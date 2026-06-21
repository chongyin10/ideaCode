const { fork } = require('child_process');
const path = require('path');
const { Channels } = require('../shared/channels.cjs');

/**
 * 扩展宿主进程管理器 (Extension Host Process)
 * 
 * 设计思想：
 * - 所有第三方插件/扩展在这个独立的 Node.js 子进程中运行
 * - 与主进程通过 JSON-RPC 协议通信
 * - 插件崩溃不会拖垮主界面（进程隔离）
 * - 插件无法直接访问 DOM 或操作系统 API（安全隔离）
 * 
 * 通信流程：
 * 渲染进程 → 主进程 IPC → Extension Host (JSON-RPC) → 插件
 * 插件响应 → Extension Host (JSON-RPC) → 主进程 IPC → 渲染进程
 */
class ExtensionHostManager {
  constructor(windowManager) {
    this.windowManager = windowManager;
    /** @type {import('child_process').ChildProcess|null} */
    this.hostProcess = null;
    this.isRunning = false;
    this.messageId = 0;
    /** @type {Map<number, {resolve: Function, reject: Function}>} */
    this.pendingRequests = new Map();
  }

  /**
   * 启动扩展宿主进程
   */
  start() {
    if (this.isRunning) return;

    const hostPath = path.join(__dirname, '..', 'extension-host', 'index.cjs');
    this.hostProcess = fork(hostPath, [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      // 插件在独立进程中运行，无窗口环境
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });

    this.hostProcess.on('message', (message) => {
      this.handleHostMessage(message);
    });

    this.hostProcess.on('error', (err) => {
      console.error('[ExtensionHost] 进程错误:', err);
      this.restart();
    });

    this.hostProcess.on('exit', (code) => {
      console.log(`[ExtensionHost] 进程退出，代码: ${code}`);
      this.isRunning = false;
      this.hostProcess = null;
      // 通知所有渲染进程扩展宿主已停止
      this.windowManager.broadcast(Channels.EXTENSION_HOST_MESSAGE, {
        type: 'hostStopped',
        code,
      });
    });

    this.isRunning = true;
    console.log('[ExtensionHost] 扩展宿主进程已启动');
  }

  /**
   * 停止扩展宿主进程
   */
  stop() {
    if (!this.hostProcess) return;

    // 优雅关闭：发送退出信号
    this.sendRpc('host.shutdown', {});

    // 强制终止（如果 5 秒内未退出）
    setTimeout(() => {
      if (this.hostProcess && !this.hostProcess.killed) {
        this.hostProcess.kill('SIGTERM');
      }
    }, 5000);
  }

  /**
   * 重启扩展宿主进程
   */
  restart() {
    this.stop();
    setTimeout(() => this.start(), 1000);
  }

  /**
   * 向扩展宿主发送 JSON-RPC 请求
   */
  sendRpc(method, params) {
    if (!this.hostProcess) return Promise.reject(new Error('Extension Host 未运行'));

    const id = ++this.messageId;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });

      // 设置超时
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`RPC 请求超时: ${method}`));
        }
      }, 30000);

      this.hostProcess.send({
        jsonrpc: '2.0',
        id,
        method,
        params,
      });
    });
  }

  /**
   * 向扩展宿主发送通知（无需响应）
   */
  sendNotification(method, params) {
    if (!this.hostProcess) return;
    this.hostProcess.send({
      jsonrpc: '2.0',
      method,
      params,
    });
  }

  /**
   * 处理扩展宿主发来的消息
   */
  handleHostMessage(message) {
    // JSON-RPC 响应
    if (message.id !== undefined && this.pendingRequests.has(message.id)) {
      const { resolve, reject } = this.pendingRequests.get(message.id);
      this.pendingRequests.delete(message.id);
      if (message.error) {
        reject(new Error(message.error.message));
      } else {
        resolve(message.result);
      }
      return;
    }

    // JSON-RPC 请求（Extension Host 向主进程请求）
    if (message.method && message.id !== undefined) {
      this.handleHostRequest(message).catch(console.error);
      return;
    }

    // JSON-RPC 通知 / 推送消息
    if (message.method) {
      // 将扩展消息广播到所有渲染进程
      this.windowManager.broadcast(Channels.EXTENSION_MESSAGE, {
        method: message.method,
        params: message.params,
      });
    }
  }

  /**
   * 处理 Extension Host 发来的请求（需要响应）
   */
  async handleHostRequest(message) {
    const { id, method, params } = message;
    let result;
    let error = null;

    try {
      switch (method) {
        case 'commands.execute': {
          // 转发到渲染进程执行命令
          const { command, args } = params;
          // 这里需要广播到渲染进程并等待响应
          // 简化实现：直接返回成功
          result = { executed: true, command };
          break;
        }
        case 'window.showInformationMessage':
        case 'window.showErrorMessage':
        case 'window.showWarningMessage': {
          // 广播到渲染进程显示消息
          this.windowManager.broadcast(Channels.EXTENSION_MESSAGE, {
            method,
            params,
          });
          result = { shown: true };
          break;
        }
        case 'webview.create':
        case 'webview.dispose':
        case 'webview.reveal':
        case 'webview.postMessage':
        case 'tree.register':
        case 'tree.unregister':
        case 'webviewView.register':
        case 'webviewView.unregister': {
          // 广播到渲染进程处理 WebView
          this.windowManager.broadcast(Channels.EXTENSION_MESSAGE, {
            method,
            params,
          });
          result = { processed: true };
          break;
        }
        default: {
          // 未知方法，广播到渲染进程
          this.windowManager.broadcast(Channels.EXTENSION_MESSAGE, {
            method,
            params,
          });
          result = { processed: true };
        }
      }
    } catch (err) {
      error = {
        code: -32603,
        message: err.message || 'Internal error',
      };
    }

    // 发送响应回 Extension Host
    if (this.hostProcess) {
      this.hostProcess.send({
        jsonrpc: '2.0',
        id,
        result: error ? undefined : result,
        error: error || undefined,
      });
    }
  }

  /**
   * 处理渲染进程的扩展请求
   */
  handleRendererRequest(method, params) {
    return this.sendRpc(method, params);
  }
}

module.exports = { ExtensionHostManager };
