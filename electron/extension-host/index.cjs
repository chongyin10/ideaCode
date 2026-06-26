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
/*  扩展管理器                                     */
/* ────────────────────────────────────────────── */

class ExtensionManager {
  constructor() {
    this.extensions = new Map(); // id -> { manifest, path, active, context }
    // 使用 __dirname 定位扩展目录（从 extension-host 向上两级到项目根目录）
    this.extensionsDir = path.resolve(__dirname, '..', '..', 'extensions');
    console.log('[ExtensionHost] 扩展目录:', this.extensionsDir);
  }

  async scanExtensions() {
    const results = [];
    console.log('[ExtensionHost] 开始扫描扩展目录:', this.extensionsDir);
    // 清理已不存在的扩展（例如被卸载）
    for (const [id, ext] of this.extensions) {
      try {
        await fs.access(ext.path);
      } catch {
        console.log('[ExtensionHost] 扩展目录已不存在，移除:', id);
        this.extensions.delete(id);
      }
    }
    try {
      const entries = await fs.readdir(this.extensionsDir, { withFileTypes: true });
      console.log('[ExtensionHost] 目录条目数:', entries.length);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const extPath = path.join(this.extensionsDir, entry.name);
        const manifestPath = path.join(extPath, 'package.json');
        console.log('[ExtensionHost] 检查扩展:', entry.name, manifestPath);
        try {
          const raw = await fs.readFile(manifestPath, 'utf-8');
          const manifest = JSON.parse(raw);
          console.log('[ExtensionHost] 找到扩展:', manifest.name, 'main:', manifest.main);
          if (manifest.name && manifest.main) {
            this.extensions.set(manifest.name, {
              manifest,
              path: extPath,
              active: false,
              context: null,
            });
            results.push({ id: manifest.name, manifest, path: extPath });
          }
        } catch (err) {
          console.log('[ExtensionHost] 扩展目录无效:', entry.name, err.message);
        }
      }
    } catch (err) {
      console.error('[ExtensionHost] 扩展目录不存在或无法读取:', this.extensionsDir, err.message);
    }
    console.log('[ExtensionHost] 扫描完成，找到', results.length, '个扩展');
    return results;
  }

  async activateExtension(extId) {
    const ext = this.extensions.get(extId);
    if (!ext || ext.active) return false;

    const prevExtId = global._currentExtensionId;
    global._currentExtensionId = extId;
    try {
      const mainPath = path.join(ext.path, ext.manifest.main);
      const module = require(mainPath);
      
      if (module.activate) {
        // 创建 vscode API 上下文
        const context = this.createExtensionContext(ext);
        await module.activate(context);
        ext.context = context;
        ext.active = true;
        return true;
      }
    } catch (err) {
      console.error(`[ExtensionHost] 激活扩展失败 ${extId}:`, err.message);
      return false;
    } finally {
      global._currentExtensionId = prevExtId;
    }
    return false;
  }

  async deactivateExtension(extId) {
    const ext = this.extensions.get(extId);
    if (!ext || !ext.active) return false;

    try {
      const mainPath = path.join(ext.path, ext.manifest.main);
      const module = require(mainPath);
      
      if (module.deactivate) {
        await module.deactivate();
      }
      
      // 清理 subscriptions
      if (ext.context && ext.context.subscriptions) {
        for (const dispose of ext.context.subscriptions) {
          try { dispose(); } catch { /* ignore */ }
        }
      }
      
      ext.active = false;
      ext.context = null;
      return true;
    } catch (err) {
      console.error(`[ExtensionHost] 停用扩展失败 ${extId}:`, err.message);
      return false;
    }
  }

  createExtensionContext(ext) {
    const subscriptions = [];
    
    return {
      subscriptions,
      extensionPath: ext.path,
      extensionUri: { fsPath: ext.path, scheme: 'file' },
      
      // 全局状态存储（通过主进程代理）
      globalState: {
        get: async (key, defaultValue) => {
          const result = await rpc.request('storage.get', { 
            prefix: ext.manifest.name, 
            key, 
            defaultValue 
          });
          return result.value;
        },
        update: async (key, value) => {
          await rpc.request('storage.set', { 
            prefix: ext.manifest.name, 
            key, 
            value 
          });
        },
      },
      
      // 工作区状态存储
      workspaceState: {
        get: async (key, defaultValue) => {
          const result = await rpc.request('storage.get', { 
            prefix: `workspace:${ext.manifest.name}`, 
            key, 
            defaultValue 
          });
          return result.value;
        },
        update: async (key, value) => {
          await rpc.request('storage.set', { 
            prefix: `workspace:${ext.manifest.name}`, 
            key, 
            value 
          });
        },
      },
      
      // 密钥存储
      secrets: {
        get: async (key) => {
          const result = await rpc.request('secrets.get', { 
            extensionId: ext.manifest.name, 
            key 
          });
          return result.value;
        },
        store: async (key, value) => {
          await rpc.request('secrets.store', { 
            extensionId: ext.manifest.name, 
            key, 
            value 
          });
        },
        delete: async (key) => {
          await rpc.request('secrets.delete', { 
            extensionId: ext.manifest.name, 
            key 
          });
        },
      },
    };
  }

  getAllExtensions() {
    return Array.from(this.extensions.values()).map((ext) => ({
      id: ext.manifest.name,
      manifest: ext.manifest,
      path: ext.path,
      active: ext.active,
    }));
  }

  getExtension(extId) {
    const ext = this.extensions.get(extId);
    if (!ext) return null;
    return {
      id: ext.manifest.name,
      manifest: ext.manifest,
      path: ext.path,
      active: ext.active,
    };
  }

  async invokeExtension(extId, method, args = []) {
    const ext = this.extensions.get(extId);
    if (!ext) throw new Error(`扩展未找到: ${extId}`);
    const mainPath = path.join(ext.path, ext.manifest.main);
    const module = require(mainPath);
    if (typeof module[method] !== 'function') {
      throw new Error(`扩展方法未找到: ${method}`);
    }
    return await module[method].apply(module, args);
  }
}

const manager = new ExtensionManager();

/* ────────────────────────────────────────────── */
/*  VSCode 兼容 API                               */
/* ────────────────────────────────────────────── */

// 创建全局 vscode 对象
const vscode = {
  // 窗口 API
  window: {
    showInformationMessage: (message, ...items) => {
      return rpc.request('window.showInformationMessage', { message, items });
    },
    showErrorMessage: (message, ...items) => {
      return rpc.request('window.showErrorMessage', { message, items });
    },
    showWarningMessage: (message, ...items) => {
      return rpc.request('window.showWarningMessage', { message, items });
    },
    
    // WebView - 插件渲染自定义 UI 的主要方式
    createWebviewPanel: (viewType, title, showOptions, options) => {
      const panelId = `webview-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      // 解析当前激活的扩展 id（解决 viewType 分隔符与扩展 id 不一致的问题）
      // 例如 viewType='git.changesView'、'ssh-connections'、'lifeAiCode.xxx' 等
      // 都对应不同的扩展 id（'ideacode-git'、'ideacode-ssh'、'lifeai-code'）
      // 使用 global._currentExtensionId（activate 时设置）作为权威来源
      const currentExtId = global._currentExtensionId;
      const currentExt = currentExtId ? manager.extensions.get(currentExtId) : null;
      const extPath = currentExt?.path
        || manager.extensions.get(viewType.split('.')[0])?.path
        || manager.extensions.get(viewType.split('-')[0])?.path;

      // 通知渲染进程创建 WebView 面板
      rpc.notify('webview.create', {
        id: panelId,
        viewType,
        title,
        showOptions,
        options,
        extensionPath: extPath,
      });
      
      return {
        id: panelId,
        viewType,
        title,
        webview: {
          html: '',
          options: {},
          postMessage: (message) => {
            rpc.notify('webview.postMessage', { id: panelId, message });
          },
          onDidReceiveMessage: (callback) => {
            // 通过事件监听
            const handler = (msg) => {
              if (msg.method === 'webview.message' && msg.params?.id === panelId) {
                callback(msg.params.message);
              }
            };
            // 注册到 rpc 的通用消息处理器
            return { dispose: () => {} };
          },
          asWebviewUri: (localResource) => {
            // 将本地资源路径转换为 webview URI
            return `ideacode-webview-resource://${localResource.fsPath}`;
          },
          cspSource: "ideacode-webview-resource:",
        },
        onDidDispose: (callback) => {
          return { dispose: () => {} };
        },
        onDidChangeViewState: (callback) => {
          return { dispose: () => {} };
        },
        reveal: (viewColumn) => {
          rpc.notify('webview.reveal', { id: panelId, viewColumn });
        },
        dispose: () => {
          rpc.notify('webview.dispose', { id: panelId });
        },
      };
    },
    
    // 输入框
    showInputBox: (options) => {
      return rpc.request('window.showInputBox', options);
    },
    
    // 快速选择
    showQuickPick: (items, options) => {
      return rpc.request('window.showQuickPick', { items, options });
    },
    
    // 打开文件选择器
    showOpenDialog: (options) => {
      return rpc.request('window.showOpenDialog', options);
    },
    
    // 保存文件选择器
    showSaveDialog: (options) => {
      return rpc.request('window.showSaveDialog', options);
    },
    
    // 注册树数据提供者（用于 Activity Bar 的侧边栏视图）
    registerTreeDataProvider: (viewId, treeDataProvider) => {
      rpc.notify('tree.register', { viewId, treeDataProvider });
      return {
        dispose: () => {
          rpc.notify('tree.unregister', { viewId });
        },
      };
    },
    
    // 注册 WebView 提供者（用于 Activity Bar 的自定义视图）
    registerWebviewViewProvider: (viewId, provider) => {
      rpc.notify('webviewView.register', { viewId });
      return {
        dispose: () => {
          rpc.notify('webviewView.unregister', { viewId });
        },
      };
    },
  },
  
  // 工作区 API
  workspace: {
    getConfiguration: (section) => {
      return {
        get: (key, defaultValue) => defaultValue,
        update: () => {},
        has: () => false,
        inspect: () => undefined,
      };
    },
    
    openTextDocument: (uri) => {
      return rpc.request('workspace.openTextDocument', { uri });
    },
    
    saveAll: () => {
      return rpc.request('workspace.saveAll', {});
    },
    
    getWorkspaceFolders: () => {
      return rpc.request('workspace.getWorkspaceFolders', {});
    },
    
    onDidChangeConfiguration: (callback) => {
      return { dispose: () => {} };
    },
    
    onDidOpenTextDocument: (callback) => {
      return { dispose: () => {} };
    },
    
    onDidCloseTextDocument: (callback) => {
      return { dispose: () => {} };
    },
    
    onDidSaveTextDocument: (callback) => {
      return { dispose: () => {} };
    },
  },
  
  // 命令 API
  commands: {
    registerCommand: (command, handler) => {
      rpc.on(`command.${command}`, async (params) => {
        return handler(...(params.args || []));
      });
      return {
        dispose: () => {
          rpc.handlers.delete(`command.${command}`);
        },
      };
    },
    
    executeCommand: (command, ...args) => {
      return rpc.request('commands.execute', { command, args });
    },
    
    getCommands: () => {
      return rpc.request('commands.getCommands', {});
    },
  },
  
  // 语言 API
  languages: {
    registerDocumentSemanticTokensProvider: () => {
      return { dispose: () => {} };
    },
    
    registerCompletionItemProvider: () => {
      return { dispose: () => {} };
    },
    
    registerHoverProvider: () => {
      return { dispose: () => {} };
    },
    
    registerDefinitionProvider: () => {
      return { dispose: () => {} };
    },
    
    registerCodeActionsProvider: () => {
      return { dispose: () => {} };
    },
  },
  
  // 环境 API
  env: {
    appName: 'IDEACODE',
    appRoot: process.cwd(),
    language: 'zh-CN',
    machineId: 'unknown',
    sessionId: 'unknown',
    shell: process.env.SHELL || '',
    clipboard: {
      writeText: (text) => {
        return rpc.request('env.clipboard.writeText', { text });
      },
      readText: () => {
        return rpc.request('env.clipboard.readText', {});
      },
    },
    openExternal: (uri) => {
      return rpc.request('env.openExternal', { uri: uri.toString() });
    },
  },
  
  // URI 工具
  Uri: {
    file: (path) => ({ fsPath: path, scheme: 'file' }),
    parse: (uri) => {
      const match = uri.match(/^([^:]+):\/\/(.+)$/);
      if (match) {
        return { scheme: match[1], fsPath: match[2] };
      }
      return { scheme: 'file', fsPath: uri };
    },
  },
  
  // 事件 API
  EventEmitter: class EventEmitter {
    constructor() {
      this.listeners = [];
    }
    
    event(callback) {
      this.listeners.push(callback);
      return {
        dispose: () => {
          const idx = this.listeners.indexOf(callback);
          if (idx >= 0) this.listeners.splice(idx, 1);
        },
      };
    }
    
    fire(data) {
      for (const listener of this.listeners) {
        listener(data);
      }
    }
    
    dispose() {
      this.listeners = [];
    }
  },
  
  // Disposable 工具
  Disposable: class Disposable {
    constructor(callOnDispose) {
      this.callOnDispose = callOnDispose;
    }
    
    dispose() {
      if (this.callOnDispose) {
        this.callOnDispose();
      }
    }
    
    static from(...disposables) {
      return new Disposable(() => {
        for (const d of disposables) {
          d.dispose();
        }
      });
    }
  },
  
  // 版本
  version: '1.0.0',
};

// 将 vscode 对象挂载到全局
global.vscode = vscode;

/* ────────────────────────────────────────────── */
/*  JSON-RPC 方法注册                              */
/* ────────────────────────────────────────────── */

// 扫描扩展
rpc.on('ext.scan', async () => {
  const manifests = await manager.scanExtensions();
  return { manifests };
});

// 激活扩展
rpc.on('ext.activate', async (params) => {
  const { extId } = params;
  const result = await manager.activateExtension(extId);
  return { success: result };
});

// 停用扩展
rpc.on('ext.deactivate', async (params) => {
  const { extId } = params;
  const result = await manager.deactivateExtension(extId);
  return { success: result };
});

// 获取所有扩展
rpc.on('ext.getAll', async () => {
  return { extensions: manager.getAllExtensions() };
});

// 获取单个扩展
rpc.on('ext.get', async (params) => {
  const { extId } = params;
  return { extension: manager.getExtension(extId) };
});

// 调用扩展导出的方法
rpc.on('ext.invoke', async (params) => {
  const { extId, method, args } = params;
  return await manager.invokeExtension(extId, method, args);
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

// 文件系统搜索
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

// 文件内容分析
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

// 终端事件占位处理器：实际路由在 api.js 的 Terminal 代理中完成，
// 此处注册仅避免主进程返回 "Method not found"。
rpc.on('terminal.created', async () => ({ received: true }));
rpc.on('terminal.data', async () => ({ received: true }));
rpc.on('terminal.exit', async () => ({ received: true }));

/* ─── LifeAiCode RPC 路由 ─── */
// 将渲染进程发来的 lifeAiCode 请求转发到对应的扩展命令处理器
function dispatchLifeAiCode(method, params) {
  // 映射到 lifeAiCode 内部命令
  const cmdMap = {
    'lifeAiCode.internal.processMessage':   'lifeAiCode.internal.processMessage',
    'lifeAiCode.internal.explainCode':      'lifeAiCode.internal.explainCode',
    'lifeAiCode.internal.suggestRefactor':  'lifeAiCode.internal.suggestRefactor',
    'lifeAiCode.internal.accept':           'lifeAiCode.internal.accept',
    'lifeAiCode.internal.reject':           'lifeAiCode.internal.reject',
    'lifeAiCode.internal.previewDiff':      'lifeAiCode.internal.previewDiff',
    'lifeAiCode.internal.setEditMode':      'lifeAiCode.internal.setEditMode',
  };
  
  const cmd = cmdMap[method];
  if (cmd && global._lifeAiCodeCommandHandlers && global._lifeAiCodeCommandHandlers.has(cmd)) {
    const handler = global._lifeAiCodeCommandHandlers.get(cmd);
    return Promise.resolve(handler(params));
  }
  
  // 转发为 commands.execute
  if (global._lifeAiCodeCommandHandlers && global._lifeAiCodeCommandHandlers.has(method)) {
    const handler = global._lifeAiCodeCommandHandlers.get(method);
    return Promise.resolve(handler(params));
  }
  
  return Promise.resolve({ notFound: true });
}

const lifeAiCodeMethods = [
  'lifeAiCode.internal.processMessage',
  'lifeAiCode.internal.explainCode',
  'lifeAiCode.internal.suggestRefactor',
  'lifeAiCode.internal.accept',
  'lifeAiCode.internal.reject',
  'lifeAiCode.internal.previewDiff',
  'lifeAiCode.internal.configure',
  'lifeAiCode.internal.testConnection',
  'lifeAiCode.internal.setEditMode',
];

// 处理 commands.execute（如 lifeAiCode.ask）
rpc.on('commands.execute', async (params) => {
  const { command, args = [] } = params || {};
  if (command && global._lifeAiCodeCommandHandlers && global._lifeAiCodeCommandHandlers.has(command)) {
    const handler = global._lifeAiCodeCommandHandlers.get(command);
    try {
      const result = await handler(...args);
      return { executed: true, result };
    } catch (err) {
      return { executed: false, error: err.message };
    }
  }
  return { executed: false, error: `命令未找到: ${command}` };
});

for (const method of lifeAiCodeMethods) {
  rpc.on(method, async (params) => {
    return dispatchLifeAiCode(method, params);
  });
}

/* ─── webview.message 路由 ─── */
// 从渲染进程发来的 webview 消息，转发到对应扩展注册的消息处理器
rpc.on('webview.message', async (params) => {
  const { id, message } = params || {};
  if (!id || !message) return { forwarded: false };

  let forwarded = false;

  // LifeAiCode 扩展注册的处理器
  const lifeHandlers = global._lifeAiCodeWebviewHandlers?.get(id);
  if (lifeHandlers) {
    for (const handler of lifeHandlers) {
      try { handler(message); } catch (e) { console.error('[ExtensionHost] lifeAiCode webview handler error:', e); }
    }
    forwarded = true;
  }

  // Git 扩展注册的处理器
  const gitHandlers = global._gitWebviewHandlers?.get(id);
  if (gitHandlers) {
    for (const handler of gitHandlers) {
      try { handler(message); } catch (e) { console.error('[ExtensionHost] git webview handler error:', e); }
    }
    forwarded = true;
  }

  // SSH 扩展注册的处理器（兼容旧版本使用 _webviewMessageHandlers 的情况）
  const sshHandlers = global._webviewMessageHandlers?.get(id);
  if (sshHandlers) {
    for (const handler of sshHandlers) {
      try { handler(message); } catch (e) { console.error('[ExtensionHost] ssh webview handler error:', e); }
    }
    forwarded = true;
  }

  return { forwarded };
});

console.log('[ExtensionHost] 扩展宿主已启动，等待连接...');

// 发送 host.ready 通知
rpc.notify('host.ready', { timestamp: Date.now() });
