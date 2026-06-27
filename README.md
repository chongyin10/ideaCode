# IDEACODE

基于 **React + TypeScript + Vite + Monaco Editor + Electron** 构建的轻量级桌面 IDE，提供类 VS Code 的开发体验，内置 AI 代码辅助、远程文件管理、终端和 Git 集成。

![React](https://img.shields.io/badge/React-18.3-61DAFB?logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?logo=typescript)
![Vite](https://img.shields.io/badge/Vite-5.4-646CFF?logo=vite)
![Electron](https://img.shields.io/badge/Electron-30-47848F?logo=electron)

---

## 功能概览

> ![整体界面](docs/images/overview-dark.png)

IDEACODE 围绕以下核心功能构建，提供完整的桌面 IDE 开发体验：

| 功能 | 说明 |
|------|------|
| 📁 **文件管理** | 完整的文件树，支持创建/重命名/删除/拖拽/剪切板操作 |
| ✏️ **代码编辑** | Monaco Editor 核心，多语言语法高亮、语义着色、智能补全 |
| 📑 **分屏编辑** | 多编辑器组并排显示，标签页拖拽排序，智能标签管理 |
| 🔍 **全局搜索** | 正则/模糊全文搜索，支持下钻到文件和替换 |
| 🖥️ **内置终端** | xterm.js 终端仿真，支持多实例/分屏/广播模式 |
| 🌿 **Git 集成** | 暂存/提交/推送/拉取，分支管理，差异对比 |
| 🤖 **AI 代码辅助** | 多 LLM 厂商支持，对话/代码审查/Agent 模式 |
| 🔗 **SSH 远程管理** | SSH/SFTP 远程文件浏览与编辑 |
| 🎨 **主题切换** | 浅色/深色/高对比度主题，字体大小可调 |
| 🌍 **国际化** | 中/英多语言 i18next 支持 |
| 🧩 **扩展系统** | 插件式架构，支持扩展注册命令、菜单、面板 |

> 截图清单和截取方法详见 → [docs/images/README.md](docs/images/README.md)

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

> **注意**：浏览器 Web 版打开本地文件夹时，会使用 File System Access API 弹出系统文件选择器。

### 3. 桌面运行（Electron 开发模式）

**推荐日常开发方式**。一键启动 Vite 热更新 + Electron 桌面窗口，自动打开 DevTools：

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

## 功能详解

### 整体布局

```
┌─────────────────────────────────────────────────┐
│  TopBar（标题栏 / 搜索 / 设置 / 面板切换）        │
├──────┬──────────┬───────────────┬───────────────┤
│Activ-│SidePanel │  主编辑区域     │  RightPanel   │
│ityBar│（文件树/  │（TabBar +     │  （AI 对话/   │
│      │  搜索/   │  MonacoEditor)│   扩展面板）   │
│      │  Git等） ├───────────────┤               │
│      │         │  BottomPanel  │               │
│      │         │  （终端/问题）  │               │
├──────┴──────────┴───────────────┴───────────────┤
│  StatusBar（Git分支/语言/行列号/系统资源）        │
└─────────────────────────────────────────────────┘
```

### 文件浏览器

> ![文件浏览器](docs/images/file-explorer.png)

左侧文件树提供完整的文件管理：

- **创建/重命名/删除**文件和文件夹（行内编辑）
- **剪切/复制/粘贴**，支持跨目录
- **拖拽移动**文件到任意目录
- 单击预览文件，双击锁定标签页
- **右键菜单**：复制路径、在系统文件管理器中显示
- **折叠全部**、刷新目录

### 代码编辑器

> ![代码编辑器](docs/images/code-editor.png)

Monaco Editor（VS Code 核心编辑器）提供：

- **50+ 语言语法高亮**，支持 JSX/TSX 特殊着色
- **TypeScript 语义高亮**：变量/方法/属性分别着色
- **Cmd+Click 跳转定义**（TypeScript 项目）
- **代码补全**与智能提示
- **只读模式**切换
- 编辑器状态快照（光标位置/滚动位置记忆）
- 语言模式手动切换

### 分屏编辑

> ![分屏编辑](docs/images/split-editor.png)

支持多编辑器组并排显示：

- 拖拽分割线调整列宽
- 等分宽度一键恢复
- 标签页拖拽排序
- **智能标签管理**（BCM 神经网络算法，自动淘汰冷门标签）
- 标签历史导航（Ctrl+Tab）
- 预览模式 vs 固定模式

### 快速打开

> ![快速打开](docs/images/quick-open.png)

`Cmd+P` / `Ctrl+P` 快速文件搜索：

- **模糊匹配**，基于 Boyer-Moore + 编辑距离算法
- 路径前缀过滤（如 `src/index` 仅搜索 `src/` 目录下）
- 自动排除 `node_modules`、`.git`、`dist`、`build`

### 全局搜索与替换

> ![搜索与替换](docs/images/search-replace.png)

全文搜索面板：

- 支持 **正则**、**整词匹配**、**大小写敏感**、**模糊模式**
- 文件包含/排除规则
- 按文件分组可折叠结果
- 单文件替换和批量替换
- 显示匹配文件数和匹配总数

### 内置终端

> ![内置终端](docs/images/terminal.png)

基于 xterm.js + node-pty 的完整终端仿真：

- **多标签页**实例，侧边栏列表管理
- **分屏终端**（左右分屏）
- **广播模式**（输入同步到所有终端）
- **Shell 配置文件**（zsh/bash/自定义）
- **书签功能**（添加/跳转/删除）
- 终端内搜索
- 终端输出折叠（性能优化）
- **密码自动检测**与隐藏
- 当前目录与文件树同步
- 终端可**移动到编辑器区域**作为独立标签页

### Git 版本控制

> ![Git 面板](docs/images/git-panel.png)
> ![Git 差异对比](docs/images/git-diff.png)

完整的 Git 工作流集成：

- **Source Control 面板**：已暂存/未暂存/合并冲突/未跟踪文件分类展示
- **暂存/取消暂存**单个文件或全部
- **放弃更改**（含确认弹窗）
- **提交**（支持 amend 和 --no-verify）
- **推送/拉取/获取**
- **分支管理**：切换分支、创建新分支
- **仓库初始化**（git init）和远程关联
- 点击变更文件打开 **Diff 编辑器**查看差异
- 编辑器标签页和状态栏实时显示 Git 状态标记

---

## AI 代码辅助（LifeAiCode）

LifeAiCode 是内置的 AI 代码助手扩展，支持多 LLM 厂商，提供代码分析、对话、Agent 模式等功能。

### AI 对话

> ![AI 对话](docs/images/ai-chat.png)

右侧面板的 AI 对话界面：

- **流式响应**（逐 Token 输出）
- **Markdown 渲染**，代码块语法高亮
- 对话历史管理（最近 20 条）
- **模型/厂商切换**下拉菜单
- 停止生成、重新生成、继续截断回复

### AI 代码审查

> ![AI 代码审查](docs/images/ai-code-review.png)

选中代码后通过右键菜单或命令面板触发：

- `AI: 解释代码` — 分析当前代码逻辑
- `AI: 建议重构` — 提供重构方案
- `AI: 代码审查` — 检查 Bug、安全隐患、性能问题

所有建议以 **diff 形式**展示，用户**确认后才写入**文件，不会直接修改代码。

### Agent 模式

> ![AI Agent](docs/images/ai-agent.png)

Agent 模式允许 AI 自主执行操作，支持以下工具：

| 工具 | 功能 |
|------|------|
| `read_file` | 读取文件内容 |
| `get_file_tree` | 获取项目目录树 |
| `search_files` | 按模式搜索文件 |
| `write_file` | 创建或覆盖文件 |
| `apply_edit` | 应用查找替换编辑 |
| `execute_shell` | 执行 Shell 命令 |

- Agent 最多执行 **10 轮** LLM 调用
- **用户确认机制**：写文件和编辑操作需确认
- **中止支持**：取消按钮立即停止 Agent 执行
- 所有操作用 `.lifeAiCode-agent-audit.log` 审计记录

### AI 修改确认

> ![AI 修改确认](docs/images/ai-diff-confirm.png)

接受 AI 建议前，弹出 **Diff 确认弹窗**：

- 并排对比原始代码和修改后代码
- 逐文件确认或拒绝
- 确保用户完全掌控代码变更

### 支持的 LLM 厂商

> ![AI 模型配置](docs/images/ai-settings.png)

| 厂商 | 标识 | API Base URL | 默认模型 |
|------|------|-------------|---------|
| OpenAI | `openai` | `https://api.openai.com/v1` | `gpt-4o` |
| Anthropic | `anthropic` | `https://api.anthropic.com/v1` | `claude-3-sonnet` |
| DeepSeek | `deepseek` | `https://api.deepseek.com` | `deepseek-v4-flash` |
| GLM (智谱) | `glm` | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-plus` |
| Qwen (千问) | `qwen` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| Ollama (本地) | `ollama` | `http://localhost:11434` | `deepseek-coder` |
| 自定义 | `custom` | 用户自填 | 自定义 |

**配置 API Key：**

可在 WebView 配置面板中添加，或通过环境变量设置：

```bash
export OPENAI_API_KEY="sk-..."
export DEEPSEEK_API_KEY="sk-..."
export ZHIPU_API_KEY="..."
export ANTHROPIC_API_KEY="sk-ant-..."
export DASHSCOPE_API_KEY="sk-..."
```

> **安全原则**：AI 以只读分析为主，所有代码修改必须用户确认后才写入文件。

---

## SSH 远程管理

> ![SSH 连接管理](docs/images/ssh-connections.png)
> ![SSH 远程文件树](docs/images/ssh-file-tree.png)

SSH 扩展提供远程服务器文件浏览和管理：

- **连接管理**：添加/编辑/删除 SSH 连接（支持密码和私钥认证）
- **远程文件树**：浏览远程目录结构
- **交互会话**：终端输出和命令输入
- **远程文件操作**：复制/移动/删除远程文件
- **远程剪贴板**：跨目录文件操作

```bash
# 构建 SSH 扩展
cd web/ssh && npm install && npm run build
```

---

## 扩展系统

IDEACODE 采用插件式架构，扩展可以注册命令、菜单、面板和视图容器。

### 已有扩展

| 扩展 | 源码目录 | 描述 |
|------|---------|------|
| **Git** | `web/git/` | Git 版本控制面板 |
| **SSH** | `web/ssh/` | SSH/SFTP 远程文件管理 |
| **LifeAiCode** | `web/lifeAiCode/` | AI 代码辅助工具 |

> ![扩展面板](docs/images/extensions.png)

### 扩展架构

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
      ├─ git/              ← Git 版本控制
      ├─ ssh/              ← SSH/SFTP 远程文件系统
      └─ lifeAiCode/       ← AI 代码辅助（构建产物）

主进程 (Electron main)
  ├─ main.cjs              ← 窗口管理/菜单
  └─ extensionHost.cjs     ← Extension Host 生命周期管理
```

---

## 设置面板

> ![设置面板](docs/images/settings-panel.png)

可通过左侧活动栏设置图标或快捷方式打开：

| 分类 | 配置项 |
|------|--------|
| 常用 | 语言切换 |
| 编辑器 | 字体大小、语义高亮、自动换行、迷你地图 |
| 外观 | 主题切换（浅色/深色/高对比度） |

---

## 状态栏

> ![状态栏](docs/images/status-bar.png)

底部状态栏提供实时开发信息：

- **左侧**：
  - Git 分支选择器（可点击切换/搜索/创建分支）
  - 问题计数（警告/错误数）
  - 文件路径显示（相对/绝对路径切换）
- **右侧**：
  - 系统资源监控（CPU / 内存 / GPU 使用率）
  - 行列号、编码格式
  - 语言模式选择器（手动切换文件语言）

---

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动 Web 开发服务器（浏览器访问） |
| `npm run build` | 生产构建（先构建扩展，再构建主应用） |
| `npm run preview` | 预览生产构建（浏览器） |
| `npm run lint` | ESLint 代码检查 |
| `npm run electron:dev` | **桌面开发模式**（热更新 + 自动 DevTools） |
| `npm run electron:preview` | **桌面生产预览**（打包后启动窗口） |

### 扩展构建

```bash
# 完整构建 LifeAiCode（extension-host + webview）
cd web/lifeAiCode && npm run build:all

# 仅构建 WebView
cd web/lifeAiCode && npm run build

# 构建 Git 扩展
cd web/git && npm install && npm run build

# 构建 SSH 扩展
cd web/ssh && npm install && npm run build
```

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
│   ├── utils/
│   │   └── algorithms/          # 高级算法（模糊搜索/缓存/预测）
│   └── i18n/                    # 国际化
├── web/                         # 扩展前端源码
│   ├── git/                     # Git 扩展前端（Vite + React）
│   ├── ssh/                     # SSH 扩展前端（Vite + React）
│   └── lifeAiCode/              # LifeAiCode 扩展前端（Vite + React）
├── extensions/                  # 扩展产物（构建生成，gitignored）
│   ├── git/                     # Git 扩展
│   ├── ssh/                     # SSH 扩展
│   └── lifeAiCode/              # LifeAiCode 扩展
├── docs/
│   └── images/                  # 截图资源
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

---

## 截图贡献指南

如需为项目贡献截图，请参考 [docs/images/README.md](docs/images/README.md) 中的截图规范和清单。推荐的截图步骤如下：

1. 运行 `npm run electron:dev` 启动桌面应用
2. 打开一个示例项目（推荐 React/TypeScript 项目以展示完整功能）
3. 按照清单逐个截取功能界面
4. 将截图保存为 PNG 格式，放入 `docs/images/` 目录
5. 提交 PR 时附带截图文件
