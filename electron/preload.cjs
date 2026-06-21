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
  EXTENSION_MESSAGE: 'extensionHost:message',
  HISTORY_GET_RECENT: 'history:getRecent',
  HISTORY_ADD_RECENT: 'history:addRecent',
  HISTORY_REMOVE_RECENT: 'history:removeRecent',
  HISTORY_CLEAR_ALL: 'history:clearAll',
  HISTORY_GET_FILE_PATH: 'history:getFilePath',

  GIT_GET_STATUS: 'git:getStatus',
  GIT_GET_BRANCH: 'git:getBranch',
  GIT_LIST_BRANCHES: 'git:listBranches',
  GIT_CHECKOUT: 'git:checkout',
  GIT_CREATE_BRANCH: 'git:createBranch',
  GIT_STAGE: 'git:stage',
  GIT_UNSTAGE: 'git:unstage',
  GIT_COMMIT: 'git:commit',
  GIT_GET_DIFF: 'git:getDiff',
  GIT_SHOW: 'git:show',
  GIT_PULL: 'git:pull',
  GIT_PUSH: 'git:push',
  GIT_FETCH: 'git:fetch',
  GIT_LIST_REMOTES: 'git:listRemotes',
  GIT_GET_LOG: 'git:getLog',
  GIT_STASH_LIST: 'git:stashList',
  GIT_STASH_PUSH: 'git:stashPush',
  GIT_STASH_POP: 'git:stashPop',
  GIT_GET_BEHIND_AHEAD: 'git:getBehindAhead',
  GIT_DISCARD: 'git:discard',
  GIT_INIT: 'git:init',
  GIT_CLONE: 'git:clone',
  GIT_CLONE_PROGRESS: 'git:cloneProgress',
  GIT_IS_REPO: 'git:isRepo',
  GIT_STATUS_CHANGED: 'git:statusChanged',

  /* ─── tsserver LSP ─── */
  TSSERVER_START: 'tsserver:start',
  TSSERVER_STOP: 'tsserver:stop',
  TSSERVER_OPEN: 'tsserver:open',
  TSSERVER_CLOSE: 'tsserver:close',
  TSSERVER_CHANGE: 'tsserver:change',
  TSSERVER_COMPLETIONS: 'tsserver:completions',
  TSSERVER_DEFINITION: 'tsserver:definition',
  TSSERVER_SEMANTIC_TOKENS: 'tsserver:semanticTokens',
  TSSERVER_QUICKINFO: 'tsserver:quickinfo',
  TSSERVER_DIAGNOSTICS: 'tsserver:diagnostics',

  /* ─── 终端 ─── */
  TERMINAL_CREATE: 'terminal:create',
  TERMINAL_DISPOSE: 'terminal:dispose',
  TERMINAL_INPUT: 'terminal:input',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_OUTPUT: 'terminal:output',
  TERMINAL_EXIT: 'terminal:exit',
  TERMINAL_LIST_PROFILES: 'terminal:listProfiles',
  TERMINAL_GET_CWD: 'terminal:getCwd',
  TERMINAL_DETACH: 'terminal:detach',
  TERMINAL_ATTACH: 'terminal:attach',
  TERMINAL_GET_LAYOUT: 'terminal:getLayout',
  TERMINAL_SET_LAYOUT: 'terminal:setLayout',
  TERMINAL_BROADCAST: 'terminal:broadcast',
  TERMINAL_SEND_SIGNAL: 'terminal:sendSignal',
  TERMINAL_CLEAR: 'terminal:clear',

  TERMINAL_SET_BROADCAST_MODE: 'terminal:setBroadcastMode',

  /* ─── 系统资源监控 ─── */
  SYSTEM_STATS: 'system:stats',
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
    getBranch: (dirPath) => ipcRenderer.invoke(Channels.GIT_GET_BRANCH, dirPath),
    listBranches: (dirPath) => ipcRenderer.invoke(Channels.GIT_LIST_BRANCHES, dirPath),
    checkout: (dirPath, branch) => ipcRenderer.invoke(Channels.GIT_CHECKOUT, dirPath, branch),
    createBranch: (dirPath, branch, startPoint) => ipcRenderer.invoke(Channels.GIT_CREATE_BRANCH, dirPath, branch, startPoint),
    stage: (dirPath, files) => ipcRenderer.invoke(Channels.GIT_STAGE, dirPath, files),
    unstage: (dirPath, files) => ipcRenderer.invoke(Channels.GIT_UNSTAGE, dirPath, files),
    commit: (dirPath, message) => ipcRenderer.invoke(Channels.GIT_COMMIT, dirPath, message),
    getDiff: (dirPath, staged) => ipcRenderer.invoke(Channels.GIT_GET_DIFF, dirPath, staged),
    show: (dirPath, filePath) => ipcRenderer.invoke(Channels.GIT_SHOW, dirPath, filePath),
    pull: (dirPath) => ipcRenderer.invoke(Channels.GIT_PULL, dirPath),
    push: (dirPath) => ipcRenderer.invoke(Channels.GIT_PUSH, dirPath),
    fetch: (dirPath) => ipcRenderer.invoke(Channels.GIT_FETCH, dirPath),
    listRemotes: (dirPath) => ipcRenderer.invoke(Channels.GIT_LIST_REMOTES, dirPath),
    getLog: (dirPath, count) => ipcRenderer.invoke(Channels.GIT_GET_LOG, dirPath, count),
    stashList: (dirPath) => ipcRenderer.invoke(Channels.GIT_STASH_LIST, dirPath),
    stashPush: (dirPath, message) => ipcRenderer.invoke(Channels.GIT_STASH_PUSH, dirPath, message),
    stashPop: (dirPath) => ipcRenderer.invoke(Channels.GIT_STASH_POP, dirPath),
    getBehindAhead: (dirPath) => ipcRenderer.invoke(Channels.GIT_GET_BEHIND_AHEAD, dirPath),
    discard: (dirPath, files) => ipcRenderer.invoke(Channels.GIT_DISCARD, dirPath, files),
    init: (dirPath) => ipcRenderer.invoke(Channels.GIT_INIT, dirPath),
    clone: (repoUrl, targetPath) => ipcRenderer.invoke(Channels.GIT_CLONE, repoUrl, targetPath),
    onCloneProgress: (callback) => onChannel(Channels.GIT_CLONE_PROGRESS, callback),
    onStatusChanged: (callback) => onChannel(Channels.GIT_STATUS_CHANGED, callback),
    isRepo: (dirPath) => ipcRenderer.invoke(Channels.GIT_IS_REPO, dirPath),
  },

  /** tsserver LSP — TypeScript 语言服务 */
  tsserver: {
    start: (root) => ipcRenderer.invoke(Channels.TSSERVER_START, root),
    stop: () => ipcRenderer.invoke(Channels.TSSERVER_STOP),
    open: (file, content) => ipcRenderer.invoke(Channels.TSSERVER_OPEN, file, content),
    close: (file) => ipcRenderer.invoke(Channels.TSSERVER_CLOSE, file),
    change: (file, content) => ipcRenderer.invoke(Channels.TSSERVER_CHANGE, file, content),
    completions: (file, line, offset) => ipcRenderer.invoke(Channels.TSSERVER_COMPLETIONS, file, line, offset),
    definition: (file, line, offset) => ipcRenderer.invoke(Channels.TSSERVER_DEFINITION, file, line, offset),
    semanticTokens: (file) => ipcRenderer.invoke(Channels.TSSERVER_SEMANTIC_TOKENS, file),
    quickInfo: (file, line, offset) => ipcRenderer.invoke(Channels.TSSERVER_QUICKINFO, file, line, offset),
    onDiagnostics: (cb) => onChannel(Channels.TSSERVER_DIAGNOSTICS, cb),
  },

  /** 终端 — PTY 伪终端集成 */
  terminal: {
    create: (config) => ipcRenderer.invoke(Channels.TERMINAL_CREATE, config),
    dispose: (id) => ipcRenderer.invoke(Channels.TERMINAL_DISPOSE, { id }),
    input: (id, data) => ipcRenderer.invoke(Channels.TERMINAL_INPUT, { id, data }),
    resize: (id, cols, rows) => ipcRenderer.invoke(Channels.TERMINAL_RESIZE, { id, cols, rows }),
    sendSignal: (id, signal) => ipcRenderer.invoke(Channels.TERMINAL_SEND_SIGNAL, { id, signal }),
    clear: (id) => ipcRenderer.invoke(Channels.TERMINAL_CLEAR, { id }),
    ack: (id, charCount) => ipcRenderer.invoke('terminal:ack', { id, charCount }),
    listProfiles: () => ipcRenderer.invoke(Channels.TERMINAL_LIST_PROFILES),
    getCwd: (id) => ipcRenderer.invoke(Channels.TERMINAL_GET_CWD, { id }),
    detach: (id) => ipcRenderer.invoke(Channels.TERMINAL_DETACH, { id }),
    attach: (id) => ipcRenderer.invoke(Channels.TERMINAL_ATTACH, { id }),
    getLayout: () => ipcRenderer.invoke(Channels.TERMINAL_GET_LAYOUT),
    setLayout: (layout) => ipcRenderer.invoke(Channels.TERMINAL_SET_LAYOUT, layout),
    broadcast: (senderId, data, targetIds) => ipcRenderer.invoke(Channels.TERMINAL_BROADCAST, { senderId, data, targetIds }),
    setBroadcastMode: (enabled) => ipcRenderer.invoke(Channels.TERMINAL_SET_BROADCAST_MODE, { enabled }),
    onOutput: (callback) => onChannel(Channels.TERMINAL_OUTPUT, callback),
    onExit: (callback) => onChannel(Channels.TERMINAL_EXIT, callback),
  },

  /** 系统资源监控 — 主进程广播 */
  system: {
    onStats: (callback) => onChannel(Channels.SYSTEM_STATS, callback),
  },
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
