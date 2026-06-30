/**
 * Tool: delete_file
 *
 * 删除指定文件。删除操作不可逆，因此走 pending 模式：
 * 先读取文件内容作为 original，注册待确认编辑，用户在 UI 确认后才真正删除。
 *
 * 保护措施：
 * - 路径必须在工作区内
 * - 文件必须存在（ENOENT 直接报错）
 * - 单文件大小上限 32MB（防止读取超大文件时 Invalid string length）
 * §SSH 远程工作区支持：使用 context.fs 统一适配器读取文件。
 */

const fs = require('fs').promises;
const path = require('path');
const { isRemoteUri } = require('../../sshUri');

const MAX_DELETE_FILE_SIZE = 32 * 1024 * 1024; // 32MB

async function deleteFile(args, context) {
  const { path: filePathInput } = args || {};
  if (!filePathInput || typeof filePathInput !== 'string') {
    return { success: false, error: '缺少 path 参数' };
  }

  const workspaceRoot = context.workspaceRoot || '';
  const fsAdapter = context.fs || {
    stat: (p) => fs.stat(p),
    readFile: (p) => fs.readFile(p, 'utf-8'),
    resolvePath: (p) => resolveLocalPath(p, workspaceRoot),
  };

  let targetPath;
  try {
    targetPath = fsAdapter.resolvePath(filePathInput);
  } catch (err) {
    return { success: false, error: `路径解析失败: ${err.message}` };
  }

  // 读取文件内容（用于 UI 确认时展示将被删除的内容）
  let original = '';
  try {
    const stat = await fsAdapter.stat(filePathInput);
    if (!stat || stat.isDirectory) {
      return { success: false, error: `路径不是文件: ${filePathInput}` };
    }
    if (stat.size > MAX_DELETE_FILE_SIZE) {
      return {
        success: false,
        error: `文件过大（${(stat.size / 1024 / 1024).toFixed(1)}MB），超过 ${MAX_DELETE_FILE_SIZE / 1024 / 1024}MB 删除上限。请手动删除该文件。`,
      };
    }
    const raw = await fsAdapter.readFile(filePathInput);
    original = typeof raw === 'string' ? raw : raw.toString('utf-8');
  } catch (err) {
    if (!isRemoteUri(workspaceRoot) && err?.code === 'ENOENT') {
      return { success: false, error: `文件不存在: ${filePathInput}` };
    }
    return { success: false, error: `无法读取文件: ${err.message}` };
  }

  const editId = `agent-delete-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  if (typeof context.registerPendingEdit === 'function') {
    context.registerPendingEdit(editId, {
      filePath: targetPath,
      mode: 'delete',
      original,
      modified: '',
    });
  }

  if (typeof context.postToWebView === 'function') {
    context.postToWebView({
      type: 'agentEditPending',
      editId,
      filePath: filePathInput,
      original,
      modified: '',
      mode: 'delete',
    });
  }

  return {
    success: true,
    pending: true,
    editId,
    filePath: filePathInput,
    message: `已生成删除建议（文件 ${(Buffer.byteLength(original, 'utf8') / 1024).toFixed(1)}KB），等待用户在 UI 中确认后才会删除。`,
  };
}

function resolveLocalPath(inputPath, workspaceRoot) {
  let targetPath = inputPath;
  if (!path.isAbsolute(targetPath) && workspaceRoot && !isRemoteUri(workspaceRoot)) {
    targetPath = path.join(workspaceRoot, targetPath);
  }
  return path.resolve(targetPath);
}

module.exports = deleteFile;
