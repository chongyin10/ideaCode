const { ipcMain } = require('electron');
const { Channels } = require('../../shared/channels.cjs');

/**
 * 终端 BrowserView 视图层 IPC 处理器
 *
 * 负责：
 * 1. 响应主窗口对 BrowserView 的创建/销毁/定位/聚焦请求
 * 2. 维护每个窗口的广播模式状态
 * 3. 中转主窗口对终端页的搜索/清除选区等操作
 */
function registerTerminalViewHandlers(terminalViewManager) {
  /** @type {Map<import('electron').BrowserWindow, boolean>} */
  const broadcastModeByWindow = new Map();

  /**
   * 获取 ownerWindow，支持从 invoke 的 event.sender 推导
   * @param {import('electron').IpcMainInvokeEvent} event
   */
  function getOwnerWindow(event) {
    return terminalViewManager.getOwnerWindow(event.sender);
  }

  // 创建 BrowserView（通常由 terminalHandler 在创建 PTY 时自动调用，这里也保留显式入口）
  ipcMain.handle(Channels.TERMINAL_VIEW_CREATE, async (event, { terminalId }) => {
    const ownerWindow = getOwnerWindow(event);
    if (!ownerWindow) {
      return { success: false, error: '无法定位所属窗口' };
    }
    try {
      const view = await terminalViewManager.createView(ownerWindow, terminalId);
      return { success: true, viewId: view.webContents.id };
    } catch (error) {
      console.error('[TerminalViewHandler] 创建 view 失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 销毁 BrowserView
  ipcMain.handle(Channels.TERMINAL_VIEW_DESTROY, async (event, { terminalId }) => {
    const ownerWindow = getOwnerWindow(event);
    if (ownerWindow) {
      terminalViewManager.destroyView(ownerWindow, terminalId);
    }
    return { success: true };
  });

  // 设置 BrowserView 边界与显隐
  ipcMain.handle(Channels.TERMINAL_VIEW_SET_BOUNDS, async (event, { terminalId, bounds }) => {
    const ownerWindow = getOwnerWindow(event);
    if (ownerWindow) {
      terminalViewManager.setBounds(ownerWindow, terminalId, bounds);
    }
    return { success: true };
  });

  // 聚焦 BrowserView
  ipcMain.handle(Channels.TERMINAL_VIEW_FOCUS, async (event, { terminalId }) => {
    const ownerWindow = getOwnerWindow(event);
    if (ownerWindow) {
      terminalViewManager.focusView(ownerWindow, terminalId);
    }
    return { success: true };
  });

  // 终端页就绪通知（可用来刷新缓冲，当前仅作日志）
  ipcMain.on(Channels.TERMINAL_VIEW_READY, (event, { terminalId }) => {
    // terminalId 来自 URL query，主进程侧可通过 webContents.id 关联
    console.log(`[TerminalViewHandler] 终端页 ready: terminalId=${terminalId}`);
  });

  // 设置当前窗口的广播模式
  ipcMain.handle(Channels.TERMINAL_VIEW_SET_BROADCAST, async (event, { enabled }) => {
    const ownerWindow = getOwnerWindow(event);
    if (ownerWindow) {
      broadcastModeByWindow.set(ownerWindow, !!enabled);
    }
    return { success: true };
  });

  // 搜索
  ipcMain.handle(Channels.TERMINAL_VIEW_FIND, async (event, { terminalId, term, previous }) => {
    const ownerWindow = getOwnerWindow(event);
    const wc = ownerWindow ? terminalViewManager.getViewWebContents(ownerWindow, terminalId) : undefined;
    if (wc && !wc.isDestroyed()) {
      wc.send(Channels.TERMINAL_VIEW_FIND, { term, previous });
    }
    return { success: true };
  });

  // 清除选区
  ipcMain.handle(Channels.TERMINAL_VIEW_CLEAR_SELECTION, async (event, { terminalId }) => {
    const ownerWindow = getOwnerWindow(event);
    const wc = ownerWindow ? terminalViewManager.getViewWebContents(ownerWindow, terminalId) : undefined;
    if (wc && !wc.isDestroyed()) {
      wc.send(Channels.TERMINAL_VIEW_CLEAR_SELECTION, {});
    }
    return { success: true };
  });

  // 暴露给 terminalHandler 查询广播状态
  return {
    isBroadcastEnabled(window) {
      return !!broadcastModeByWindow.get(window);
    },
  };
}

module.exports = { registerTerminalViewHandlers };
