/**
 * LifeAiCode VSCode 兼容 API
 * 在 Extension Host 进程中运行，通过 JSON-RPC 与主进程通信
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

const vscode = {
  window: {
    showInformationMessage: (message, ...items) => {
      if (typeof process !== 'undefined' && process.send) {
        process.send({ jsonrpc: '2.0', method: 'ui.showMessage', params: { message, type: 'info' } });
      }
      return Promise.resolve(undefined);
    },
    showErrorMessage: (message, ...items) => {
      if (typeof process !== 'undefined' && process.send) {
        process.send({ jsonrpc: '2.0', method: 'ui.showMessage', params: { message, type: 'error' } });
      }
      return Promise.resolve(undefined);
    },
    showWarningMessage: (message, ...items) => {
      if (typeof process !== 'undefined' && process.send) {
        process.send({ jsonrpc: '2.0', method: 'ui.showMessage', params: { message, type: 'warning' } });
      }
      return Promise.resolve(undefined);
    },

    createWebviewPanel: (viewType, title, showOptions, options) => {
      const panelId = `lifeAiCode-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      if (typeof process !== 'undefined' && process.send) {
        process.send({
          jsonrpc: '2.0',
          method: 'webview.create',
          params: { id: panelId, viewType, title, showOptions, options },
        });
      }
      return {
        id: panelId,
        viewType,
        title,
        webview: {
          _html: '',
          get html() { return this._html; },
          set html(value) {
            this._html = value;
            if (typeof process !== 'undefined' && process.send) {
              process.send({ jsonrpc: '2.0', method: 'webview.setHtml', params: { id: panelId, html: value } });
            }
          },
          options: options || {},
          cspSource: 'ideacode-webview-resource:',
          postMessage: (message) => {
            if (typeof process !== 'undefined' && process.send) {
              process.send({ jsonrpc: '2.0', method: 'webview.postMessage', params: { id: panelId, message } });
            }
          },
          onDidReceiveMessage: (callback) => {
            if (!global._lifeAiCodeWebviewHandlers) global._lifeAiCodeWebviewHandlers = new Map();
            if (!global._lifeAiCodeWebviewHandlers.has(panelId)) {
              global._lifeAiCodeWebviewHandlers.set(panelId, []);
            }
            global._lifeAiCodeWebviewHandlers.get(panelId).push(callback);
            return { dispose: () => {} };
          },
          asWebviewUri: (localResource) => `ideacode-webview-resource://${localResource.fsPath}`,
        },
        onDidDispose: (callback) => {
          if (!global._lifeAiCodeDisposeHandlers) global._lifeAiCodeDisposeHandlers = new Map();
          if (!global._lifeAiCodeDisposeHandlers.has(panelId)) {
            global._lifeAiCodeDisposeHandlers.set(panelId, []);
          }
          global._lifeAiCodeDisposeHandlers.get(panelId).push(callback);
          return { dispose: () => {} };
        },
        onDidChangeViewState: (callback) => ({ dispose: () => {} }),
        reveal: () => {
          if (typeof process !== 'undefined' && process.send) {
            process.send({ jsonrpc: '2.0', method: 'webview.reveal', params: { id: panelId } });
          }
        },
        dispose: () => {
          if (typeof process !== 'undefined' && process.send) {
            process.send({ jsonrpc: '2.0', method: 'webview.dispose', params: { id: panelId } });
          }
        },
      };
    },
  },

  workspace: {
    getConfiguration: () => ({
      get: (key, defaultValue) => defaultValue,
      update: () => Promise.resolve(),
    }),
    getWorkspaceFolders: () => Promise.resolve([]),
  },

  commands: {
    registerCommand: (command, handler) => {
      if (!global._lifeAiCodeCommandHandlers) global._lifeAiCodeCommandHandlers = new Map();
      global._lifeAiCodeCommandHandlers.set(command, handler);
      return { dispose: () => global._lifeAiCodeCommandHandlers.delete(command) };
    },
    executeCommand: (command, ...args) => {
      if (global._lifeAiCodeCommandHandlers && global._lifeAiCodeCommandHandlers.has(command)) {
        return Promise.resolve(global._lifeAiCodeCommandHandlers.get(command)(...args));
      }
      return new Promise((resolve, reject) => {
        if (typeof process !== 'undefined' && process.send) {
          const id = Date.now() + Math.random();
          process.send({ jsonrpc: '2.0', id, method: 'commands.execute', params: { command, args } });
          const handler = (msg) => {
            if (msg.id === id) {
              process.removeListener('message', handler);
              if (msg.error) reject(new Error(msg.error.message));
              else resolve(msg.result);
            }
          };
          process.on('message', handler);
          setTimeout(() => {
            process.removeListener('message', handler);
            reject(new Error('Command execution timeout'));
          }, 30000);
        } else {
          reject(new Error('Extension Host not connected'));
        }
      });
    },
  },

  Uri: {
    file: (fp) => ({ fsPath: fp, scheme: 'file' }),
    parse: (uri) => {
      const match = uri.match(/^([^:]+):\/\/(.+)$/);
      return match ? { scheme: match[1], fsPath: match[2] } : { scheme: 'file', fsPath: uri };
    },
  },

  env: {
    appName: 'IDEACODE',
    appRoot: typeof process !== 'undefined' ? process.cwd() : '',
  },

  version: '1.0.0',
};

// 处理从主进程转发来的 WebView 消息
if (typeof process !== 'undefined') {
  const origHandler = process.listeners('message').slice(-1)[0] || null;
  process.on('message', (msg) => {
    if (msg.method === 'webview.message' && msg.params) {
      const { id, message } = msg.params;
      const handlers = global._lifeAiCodeWebviewHandlers?.get(id);
      if (handlers) {
        for (const handler of handlers) {
          handler(message);
        }
      }
    }
    if (msg.method === 'webview.dispose' && msg.params) {
      const { id } = msg.params;
      const handlers = global._lifeAiCodeDisposeHandlers?.get(id);
      if (handlers) {
        for (const handler of handlers) {
          try { handler(); } catch { /* ignore */ }
        }
        global._lifeAiCodeDisposeHandlers.delete(id);
      }
    }
  });
}

module.exports = vscode;
