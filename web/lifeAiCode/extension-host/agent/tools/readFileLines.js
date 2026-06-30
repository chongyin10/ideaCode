/**
 * Tool: read_file_lines
 *
 * 读取文件中指定行范围的内容。流式读取，到达 endLine 后立即终止，
 * 可安全处理超大文件的局部读取。单次最多读取 500 行。
 *
 * 典型用法：
 *   先用 read_file_outline 获取文件结构，找到目标行号，
 *   再用本工具精读该行范围。
 * §SSH 远程工作区支持：无法流式_seek，直接读取全文后截取行范围。
 */

const path = require('path');
const SafeFileReader = require('../safeFileReader.cjs');
const tokenBudget = require('../tokenBudget.cjs');
const { isRemoteUri } = require('../../sshUri');

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

  // §SSH 远程工作区：无法本地流式 seek，读取全文后截取
  if (isRemoteUri(workspaceRoot)) {
    return readRemoteLines(filePathInput, startLine, endLine, context);
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

    const result = await SafeFileReader.readLines(targetPath, startLine, endLine, {
      maxLines: MAX_LINES_PER_CALL,
    });

    return formatResult(filePathInput, result);
  } catch (err) {
    return { success: false, error: `读取文件行范围失败: ${err.message}` };
  }
}

async function readRemoteLines(filePathInput, startLine, endLine, context) {
  const fsAdapter = context.fs || { readFile: () => { throw new Error('fs adapter not available'); } };
  try {
    const raw = await fsAdapter.readFile(filePathInput);
    const content = typeof raw === 'string' ? raw : raw.toString('utf-8');
    const allLines = content.split('\n');
    const totalLines = allLines.length;
    const s = Math.max(1, Math.floor(startLine));
    const e = Math.min(Math.floor(endLine), totalLines);
    const lines = [];
    for (let i = s; i <= e; i++) {
      lines.push({ line: i, content: allLines[i - 1] || '' });
    }
    return formatResult(filePathInput, {
      lines,
      startLine: s,
      endLine: e,
      totalLines,
    });
  } catch (err) {
    return { success: false, error: `读取远程文件行范围失败: ${err.message}` };
  }
}

function formatResult(filePathInput, result) {
  const content = result.lines
    .map((l) => `${String(l.line).padStart(6, ' ')}│ ${l.content}`)
    .join('\n');

  const maxTokens = tokenBudget.getSafeReturnLimit();
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
}

module.exports = readFileLines;
