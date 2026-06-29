/**
 * Tool: read_file_outline
 *
 * 提取文件的结构大纲（函数/类/方法签名、import/export 列表），
 * 流式扫描不加载全文，可安全处理任意大小文件。
 * 当文件过大不适合 read_file 全量读取时，应优先使用此工具了解文件结构。
 */

const path = require('path');
const SafeFileReader = require('../safeFileReader.cjs');
const tokenBudget = require('../tokenBudget.cjs');

async function readFileOutline(args, context) {
  const { path: filePathInput } = args || {};
  if (!filePathInput || typeof filePathInput !== 'string') {
    return { success: false, error: '缺少 path 参数' };
  }

  const workspaceRoot = context.workspaceRoot || '';
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

    // 构建给 LLM 的可读大纲文本
    const outlineText = formatOutlineText(result, language, stat.size);

    // Token 预算检查
    const maxTokens = tokenBudget.getSafeReturnLimit(context);
    const checked = tokenBudget.checkAndTruncate(outlineText, maxTokens);

    return {
      success: true,
      path: filePathInput,
      size: stat.size,
      language,
      totalLines: result.totalLines,
      symbols: result.symbols,
      imports: result.imports,
      exports: result.exports,
      truncated: result.truncated || checked.truncated,
      outline: checked.content,
      suggestion: buildSuggestion(stat.size, result.totalLines, language),
    };
  } catch (err) {
    return { success: false, error: `提取文件大纲失败: ${err.message}` };
  }
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
