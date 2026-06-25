/**
 * Tool: apply_edit
 *
 * 生成文件修改建议，等待用户确认。
 * 不会直接写盘，而是把 original/modified 推送到 WebView 供用户确认。
 */

const fs = require('fs');
const path = require('path');

async function applyEdit(args, context) {
  const { path: filePathInput, original, modified } = args || {};
  if (!filePathInput || typeof filePathInput !== 'string') {
    return { success: false, error: '缺少 path 参数' };
  }
  if (typeof original !== 'string' || typeof modified !== 'string') {
    return { success: false, error: 'original 和 modified 必须是字符串' };
  }
  if (original === modified) {
    return { success: false, error: 'original 和 modified 相同，无需修改' };
  }

  const workspaceRoot = context.workspaceRoot || '';
  let targetPath = filePathInput;
  if (!path.isAbsolute(targetPath) && workspaceRoot) {
    targetPath = path.join(workspaceRoot, targetPath);
  }
  targetPath = path.resolve(targetPath);

  // 路径边界检查
  if (workspaceRoot && !targetPath.startsWith(path.resolve(workspaceRoot))) {
    return { success: false, error: `拒绝修改工作区外的文件: ${filePathInput}` };
  }

  // 读取当前文件内容以验证 original 是否存在
  let currentContent = '';
  try {
    currentContent = fs.readFileSync(targetPath, 'utf-8');
  } catch (err) {
    return { success: false, error: `无法读取文件: ${err.message}` };
  }

  if (!currentContent.includes(original)) {
    return { success: false, error: '文件中未找到 original 指定的代码片段，请重新读取文件确认内容' };
  }

  const editId = `agent-edit-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  // 将待确认编辑注册到 context
  if (typeof context.registerPendingEdit === 'function') {
    context.registerPendingEdit(editId, {
      filePath: targetPath,
      mode: 'replace',
      original,
      modified,
    });
  }

  // 通知 WebView 显示确认弹窗
  if (typeof context.postToWebView === 'function') {
    context.postToWebView({
      type: 'agentEditPending',
      editId,
      filePath: filePathInput,
      original,
      modified,
    });
  }

  return {
    success: true,
    pending: true,
    editId,
    filePath: filePathInput,
    message: '已生成修改建议，等待用户在 UI 中确认后才会应用。',
  };
}

module.exports = applyEdit;
