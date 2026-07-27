/**
 * listFiles —— 为 WebView 的 @ 文件补全提供工作区文件列表
 *
 * 递归遍历当前工作区，产出扁平的相对路径列表（目录 + 文件），
 * 供 ChatPanel 输入框本地过滤使用。
 * §SSH 远程工作区支持：通过 remoteFsAdapter 统一适配器读取远程目录。
 */

const path = require('path');
const { createFsAdapter } = require('./remoteFsAdapter');
const { isRemoteUri, parseSshUri } = require('./sshUri');

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.vite', '.next', '.nuxt',
  'coverage', '.cache', 'tmp', 'temp', 'vendor', '__pycache__',
]);
const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db']);
const MAX_ENTRIES = 1000;

/**
 * @param {{ rpc: { request: (method: string, params: object) => Promise<any> } }} context
 * @returns {Promise<Array<{ name: string, path: string, isDirectory: boolean }>>}
 */
async function listWorkspaceFiles(context) {
  // 获取工作区根路径（与 codeContext.js 同模式）
  let workspaceRoot = '';
  try {
    const folders = await context.rpc.request('workspace.getFolders', {});
    if (folders && folders.length > 0) {
      const uri = folders[0].uri || {};
      workspaceRoot = uri.fsPath || (typeof uri.toString === 'function' ? uri.toString() : '') || '';
    }
  } catch {
    // ignore
  }
  if (!workspaceRoot) return [];

  const fsAdapter = createFsAdapter({ workspaceRoot });
  const isRemote = isRemoteUri(workspaceRoot);
  const rootRemotePath = isRemote ? (parseSshUri(workspaceRoot).remotePath || '') : '';

  const results = [];

  function toRelative(fullPath) {
    if (isRemote) {
      const remotePath = parseSshUri(fullPath).remotePath || fullPath;
      return rootRemotePath && remotePath.startsWith(rootRemotePath + '/')
        ? remotePath.slice(rootRemotePath.length + 1)
        : remotePath;
    }
    return path.relative(workspaceRoot, fullPath);
  }

  async function walk(dir) {
    if (results.length >= MAX_ENTRIES) return;
    let items;
    try {
      items = await fsAdapter.readDirectory(dir);
    } catch {
      return;
    }

    const dirs = items.filter((i) => i.kind === 'directory').sort((a, b) => a.name.localeCompare(b.name));
    const files = items.filter((i) => i.kind === 'file').sort((a, b) => a.name.localeCompare(b.name));

    for (const item of [...dirs, ...files]) {
      if (results.length >= MAX_ENTRIES) return;
      if (item.name.startsWith('.')) continue;
      if (IGNORED_DIRS.has(item.name)) continue;
      if (item.kind === 'file' && IGNORED_FILES.has(item.name)) continue;

      const fullPath = item.uri || path.join(dir, item.name);
      results.push({
        name: item.name,
        path: toRelative(fullPath),
        isDirectory: item.kind === 'directory',
      });
      if (item.kind === 'directory') {
        await walk(fullPath);
      }
    }
  }

  await walk(workspaceRoot);
  return results;
}

module.exports = { listWorkspaceFiles };
