const { dialog, BrowserWindow } = require('electron');
const { ipcMain } = require('electron');
const fs = require('fs');
const { Channels } = require('../../shared/channels.cjs');

/**
 * 对话框 IPC 处理器
 * 
 * 渲染进程无法直接调用系统对话框，
 * 通过 IPC 请求主进程代为唤起原生对话框。
 */
function registerDialogHandlers() {
  // 打开目录对话框
  ipcMain.handle(Channels.DIALOG_OPEN_DIRECTORY, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
    });
    const selected = filePaths[0];
    if (!selected) return null;
    try {
      // 返回规范化真实路径，避免符号链接/别名导致的路径不一致
      return await fs.promises.realpath(selected);
    } catch {
      return selected;
    }
  });

  // 打开文件对话框
  ipcMain.handle(Channels.DIALOG_OPEN_FILE, async (event, options = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: options.filters || [
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    return filePaths[0] || null;
  });

  // 保存文件对话框
  ipcMain.handle(Channels.DIALOG_SAVE_FILE, async (event, options = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { filePath } = await dialog.showSaveDialog(win, {
      defaultPath: options.defaultPath,
      filters: options.filters || [
        { name: '文本文件', extensions: ['txt'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    return filePath || null;
  });
}

module.exports = { registerDialogHandlers };
