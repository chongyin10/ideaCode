const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');

/**
 * 文件监听 Worker（多进程模式）
 * 
 * 运行在独立的线程中，监听指定目录的文件变更。
 * 优势：
 * 1. 不阻塞主进程事件循环
 * 2. 即使窗口失焦（后台模式），文件变更仍能被捕获
 * 3. 崩溃隔离：Worker 异常不会影响主进程稳定性
 */

const { watchPath } = workerData;

const watcher = fs.watch(watchPath, { recursive: true }, (eventType, filename) => {
  parentPort.postMessage({
    type: 'change',
    eventType,
    filename,
    path: watchPath,
    timestamp: Date.now(),
  });
});

parentPort.on('message', (msg) => {
  if (msg.type === 'stop') {
    watcher.close();
    parentPort.postMessage({ type: 'stopped' });
    process.exit(0);
  }
});
