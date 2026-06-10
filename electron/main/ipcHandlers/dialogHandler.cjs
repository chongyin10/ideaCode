const { dialog } = require('electron');
const { ipcMain } = require('electron');
const { Channels } = require('../../shared/channels.cjs');

/**
 * 对话框 IPC 处理器
 * 
 * 渲染进程无法直接调用系统对话框，
 * 通过 IPC 请求主进程代为唤起原生对话框。
 */
function registerDialogHandlers() {
  // 打开目录对话框
  ipcMain.handle(Channels.DIALOG_OPEN_DIRECTORY, async () => {
    const { filePaths } = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    });
    return filePaths[0] || null;
  });

  // 打开文件对话框
  ipcMain.handle(Channels.DIALOG_OPEN_FILE, async (_event, options = {}) => {
    const { filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: options.filters || [
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    return filePaths[0] || null;
  });

  // 保存文件对话框
  ipcMain.handle(Channels.DIALOG_SAVE_FILE, async (_event, options = {}) => {
    const { filePath } = await dialog.showSaveDialog({
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
