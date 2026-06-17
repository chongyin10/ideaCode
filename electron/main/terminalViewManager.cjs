const { BrowserView, BrowserWindow } = require('electron');
const path = require('path');

const isDev = process.env.VITE_DEV_SERVER_URL !== undefined;

/**
 * 终端 BrowserView 管理器
 *
 * 为每个终端进程维护一个独立的 BrowserView，加载 terminal.html。
 * 主窗口 React 只负责提供占位 div 的坐标；本管理器负责把 BrowserView
 * 定位到对应位置，并在切换/关闭/窗口销毁时进行显隐/清理。
 */
class TerminalViewManager {
  constructor() {
    /** @type {Map<import('electron').BrowserWindow, Map<number, import('electron').BrowserView>>} */
    this.views = new Map();
  }

  /**
   * 为指定窗口创建终端 BrowserView
   * @param {import('electron').BrowserWindow} ownerWindow
   * @param {number} terminalId
   * @returns {Promise<import('electron').BrowserView>}
   */
  async createView(ownerWindow, terminalId) {
    if (!ownerWindow || ownerWindow.isDestroyed()) {
      throw new Error('[TerminalViewManager] ownerWindow 无效');
    }

    const windowViews = this._getWindowViews(ownerWindow);
    if (windowViews.has(terminalId)) {
      return windowViews.get(terminalId);
    }

    const view = new BrowserView({
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        sandbox: true,
      },
    });

    view.setBackgroundColor('#1e1e1e');
    view.setAutoResize({ width: false, height: false });

    ownerWindow.addBrowserView(view);
    windowViews.set(terminalId, view);

    // 初始隐藏：bounds 置 0，避免创建时闪烁
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });

    const loadUrl = this._getTerminalUrl(terminalId);
    await view.webContents.loadURL(loadUrl);

    // 窗口关闭时兜底清理
    const onClose = () => this.destroyWindowViews(ownerWindow);
    if (!ownerWindow._terminalViewCloseHooked) {
      ownerWindow._terminalViewCloseHooked = true;
      ownerWindow.once('closed', onClose);
    }

    return view;
  }

  /**
   * 销毁指定终端 BrowserView
   * @param {import('electron').BrowserWindow} ownerWindow
   * @param {number} terminalId
   */
  destroyView(ownerWindow, terminalId) {
    if (!ownerWindow || ownerWindow.isDestroyed()) return;
    const windowViews = this.views.get(ownerWindow);
    if (!windowViews) return;
    const view = windowViews.get(terminalId);
    if (!view) return;

    try {
      ownerWindow.removeBrowserView(view);
      view.webContents.destroy();
    } catch (e) {
      console.warn(`[TerminalViewManager] 销毁 view ${terminalId} 失败:`, e.message);
    }
    windowViews.delete(terminalId);
    if (windowViews.size === 0) {
      this.views.delete(ownerWindow);
    }
  }

  /**
   * 设置 BrowserView 的坐标与显隐
   * @param {import('electron').BrowserWindow} ownerWindow
   * @param {number} terminalId
   * @param {object} bounds
   * @param {number} bounds.x
   * @param {number} bounds.y
   * @param {number} bounds.width
   * @param {number} bounds.height
   * @param {boolean} bounds.visible
   */
  setBounds(ownerWindow, terminalId, bounds) {
    const view = this._getView(ownerWindow, terminalId);
    if (!view) return;

    const { x = 0, y = 0, width = 0, height = 0, visible = false } = bounds;
    if (visible && width > 0 && height > 0) {
      view.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });
    } else {
      // 隐藏：bounds 置 0，避免覆盖其他 UI
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }
  }

  /**
   * 聚焦指定 BrowserView
   * @param {import('electron').BrowserWindow} ownerWindow
   * @param {number} terminalId
   */
  focusView(ownerWindow, terminalId) {
    const view = this._getView(ownerWindow, terminalId);
    if (view && !view.webContents.isDestroyed()) {
      view.webContents.focus();
    }
  }

  /**
   * 销毁某个窗口下的全部终端 BrowserView
   * @param {import('electron').BrowserWindow} ownerWindow
   */
  destroyWindowViews(ownerWindow) {
    if (!ownerWindow || ownerWindow.isDestroyed()) return;
    const windowViews = this.views.get(ownerWindow);
    if (!windowViews) return;
    for (const [terminalId, view] of windowViews) {
      try {
        ownerWindow.removeBrowserView(view);
        view.webContents.destroy();
      } catch (e) {
        console.warn(`[TerminalViewManager] 销毁窗口 view ${terminalId} 失败:`, e.message);
      }
    }
    windowViews.clear();
    this.views.delete(ownerWindow);
  }

  /**
   * 获取指定 BrowserView 的 webContents
   * @param {import('electron').BrowserWindow} ownerWindow
   * @param {number} terminalId
   * @returns {import('electron').WebContents | undefined}
   */
  getViewWebContents(ownerWindow, terminalId) {
    const view = this._getView(ownerWindow, terminalId);
    return view && !view.webContents.isDestroyed() ? view.webContents : undefined;
  }

  /**
   * 根据 webContents 反向查找所属窗口（用于 IPC 中定位 ownerWindow）
   * @param {import('electron').WebContents} webContents
   * @returns {import('electron').BrowserWindow | undefined}
   */
  getOwnerWindow(webContents) {
    return BrowserWindow.fromWebContents(webContents);
  }

  /**
   * 根据 terminalId 查找已存在的 view（不区分窗口）
   * @param {number} terminalId
   * @returns {{ window: import('electron').BrowserWindow, view: import('electron').BrowserView } | undefined}
   */
  findViewByTerminalId(terminalId) {
    for (const [win, windowViews] of this.views) {
      const view = windowViews.get(terminalId);
      if (view) return { window: win, view };
    }
    return undefined;
  }

  /* ─── 私有辅助 ─── */

  _getWindowViews(ownerWindow) {
    if (!this.views.has(ownerWindow)) {
      this.views.set(ownerWindow, new Map());
    }
    return this.views.get(ownerWindow);
  }

  _getView(ownerWindow, terminalId) {
    if (!ownerWindow || ownerWindow.isDestroyed()) return undefined;
    return this.views.get(ownerWindow)?.get(terminalId);
  }

  _getTerminalUrl(terminalId) {
    if (isDev) {
      const base = process.env.VITE_DEV_SERVER_URL;
      return `${base}terminal.html?id=${terminalId}`;
    }
    const filePath = path.join(__dirname, '..', '..', 'dist', 'terminal.html');
    return `file://${filePath}?id=${terminalId}`;
  }
}

module.exports = { TerminalViewManager };
