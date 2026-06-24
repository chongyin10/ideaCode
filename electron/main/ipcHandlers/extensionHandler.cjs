const { ipcMain } = require('electron');
const { Channels } = require('../../shared/channels.cjs');

/**
 * 扩展宿主 IPC 处理器
 * 
 * 渲染进程通过此通道与扩展宿主进程通信。
 * 扩展宿主是独立的 Node.js 子进程，通过 JSON-RPC 与主进程交互。
 */
function registerExtensionHandlers(extensionHostManager) {
  // 启动扩展宿主
  ipcMain.handle(Channels.EXTENSION_HOST_START, () => {
    extensionHostManager.start();
    return { success: true };
  });

  // 停止扩展宿主
  ipcMain.handle(Channels.EXTENSION_HOST_STOP, () => {
    extensionHostManager.stop();
    return { success: true };
  });

  // 向扩展宿主发送 RPC 请求
  ipcMain.handle(Channels.EXTENSION_HOST_RPC, async (_event, method, params) => {
    try {
      const result = await extensionHostManager.handleRendererRequest(method, params);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 接收渲染进程对 Extension Host 请求的响应
  ipcMain.on(Channels.EXTENSION_HOST_RENDERER_RESPONSE, (_event, { id, result, error }) => {
    extensionHostManager.handleRendererResponse(id, result, error);
  });
}

module.exports = { registerExtensionHandlers };
