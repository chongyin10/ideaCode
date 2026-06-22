/**
 * VSCode 兼容 API 存根
 * 在 Extension Host 进程中运行，通过 JSON-RPC 与主进程通信
 */

class EventEmitter {
  constructor() {
    this._listeners = new Set();
  }

  fire(data) {
    for (const listener of this._listeners) {
      try {
        listener(data);
      } catch {
        // ignore listener errors
      }
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
        onDidDispose: (callback) => {
          if (!global._webviewDisposeHandlers) global._webviewDisposeHandlers = new Map();
          if (!global._webviewDisposeHandlers.has(panelId)) {
            global._webviewDisposeHandlers.set(panelId, []);
          }
          global._webviewDisposeHandlers.get(panelId).push(callback);
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
    createTerminal: (options) => {
      return new Promise((resolve, reject) => {
        if (typeof process === 'undefined' || !process.send) {
          reject(new Error('Extension Host not connected'));
          return;
        }

        const requestId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const rpcId = Date.now() + Math.random();
        let settled = false;

        // 等待渲染进程创建完成后回传的 terminal.created 通知
        const createdHandler = (msg) => {
          if (msg.method === 'terminal.created' && msg.params?.requestId === requestId) {
            if (settled) return;
            settled = true;
            process.removeListener('message', createdHandler);
            clearTimeout(timer);

            const { tabId, processId, success, error } = msg.params || {};
            if (!success) {
              reject(new Error(error || '创建终端失败'));
              return;
            }

            const outputEmitter = new EventEmitter();
            const exitEmitter = new EventEmitter();

            const outputRouter = (msg2) => {
              if (msg2.method === 'terminal.data' && msg2.params?.tabId === tabId) {
                outputEmitter.fire(msg2.params.data);
              } else if (msg2.method === 'terminal.exit' && msg2.params?.tabId === tabId) {
                exitEmitter.fire(msg2.params.exitCode);
              }
            };
            process.on('message', outputRouter);

            const terminal = {
              tabId,
              processId,
              sendText: (text, addNewLine = true) => {
                const data = addNewLine && !text.endsWith('\r') && !text.endsWith('\n') ? `${text}\r` : text;
                process.send({ jsonrpc: '2.0', method: 'terminal.sendInput', params: { tabId, text: data } });
              },
              show: () => {
                process.send({ jsonrpc: '2.0', method: 'terminal.show', params: { tabId } });
              },
              hide: () => {
                process.send({ jsonrpc: '2.0', method: 'terminal.hide', params: { tabId } });
              },
              dispose: () => {
                process.removeListener('message', outputRouter);
                process.send({ jsonrpc: '2.0', method: 'terminal.dispose', params: { tabId } });
              },
              openInModal: (title) => {
                process.send({ jsonrpc: '2.0', method: 'terminal.openInModal', params: { tabId, title } });
              },
              onDidWriteData: outputEmitter.event,
              onDidClose: exitEmitter.event,
            };
            resolve(terminal);
          }
        };
        process.on('message', createdHandler);

        process.send({ jsonrpc: '2.0', id: rpcId, method: 'terminal.create', params: { ...options, requestId } });

        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            process.removeListener('message', createdHandler);
            reject(new Error('Terminal creation timeout'));
          }
        }, 30000);
      });
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (key, defaultValue) => defaultValue,
      update: () => Promise.resolve(),
    }),
    getWorkspaceFolders: () => Promise.resolve([]),
    registerFileSystemProvider: (scheme, provider) => {
      if (!global._fileSystemProviders) global._fileSystemProviders = new Map();
      global._fileSystemProviders.set(scheme, provider);
      if (typeof process !== 'undefined' && process.send) {
        process.send({
          jsonrpc: '2.0',
          method: 'workspace.registerFileSystemProvider',
          params: { scheme, extensionId: global._currentExtensionId },
        });
      }
      return { dispose: () => global._fileSystemProviders?.delete(scheme) };
    },
    addWorkspaceFolder: ({ id, name, uri }) => {
      if (typeof process !== 'undefined' && process.send) {
        process.send({
          jsonrpc: '2.0',
          method: 'workspace.addWorkspaceFolder',
          params: { id, name, uri },
        });
      }
      return Promise.resolve();
    },
    removeWorkspaceFolder: ({ id }) => {
      if (typeof process !== 'undefined' && process.send) {
        process.send({
          jsonrpc: '2.0',
          method: 'workspace.removeWorkspaceFolder',
          params: { id },
        });
      }
      return Promise.resolve();
    },
    openRemoteFileTree: ({ title, tree }) => {
      if (typeof process !== 'undefined' && process.send) {
        process.send({
          jsonrpc: '2.0',
          method: 'workspace.openRemoteFileTree',
          params: { title, tree },
        });
      }
      return Promise.resolve();
    },
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
    if (msg.method === 'webview.dispose' && msg.params) {
      const { id } = msg.params;
      const handlers = global._webviewDisposeHandlers?.get(id);
      if (handlers) {
        for (const handler of handlers) {
          try { handler(); } catch { /* ignore */ }
        }
        global._webviewDisposeHandlers.delete(id);
      }
    }
  });
}

module.exports = vscode;
