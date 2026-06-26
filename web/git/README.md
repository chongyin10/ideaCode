# IDEACODE Git 扩展

基于 **VS Code `vscode.git`** 架构设计的内置 Git 源码管理扩展。

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│  Renderer Process (React)                                       │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ DockableContent (SidePanel)                              │  │
│  │   └─ GitSourceControlView                                │  │
│  │        └─ WebViewPanel (iframe)                          │  │
│  │             └─ web/git/src/* (React UI)                  │  │
│  └───────────────────────────────────────────────────────────┘  │
└────────────────────────────▲────────────────────────────────────┘
                             │ postMessage (iframe ↔ renderer)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  Extension Host Process (Node.js subprocess)                    │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ web/git/extension/extension.js                            │  │
│  │   ├─ Repository  ──► 状态管理 + git CLI 调用              │  │
│  │   ├─ gitCLI.js   ──► spawn('git', ...) 封装               │  │
│  │   ├─ statusParser.js ──► 解析 porcelain v2                │  │
│  │   └─ api.js      ──► VSCode 兼容 API 存根                 │  │
│  └───────────────────────────────────────────────────────────┘  │
└────────────────────────────▲────────────────────────────────────┘
                             │ JSON-RPC
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  Main Process (Electron)                                        │
│  extensionHost.cjs (JSON-RPC router)                            │
│  extensionBridge.ts (renderer ↔ extension host bridge)          │
└─────────────────────────────────────────────────────────────────┘
```

## 关键设计

1. **Repository 类**（`web/git/extension/repository.js`）
   - 每个工作区一个实例，封装完整 Git 仓库状态
   - `onDidChange` 事件向 UI 推送状态变更
   - 自动轮询 `.git` 目录，操作后快速刷新
   - 提供 `stage` / `unstage` / `commit` / `discard` / `push` / `pull` 等完整 Git 操作

2. **gitCLI 封装层**（`web/git/extension/gitCLI.js`）
   - 使用 `child_process.spawn` 调用 `git` CLI
   - 统一超时、错误处理
   - 不抛异常，返回 `{ stdout, stderr, code }`

3. **Status Parser**（`web/git/extension/statusParser.js`）
   - 解析 `git status --porcelain=v2 --branch`
   - 区分 staged / changes / merge / untracked

4. **WebView UI**（`web/git/src/`）
   - 纯 React + TypeScript，VS Code 主题风格
   - 通过 `postMessage` 与 Extension Host 通信
   - 自适应轮询、赫布排序等高级特性可后续扩展

## 使用

### 构建
```bash
cd web/git
npm install
npm run build
```

构建产物输出到 `extensions/git/`：
- `extension.cjs` - Extension Host 端打包
- `webview/index.html` - WebView 入口（CSS/JS 已内联）

### 激活
扩展通过 `onStartupFinished` 自动激活，激活时会：
1. 创建 Source Control WebView
2. 轮询工作区根路径
3. 工作区变更时自动 `openRepository(rootPath)`，向上查找 `.git` 目录

### 集成方式
渲染进程的 `DockableContent` 检测到 `extensionId === 'ideacode-git'` 的 WebView 时，自动用它替换内置 `SourceControlPanel`。如果扩展未加载，回退到旧面板。

## 扩展点

- `repository.js` - 添加新 Git 命令
- `statusParser.js` - 支持更多 porcelain 格式
- `src/components/` - 添加 UI 组件（图形化 diff、stash 管理等）
- `extension.js` - 注册新命令/视图

## 与 VS Code `vscode.git` 的差异

- WebView UI 较简单（无内联 diff 编辑器，先打开文件）
- 暂不支持 multi-root workspace
- 暂不支持 submodule 管理
- 暂不支持 interactive rebase