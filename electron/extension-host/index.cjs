const { JsonRpcServer } = require('./rpc.cjs');
const fs = require('fs').promises;
const path = require('path');

/**
 * 扩展宿主进程入口
 * 
 * 这是独立的 Node.js 子进程，没有 Chromium 环境，只有纯 Node.js API。
 * 所有扩展/插件在此进程中运行，通过 JSON-RPC 与主进程通信。
 * 
 * 安全设计：
 * - 无法访问 DOM 或 BrowserWindow
 * - 无法直接与渲染进程通信
 * - 所有系统调用通过主进程代理
 */

const rpc = new JsonRpcServer();

// 设置向父进程（主进程）发送消息的函数
rpc.setSendFunction((message) => {
  if (process.send) {
    process.send(message);
  }
});

// 接收父进程消息
process.on('message', (message) => {
  rpc.handleMessage(message);
});

/* ────────────────────────────────────────────── */
/*  扩展宿主内置能力                               */
/* ────────────────────────────────────────────── */

// 文件系统搜索（模拟扩展的搜索能力）
rpc.on('fs.search', async (params) => {
  const { rootPath, query, maxResults = 100 } = params;
  const results = [];
  let count = 0;

  const excludeDirs = new Set([
    'node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.vscode',
  ]);

  async function searchDir(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (count >= maxResults) return;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!excludeDirs.has(entry.name)) {
          await searchDir(fullPath);
        }
        continue;
      }
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(query)) {
            results.push({ file: fullPath, line: i + 1, text: lines[i].trim().substring(0, 150) });
            count++;
            if (count >= maxResults) return;
          }
        }
      } catch {
        // 忽略二进制文件
      }
    }
  }

  await searchDir(rootPath);
  return { results, total: count };
});

// 文件内容分析（模拟扩展的语言分析能力）
rpc.on('fs.analyze', async (params) => {
  const { filePath } = params;
  const stat = await fs.stat(filePath);
  const content = await fs.readFile(filePath, 'utf-8');
  const lines = content.split('\n');

  return {
    path: filePath,
    size: stat.size,
    lines: lines.length,
    words: content.split(/\s+/).length,
    extension: path.extname(filePath),
  };
});

// 扩展宿主健康检查
rpc.on('host.ping', async () => {
  return { pong: true, timestamp: Date.now() };
});

// 关闭扩展宿主
rpc.on('host.shutdown', async () => {
  console.log('[ExtensionHost] 收到关闭信号，正在退出...');
  setTimeout(() => process.exit(0), 100);
  return { shuttingDown: true };
});

// 通知主进程扩展宿主已就绪
rpc.notify('host.ready', { pid: process.pid, version: '1.0.0' });

console.log('[ExtensionHost] 扩展宿主进程已启动，PID:', process.pid);
