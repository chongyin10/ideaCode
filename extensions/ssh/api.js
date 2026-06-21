/**
 * VSCode 兼容 API 存根
 * 在 Extension Host 进程中运行，通过 JSON-RPC 与主进程通信
 */

const vscode = {
  window: {
    showInformationMessage: (message, ...items) => {
      if (typeof process !== 'undefined' && process.send) {
        process.send({ jsonrpc: '2.0', method: 'window.showInformationMessage', params: { message, items } });
      }
      return Promise.resolve(undefined);
    },
    showErrorMessage: (message, ...items) => {
      if (typeof process !== 'undefined' && process.send) {
        process.send({ jsonrpc: '2.0', method: 'window.showErrorMessage', params: { message, items } });
      }
      return Promise.resolve(undefined);
    },
    showWarningMessage: (message, ...items) => {
      if (typeof process !== 'undefined' && process.send) {
        process.send({ jsonrpc: '2.0', method: 'window.showWarningMessage', params: { message, items } });
      }
      return Promise.resolve(undefined);
    },
    createWebviewPanel: (viewType, title, showOptions, options) => {
      const panelId = `webview-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
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
          get html() {
            return this._html;
          },
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
            if (!global._webviewMessageHandlers) global._webviewMessageHandlers = new Map();
            if (!global._webviewMessageHandlers.has(panelId)) {
              global._webviewMessageHandlers.set(panelId, []);
            }
            global._webviewMessageHandlers.get(panelId).push(callback);
            return { dispose: () => {} };
          },
          asWebviewUri: (localResource) => `ideacode-webview-resource://${localResource.fsPath}`,
        },
        onDidDispose: (callback) => ({ dispose: () => {} }),
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
    createTerminal: (options) => {
      return new Promise((resolve, reject) => {
        if (typeof process !== 'undefined' && process.send) {
          const id = Date.now() + Math.random();
          process.send({ jsonrpc: '2.0', id, method: 'terminal.create', params: options });
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
            reject(new Error('Terminal creation timeout'));
          }, 30000);
        } else {
          reject(new Error('Extension Host not connected'));
        }
      });
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
      if (!global._commandHandlers) global._commandHandlers = new Map();
      global._commandHandlers.set(command, handler);
      return { dispose: () => global._commandHandlers.delete(command) };
    },
    executeCommand: (command, ...args) => {
      if (global._commandHandlers && global._commandHandlers.has(command)) {
        return Promise.resolve(global._commandHandlers.get(command)(...args));
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
    file: (path) => ({ fsPath: path, scheme: 'file' }),
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
  process.on('message', (msg) => {
    if (msg.method === 'webview.message' && msg.params) {
      const { id, message } = msg.params;
      const handlers = global._webviewMessageHandlers?.get(id);
      if (handlers) {
        for (const handler of handlers) {
          handler(message);
        }
      }
    }
  });
}

module.exports = vscode;
