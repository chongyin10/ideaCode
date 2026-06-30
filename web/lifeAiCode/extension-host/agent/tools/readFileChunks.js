/**
 * Tool: read_file_chunks
 *
 * 将文件按固定行数分块，按 chunkIndex 读取指定块。
 * 流式读取，跳过前 N 块后收集目标块，适合顺序遍历大文件。
 *
 * 典型用法：
 *   chunk 0 → 读取 L1-L200
 *   chunk 1 → 读取 L201-L400
 *   ...
 *   直到 hasMore === false
 * §SSH 远程工作区支持：无法本地流式 seek，读取全文后截取块。
 */

const path = require('path');
const SafeFileReader = require('../safeFileReader.cjs');
const tokenBudget = require('../tokenBudget.cjs');
const { isRemoteUri } = require('../../sshUri');

const DEFAULT_CHUNK_SIZE = 200; // 每块 200 行

async function readFileChunks(args, context) {
  const { path: filePathInput, chunkIndex, chunkSize } = args || {};

  if (!filePathInput || typeof filePathInput !== 'string') {
    return { success: false, error: '缺少 path 参数' };
  }
  if (typeof chunkIndex !== 'number' || chunkIndex < 0 || !Number.isInteger(chunkIndex)) {
    return { success: false, error: '缺少 chunkIndex 参数或值无效（应为 ≥0 的整数）' };
  }

  const size = Math.min(Math.floor(chunkSize || DEFAULT_CHUNK_SIZE), 500);
  if (size < 1) {
    return { success: false, error: 'chunkSize 必须为正整数' };
  }

  const workspaceRoot = context.workspaceRoot || '';

  if (isRemoteUri(workspaceRoot)) {
    return readRemoteChunks(filePathInput, chunkIndex, size, context);
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

    const startLine = chunkIndex * size + 1;
    const endLine = startLine + size - 1;

    const result = await SafeFileReader.readLines(targetPath, startLine, endLine, {
      maxLines: size,
    });

    return formatResult(filePathInput, chunkIndex, size, result);
  } catch (err) {
    return { success: false, error: `分块读取文件失败: ${err.message}` };
  }
}

async function readRemoteChunks(filePathInput, chunkIndex, size, context) {
  const fsAdapter = context.fs || { readFile: () => { throw new Error('fs adapter not available'); } };
  try {
    const raw = await fsAdapter.readFile(filePathInput);
    const content = typeof raw === 'string' ? raw : raw.toString('utf-8');
    const allLines = content.split('\n');
    const totalLines = allLines.length;
    const startLine = chunkIndex * size + 1;
    const endLine = Math.min(startLine + size - 1, totalLines);
    if (startLine > totalLines) {
      return { success: false, error: `chunkIndex ${chunkIndex} 超出文件范围（共 ${totalLines} 行）` };
    }
    const lines = [];
    for (let i = startLine; i <= endLine; i++) {
      lines.push({ line: i, content: allLines[i - 1] || '' });
    }
    return formatResult(filePathInput, chunkIndex, size, {
      lines,
      startLine,
      endLine,
      totalLines,
    });
  } catch (err) {
    return { success: false, error: `分块读取远程文件失败: ${err.message}` };
  }
}

function formatResult(filePathInput, chunkIndex, size, result) {
  const totalChunks = Math.ceil(result.totalLines / size);
  const content = result.lines
    .map((l) => `${String(l.line).padStart(6, ' ')}│ ${l.content}`)
    .join('\n');

  const maxTokens = tokenBudget.getSafeReturnLimit();
  const checked = tokenBudget.checkAndTruncate(content, maxTokens);

  return {
    success: true,
    path: filePathInput,
    chunkIndex,
    chunkSize: size,
    totalChunks,
    totalLines: result.totalLines,
    startLine: result.startLine,
    endLine: result.endLine,
    actualLines: result.lines.length,
    content: checked.content,
    truncated: checked.truncated,
    hasMore: chunkIndex + 1 < totalChunks,
    suggestion: chunkIndex + 1 < totalChunks
      ? `第 ${chunkIndex}/${totalChunks - 1} 块（共 ${totalChunks} 块）。继续读取下一块请使用 chunkIndex=${chunkIndex + 1}。`
      : `已是最后一块（第 ${chunkIndex}/${totalChunks - 1} 块）。`,
  };
}

module.exports = readFileChunks;
