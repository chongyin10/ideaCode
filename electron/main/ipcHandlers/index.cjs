const { registerDialogHandlers } = require('./dialogHandler.cjs');
const { registerFsHandlers } = require('./fsHandler.cjs');
const { registerWindowHandlers } = require('./windowHandler.cjs');
const { registerExtensionHandlers } = require('./extensionHandler.cjs');
const { registerHistoryHandlers } = require('./historyHandler.cjs');
const { registerGitHandlers } = require('./gitHandler.cjs');
const { registerTsServerHandlers } = require('../lsp/tsserverManager.cjs');
const { registerTerminalHandlers } = require('./terminalHandler.cjs');

/**
 * 统一注册所有 IPC 处理器
 * 
 * 在主进程启动早期调用，确保所有 IPC 通道在渲染进程连接前已就绪。
 */
function registerIpcHandlers(deps = {}) {
  const { windowManager, extensionHostManager, historyManager } = deps;

  registerDialogHandlers();
  registerFsHandlers();
  registerGitHandlers();
  registerTsServerHandlers();
  registerTerminalHandlers();

  if (windowManager) {
    registerWindowHandlers(windowManager);
  }

  if (extensionHostManager) {
    registerExtensionHandlers(extensionHostManager);
  }

  if (historyManager) {
    registerHistoryHandlers(historyManager);
  }
}

module.exports = { registerIpcHandlers };
