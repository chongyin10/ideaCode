/**
 * 服务接口契约
 *
 * 定义每个服务的标准接口，所有服务实现必须遵循此契约。
 * 这是微内核架构的核心：内核不关心实现细节，只关心接口。
 */

import type { Disposable, Uri } from '../ipc/index.js';

// ─── 文件系统服务 ───

export interface FileInfo {
  name: string;
  kind: 'file' | 'directory' | 'symlink';
  size: number;
  modifiedTime: number;
}

export interface IFileService {
  readDir(dirPath: string): Promise<FileInfo[]>;
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<boolean>;
  stat(filePath: string): Promise<FileInfo>;
  createFile(filePath: string): Promise<boolean>;
  createDir(dirPath: string): Promise<boolean>;
  delete(targetPath: string): Promise<boolean>;
  rename(oldPath: string, newPath: string): Promise<boolean>;
  copy(srcPath: string, destPath: string): Promise<boolean>;
  reveal(filePath: string): Promise<boolean>;
  watch(watchPath: string): Promise<boolean>;
  unwatch(watchPath: string): Promise<boolean>;
  onChange(handler: (change: FileChangeEvent) => void): Disposable;
}

export interface FileChangeEvent {
  path: string;
  type: 'created' | 'changed' | 'deleted';
}

// ─── 终端服务 ───

export interface TerminalCreateOptions {
  cwd?: string;
  shell?: string;
  shellArgs?: string[];
  env?: Record<string, string>;
  name?: string;
}

export interface ITerminalService {
  create(config: TerminalCreateOptions): Promise<{ tabId: string; processId: number; success: boolean; error?: string }>;
  dispose(tabId: string): Promise<void>;
  input(tabId: string, data: string): Promise<void>;
  resize(tabId: string, cols: number, rows: number): Promise<void>;
  sendSignal(tabId: string, signal: string): Promise<void>;
  clear(tabId: string): Promise<void>;
  listProfiles(): Promise<string[]>;
  getCwd(tabId: string): Promise<string>;
  detach(tabId: string): Promise<void>;
  attach(tabId: string): Promise<void>;
  onOutput(handler: (data: TerminalOutputEvent) => void): Disposable;
  onExit(handler: (data: TerminalExitEvent) => void): Disposable;
}

export interface TerminalOutputEvent {
  tabId: string;
  processId: number;
  data: string;
}

export interface TerminalExitEvent {
  tabId: string;
  processId: number;
  exitCode: number;
}

// ─── 编辑器服务 ───

export interface EditorDocument {
  uri: Uri;
  fileName: string;
  languageId: string;
  version: number;
  isDirty: boolean;
  isUntitled: boolean;
  content?: string;
}

export interface EditorSelection {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export interface IEditorService {
  getActive(): EditorDocument | null;
  getVisible(): EditorDocument[];
  setValue(text: string): void;
  insertText(text: string): void;
  replaceRange(
    startLine: number, startCol: number,
    endLine: number, endCol: number,
    text: string
  ): void;
  gotoLine(line: number): void;
  getSelection(): EditorSelection | null;
    onChange(handler: (doc: EditorDocument) => void): Disposable;
}

// ─── 工作区服务 ───

export interface WorkspaceFolderInfo {
  uri: Uri;
  name: string;
  index: number;
}

export interface IWorkspaceService {
  getRootPath(): string | null;
  getFolders(): WorkspaceFolderInfo[];
  openFile(filePath: string): Promise<void>;
  openDocument(uri: Uri): Promise<void>;
  saveAll(): Promise<void>;
  onDidChangeWorkspaceFolders(handler: (folders: WorkspaceFolderInfo[]) => void): Disposable;
  onDidOpenTextDocument(handler: (doc: EditorDocument) => void): Disposable;
  onDidSaveTextDocument(handler: (doc: EditorDocument) => void): Disposable;
}

// ─── Git 服务 ───

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

export interface GitChange {
  path: string;
  originalPath: string | null;
  indexStatus: string;
  workingStatus: string;
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

export interface IGitService {
  getStatus(): Promise<GitStatus>;
  getBranch(): Promise<string>;
  listBranches(): Promise<GitBranch[]>;
  checkout(name: string): Promise<void>;
  createBranch(name: string, startPoint?: string): Promise<void>;
  stage(paths: string[]): Promise<void>;
  unstage(paths: string[]): Promise<void>;
  commit(message: string, opts?: { amend?: boolean; noVerify?: boolean }): Promise<string>;
  getDiff(path?: string, staged?: boolean): Promise<string>;
  push(remote?: string, branch?: string): Promise<string>;
  pull(remote?: string, branch?: string): Promise<string>;
  fetch(remote?: string): Promise<void>;
  init(cwd: string): Promise<void>;
  clone(url: string, targetPath: string): Promise<void>;
  isRepo(path: string): Promise<boolean>;
  onStatusChanged(handler: (status: GitStatus) => void): Disposable;
}

// ─── LSP 服务 ───

export interface ILspService {
  start(root: string): Promise<void>;
  stop(): Promise<void>;
  open(file: string, content: string): Promise<void>;
  close(file: string): Promise<void>;
  change(file: string, content: string): Promise<void>;
  completions(file: string, line: number, offset: number): Promise<unknown[]>;
  definition(file: string, line: number, offset: number): Promise<unknown>;
  semanticTokens(file: string): Promise<unknown>;
  quickInfo(file: string, line: number, offset: number): Promise<unknown>;
  onDiagnostics(handler: (diagnostics: unknown) => void): Disposable;
}

// ─── 窗口服务 ───

export interface IWindowService {
  create(options?: { show?: boolean; url?: string }): Promise<number>;
  close(): Promise<void>;
  focus(): Promise<void>;
  minimize(): Promise<void>;
  maximize(): Promise<void>;
  restore(): Promise<void>;
  broadcast(channel: string, data: unknown): void;
}

// ─── 对话框服务 ───

export interface IDialogService {
  openDirectory(): Promise<string | null>;
  openFile(options?: { filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | null>;
  saveFile(options?: { defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | null>;
}

// ─── 消息 UI 服务 ───

export type MessageType = 'info' | 'warning' | 'error';

export interface IUiService {
  showMessage(message: string, type: MessageType): Promise<void>;
  showInputBox(options: { prompt?: string; value?: string; password?: boolean }): Promise<string | undefined>;
  showQuickPick(items: Array<{ label: string; description?: string }>, options?: { placeHolder?: string }): Promise<string | undefined>;
  setStatusBar(id: string, text: string, tooltip?: string, command?: string): void;
  hideStatusBar(id: string): void;
}

// ─── WebView 管理服务 ───

export interface IWebViewService {
  createPanel(params: WebViewCreateParams): Promise<string>;
  setHtml(id: string, html: string): Promise<void>;
  dispose(id: string): Promise<void>;
  reveal(id: string): Promise<void>;
  postMessage(id: string, message: unknown): Promise<void>;
  onMessage(id: string, handler: (message: unknown) => void): Disposable;
}

export interface WebViewCreateParams {
  viewType: string;
  title: string;
  html?: string;
  extensionId: string;
  extensionPath: string;
  enableScripts?: boolean;
  retainContextWhenHidden?: boolean;
  modal?: boolean;
}

// ─── 系统监控服务 ───

export interface SystemStats {
  cpu: number;
  memory: { used: number; total: number; percent: number };
  gpu?: { usage: number; memory: number };
}

export interface ISystemService {
  onStats(handler: (stats: SystemStats) => void): Disposable;
}

// ─── 配置服务 ───

export interface IConfigService {
  get<T = unknown>(section: string, key: string, defaultValue?: T): T;
  set(section: string, key: string, value: unknown): Promise<void>;
}

// ─── 存储服务 ───

export interface IStorageService {
  get(prefix: string, key: string, defaultValue?: unknown): Promise<unknown>;
  set(prefix: string, key: string, value: unknown): Promise<void>;
}

// ─── 密钥存储服务 ───

export interface ISecretService {
  get(extensionId: string, key: string): Promise<string | null>;
  store(extensionId: string, key: string, value: string): Promise<void>;
  delete(extensionId: string, key: string): Promise<void>;
}

// ─── 服务清单 ───

export interface ServiceManifest {
  id: string;
  version: string;
  capabilities: string[];
  process: 'main' | 'renderer' | 'extension-host';
  dependencies?: string[];
}

// ─── 服务总线接口 ───

export interface IServiceBus {
  /** 请求-响应模式 */
  request<T = unknown>(service: string, method: string, params?: unknown): Promise<T>;

  /** 发布-订阅模式 */
  publish(topic: string, data: unknown): void;
  subscribe(topic: string, handler: (data: unknown) => void): Disposable;

  /** 服务注册 */
  registerService(manifest: ServiceManifest, instance: unknown): void;
  unregisterService(serviceId: string): void;
  getService<T>(serviceId: string): T | undefined;

  /** 本地处理器注册 (用于双向桥接) */
  handle(method: string, handler: (params: unknown) => unknown | Promise<unknown>): void;
  removeHandler(method: string): boolean;
  invokeLocal(method: string, params?: unknown): Promise<unknown>;

  /** 通知模式 (fire-and-forget) */
  notify(service: string, method: string, params?: unknown): void;
}
