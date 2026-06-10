const { Worker } = require('worker_threads');
const path = require('path');

/**
 * 后台任务管理器 - 多进程模式调度中心
 * 
 * 负责管理所有 Worker 线程的生命周期：
 * - 文件监听（后台模式持续运行）
 * - 全文搜索（大任务独立线程）
 * 
 * 设计原则：
 * 1. 每个 Worker 都是独立进程，崩溃不影响主进程
 * 2. 任务可取消，避免资源浪费
 * 3. 主进程通过消息通道与 Worker 通信
 */
class TaskManager {
  constructor() {
    /** @type {Map<string, Worker>} */
    this.workers = new Map();
    this.taskIdCounter = 0;
  }

  _makeId(prefix) {
    return `${prefix}:${++this.taskIdCounter}:${Date.now()}`;
  }

  /**
   * 启动文件监听任务（后台模式）
   * @param {string} watchPath 
   * @param {Function} onMessage 
   * @returns {string} taskId
   */
  startFileWatch(watchPath, onMessage) {
    const taskId = this._makeId('watch');
    if (this.workers.has(taskId)) return taskId;

    const worker = new Worker(path.join(__dirname, 'fileWatcher.cjs'), {
      workerData: { watchPath },
    });

    worker.on('message', onMessage);
    worker.on('error', (err) => console.error(`[Worker ${taskId}] error:`, err));
    worker.on('exit', () => this.workers.delete(taskId));

    this.workers.set(taskId, worker);
    return taskId;
  }

  /**
   * 启动全文搜索任务
   * @param {object} params { rootPath, query, options }
   * @param {Function} onMessage 
   * @returns {string} taskId
   */
  startSearch(params, onMessage) {
    const taskId = this._makeId('search');

    const worker = new Worker(path.join(__dirname, 'searchWorker.cjs'), {
      workerData: params,
    });

    worker.on('message', onMessage);
    worker.on('error', (err) => console.error(`[Worker ${taskId}] error:`, err));
    worker.on('exit', () => this.workers.delete(taskId));

    this.workers.set(taskId, worker);
    return taskId;
  }

  /**
   * 取消/停止指定任务
   * @param {string} taskId 
   * @returns {boolean}
   */
  stopTask(taskId) {
    const worker = this.workers.get(taskId);
    if (worker) {
      worker.postMessage({ type: 'stop' });
      return true;
    }
    return false;
  }

  /**
   * 取消搜索任务（发送 cancel 信号而非强制终止）
   * @param {string} taskId 
   */
  cancelSearch(taskId) {
    const worker = this.workers.get(taskId);
    if (worker) {
      worker.postMessage({ type: 'cancel' });
      return true;
    }
    return false;
  }

  /** 停止所有后台任务 */
  stopAll() {
    for (const [taskId, worker] of this.workers) {
      worker.postMessage({ type: 'stop' });
    }
    this.workers.clear();
  }

  /** 获取运行中的任务列表 */
  listTasks() {
    return Array.from(this.workers.keys());
  }
}

module.exports = { TaskManager };
