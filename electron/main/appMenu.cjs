const { Menu, BrowserWindow } = require('electron');
const { Channels } = require('../shared/channels.cjs');

/**
 * 应用菜单构建器
 * 
 * 原生平台适配：
 * - Windows/Linux: 自定义窗口菜单
 * - macOS: 原生全局菜单栏（遵循系统规范）
 */
function createAppMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '新建窗口',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => {
            // 通过 IPC 通知渲染进程，或直接在主进程创建窗口
            const win = BrowserWindow.getFocusedWindow();
            if (win) {
              win.webContents.send(Channels.MENU_NEW_WINDOW);
            }
          },
        },
        { type: 'separator' },
        {
          label: '打开文件夹',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) {
              win.webContents.send(Channels.MENU_OPEN_FOLDER);
            }
          },
        },
        {
          label: '打开文件',
          accelerator: 'CmdOrCtrl+P',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) {
              win.webContents.send(Channels.MENU_OPEN_FILE);
            }
          },
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭' },
        { type: 'separator' },
        { role: 'front', label: '前置所有窗口' },
      ],
    },
  ];

  if (process.platform === 'darwin') {
    template.unshift({
      label: 'IDEACODE',
      submenu: [
        { role: 'about', label: '关于 IDEACODE' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏 IDEACODE' },
        { role: 'hideothers', label: '隐藏其他' },
        { role: 'unhide', label: '显示全部' },
        { type: 'separator' },
        { role: 'quit', label: '退出 IDEACODE' },
      ],
    });
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

module.exports = { createAppMenu };
