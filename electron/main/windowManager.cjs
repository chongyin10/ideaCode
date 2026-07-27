const { BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const { Channels } = require('../shared/channels.cjs');

const isDev = process.env.VITE_DEV_SERVER_URL !== undefined;

/**
 * 获取构建资源目录下的图标路径
 * - 开发环境：相对于 electron/main/windowManager.cjs -> ../../build
 * - 生产环境：electron-builder 将 buildResources 复制到 process.resourcesPath
 */
function getBuildResourcePath(...segments) {
  if (isDev) {
    return path.join(__dirname, '..', '..', 'build', ...segments);
  }
  return path.join(process.resourcesPath, ...segments);
}

/**
 * 窗口管理器 - 多窗口生命周期管理
 * 
 * 每个编辑器窗口都是一个独立的 Chromium 渲染进程：
 * - 某个页面卡死不会影响其他窗口
 * - 每个窗口拥有独立的 JavaScript 执行环境和内存空间
 * - 通过 IPC 与主进程通信，无法直接访问操作系统 API
 */
class WindowManager {
  constructor() {
    /** @type {Map<number, BrowserWindow>} */
    this.windows = new Map();
    /** @type {number} */
    this.windowIdCounter = 0;
  }

  /**
   * 创建新窗口
   * @param {object} options
   * @param {string} [options.title]
   * @param {string} [options.route] - React Router 路由路径
   */
  createWindow(options = {}) {
    const windowId = ++this.windowIdCounter;
    const { title = 'IDEACODE', route = '/' } = options;

    // 应用窗口图标：Windows/Linux 显示在标题栏/任务栏；macOS 使用 .app 图标
    // Windows 优先使用多尺寸 .ico，Linux 使用 .png
    const appIconName = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
    const appIcon = nativeImage.createFromPath(getBuildResourcePath(appIconName));

    const win = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 800,
      minHeight: 600,
      title,
      show: false,
      icon: appIcon,
      // 自定义标题栏：macOS 隐藏标题栏背景保留交通灯；Win/Linux 完全无边框
      titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
      frame: process.platform !== 'darwin',
      trafficLightPosition: process.platform === 'darwin' ? { x: 13, y: 11 } : undefined,
      webPreferences: {
        // Preload 脚本机制：在页面脚本执行前先加载，建立安全桥接
        preload: path.join(__dirname, '..', 'preload.cjs'),
        // 安全沙箱：渲染进程内的 Node.js 能力被完全屏蔽
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        enableRemoteModule: false,
        // 启用 Chromium 内置插件（PDFium PDF 查看器），供 PdfViewer 的 iframe 渲染 PDF
        plugins: true,
        // 启用进程沙箱（Electron 20+ 默认开启）
        sandbox: true,
      },
    });

    // 窗口就绪后再显示，避免白屏闪烁
    win.once('ready-to-show', () => {
      win.show();
      if (isDev) {
        win.webContents.openDevTools();
      }
    });

    // 窗口关闭时清理
    win.on('closed', () => {
      this.windows.delete(windowId);
      // 通知其他窗口该窗口已关闭
      this.broadcastToOthers(windowId, Channels.WINDOW_STATE_CHANGED, {
        windowId,
        event: 'closed',
      });
    });

    // 窗口焦点变化（激活模式）
    win.on('focus', () => {
      this.broadcast(Channels.WINDOW_FOCUS, { windowId, focused: true });
    });

    win.on('blur', () => {
      this.broadcast(Channels.WINDOW_BLUR, { windowId, focused: false });
    });

    // 窗口状态变化
    win.on('maximize', () => {
      this.broadcast(Channels.WINDOW_STATE_CHANGED, { windowId, state: 'maximized' });
    });

    win.on('unmaximize', () => {
      this.broadcast(Channels.WINDOW_STATE_CHANGED, { windowId, state: 'restored' });
    });

    win.on('minimize', () => {
      this.broadcast(Channels.WINDOW_STATE_CHANGED, { windowId, state: 'minimized' });
    });

    win.on('restore', () => {
      this.broadcast(Channels.WINDOW_STATE_CHANGED, { windowId, state: 'restored' });
    });

    // 存储窗口引用
    this.windows.set(windowId, win);

    // 构建加载 URL
    let loadUrl;
    if (isDev) {
      loadUrl = process.env.VITE_DEV_SERVER_URL + '#' + route;
    } else {
      // 生产环境使用 file:// 协议 + hash 路由
      const filePath = path.join(__dirname, '..', '..', 'dist', 'index.html');
      loadUrl = `file://${filePath}#${route}`;
    }

    win.loadURL(loadUrl);

    return { windowId, win };
  }

  /**
   * 关闭指定窗口
   * @param {number} windowId
   */
  closeWindow(windowId) {
    const win = this.windows.get(windowId);
    if (win && !win.isDestroyed()) {
      win.close();
    }
    this.windows.delete(windowId);
  }

  /**
   * 获取指定窗口
   * @param {number} windowId
   */
  getWindow(windowId) {
    return this.windows.get(windowId);
  }

  /**
   * 获取所有窗口
   */
  getAllWindows() {
    return Array.from(this.windows.values());
  }

  /**
   * 获取窗口数量
   */
  getWindowCount() {
    return this.windows.size;
  }

  /**
   * 向所有窗口广播消息
   */
  broadcast(channel, data) {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, data);
      }
    }
  }

  /**
   * 向除指定窗口外的所有窗口广播
   */
  broadcastToOthers(excludeWindowId, channel, data) {
    for (const [id, win] of this.windows) {
      if (id !== excludeWindowId && !win.isDestroyed()) {
        win.webContents.send(channel, data);
      }
    }
  }

  /**
   * 向指定窗口发送消息
   */
  sendToWindow(windowId, channel, data) {
    const win = this.windows.get(windowId);
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  }

  /**
   * 关闭所有窗口
   */
  closeAllWindows() {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) {
        win.close();
      }
    }
    this.windows.clear();
  }
}

module.exports = { WindowManager };
