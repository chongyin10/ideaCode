/**
 * Tool: read_file_outline
 *
 * 提取文件的结构大纲（函数/类/方法签名、import/export 列表），
 * 流式扫描不加载全文，可安全处理任意大小文件。
 * 当文件过大不适合 read_file 全量读取时，应优先使用此工具了解文件结构。
 * §SSH 远程工作区支持：无法本地流式 outline，读取全文后提取（受大小限制）。
 */

const path = require('path');
const SafeFileReader = require('../safeFileReader.cjs');
const tokenBudget = require('../tokenBudget.cjs');
const { isRemoteUri } = require('../../sshUri');

const MAX_REMOTE_OUTLINE_SIZE = 2 * 1024 * 1024; // 2MB

async function readFileOutline(args, context) {
  const { path: filePathInput } = args || {};
  if (!filePathInput || typeof filePathInput !== 'string') {
    return { success: false, error: '缺少 path 参数' };
  }

  const workspaceRoot = context.workspaceRoot || '';

  if (isRemoteUri(workspaceRoot)) {
    return extractRemoteOutline(filePathInput, context);
  }

  let targetPath = filePathInput;
  if (!path.isAbsolute(targetPath) && workspaceRoot) {
    targetPath = path.join(workspaceRoot, targetPath);
  }
  targetPath = path.resolve(targetPath);

  if (workspaceRoot && !targetPath.startsWith(path.resolve(workspaceRoot))) {
    return { success: false, error: `拒绝访问工作区外的路径: ${filePathInput}` };
  }

  try {
    const stat = await SafeFileReader.stat(targetPath);
    if (!stat.isFile()) {
      return { success: false, error: `路径不是文件: ${filePathInput}` };
    }

    const language = SafeFileReader.detectLanguage(targetPath);
    const result = await SafeFileReader.extractOutline(targetPath, language);

    return formatResult(filePathInput, language, stat.size, result);
  } catch (err) {
    return { success: false, error: `提取文件大纲失败: ${err.message}` };
  }
}

async function extractRemoteOutline(filePathInput, context) {
  const fsAdapter = context.fs || { readFile: () => { throw new Error('fs adapter not available'); } };
  try {
    const stat = await fsAdapter.stat(filePathInput);
    if (!stat || stat.isDirectory) {
      return { success: false, error: `路径不是文件: ${filePathInput}` };
    }
    if (stat.size > MAX_REMOTE_OUTLINE_SIZE) {
      return {
        success: false,
        error: `远程文件过大（${(stat.size / 1024 / 1024).toFixed(1)}MB > ${MAX_REMOTE_OUTLINE_SIZE / 1024 / 1024}MB），无法提取大纲。请使用 read_file_lines 分块读取。`,
      };
    }
    const raw = await fsAdapter.readFile(filePathInput);
    const content = typeof raw === 'string' ? raw : raw.toString('utf-8');
    const language = SafeFileReader.detectLanguage(filePathInput);
    const totalLines = content.split('\n').length;
    // 简单正则提取 import/export/函数/类定义，不如 SafeFileReader 全面但够用
    const lines = content.split('\n');
    const symbols = [];
    const imports = [];
    const exports = [];
    const importRe = /^(import|require)\b/;
    const exportRe = /^export\b/;
    const symbolRe = /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+(\w+)/;
    const methodRe = /^(?:async\s+)?(\w+)\s*\(/;
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      if (importRe.test(trimmed)) imports.push(trimmed.length > 120 ? trimmed.slice(0, 120) + '…' : trimmed);
      else if (exportRe.test(trimmed)) exports.push(trimmed.length > 120 ? trimmed.slice(0, 120) + '…' : trimmed);
      const symMatch = trimmed.match(symbolRe);
      if (symMatch) {
        symbols.push({ line: idx + 1, kind: 'symbol', name: symMatch[1], signature: trimmed.slice(0, 120) });
        return;
      }
      const methodMatch = trimmed.match(methodRe);
      if (methodMatch && (trimmed.includes(':') || trimmed.includes('=>'))) {
        symbols.push({ line: idx + 1, kind: 'method', name: methodMatch[1], signature: trimmed.slice(0, 120) });
      }
    });

    const result = {
      symbols,
      imports,
      exports,
      totalLines,
      truncated: false,
    };
    return formatResult(filePathInput, language, stat.size, result);
  } catch (err) {
    return { success: false, error: `提取远程文件大纲失败: ${err.message}` };
  }
}

function formatResult(filePathInput, language, size, result) {
  const outlineText = formatOutlineText(result, language, size);
  const maxTokens = tokenBudget.getSafeReturnLimit();
  const checked = tokenBudget.checkAndTruncate(outlineText, maxTokens);

  return {
    success: true,
    path: filePathInput,
    size,
    language,
    totalLines: result.totalLines,
    symbols: result.symbols,
    imports: result.imports,
    exports: result.exports,
    truncated: result.truncated || checked.truncated,
    outline: checked.content,
    suggestion: buildSuggestion(size, result.totalLines, language),
  };
}

/**
 * 格式化大纲为可读文本
 */
function formatOutlineText(result, language, size) {
  const lines = [];
  lines.push(`文件语言: ${language}`);
  lines.push(`文件大小: ${(size / 1024).toFixed(1)}KB`);
  lines.push(`总行数: ${result.totalLines}`);
  lines.push('');

  if (result.imports.length > 0) {
    lines.push('## Imports');
    for (const imp of result.imports) {
      lines.push(`  ${imp}`);
    }
    lines.push('');
  }

  if (result.exports.length > 0) {
    lines.push('## Exports');
    for (const exp of result.exports) {
      lines.push(`  ${exp}`);
    }
    lines.push('');
  }

  lines.push('## 符号定义');
  for (const sym of result.symbols) {
    lines.push(`  L${sym.line} [${sym.kind}] ${sym.name}`);
    if (sym.signature && sym.signature !== sym.name) {
      lines.push(`    ${sym.signature}`);
    }
  }

  if (result.truncated) {
    lines.push('');
    lines.push('（符号数量超过 200 上限，已截断）');
  }

  return lines.join('\n');
}

/**
 * 构建给 LLM 的下一步建议
 */
function buildSuggestion(size, totalLines, language) {
  const sizeKB = size / 1024;
  if (sizeKB <= 500) {
    return '文件较小，可直接使用 read_file 读取完整内容。';
  }
  const lines = [
    `文件较大（${sizeKB.toFixed(1)}KB / ${totalLines} 行），不建议使用 read_file 全量读取。`,
    `建议：`,
    `  - 使用 read_file_lines(path, startLine, endLine) 读取上方感兴趣的行范围（单次不超过 500 行）`,
    `  - 使用 search_in_file(path, pattern) 搜索特定内容`,
  ];
  if (language === 'javascript' || language === 'typescript') {
    lines.push(`  - 使用 read_file_chunks(path, chunkIndex) 顺序分块阅读`);
  }
  return lines.join('\n');
}

module.exports = readFileOutline;
