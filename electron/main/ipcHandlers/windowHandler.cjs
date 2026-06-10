const { ipcMain, BrowserWindow } = require('electron');
const { Channels } = require('../../shared/channels.cjs');

/**
 * 窗口管理 IPC 处理器
 * 
 * 渲染进程可以通过 IPC 请求主进程管理窗口状态。
 * 每个窗口都是独立的渲染进程，窗口间互不影响。
 */
function registerWindowHandlers(windowManager) {
  // 创建新窗口
  ipcMain.handle(Channels.WINDOW_CREATE, (_event, options = {}) => {
    const { windowId } = windowManager.createWindow(options);
    return { windowId, success: true };
  });

  // 关闭当前窗口
  ipcMain.handle(Channels.WINDOW_CLOSE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.close();
    }
    return { success: true };
  });

  // 最小化当前窗口
  ipcMain.handle(Channels.WINDOW_MINIMIZE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.minimize();
    }
    return { success: true };
  });

  // 最大化/恢复当前窗口
  ipcMain.handle(Channels.WINDOW_MAXIMIZE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
    }
    return { success: true };
  });

  // 恢复当前窗口
  ipcMain.handle(Channels.WINDOW_RESTORE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.restore();
    }
    return { success: true };
  });

  // 获取当前窗口 ID
  ipcMain.handle('window:getCurrentId', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win ? win.id : null;
  });
}

module.exports = { registerWindowHandlers };
