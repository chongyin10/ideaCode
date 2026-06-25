/**
 * Tool: write_file
 *
 * 写入文件内容。与 apply_edit 不同，write_file 用于创建新文件或全量覆盖。
 * 默认需要用户确认，仅当文件不存在或用户明确授权时才执行。
 */

const fs = require('fs');
const path = require('path');

async function writeFile(args, context) {
  const { path: filePathInput, content } = args || {};
  if (!filePathInput || typeof filePathInput !== 'string') {
    return { success: false, error: '缺少 path 参数' };
  }
  if (typeof content !== 'string') {
    return { success: false, error: 'content 必须是字符串' };
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

  // 生成待确认编辑，通过 apply_edit 同样的机制让用户确认
  const editId = `agent-write-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  if (typeof context.registerPendingEdit === 'function') {
    context.registerPendingEdit(editId, {
      filePath: targetPath,
      mode: 'write',
      original: fileExists ? fs.readFileSync(targetPath, 'utf-8') : '',
      modified: content,
    });
  }

  if (typeof context.postToWebView === 'function') {
    context.postToWebView({
      type: 'agentEditPending',
      editId,
      filePath: filePathInput,
      original: fileExists ? fs.readFileSync(targetPath, 'utf-8') : '',
      modified: content,
    });
  }

  return {
    success: true,
    pending: true,
    editId,
    filePath: filePathInput,
    message: `已生成${fileExists ? '覆盖' : '创建'}文件建议，等待用户在 UI 中确认后才会应用。`,
  };
}

module.exports = writeFile;
