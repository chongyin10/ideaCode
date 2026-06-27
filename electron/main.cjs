// v8-compile-cache：将 V8 编译结果缓存到磁盘，大幅加快大型项目二次启动的模块加载速度。
// 必须在所有其他 require 之前调用，确保后续 require 的模块都走缓存。
require('v8-compile-cache');

const { app } = require('electron');
const { fixPath } = require('./main/utils/env.cjs');

// 先补全 PATH，确保后续子进程能找到用户安装的 git 等命令（macOS GUI 启动时尤为重要）
fixPath();

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
 * IDEACODE 主进程入口 (微内核架构)
 * ============================================================================
 *
 * 【架构演进】
 *   v1:  单体架构 — 所有 Manager 手动实例化，IPC Handler 分散注册
 *   v2:  微内核架构 — 引入 ServiceBus + 服务化拆分 (当前)
 *
 * 【微内核核心】
 *   1. ServiceBus: 统一消息总线，替代 channels.cjs 硬编码
 *   2. ServiceRegistry: 服务注册发现
 *   3. 服务适配器: 每个 IPC Handler 变为独立服务
 *
 * 【双轨策略】
 *   新旧两套系统并行运行，通过 feature flag 切换。
 *   默认使用旧系统（稳定），新系统可通过环境变量启用。
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
 * ============================================================================
 */

// ─── 微内核模式开关 ───
const useMicrokernel = process.env.IDEACODE_MICROKERNEL === '1';

// 1. 创建核心管理器
const windowManager = new WindowManager();
const trayManager = new TrayManager(windowManager);
const lifecycleManager = new LifecycleManager(windowManager, trayManager);
const extensionHostManager = new ExtensionHostManager(windowManager);
const historyManager = new HistoryManager();

// 2. 注册 IPC 处理器
if (useMicrokernel) {
  // 微内核模式：通过 ServiceBus 统一注册
  console.log('[Main] 启用微内核架构');
  try {
    const { Microkernel } = require('../packages/kernel/src/Microkernel.ts');
    // Note: TypeScript 需要编译后才能 require；在 transpiled 环境使用打包后的 CJS。
    // 作为一种渐进策略，这里先使用兼容桥接器。
    const { createElectronIpcBridge } = require('../packages/kernel/src/ipc/ElectronMainIpcBridge.cjs');
    
    // 创建简易 ServiceBus 模拟（在 CJS 环境中直接构造对象）
    const bus = createInlineServiceBus();
    createElectronIpcBridge(bus, { windowManager, extensionHostManager, historyManager });
    
    global.__kernel__ = { bus };
    console.log('[Main] 微内核初始化完成');
  } catch (err) {
    console.warn('[Main] 微内核初始化失败，回退到传统模式:', err.message);
    registerIpcHandlers({ windowManager, extensionHostManager, historyManager });
  }
} else {
  // 传统模式：维持原有 IPC 注册
  registerIpcHandlers({ windowManager, extensionHostManager, historyManager });
}

/**
 * 创建内联 ServiceBus（轻量版，用于 CJS 环境）
 * 保持与现有代码的兼容性，同时提供微内核能力
 */
function createInlineServiceBus() {
  const handlers = new Map();
  const topicSubs = new Map();
  let reqId = 0;
  const pending = new Map();

  return {
    handle(method, handler) {
      handlers.set(method, handler);
    },
    removeHandler(method) {
      return handlers.delete(method);
    },
    async request(service, method, params) {
      const fullMethod = `${service}:${method}`;
      const h = handlers.get(fullMethod);
      if (h) return h(params);
      throw new Error(`Method not found: ${fullMethod}`);
    },
    publish(topic, data) {
      const subs = topicSubs.get(topic);
      if (subs) {
        for (const fn of subs) { try { fn(data); } catch (e) { /* ignore */ } }
      }
    },
    subscribe(topic, handler) {
      if (!topicSubs.has(topic)) topicSubs.set(topic, new Set());
      topicSubs.get(topic).add(handler);
      return { dispose: () => topicSubs.get(topic)?.delete(handler) };
    },
    notify(service, method, params) {
      // fire-and-forget
      const fullMethod = `${service}:${method}`;
      const h = handlers.get(fullMethod);
      if (h) h(params).catch(() => {});
    },
    registerService(manifest, instance) {},
    unregisterService(id) {},
    getService(id) { return undefined; },
    invokeLocal(method, params) {
      const h = handlers.get(method);
      if (h) return h(params);
      throw new Error(`Local handler not found: ${method}`);
    },
  };
}

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
