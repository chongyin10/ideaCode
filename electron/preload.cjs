const { contextBridge, ipcRenderer } = require('electron');

/**
 * IPC 通道常量（内联定义）
 * 
 * 注意：preload 脚本在 sandbox 模式下运行时，无法通过 require 加载
 * 相对路径的本地模块。因此将通道常量直接内联在此文件中，确保
 * preload 脚本完全自包含。
 */
const Channels = {
  DIALOG_OPEN_DIRECTORY: 'dialog:openDirectory',
  DIALOG_OPEN_FILE: 'dialog:openFile',
  DIALOG_SAVE_FILE: 'dialog:saveFile',
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
  WINDOW_CREATE: 'window:create',
  WINDOW_CLOSE: 'window:close',
  WINDOW_FOCUS: 'window:focus',
  WINDOW_BLUR: 'window:blur',
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_RESTORE: 'window:restore',
  WINDOW_STATE_CHANGED: 'window:stateChanged',
  EXTENSION_HOST_START: 'extensionHost:start',
  EXTENSION_HOST_STOP: 'extensionHost:stop',
  EXTENSION_HOST_RPC: 'extensionHost:rpc',
  EXTENSION_HOST_MESSAGE: 'extensionHost:message',
  APP_QUIT: 'app:quit',
  APP_RELAUNCH: 'app:relaunch',
  MENU_OPEN_FOLDER: 'menu:open-folder',
  MENU_OPEN_FILE: 'menu:open-file',
  MENU_NEW_WINDOW: 'menu:new-window',
  FS_CHANGE: 'fs:change',
  EXTENSION_MESSAGE: 'extension:message',
  HISTORY_GET_RECENT: 'history:getRecent',
  HISTORY_ADD_RECENT: 'history:addRecent',
  HISTORY_REMOVE_RECENT: 'history:removeRecent',
  HISTORY_CLEAR_ALL: 'history:clearAll',
  HISTORY_GET_FILE_PATH: 'history:getFilePath',

  GIT_GET_STATUS: 'git:getStatus',
};

/**
 * Preload 脚本机制
 * 
 * 执行时机：在 Chromium 渲染引擎加载页面脚本之前运行。
 * 核心作用：为受严格安全策略（CSP、contextIsolation、sandbox）限制的渲染进程，
 *          安全地引入必要的 Node.js 运行时能力。
 * 
 * 安全原则：
 * 1. 不直接暴露 ipcRenderer 对象，而是包装为受限 API
 * 2. 所有 IPC 通道名使用 Channels 常量，编译期防错
 * 3. 事件监听器返回取消订阅函数，防止内存泄漏
 * 4. 白名单机制：仅暴露业务需要的 API，不暴露底层系统调用
 * 5. 扩展隔离：扩展只能通过 JSON-RPC 通信，无法直接访问此 API
 */

function onChannel(channel, callback) {
  const wrapped = (_event, data) => callback(data);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

function onceChannel(channel, callback) {
  const wrapped = (_event, data) => callback(data);
  ipcRenderer.once(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const electronAPI = {
  platform: process.platform,
  isElectron: true,

  window: {
    create: (options) => ipcRenderer.invoke(Channels.WINDOW_CREATE, options),
    close: () => ipcRenderer.invoke(Channels.WINDOW_CLOSE),
    minimize: () => ipcRenderer.invoke(Channels.WINDOW_MINIMIZE),
    maximize: () => ipcRenderer.invoke(Channels.WINDOW_MAXIMIZE),
    restore: () => ipcRenderer.invoke(Channels.WINDOW_RESTORE),
    onFocus: (callback) => onChannel(Channels.WINDOW_FOCUS, callback),
    onBlur: (callback) => onChannel(Channels.WINDOW_BLUR, callback),
    onStateChanged: (callback) => onChannel(Channels.WINDOW_STATE_CHANGED, callback),
  },

  menu: {
    onOpenFolder: (callback) => onChannel(Channels.MENU_OPEN_FOLDER, callback),
    onOpenFile: (callback) => onChannel(Channels.MENU_OPEN_FILE, callback),
    onNewWindow: (callback) => onChannel(Channels.MENU_NEW_WINDOW, callback),
  },

  dialog: {
    openDirectory: () => ipcRenderer.invoke(Channels.DIALOG_OPEN_DIRECTORY),
    openFile: (options) => ipcRenderer.invoke(Channels.DIALOG_OPEN_FILE, options),
    saveFile: (options) => ipcRenderer.invoke(Channels.DIALOG_SAVE_FILE, options),
  },

  fs: {
    readDir: (dirPath) => ipcRenderer.invoke(Channels.FS_READ_DIR, dirPath),
    readFile: (filePath) => ipcRenderer.invoke(Channels.FS_READ_FILE, filePath),
    writeFile: (filePath, content) =>
      ipcRenderer.invoke(Channels.FS_WRITE_FILE, filePath, content),
    stat: (filePath) => ipcRenderer.invoke(Channels.FS_STAT, filePath),
    watch: (watchPath) => ipcRenderer.invoke(Channels.FS_WATCH, watchPath),
    unwatch: (watchPath) => ipcRenderer.invoke(Channels.FS_UNWATCH, watchPath),
    onChange: (callback) => onChannel(Channels.FS_CHANGE, callback),
    createFile: (filePath) => ipcRenderer.invoke(Channels.FS_CREATE_FILE, filePath),
    createDir: (dirPath) => ipcRenderer.invoke(Channels.FS_CREATE_DIR, dirPath),
    delete: (targetPath) => ipcRenderer.invoke(Channels.FS_DELETE, targetPath),
    rename: (oldPath, newPath) => ipcRenderer.invoke(Channels.FS_RENAME, oldPath, newPath),
    copy: (srcPath, destPath) => ipcRenderer.invoke(Channels.FS_COPY, srcPath, destPath),
    reveal: (filePath) => ipcRenderer.invoke(Channels.FS_REVEAL, filePath),
  },

  extension: {
    startHost: () => ipcRenderer.invoke(Channels.EXTENSION_HOST_START),
    stopHost: () => ipcRenderer.invoke(Channels.EXTENSION_HOST_STOP),
    rpc: (method, params) => ipcRenderer.invoke(Channels.EXTENSION_HOST_RPC, method, params),
    onMessage: (callback) => onChannel(Channels.EXTENSION_MESSAGE, callback),
  },

  app: {
    onQuit: (callback) => onChannel(Channels.APP_QUIT, callback),
  },

  git: {
    getStatus: (dirPath) => ipcRenderer.invoke(Channels.GIT_GET_STATUS, dirPath),
  },
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
