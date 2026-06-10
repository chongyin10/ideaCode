const { app } = require('electron');

/**
 * 应用生命周期管理器
 * 
 * 职责：
 * 1. 管理应用的启动、退出、重启流程
 * 2. 处理 macOS dock 点击、Windows/Linux 单实例锁
 * 3. 崩溃恢复与优雅关闭
 */
class LifecycleManager {
  constructor(windowManager, trayManager) {
    this.windowManager = windowManager;
    this.trayManager = trayManager;
    this.isQuitting = false;
  }

  init() {
    // Windows/Linux 单实例锁：防止多个应用实例同时运行
    const gotTheLock = app.requestSingleInstanceLock();
    if (!gotTheLock) {
      console.log('[Lifecycle] 应用已在运行，退出新实例');
      app.quit();
      return false;
    }

    // 第二个实例尝试启动时，聚焦到第一个实例的窗口
    app.on('second-instance', (_event, _argv, _workingDirectory) => {
      const wins = this.windowManager.getAllWindows();
      if (wins.length > 0) {
        const win = wins[0];
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    });

    // macOS: dock 点击时恢复窗口
    app.on('activate', () => {
      if (this.windowManager.getWindowCount() === 0) {
        this.windowManager.createWindow();
      }
    });

    // 所有窗口关闭时的行为
    app.on('window-all-closed', () => {
      // macOS: 保持应用在后台运行（dock 图标仍在）
      if (process.platform !== 'darwin') {
        this.quit();
      }
    });

    // 应用即将退出
    app.on('before-quit', () => {
      this.isQuitting = true;
    });

    // 应用退出
    app.on('will-quit', () => {
      this.trayManager?.destroy();
    });

    return true;
  }

  quit() {
    this.isQuitting = true;
    this.windowManager.closeAllWindows();
    app.quit();
  }

  relaunch() {
    app.relaunch();
    this.quit();
  }
}

module.exports = { LifecycleManager };
