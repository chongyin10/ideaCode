/**
 * IPC 通道常量定义
 * 
 * 被引用方：
 * - electron/main/ipcHandlers/*.cjs   (主进程处理端)
 * - electron/preload.cjs              (preload 桥接端)
 * - electron/extension-host/*.cjs     (扩展宿主进程)
 */

const Channels = {
  /* ─── 系统对话框 ─── */
  DIALOG_OPEN_DIRECTORY: 'dialog:openDirectory',
  DIALOG_OPEN_FILE: 'dialog:openFile',
  DIALOG_SAVE_FILE: 'dialog:saveFile',

  /* ─── 文件系统 (Node.js fs 运行时) ─── */
  FS_READ_DIR: 'fs:readDir',
  FS_READ_FILE: 'fs:readFile',
  FS_WRITE_FILE: 'fs:writeFile',
  FS_STAT: 'fs:stat',
  FS_WATCH: 'fs:watch',
  FS_UNWATCH: 'fs:unwatch',
  FS_CREATE_FILE: 'fs:createFile',
  FS_CREATE_DIR: 'fs:createDir',
  FS_DELETE: 'fs:delete',
  FS_RENAME: 'fs:rename',
  FS_COPY: 'fs:copy',
  FS_REVEAL: 'fs:reveal',

  /* ─── 窗口管理 ─── */
  WINDOW_CREATE: 'window:create',
  WINDOW_CLOSE: 'window:close',
  WINDOW_FOCUS: 'window:focus',
  WINDOW_BLUR: 'window:blur',
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_RESTORE: 'window:restore',
  WINDOW_STATE_CHANGED: 'window:stateChanged',

  /* ─── 扩展宿主 ─── */
  EXTENSION_HOST_START: 'extensionHost:start',
  EXTENSION_HOST_STOP: 'extensionHost:stop',
  EXTENSION_HOST_RPC: 'extensionHost:rpc',
  EXTENSION_HOST_MESSAGE: 'extensionHost:message',

  /* ─── 应用生命周期 ─── */
  APP_QUIT: 'app:quit',
  APP_RELAUNCH: 'app:relaunch',

  /* ─── 菜单事件 ─── */
  MENU_OPEN_FOLDER: 'menu:open-folder',
  MENU_OPEN_FILE: 'menu:open-file',
  MENU_NEW_WINDOW: 'menu:new-window',

  /* ─── 推送型通道 (主进程 → 渲染进程) ─── */
  FS_CHANGE: 'fs:change',
  EXTENSION_MESSAGE: 'extension:message',
};

module.exports = { Channels };
