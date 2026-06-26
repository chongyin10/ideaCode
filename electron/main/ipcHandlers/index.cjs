const { registerDialogHandlers } = require('./dialogHandler.cjs');
const { registerFsHandlers } = require('./fsHandler.cjs');
const { registerWindowHandlers } = require('./windowHandler.cjs');
const { registerExtensionHandlers } = require('./extensionHandler.cjs');
const { registerExtensionInstallHandlers } = require('./extensionInstallHandler.cjs');
const { registerHistoryHandlers } = require('./historyHandler.cjs');
// Git 功能由 web/git 扩展在 Extension Host 子进程中提供，不再注册内置 gitHandler
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
  registerTsServerHandlers();
  registerTerminalHandlers();

  if (windowManager) {
    registerWindowHandlers(windowManager);
  }

  if (extensionHostManager) {
    registerExtensionHandlers(extensionHostManager);
  }

  registerExtensionInstallHandlers();

  if (historyManager) {
    registerHistoryHandlers(historyManager);
  }
}

module.exports = { registerIpcHandlers };

