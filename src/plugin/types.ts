/**
 * 插件系统类型定义
 *
 * 插件架构设计：
 * - 每个插件是一个符合 Plugin 接口的 JS 模块
 * - 插件通过 activate(context) 获取 API 能力
 * - 插件通过 deactivate() 清理资源
 * - 所有插件在渲染进程中运行，通过 API 层与主进程通信
 */

import type { FileEntry, FileSource } from '../services/fileService';

/* ─── 插件元数据 ─── */

export interface PluginManifest {
  /** 插件唯一标识（反向域名格式，如 com.example.my-plugin） */
  id: string;
  /** 插件名称 */
  name: string;
  /** 版本号 */
  version: string;
  /** 作者 */
  author?: string;
  /** 描述 */
  description?: string;
  /** 插件入口文件路径 */
  main: string;
  /** 激活事件（何时加载插件） */
  activationEvents?: string[];
  /** 贡献点配置 */
  contributes?: PluginContributes;
}

export interface PluginContributes {
  /** 命令定义 */
  commands?: PluginCommand[];
  /** 菜单项 */
  menus?: PluginMenu[];
  /** 配置项 */
  configuration?: PluginConfiguration[];
  /** 面板 */
  panels?: PluginPanel[];
}

export interface PluginCommand {
  id: string;
  title: string;
  icon?: string;
  keybinding?: string;
}

export interface PluginMenu {
  id: string;
  label: string;
  command?: string;
  group: string;
  order?: number;
  icon?: string;
  shortcut?: string;
  when?: string;
}

export interface PluginConfiguration {
  id: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  default: unknown;
  description?: string;
}

export interface PluginPanel {
  id: string;
  title: string;
  icon?: string;
}

/* ─── 插件上下文 API ─── */

/**
 * 文件系统 API
 */
export interface PluginFsApi {
  /** 读取文件内容 */
  readFile: (source: FileSource) => Promise<string>;
  /** 写入文件内容 */
  writeFile: (source: FileSource, content: string) => Promise<boolean>;
  /** 读取目录 */
  readDirectory: (source: FileSource) => Promise<FileEntry[]>;
  /** 监听文件变更 */
  watch: (path: string, callback: (event: { eventType: string; filename: string | null }) => void) => Promise<() => void>;
}

/**
 * 工作区 API
 */
export interface PluginWorkspaceApi {
  /** 获取当前根目录 */
  getRootSource: () => FileSource | null;
  /** 获取已打开的文件列表 */
  getOpenedFiles: () => { id: string; name: string; source: FileSource }[];
  /** 获取当前激活文件 */
  getActiveFile: () => { id: string; name: string; source: FileSource } | null;
  /** 打开文件 */
  openFile: (entry: FileEntry) => void;
  /** 监听文件打开事件 */
  onDidOpenFile: (callback: (file: { id: string; name: string; source: FileSource }) => void) => () => void;
  /** 监听激活文件变化 */
  onDidChangeActiveFile: (callback: (fileId: string | null) => void) => () => void;
}

/**
 * 命令 API
 */
export interface PluginCommandsApi {
  /** 注册命令 */
  registerCommand: (commandId: string, handler: (...args: unknown[]) => unknown) => () => void;
  /** 执行命令 */
  executeCommand: (commandId: string, ...args: unknown[]) => unknown;
  /** 监听命令执行 */
  onDidExecuteCommand: (callback: (commandId: string, args: unknown[]) => void) => () => void;
}

/**
 * 菜单 API
 */
export interface PluginMenusApi {
  /** 注册上下文菜单项 */
  registerMenuItem: (context: string, item: { id: string; label: string; group: string; order?: number; icon?: string; shortcut?: string; command?: string; when?: string }) => () => void;
}

/**
 * UI API
 */
export interface PluginUiApi {
  /** 注册状态栏项 */
  registerStatusBarItem: (id: string, options: { text: string; tooltip?: string; command?: string }) => () => void;
  /** 注册侧边栏面板 */
  registerPanel: (id: string, options: { title: string; render: () => HTMLElement }) => () => void;
  /** 显示/打开已注册的侧边栏面板或扩展视图 */
  showPanel: (id: string) => void;
  /** 显示通知消息 */
  showMessage: (message: string, type?: 'info' | 'warning' | 'error') => void;
  /** 显示输入框 */
  showInputBox: (options: { prompt: string; value?: string }) => Promise<string | undefined>;
  /** 显示快速选择 */
  showQuickPick: (items: string[], options?: { placeHolder?: string }) => Promise<string | undefined>;
}

/**
 * 编辑器 API
 */
export interface PluginEditorApi {
  /** 获取当前编辑器内容 */
  getValue: () => string | null;
  /** 设置编辑器内容 */
  setValue: (value: string) => void;
  /** 在当前位置插入文本 */
  insertText: (text: string) => void;
  /** 跳转到指定行列 */
  gotoLine: (line: number, column?: number) => void;
  /** 监听内容变更 */
  onDidChangeContent: (callback: (value: string) => void) => () => void;
}

/**
 * 插件上下文
 * 插件通过此对象访问 IDE 的所有能力
 */
export interface PluginContext {
  /** 插件唯一标识 */
  pluginId: string;
  /** 插件元数据 */
  manifest: PluginManifest;
  /** 插件存储（持久化数据） */
  storage: PluginStorage;
  /** 文件系统 */
  fs: PluginFsApi;
  /** 工作区 */
  workspace: PluginWorkspaceApi;
  /** 命令系统 */
  commands: PluginCommandsApi;
  /** UI 接口 */
  ui: PluginUiApi;
  /** 菜单接口 */
  menus: PluginMenusApi;
  /** 编辑器 */
  editor: PluginEditorApi;
  /** 订阅清理列表（插件卸载时自动调用） */
  subscriptions: (() => void)[];
}

/**
 * 插件存储接口
 */
export interface PluginStorage {
  /** 获取存储值 */
  get<T>(key: string, defaultValue?: T): T | undefined;
  /** 设置存储值 */
  set<T>(key: string, value: T): void;
  /** 删除存储值 */
  delete(key: string): void;
}

/* ─── 插件接口 ─── */

export interface Plugin {
  /** 插件元数据 */
  manifest: PluginManifest;
  /** 激活插件 */
  activate: (context: PluginContext) => void | Promise<void>;
  /** 停用插件 */
  deactivate?: () => void | Promise<void>;
}

/* ─── 插件管理器状态 ─── */

export interface PluginState {
  id: string;
  manifest: PluginManifest;
  isActive: boolean;
  error?: string;
}
