/* ─── Git ─── */

export type GitStatusCode = 'M' | 'A' | 'D' | 'R' | 'U' | 'C';
export type GitStatusMap = Record<string, GitStatusCode>;
export interface GitStatusResult {
  /** 暂存区（已 git add） */
  staged: GitStatusMap;
  /** 工作区已修改/删除的文件 */
  changes: GitStatusMap;
  /** 合并冲突的文件 */
  merge: GitStatusMap;
  /** 未跟踪的新文件 */
  untracked: GitStatusMap;
}
  name: string;
  current: boolean;
}

export interface GitRemote {
  name: string;
  url: string;
  type: string;
}

export interface GitBehindAhead {
  ahead: number;
  behind: number;
}

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

  /** Git 版本控制 */
  git: {
    getStatus: (dirPath: string) => Promise<GitStatusResult>;
    getBranch: (dirPath: string) => Promise<string>;
    listBranches: (dirPath: string) => Promise<GitBranch[]>;
    checkout: (dirPath: string, branch: string) => Promise<boolean>;
    createBranch: (dirPath: string, branch: string) => Promise<boolean>;
    stage: (dirPath: string, files: string | string[]) => Promise<boolean>;
    unstage: (dirPath: string, files: string | string[]) => Promise<boolean>;
    commit: (dirPath: string, message: string) => Promise<string>;
    getDiff: (dirPath: string, staged?: boolean) => Promise<string>;
    show: (dirPath: string, filePath: string) => Promise<string>;
    pull: (dirPath: string) => Promise<string>;
    push: (dirPath: string) => Promise<string>;
    fetch: (dirPath: string) => Promise<boolean>;
    listRemotes: (dirPath: string) => Promise<GitRemote[]>;
    getLog: (dirPath: string, count?: number) => Promise<string[]>;
    stashList: (dirPath: string) => Promise<string[]>;
    stashPush: (dirPath: string, message?: string) => Promise<boolean>;
    stashPop: (dirPath: string) => Promise<boolean>;
    getBehindAhead: (dirPath: string) => Promise<GitBehindAhead>;
    discard: (dirPath: string, file: string) => Promise<boolean>;
    init: (dirPath: string) => Promise<boolean>;
    clone: (repoUrl: string, targetPath: string) => Promise<string>;
    onCloneProgress: (callback: (data: string) => void) => () => void;
    isRepo: (dirPath: string) => Promise<boolean>;
  };
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
