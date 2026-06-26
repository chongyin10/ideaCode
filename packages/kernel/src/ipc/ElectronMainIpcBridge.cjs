/**
 * Electron 主进程 IPC 桥接器
 *
 * 将 ServiceBus 连接到 Electron 的 ipcMain，作为微内核在 Electron 环境中的 IPC 适配器。
 * 替代原有的 registerIpcHandlers() 分散注册方式。
 *
 * 使用方式：
 *   const { createElectronIpcBridge } = require('@ideacode/kernel/ipc');
 *   const bridge = createElectronIpcBridge(kernel.bus, { windowManager, extensionHostManager, historyManager });
 */

const { ipcMain, BrowserWindow } = require('electron');
const { Channels } = require('../../../electron/shared/channels.cjs');

/**
 * @typedef {import('../../../electron/main/windowManager.cjs').WindowManager} WindowManager
 * @typedef {import('../../../electron/main/extensionHost.cjs').ExtensionHostManager} ExtensionHostManager
 * @typedef {import('../../../electron/main/historyManager.cjs').HistoryManager} HistoryManager
 */

/**
 * 创建 Electron 主进程 IPC 桥接器
 *
 * 在 ServiceBus 和 Electron IPC 之间建立双向映射：
 * - ipcMain.handle('ns:method') → bus.handle('ns.method', handler)
 * - bus.publish(topic, data) → windowManager.broadcast(topic, data)
 *
 * @param {object} bus - ServiceBus 实例 (具有 handle/publish/subscribe 方法)
 * @param {object} deps
 * @param {WindowManager} deps.windowManager
 * @param {ExtensionHostManager} deps.extensionHostManager
 * @param {HistoryManager} deps.historyManager
 */
function createElectronIpcBridge(bus, deps) {
  const { windowManager, extensionHostManager, historyManager } = deps;

  if (!bus || !bus.handle) {
    throw new Error('[ElectronIpcBridge] 需要 ServiceBus 实例');
  }

  // =====================================================
  // 向 ServiceBus 注册主进程端处理器
  // =====================================================

  // ─── 对话框 ───
  bus.handle('dialog.openDirectory', async () => {
    const { dialog } = require('electron');
    const focused = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(focused || BrowserWindow.getAllWindows()[0], {
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  bus.handle('dialog.openFile', async (params) => {
    const { dialog } = require('electron');
    const focused = BrowserWindow.getFocusedWindow();
    const opts = { properties: ['openFile'] };
    if (params?.filters) opts.filters = params.filters;
    const result = await dialog.showOpenDialog(focused || BrowserWindow.getAllWindows()[0], opts);
    return result.canceled ? null : result.filePaths[0];
  });

  bus.handle('dialog.saveFile', async (params) => {
    const { dialog } = require('electron');
    const focused = BrowserWindow.getFocusedWindow();
    const opts = {};
    if (params?.defaultPath) opts.defaultPath = params.defaultPath;
    if (params?.filters) opts.filters = params.filters;
    const result = await dialog.showSaveDialog(focused || BrowserWindow.getAllWindows()[0], opts);
    return result.canceled ? null : result.filePath;
  });

  // ─── 文件系统 ───
  const { registerFsHandlersByBus } = require('./FsHandlersByBus.cjs');
  registerFsHandlersByBus(bus);

  // ─── 窗口管理 ───
  if (windowManager) {
    bus.handle('window.create', (params) => {
      windowManager.createWindow(params?.path);
    });

    ipcMain.on(Channels.WINDOW_FOCUS, () => {
      bus.publish('window:focus', {});
    });

    ipcMain.on(Channels.WINDOW_BLUR, () => {
      bus.publish('window:blur', {});
    });
  }

  // ─── 扩展宿主 ───
  if (extensionHostManager) {
    // 启动/停止
    bus.handle('extensionHost.start', () => extensionHostManager.start());

    bus.handle('extensionHost.stop', () => {
      extensionHostManager.stop();
      return { stopped: true };
    });

    // RPC 转发
    bus.handle('extensionHost.rpc', async (params) => {
      const { method, params: rpcParams } = params || {};
      return extensionHostManager.sendRpc(method, rpcParams);
    });

    // 安装/卸载
    bus.handle('extension.install', (params) => {
      const { extPath } = params || {};
      // 通过 install handler 处理
      return { success: true };
    });

    bus.handle('extension.uninstall', (params) => {
      const { extPath } = params || {};
      return { success: true };
    });
  }

  // ─── 历史记录 ───
  if (historyManager) {
    bus.handle('history.getRecent', () => historyManager.getRecent());

    bus.handle('history.addRecent', (params) => {
      const { path } = params || {};
      historyManager.addRecent(path);
      return { added: true };
    });

    bus.handle('history.removeRecent', (params) => {
      const { path } = params || {};
      historyManager.removeRecent(path);
      return { removed: true };
    });

    bus.handle('history.clearAll', () => {
      historyManager.clearAll();
      return { cleared: true };
    });
  }

  // ─── 广播桥接 ───
  // 将 ServiceBus 的 publish 连接为 windowManager.broadcast
  const originalPublish = bus.publish.bind(bus);
  bus.publish = function (topic, data) {
    // 先执行原有的 ServiceBus publish (通知同进程订阅者)
    originalPublish(topic, data);

    // 再广播到所有渲染进程窗口
    if (windowManager && typeof windowManager.broadcast === 'function') {
      windowManager.broadcast(topic, data);
    }
  };

  // =====================================================
  // 将已注册的 IPC handler 通道映射到 ServiceBus
  // =====================================================

  // 为所有已知 IPC 通道建立桥接
  // 渲染进程的 ipcRenderer.invoke(channel, ...args)
  // → bus.request(service, method, params)

  /**
   * 桥接一个 IPC 通道到 ServiceBus handler
   */
  function bridgeChannel(channel, serviceMethod) {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        const params = args.length === 1 ? args[0] : args;
        return await bus.request(
          serviceMethod.split(':')[0],
          serviceMethod.split(':')[1],
          params
        );
      } catch (err) {
        console.error(`[ElectronIpcBridge] ${channel} 错误:`, err.message);
        throw err;
      }
    });
  }

  // 建立通道映射
  const channelMap = {
    // fs
    [Channels.FS_READ_DIR]: 'fs:readDir',
    [Channels.FS_READ_FILE]: 'fs:readFile',
    [Channels.FS_WRITE_FILE]: 'fs:writeFile',
    [Channels.FS_STAT]: 'fs:stat',
    [Channels.FS_WATCH]: 'fs:watch',
    [Channels.FS_UNWATCH]: 'fs:unwatch',
    [Channels.FS_CREATE_FILE]: 'fs:createFile',
    [Channels.FS_CREATE_DIR]: 'fs:createDir',
    [Channels.FS_DELETE]: 'fs:delete',
    [Channels.FS_RENAME]: 'fs:rename',
    [Channels.FS_COPY]: 'fs:copy',
    [Channels.FS_REVEAL]: 'fs:reveal',
    // dialog
    [Channels.DIALOG_OPEN_DIRECTORY]: 'dialog:openDirectory',
    [Channels.DIALOG_OPEN_FILE]: 'dialog:openFile',
    [Channels.DIALOG_SAVE_FILE]: 'dialog:saveFile',
    // extension
    [Channels.EXTENSION_HOST_START]: 'extensionHost:start',
    [Channels.EXTENSION_HOST_STOP]: 'extensionHost:stop',
    [Channels.EXTENSION_HOST_RPC]: 'extensionHost:rpc',
    [Channels.EXTENSION_INSTALL]: 'extension:install',
    [Channels.EXTENSION_UNINSTALL]: 'extension:uninstall',
  };

  for (const [channel, method] of Object.entries(channelMap)) {
    bridgeChannel(channel, method);
  }

  console.log('[ElectronIpcBridge] 已桥接', Object.keys(channelMap).length, '个 IPC 通道');
  console.log('[ElectronIpcBridge] 微内核 IPC 桥接器已就绪');
}

module.exports = { createElectronIpcBridge };
