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
  EXTENSION_MESSAGE: 'extensionHost:message',

  /* ─── 应用生命周期 ─── */
  APP_QUIT: 'app:quit',
  APP_RELAUNCH: 'app:relaunch',

  /* ─── 菜单事件 ─── */
  MENU_OPEN_FOLDER: 'menu:open-folder',
  MENU_OPEN_FILE: 'menu:open-file',
  MENU_NEW_WINDOW: 'menu:new-window',

  /* ─── Git ─── */
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

  /* ─── 终端 BrowserView 管理 ─── */
  TERMINAL_VIEW_CREATE: 'terminal:view:create',
  TERMINAL_VIEW_DESTROY: 'terminal:view:destroy',
  TERMINAL_VIEW_SET_BOUNDS: 'terminal:view:setBounds',
  TERMINAL_VIEW_FOCUS: 'terminal:view:focus',
  TERMINAL_VIEW_READY: 'terminal:view:ready',
  TERMINAL_VIEW_SET_BROADCAST: 'terminal:view:setBroadcast',
  TERMINAL_VIEW_FIND: 'terminal:view:find',
  TERMINAL_VIEW_CLEAR_SELECTION: 'terminal:view:clearSelection',
  TERMINAL_VIEW_RESIZE_STATE: 'terminal:view:resizeState',

  /* ─── 右侧面板 resize 状态 ─── */
  RIGHT_PANEL_RESIZE_STATE: 'rightPanel:resizeState',
};

module.exports = { Channels };
