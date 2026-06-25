/**
 * Tool: search_files
 *
 * 在项目中搜索文件或代码内容（异步实现，不阻塞 Extension Host）。
 * - 使用 fs.promises 全异步
 * - 限制单次最多扫描 100 个文件、收集 50 个匹配
 * - 自动忽略 node_modules / .git / 二进制文件 / 图片字体视频等
 */

const fs = require('fs');
const path = require('path');

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

async function searchFiles(args, context) {
  const { pattern, glob } = args || {};
  if (!pattern || typeof pattern !== 'string') {
    return { success: false, error: '缺少 pattern 参数' };
  }

  const workspaceRoot = context.workspaceRoot || '';
  if (!workspaceRoot) {
    return { success: false, error: '未打开工作区，无法搜索' };
  }

  const rootPath = path.resolve(workspaceRoot);

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
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (matches.length >= MAX_MATCHES) return;
      if (scannedFiles >= MAX_FILES) return;
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.')) continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (IGNORED_EXTS.has(ext)) continue;
        if (allowedExts && !allowedExts.has(ext)) continue;

        scannedFiles++;
        try {
          const content = await fs.promises.readFile(fullPath, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            regex.lastIndex = 0;
            if (regex.test(lines[i])) {
              const relPath = path.relative(rootPath, fullPath);
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

module.exports = searchFiles;
