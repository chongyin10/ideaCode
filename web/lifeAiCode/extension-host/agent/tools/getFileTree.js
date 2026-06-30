/**
 * Tool: get_file_tree
 *
 * 获取指定目录的树形结构（异步实现，不阻塞 Extension Host）。
 * §SSH 远程工作区支持：使用 context.fs 统一适配器读取远程目录。
 */

const fs = require('fs');
const path = require('path');
const { isRemoteUri, parseSshUri } = require('../../sshUri');

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.vite', '.next', '.nuxt',
  'coverage', '.cache', 'tmp', 'temp', 'vendor', '__pycache__',
]);
const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db']);
const MAX_FILES = 120;

async function getFileTree(args, context) {
  const workspaceRoot = context.workspaceRoot || '';
  let targetPath = (args && args.path) || workspaceRoot || process.cwd();
  const depth = Math.min(Math.max(Number(args && args.depth) || 2, 1), 4);

  const fsAdapter = context.fs || createLocalFsAdapter();
  const isRemote = isRemoteUri(workspaceRoot);

  let rootRemotePath = '';
  if (isRemote) {
    const sshInfo = parseSshUri(workspaceRoot);
    rootRemotePath = sshInfo.remotePath || '';
    // targetPath 可能是相对路径或 ssh URI；用适配器解析
    try {
      targetPath = fsAdapter.resolvePath(targetPath);
    } catch (err) {
      return { success: false, error: `解析路径失败: ${err.message}` };
    }
  } else {
    if (!path.isAbsolute(targetPath) && workspaceRoot) {
      targetPath = path.join(workspaceRoot, targetPath);
    }
    targetPath = path.resolve(targetPath);

    // 路径边界检查
    if (workspaceRoot && !targetPath.startsWith(path.resolve(workspaceRoot))) {
      return { success: false, error: `拒绝访问工作区外的路径: ${args.path}` };
    }
  }

  let count = 0;

  async function walk(dir, currentDepth) {
    if (currentDepth > depth || count >= MAX_FILES) return [];
    let items;
    try {
      items = await fsAdapter.readDirectory(dir);
    } catch {
      return [];
    }

    const dirs = items.filter((i) => i.kind === 'directory').sort((a, b) => a.name.localeCompare(b.name));
    const files = items.filter((i) => i.kind === 'file').sort((a, b) => a.name.localeCompare(b.name));
    const entries = [];

    for (const item of [...dirs, ...files]) {
      if (count >= MAX_FILES) break;
      if (item.name.startsWith('.') && !IGNORED_DIRS.has(item.name)) continue;
      if (IGNORED_DIRS.has(item.name)) continue;
      if (item.kind === 'file' && IGNORED_FILES.has(item.name)) continue;

      const fullPath = isRemote ? item.uri : path.join(dir, item.name);
      const relPath = isRemote
        ? (rootRemotePath && fullPath.startsWith(rootRemotePath) ? fullPath.slice(rootRemotePath.length + 1) : fullPath)
        : path.relative(targetPath, fullPath);
      const prefix = '  '.repeat(currentDepth);
      if (item.kind === 'directory') {
        entries.push(`${prefix}📁 ${item.name}/`);
        count++;
        const sub = await walk(fullPath, currentDepth + 1);
        entries.push(...sub);
      } else {
        entries.push(`${prefix}📄 ${item.name}`);
        count++;
      }
    }
    return entries;
  }

  try {
    const stat = await fsAdapter.stat(targetPath);
    if (!stat || !stat.isDirectory) {
      return { success: false, error: `路径不是目录: ${args.path}` };
    }

    const lines = await walk(targetPath, 0);
    const displayName = isRemote
      ? (targetPath.startsWith(rootRemotePath) ? targetPath.slice(rootRemotePath.length + 1) || '/' : targetPath)
      : path.basename(targetPath);
    const treeText = [`📁 ${displayName}/`, ...lines].join('\n');
    return {
      success: true,
      path: args.path || workspaceRoot,
      depth,
      fileCount: count,
      tree: treeText,
    };
  } catch (err) {
    return { success: false, error: `获取目录树失败: ${err.message}` };
  }
}

function createLocalFsAdapter() {
  return {
    readDirectory: (dir) => fs.promises.readdir(dir, { withFileTypes: true }).then((dirents) => dirents.map((d) => ({
      name: d.name,
      kind: d.isDirectory() ? 'directory' : 'file',
      uri: path.join(dir, d.name),
    }))),
    stat: (p) => fs.promises.stat(p).then((s) => ({ isDirectory: s.isDirectory(), size: s.size })),
  };
}

module.exports = getFileTree;
