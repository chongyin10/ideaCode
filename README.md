# IDEACODE

基于 **React + TypeScript + Vite + Monaco Editor + Electron** 构建的轻量级桌面 IDE，支持扩展系统、AI 代码辅助、远程文件管理、终端、Git 集成。

![React](https://img.shields.io/badge/React-18.3-61DAFB?logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?logo=typescript)
![Vite](https://img.shields.io/badge/Vite-5.4-646CFF?logo=vite)
![Electron](https://img.shields.io/badge/Electron-30-47848F?logo=electron)

---

## 技术栈

| 技术 | 说明 |
|------|------|
| React 18 | UI 框架 |
| TypeScript | 类型安全 |
| Vite 5 | 构建工具与热更新 |
| Monaco Editor | VS Code 同款编辑器核心 |
| Electron 30 | 跨平台桌面应用框架 |
| Redux Toolkit | 状态管理 |
| xterm.js | 内置终端 |
| i18next | 国际化 |

---

## 环境要求

- **Node.js** >= 18.12.0
- **npm** >= 9.0（或 pnpm / yarn）
- **操作系统**：macOS / Windows / Linux（桌面运行需图形界面）

---

## 快速开始

### 1. 安装依赖

```bash
npm install
```

> 国内网络若安装 Electron 较慢，可使用镜像：
> ```bash
> ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
> ```

### 2. 本地运行（浏览器 Web 版）

```bash
npm run dev
```

启动后打开浏览器访问 `http://localhost:5173`。

**注意**：浏览器 Web 版打开本地文件夹时，会使用 File System Access API 弹出系统文件选择器。

### 3. 桌面运行（Electron 开发模式）

推荐日常开发方式。一键启动 **Vite 热更新 + Electron 桌面窗口**，自动打开 DevTools：

```bash
npm run electron:dev
```

执行流程：
1. 启动 Vite dev server（`http://localhost:5173`）
2. 启动 Electron 桌面窗口并加载该地址
3. 自动打开 Chrome DevTools
4. 按 `Ctrl + C` 一键关闭两者

### 4. 桌面运行（生产预览）

```bash
npm run electron:preview
```

先执行 `vite build`，然后启动 Electron 加载本地打包文件。

---

## 扩展开发

### 架构

```
渲染进程 (React)
  ├─ PluginSystem          ← 内置插件（渲染进程内运行）
  │   ├─ aiPlugin.ts       ← LifeAiCode 插件（注册命令/菜单）
  │   └─ extensionBridge.ts ← 与 Extension Host RPC 通信
  │
  └─ WebViewPanel          ← iframe 容器（运行扩展 WebView UI）

Extension Host (子进程 fork)
  ├─ index.cjs             ← RPC 路由 / 扩展扫描 / 激活
  └─ extensions/
      ├─ ssh/              ← SSH/SFTP 远程文件系统
      └─ lifeAiCode/       ← AI 代码辅助（构建产物）

主进程 (Electron main)
  ├─ main.cjs              ← 窗口管理/菜单
  └─ extensionHost.cjs     ← Extension Host 生命周期管理
```

### 已有的扩展

| 扩展 | 源码目录 | 描述 |
|------|---------|------|
| **SSH** | `web/ssh/` | SSH/SFTP 远程文件系统浏览与编辑 |
| **LifeAiCode** | `web/lifeAiCode/` | AI 代码辅助工具 |

### LifeAiCode — AI 代码辅助扩展

支持多 LLM 厂商的 AI 代码助手。源码全部位于 `web/lifeAiCode/`，构建产物输出到 `extensions/lifeAiCode/`。

**目录结构：**

```
web/lifeAiCode/
├── extension-host/          ← Extension Host 核心 JS（在子进程中运行）
│   ├── extension.js         ← 主入口（WebView 管理、消息路由、LLM 调用）
│   ├── api.js               ← VSCode 兼容 API 存根
│   ├── llmClient.js         ← LLM API 客户端（OpenAI/Anthropic/DeepSeek/GLM/Qwen/Ollama）
│   ├── codeContext.js       ← 代码上下文构建器（收集编辑器环境）
│   ├── suggestionGenerator.js ← 建议解析器（LLM 响应 → 结构化建议）
│   └── package.json          ← 扩展清单
├── src/                     ← WebView 前端（React）
│   ├── components/          ← 对话面板、配置面板、建议卡片
│   ├── App.tsx              ← 双 Tab 布局（对话 / 配置）
│   └── types.ts             ← 完整类型定义
└── scripts/                 ← 构建脚本
    ├── build-all.cjs        ← 一键完整构建
    ├── build-extension.cjs  ← 打包扩展
    └── copy-to-extension.cjs ← 部署到 extensions/lifeAiCode/
```

**支持的 LLM 厂商：**

| 厂商 | 标识 | API Base URL | 默认模型 |
|------|------|-------------|---------|
| OpenAI | `openai` | `https://api.openai.com/v1` | `gpt-4o` |
| Anthropic | `anthropic` | `https://api.anthropic.com/v1` | `claude-3-sonnet` |
| DeepSeek | `deepseek` | `https://api.deepseek.com` | `deepseek-v4-flash` |
| GLM (智谱) | `glm` | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-plus` |
| Qwen (千问) | `qwen` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| Ollama (本地) | `ollama` | `http://localhost:11434` | `deepseek-coder` |
| 自定义 | `custom` | 用户自填 | 自定义 |

**核心设计原则：**

1. **只读分析** — AI 分析代码但不直接修改，建议以 diff 形式展示
2. **用户确认** — 所有代码变更必须用户确认后才写入
3. **进程隔离** — 运行在独立 Extension Host 子进程
4. **多配置** — 可添加多组厂商配置，一键切换

**构建 LifeAiCode：**

```bash
# 完整构建（extension-host + webview）
cd web/lifeAiCode
npm run build:all

# 仅构建 WebView
npm run build
```

**配置 API Key：**

可在 WebView 配置面板中添加，或通过环境变量设置：

```bash
export OPENAI_API_KEY="sk-..."
export DEEPSEEK_API_KEY="sk-..."
export ZHIPU_API_KEY="..."
export DASHSCOPE_API_KEY="sk-..."
```

### SSH 扩展

```bash
cd web/ssh && npm install && npm run build
```

---

## 常用脚本

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动 Web 开发服务器（浏览器访问） |
| `npm run build` | 生产构建（先构建扩展，再构建主应用） |
| `npm run preview` | 预览生产构建（浏览器） |
| `npm run lint` | ESLint 代码检查 |
| `npm run electron:dev` | **桌面开发模式**（热更新 + 自动 DevTools） |
| `npm run electron:preview` | **桌面生产预览**（打包后启动窗口） |

---

## 项目结构

```
ideacode/
├── electron/                    # Electron 主进程
│   ├── main.cjs                 # 主进程入口（窗口管理、菜单）
│   ├── preload.cjs              # 预加载脚本（安全桥接）
│   ├── extension-host/          # Extension Host RPC 服务器
│   │   ├── index.cjs            # RPC 路由 / 扩展生命周期
│   │   └── rpc.cjs              # JSON-RPC 实现
│   └── main/
│       ├── extensionHost.cjs    # Extension Host 进程管理
│       └── ipcHandlers/         # IPC 处理器
├── src/                         # 渲染进程（IDE 主应用）
│   ├── components/              # UI 组件
│   │   ├── ActivityBar/         # 左侧活动栏
│   │   ├── MonacoEditor/        # 代码编辑器（Monaco）
│   │   ├── SidePanel/           # 侧边面板（文件树/搜索/终端）
│   │   ├── StatusBar/           # 底部状态栏
│   │   ├── TabBar/              # 编辑器标签页
│   │   ├── TopBar/              # 顶部标题栏
│   │   ├── WebViewPanel/        # WebView iframe 容器
│   │   └── DiffEditorPanel/     # 差异编辑器
│   ├── store/                   # Redux 状态管理
│   │   └── slices/              # 状态切片（workspace/git/terminal/…）
│   ├── plugin/                  # 插件系统
│   │   ├── core.ts              # 插件管理器
│   │   ├── extensionBridge.ts   # 与 Extension Host RPC 桥接
│   │   ├── aiPlugin.ts          # LifeAiCode 内置插件
│   │   ├── api.ts               # 插件 API（编辑器/文件/UI）
│   │   └── types.ts             # 插件类型定义
│   ├── services/                # 服务层
│   │   ├── fileService.ts       # 文件系统操作
│   │   ├── gitService.ts        # Git 操作
│   │   └── monacoEditorBridge.ts # Monaco 编辑器桥接
│   ├── pages/
│   │   └── Home.tsx             # IDE 工作台主页
│   └── i18n/                    # 国际化
├── web/                         # 扩展前端源码
│   ├── ssh/                     # SSH 扩展前端（Vite + React）
│   └── lifeAiCode/              # LifeAiCode 扩展前端（Vite + React）
├── extensions/                  # 扩展产物（构建生成，gitignored）
│   ├── ssh/                     # SSH 扩展
│   └── lifeAiCode/              # LifeAiCode 扩展
├── scripts/
│   └── electron-dev.mjs         # 桌面开发模式启动脚本
├── index.html
├── package.json
├── vite.config.ts
└── README.md
```

---

## 已知问题

1. **Monaco Editor 首次加载**：编辑器核心资源较大，首次打开文件时可能需要短暂等待（已做预加载优化）。
2. **File System Access API 兼容性**：部分浏览器（如 Safari）不支持该 API，建议通过 Electron 桌面端使用。
3. **无头服务器无法启动 Electron**：需在带有图形界面的操作系统上运行。
