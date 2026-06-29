const { parentPort, workerData } = require('worker_threads');
const fs = require('fs').promises;
const path = require('path');

/**
 * 全文搜索 Worker（多进程模式）
 * 
 * 在独立线程中执行耗时的大目录搜索，避免阻塞主进程 UI。
 * 支持实时进度推送和取消操作。
 */

const { rootPath, query, options = {} } = workerData;
const { maxResults = 100, includePattern, excludePattern } = options;

let cancelled = false;
let matched = 0;
const results = [];

const excludeDirs = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
]);

// 搜索场景单文件大小上限。超过此大小的文件（minified bundle、source map、大日志）
// 通常是生成产物而非源代码，跳过即可，避免 readFile 触发 Invalid string length。
const MAX_SEARCH_FILE_SIZE = 10 * 1024 * 1024; // 10MB

async function searchDir(dir) {
  if (cancelled) return;

  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (cancelled) return;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!excludeDirs.has(entry.name)) {
        await searchDir(fullPath);
      }
      continue;
    }

    if (!entry.isFile()) continue;

    // 简单的文件扩展名过滤
    if (excludePattern && new RegExp(excludePattern).test(entry.name)) continue;
    if (includePattern && !new RegExp(includePattern).test(entry.name)) continue;

    try {
      // 大文件保护：跳过超大文件，防止 readFile 触发 Invalid string length
      const stat = await fs.stat(fullPath);
      if (stat.size > MAX_SEARCH_FILE_SIZE) continue;

      const content = await fs.readFile(fullPath, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        if (cancelled) return;
        if (lines[i].includes(query)) {
          results.push({
            file: fullPath,
            line: i + 1,
            text: lines[i].trim().substring(0, 200),
          });
          matched++;

          // 每找到 10 条结果推送一次进度
          if (matched % 10 === 0) {
            parentPort.postMessage({ type: 'progress', count: matched });
          }

          if (matched >= maxResults) {
            cancelled = true;
            return;
          }
        }
      }
    } catch {
      // 忽略二进制文件或权限不足的文件
    }
  }
}

parentPort.on('message', (msg) => {
  if (msg.type === 'cancel') {
    cancelled = true;
  }
});

searchDir(rootPath).then(() => {
  parentPort.postMessage({ type: 'done', results, total: matched });
});
