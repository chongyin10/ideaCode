/**
 * Tool: search_files
 *
 * 在项目中搜索文件或代码内容。
 * 当前使用简单递归遍历 + 字符串/正则匹配。
 * 未来可替换为渲染进程的 searchService 或主进程 searchWorker。
 */

const fs = require('fs');
const path = require('path');

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
    // 如果 pattern 不是合法正则，按字面量匹配
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

  const ignoredDirs = new Set([
    'node_modules', '.git', 'dist', 'build', 'out', '.vite', '.next', '.nuxt',
    'coverage', '.cache', 'tmp', 'temp', 'vendor', '__pycache__',
  ]);
  const ignoredExts = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.eot',
    '.mp3', '.mp4', '.avi', '.mov', '.zip', '.tar', '.gz', '.rar', '.pdf',
  ]);

  const matches = [];
  const MAX_FILES = 100;
  const MAX_MATCHES = 50;
  let scannedFiles = 0;

  function walk(dir) {
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const item of items) {
      if (matches.length >= MAX_MATCHES) return;
      if (scannedFiles >= MAX_FILES) return;
      if (ignoredDirs.has(item.name)) continue;
      if (item.name.startsWith('.')) continue;

      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        walk(fullPath);
      } else if (item.isFile()) {
        const ext = path.extname(item.name).toLowerCase();
        if (ignoredExts.has(ext)) continue;
        if (allowedExts && !allowedExts.has(ext)) continue;

        scannedFiles++;
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
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

  walk(rootPath);

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
