/**
 * Tool: get_file_tree
 *
 * 获取指定目录的树形结构（异步实现，不阻塞 Extension Host）。
 */

const fs = require('fs');
const path = require('path');

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

  if (!path.isAbsolute(targetPath) && workspaceRoot) {
    targetPath = path.join(workspaceRoot, targetPath);
  }
  targetPath = path.resolve(targetPath);

  // 路径边界检查
  if (workspaceRoot && !targetPath.startsWith(path.resolve(workspaceRoot))) {
    return { success: false, error: `拒绝访问工作区外的路径: ${args.path}` };
  }

  let count = 0;

  async function walk(dir, currentDepth) {
    if (currentDepth > depth || count >= MAX_FILES) return [];
    let items;
    try {
      items = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const dirs = items.filter((i) => i.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    const files = items.filter((i) => i.isFile()).sort((a, b) => a.name.localeCompare(b.name));
    const entries = [];

    for (const item of [...dirs, ...files]) {
      if (count >= MAX_FILES) break;
      if (item.name.startsWith('.') && !IGNORED_DIRS.has(item.name) && item.isDirectory()) continue;
      if (IGNORED_DIRS.has(item.name)) continue;
      if (item.isFile() && IGNORED_FILES.has(item.name)) continue;

      const fullPath = path.join(dir, item.name);
      const relPath = path.relative(targetPath, fullPath);
      const prefix = '  '.repeat(currentDepth);
      if (item.isDirectory()) {
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
    const stat = await fs.promises.stat(targetPath);
    if (!stat.isDirectory()) {
      return { success: false, error: `路径不是目录: ${args.path}` };
    }

    const lines = await walk(targetPath, 0);
    const treeText = [`📁 ${path.basename(targetPath)}/`, ...lines].join('\n');
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

module.exports = getFileTree;
