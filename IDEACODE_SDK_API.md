# IDEACODE SDK & Extension API 文档

> 本文档面向需要在 IDEACODE 中开发扩展或集成第三方插件的开发者。
> 覆盖：扩展宿主进程（Extension Host）API、渲染进程插件（Renderer Plugin）、统一 SDK（`@ideacode/sdk`）以及共享类型（`@ideacode/types`）。

---

## 1. 概述

IDEACODE 采用 **双轨扩展架构**：

1. **扩展宿主进程（Extension Host）**：运行在独立的 Node.js 子进程中，与主进程通过 JSON-RPC 通信。扩展使用 VS Code 风格的 `activate(context)` / `deactivate()` 生命周期，是当前 **推荐** 的第三方扩展开发方式。
2. **渲染进程插件（Renderer Plugin）**：直接运行在 Electron 渲染进程内，访问 Redux 状态与 React UI，适合深度定制 IDE 内部行为，但隔离性较差，主要用于内置功能。
3. **统一 SDK / 微内核（`@ideacode/sdk` + `@ideacode/kernel`）**：正在建设中的统一层，目标是用 `ServiceBus` 取代散落在各处的 RPC 处理逻辑。目前 IDE 内部部分模块已开始接入，第三方扩展暂时不需要直接使用。

```
┌─────────────────────────────────────────────────────────────┐
│                      渲染进程 (Renderer)                      │
│  ┌──────────────┐   ┌──────────────────┐   ┌──────────────┐  │
│  │   React UI   │   │  Renderer Plugin │   │ @ideacode/sdk│  │
│  └──────┬───────┘   └────────┬─────────┘   └──────┬───────┘  │
│         │                    │                    │          │
│  preload.cjs  ←── window.electronAPI ──→  主进程 IPC        │
└─────────┼────────────────────┼────────────────────┼──────────┘
          │                    │                    │
          ▼                    ▼                    ▼
┌─────────────────────────────────────────────────────────────┐
│                      主进程 (Main Process)                    │
│         ExtensionHostManager  ←──IPC──→  Extension Host       │
│                                          (Node.js child)      │
│                                              │                │
│                          extensions/*/extension.cjs           │
└─────────────────────────────────────────────────────────────┘
```

> **给第三方开发者的建议**：优先使用 **Extension Host + `vscode` 兼容 API** 开发扩展，这样不需要关心渲染进程内部实现，扩展之间也能通过命令互相调用。

---

## 2. Extension Host 扩展（推荐）

### 2.1 扩展目录结构

扩展放在项目根目录的 `extensions/<id>/` 下，运行时由 Extension Host 扫描并加载。

```
extensions/my-extension/
├── package.json          # 扩展清单
├── extension.cjs         # 构建后的入口（Extension Host 实际加载）
├── extension.js          # 源码入口
├── api.js                # vscode API 桩（建议复用 @ideacode/extensions-shared）
├── build.cjs             # esbuild 构建脚本
└── webview/              # WebView 前端产物
    ├── index.html
    └── assets/
```

### 2.2 扩展清单 `package.json`

```json
{
  "name": "my-publisher-my-extension",
  "displayName": "我的扩展",
  "description": "一个示例扩展",
  "version": "1.0.0",
  "publisher": "my-publisher",
  "main": "extension.cjs",
  "activationEvents": ["onStartupFinished"],
  "contributes": {
    "commands": [
      { "command": "myExt.hello", "title": "我的扩展: 打招呼", "category": "MyExt" }
    ],
    "viewsContainers": {
      "activitybar": [
        { "id": "my-ext", "title": "我的扩展", "icon": "$(zap)" }
      ]
    },
    "views": {
      "my-ext": [
        { "id": "my-ext.panel", "name": "面板" }
      ]
    }
  },
  "scripts": {
    "build": "node build.cjs"
  }
}
```

字段说明：

| 字段 | 说明 |
|------|------|
| `main` | 入口文件，必须是 CommonJS，建议打包为 `extension.cjs`。 |
| `activationEvents` | 激活时机。常用 `onStartupFinished`（启动后自动激活）或 `onCommand:xxx`（调用命令时激活）。 |
| `contributes.commands` | 注册的命令列表，会出现在命令面板。 |
| `contributes.viewsContainers` | Activity Bar 上的容器。 |
| `contributes.views` | 容器内的视图，需要与 `createWebviewPanel` 的 `viewType` 对应。 |

### 2.3 扩展入口 `extension.js`

```js
const vscode = require('@ideacode/extensions-shared');

async function activate(context) {
  console.log('[MyExt] 扩展已激活');

  // 注册命令
  const disposable = vscode.commands.registerCommand('myExt.hello', async () => {
    const name = await vscode.window.showInputBox({ prompt: '请输入你的名字' });
    if (name) {
      vscode.window.showInformationMessage(`你好，${name}！`);
    }
  });

  context.subscriptions.push(disposable);
}

function deactivate() {
  console.log('[MyExt] 扩展已停用');
}

module.exports = { activate, deactivate };
```

`activate(context)` 接收的 `context` 对象包含：

| 成员 | 类型 | 说明 |
|------|------|------|
| `context.subscriptions` | `Disposable[]` | 插件释放资源列表，扩展停用时会自动调用 `dispose()`。 |
| `context.extensionPath` | `string` | 扩展目录绝对路径。 |
| `context.extensionUri` | `Uri` | 扩展目录 URI，`{ scheme: 'file', fsPath: extensionPath }`。 |
| `context.globalState` | `ExtensionStorage` | 全局持久化存储。 |
| `context.workspaceState` | `ExtensionStorage` | 按工作区隔离的持久化存储。 |
| `context.secrets` | `SecretStorage` | 密钥安全存储。 |

### 2.4 使用 `@ideacode/extensions-shared`

`@ideacode/extensions-shared` 是统一的 VS Code 兼容 API 模块，替代了过去每个扩展各自维护的 `api.js`。

```js
// 方式 1：复用仓库内的共享包（扩展源码放在本仓库时）
const vscode = require('@ideacode/extensions-shared');

// 方式 2：把 vscode-api.js 复制到你的扩展目录作为 api.js
const vscode = require('./api');
```

该模块内部通过 `process.send` / `process.on('message')` 与 Extension Host 进行 JSON-RPC 通信，调用上限为 30 秒超时。

除了 `vscode.*` 命名空间外，还暴露了底层通信辅助函数：

```js
const { request, send } = require('@ideacode/extensions-shared');

// 发送请求并等待响应
const result = await request('commands.getCommands', {});

// 发送通知（fire-and-forget）
send('window.showInformationMessage', { message: '通知消息', items: [] });
```

### 2.5 构建与部署

扩展宿主运行在 Node 环境，需要把源码和依赖打包为单个 CommonJS 文件：

```js
// build.cjs
const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['./extension.js'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'extension.cjs',
  external: ['cpu-features'], // 原生依赖不要打包
}).catch(() => process.exit(1));
```

构建并加载：

```bash
# 在扩展目录内构建入口
cd extensions/my-extension
npm install
npm run build

# 开发时重启 Extension Host 即可加载
# 生产环境随 IDE 打包
```

Extension Host 启动时会扫描 `extensions/` 下的每个 `package.json`，根据 `activationEvents` 自动激活扩展。

---

## 3. 常用 API 详解

### 3.1 `vscode.window` — 窗口与 UI

```js
const vscode = require('@ideacode/extensions-shared');

// 消息框
await vscode.window.showInformationMessage('操作成功', '确定', '取消');
await vscode.window.showErrorMessage('出错了');
await vscode.window.showWarningMessage('警告');

// 输入框
const value = await vscode.window.showInputBox({
  prompt: '请输入文件名',
  value: 'untitled.txt',
  placeHolder: '文件名',
});

// 快速选择
const pick = await vscode.window.showQuickPick([
  { label: '选项 A', description: '描述 A' },
  { label: '选项 B', description: '描述 B' },
], { placeHolder: '请选择一个选项' });

// 文件对话框
const files = await vscode.window.showOpenDialog({
  canSelectFiles: true,
  canSelectFolders: false,
  canSelectMany: false,
});

// 保存对话框
const saved = await vscode.window.showSaveDialog({
  defaultUri: vscode.Uri.file('/tmp/output.txt'),
});

// 状态栏消息
vscode.window.setStatusBarMessage('正在执行...', 3000);
```

### 3.2 `vscode.workspace` — 工作区

```js
// 打开文档
const doc = await vscode.workspace.openTextDocument(vscode.Uri.file('/tmp/a.js'));

// 保存所有文档
await vscode.workspace.saveAll();

// 获取工作区根目录
const folders = await vscode.workspace.getWorkspaceFolders();

// 读取/更新配置（目前为占位实现，建议通过 commands 与主进程交互）
const cfg = vscode.workspace.getConfiguration('myExt');
```

### 3.3 `vscode.commands` — 命令

```js
// 注册命令
const disposable = vscode.commands.registerCommand('myExt.doSomething', async (arg) => {
  console.log('收到参数', arg);
  return 'done';
});
context.subscriptions.push(disposable);

// 执行命令（可跨扩展调用）
const result = await vscode.commands.executeCommand('myExt.doSomething', { foo: 1 });

// 调用 SSH 扩展能力示例
const output = await vscode.commands.executeCommand('ssh.executeRemote', {
  connectionId: 'my-ssh',
  command: 'uname -a',
  cwd: '/home/user',
});
```

### 3.4 `vscode.env` — 环境与剪贴板

```js
console.log(vscode.env.appName);   // IDEACODE
console.log(vscode.env.language);  // zh-CN

// 剪贴板
await vscode.env.clipboard.writeText('hello');
const text = await vscode.env.clipboard.readText();

// 打开外部链接
await vscode.env.openExternal(vscode.Uri.parse('https://example.com'));
```

### 3.5 `vscode.Uri`

```js
const fileUri = vscode.Uri.file('/tmp/a.js');
// { scheme: 'file', fsPath: '/tmp/a.js' }

const parsed = vscode.Uri.parse('ssh://host/path');
// { scheme: 'ssh', fsPath: 'host/path' }
```

### 3.6 `context.globalState / workspaceState / secrets` — 持久化

```js
async function activate(context) {
  // 全局存储
  let counter = (await context.globalState.get('counter', 0)) + 1;
  await context.globalState.update('counter', counter);

  // 工作区存储
  await context.workspaceState.update('lastOpened', Date.now());

  // 密钥存储
  await context.secrets.store('apiKey', 'sk-xxxx');
  const key = await context.secrets.get('apiKey');
  await context.secrets.delete('apiKey');
}
```

---

## 4. WebView 扩展开发

WebView 是扩展自定义 UI 的主要方式。前端可以使用任意框架（仓库内示例使用 Vite + React），最终产物放在 `extensions/<id>/webview/` 下，由 Extension Host 在运行时内联到 HTML 中。

### 4.1 创建 WebView 面板

```js
function activate(context) {
  const panel = vscode.window.createWebviewPanel(
    'myExt.panel',            // viewType，需与 package.json contributes.views 匹配
    '我的面板',                // 标题
    { preserveFocus: true },  // 显示选项
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      extensionId: context.extensionId,
      extensionPath: context.extensionPath,
    }
  );

  panel.webview.html = getWebviewHtml(context.extensionPath);

  // 接收 WebView 消息
  panel.webview.onDidReceiveMessage((message) => {
    if (message.command === 'sayHello') {
      vscode.window.showInformationMessage(`来自 WebView：${message.text}`);
    }
  });

  // 向 WebView 发送消息
  panel.webview.postMessage({ type: 'init', data: { version: '1.0.0' } });

  context.subscriptions.push({
    dispose: () => panel.dispose(),
  });
}
```

### 4.2 加载 WebView HTML

Extension Host 需要把 `index.html` 中的 `<link>` / `<script>` 资源内联为 `<style>` / `<script>`，因为 WebView 无法直接访问本地文件：

```js
const fs = require('fs');
const path = require('path');

function getWebviewHtml(extensionPath) {
  const htmlPath = path.join(extensionPath, 'webview', 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf-8');

  html = html.replace(
    /<link[^>]*rel="stylesheet"[^>]*href="(?:\.\/|\/)assets\/([^"]+)"[^>]*>/g,
    (match, filename) => {
      const cssPath = path.join(extensionPath, 'webview', 'assets', filename);
      try {
        const css = fs.readFileSync(cssPath, 'utf-8');
        return `<style>${css}</style>`;
      } catch { return match; }
    }
  );

  html = html.replace(
    /<script[^>]*type="module"[^>]*src="(?:\.\/|\/)assets\/([^"]+)"[^>]*><\/script>/g,
    (match, filename) => {
      const jsPath = path.join(extensionPath, 'webview', 'assets', filename);
      try {
        const js = fs.readFileSync(jsPath, 'utf-8');
        return `<script type="module">${js}</script>`;
      } catch { return match; }
    }
  );

  return html;
}
```

### 4.3 WebView 前端通信

WebView 内部使用标准 `acquireVsCodeApi()`（IDEACODE 提供兼容实现）：

```html
<!-- web/my-ext/index.html -->
<!doctype html>
<html>
  <body>
    <div id="root"></div>
    <script type="module" src="./src/main.tsx"></script>
  </body>
</html>
```

```tsx
// web/my-ext/src/App.tsx
import { useEffect, useState } from 'react';

// IDEACODE 在 WebView 全局注入的兼容 API
const vscode = (window as any).vscode;

export default function App() {
  const [text, setText] = useState('');

  useEffect(() => {
    // 接收 Extension Host 消息
    vscode.onMessage((msg: any) => {
      if (msg.type === 'init') {
        setText(`版本：${msg.data.version}`);
      }
    });

    // 发送消息到 Extension Host
    vscode.postMessage({ command: 'sayHello', text: '你好，IDEACODE！' });
  }, []);

  return <div>{text}</div>;
}
```

WebView 构建注意事项：

```js
// vite.config.ts
export default {
  base: './',                  // 使用相对路径，方便内联
  build: {
    outDir: 'webview-dist',
    rollupOptions: {
      output: {
        manualChunks: undefined,
        inlineDynamicImports: true, // 单 chunk，避免内联时路径问题
      },
    },
  },
};
```

构建后通过脚本把 `webview-dist` 复制到 `extensions/<id>/webview/`。

---

## 5. 进阶能力示例

### 5.1 树视图（TreeView）

```js
const vscode = require('@ideacode/extensions-shared');

class MyTreeDataProvider {
  async getChildren(element) {
    if (!element) {
      return [
        { id: '1', label: '节点 1', collapsibleState: 'expanded' },
        { id: '2', label: '节点 2', collapsibleState: 'collapsed' },
      ];
    }
    return [
      { id: `${element.id}-a`, label: `${element.label} / 子项 A` },
      { id: `${element.id}-b`, label: `${element.label} / 子项 B` },
    ];
  }

  getTreeItem(element) {
    return element;
  }
}

function activate(context) {
  const provider = new MyTreeDataProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('myExt.treeView', provider)
  );
}
```

`TreeItem` 形状：

```ts
{
  id: string;
  label: string;
  description?: string;
  icon?: string;
  tooltip?: string;
  collapsibleState?: 'none' | 'collapsed' | 'expanded';
  children?: TreeItem[];
  command?: { command: string; title: string; arguments?: unknown[] };
}
```

### 5.2 文件系统提供程序（FileSystemProvider）

适合为远程或虚拟协议提供文件访问能力，例如 `ssh://`、`memfs://`。

```js
const vscode = require('@ideacode/extensions-shared');

const myFsProvider = {
  async readFile(uri) {
    // 返回 string
    return '文件内容';
  },
  async writeFile(uri, content) {
    // content: string
  },
  async stat(uri) {
    return {
      type: 1, // 1=file, 2=directory
      ctime: Date.now(),
      mtime: Date.now(),
      size: 0,
    };
  },
  async readDirectory(uri) {
    return [['file.txt', 1], ['folder', 2]];
  },
  async createDirectory(uri) {},
  async delete(uri, options) {},
  async rename(source, target, options) {},
};

function activate(context) {
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider('myfs', myFsProvider)
  );
}
```

### 5.3 终端

```js
const terminal = vscode.window.createTerminal({
  name: 'My Terminal',
  shellPath: '/bin/zsh',
  cwd: '/tmp',
});

terminal.sendText('echo hello');
terminal.show();

context.subscriptions.push({ dispose: () => terminal.dispose() });
```

### 5.4 跨扩展命令调用

```js
// 调用 IDE 内置或其它扩展注册的命令
const branches = await vscode.commands.executeCommand('git.getBranches');

// 调用 SSH 扩展在远程执行命令
const result = await vscode.commands.executeCommand('ssh.executeRemote', {
  connectionId: 'my-server',
  command: 'git status --short',
  cwd: '/home/user/project',
});
```

---

## 6. 完整第三方扩展示例

### 6.1 最小命令扩展

**`extensions/my-hello/package.json`**

```json
{
  "name": "ideacode-hello",
  "displayName": "Hello IDEACODE",
  "version": "1.0.0",
  "publisher": "ideacode",
  "main": "extension.cjs",
  "activationEvents": ["onCommand:hello.sayHello"],
  "contributes": {
    "commands": [
      { "command": "hello.sayHello", "title": "Hello: 打招呼" }
    ]
  }
}
```

**`extensions/my-hello/extension.js`**

```js
const vscode = require('@ideacode/extensions-shared');

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('hello.sayHello', async () => {
      const name = await vscode.window.showInputBox({ prompt: '名字' });
      vscode.window.showInformationMessage(name ? `Hello, ${name}` : 'Hello, IDEACODE!');
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
```

**`extensions/my-hello/build.cjs`**

```js
const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['./extension.js'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'extension.cjs',
}).catch(() => process.exit(1));
```

### 6.2 带 WebView 的扩展

```js
const vscode = require('@ideacode/extensions-shared');
const fs = require('fs');
const path = require('path');

function getHtml(extensionPath) {
  const htmlPath = path.join(extensionPath, 'webview', 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf-8');
  html = html.replace(
    /<script[^>]*src="\.\/assets\/([^"]+)"[^>]*><\/script>/g,
    (m, file) => `<script type="module">${fs.readFileSync(path.join(extensionPath, 'webview', 'assets', file), 'utf-8')}</script>`
  );
  html = html.replace(
    /<link[^>]*href="\.\/assets\/([^"]+)"[^>]*>/g,
    (m, file) => `<style>${fs.readFileSync(path.join(extensionPath, 'webview', 'assets', file), 'utf-8')}</style>`
  );
  return html;
}

function activate(context) {
  const panel = vscode.window.createWebviewPanel(
    'hello.panel',
    'Hello 面板',
    { preserveFocus: true },
    { enableScripts: true, retainContextWhenHidden: true }
  );

  panel.webview.html = getHtml(context.extensionPath);

  panel.webview.onDidReceiveMessage((msg) => {
    if (msg.command === 'alert') {
      vscode.window.showInformationMessage(msg.text);
    }
  });

  context.subscriptions.push({ dispose: () => panel.dispose() });
}

module.exports = { activate, deactivate: () => {} };
```

---

## 7. 内部 SDK：`@ideacode/sdk`（供 IDE 核心与高级扩展使用）

`@ideacode/sdk` 是正在建设的统一扩展 SDK，目标是让扩展与 IDE 核心之间通过 `ServiceBus` 通信，而不是直接依赖 Electron IPC 或 Redux。

### 7.1 ServiceBus（`@ideacode/kernel`）

`ServiceBus` 是微内核的消息总线，提供四类能力：

```ts
interface IServiceBus {
  // 请求-响应（RPC）
  request<T>(service: string, method: string, params?: unknown): Promise<T>;

  // 通知（fire-and-forget）
  notify(service: string, method: string, params?: unknown): void;

  // 发布-订阅
  publish(topic: string, data: unknown): void;
  subscribe(topic: string, handler: (data: unknown) => void): Disposable;

  // 本地处理器注册
  handle(method: string, handler: (params: unknown) => unknown | Promise<unknown>): void;
  removeHandler(method: string): boolean;

  // 服务注册表
  registerService(manifest: ServiceManifest, instance: unknown): void;
  getService<T>(serviceId: string): T | undefined;
}
```

方法名采用 `service:method` 形式，例如 `fs:readFile`、`webview:create`。

使用示例：

```ts
import { ServiceBus } from '@ideacode/kernel';

const bus = new ServiceBus();

// 注册本地处理器
bus.handle('hello:greet', (params) => {
  return { message: `Hello, ${params.name}` };
});

// 发起请求
const res = await bus.request<{ message: string }>('hello', 'greet', { name: 'IDEACODE' });
console.log(res.message); // Hello, IDEACODE

// 发布-订阅
const sub = bus.subscribe('file:changed', (data) => {
  console.log('文件变更', data);
});

bus.publish('file:changed', { path: '/tmp/a.js' });
sub.dispose();
```

### 7.2 ExtensionBridge

`ExtensionBridge` 管理扩展生命周期，并把 Extension Host 的消息桥接到 `ServiceBus`。

```ts
import { ServiceBus } from '@ideacode/kernel';
import { ExtensionBridge } from '@ideacode/sdk';

const bus = new ServiceBus();
const bridge = new ExtensionBridge(bus);

// 设置与 Extension Host 通信的 RPC 函数
bridge.setHostRpc(async (method, params) => {
  return window.electronAPI.extension.rpc(method, params);
});

// 初始化：等待 Host 就绪、扫描扩展、自动激活
await bridge.initialize();

// 手动激活/停用
await bridge.activateExtension('ideacode-git');
await bridge.deactivateExtension('ideacode-git');

// 获取扩展状态
const all = bridge.getAllExtensions();
const ext = bridge.getExtension('ideacode-git');

// 调用扩展暴露的方法
const result = await bridge.invokeExtension('ideacode-git', 'getStatus', []);

bridge.dispose();
```

### 7.3 ExtensionContextImpl

`ExtensionContextImpl` 是 `ExtensionContext` 接口的实现，封装了各类子 API，所有调用都通过 `ServiceBus` 路由。

```ts
import { ServiceBus } from '@ideacode/kernel';
import { ExtensionContextImpl } from '@ideacode/sdk';
import type { ExtensionManifest } from '@ideacode/types';

const manifest: ExtensionManifest = {
  id: 'my-extension',
  name: 'my-extension',
  version: '1.0.0',
  main: 'extension.cjs',
};

const ctx = new ExtensionContextImpl(bus, manifest, '/extensions/my-extension');

// 使用窗口 API
await ctx.window.showInformationMessage('来自 SDK 的问候');

// 使用文件系统 API
const content = await ctx.fs.readFile({ scheme: 'file', fsPath: '/tmp/a.js' });

// 注册命令
ctx.commands.registerCommand('sdk.hello', () => 'Hello from SDK');
```

### 7.4 ServiceAdapters

`ServiceAdapter` 用于把 `ServiceBus` 上的方法映射到实际的后端能力。SDK 内置了以下适配器：

| 适配器 | ID | 说明 |
|--------|----|------|
| `FileServiceAdapter` | `fileService` | 文件系统：`fs.readDir`、`fs.readFile`、`fs.writeFile`、`fs.stat`、`fs.createFile`、`fs.createDir`、`fs.delete`、`fs.rename`、`fs.copy`、`fs.reveal`、`fs.search` |
| `TerminalServiceAdapter` | `terminalService` | 终端：`terminal.create`、`terminal.sendInput`、`terminal.dispose`、`terminal.show`、`terminal.hide`，并发布 `terminal:<tabId>:output`、`terminal:<tabId>:exit` |
| `EditorServiceAdapter` | `editorService` | 编辑器：`editor.getActive`、`editor.getVisible`、`lifeAiCode.editCode`、`lifeAiCode.toggleEditMode` |
| `WorkspaceServiceAdapter` | `workspaceService` | 工作区：`workspace.getRootPath`、`workspace.getFolders`、`workspace.openDocument`、`workspace.openRemoteFileTree`、`workspace.registerFileSystemProvider`、`configuration.get/set`、`storage.get/set`、`secrets.get/store/delete`、`env.clipboard.*`、`env.openExternal` |
| `WebViewServiceAdapter` | `webViewService` | WebView / 树视图：`webview.create`、`webview.setHtml`、`webview.dispose`、`webview.reveal`、`webview.postMessage`、`webview.message`、`tree.register/unregister`、`webviewView.register/unregister`、`ui.statusBar.update/hide`、`ui.activityBar.setBadge`、`ui.showMessage` |
| `ExtensionMgmtAdapter` | `extensionMgmt` | 扩展管理：`extension.disable/enable/uninstall`，以及 Git 相关事件/命令：`git.statusChanged`、`git.branchChanged`、`git.openFile`、`git.loadDirectory`、`git.openRepositoryDialog`、`git.clone`、`git.pushState` |

使用示例：

```ts
import { ServiceBus } from '@ideacode/kernel';
import { FileServiceAdapter, WebViewServiceAdapter } from '@ideacode/sdk';

const bus = new ServiceBus();

const files = new FileServiceAdapter();
files.setFileApi(window.electronAPI.fs); // 注入 Electron 文件 API
files.register(bus);

const webviews = new WebViewServiceAdapter();
webviews.setWebViewState({ dispatch: (action) => store.dispatch(action) });
webviews.register(bus);
```

### 7.5 何时使用 `@ideacode/sdk`

- **扩展作者**：目前不需要直接使用。未来当 Extension Host 全面迁移到 `ServiceBus` 后，扩展入口会改为接收 `ExtensionContextImpl` 上下文。
- **IDE 核心开发者**：在渲染进程搭建新的桥接、替换 `src/plugin/extensionBridge.ts` 时，应优先使用 `ExtensionBridge` + `ServiceAdapter`。

---

## 8. 共享类型：`@ideacode/types`

`@ideacode/types` 提供所有扩展与 SDK 相关的类型契约。

```ts
// 统一入口
import type { ExtensionManifest, ExtensionContext, WindowApi } from '@ideacode/types';

// 子路径导出
import type { IServiceBus } from '@ideacode/types/services';
import type { IpcRequest, Uri } from '@ideacode/types/ipc';
```

主要类型族：

| 模块 | 关键类型 |
|------|----------|
| `ipc` | `IpcRequest`、`IpcResponse`、`IpcNotification`、`IpcError`、`Disposable`、`Event<T>`、`Uri` |
| `services` | `IFileService`、`ITerminalService`、`IEditorService`、`IWorkspaceService`、`IUiService`、`IWebViewService`、`IServiceBus` 及 DTO |
| `extensions` | `ExtensionManifest`、`ExtensionContext`、`WindowApi`、`WorkspaceApi`、`CommandApi`、`EditorApi`、`TerminalApi`、`FileSystemApi`、`LanguageApi`、`EnvironmentApi`、`WebviewPanel`、`Webview`、`TreeItem`、`TreeDataProvider`、`TextDocument`、`TextEditor` |

---

## 9. 调试与开发

### 9.1 热重载

开发 Extension Host 扩展时，主进程会监视 `extensions/*.{js,cjs,json}` 的变化并自动重启 Extension Host。

```bash
# 默认开启热重载；如需关闭
LIFEAICODE_HOTRELOAD=0 npm run electron:dev
```

### 9.2 查看日志

Extension Host 的日志会输出到主进程控制台，查找 `[ExtensionHost]`、`[ExtensionManager]` 等前缀。

### 9.3 调试 WebView

WebView 运行在渲染进程的 `<iframe>` 中。可在 DevTools 中：

1. 打开 **开发者工具**。
2. 在 Console 中执行 `document.querySelector('iframe.webview-panel').contentWindow` 查看内部状态。
3. 在 WebView 代码中主动 `console.log`，消息会冒泡到外层 Console。

### 9.4 排查扩展未加载

1. 确认 `extensions/<id>/package.json` 中 `main` 指向存在的 `.cjs` 文件。
2. 确认 `activationEvents` 包含 `onStartupFinished` 或正确的事件。
3. 查看 Extension Host 日志是否有 `扩展已激活: <id>`。
4. 若使用 `@ideacode/extensions-shared`，确认扩展打包时未错误地将其外部化（应使用仓库内的模块或复制 `vscode-api.js`）。

---

## 10. 注意事项与兼容性

1. **`vscode` API 是兼容层**：并非 100% 覆盖 VS Code API，只实现了 IDEACODE 当前需要的子集。扩展移植时需要对照本文档检查。
2. **WebView 资源必须内联**：Extension Host 会把 `webview/index.html` 里的 CSS/JS 内联，因此构建时建议 `inlineDynamicImports: true` 并避免多 chunk。
3. **命令命名空间**：建议用 `<publisher>.<command>` 或 `<extId>.<command>` 命名，避免冲突。
4. **存储前缀**：`globalState` 与 `workspaceState` 会自动以扩展 `name` 作为前缀，不需要手动加前缀。
5. **原生依赖**：SSH 扩展依赖 `ssh2`、`node-pty` 等原生模块，打包时应在 `build.cjs` 中 `external`，由宿主进程提供运行环境。
6. **文件写入安全**：AI 类扩展不要直接调用 Node `fs.writeFile` 修改工作区外文件；应通过 `commands.executeCommand` 调用 IDE 提供的受控方法。
7. **渲染进程插件不推荐第三方使用**：它直接访问 Redux store 和 React 组件，耦合度高，且没有进程隔离。

---

## 11. 参考文件

| 用途 | 路径 |
|------|------|
| SDK 入口 | `packages/sdk/src/index.ts` |
| 扩展上下文实现 | `packages/sdk/src/ExtensionContext.ts` |
| 扩展桥接器 | `packages/sdk/src/ExtensionBridge.ts` |
| 服务适配器 | `packages/sdk/src/serviceAdapters/*.ts` |
| 微内核 / ServiceBus | `packages/kernel/src/bus/ServiceBus.ts` |
| 共享类型 | `packages/types/src/index.ts` |
| 共享 vscode API | `packages/extensions-shared/src/vscode-api.js` |
| Extension Host 运行时 | `electron/extension-host/index.cjs` |
| Extension Host 管理器 | `electron/main/extensionHost.cjs` |
| 渲染进程桥接（旧） | `src/plugin/extensionBridge.ts` |
| 渲染进程插件示例 | `src/plugin/index.ts` |
| Git 扩展示例 | `extensions/git/extension.js`、`web/git/src/App.tsx` |
| SSH 扩展示例 | `extensions/ssh/extension.js` |
| LifeAiCode 扩展示例 | `extensions/lifeAiCode/extension.js`、`src/plugin/aiPlugin.ts` |

---

## 12. 变更与迁移

- **旧方式**：每个扩展维护独立的 `api.js`，通过 `process.send` 手动拼 JSON-RPC。
- **新方式**：统一 `require('@ideacode/extensions-shared')`，获得一致的 `vscode` 兼容 API。
- **未来方向**：Extension Host 会逐步切换到 `@ideacode/sdk` 的 `ExtensionContextImpl`，扩展入口将获得更完整的类型安全与生命周期管理。

---

> 如有新增 API 需求或发现文档与代码不一致，请在对应扩展或 `packages/sdk` 中补充适配器与类型定义，并同步更新本文档。
