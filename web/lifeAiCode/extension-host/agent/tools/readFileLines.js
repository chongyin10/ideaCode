/**
 * Tool: read_file_lines
 *
 * 读取文件中指定行范围的内容。流式读取，到达 endLine 后立即终止，
 * 可安全处理超大文件的局部读取。单次最多读取 500 行。
 *
 * 典型用法：
 *   先用 read_file_outline 获取文件结构，找到目标行号，
 *   再用本工具精读该行范围。
 */

const path = require('path');
const SafeFileReader = require('../safeFileReader.cjs');
const tokenBudget = require('../tokenBudget.cjs');

const MAX_LINES_PER_CALL = 500;

async function readFileLines(args, context) {
  const { path: filePathInput, startLine, endLine } = args || {};
  if (!filePathInput || typeof filePathInput !== 'string') {
    return { success: false, error: '缺少 path 参数' };
  }
  if (!startLine || typeof startLine !== 'number' || startLine < 1) {
    return { success: false, error: '缺少 startLine 参数或值无效（应为 ≥1 的整数）' };
  }
  if (!endLine || typeof endLine !== 'number' || endLine < startLine) {
    return { success: false, error: '缺少 endLine 参数或值无效（应 ≥ startLine）' };
  }

  const requestedLines = endLine - startLine + 1;
  if (requestedLines > MAX_LINES_PER_CALL) {
    return {
      success: false,
      error: `单次最多读取 ${MAX_LINES_PER_CALL} 行，请求了 ${requestedLines} 行。请缩小范围或使用 read_file_chunks 分块读取。`,
    };
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

    const result = await SafeFileReader.readLines(targetPath, startLine, endLine, {
      maxLines: MAX_LINES_PER_CALL,
    });

    // 将行数组格式化为带行号的文本
    const content = result.lines
      .map((l) => `${String(l.line).padStart(6, ' ')}│ ${l.content}`)
      .join('\n');

    // Token 预算检查
    const maxTokens = tokenBudget.getSafeReturnLimit(context);
    const checked = tokenBudget.checkAndTruncate(content, maxTokens);

    return {
      success: true,
      path: filePathInput,
      startLine: result.startLine,
      endLine: result.endLine,
      actualLines: result.lines.length,
      totalLines: result.totalLines,
      content: checked.content,
      truncated: checked.truncated,
      hasMore: result.endLine < result.totalLines,
      suggestion: result.endLine < result.totalLines
        ? `文件共 ${result.totalLines} 行，当前读取了 L${result.startLine}-L${result.endLine}。继续读取请使用 startLine=${result.endLine + 1}。`
        : undefined,
    };
  } catch (err) {
    return { success: false, error: `读取文件行范围失败: ${err.message}` };
  }
}

module.exports = readFileLines;
