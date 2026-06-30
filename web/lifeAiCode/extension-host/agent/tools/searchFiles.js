/**
 * Tool: search_files
 *
 * 在项目中搜索文件或代码内容（异步实现，不阻塞 Extension Host）。
 * - 使用 fs.promises 全异步
 * - 限制单次最多扫描 100 个文件、收集 50 个匹配
 * - 自动忽略 node_modules / .git / 二进制文件 / 图片字体视频等
 * §SSH 远程工作区支持：使用 context.fs 统一适配器读取目录和文件。
 */

const fs = require('fs');
const path = require('path');
const { isRemoteUri, parseSshUri } = require('../../sshUri');

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.vite', '.next', '.nuxt',
  'coverage', '.cache', 'tmp', 'temp', 'vendor', '__pycache__',
]);
const IGNORED_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.eot',
  '.mp3', '.mp4', '.avi', '.mov', '.zip', '.tar', '.gz', '.rar', '.pdf',
]);
const MAX_FILES = 100;
const MAX_MATCHES = 50;
// 搜索场景单文件大小上限：跳过超大文件，防止 readFile 触发 Invalid string length
const MAX_SEARCH_FILE_SIZE = 10 * 1024 * 1024; // 10MB

async function searchFiles(args, context) {
  const { pattern, glob } = args || {};
  if (!pattern || typeof pattern !== 'string') {
    return { success: false, error: '缺少 pattern 参数' };
  }

  const workspaceRoot = context.workspaceRoot || '';
  if (!workspaceRoot) {
    return { success: false, error: '未打开工作区，无法搜索' };
  }

  const isRemote = isRemoteUri(workspaceRoot);
  const fsAdapter = context.fs || createLocalFsAdapter();

  let rootPath = workspaceRoot;
  let rootRemotePath = '';
  if (isRemote) {
    const sshInfo = parseSshUri(workspaceRoot);
    rootRemotePath = sshInfo.remotePath || '/';
    rootPath = workspaceRoot;
  } else {
    rootPath = path.resolve(workspaceRoot);
  }

  let regex;
  try {
    regex = new RegExp(pattern, 'g');
  } catch {
    // 如果 pattern 不是合法正则，按字面量匹配（转义）
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  }

  // 解析 glob，简化为扩展名过滤
  let allowedExts = null;
  if (glob && glob !== '**/*') {
    const extMatch = glob.match(/\.([a-zA-Z0-9]+)$/);
    if (extMatch) {
      allowedExts = new Set([`.${extMatch[1]}`]);
    }
  }

  const matches = [];
  let scannedFiles = 0;

  async function walk(dir) {
    if (matches.length >= MAX_MATCHES) return;
    if (scannedFiles >= MAX_FILES) return;

    let entries;
    try {
      entries = await fsAdapter.readDirectory(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (matches.length >= MAX_MATCHES) return;
      if (scannedFiles >= MAX_FILES) return;
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.')) continue;

      const fullPath = isRemote ? entry.uri : path.join(dir, entry.name);
      if (entry.kind === 'directory') {
        await walk(fullPath);
      } else if (entry.kind === 'file') {
        const ext = path.extname(entry.name).toLowerCase();
        if (IGNORED_EXTS.has(ext)) continue;
        if (allowedExts && !allowedExts.has(ext)) continue;

        scannedFiles++;
        try {
          // 大文件保护：跳过超大文件，防止 readFile 触发 Invalid string length
          const stat = await fsAdapter.stat(fullPath);
          if (!stat || stat.size > MAX_SEARCH_FILE_SIZE) continue;

          const raw = await fsAdapter.readFile(fullPath);
          const content = typeof raw === 'string' ? raw : raw.toString('utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            regex.lastIndex = 0;
            if (regex.test(lines[i])) {
              const relPath = isRemote
                ? (rootRemotePath && fullPath.startsWith(rootRemotePath) ? fullPath.slice(rootRemotePath.length + 1) : fullPath)
                : path.relative(rootPath, fullPath);
              matches.push({
                file: relPath,
                line: i + 1,
                text: lines[i].trim(),
              });
              if (matches.length >= MAX_MATCHES) return;
            }
          }
        } catch {
          // 二进制或不可读文件，跳过
        }
      }
    }
  }

  await walk(rootPath);

  return {
    success: true,
    pattern,
    glob: glob || '**/*',
    scannedFiles,
    matchCount: matches.length,
    matches,
  };
}

function createLocalFsAdapter() {
  return {
    readDirectory: (dir) => fs.promises.readdir(dir, { withFileTypes: true }).then((dirents) => dirents.map((d) => ({
      name: d.name,
      kind: d.isDirectory() ? 'directory' : 'file',
      uri: path.join(dir, d.name),
    }))),
    stat: (p) => fs.promises.stat(p).then((s) => ({ isDirectory: s.isDirectory(), size: s.size })),
    readFile: (p) => fs.promises.readFile(p, 'utf-8'),
  };
}

module.exports = searchFiles;
