/**
 * Tool: write_file
 *
 * 写入文件内容。与 apply_edit 不同，write_file 用于创建新文件或全量覆盖。
 * 默认需要用户确认，仅当文件不存在或用户明确授权时才执行。
 *
 * 保护措施：
 * - 文件大小限制（默认 5MB），超过拒绝
 * - 路径必须在工作区内
 * §SSH 远程工作区支持：使用 context.fs 统一适配器读取/写入文件。
 */

const fs = require('fs').promises;
const path = require('path');
const { isRemoteUri } = require('../../sshUri');
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
  const fsAdapter = context.fs || {
    readFile: (p) => fs.readFile(p, 'utf-8'),
    resolvePath: (p) => resolveLocalPath(p, workspaceRoot),
  };

  let targetPath;
  try {
    targetPath = fsAdapter.resolvePath(filePathInput);
  } catch (err) {
    return { success: false, error: `路径解析失败: ${err.message}` };
  }

  // Bug 15: 使用异步 fs 操作避免阻塞 Extension Host 事件循环
  let fileExists = false;
  let original = '';
  try {
    original = await fsAdapter.readFile(filePathInput);
    original = typeof original === 'string' ? original : original.toString('utf-8');
    fileExists = true;
  } catch (err) {
    // 文件不存在或读取失败，视为新文件
    if (!isRemoteUri(workspaceRoot) && err?.code !== 'ENOENT') {
      return { success: false, error: `无法读取文件: ${err.message}` };
    }
    // 远程环境下没有 ENOENT code，直接视为不存在
  }

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
    notApplied: true,
    editId,
    filePath: filePathInput,
    message: `⚠️ 文件尚未写入磁盘！已生成${fileExists ? '覆盖' : '创建'}文件建议（${(Buffer.byteLength(content, 'utf8') / 1024).toFixed(1)}KB），需用户在 UI 中确认后才会真正应用。如果需要文件立即生效（如创建项目），请改用 execute_shell 命令（如 cat > file << 'EOF'...EOF 或 mkdir -p + touch）直接写入磁盘。`,
  };
}

function resolveLocalPath(inputPath, workspaceRoot) {
  let targetPath = inputPath;
  if (!path.isAbsolute(targetPath) && workspaceRoot && !isRemoteUri(workspaceRoot)) {
    targetPath = path.join(workspaceRoot, targetPath);
  }
  return path.resolve(targetPath);
}

module.exports = writeFile;
