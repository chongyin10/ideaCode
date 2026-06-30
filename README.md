# IDEACODE

基于 **React + TypeScript + Vite + Monaco Editor + Electron** 构建的轻量级桌面 IDE。

![React](https://img.shields.io/badge/React-18.3-61DAFB?logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?logo=typescript)
![Vite](https://img.shields.io/badge/Vite-5.4-646CFF?logo=vite)
![Electron](https://img.shields.io/badge/Electron-30-47848F?logo=electron)

> ![整体界面](docs/images/overview-dark.png)

---

## 基础功能

除了上述差异化特性，IDEACODE 也提供了标准 IDE 的核心能力：

| 功能 | 说明 |
|------|------|
| 📁 **文件管理** | 完整的文件树，支持创建/重命名/删除/拖拽/剪切板操作 |
| ✏️ **代码编辑** | Monaco Editor 核心，50+ 语言高亮、TS 语义着色、Cmd+Click 跳转定义 |
| 📑 **分屏编辑** | 多编辑器组并排，标签页拖拽排序，标签历史导航 |
| 🔍 **全局搜索** | 正则/整词/大小写/模糊全文搜索，按文件分组可折叠结果 |
| 🌿 **Git 集成** | 暂存/提交/推送/拉取，分支管理，Diff 对比 |
| 🔗 **SSH 远程管理** | SSH/SFTP 连接管理、远程文件树、交互会话 |
| 🎨 **主题** | 浅色/深色/高对比度，字体大小可调 |
| 🌍 **i18n** | 中/英多语言支持 |

---

## 整体布局

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
│  StatusBar（Git分支/语言/行列号/CPU/内存/GPU）    │
└─────────────────────────────────────────────────┘
```

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
| xterm.js + node-pty | 内置终端 + 伪终端 |
| i18next | 国际化 |

---

## 环境要求

- **Node.js** >= 18.12.0
- **npm** >= 9.0
- **操作系统**：macOS / Windows / Linux（需图形界面）

---

## 快速开始

```bash
# 安装依赖
npm install

# 浏览器 Web 版（热更新）
npm run dev

# 桌面开发模式（推荐，Electron 热更新 + DevTools）
npm run electron:dev

# 桌面生产预览
npm run electron:preview
```

> 国内网络安装 Electron 慢时，可使用镜像：
> ```bash
> ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
> ```

---

## 扩展系统

IDEACODE 采用插件式架构，扩展在独立的 Extension Host 子进程中运行，通过 JSON-RPC 与渲染进程通信。

| 扩展 | 目录 | 说明 |
|------|------|------|
| **Git** | `web/git/` | Git 版本控制面板 |
| **SSH** | `web/ssh/` | SSH/SFTP 远程文件管理 |
| **LifeAiCode** | `web/lifeAiCode/` | AI 代码辅助（多 LLM + Agent） |

```bash
# 构建所有扩展
cd web/lifeAiCode && npm run build:all
cd web/git && npm install && npm run build
cd web/ssh && npm install && npm run build
```

---

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | Web 开发服务器 |
| `npm run build` | 生产构建 |
| `npm run preview` | 浏览器预览生产构建 |
| `npm run lint` | ESLint 检查 |
| `npm run electron:dev` | **桌面开发模式**（推荐） |
| `npm run electron:preview` | 桌面生产预览 |

---

## 项目结构

```
ideacode/
├── electron/                     # Electron 主进程
│   ├── main.cjs                  # 窗口管理、菜单
│   ├── preload.cjs               # 安全 IPC 桥接
│   └── extension-host/           # Extension Host RPC
├── src/                          # 渲染进程（IDE 主体）
│   ├── components/               # UI 组件（ActivityBar/Monaco/TabBar/…）
│   ├── store/slices/             # Redux 状态切片
│   ├── plugin/                   # 插件系统 + 扩展桥接
│   ├── services/                 # 文件/终端/Git 服务层
│   ├── utils/algorithms/         # 高级算法（BCM/PageRank/Bandit/FM-Index/…）
│   └── i18n/                     # 国际化
├── web/                          # 扩展前端源码
│   ├── git/
│   ├── ssh/
│   └── lifeAiCode/
├── extensions/                   # 扩展构建产物（gitignored）
├── docs/images/                  # 截图资源
├── package.json
└── vite.config.ts
```

---

## 已知问题

1. **Monaco Editor 首次加载**：核心资源较大，首次打开文件可能有短暂等待（已做预加载优化）
2. **File System Access API 兼容性**：Safari 不支持，建议使用 Electron 桌面端
3. **无头服务器限制**：Electron 需要图形界面环境

---

## 截图贡献

截图清单和截取方法详见 → [docs/images/README.md](docs/images/README.md)

贡献步骤：
1. `npm run electron:dev` 启动桌面应用
2. 打开一个 React/TypeScript 示例项目
3. 按清单截取各功能界面（推荐 PNG / 1920×1080）
4. 将截图放入 `docs/images/` 目录
5. 提交 PR

### 版权声明 / License
1. 本项目代码仅供个人学习、研究或非商业用途使用
- ✅ 允许：查看源码、个人学习研究、非商业性质的交流
- ❌ 禁止：未经书面授权，严禁将本项目用于任何商业用途（包括但不限于作为商业产品的一部分、出售、出租、或用于企业内部盈利性项目
- 如需商业授权或合作，请联系：📧 mailto:chongyin_good@163.com | mailto:mimicy710@gmail.com

```
⚠️ Legal Notice: All Rights Reserved. Unauthorized commercial use is strictly prohibited and will be subject to legal action.
```