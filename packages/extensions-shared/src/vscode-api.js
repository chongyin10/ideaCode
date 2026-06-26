/**
 * 统一 VSCode 兼容 API (共享模块)
 *
 * 替代 extensions/git/api.js, extensions/ssh/api.js,
 * extensions/lifeAiCode/api.js 三个重复的 API 桩。
 *
 * 所有扩展通过此模块获取一致的 vscode API。
 * 在 Extension Host 进程中运行，通过 process.send / process.on('message')
 * 与主进程进行 JSON-RPC 通信。
 *
 * ============================================================================
 * 架构变更 (微内核):
 *   之前：每个扩展拥有自己的 api.js，接口不统一，存在兼容性问题
 *   现在：统一使用此模块，接口一致，易于维护和扩展
 * ============================================================================
 */

/* ────────────────────────────────────────────── */
/*  基础工具类                                      */
/* ────────────────────────────────────────────── */

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

class Disposable {
  constructor(fn) { this._fn = fn; }
  dispose() { if (this._fn) { try { this._fn(); } catch { /* ignore */ } this._fn = null; } }
  static from(...disposables) {
    return new Disposable(() => {
      for (const d of disposables) {
        try { d.dispose(); } catch { /* ignore */ }
      }
    });
  }
}

/* ────────────────────────────────────────────── */
/*  RPC 通信层                                     */
/* ────────────────────────────────────────────── */

/**
 * 发送通知 (fire-and-forget)
 */
function send(method, params) {
  if (typeof process !== 'undefined' && process.send) {
    process.send({ jsonrpc: '2.0', method, params });
  }
}

/**
 * 发送请求并等待响应 (Promise-based RPC)
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

/* ────────────────────────────────────────────── */
/*  VSCode 兼容 API                                */
/* ────────────────────────────────────────────── */

const vscode = {
  // ─── 窗口 API ───

  window: {
    showInformationMessage: (message, ...items) =>
      send('window.showInformationMessage', { message, items }),
    showErrorMessage: (message, ...items) =>
      send('window.showErrorMessage', { message, items }),
    showWarningMessage: (message, ...items) =>
      send('window.showWarningMessage', { message, items }),

    /**
     * 创建 WebView 面板
     * @param {string} viewType
     * @param {string} title
     * @param {object} [showOptions]
     * @param {object} [options]
     */
    createWebviewPanel: (viewType, title, showOptions, options) => {
      const panelId = `webview-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      // 解析当前激活的扩展 id
      const currentExtId = global._currentExtensionId;
      const extPath = currentExtId
        ? (global._extensionPaths && global._extensionPaths[currentExtId])
        : null;

      send('webview.create', {
        id: panelId,
        viewType,
        title,
        showOptions,
        options: {
          ...options,
          extensionId: options?.extensionId || currentExtId,
          extensionPath: options?.extensionPath || extPath,
        },
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
            _registerWebviewListener(panelId, callback);
            return { dispose: () => {} };
          },
          asWebviewUri: (localResource) =>
            `ideacode-webview-resource://${localResource.fsPath}`,
        },
        onDidDispose: (callback) => ({ dispose: () => {} }),
        onDidChangeViewState: (callback) => ({ dispose: () => {} }),
        reveal: (viewColumn) => send('webview.reveal', { id: panelId, viewColumn }),
        dispose: () => send('webview.dispose', { id: panelId }),
      };
    },

    /**
     * 创建终端
     */
    createTerminal: (options) => {
      const tabId = `term-ext-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      send('terminal.create', { ...(options || {}), tabId });
      return {
        name: options?.name || 'Terminal',
        processId: Promise.resolve(0),
        sendText(text, addNewLine = true) {
          send('terminal.sendInput', { tabId, text: addNewLine ? text + '\n' : text });
        },
        show(preserveFocus) { send('terminal.show', { tabId }); },
        hide() { send('terminal.hide', {}); },
        dispose() { send('terminal.dispose', { tabId }); },
        get onDidWrite() {
          /** @type {EventEmitter} */
          const em = new EventEmitter();
          return (listener) => em.event(listener);
        },
        get onDidClose() {
          const em = new EventEmitter();
          return (listener) => em.event(listener);
        },
      };
    },

    showInputBox: (options) => request('window.showInputBox', options),
    showQuickPick: (items, options) => request('window.showQuickPick', { items, options }),
    showOpenDialog: (options) => request('window.showOpenDialog', options),
    showSaveDialog: (options) => request('window.showSaveDialog', options),

    registerTreeDataProvider: (viewId, treeDataProvider) => {
      send('tree.register', { viewId, treeDataProvider });
      return { dispose: () => send('tree.unregister', { viewId }) };
    },

    registerWebviewViewProvider: (viewId, provider) => {
      send('webviewView.register', { viewId });
      return { dispose: () => send('webviewView.unregister', { viewId }) };
    },
  },

  // ─── 工作区 API ───

  workspace: {
    getConfiguration: (section) => ({
      get: (key, defaultValue) => defaultValue,
      update: () => Promise.resolve(),
      has: () => false,
      inspect: () => undefined,
    }),

    openTextDocument: (uri) => request('workspace.openTextDocument', { uri }),
    saveAll: () => request('workspace.saveAll', {}),
    getWorkspaceFolders: () => request('workspace.getWorkspaceFolders', {}),

    /** 获取当前工作区根路径 */
    getRootPath: () => request('workspace.getRootPath'),
    /** VS Code 兼容别名 */
    getWorkspaceFolder: () => request('workspace.getWorkspaceFolders'),
    registerFileSystemProvider: (scheme, provider) => {
      send('workspace.registerFileSystemProvider', { scheme, extensionId: global._currentExtensionId });
      return { dispose: () => send('workspace.unregisterFileSystemProvider', { scheme }) };
    },

    get onDidChangeConfiguration() {
      const em = new EventEmitter();
      return em.event;
    },
    get onDidChangeWorkspaceFolders() {
      const em = new EventEmitter();
      return em.event;
    },
    get onDidOpenTextDocument() {
      const em = new EventEmitter();
      return em.event;
    },
    get onDidCloseTextDocument() {
      const em = new EventEmitter();
      return em.event;
    },
    get onDidSaveTextDocument() {
      const em = new EventEmitter();
      return em.event;
    },
  },

  // ─── 命令 API ───

  commands: {
    registerCommand: (command, handler) => {
      // 扩展本地命令处理器（通过全局注册表）
      const cmdKey = `__cmd_${global._currentExtensionId || 'global'}_${command}`;
      global[cmdKey] = handler;
      return {
        dispose: () => { delete global[cmdKey]; },
      };
    },

    executeCommand: (command, ...args) => {
      // 先查本地处理器
      const cmdKey = `__cmd_${global._currentExtensionId || 'global'}_${command}`;
      if (typeof global[cmdKey] === 'function') {
        return Promise.resolve(global[cmdKey](...args));
      }
      // 转发到主进程
      return request('commands.execute', { command, args });
    },

    getCommands: () => request('commands.getCommands', {}),
  },

  // ─── 语言 API ───

  languages: {
    registerDocumentSemanticTokensProvider: () => ({ dispose: () => {} }),
    registerCompletionItemProvider: () => ({ dispose: () => {} }),
    registerHoverProvider: () => ({ dispose: () => {} }),
    registerDefinitionProvider: () => ({ dispose: () => {} }),
    registerCodeActionsProvider: () => ({ dispose: () => {} }),
  },

  // ─── 环境 API ───

  env: {
    appName: 'IDEACODE',
    appRoot: typeof process !== 'undefined' ? process.cwd() : '',
    language: 'zh-CN',
    machineId: 'unknown',
    sessionId: 'unknown',
    shell: (typeof process !== 'undefined' && process.env.SHELL) || '',

    clipboard: {
      writeText: (text) => request('env.clipboard.writeText', { text }),
      readText: () => request('env.clipboard.readText', {}),
    },

    openExternal: (uri) => request('env.openExternal', { uri: uri.toString() }),
  },

  // ─── URI 工具 ───

  Uri: {
    file: (fspath) => ({ fsPath: fspath, scheme: 'file' }),
    parse: (uri) => {
      const match = uri.match(/^([^:]+):\/\/(.+)$/);
      return match ? { scheme: match[1], fsPath: match[2] } : { scheme: 'file', fsPath: uri };
    },
  },

  // ─── 工具类 ───

  EventEmitter,
  Disposable,

  // ─── 版本 ───

  version: '1.0.0',
};

/* ────────────────────────────────────────────── */
/*  WebView 消息路由                                */
/* ────────────────────────────────────────────── */

/**
 * 全局 WebView 消息监听器注册表
 * 与 Extension Host 的 webview.message 路由配合使用
 */
if (!global._webviewListenerRegistry) {
  global._webviewListenerRegistry = new Map();
}

function _registerWebviewListener(panelId, callback) {
  if (!global._webviewListenerRegistry.has(panelId)) {
    global._webviewListenerRegistry.set(panelId, []);
  }
  global._webviewListenerRegistry.get(panelId).push(callback);
}

// 监听来自主进程转发的 WebView 消息
if (typeof process !== 'undefined') {
  process.on('message', (msg) => {
    if (msg && msg.method === 'webview.message' && msg.params) {
      const { id, message } = msg.params;
      const handlers = global._webviewListenerRegistry?.get(id);
      if (handlers) {
        for (const h of handlers) {
          try { h(message); } catch (e) {
            console.error('[vscode-api] webview handler error:', e);
          }
        }
      }
    }
  });
}

/* ────────────────────────────────────────────── */
/*  导出                                           */
/* ────────────────────────────────────────────── */

module.exports = vscode;
module.exports.request = request;
module.exports.send = send;
module.exports.EventEmitter = EventEmitter;
module.exports.Disposable = Disposable;
