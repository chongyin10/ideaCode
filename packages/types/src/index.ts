/**
 * @ideacode/types - 共享类型契约
 *
 * 微内核架构的基石：所有跨进程、跨模块的类型定义在此统一维护。
 * 替代分散的 channel 常量、重复的 API 桩、隐式的类型约定。
 */

// IPC 类型（无冲突）
export * from './ipc/index.js';

// 服务接口类型
export type {
  FileInfo,
  IFileService,
  FileChangeEvent,
  TerminalCreateOptions,
  ITerminalService,
  TerminalOutputEvent,
  TerminalExitEvent,
  EditorDocument,
  EditorSelection,
  IEditorService,
  WorkspaceFolderInfo,
  IWorkspaceService,
  GitStatus,
  GitChange,
  GitBranch,
  IGitService,
  ILspService,
  IWindowService,
  IDialogService,
  MessageType,
  IUiService,
  WebViewCreateParams,
  IWebViewService,
  SystemStats,
  ISystemService,
  IConfigService,
  IStorageService,
  ISecretService,
  ServiceManifest,
  IServiceBus,
} from './services/index.js';

// 扩展 SDK 类型
export * from './extensions/index.js';
