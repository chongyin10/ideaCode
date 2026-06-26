/**
 * 统一扩展 SDK 类型定义
 *
 * 替代现有的 4 套互不兼容的 API：
 * - extensions/git/api.js
 * - extensions/ssh/api.js
 * - extensions/lifeAiCode/api.js
 * - src/plugin/types.ts (PluginContext)
 */

import type { Disposable, Uri, Event } from '../ipc/index.js';
import type { IFileService, ITerminalService, IEditorService, IWorkspaceService, IUiService, IWebViewService, IConfigService, IStorageService, ISecretService } from '../services/index.js';

// ─── 扩展清单 ───

export interface ExtensionManifest {
  id: string;
  name: string;
  displayName?: string;
  version: string;
  description?: string;
  author?: string;
  publisher?: string;
  main: string;
  activationEvents?: string[];
  contributes?: {
    commands?: Array<{ command: string; title: string; category?: string; icon?: string }>;
    menus?: Record<string, Array<{ command: string; group?: string; order?: number; when?: string }>>;
    configuration?: { title: string; properties: Record<string, unknown> };
    views?: Record<string, Array<{ id: string; name: string; when?: string; actions?: Array<{ command: string; title?: string; icon?: string; tooltip?: string }> }>>;
    viewsContainers?: Record<string, Array<{ id: string; title: string; icon: string }>>;
  };
  dependencies?: Record<string, string>;
  capabilities?: Record<string, boolean>;
}

// ─── WebView 面板 ───

export interface WebviewPanel {
  readonly id: string;
  readonly viewType: string;
  readonly title: string;
  readonly webview: Webview;
  reveal(viewColumn?: number): void;
  dispose(): void;
  onDidDispose: Event<void>;
  onDidChangeViewState: Event<{ active: boolean; visible: boolean }>;
}

export interface Webview {
  html: string;
  options: Record<string, unknown>;
  cspSource: string;
  postMessage(message: unknown): void;
  onDidReceiveMessage: Event<unknown>;
  asWebviewUri(localResource: Uri): string;
}

// ─── 树数据提供者 ───

export interface TreeItem {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  tooltip?: string;
  collapsibleState?: 'none' | 'collapsed' | 'expanded';
  children?: TreeItem[];
  command?: { command: string; title: string; arguments?: unknown[] };
}

export interface TreeDataProvider {
  getChildren(element?: TreeItem): Promise<TreeItem[]>;
  getParent?(element: TreeItem): Promise<TreeItem | undefined>;
  getTreeItem(element: TreeItem): TreeItem;
  onDidChangeTreeData?: Event<TreeItem | undefined>;
}

// ─── 扩展上下文 (统一 SDK) ───

export interface ExtensionContext {
  /** 扩展唯一标识 */
  readonly extensionId: string;

  /** 扩展文件系统路径 */
  readonly extensionPath: string;

  /** 扩展 URI */
  readonly extensionUri: Uri;

  /** 持久化存储 (全局) */
  readonly globalState: ExtensionStorage;

  /** 持久化存储 (工作区) */
  readonly workspaceState: ExtensionStorage;

  /** 密钥存储 */
  readonly secrets: SecretStorage;

  /** 订阅列表 (停用时自动释放) */
  readonly subscriptions: Disposable[];

  /** 窗口 API */
  readonly window: WindowApi;

  /** 工作区 API */
  readonly workspace: WorkspaceApi;

  /** 命令 API */
  readonly commands: CommandApi;

  /** 编辑器 API */
  readonly editor: EditorApi;

  /** 终端 API */
  readonly terminal: TerminalApi;

  /** 文件系统 API */
  readonly fs: FileSystemApi;

  /** 语言特性 API */
  readonly languages: LanguageApi;

  /** 环境 API */
  readonly env: EnvironmentApi;
}

// ─── 各个子 API ───

export interface ExtensionStorage {
  get<T>(key: string, defaultValue?: T): Promise<T>;
  update(key: string, value: unknown): Promise<void>;
}

export interface SecretStorage {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface WindowApi {
  showInformationMessage(message: string, ...items: string[]): Promise<string | undefined>;
  showErrorMessage(message: string, ...items: string[]): Promise<string | undefined>;
  showWarningMessage(message: string, ...items: string[]): Promise<string | undefined>;
  createWebviewPanel(
    viewType: string,
    title: string,
    showOptions?: { preserveFocus?: boolean; modal?: boolean },
    options?: { enableScripts?: boolean; retainContextWhenHidden?: boolean; extensionId?: string; extensionPath?: string }
  ): WebviewPanel;
  createTerminal(options?: { name?: string; shellPath?: string; cwd?: string }): Terminal;
  showInputBox(options?: { prompt?: string; value?: string; password?: boolean; placeHolder?: string }): Promise<string | undefined>;
  showQuickPick(items: Array<{ label: string; description?: string; detail?: string }>, options?: { placeHolder?: string; canPickMany?: boolean }): Promise<string | string[] | undefined>;
  showOpenDialog(options?: { canSelectFiles?: boolean; canSelectFolders?: boolean; canSelectMany?: boolean; filters?: Record<string, string[]> }): Promise<Uri[] | undefined>;
  showSaveDialog(options?: { defaultUri?: Uri; filters?: Record<string, string[]> }): Promise<Uri | undefined>;
  registerTreeDataProvider(viewId: string, treeDataProvider: TreeDataProvider): Disposable;
  registerWebviewViewProvider(viewId: string, provider: WebviewViewProvider): Disposable;
  setStatusBarMessage(text: string, hideAfterTimeout?: number): Disposable;
}

export interface WorkspaceApi {
  getConfiguration(section?: string): WorkspaceConfiguration;
  openTextDocument(uri: Uri): Promise<TextDocument>;
  saveAll(): Promise<boolean>;
  getWorkspaceFolders(): Promise<WorkspaceFolder[]>;
  registerFileSystemProvider(scheme: string, provider: FileSystemProvider): Disposable;
  onDidChangeConfiguration: Event<void>;
  onDidOpenTextDocument: Event<TextDocument>;
  onDidCloseTextDocument: Event<TextDocument>;
  onDidSaveTextDocument: Event<TextDocument>;
}

export interface CommandApi {
  registerCommand(command: string, handler: (...args: unknown[]) => unknown): Disposable;
  executeCommand<T = unknown>(command: string, ...args: unknown[]): Promise<T>;
  getCommands(): Promise<string[]>;
}

export interface EditorApi {
  getActiveTextEditor(): TextEditor | undefined;
  getVisibleTextEditors(): TextEditor[];
  onDidChangeActiveTextEditor: Event<TextEditor | undefined>;
}

export interface TerminalApi {
  createTerminal(options?: { name?: string; shellPath?: string; cwd?: string; env?: Record<string, string> }): Terminal;
  onDidCloseTerminal: Event<Terminal>;
}

export interface FileSystemApi {
  readFile(uri: Uri): Promise<string>;
  writeFile(uri: Uri, content: string): Promise<void>;
  createDirectory(uri: Uri): Promise<void>;
  delete(uri: Uri, options?: { recursive?: boolean }): Promise<void>;
  rename(source: Uri, target: Uri, options?: { overwrite?: boolean }): Promise<void>;
  stat(uri: Uri): Promise<FileStat>;
  readDirectory(uri: Uri): Promise<[string, FileType][]>;
}

export interface LanguageApi {
  registerCompletionItemProvider(
    selector: DocumentSelector,
    provider: CompletionItemProvider
  ): Disposable;
  registerHoverProvider(
    selector: DocumentSelector,
    provider: HoverProvider
  ): Disposable;
  registerDefinitionProvider(
    selector: DocumentSelector,
    provider: DefinitionProvider
  ): Disposable;
  registerDocumentSemanticTokensProvider(
    selector: DocumentSelector,
    provider: unknown
  ): Disposable;
}

export interface EnvironmentApi {
  readonly appName: string;
  readonly appRoot: string;
  readonly language: string;
  readonly shell: string;
  readonly clipboard: { readText(): Promise<string>; writeText(text: string): Promise<void> };
  openExternal(uri: Uri): Promise<boolean>;
}

// ─── 辅助类型 ───

export interface WorkspaceFolder {
  uri: Uri;
  name: string;
  index: number;
}

export type WorkspaceConfiguration = {
  get<T>(key: string, defaultValue?: T): T;
  update(key: string, value: unknown): Promise<void>;
  has(key: string): boolean;
  inspect<T>(key: string): { key: string; defaultValue?: T; globalValue?: T; workspaceValue?: T } | undefined;
};

export interface TextDocument {
  readonly uri: Uri;
  readonly fileName: string;
  readonly languageId: string;
  readonly version: number;
  readonly isDirty: boolean;
  readonly isUntitled: boolean;
  readonly lineCount: number;
  getText(range?: Range): string;
  lineAt(line: number): TextLine;
}

export interface TextLine {
  readonly lineNumber: number;
  readonly text: string;
  readonly range: Range;
}

export interface TextEditor {
  readonly document: TextDocument;
  readonly selection: Selection;
  readonly visibleRanges: Range[];
  edit(callback: (editBuilder: TextEditorEdit) => void): Promise<boolean>;
  revealRange(range: Range): void;
}

export interface TextEditorEdit {
  replace(location: Position | Range, value: string): void;
  insert(location: Position, value: string): void;
  delete(location: Range): void;
}

export interface Range {
  readonly start: Position;
  readonly end: Position;
}

export interface Position {
  readonly line: number;
  readonly character: number;
}

export interface Selection {
  readonly start: Position;
  readonly end: Position;
}

export interface Terminal {
  readonly name: string;
  readonly processId: Promise<number>;
  sendText(text: string, addNewLine?: boolean): void;
  show(preserveFocus?: boolean): void;
  hide(): void;
  dispose(): void;
  onDidWrite: Event<string>;
  onDidClose: Event<void>;
}

export interface FileStat {
  type: FileType;
  ctime: number;
  mtime: number;
  size: number;
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export type DocumentSelector = string | string[] | { language: string; scheme?: string; pattern?: string };

export interface CompletionItemProvider {
  provideCompletionItems(
    document: TextDocument,
    position: Position
  ): CompletionItem[] | Promise<CompletionItem[]>;
}

export interface CompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string;
  insertText?: string;
  sortText?: string;
}

export interface HoverProvider {
  provideHover(document: TextDocument, position: Position): Hover | Promise<Hover>;
}

export interface Hover {
  contents: string | Array<{ language: string; value: string }>;
  range?: Range;
}

export interface DefinitionProvider {
  provideDefinition(
    document: TextDocument,
    position: Position
  ): Definition | Promise<Definition>;
}

export type Definition = Uri | Uri[] | null;

export interface FileSystemProvider {
  readonly scheme: string;
  readDirectory(uri: Uri): Promise<[string, FileType][]>;
  readFile(uri: Uri): Promise<Uint8Array>;
  writeFile(uri: Uri, content: Uint8Array, options?: { create: boolean; overwrite: boolean }): Promise<void>;
  createDirectory(uri: Uri): Promise<void>;
  delete(uri: Uri, options?: { recursive: boolean }): Promise<void>;
  rename(oldUri: Uri, newUri: Uri, options?: { overwrite: boolean }): Promise<void>;
  stat(uri: Uri): Promise<FileStat>;
  watch(uri: Uri): Disposable;
}

export interface WebviewViewProvider {
  resolveWebviewView(
    webviewView: WebviewView,
    context: { state?: unknown },
    token: unknown
  ): void | Promise<void>;
}

export interface WebviewView {
  readonly viewType: string;
  readonly title: string;
  readonly webview: Webview;
  show?(preserveFocus?: boolean): void;
}
