const { app } = require('electron');

// 抑制 Electron 安全警告与部分 DevTools CDP 无关错误
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
app.commandLine.appendSwitch('disable-features', 'AutofillServerCommunication,AutofillEnable');

const { WindowManager } = require('./main/windowManager.cjs');
const { TrayManager } = require('./main/tray.cjs');
const { LifecycleManager } = require('./main/lifecycle.cjs');
const { ExtensionHostManager } = require('./main/extensionHost.cjs');
const { HistoryManager } = require('./main/historyManager.cjs');
const { createAppMenu } = require('./main/appMenu.cjs');
const { registerIpcHandlers } = require('./main/ipcHandlers/index.cjs');
const { SystemMonitor } = require('./main/systemMonitor.cjs');

/**
 * IDEACODE 主进程入口
 * ============================================================================
 * 
 * 【主进程 (Main Process)】
 *   全局"管家"，负责窗口管理、菜单栏、系统托盘等原生集成。
 *   管理所有子进程（渲染进程、扩展宿主进程、Worker 线程）的生命周期。
 * 
 * 【渲染进程 (Renderer Process)】
 *   每个编辑器窗口对应一个独立的 Chromium 进程。
 *   负责页面渲染和交互，某个页面卡死不会影响其他窗口。
 * 
 * 【扩展宿主进程 (Extension Host Process)】
 *   独立的 Node.js 子进程，所有第三方插件在此运行。
 *   通过 JSON-RPC 协议与主进程通信，保证插件崩溃不会拖垮主界面。
 * 
 * 【Preload 脚本机制】
 *   在渲染进程加载页面之前执行，通过 contextBridge
 *   将精选的 Node.js 能力安全地暴露给 window.electronAPI。
 *   渲染进程无法直接访问 require('fs')，只能通过白名单 API 间接使用。
 * 
 * 【安全沙箱】
 *   - contextIsolation: true  // API 隔离
 *   - nodeIntegration: false   // 进程沙箱：Node.js 能力完全屏蔽
 *   - sandbox: true            // Chromium 沙箱
 * 
 * 【多进程模式 / 后台模式】
 *   耗时操作（文件监听、全文搜索）由 Worker 线程处理。
 *   窗口失焦时进入后台模式，文件监听等后台任务继续运行。
 * 
 * 【历史记录】
 *   最近打开的项目/文件夹路径持久化到用户数据目录：
 *   ~/Library/Application Support/IDEACODE/ideaCodeHistory.json (macOS)
 * ============================================================================
 */

// 1. 创建核心管理器
const windowManager = new WindowManager();
const trayManager = new TrayManager(windowManager);
const lifecycleManager = new LifecycleManager(windowManager, trayManager);
const extensionHostManager = new ExtensionHostManager(windowManager);
const historyManager = new HistoryManager();

// 2. 注册 IPC 处理器（必须在 app ready 之前完成）
registerIpcHandlers({ windowManager, extensionHostManager, historyManager });

// 3. 应用生命周期初始化
const canStart = lifecycleManager.init();
if (!canStart) return;

app.whenReady().then(() => {
  // 创建应用菜单
  createAppMenu();

  // 创建系统托盘
  trayManager.createTray();

  // 创建首个窗口
  windowManager.createWindow();

  // 启动系统资源监控，定期向所有窗口广播 CPU/GPU/内存使用率
  const systemMonitor = new SystemMonitor(windowManager, { intervalMs: 2000 });
  systemMonitor.start();

  // 启动扩展宿主进程（延迟启动，避免与应用启动竞争资源）
  setTimeout(() => {
    extensionHostManager.start();
  }, 2000);
});
