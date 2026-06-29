/**
 * Tool: read_file
 *
 * 读取指定文件内容。
 * 支持绝对路径和相对于工作区的路径。
 */

const fs = require('fs');
const path = require('path');

async function readFile(args, context) {
  const { path: filePathInput } = args || {};
  if (!filePathInput || typeof filePathInput !== 'string') {
    return { success: false, error: '缺少 path 参数' };
  }

  const workspaceRoot = context.workspaceRoot || '';
  let targetPath = filePathInput;

  // 处理相对路径
  if (!path.isAbsolute(targetPath) && workspaceRoot) {
    targetPath = path.join(workspaceRoot, targetPath);
  }

  targetPath = path.resolve(targetPath);

  // 路径边界检查
  if (workspaceRoot && !targetPath.startsWith(path.resolve(workspaceRoot))) {
    return { success: false, error: `拒绝访问工作区外的路径: ${filePathInput}` };
  }

  try {
    const stat = await fs.promises.stat(targetPath);
    if (!stat.isFile()) {
      return { success: false, error: `路径不是文件: ${filePathInput}` };
    }

    // 限制大文件读取
    const MAX_SIZE = 500 * 1024; // 500KB
    if (stat.size > MAX_SIZE) {
      // Bug 修复：原代码先 readFile 整个文件再 slice，超大文件（如 minified bundle、
      // source map、大日志）会在 readFile 阶段触发 RangeError: Invalid string length。
      // 改用 createReadStream 只读取前 MAX_SIZE 字节，避免读取整个大文件。
      const head = await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(targetPath, {
          start: 0,
          end: MAX_SIZE - 1,
          encoding: 'utf8',
        });
        const parts = [];
        stream.on('data', (chunk) => parts.push(chunk));
        stream.on('end', () => resolve(parts.join('')));
        stream.on('error', reject);
      });
      return {
        success: true,
        path: filePathInput,
        size: stat.size,
        truncated: true,
        content: head + '\n\n...（文件过大，已截断）...',
      };
    }

    const content = await fs.promises.readFile(targetPath, 'utf-8');
    return {
      success: true,
      path: filePathInput,
      size: stat.size,
      content,
    };
  } catch (err) {
    return { success: false, error: `读取文件失败: ${err.message}` };
  }
}

module.exports = readFile;
