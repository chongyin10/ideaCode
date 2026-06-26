/**
 * VSCode 兼容 API 存根 (Git 扩展)
 *
 * 在 Extension Host 进程中运行，通过 process.send / process.on('message')
 * 与主进程进行 JSON-RPC 通信。
 */

class EventEmitter {
  constructor() {
    this._listeners = new Set();
  }
  fire(data) {
    for (const listener of this._listeners) {
      try { listener(data); } catch { /* ignore */ }
    }
  }
  get event() {
    const self = this;
    return function (listener) {
      self._listeners.add(listener);
      return { dispose: () => self._listeners.delete(listener) };
    };
  }
}

const send = (method, params) => {
  if (typeof process !== 'undefined' && process.send) {
    process.send({ jsonrpc: '2.0', method, params });
  }
};

/**
 * 向主进程发送 JSON-RPC 请求并等待响应
 * 用于查询 workspace 状态、调用主进程能力等
 */
function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (typeof process === 'undefined' || !process.send) {
      reject(new Error('Extension Host not connected'));
      return;
    }
    const id = Date.now() + Math.random();
    const handler = (msg) => {
      if (msg && msg.id === id) {
        process.removeListener('message', handler);
        if (msg.error) reject(new Error(msg.error.message || msg.error));
        else resolve(msg.result);
      }
    };
    process.on('message', handler);
    process.send({ jsonrpc: '2.0', id, method, params });
    setTimeout(() => {
      process.removeListener('message', handler);
      reject(new Error(`RPC timeout: ${method}`));
    }, 30000);
  });
}

const vscode = {
  window: {
    showInformationMessage: (message) => send('window.showInformationMessage', { message }),
    showErrorMessage: (message) => send('window.showErrorMessage', { message }),
    showWarningMessage: (message) => send('window.showWarningMessage', { message }),
    createWebviewPanel: (viewType, title, _showOptions, options) => {
      const panelId = `git-webview-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      send('webview.create', {
        id: panelId, viewType, title, options,
      });
      return {
        id: panelId,
        viewType,
        title,
        webview: {
          _html: '',
          get html() { return this._html; },
          set html(value) {
            this._html = value;
            send('webview.setHtml', { id: panelId, html: value });
          },
          options: options || {},
          cspSource: 'ideacode-webview-resource:',
          postMessage: (message) => send('webview.postMessage', { id: panelId, message }),
          onDidReceiveMessage: (callback) => {
            if (!global._gitWebviewHandlers) global._gitWebviewHandlers = new Map();
            if (!global._gitWebviewHandlers.has(panelId)) {
              global._gitWebviewHandlers.set(panelId, []);
            }
            global._gitWebviewHandlers.get(panelId).push(callback);
            return { dispose: () => {} };
          },
          asWebviewUri: (localResource) => `ideacode-webview-resource://${localResource.fsPath}`,
        },
        onDidDispose: (callback) => ({ dispose: () => {} }),
        onDidChangeViewState: (callback) => ({ dispose: () => {} }),
        reveal: () => send('webview.reveal', { id: panelId }),
        dispose: () => send('webview.dispose', { id: panelId }),
      };
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (key, defaultValue) => defaultValue,
      update: () => Promise.resolve(),
    }),
    /**
     * 获取当前工作区根路径（直接 RPC 调用，会转发到渲染进程查询 Redux state）
     */
    getRootPath: () => request('workspace.getRootPath'),
    getWorkspaceFolders: () => request('workspace.getFolders').then((r) => r || []),
    onDidChangeWorkspaceFolders: (_callback) => ({ dispose: () => {} }),
  },
  commands: {
    registerCommand: (command, handler) => {
      if (!global._gitCommandHandlers) global._gitCommandHandlers = new Map();
      global._gitCommandHandlers.set(command, handler);
      return { dispose: () => global._gitCommandHandlers?.delete(command) };
    },
    executeCommand: (command, ...args) => {
      // 本地命令
      if (global._gitCommandHandlers && global._gitCommandHandlers.has(command)) {
        return Promise.resolve(global._gitCommandHandlers.get(command)(...args));
      }
      // 转发到主进程
      return new Promise((resolve, reject) => {
        const id = Date.now() + Math.random();
        const handler = (msg) => {
          if (msg.id === id) {
            process.removeListener('message', handler);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
          }
        };
        process.on('message', handler);
        if (typeof process !== 'undefined' && process.send) {
          process.send({ jsonrpc: '2.0', id, method: 'commands.execute', params: { command, args } });
        }
        setTimeout(() => {
          process.removeListener('message', handler);
          reject(new Error(`Command execution timeout: ${command}`));
        }, 30000);
      });
    },
  },
  Uri: {
    file: (path) => ({ fsPath: path, scheme: 'file' }),
    parse: (uri) => {
      const match = uri.match(/^([^:]+):\/\/(.+)$/);
      return match ? { scheme: match[1], fsPath: match[2] } : { scheme: 'file', fsPath: uri };
    },
  },
  env: {
    appName: 'IDEACODE',
    appRoot: typeof process !== 'undefined' ? process.cwd() : '',
    shell: process.env.SHELL || '',
  },
  version: '1.0.0',
  EventEmitter,
  Disposable: class Disposable {
    constructor(fn) { this._fn = fn; }
    dispose() { if (this._fn) { try { this._fn(); } catch { /* ignore */ } this._fn = null; } }
    static from(...disposables) {
      return new Disposable(() => { for (const d of disposables) { try { d.dispose(); } catch { /* ignore */ } } });
    }
  },
};

// 接收主进程转发的 WebView 消息
if (typeof process !== 'undefined') {
  process.on('message', (msg) => {
    if (msg && msg.method === 'webview.message' && msg.params) {
      const { id, message } = msg.params;
      const handlers = global._gitWebviewHandlers?.get(id);
      if (handlers) {
        for (const h of handlers) {
          try { h(message); } catch (e) { console.error('[Git] webview handler error:', e); }
        }
      }
    }
  });
}

module.exports = vscode;
module.exports.request = request;
module.exports.send = send;