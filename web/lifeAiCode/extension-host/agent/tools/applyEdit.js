/**
 * Tool: apply_edit
 *
 * 对文件进行安全的查找替换修改。
 * - 用规范化空白（trim + 折叠连续空白）做匹配，能容忍 LLM 缩进差异
 * - 校验位置唯一性：若 original 出现多次，要求 LLM 给出更多上下文
 * - 真正写入需要用户确认，仅注册到 pendingAgentEdits
 */

const fs = require('fs').promises;
const path = require('path');
const { isRemoteUri } = require('../../sshUri');

// Agent 编辑场景单文件大小上限。超大文件（minified bundle、生成代码、大日志）
// 不适合 Agent 直接查找替换，且 readFile + indexOf 循环 + replaceAll 会消耗大量内存。
// 超过上限直接拒绝，防止 Invalid string length。
const MAX_EDIT_FILE_SIZE = 32 * 1024 * 1024; // 32MB

/**
 * 规范化字符串：去掉前后空白 + 把任意连续空白折叠成单个空格
 * 用于对 LLM 输出的"original"做容错匹配
 */
function normalizeWhitespace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * 找 original 在 currentContent 中的所有匹配位置
 * @param {string} content 文件完整内容
 * @param {string} original LLM 给的原文片段
 * @returns {{indices: number[], normalizedUnique: boolean}}
 *   - indices: 在 content 中所有出现位置的起始 index（按 normalizeWhitespace 匹配后）
 *   - normalizedUnique: 规范化后是否唯一
 */
function findOriginalMatches(content, original) {
  if (!original) return { indices: [], normalizedUnique: false };
  const normOrig = normalizeWhitespace(original);
  if (!normOrig) return { indices: [], normalizedUnique: false };

  // 把 content 切成 tokens（按空白），保留 offset 信息
  const tokens = [];
  const tokenRe = /(\s+)|(\S+)/g;
  let m;
  while ((m = tokenRe.exec(content)) !== null) {
    tokens.push({ kind: m[1] ? 'ws' : 'word', val: m[0], start: m.index, end: m.index + m[0].length });
  }

  // 把所有 word token 拼成 normalized 字符串 + 索引数组
  const wordTokens = tokens.filter((t) => t.kind === 'word');
  const normTokens = wordTokens.map((t) => t.val);
  const normStr = normTokens.join(' ');

  // 在 normStr 里找 normOrig（按 word 边界），回查原 content index
  const origWords = normOrig.split(' ');
  const indices = [];
  for (let i = 0; i + origWords.length <= normTokens.length; i++) {
    let match = true;
    for (let k = 0; k < origWords.length; k++) {
      if (normTokens[i + k] !== origWords[k]) { match = false; break; }
    }
    if (match) {
      // 把 word i..i+len-1 映射回 content index = 第一个 word 的 start
      indices.push(wordTokens[i].start);
    }
  }
  return { indices, normalizedUnique: indices.length === 1 };
}

async function applyEdit(args, context) {
  const { path: filePathInput, original, modified } = args || {};
  if (!filePathInput || typeof filePathInput !== 'string') {
    return { success: false, error: '缺少 path 参数' };
  }
  if (typeof original !== 'string' || typeof modified !== 'string') {
    return { success: false, error: 'original 和 modified 必须是字符串' };
  }
  // Bug 5: original 为空字符串时 indexOf('', from) 永远返回 from（非 -1），
  // 且 from = idx + 0 = idx 永不前进 → 无限循环直到 OOM 崩溃
  if (!original.trim()) {
    return { success: false, error: 'original 不能为空或仅含空白' };
  }
  if (normalizeWhitespace(original) === normalizeWhitespace(modified)) {
    return { success: false, error: 'original 和 modified 规范化后相同，无需修改' };
  }

  const workspaceRoot = context.workspaceRoot || '';
  const fsAdapter = context.fs || {
    stat: (p) => fs.stat(p),
    readFile: (p) => fs.readFile(p, 'utf-8'),
    resolvePath: (p) => resolveLocalPath(p, workspaceRoot),
  };

  let targetPath;
  try {
    targetPath = fsAdapter.resolvePath(filePathInput);
  } catch (err) {
    return { success: false, error: `路径解析失败: ${err.message}` };
  }

  // 读取当前文件内容以验证 original 是否存在
  let currentContent = '';
  try {
    // 大文件保护：超大文件不适合 Agent 查找替换，拒绝操作防止 Invalid string length
    const stat = await fsAdapter.stat(filePathInput);
    if (!stat || stat.size > MAX_EDIT_FILE_SIZE) {
      return {
        success: false,
        error: `文件过大（${stat ? (stat.size / 1024 / 1024).toFixed(1) : '?'}MB），超过 ${MAX_EDIT_FILE_SIZE / 1024 / 1024}MB 编辑上限。请手动修改该文件。`,
      };
    }
    const raw = await fsAdapter.readFile(filePathInput);
    currentContent = typeof raw === 'string' ? raw : raw.toString('utf-8');
  } catch (err) {
    return { success: false, error: `无法读取文件: ${err.message}` };
  }

  // 1. 先做精确匹配（最快）
  const exactIndices = [];
  let from = 0;
  while (true) {
    const idx = currentContent.indexOf(original, from);
    if (idx === -1) break;
    exactIndices.push(idx);
    from = idx + original.length;
  }

  let matchStart = -1;
  let matchEnd = -1;
  let matchType = '';

  if (exactIndices.length === 1) {
    // ✅ 唯一精确匹配
    matchStart = exactIndices[0];
    matchEnd = exactIndices[0] + original.length;
    matchType = 'exact';
  } else if (exactIndices.length > 1) {
    // 出现多次，要求 LLM 提供更多上下文
    return {
      success: false,
      error: `original 在文件中出现 ${exactIndices.length} 次，无法唯一定位。请在 original 周围提供更多上下文（含前后行），或重新读取文件确认。`,
    };
  } else {
    // 2. 精确匹配失败，尝试规范化匹配（容忍缩进/空白差异）
    const { indices, normalizedUnique } = findOriginalMatches(currentContent, original);
    if (indices.length === 1 && normalizedUnique) {
      // ✅ 唯一规范化匹配
      matchStart = indices[0];
      // 计算匹配的结束位置：把对应的 word tokens 拼回原文
      // 这里简化：从 matchStart 到 original 字面长度后第一个 word 边界
      // 但更准确的方式是按 word tokens 数找到 end offset
      // 简化策略：从 matchStart 往后扫描到 origWords 长度对应的非空 token
      // 实际我们用 word 数 + matchStart 推算
      const origWords = normalizeWhitespace(original).split(' ');
      // 从 matchStart 往后跳过 origWords.length 个 word tokens 的字符总和
      // 通过扫描原 content
      let pos = matchStart;
      let wordCount = 0;
      let charLen = 0;
      const tokenRe2 = /(\s+)|(\S+)/g;
      let mm;
      tokenRe2.lastIndex = matchStart;
      while ((mm = tokenRe2.exec(currentContent)) !== null) {
        if (mm[2]) {
          // word token
          wordCount++;
          charLen = mm.index + mm[0].length - matchStart;
          if (wordCount >= origWords.length) {
            matchEnd = mm.index + mm[0].length;
            break;
          }
        }
      }
      if (matchEnd === -1) matchEnd = Math.min(matchStart + original.length, currentContent.length);
      matchType = 'normalized';
    } else if (indices.length > 1) {
      return {
        success: false,
        error: `original（忽略空白后）在文件中出现 ${indices.length} 次，仍无法唯一定位。请在 original 周围提供更多上下文，或重新读取文件确认。`,
      };
    } else {
      return {
        success: false,
        error: '文件中未找到 original 指定的代码片段（已尝试精确匹配和忽略空白匹配）。请重新读取文件确认内容。',
      };
    }
  }

  const editId = `agent-edit-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  // 将待确认编辑注册到 context
  if (typeof context.registerPendingEdit === 'function') {
    context.registerPendingEdit(editId, {
      filePath: targetPath,
      mode: 'replace',
      original: currentContent.slice(matchStart, matchEnd),
      modified,
    });
  }

  // 通知 WebView 显示确认弹窗（用精确匹配到的原文做 diff）
  if (typeof context.postToWebView === 'function') {
    context.postToWebView({
      type: 'agentEditPending',
      editId,
      filePath: filePathInput,
      original: currentContent.slice(matchStart, matchEnd),
      modified,
    });
  }

  return {
    success: true,
    pending: true,
    editId,
    filePath: filePathInput,
    matchType, // 'exact' | 'normalized'，用于 UI 提示
    message: `已生成修改建议（${matchType === 'exact' ? '精确匹配' : '规范化匹配'}），等待用户在 UI 中确认后才会应用。`,
  };
}

function resolveLocalPath(inputPath, workspaceRoot) {
  let targetPath = inputPath;
  if (!path.isAbsolute(targetPath) && workspaceRoot && !isRemoteUri(workspaceRoot)) {
    targetPath = path.join(workspaceRoot, targetPath);
  }
  return path.resolve(targetPath);
}

module.exports = applyEdit;