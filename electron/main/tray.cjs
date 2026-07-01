const { Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { Channels } = require('../shared/channels.cjs');

const isDev = process.env.VITE_DEV_SERVER_URL !== undefined;

/**
 * 获取构建资源目录下的图标路径
 * - 开发环境：相对于 electron/main/tray.cjs -> ../../build
 * - 生产环境：electron-builder 将 buildResources 复制到 process.resourcesPath
 */
function getBuildResourcePath(...segments) {
  if (isDev) {
    return path.join(__dirname, '..', '..', 'build', ...segments);
  }
  return path.join(process.resourcesPath, ...segments);
}

/**
 * 系统托盘管理器
 * 
 * 原生平台适配：
 * - Windows: 任务栏右下角托盘图标
 * - macOS: 菜单栏托盘图标
 * - Linux: 系统托盘/指示器区域
 * 
 * 功能：
 * 1. 最小化到托盘
 * 2. 托盘右键菜单
 * 3. 点击托盘图标恢复窗口
 */
class TrayManager {
  constructor(windowManager) {
    this.windowManager = windowManager;
    /** @type {Tray|null} */
    this.tray = null;
  }

  createTray() {
    // 使用应用图标作为托盘图标
    // macOS 菜单栏图标使用 22x22（@2x 44x44）尺寸；Windows/Linux 使用 16x16/32x32
    const trayIconName = process.platform === 'darwin' ? 'trayIcon_22.png' : 'trayIcon_16.png';
    const iconPath = getBuildResourcePath(trayIconName);
    const icon = nativeImage.createFromPath(iconPath);
    // 启用模板模式可使图标跟随系统深色/浅色菜单栏自动反色；
    // 当前应用图标是彩色 logo，暂不使用模板模式以保持品牌色。
    // icon.setTemplateImage(true);
    this.tray = new Tray(icon);

    const contextMenu = Menu.buildFromTemplate([
      {
        label: '新建窗口',
        click: () => this.windowManager.createWindow(),
      },
      { type: 'separator' },
      {
        label: '显示全部窗口',
        click: () => {
          for (const win of this.windowManager.getAllWindows()) {
            if (win.isMinimized()) win.restore();
            win.show();
          }
        },
      },
      {
        label: '最小化到托盘',
        click: () => {
          for (const win of this.windowManager.getAllWindows()) {
            win.hide();
          }
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          // 发送退出信号到所有窗口，允许前端保存状态
          this.windowManager.broadcast(Channels.APP_QUIT, {});
          setTimeout(() => {
            require('electron').app.quit();
          }, 500);
        },
      },
    ]);

    this.tray.setContextMenu(contextMenu);
    this.tray.setToolTip('IDEACODE');

    // 点击托盘图标：恢复最近一个窗口
    this.tray.on('click', () => {
      const wins = this.windowManager.getAllWindows();
      if (wins.length === 0) {
        this.windowManager.createWindow();
        return;
      }
      const lastWin = wins[wins.length - 1];
      if (lastWin.isVisible()) {
        lastWin.hide();
      } else {
        lastWin.show();
        lastWin.focus();
      }
    });

    // macOS: 双击托盘图标新建窗口
    this.tray.on('double-click', () => {
      this.windowManager.createWindow();
    });
  }

  destroy() {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

module.exports = { TrayManager };
