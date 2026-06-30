/**
 * 统一文件系统适配器
 *
 * 为 lifeAiCode Agent 工具提供一致的 fs API：
 *   - 本地工作区：直接使用 Node.js fs
 *   - SSH 远程工作区：通过 vscode.commands.executeCommand('ssh.fs.*') 调用
 *     ideacode-ssh 扩展的 FileSystemProvider
 *
 * 适配器在创建时持有上下文对象引用，每次调用根据当前 workspaceRoot 自动选择后端。
 */

const fs = require('fs');
const path = require('path');
const vscode = require('./api');
const { isRemoteUri, parseSshUri, buildSshUri } = require('./sshUri');

function createFsAdapter(context) {
  /**
   * 获取当前工作区根路径（可能是本地绝对路径或 ssh:// URI）
   */
  function getWorkspaceRoot() {
    return context.workspaceRoot || '';
  }

  function isRemote() {
    return isRemoteUri(getWorkspaceRoot());
  }

  /**
   * 把用户传入的相对/绝对路径解析为绝对本地路径或 ssh:// URI
   */
  function resolvePath(inputPath) {
    if (!inputPath || typeof inputPath !== 'string') {
      throw new Error('路径参数无效');
    }
    const root = getWorkspaceRoot();
    if (isRemoteUri(root)) {
      const { connectionId, remotePath: rootRemotePath } = parseSshUri(root);
      if (inputPath.startsWith(`${connectionId}/`) || inputPath.startsWith('ssh://')) {
        // 已经是以 connectionId 开头或完整 ssh URI
        return inputPath.startsWith('ssh://') ? inputPath : buildSshUri(connectionId, `/${inputPath.slice(connectionId.length + 1)}`);
      }
      const normalized = path.posix.normalize(
        inputPath.startsWith('/') ? inputPath : path.posix.join(rootRemotePath, inputPath)
      );
      return buildSshUri(connectionId, normalized);
    }

    let localPath = inputPath;
    if (!path.isAbsolute(localPath) && root) {
      localPath = path.join(root, localPath);
    }
    return path.resolve(localPath);
  }

  /**
   * 路径边界检查：禁止访问工作区之外
   */
  function assertWithinWorkspace(inputPath, resolvedPath) {
    const root = getWorkspaceRoot();
    if (!root) return true;
    if (isRemoteUri(root)) {
      const rootInfo = parseSshUri(root);
      const targetInfo = parseSshUri(resolvedPath);
      if (!targetInfo.isRemote || targetInfo.connectionId !== rootInfo.connectionId) {
        throw new Error(`拒绝访问工作区外的远程连接: ${inputPath}`);
      }
      if (!targetInfo.remotePath.startsWith(rootInfo.remotePath)) {
        throw new Error(`拒绝访问工作区外的路径: ${inputPath}`);
      }
      return true;
    }
    const resolvedRoot = path.resolve(root);
    if (!resolvedPath.startsWith(resolvedRoot)) {
      throw new Error(`拒绝访问工作区外的路径: ${inputPath}`);
    }
    return true;
  }

  async function readFile(inputPath, encoding = 'utf-8') {
    const resolved = resolvePath(inputPath);
    assertWithinWorkspace(inputPath, resolved);
    if (isRemote()) {
      const content = await vscode.commands.executeCommand('ssh.fs.readFile', resolved);
      if (encoding === 'utf-8' || encoding === 'utf8') {
        return typeof content === 'string' ? content : content.toString('utf-8');
      }
      return Buffer.from(content);
    }
    return fs.promises.readFile(resolved, encoding);
  }

  async function writeFile(inputPath, content) {
    const resolved = resolvePath(inputPath);
    assertWithinWorkspace(inputPath, resolved);
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8');
    if (isRemote()) {
      await vscode.commands.executeCommand('ssh.fs.writeFile', resolved, data);
      return;
    }
    const dir = path.dirname(resolved);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(resolved, data);
  }

  async function readDirectory(inputPath) {
    const resolved = resolvePath(inputPath);
    assertWithinWorkspace(inputPath, resolved);
    if (isRemote()) {
      const entries = await vscode.commands.executeCommand('ssh.fs.readDirectory', resolved);
      return Array.isArray(entries) ? entries : [];
    }
    const dirents = await fs.promises.readdir(resolved, { withFileTypes: true });
    return dirents.map((d) => ({
      name: d.name,
      kind: d.isDirectory() ? 'directory' : 'file',
      uri: path.join(resolved, d.name),
    }));
  }

  async function stat(inputPath) {
    const resolved = resolvePath(inputPath);
    assertWithinWorkspace(inputPath, resolved);
    if (isRemote()) {
      return vscode.commands.executeCommand('ssh.fs.stat', resolved);
    }
    try {
      const s = await fs.promises.stat(resolved);
      return { isDirectory: s.isDirectory(), size: s.size };
    } catch {
      return null;
    }
  }

  async function createDirectory(inputPath) {
    const resolved = resolvePath(inputPath);
    assertWithinWorkspace(inputPath, resolved);
    if (isRemote()) {
      await vscode.commands.executeCommand('ssh.fs.createDirectory', resolved);
      return;
    }
    await fs.promises.mkdir(resolved, { recursive: true });
  }

  async function deletePath(inputPath, options = {}) {
    const resolved = resolvePath(inputPath);
    assertWithinWorkspace(inputPath, resolved);
    if (isRemote()) {
      await vscode.commands.executeCommand('ssh.fs.delete', resolved, options);
      return;
    }
    if (options.recursive) {
      await fs.promises.rm(resolved, { recursive: true, force: true });
    } else {
      await fs.promises.unlink(resolved);
    }
  }

  async function rename(oldPath, newPath) {
    const resolvedOld = resolvePath(oldPath);
    const resolvedNew = resolvePath(newPath);
    assertWithinWorkspace(oldPath, resolvedOld);
    assertWithinWorkspace(newPath, resolvedNew);
    if (isRemote()) {
      await vscode.commands.executeCommand('ssh.fs.rename', resolvedOld, resolvedNew);
      return;
    }
    await fs.promises.rename(resolvedOld, resolvedNew);
  }

  return {
    isRemote,
    getWorkspaceRoot,
    resolvePath,
    readFile,
    writeFile,
    readDirectory,
    stat,
    createDirectory,
    delete: deletePath,
    rename,
  };
}

module.exports = { createFsAdapter };
