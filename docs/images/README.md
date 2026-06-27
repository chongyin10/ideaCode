# 截图指南

本目录存放 IDEACODE 的功能截图。截图建议使用 **Electron 桌面开发模式** 运行应用后截取。

## 截图规范

- 格式：**PNG**（无损压缩）
- 分辨率：窗口宽度 **1400px** 以上，推荐 1920×1080
- 主题：建议同时提供 **浅色主题** 和 **深色主题** 版本（深色主题为首选）
- 文件名：小写英文，连字符分隔

## 截图清单

| 文件名 | 内容 | 说明 |
|--------|------|------|
| `overview-dark.png` | IDE 整体界面 | 打开一个项目的完整界面（深色主题） |
| `overview-light.png` | IDE 整体界面 | 同上（浅色主题） |
| `file-explorer.png` | 文件浏览器 | 左侧文件树展开状态，显示右键菜单 |
| `code-editor.png` | 代码编辑器 | Monaco Editor 编辑窗口，展示语法高亮和代码补全 |
| `split-editor.png` | 分屏编辑 | 两个编辑器并排显示不同文件 |
| `terminal.png` | 内置终端 | 底部终端面板，显示命令执行效果 |
| `git-panel.png` | Git 版本控制 | 侧边栏 Git 面板，显示变更文件列表 |
| `git-diff.png` | Git 差异对比 | Diff 编辑器展示代码变更 |
| `search-replace.png` | 搜索与替换 | 全局搜索面板，展示搜索结果 |
| `quick-open.png` | 快速打开 | Ctrl+P 快速文件搜索弹窗 |
| `ai-chat.png` | AI 对话面板 | LifeAiCode 聊天界面（右侧面板） |
| `ai-code-review.png` | AI 代码审查 | AI 分析代码并给出建议 |
| `ai-agent.png` | AI Agent 模式 | Agent 自动执行工具调用 |
| `ai-diff-confirm.png` | AI 修改确认 | 接受 AI 建议前的差异对比弹窗 |
| `ai-settings.png` | AI 模型配置 | LLM 厂商配置面板 |
| `ssh-connections.png` | SSH 连接管理 | SSH 扩展的连接和会话管理界面 |
| `ssh-file-tree.png` | SSH 远程文件树 | 远程服务器文件浏览界面 |
| `settings-panel.png` | 设置面板 | 编辑器/外观设置界面 |
| `status-bar.png` | 状态栏 | 底部状态栏特写 |
| `extensions.png` | 扩展面板 | ActivityBar 扩展图标和扩展列表 |

## 截取方式

### macOS
1. 运行 `npm run electron:dev` 启动桌面应用
2. **全屏截图**：`Cmd + Shift + 3`
3. **窗口截图**：`Cmd + Shift + 4`，然后按 `Space` 点击窗口
4. **区域截图**：`Cmd + Shift + 4`，拖拽选择区域

### Windows
1. 运行 `npm run electron:dev` 启动桌面应用
2. **全屏截图**：`PrtScn`
3. **窗口截图**：`Alt + PrtScn`
4. **区域截图**：`Win + Shift + S`

### Linux
1. 运行 `npm run electron:dev` 启动桌面应用
2. 使用 `gnome-screenshot` 或 `flameshot` 工具
