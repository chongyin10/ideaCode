# IDEACODE

基于 **React + TypeScript + Vite + Monaco Editor + Electron** 构建的轻量级桌面 IDE，界面风格参考 VS Code，支持本地文件浏览、多标签页代码编辑和文件系统操作。

![IDEACODE](https://img.shields.io/badge/IDEACODE-Editor-blue)
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
| React Router v6 | 路由管理 |
| File System Access API | 浏览器端本地文件读写 |

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

---

### 2. 本地运行（浏览器 Web 版）

适用于快速预览 UI 和组件调试，通过浏览器访问：

```bash
npm run dev
```

启动后打开浏览器访问 `http://localhost:5173`。

**注意**：浏览器 Web 版打开本地文件夹时，会使用 File System Access API 弹出系统文件选择器。

---

### 3. 桌面运行（Electron 开发模式）

推荐日常开发方式。一键启动 **Vite 热更新 + Electron 桌面窗口**，代码修改后窗口自动刷新，并**自动打开 DevTools**：

```bash
npm run electron:dev
```

执行流程：
1. 启动 Vite dev server（`http://localhost:5173`）
2. 启动 Electron 桌面窗口并加载该地址
3. 自动打开 Chrome DevTools
4. 按 `Ctrl + C` 一键关闭两者

---

### 4. 桌面运行（生产预览）

打包 React 应用并以纯桌面窗口运行（无浏览器、无地址栏）：

```bash
npm run electron:preview
```

该命令会先执行 `vite build`，然后启动 Electron 加载本地打包文件。

---

## 常用脚本

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动 Web 开发服务器（浏览器访问） |
| `npm run build` | 生产构建（输出到 `dist/`） |
| `npm run preview` | 预览生产构建（浏览器） |
| `npm run lint` | ESLint 代码检查 |
| `npm run electron:dev` | **桌面开发模式**（热更新 + 自动 DevTools） |
| `npm run electron:preview` | **桌面生产预览**（打包后启动窗口） |

---

## 调试指南

### 在 VSCode 中调试

项目已内置调试配置（`.vscode/launch.json`），支持两种调试场景：

#### 调试主进程（Node.js）

1. 打开 VSCode 左侧「运行和调试」面板（`Ctrl+Shift+D` / `Cmd+Shift+D`）
2. 选择配置 `Debug: Main Process`
3. 按 `F5` 启动
4. 在 `electron/main.cjs` 中打断点即可命中

#### 调试渲染进程（React 页面）

1. 先启动桌面窗口：`npm run electron:dev`
2. 回到 VSCode，选择配置 `Debug: Renderer Process`
3. 按 `F5` attach
4. 在任意 `src/**/*.tsx` 文件中打断点即可命中

### 手动调试命令

```bash
# 单独启动 Vite（终端 1）
npm run dev

# 单独启动 Electron 并连接 dev server（终端 2）
VITE_DEV_SERVER_URL=http://localhost:5173 npx electron electron/main.cjs
```

---

## 项目结构

```
ideacode/
├── electron/                 # Electron 主进程
│   ├── main.cjs              # 主进程入口（窗口管理、菜单）
│   └── preload.cjs           # 预加载脚本（安全桥接）
├── scripts/
│   └── electron-dev.mjs      # 桌面开发模式一键启动脚本
├── src/
│   ├── components/           # UI 组件
│   │   ├── ActivityBar/      # 左侧活动栏
│   │   ├── MonacoEditor/     # 代码编辑器封装
│   │   ├── SidePanel/        # 侧边文件树面板
│   │   ├── StatusBar/        # 底部状态栏
│   │   ├── TabBar/           # 编辑器标签页
│   │   └── TopBar/           # 顶部标题栏
│   ├── context/
│   │   └── WorkspaceContext.tsx   # 全局工作区状态
│   ├── hooks/
│   │   └── useLayout.ts      # 布局状态管理
│   ├── pages/
│   │   └── Home.tsx          # IDE 工作台主页
│   ├── router/
│   │   └── index.tsx         # 路由配置
│   ├── services/
│   │   └── fileService.ts    # 文件系统服务封装
│   ├── types/
│   │   ├── electron.d.ts     # Electron API 类型
│   │   └── fs-api.d.ts       # File System Access API 类型
│   ├── App.tsx               # 根布局组件
│   ├── main.tsx              # 应用入口
│   └── index.css             # 全局样式
├── dist/                     # 生产构建输出（自动生成）
├── index.html
├── package.json
├── vite.config.ts
├── tsconfig.json
└── README.md
```

---

## 已知问题

1. **Monaco Editor 首次加载**：编辑器核心资源较大，首次打开文件时可能需要短暂等待（已做预加载优化）。
2. **File System Access API 兼容性**：部分浏览器（如 Safari）不支持该 API，建议通过 Electron 桌面端使用以获得最佳体验。
3. **无头服务器无法启动 Electron**：当前配置在纯命令行服务器环境中无法弹出 GUI 窗口，需在带有图形界面的操作系统上运行。

---

## 后续可扩展方向

- [ ] 将文件读写切换为 Electron Node.js IPC（无需弹窗授权）
- [ ] 最近打开项目列表与持久化
- [ ] 系统托盘 / 全局快捷键
- [ ] 编辑器主题切换与设置面板
- [ ] 插件系统雏形
