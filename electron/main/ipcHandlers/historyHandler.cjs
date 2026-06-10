const { ipcMain } = require('electron');

/**
 * 历史记录 IPC 处理器
 *
 * 提供渲染进程访问最近打开项目列表的能力。
 */
function registerHistoryHandlers(historyManager) {
  // 获取最近项目列表
  ipcMain.handle('history:getRecent', async () => {
    return historyManager.getRecent();
  });

  // 添加最近项目
  ipcMain.handle('history:addRecent', async (_event, projectPath, name) => {
    await historyManager.addRecent(projectPath, name);
    return { success: true };
  });

  // 移除指定历史记录
  ipcMain.handle('history:removeRecent', async (_event, projectPath) => {
    await historyManager.removeRecent(projectPath);
    return { success: true };
  });

  // 清空历史记录
  ipcMain.handle('history:clearAll', async () => {
    await historyManager.clearAll();
    return { success: true };
  });

  // 获取历史记录文件路径（调试用）
  ipcMain.handle('history:getFilePath', async () => {
    return historyManager.getFilePath();
  });
}

module.exports = { registerHistoryHandlers };
