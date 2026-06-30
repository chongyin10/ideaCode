const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { Channels } = require('../shared/channels.cjs');

/**
 * 解析 app 根目录，注入给扩展宿主子进程作为 IDEACODE_APP_ROOT 环境变量。
 *
 * - dev 模式：app.getAppPath() 返回 main.cjs 所在目录（electron/），
 *   不是项目根。改为 __dirname 向上推 2 级（main → electron → 项目根）。
 * - prod 模式：process.cwd() 是 `/`（macOS GUI 启动不继承 shell 工作目录），
 *   用 app.getAppPath() 拿到 ASAR root。
 */
function resolveAppRoot() {
  try {
    if (app.isPackaged) return app.getAppPath();
  } catch { /* 非 Electron 环境，忽略 */ }
  // dev：extensionHost.cjs 在 electron/main/，向上推 2 级到项目根
  return path.resolve(__dirname, '..', '..');
}

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
    /** 渲染进程请求-响应 id 计数器 */
    this.rendererRequestId = 0;
    /** @type {Map<number, {resolve: Function, reject: Function}>} */
    this.pendingRendererRequests = new Map();
    /** 是否在用户主动停止时（避免热重启循环） */
    this.stopping = false;
    /** 是否正在热重启（文件变化/异常触发的 kill→restart）。
     *  与 stopping 区分：stopping 表示用户主动永久停止，不应再启动；
     *  _hotRestarting 表示为热重启而 kill，exit 后需要立即 start()。
     *  原先用 stopping 复用会导致 exit 处理器跳过重启，使热重启变成永久停止。 */
    this._hotRestarting = false;
    /** 文件监听器（dev 模式用） */
    this.fileWatcher = null;
    /** 文件变化防抖定时器 */
    this.restartTimer = null;
    /** 监视的扩展目录列表（按扩展 id） */
    this.watchedDirs = new Set();
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
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        // 注入 app root，避免子进程内 process.cwd() 为 / 导致路径解析失败
        IDEACODE_APP_ROOT: resolveAppRoot(),
      },
    });

    // 将扩展宿主日志转发到主进程控制台，方便调试
    this.hostProcess.stdout?.on('data', (data) => {
      process.stdout.write(`[ExtensionHost] ${data}`);
    });
    this.hostProcess.stderr?.on('data', (data) => {
      process.stderr.write(`[ExtensionHost] ${data}`);
    });

    this.hostProcess.on('message', (message) => {
      this.handleHostMessage(message);
    });

    this.hostProcess.on('error', (err) => {
      console.error('[ExtensionHost] 进程错误:', err);
      if (!this.stopping) this.scheduleRestart(1000, 'error');
    });

    this.hostProcess.on('exit', (code, signal) => {
      console.log(`[ExtensionHost] 进程退出，代码: ${code} signal: ${signal || 'none'}`);
      const wasHotRestarting = this._hotRestarting;
      this.isRunning = false;
      this.hostProcess = null;
      this._hotRestarting = false;
      // 通知所有渲染进程扩展宿主已停止
      this.windowManager.broadcast(Channels.EXTENSION_HOST_MESSAGE, {
        type: 'hostStopped',
        code,
      });

      // 主动停止时（用户调用 stop）不再自启
      if (this.stopping) return;

      if (wasHotRestarting) {
        // 热重启：立即拉起新进程（_killAndRestart 已设置好上下文）
        console.log('[ExtensionHost] 热重启：立即重新启动');
        this.start();
      } else {
        // 非主动退出 → 自动重启（dev 模式开发体验）
        this.scheduleRestart(800, 'unexpected-exit');
      }
    });

    this.isRunning = true;
    this.stopping = false;
    this._hotRestarting = false;
    console.log('[ExtensionHost] 扩展宿主进程已启动');

    // 启动 dev 模式文件监视
    this.startFileWatchers();
  }

  /**
   * 设置 dev 模式文件监视：扩展源文件变化时自动重启 Extension Host
   */
  startFileWatchers() {
    if (this.fileWatcher) return; // 已经启动过
    if (process.env.NODE_ENV === 'production' || process.env.LIFEAICODE_DISABLE_HOTRELOAD === '1') {
      console.log('[ExtensionHost] 生产模式或显式禁用，跳过文件监视');
      return;
    }
    // 显式启用（默认就是开启的）
    if (process.env.LIFEAICODE_HOTRELOAD === '0') {
      console.log('[ExtensionHost] 显式禁用热重启 (LIFEAICODE_HOTRELOAD=0)');
      return;
    }

    // 默认监视整个 extensions 目录
    const extensionsDir = path.resolve(__dirname, '..', '..', 'extensions');
    this._addWatchDir(extensionsDir);

    // 启动聚合后的 fs.watch
    this._setupAggregateWatcher();
  }

  /**
   * 记录要监视的目录
   */
  _addWatchDir(dir) {
    if (this.watchedDirs.has(dir)) return;
    this.watchedDirs.add(dir);
    console.log(`[ExtensionHost] 加入监视: ${dir}`);
  }

  /**
   * 启动聚合的 fs.watch
   */
  _setupAggregateWatcher() {
    if (this.fileWatcher) return;

    // fs.watch 跨平台表现：
    // - macOS / Windows：recursive: true 有效
    // - Linux：Node 20+ 支持 recursive
    // 兼容回退：每个目录单独 watch
    this.fileWatcher = { dirs: new Map() };

    const startWatch = (dir) => {
      if (this.fileWatcher.dirs.has(dir)) return;
      try {
        const opts = { persistent: true };
        if (process.platform !== 'linux' || parseInt(process.versions.node) >= 20) {
          opts.recursive = true;
        }
        const w = fs.watch(dir, opts, (eventType, filename) => {
          if (!filename) return;
          // 只关心扩展相关文件（.js / .cjs / .json）
          if (!/\.(js|cjs|json)$/i.test(filename)) return;
          const rel = path.relative(dir, path.join(dir, filename));
          // 排除 node_modules / webview / dist / 扩展运行时数据文件
          if (rel.startsWith('node_modules') || rel.startsWith('webview') || rel.startsWith('webview-dist') || rel.startsWith('.')) return;
          if (/\.lifeAiCode-config\.json$/i.test(filename)) return;
          console.log(`[ExtensionHost] 检测到文件变化: ${eventType} ${path.join(dir, filename)}`);
          this.scheduleRestart(400, 'file-change');
        });
        w.on('error', (err) => {
          console.error(`[ExtensionHost] 文件监视错误 (${dir}):`, err.message);
        });
        this.fileWatcher.dirs.set(dir, w);
      } catch (err) {
        console.error(`[ExtensionHost] 启动监视失败 (${dir}):`, err.message);
      }
    };

    // 为已记录的目录逐个启动
    for (const dir of this.watchedDirs) {
      startWatch(dir);
    }

    // 关闭时清理
    this._stopAggregateWatcher = () => {
      if (this.fileWatcher) {
        for (const w of this.fileWatcher.dirs.values()) {
          try { w.close(); } catch { /* ignore */ }
        }
        this.fileWatcher = null;
      }
    };
  }

  /**
   * 防抖重启：合并短时间内的多次变化
   */
  scheduleRestart(delayMs, reason) {
    if (this.stopping) return;
    // 正在热重启（已发 SIGTERM，等 exit 事件拉起新进程）时，忽略新的重启请求，
    // 避免 exit 前重复 kill / 重复 start。
    if (this._hotRestarting) return;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.isRunning) {
        console.log(`[ExtensionHost] 热重启 (${reason})`);
        this._killAndRestart();
      } else {
        console.log(`[ExtensionHost] 重启 (${reason})`);
        this.start();
      }
    }, delayMs);
  }

  _killAndRestart() {
    if (!this.hostProcess) {
      this.start();
      return;
    }
    // 标记热重启（而非用户主动停止），exit 事件会据此立即拉起新进程。
    // 不能复用 this.stopping：那会导致 exit 处理器跳过重启，热重启变成永久停止。
    this._hotRestarting = true;
    const proc = this.hostProcess;
    try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    // 兜底：2 秒后强杀
    setTimeout(() => {
      try { if (!proc.killed) proc.kill('SIGKILL'); } catch { /* ignore */ }
    }, 2000);
    // exit 事件会自动清理 isRunning/hostProcess 并触发 start()
  }

  /**
   * 停止扩展宿主进程
   */
  stop() {
    if (!this.hostProcess) return;

    this.stopping = true;
    // 清理热重启标志：用户主动停止时，exit 不应再触发重启
    this._hotRestarting = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this._stopAggregateWatcher) {
      this._stopAggregateWatcher();
      this._stopAggregateWatcher = null;
    }
    this.watchedDirs.clear();

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
   * @deprecated 用 scheduleRestart() 代替，文件变化会通过防抖自动触发
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
   * 向渲染进程发送请求并等待响应（Extension Host → Main → Renderer）
   */
  requestRenderer(method, params, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const windows = this.windowManager.getAllWindows().filter((w) => !w.isDestroyed());
      if (windows.length === 0) {
        reject(new Error('没有可用的渲染进程窗口'));
        return;
      }

      const focused = windows.find((w) => w.isFocused());
      const target = focused || windows[0];
      const reqId = ++this.rendererRequestId;
      this.pendingRendererRequests.set(reqId, { resolve, reject });

      const timer = setTimeout(() => {
        if (this.pendingRendererRequests.has(reqId)) {
          this.pendingRendererRequests.delete(reqId);
          reject(new Error(`渲染进程请求超时: ${method}`));
        }
      }, timeout);

      // 避免内存泄漏：清理计时器引用
      const originalResolve = resolve;
      const originalReject = reject;
      resolve = (value) => {
        clearTimeout(timer);
        originalResolve(value);
      };
      reject = (reason) => {
        clearTimeout(timer);
        originalReject(reason);
      };
      this.pendingRendererRequests.set(reqId, { resolve, reject });

      target.webContents.send(Channels.EXTENSION_HOST_REQUEST_RENDERER, {
        id: reqId,
        method,
        params,
      });
    });
  }

  /**
   * 处理渲染进程返回的响应
   */
  handleRendererResponse(id, result, error) {
    const pending = this.pendingRendererRequests.get(id);
    if (!pending) return;
    this.pendingRendererRequests.delete(id);
    if (error) {
      pending.reject(new Error(error));
    } else {
      pending.resolve(result);
    }
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
   * 判断某个 RPC 方法是否应该从渲染进程取真实数据
   */
  _needsRendererData(method) {
    return (
      method.startsWith('editor.') ||
      method.startsWith('workspace.') ||
      method.startsWith('configuration.') ||
      method.startsWith('storage.') ||
      method.startsWith('secrets.') ||
      method.startsWith('env.') ||
      // Git 扩展调用的方法：需要从渲染进程获取真实数据或调用其能力
      method.startsWith('git.') ||
      // __ 开头的内部命令（如 __git_getRootPath）也走渲染进程
      method.startsWith('__git_')
    );
  }

  /**
   * 处理 Extension Host 发来的请求（需要响应）
   */
  async handleHostRequest(message) {
    const { id, method, params } = message;
    let result;
    let error = null;

    try {
      // 需要真实数据的方法：转发到渲染进程并等待响应
      if (this._needsRendererData(method)) {
        result = await this.requestRenderer(method, params);
      } else {
        switch (method) {
          case 'commands.execute': {
            // 转发到渲染进程执行命令（广播，不等待结果）
            const { command, args } = params;
            this.windowManager.broadcast(Channels.EXTENSION_MESSAGE, {
              method,
              params,
            });
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
          case 'webviewView.unregister':
          case 'terminal.create':
          case 'lifeAiCode.applyChanges':
          case 'lifeAiCode.fileChanged': {
            // 广播到渲染进程处理 WebView / 终端 / 文件变更刷新
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
