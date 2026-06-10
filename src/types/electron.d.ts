/* ─── IPC 数据结构 ─── */

export interface FsEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

export interface FsStat {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtime: string;
}

export interface FsChangeEvent {
  eventType: 'rename' | 'change';
  filename: string | null;
  path: string;
  timestamp: number;
}

export interface WindowFocusEvent {
  windowId: number;
  focused: boolean;
}

export interface WindowStateEvent {
  windowId: number;
  state: 'maximized' | 'minimized' | 'restored' | 'closed';
}

export interface WatchResult {
  success: boolean;
  alreadyWatching?: boolean;
  reason?: string;
}

export interface ExtensionRpcResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

export interface ExtensionMessage {
  method: string;
  params: unknown;
}

export interface RecentProject {
  path: string;
  name: string;
  timestamp: number;
  openedCount: number;
}

/* ─── Electron API 接口（由 preload 脚本注入） ─── */

export interface ElectronAPI {
  platform: string;
  isElectron: boolean;

  /** 窗口生命周期 - 多窗口管理 */
  window: {
    create: (options?: { title?: string; route?: string }) => Promise<{ windowId: number; success: boolean }>;
    close: () => Promise<{ success: boolean }>;
    minimize: () => Promise<{ success: boolean }>;
    maximize: () => Promise<{ success: boolean }>;
    restore: () => Promise<{ success: boolean }>;
    onFocus: (callback: (data: WindowFocusEvent) => void) => () => void;
    onBlur: (callback: (data: WindowFocusEvent) => void) => () => void;
    onStateChanged: (callback: (data: WindowStateEvent) => void) => () => void;
  };

  /** 菜单事件 */
  menu: {
    onOpenFolder: (callback: () => void) => () => void;
    onOpenFile: (callback: () => void) => () => void;
    onNewWindow: (callback: () => void) => () => void;
  };

  /** 系统对话框 */
  dialog: {
    openDirectory: () => Promise<string | null>;
    openFile: (options?: { filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
    saveFile: (options?: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
  };

  /** 文件系统 - Node.js 运行时能力 */
  fs: {
    readDir: (dirPath: string) => Promise<FsEntry[]>;
    readFile: (filePath: string) => Promise<string>;
    writeFile: (filePath: string, content: string) => Promise<boolean>;
    stat: (filePath: string) => Promise<FsStat | null>;
    watch: (watchPath: string) => Promise<WatchResult>;
    unwatch: (watchPath: string) => Promise<WatchResult>;
    onChange: (callback: (data: FsChangeEvent) => void) => () => void;
    createFile: (filePath: string) => Promise<boolean>;
    createDir: (dirPath: string) => Promise<boolean>;
    delete: (targetPath: string) => Promise<boolean>;
    rename: (oldPath: string, newPath: string) => Promise<boolean>;
    copy: (srcPath: string, destPath: string) => Promise<boolean>;
    reveal: (filePath: string) => Promise<boolean>;
  };

  /** 扩展宿主 - JSON-RPC 通信 */
  extension: {
    startHost: () => Promise<{ success: boolean }>;
    stopHost: () => Promise<{ success: boolean }>;
    rpc: (method: string, params: unknown) => Promise<ExtensionRpcResult>;
    onMessage: (callback: (data: ExtensionMessage) => void) => () => void;
  };

  /** 应用生命周期 */
  app: {
    onQuit: (callback: () => void) => () => void;
  };

  /** 历史记录 - 最近打开的项目 */
  history: {
    getRecent: () => Promise<RecentProject[]>;
    addRecent: (projectPath: string, name: string) => Promise<{ success: boolean }>;
    removeRecent: (projectPath: string) => Promise<{ success: boolean }>;
    clearAll: () => Promise<{ success: boolean }>;
    getFilePath: () => Promise<string>;
  };
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
