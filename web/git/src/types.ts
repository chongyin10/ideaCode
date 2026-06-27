// Git 扩展 WebView 与 Extension Host 之间的共享类型定义

export type StatusKind = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | 'T' | '?' | ' ';

export interface GitChange {
  path: string;
  originalPath: string | null;
  indexStatus: StatusKind;
  workingStatus: StatusKind;
  /**
   * 聚合条目标记：当 staged/changes 中存在大量位于默认忽略目录
   * （node_modules/dist/build 等）下的第三方文件时，会聚合成单条
   * 「目录/ (N 个文件)」条目，避免 UI 列出几万行。
   * 聚合条目不可执行单文件操作（打开/diff/暂存/取消暂存）。
   */
  aggregated?: boolean;
  /** 聚合条目包含的文件个数（仅当 aggregated=true 时有效） */
  count?: number;
}

export interface GitStatus {
  staged: GitChange[];
  changes: GitChange[];
  merge: GitChange[];
  untracked: GitChange[];
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface GitBranch {
  name: string;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  isRemote: boolean;
  lastCommit?: {
    hash: string;
    shortHash: string;
    subject: string;
    authorName: string;
    timestamp: number;
  };
}

export interface GitRemote {
  name: string;
  url: string;
  type: string;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  timestamp: number;
}

export interface GitStash {
  ref: string;
  message: string;
  timestamp: number;
}

export interface StateMessage {
  type: 'state';
  rootPath: string | null;
  repoRoot: string | null;
  isRepo: boolean;
  gitAvailable: boolean;
  state: GitStatus | null;
  lastError: string | null;
  loading?: boolean;
}

export interface BranchesMessage {
  type: 'branches';
  branches: GitBranch[];
}

export interface LogMessage {
  type: 'log';
  log: GitCommit[];
}

export interface StashesMessage {
  type: 'stashes';
  stashes: GitStash[];
}

export interface ActiveFileMessage {
  type: 'activeFile';
  path: string | null;
  staged: boolean | null;
}

export interface ShowBranchPickerMessage {
  type: 'showBranchPicker';
}

export interface RpcReply {
  type: 'rpc:reply';
  id: number;
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

export type HostMessage = StateMessage | BranchesMessage | LogMessage | StashesMessage | ActiveFileMessage | ShowBranchPickerMessage | RpcReply;

export interface RpcRequest {
  id: number;
  command: string;
  [key: string]: unknown;
}