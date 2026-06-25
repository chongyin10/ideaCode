/**
 * Tool: write_file
 *
 * 写入文件内容。与 apply_edit 不同，write_file 用于创建新文件或全量覆盖。
 * 默认需要用户确认，仅当文件不存在或用户明确授权时才执行。
 *
 * 保护措施：
 * - 文件大小限制（默认 5MB），超过拒绝
 * - 路径必须在工作区内
 */

const fs = require('fs');
const path = require('path');
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

async function writeFile(args, context) {
  const { path: filePathInput, content } = args || {};
  if (!filePathInput || typeof filePathInput !== 'string') {
    return { success: false, error: '缺少 path 参数' };
  }
  if (typeof content !== 'string') {
    return { success: false, error: 'content 必须是字符串' };
  }
  // 大小限制
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_SIZE) {
    return {
      success: false,
      error: `文件过大（${(Buffer.byteLength(content, 'utf8') / 1024 / 1024).toFixed(2)}MB > ${MAX_FILE_SIZE / 1024 / 1024}MB），拒绝写入以保护内存`,
    };
  }

  const workspaceRoot = context.workspaceRoot || '';
  let targetPath = filePathInput;
  if (!path.isAbsolute(targetPath) && workspaceRoot) {
    targetPath = path.join(workspaceRoot, targetPath);
  }
  targetPath = path.resolve(targetPath);

  // 路径边界检查
  if (workspaceRoot && !targetPath.startsWith(path.resolve(workspaceRoot))) {
    return { success: false, error: `拒绝写入工作区外的文件: ${filePathInput}` };
  }

  const fileExists = fs.existsSync(targetPath);
  const original = fileExists ? fs.readFileSync(targetPath, 'utf-8') : '';

  const editId = `agent-write-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  if (typeof context.registerPendingEdit === 'function') {
    context.registerPendingEdit(editId, {
      filePath: targetPath,
      mode: 'write',
      original,
      modified: content,
    });
  }

  if (typeof context.postToWebView === 'function') {
    context.postToWebView({
      type: 'agentEditPending',
      editId,
      filePath: filePathInput,
      original,
      modified: content,
    });
  }

  return {
    success: true,
    pending: true,
    editId,
    filePath: filePathInput,
    message: `已生成${fileExists ? '覆盖' : '创建'}文件建议（${(Buffer.byteLength(content, 'utf8') / 1024).toFixed(1)}KB），等待用户在 UI 中确认后才会应用。`,
  };
}

module.exports = writeFile;
