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
    const stat = fs.statSync(targetPath);
    if (!stat.isFile()) {
      return { success: false, error: `路径不是文件: ${filePathInput}` };
    }

    // 限制大文件读取
    const MAX_SIZE = 500 * 1024; // 500KB
    if (stat.size > MAX_SIZE) {
      const content = fs.readFileSync(targetPath, 'utf-8');
      return {
        success: true,
        path: filePathInput,
        size: stat.size,
        truncated: true,
        content: content.slice(0, MAX_SIZE) + '\n\n...（文件过大，已截断）...',
      };
    }

    const content = fs.readFileSync(targetPath, 'utf-8');
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
