/* ─── Git 由 web/git 扩展提供（独立架构）─── */

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

export interface ExtensionRendererRequest extends ExtensionMessage {
  id: number;
}

export interface RecentProject {
  path: string;
  name: string;
  timestamp: number;
  openedCount: number;
}

/* ─── 终端 ─── */

export interface TerminalProfile {
  name: string;
  path: string;
  args?: string[];
  icon?: string;
}

export interface TerminalCreateConfig {
  shellConfig?: { name: string; path: string; args?: string[] };
  executable?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  cols?: number;
  rows?: number;
}

export interface TerminalCreateResult {
  success: boolean;
  id?: number;
  error?: string;
}

export interface TerminalOutputEvent {
  id: number;
  type: 'data' | 'ready' | 'exit';
  data?: string;
  pid?: number;
  cwd?: string;
  exitCode?: number;
  signal?: number;
}

export interface TerminalProfilesResult {
  success: boolean;
  profiles?: TerminalProfile[];
  defaultShell?: TerminalProfile;
  error?: string;
}

export interface TerminalCwdResult {
  success: boolean;
  cwd?: string;
  error?: string;
}

export interface TerminalLayoutResult {
  success: boolean;
  layout?: { tabs: Array<{ id: number; pid?: number; config: unknown; cwd: string }> };
  error?: string;
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
    /** §ripgrep 内容搜索：主进程 spawn rg，结果通过事件流式推送 */
    search: (params: {
      rootPath: string;
      query: string;
      options: {
        caseSensitive?: boolean;
        wholeWord?: boolean;
        useRegex?: boolean;
        includePattern?: string;
        excludePattern?: string;
        maxResults?: number;
      };
      searchId: number;
    }) => Promise<{ started: boolean; error?: string; searchId?: number }>;
    searchCancel: () => Promise<{ success: boolean }>;
    onSearchProgress: (callback: (data: {
      searchId: number;
      results: Array<{
        filePath: string;
        fileName: string;
        matches: Array<{
          line: number;
          column: number;
          text: string;
          match: { index: number; length: number; matched: string };
        }>;
      }>;
      totalMatches: number;
      isTruncated: boolean;
    }) => void) => () => void;
    onSearchDone: (callback: (data: {
      searchId: number;
      results: Array<{
        filePath: string;
        fileName: string;
        matches: Array<{
          line: number;
          column: number;
          text: string;
          match: { index: number; length: number; matched: string };
        }>;
      }>;
      totalMatches: number;
      isTruncated: boolean;
      error?: string;
    }) => void) => () => void;
  };

  /** 扩展宿主 - JSON-RPC 通信 */
  extension: {
    startHost: () => Promise<{ success: boolean }>;
    stopHost: () => Promise<{ success: boolean }>;
    rpc: (method: string, params: unknown) => Promise<ExtensionRpcResult>;
    install: (extPath: string) => Promise<{ success: boolean; stdout?: string; stderr?: string; code?: number; error?: string }>;
    uninstall: (extPath: string) => Promise<{ success: boolean; error?: string }>;
    onMessage: (callback: (data: ExtensionMessage) => void) => () => void;
    onRequest: (callback: (data: ExtensionRendererRequest) => void) => () => void;
    sendResponse: (id: number, payload: { result?: unknown; error?: string }) => void;
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

  /** Git 克隆（主进程 spawn git） */
  git: {
    clone: (url: string, targetPath: string) => Promise<{ success: boolean; error?: string }>;
    onCloneProgress: (callback: (data: { message: string }) => void) => () => void;
  };

  /** tsserver LSP */
  tsserver: {
    start: (root: string) => Promise<boolean>;
    stop: () => Promise<boolean>;
    open: (file: string, content: string) => Promise<unknown>;
    close: (file: string) => Promise<void>;
    change: (file: string, content: string) => Promise<void>;
    completions: (file: string, line: number, offset: number) => Promise<unknown[]>;
    definition: (file: string, line: number, offset: number) => Promise<unknown[]>;
    semanticTokens: (file: string) => Promise<{ legend?: { tokenTypes: string[]; tokenModifiers: string[] }; resultId?: string; data: number[] } | null>;
    quickInfo: (file: string, line: number, offset: number) => Promise<unknown>;
    onDiagnostics: (cb: (data: unknown) => void) => () => void;
  };

  /** 终端 — PTY 伪终端集成 */
  terminal: {
    create: (config?: TerminalCreateConfig) => Promise<TerminalCreateResult>;
    dispose: (id: number) => Promise<{ success: boolean }>;
    input: (id: number, data: string) => Promise<{ success: boolean }>;
    resize: (id: number, cols: number, rows: number) => Promise<{ success: boolean }>;
    sendSignal: (id: number, signal: string) => Promise<{ success: boolean }>;
    clear: (id: number) => Promise<{ success: boolean }>;
    ack: (id: number, charCount: number) => Promise<{ success: boolean }>;
    listProfiles: () => Promise<TerminalProfilesResult>;
    getCwd: (id: number) => Promise<TerminalCwdResult>;
    detach: (id: number) => Promise<{ success: boolean }>;
    attach: (id: number) => Promise<{ success: boolean }>;
    getLayout: () => Promise<TerminalLayoutResult>;
    setLayout: (layout: unknown) => Promise<{ success: boolean }>;
    broadcast: (senderId: number, data: string, targetIds: number[]) => Promise<{ success: boolean }>;
    setBroadcastMode: (enabled: boolean) => Promise<{ success: boolean }>;
    onOutput: (callback: (data: TerminalOutputEvent) => void) => () => void;
    onExit: (callback: (data: TerminalOutputEvent) => void) => () => void;
  };

  /** 系统资源监控 */
  system: {
    onStats: (callback: (data: SystemStats) => void) => () => void;
  };
}

export interface SystemStats {
  cpu: number;
  memory: number;
  gpu: number | null;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
