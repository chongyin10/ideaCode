/**
 * 扩展桥接模块
 *
 * 将 Extension Host 进程（JSON-RPC）与渲染进程的 Plugin System 桥接。
 *
 * 架构：
 * Extension Host (Node.js) ←→ Main Process ←→ Preload IPC ←→ Renderer (ExtensionBridge)
 *                                                          ↓
 *                                                    Plugin System (Redux)
 *
 * 职责：
 * 1. 接收 Extension Host 的 RPC 调用，转发到 Plugin System API
 * 2. 将 Plugin System 的事件推送到 Extension Host
 * 3. 管理扩展生命周期（扫描 → 激活 → 停用）
 * 4. 管理 WebView 面板（插件自定义 UI）
 */

import type { Store } from '@reduxjs/toolkit';
import type { RootState, AppDispatch } from '../store';
import { openFile, openVirtualFile, addWorkspaceFolder, removeWorkspaceFolder, setFileContent, markFileSaved, toggleAiEditMode, setGitStatus, setGitBranch, setExternalFileChange, reloadFilesFromDisk, closeFile } from '../store/slices/workspaceSlice';
import { addPanelToOrder, removePanelFromOrder, registerDockableItem, unregisterDockableItem, switchRightItem, setDockableItemBadge } from '../store/slices/layoutSlice';
import { readFile as fsReadFile, writeFile as fsWriteFile, isPath } from '../services/fileService';
import { getMonacoEditorActions } from '../services/monacoEditorBridge';
import { getPluginManager } from './core';
import type { PluginManifest } from './types';
import { terminalSDK, type TerminalCreateOptions } from '../services/terminalSDK';
import { normalizePathForCompare } from '../utils/pathNormalize';
import {
  registerViewContainer,
  unregisterViewContainer,
  registerView,
  unregisterView,
  createWebviewPanel,
  disposeWebviewPanel,
  setWebviewPanelHtml,
} from '../store/slices/extensionUISlice';
import {
  openModalWebview,
  setModalWebviewHtml,
  closeModalWebview,
  openTerminalModal,
} from '../store/slices/modalSlice';
import { registerFileSystemProvider } from '../services/fileSystemProvider';

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
  devDependencies?: Record<string, string>;
  capabilities?: Record<string, boolean>;
}

export interface ExtensionState {
  id: string;
  manifest: ExtensionManifest;
  path: string;
  activated: boolean;
  error?: string;
}

interface WebViewPanel {
  id: string;
  viewType: string;
  title: string;
  extensionPath: string;
  html?: string;
  visible: boolean;
  disposed: boolean;
}

/**
 * 扩展桥接器
 * 连接 Extension Host 与 Plugin System
 */
export class ExtensionBridge {
  private store: Store<RootState>;
  private extensions: Map<string, ExtensionState> = new Map();
  private rpcHandlers: Map<string, (params: unknown) => unknown | Promise<unknown>> = new Map();
  private unsubscribers: (() => void)[] = [];
  private isReady = false;
  private webviewPanels: Map<string, WebViewPanel> = new Map();
  private webviewMessageCallbacks: Map<string, ((message: unknown) => void)[]> = new Map();
  private disabledExtensions: Set<string> = new Set();

  /** 上一次通知 Git 扩展的 active file 相对路径 */
  private lastGitActivePath: string | null = null;

  constructor(store: Store<RootState>) {
    this.store = store;
    this._setupRpcHandlers();
    this._setupIpcListeners();
    this._subscribeActiveFile();
    this._subscribeWorkspaceRoot();
  }

  /**
   * 订阅工作区根目录变化，主动通知 Git 扩展加载仓库。
   * 消除 git 扩展 5 秒轮询延迟——用户打开文件夹后立即开始加载 git 状态。
   *
   * 注意：rpc 未就绪时【不】更新 lastRoot——否则 host 启动期间若 root 已变更，
   * 会被记录成 lastRoot，后续 host 就绪后 root 不再变化，openWorkspace 不会再被
   * 触发，导致 git 面板与当前项目结构脱节（显示上一个项目的 git 数据）。
   * 兜底由 _flushWorkspaceRoot() 在 initialize 完成后重放一次。
   */
  private _subscribeWorkspaceRoot(): void {
    let lastRoot: string | null = null;
    this.store.subscribe(() => {
      const root = this.store.getState().workspace.rootSource;
      const rootPath = typeof root === 'string' ? root : null;
      if (rootPath !== lastRoot) {
        if (!window.electronAPI?.extension?.rpc) return;
        lastRoot = rootPath;
        window.electronAPI.extension.rpc('ext.invoke', {
          extId: 'ideacode-git',
          method: 'openWorkspace',
          args: [{ path: rootPath }],
        }).catch(() => { /* git 扩展可能尚未激活，忽略 */ });
      }
    });
  }

  /**
   * host 就绪兜底：若 store 当前已有 root，但 _subscribeWorkspaceRoot 因 rpc 未就绪被跳过，
   * 在此主动通知一次 openWorkspace，确保 git 面板与当前项目结构一致。
   * openWorkspace 内部对相同 rootPath 会早退，重复调用是安全的。
   */
  private _flushWorkspaceRoot(): void {
    if (!window.electronAPI?.extension?.rpc) return;
    const root = this.store.getState().workspace.rootSource;
    const rootPath = typeof root === 'string' ? root : null;
    window.electronAPI.extension.rpc('ext.invoke', {
      extId: 'ideacode-git',
      method: 'openWorkspace',
      args: [{ path: rootPath }],
    }).catch(() => { /* ignore */ });
  }

  /**
   * 订阅当前激活文件变化，并通知 Git 扩展高亮对应变更文件
   */
  private _subscribeActiveFile(): void {
    this.store.subscribe(() => {
      const state = this.store.getState().workspace;
      const source = state.activeFileSource;
      const root = state.rootSource;

      if (!source || typeof source !== 'string' || !root || typeof root !== 'string') {
        if (this.lastGitActivePath !== null) {
          this.lastGitActivePath = null;
          this._notifyGitActiveFile(null);
        }
        return;
      }

      const rel = source.startsWith(root + '/') ? source.slice(root.length + 1) : null;
      if (rel && rel !== this.lastGitActivePath) {
        this.lastGitActivePath = rel;
        this._notifyGitActiveFile(rel);
      } else if (!rel && this.lastGitActivePath !== null) {
        this.lastGitActivePath = null;
        this._notifyGitActiveFile(null);
      }
    });
  }

  private _notifyGitActiveFile(path: string | null): void {
    if (!window.electronAPI?.extension?.rpc) return;
    window.electronAPI.extension.rpc('ext.invoke', {
      extId: 'ideacode-git',
      method: 'setActiveFile',
      args: [{ path }],
    }).catch(() => {});
  }

  /* ─── 初始化 ─── */

  async initialize(): Promise<void> {
    if (!window.electronAPI?.extension) {
      console.warn('[ExtensionBridge] Electron extension API 不可用，跳过扩展加载');
      return;
    }

    // 启动 Extension Host
    try {
      const result = await window.electronAPI.extension.startHost();
      if (!result.success) {
        console.warn('[ExtensionBridge] Extension Host 启动失败');
        return;
      }
    } catch {
      // Extension Host 可能已启动
    }

    // 等待 Extension Host 就绪
    await this._waitForHostReady();

    // 扫描扩展
    await this.scanExtensions();

    this.isReady = true;
    console.log('[ExtensionBridge] 扩展桥接已初始化', this.isReady);

    // host 就绪后兜底：若 host 启动期间 root 已变更但 rpc 未就绪，
    // _subscribeWorkspaceRoot 已被跳过。此处主动重放一次，确保 git 面板
    // 与当前项目结构一致（避免显示上一个项目的 git 缓存数据）。
    this._flushWorkspaceRoot();
  }

  private async _waitForHostReady(timeout = 10000): Promise<void> {
    const api = window.electronAPI?.extension;
    if (!api) throw new Error('Electron extension API 不可用');

    // 先尝试 ping：宿主可能已经在主进程启动时就绪并发送过 host.ready，
    // 避免因为订阅晚于通知而一直等待超时。
    try {
      const resp = (await api.rpc('host.ping', {})) as { result?: { pong?: boolean } } | undefined;
      if (resp?.result?.pong) {
        console.log('[ExtensionBridge] Extension Host 已通过 ping 就绪');
        return;
      }
    } catch {
      // 宿主尚未就绪，继续等待 host.ready 通知
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new Error('Extension Host 就绪超时'));
      }, timeout);

      const unsub = api.onMessage((msg) => {
        if (msg.method === 'host.ready') {
          clearTimeout(timer);
          unsub();
          resolve();
        }
      });
    });
  }

  /* ─── RPC 处理器 ─── */

  private _setupRpcHandlers(): void {
    // UI 消息
    this.rpcHandlers.set('ui.showMessage', (params) => {
      const { message, type } = params as { message: string; type: 'info' | 'warning' | 'error' };
      console.log(`[Extension] ${type}: ${message}`);
      // 使用原生 alert 作为临时通知方案（TODO: 替换为 toast 系统）
      if (typeof window !== 'undefined' && message) {
        try { window.alert(`[${type?.toUpperCase() || 'INFO'}] ${message}`); } catch { /* ignore */ }
      }
      return { shown: true };
    });

    // 命令注册
    this.rpcHandlers.set('commands.register', (params) => {
      const { command } = params as { command: string };
      const manager = getPluginManager();
      if (manager) {
        manager.getCommandManager().registerCommand(command, (...args: unknown[]) => {
          this.sendToHost('commands.execute', { command, args });
          return args;
        });
      }
      return { registered: true };
    });

    // 工作区 API
    this.rpcHandlers.set('workspace.getRootPath', () => {
      return this.store.getState().workspace.rootSource;
    });

    this.rpcHandlers.set('workspace.getFolders', () => {
      const root = this.store.getState().workspace.rootSource;
      return root ? [{ uri: { fsPath: root, scheme: 'file' }, name: 'workspace', index: 0 }] : [];
    });

    this.rpcHandlers.set('workspace.openDocument', (params) => {
      const { fileName } = params as { fileName: string };
      this.store.dispatch(openFile({ name: fileName, kind: 'file', source: fileName }) as any);
      return { opened: true };
    });

    this.rpcHandlers.set('workspace.openRemoteFileTree', (params) => {
      const { title, tree } = params as { title: string; tree: unknown };
      const id = `ssh-tree-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      this.store.dispatch(
        openVirtualFile({
          id,
          name: title || '远程目录结构',
          source: `ssh-tree://${id}`,
          content: JSON.stringify(tree),
          language: 'ssh-file-tree',
          isDirty: false,
        })
      );
      return { opened: true };
    });

    this.rpcHandlers.set('workspace.registerFileSystemProvider', (params) => {
      const { scheme, extensionId } = params as { scheme: string; extensionId: string };
      const proxy: Record<string, unknown> = { scheme };
      const methods = ['readDirectory', 'readFile', 'writeFile', 'createDirectory', 'delete', 'rename', 'stat'];
      for (const method of methods) {
        proxy[method] = async (...args: unknown[]) => {
          return this.invokeExtension(extensionId, 'callFileSystemProvider', [scheme, method, args]);
        };
      }
      registerFileSystemProvider(scheme, proxy as any);
      return { registered: true };
    });

    this.rpcHandlers.set('workspace.addWorkspaceFolder', (params) => {
      const { id, name, uri } = params as { id: string; name: string; uri: string };
      this.store.dispatch(addWorkspaceFolder({ id, name, source: uri }));
      return { added: true };
    });

    this.rpcHandlers.set('workspace.removeWorkspaceFolder', (params) => {
      const { id } = params as { id: string };
      this.store.dispatch(removeWorkspaceFolder(id));
      return { removed: true };
    });

    // 编辑器 API
    this.rpcHandlers.set('editor.getActive', () => {
      const state = this.store.getState().workspace;
      const file = state.openedFiles.find((f) => f.id === state.activeFileId);
      if (!file) return null;
      return {
        document: {
          uri: { fsPath: file.source, scheme: 'file' },
          fileName: typeof file.source === 'string' ? file.source : file.name,
          languageId: file.language,
          version: 1,
          isDirty: file.isDirty,
          isUntitled: false,
          content: file.content,
        },
        selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      };
    });

    this.rpcHandlers.set('editor.getVisible', () => {
      const state = this.store.getState().workspace;
      return state.openedFiles.map((file) => ({
        document: {
          uri: { fsPath: file.source, scheme: 'file' },
          fileName: typeof file.source === 'string' ? file.source : file.name,
          languageId: file.language,
          version: 1,
          isDirty: file.isDirty,
          isUntitled: false,
          content: file.content,
        },
        selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      }));
    });

    // 配置 API
    this.rpcHandlers.set('configuration.get', (params) => {
      const { section } = params as { section: string };
      const settings = this.store.getState().settings;
      return (settings as unknown as Record<string, unknown>)[section] || {};
    });

    // 存储 API
    this.rpcHandlers.set('storage.get', (params) => {
      const { prefix, key, defaultValue } = params as { prefix: string; key: string; defaultValue: unknown };
      const manager = getPluginManager();
      if (manager) {
        const storage = manager.getStorage(prefix);
        return { value: storage.get(key, defaultValue) };
      }
      return { value: defaultValue };
    });

    this.rpcHandlers.set('storage.set', (params) => {
      const { prefix, key, value } = params as { prefix: string; key: string; value: unknown };
      const manager = getPluginManager();
      if (manager) {
        const storage = manager.getStorage(prefix);
        storage.set(key, value);
      }
      return { saved: true };
    });

    // 密钥存储 API
    this.rpcHandlers.set('secrets.get', () => {
      // 使用安全的存储方式（如 keytar）
      return { value: null };
    });

    this.rpcHandlers.set('secrets.store', () => {
      return { stored: true };
    });

    this.rpcHandlers.set('secrets.delete', () => {
      return { deleted: true };
    });

    // 状态栏 API
    this.rpcHandlers.set('ui.statusBar.update', (params) => {
      const { id, text, tooltip, command } = params as { id: string; text: string; tooltip?: string; command?: string };
      console.log(`[StatusBar] ${id}: ${text} (${tooltip}) [${command}]`);
      return { updated: true };
    });

    this.rpcHandlers.set('ui.statusBar.hide', (params) => {
      const { id } = params as { id: string };
      console.log(`[StatusBar] 隐藏: ${id}`);
      return { hidden: true };
    });

    // WebView API
    this.rpcHandlers.set('webview.create', (params) => {
      const {
        id,
        viewType,
        title,
        showOptions,
        options,
        extensionPath,
      } = params as {
        id: string;
        viewType: string;
        title: string;
        showOptions?: Record<string, unknown>;
        options?: Record<string, unknown>;
        extensionPath?: string;
      };
      const isModal = showOptions?.modal === true;
      const payload = {
        id,
        viewType,
        title,
        html: '',
        extensionId: String(options?.extensionId || 'unknown'),
        extensionPath: String(extensionPath || options?.extensionPath || ''),
        visible: true,
      };
      if (isModal) {
        this.store.dispatch(openModalWebview(payload));
        console.log(`[WebView] 创建 Modal: ${id} (${title})`);
      } else {
        this.store.dispatch(createWebviewPanel(payload));
        console.log(`[WebView] 创建面板: ${id} (${title})`);
      }
      return { created: true };
    });

    this.rpcHandlers.set('webview.setHtml', (params) => {
      const { id, html } = params as { id: string; html: string };
      const modal = this.store.getState().modal.modalWebview;
      if (modal && modal.id === id) {
        this.store.dispatch(setModalWebviewHtml({ id, html }));
      } else {
        this.store.dispatch(setWebviewPanelHtml({ id, html }));
      }
      console.log(`[WebView] 设置 HTML: ${id} (${html.length} bytes)`);
      return { set: true };
    });

    this.rpcHandlers.set('webview.dispose', (params) => {
      const { id } = params as { id: string };
      const modal = this.store.getState().modal.modalWebview;
      if (modal && modal.id === id) {
        this.store.dispatch(closeModalWebview());
        console.log(`[WebView] 关闭 Modal: ${id}`);
      } else {
        this.store.dispatch(disposeWebviewPanel(id));
        console.log(`[WebView] 销毁面板: ${id}`);
      }
      return { disposed: true };
    });

    this.rpcHandlers.set('webview.reveal', (params) => {
      const { id } = params as { id: string };
      const state = this.store.getState();
      const webview = state.extensionUI.webviewPanels.find((p) => p.id === id);
      if (webview) {
        // 找到该 WebView 所属的 view container，并切换到右侧面板对应标签
        const view = state.extensionUI.views.find((v) => v.id === webview.viewType);
        const containerId = view?.containerId;
        const rightItem = state.layout.dockableItems.find(
          (i) => i.location === 'right' && i.sourceContainerId === containerId
        );
        if (rightItem) {
          this.store.dispatch(switchRightItem(rightItem.id));
        }
      }
      return { revealed: true };
    });

    this.rpcHandlers.set('webview.postMessage', (params) => {
      const { id, message } = params as { id: string; message: unknown };
      this.postMessageToWebView(id, message);
      return { posted: true };
    });

    this.rpcHandlers.set('webview.message', (params) => {
      const { id, message } = params as { id: string; message: unknown };
      // 派发到已注册的 WebView 消息回调
      this.postMessageToWebView(id, message);
      return { received: true };
    });

    // 树视图注册
    this.rpcHandlers.set('tree.register', (params) => {
      const { viewId } = params as { viewId: string };
      console.log(`[TreeView] 注册: ${viewId}`);
      return { registered: true };
    });

    this.rpcHandlers.set('tree.unregister', (params) => {
      const { viewId } = params as { viewId: string };
      console.log(`[TreeView] 注销: ${viewId}`);
      return { unregistered: true };
    });

    // WebViewView 注册
    this.rpcHandlers.set('webviewView.register', (params) => {
      const { viewId } = params as { viewId: string };
      console.log(`[WebViewView] 注册: ${viewId}`);
      return { registered: true };
    });

    this.rpcHandlers.set('webviewView.unregister', (params) => {
      const { viewId } = params as { viewId: string };
      console.log(`[WebViewView] 注销: ${viewId}`);
      return { unregistered: true };
    });

    // 环境 API
    this.rpcHandlers.set('env.clipboard.writeText', (params) => {
      const { text } = params as { text: string };
      navigator.clipboard.writeText(text).catch(console.error);
      return { written: true };
    });

    this.rpcHandlers.set('env.clipboard.readText', async () => {
      try {
        const text = await navigator.clipboard.readText();
        return { text };
      } catch {
        return { text: '' };
      }
    });

    this.rpcHandlers.set('env.openExternal', (params) => {
      const { uri } = params as { uri: string };
      window.open(uri, '_blank');
      return { opened: true };
    });

    // 终端创建（由扩展请求，转交给 TerminalSDK 处理）
    this.rpcHandlers.set('terminal.create', async (params) => {
      const { requestId, ...options } = (params as TerminalCreateOptions & { requestId?: string }) || {};
      const result = await terminalSDK.createTab(options);
      if (!result.success) {
        if (requestId) {
          this.sendToHost('terminal.created', { requestId, success: false, error: result.error }).catch(() => {});
        }
        return { success: false, error: result.error };
      }

      const { tabId, processId } = result;
      if (!tabId) {
        return { success: false, error: '未返回 tabId' };
      }

      // 转发终端输出/退出事件到 Extension Host，实现扩展与终端双向互通
      const unsubOutput = terminalSDK.onTabOutput(tabId, (data) => {
        this.sendToHost('terminal.data', { tabId, processId, data }).catch(() => {});
      });
      const unsubExit = terminalSDK.onTabExit(tabId, (exitCode) => {
        this.sendToHost('terminal.exit', { tabId, processId, exitCode }).catch(() => {});
        unsubOutput();
        unsubExit();
      });

      if (requestId) {
        this.sendToHost('terminal.created', { requestId, tabId, processId, success: true }).catch(() => {});
      }
      return { success: true, tabId, processId };
    });

    // 终端输入、显示、隐藏、销毁
    this.rpcHandlers.set('terminal.sendInput', async (params) => {
      const { tabId, text } = params as { tabId: string; text: string };
      await terminalSDK.sendInputByTabId(tabId, text);
      return { sent: true };
    });

    this.rpcHandlers.set('terminal.dispose', (params) => {
      const { tabId } = params as { tabId: string };
      terminalSDK.disposeTab(tabId).catch((err) => {
        console.error('[ExtensionBridge] 处置终端失败:', err);
      });
      return { disposed: true };
    });

    this.rpcHandlers.set('terminal.show', (params) => {
      const { tabId } = params as { tabId?: string };
      if (tabId) {
        terminalSDK.showTab(tabId);
      } else {
        terminalSDK.showPanel();
      }
      return { shown: true };
    });

    this.rpcHandlers.set('terminal.hide', () => {
      terminalSDK.hidePanel();
      return { hidden: true };
    });

    this.rpcHandlers.set('terminal.openInModal', (params) => {
      const { tabId, title } = params as { tabId: string; title?: string };
      if (!tabId) {
        return { opened: false, error: '缺少 tabId' };
      }
      this.store.dispatch(openTerminalModal({ tabId, title }));
      return { opened: true };
    });

    /* ─── LifeAiCode AI 助手 ─── */

    /**
     * lifeAiCode.applyChanges — 用户确认 AI 建议后，执行文件写入
     *
     * 核心设计原则：
     * - 只有此 RPC 方法可以写入文件
     * - 只有在用户通过 WebView 明确接受建议后，此方法才会被调用
     * - 每次写入前都会做安全检查（路径有效性）
     */
    /**
     * lifeAiCode.editCode — AI 直接编辑当前编辑器内容
     *
     * 仅在 aiEditMode=true 时可用。
     * 直接修改 Monaco Editor buffer + Redux 状态。
     */
    this.rpcHandlers.set('lifeAiCode.editCode', async (params) => {
      const { action, text, filePath: _filePath, startLine, startCol, endLine, endCol } = params as {
        action: 'setValue' | 'insertText' | 'replaceRange';
        text: string;
        filePath?: string;
        startLine?: number;
        startCol?: number;
        endLine?: number;
        endCol?: number;
      };

      // 检查 AI 编辑模式是否开启
      const aiEditMode = this.store.getState().workspace.aiEditMode;
      if (!aiEditMode) {
        return { success: false, error: 'AI 编辑模式未开启，请在状态栏切换' };
      }

      try {
        const actions = getMonacoEditorActions();

        if (!actions || !actions.getEditor()) {
          return { success: false, error: '没有活动的编辑器实例' };
        }

        switch (action) {
          case 'setValue':
            actions.setValue(text);
            break;
          case 'insertText':
            actions.insertText(text);
            break;
          case 'replaceRange':
            if (startLine == null || endLine == null) {
              return { success: false, error: 'replaceRange 需要 startLine/endLine' };
            }
            actions.replaceRange(
              startLine, startCol || 1,
              endLine, endCol || 1,
              text
            );
            break;
          default:
            return { success: false, error: `未知操作: ${action}` };
        }

        console.log('[LifeAiCode] AI 已编辑代码:', action, text.slice(0, 50));
        return { success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[LifeAiCode] editCode 失败:', msg);
        return { success: false, error: msg };
      }
    });

    this.rpcHandlers.set('lifeAiCode.toggleEditMode', async () => {
      this.store.dispatch(toggleAiEditMode());
      const isEditMode = this.store.getState().workspace.aiEditMode;
      return { enabled: isEditMode };
    });

    this.rpcHandlers.set('lifeAiCode.applyChanges', async (params) => {
      const {
        filePath,
        content,
        original,
        modified,
      } = params as {
        filePath: string;
        content?: string;
        original?: string | string[];
        modified?: string | string[];
      };

      if (!filePath) {
        console.error('[LifeAiCode] applyChanges: 缺少 filePath');
        return { success: false, error: '缺少 filePath' };
      }

      // 安全检查：解析真实路径，确保在工作区内
      const workspaceRoot = this.store.getState().workspace.rootSource;
      if (!workspaceRoot || !isPath(workspaceRoot)) {
        console.error('[LifeAiCode] applyChanges: 没有打开工作区或工作区路径无效', filePath);
        return { success: false, error: '没有打开工作区' };
      }

      // §需求：AI 修改文件时 extension-host 传入的 filePath 可能是相对路径
      // （如 "src/pages/Home.tsx"），与绝对工作区根路径拼接后做前缀校验。
      // 注意：浏览器环境不能用 Node 的 path.resolve，用 normalizePathForCompare
      // 规范化后比较。
      // 先用 startsWith('/' | '\\\\') 粗略判断"是否已经是绝对路径"（兼容 Windows 盘符），
      // 不复用 isPath() 类型守卫——它对 string 类型推断为 never，会报类型错误。
      const looksAbsolute = /^[a-zA-Z]:[\\\\/]/.test(filePath) || filePath.startsWith('/');
      const resolvedFilePath = looksAbsolute
        ? filePath
        : `${workspaceRoot.replace(/[/\\]+$/, '')}/${filePath.replace(/^[/\\]+/, '')}`;
      const normalizedTarget = normalizePathForCompare(resolvedFilePath);
      const normalizedRoot = normalizePathForCompare(workspaceRoot);
      if (!normalizedTarget.startsWith(normalizedRoot)) {
        console.error('[LifeAiCode] applyChanges: 拒绝写入工作区外', filePath);
        return { success: false, error: '拒绝写入工作区外' };
      }

      try {
        let newContent: string;

        if (content !== undefined) {
          // 旧协议/全量写入
          newContent = content;
        } else {
          // 安全 find-and-replace：基于当前文件内容逐条替换
          const originals = Array.isArray(original) ? original : original !== undefined ? [original] : [];
          const modifieds = Array.isArray(modified) ? modified : modified !== undefined ? [modified] : [];

          if (originals.length === 0 || originals.length !== modifieds.length) {
            return { success: false, error: 'original 与 modified 参数不匹配' };
          }

          let currentContent = '';
          try {
            // §使用 resolve 后的绝对路径读取文件，避免后续 fsService 拒绝相对路径
            currentContent = await fsReadFile(resolvedFilePath);
          } catch (readErr) {
            const msg = readErr instanceof Error ? readErr.message : String(readErr);
            console.error('[LifeAiCode] applyChanges: 读取文件失败', msg);
            return { success: false, error: `读取文件失败: ${msg}` };
          }

          newContent = currentContent;
          for (let i = 0; i < originals.length; i += 1) {
            const from = originals[i];
            const to = modifieds[i];
            if (from === to || !from) continue;
            if (!newContent.includes(from)) {
              console.warn('[LifeAiCode] applyChanges: 原始代码未找到，跳过:', filePath);
              continue;
            }
            newContent = newContent.replace(from, to);
          }

          if (newContent === currentContent) {
            console.warn('[LifeAiCode] applyChanges: 文件内容无变化:', filePath);
            return { success: false, error: '文件内容无变化，未写入' };
          }
        }

        // 使用文件服务写入文件（用 resolve 后的绝对路径，避免 fsService 拒绝相对路径）
        await fsWriteFile(resolvedFilePath, newContent);

        // 更新 Redux 状态：openedFile.source 存的是绝对路径，用 resolvedFilePath 匹配
        const state = this.store.getState().workspace;
        const openedFile = state.openedFiles.find((f) => {
          const src = typeof f.source === 'string' ? f.source : '';
          return src === resolvedFilePath || src === filePath;
        });

        if (openedFile) {
          this.store.dispatch(setFileContent({ id: openedFile.id, content: newContent }));
          this.store.dispatch(markFileSaved(openedFile.id));
        }

        console.log('[LifeAiCode] 已应用变更到:', filePath, '→', resolvedFilePath);
        return { success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[LifeAiCode] 写入文件失败:', msg);
        return { success: false, error: msg };
      }
    });

    /**
     * lifeAiCode.deleteFile — 用户确认 AI 删除建议后，执行文件删除
     *
     * 安全措施：
     * - 路径必须在工作区内
     * - 使用 window.electronAPI.fs.delete（主进程执行）
     * - 删除后从编辑器关闭该文件标签（如已打开）
     */
    this.rpcHandlers.set('lifeAiCode.deleteFile', async (params) => {
      const { filePath } = params as { filePath: string };

      if (!filePath) {
        console.error('[LifeAiCode] deleteFile: 缺少 filePath');
        return { success: false, error: '缺少 filePath' };
      }

      const workspaceRoot = this.store.getState().workspace.rootSource;
      if (!workspaceRoot || !isPath(workspaceRoot)) {
        console.error('[LifeAiCode] deleteFile: 没有打开工作区或工作区路径无效', filePath);
        return { success: false, error: '没有打开工作区' };
      }

      const looksAbsolute = /^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith('/');
      const resolvedFilePath = looksAbsolute
        ? filePath
        : `${workspaceRoot.replace(/[/\\]+$/, '')}/${filePath.replace(/^[/\\]+/, '')}`;
      const normalizedTarget = normalizePathForCompare(resolvedFilePath);
      const normalizedRoot = normalizePathForCompare(workspaceRoot);
      if (!normalizedTarget.startsWith(normalizedRoot)) {
        console.error('[LifeAiCode] deleteFile: 拒绝删除工作区外文件', filePath);
        return { success: false, error: '拒绝删除工作区外文件' };
      }

      try {
        if (!window.electronAPI?.fs?.delete) {
          return { success: false, error: '当前环境不支持删除文件' };
        }
        const ok = await window.electronAPI.fs.delete(resolvedFilePath);
        if (!ok) {
          return { success: false, error: '删除文件失败（文件可能不存在或无权限）' };
        }

        // 从编辑器关闭该文件标签（如已打开）
        const state = this.store.getState().workspace;
        const openedFile = state.openedFiles.find((f) => {
          const src = typeof f.source === 'string' ? f.source : '';
          return src === resolvedFilePath || src === filePath;
        });
        if (openedFile) {
          this.store.dispatch(closeFile(openedFile.id));
        }

        console.log('[LifeAiCode] 已删除文件:', filePath, '→', resolvedFilePath);
        return { success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[LifeAiCode] 删除文件失败:', msg);
        return { success: false, error: msg };
      }
    });

    /* ─── Git 扩展 ─── */
    // 这些 RPC 由 web/git 扩展调用，用于与 IDE 主进程交互
    // （打开文件、加载目录、克隆仓库等需要主进程能力的操作）

    /** 获取当前工作区根路径 */
    this.rpcHandlers.set('workspace.getRootPath', () => {
      const root = this.store.getState().workspace.rootSource;
      return typeof root === 'string' ? root : null;
    });

    /** 在 IDE 中打开一个文件（普通模式或 Diff 模式） */
    this.rpcHandlers.set('git.openFile', async (params) => {
      const {
        path,
        original = '',
        modified = '',
        isBinary = false,
      } = params as {
        path: string;
        staged?: boolean;
        original?: string;
        modified?: string;
        isBinary?: boolean;
      };
      if (!path || typeof path !== 'string') {
        return { success: false, error: '缺少 path 参数' };
      }
      const root = this.store.getState().workspace.rootSource;
      if (!root || typeof root !== 'string') {
        return { success: false, error: '没有打开的工作区' };
      }
      const base = String(root).replace(/\/$/, '');
      const fullPath = `${base}/${path}`;
      const fileName = path.split('/').pop() || path;

      // 根据文件扩展名推断 Monaco 语言（统一走 utils/languageFromPath，
      // 保证与 openFile thunk 使用同一套规则，避免遗漏 .mts/.cts 等变体）
      const { getLanguageFromPath } = await import('../utils/languageFromPath');
      const language = getLanguageFromPath(path);

      try {
        const { openFile, openDiffView } = await import('../store/slices/workspaceSlice');

        // 二进制文件无法 Diff，回退为普通打开
        if (isBinary) {
          this.store.dispatch(
            openFile({
              name: fileName,
              kind: 'file',
              source: fullPath,
            }) as any
          );
          return { success: true };
        }

        // 原 HEAD 内容或当前工作区内容均为空（极少见，例如全新仓库没有任何提交），
        // 直接打开文件而不是空 Diff，避免无意义的视图
        if (!original && !modified) {
          this.store.dispatch(
            openFile({
              name: fileName,
              kind: 'file',
              source: fullPath,
            }) as any
          );
          return { success: true };
        }

        // 打开 Diff 视图：左侧 = HEAD（原始），右侧 = 工作树（修改后）
        this.store.dispatch(
          openDiffView({
            filePath: fullPath,
            fileName,
            original,
            modified,
            language,
          }) as any
        );
        return { success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: msg };
      }
    });

    /** 在 IDE 中打开纯内存内容的 Diff 视图（不依赖工作区磁盘文件） */
    this.rpcHandlers.set('editor.openDiff', async (params) => {
      const { filePath, original = '', modified = '' } = params as {
        filePath: string;
        original?: string;
        modified?: string;
      };
      if (!filePath || typeof filePath !== 'string') {
        return { success: false, error: '缺少 filePath 参数' };
      }
      const fileName = filePath.split(/[\\/]/).pop() || filePath;
      const { getLanguageFromPath } = await import('../utils/languageFromPath');
      const language = getLanguageFromPath(filePath);
      try {
        // 当 original 为空（AI 只提供了新增行 + 而没有 - 原始行）时，
        // 尝试从磁盘读取当前文件内容作为 original，确保 DiffEditor 左右两栏都有内容。
        // 新文件场景（文件不存在）original 保持空字符串，左侧显示空白表示全新文件。
        let originalContent = original;
        if (!originalContent && isPath(filePath)) {
          try {
            originalContent = await fsReadFile(filePath);
          } catch {
            // 文件不存在或读取失败，original 保持空字符串
          }
        }
        const { openDiffView } = await import('../store/slices/workspaceSlice');
        this.store.dispatch(
          openDiffView({
            filePath,
            fileName,
            original: originalContent,
            modified,
            language,
          }) as any
        );
        return { success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: msg };
      }
    });

    /** 加载目录（git 扩展要求打开新仓库时调用） */
    this.rpcHandlers.set('git.loadDirectory', async (params) => {
      const { path } = params as { path: string };
      if (!path || typeof path !== 'string') {
        return { success: false, error: '缺少 path 参数' };
      }
      try {
        const { loadDirectory } = await import('../store/slices/workspaceSlice');
        this.store.dispatch(
          loadDirectory({ source: path, name: path.split(/[\\/]/).pop() || path }) as any
        );
        return { success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: msg };
      }
    });

    /** Git 扩展推送文件状态映射 */
    this.rpcHandlers.set('git.statusChanged', (params) => {
      const { status } = (params || {}) as { status?: Record<string, string> };
      this.store.dispatch(setGitStatus(status || {}));
      return { updated: true };
    });

    /** Git 扩展推送当前分支名 */
    this.rpcHandlers.set('git.branchChanged', (params) => {
      const { branch } = (params || {}) as { branch?: string };
      this.store.dispatch(setGitBranch(branch || null));
      return { updated: true };
    });

    /** Git 扩展通知文件被外部修改（如 discard / checkout 恢复文件）。
     *  触发资源管理器精准刷新受影响目录 + 强制重载已打开的编辑器内容。 */
    this.rpcHandlers.set('git.filesChanged', (params) => {
      const { paths } = (params || {}) as { paths?: string[] };
      const fileList = paths || [];
      if (fileList.length === 0) return { updated: true };

      const state = this.store.getState() as RootState;
      const rootSource = state.workspace.rootSource;
      const rootPath = typeof rootSource === 'string' ? rootSource : '';

      // 1. 通知资源管理器刷新受影响目录（ExplorerContent 监听后 dispatch refreshDirectory + notifyChange）
      this.store.dispatch(setExternalFileChange({ paths: fileList, timestamp: Date.now() }));

      // 2. 强制重载被 discard 的已打开文件（清除 isDirty，因为修改已被放弃）
      // 注意：渲染进程无法使用 Node 的 path 模块（Vite 会将其外部化为空对象），
      // git 返回的 paths 以 '/' 分隔，rootPath 通常末尾不带斜杠，直接拼接即可
      if (rootPath) {
        const normalizedRoot = rootPath.replace(/[/\\]+$/, '');
        const absolutePaths = fileList.map((p) => `${normalizedRoot}/${p.replace(/^[/\\]+/, '')}`);
        // reloadFilesFromDisk 是 thunk，Store<RootState>.dispatch 不接受 thunk action，
        // 需 cast 为 AppDispatch（包含 thunk 中间件类型）
        (this.store.dispatch as AppDispatch)(reloadFilesFromDisk(absolutePaths));
      }

      return { updated: true };
    });

    /** 扩展设置 ActivityBar 徽标 */
    this.rpcHandlers.set('ui.activityBar.setBadge', (params) => {
      const { id, badge } = params as { id: string; badge?: number };
      this.store.dispatch(setDockableItemBadge({ id, badge }));
      return { updated: true };
    });

    /** 弹出原生目录选择对话框 */
    this.rpcHandlers.set('git.openRepositoryDialog', async () => {
      try {
        const selected = await window.electronAPI?.dialog?.openDirectory?.();
        return selected || null;
      } catch {
        return null;
      }
    });

    /** 克隆远程仓库（web/git 扩展调用，使用 child_process 直接 spawn git） */
    this.rpcHandlers.set('git.clone', async (params) => {
      const { url, targetPath } = params as { url: string; targetPath: string };
      if (!url || !targetPath) {
        return { success: false, error: '缺少 url 或 targetPath' };
      }
      try {
        const { loadDirectory } = await import('../store/slices/workspaceSlice');
        // web/git 扩展会自行执行 git clone（在自己的子进程中）
        // 克隆完成后通过 loadDirectory 加载到 IDE
        this.store.dispatch(
          loadDirectory({ source: targetPath, name: targetPath.split(/[\\/]/).pop() || targetPath }) as any
        );
        return { success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: msg };
      }
    });
  }

  /* ─── IPC 监听 ─── */

  private _setupIpcListeners(): void {
    if (!window.electronAPI?.extension) return;

    const unsubMessage = window.electronAPI.extension.onMessage((msg) => {
      this._handleHostMessage(msg);
    });
    this.unsubscribers.push(unsubMessage);

    if (window.electronAPI.extension.onRequest) {
      const unsubRequest = window.electronAPI.extension.onRequest((msg) => {
        this._handleRendererRequest(msg);
      });
      this.unsubscribers.push(unsubRequest);
    }
  }

  private async _handleHostMessage(msg: { method: string; params?: unknown; id?: number }): Promise<void> {
    // 处理 host.ready 通知
    if (msg.method === 'host.ready') {
      console.log('[ExtensionBridge] Extension Host 已就绪');
      return;
    }

    const handler = this.rpcHandlers.get(msg.method);
    if (!handler) {
      console.warn(`[ExtensionBridge] 未处理的 RPC 方法: ${msg.method}`);
      return;
    }

    try {
      await handler(msg.params || {});
    } catch (err) {
      console.error(`[ExtensionBridge] RPC 处理失败 ${msg.method}:`, err);
    }
  }

  /**
   * 处理主进程转发来的 Extension Host 请求（需要响应）
   */
  private async _handleRendererRequest(msg: { id: number; method: string; params?: unknown }): Promise<void> {
    const { id, method } = msg;
    const handler = this.rpcHandlers.get(method);
    if (!handler) {
      window.electronAPI?.extension?.sendResponse(id, { error: `Method not found: ${method}` });
      return;
    }

    try {
      const result = await handler(msg.params || {});
      window.electronAPI?.extension?.sendResponse(id, { result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ExtensionBridge] 渲染进程请求处理失败 ${method}:`, err);
      window.electronAPI?.extension?.sendResponse(id, { error: message });
    }
  }

  /* ─── 扩展管理 ─── */

  async scanExtensions(): Promise<ExtensionState[]> {
    if (!window.electronAPI?.extension?.rpc) return [];

    try {
      const response = await window.electronAPI.extension.rpc('ext.scan', {});
      const result = (response as { result?: { manifests: Array<{ id: string; manifest: ExtensionManifest; path?: string }> } }).result;
      const manifests = result?.manifests || [];

      for (const { id, manifest, path } of manifests) {
        const isDisabled = this.disabledExtensions.has(id);
        this.extensions.set(id, {
          id,
          manifest,
          path: path || '',
          activated: false,
        });

        // 注册到 Plugin System（只注册 manifest，不激活）
        const manager = getPluginManager();
        if (manager) {
          const pluginManifest: PluginManifest = {
            id: manifest.id || manifest.name,
            name: manifest.name,
            version: manifest.version,
            description: manifest.description,
            author: manifest.author,
            main: manifest.main,
            activationEvents: manifest.activationEvents,
            contributes: manifest.contributes ? {
              commands: manifest.contributes.commands?.map((c) => ({
                id: c.command,
                title: c.title,
                icon: c.icon,
              })),
              menus: [],
              configuration: [],
              panels: [],
            } : undefined,
          };
          manager.register(pluginManifest);
        }

        // 自动激活有 onStartupFinished 的扩展（禁用的除外）
        if (!isDisabled && manifest.activationEvents?.includes('onStartupFinished')) {
          console.log(`[ExtensionBridge] 自动激活扩展: ${id}`);
          await this.activateExtension(id);
        }
      }

      return this.getAllExtensions();
    } catch (err) {
      console.error('[ExtensionBridge] 扫描扩展失败:', err);
      return [];
    }
  }

  async activateExtension(extId: string): Promise<boolean> {
    if (!window.electronAPI?.extension?.rpc) return false;

    const ext = this.extensions.get(extId);
    if (!ext) {
      console.warn(`[ExtensionBridge] 扩展未找到: ${extId}`);
      return false;
    }

    this.disabledExtensions.delete(extId);

    if (ext.activated) return true;

    try {
      await window.electronAPI.extension.rpc('ext.activate', { extId });
      ext.activated = true;
      console.log(`[ExtensionBridge] 扩展已激活: ${extId}`);

      // 注册扩展贡献的视图容器到 Redux
      const manifest = ext.manifest;
      if (manifest.contributes?.viewsContainers?.activitybar) {
        for (const container of manifest.contributes.viewsContainers.activitybar) {
          this.store.dispatch(registerViewContainer({
            id: container.id,
            title: container.title,
            icon: container.icon,
            extensionId: extId,
          }));
          this.store.dispatch(registerDockableItem({
            id: container.id,
            title: container.title,
            icon: container.icon,
            location: 'left',
            type: 'viewContainer',
            sourceContainerId: container.id,
          }));
          this.store.dispatch(addPanelToOrder(container.id));
        }
      }
      if (manifest.contributes?.views) {
        for (const [containerId, views] of Object.entries(manifest.contributes.views)) {
          for (const view of views) {
            this.store.dispatch(registerView({
              id: view.id,
              name: view.name,
              containerId,
              extensionId: extId,
              actions: view.actions,
            }));
          }
        }
      }

      return true;
    } catch (err) {
      ext.error = err instanceof Error ? err.message : String(err);
      console.error(`[ExtensionBridge] 激活扩展失败 ${extId}:`, ext.error);
      return false;
    }
  }

  async deactivateExtension(extId: string): Promise<boolean> {
    if (!window.electronAPI?.extension?.rpc) return false;

    const ext = this.extensions.get(extId);
    if (!ext || !ext.activated) return true;

    try {
      await window.electronAPI.extension.rpc('ext.deactivate', { extId });
      ext.activated = false;
      ext.error = undefined;
      console.log(`[ExtensionBridge] 扩展已停用: ${extId}`);
      return true;
    } catch (err) {
      console.error(`[ExtensionBridge] 停用扩展失败 ${extId}:`, err);
      return false;
    }
  }

  private unregisterExtensionContributions(extId: string) {
    const ext = this.extensions.get(extId);
    if (!ext) return;
    const manifest = ext.manifest;
    if (manifest.contributes?.viewsContainers?.activitybar) {
      for (const container of manifest.contributes.viewsContainers.activitybar) {
        this.store.dispatch(unregisterViewContainer(container.id));
        this.store.dispatch(unregisterDockableItem(container.id));
        this.store.dispatch(removePanelFromOrder(container.id));
      }
    }
    if (manifest.contributes?.views) {
      for (const [, views] of Object.entries(manifest.contributes.views)) {
        for (const view of views) {
          this.store.dispatch(unregisterView(view.id));
        }
      }
    }
    const webviewPanels = this.store.getState().extensionUI.webviewPanels;
    for (const panel of webviewPanels) {
      if (panel.extensionId === extId) {
        this.store.dispatch(disposeWebviewPanel(panel.id));
      }
    }
  }

  async disableExtension(extId: string): Promise<{ success: boolean; error?: string }> {
    const ext = this.extensions.get(extId);
    if (!ext?.path) return { success: false, error: '扩展不存在' };

    this.disabledExtensions.add(extId);
    await this.deactivateExtension(extId);
    ext.activated = false;
    this.unregisterExtensionContributions(extId);

    // 删除 node_modules，使扩展进入“未启用/需重新安装依赖”状态
    const nodeModulesPath = `${ext.path}/node_modules`;
    try {
      if (window.electronAPI?.fs?.delete) {
        await window.electronAPI.fs.delete(nodeModulesPath);
      }
    } catch (err) {
      console.warn(`[ExtensionBridge] 禁用扩展时删除 node_modules 失败 ${extId}:`, err);
    }

    console.log(`[ExtensionBridge] 扩展已禁用: ${extId}`);
    return { success: true };
  }

  async enableExtension(extId: string): Promise<{ success: boolean; error?: string }> {
    const ext = this.extensions.get(extId);
    if (!ext?.path) return { success: false, error: '扩展不存在' };

    this.disabledExtensions.delete(extId);

    // 如果有依赖，先安装
    const hasDeps = ext.manifest.dependencies && Object.keys(ext.manifest.dependencies).length > 0;
    if (hasDeps && window.electronAPI?.extension?.install) {
      try {
        const installResult = await window.electronAPI.extension.install(ext.path);
        if (!installResult.success) {
          return { success: false, error: installResult.stderr || installResult.error || '依赖安装失败' };
        }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    const activated = await this.activateExtension(extId);
    if (!activated) {
      return { success: false, error: '扩展激活失败' };
    }
    return { success: true };
  }

  async uninstallExtension(extId: string): Promise<{ success: boolean; error?: string }> {
    const ext = this.extensions.get(extId);
    if (!ext?.path) return { success: false, error: '扩展不存在' };

    this.disabledExtensions.delete(extId);

    // 安全检查：只能删除 extensions 目录下的文件夹
    if (ext.path.includes('..') || !/[\\/]extensions[\\/][^\\/]+$/.test(ext.path)) {
      return { success: false, error: `路径不在 extensions 目录下: ${ext.path}` };
    }

    if (ext.activated) {
      await this.deactivateExtension(extId);
    }

    let deleteError: string | undefined;

    // 优先使用扩展卸载 IPC（带服务端校验）
    if (window.electronAPI?.extension?.uninstall) {
      try {
        const result = await window.electronAPI.extension.uninstall(ext.path);
        if (result?.success) {
          deleteError = undefined;
        } else {
          deleteError = result?.error || 'extension:uninstall 返回失败';
        }
      } catch (err) {
        deleteError = err instanceof Error ? err.message : String(err);
      }
    } else {
      deleteError = 'extension.uninstall 不可用';
    }

    // 如果专用 IPC 失败（主进程/Preload 未重启等情况），回退到 fs.delete
    if (deleteError) {
      console.warn(`[ExtensionBridge] 专用卸载通道失败，回退到 fs.delete: ${deleteError}`);
      if (window.electronAPI?.fs?.delete) {
        try {
          const ok = await window.electronAPI.fs.delete(ext.path);
          if (!ok) {
            return { success: false, error: `fs.delete 返回 false (${deleteError})` };
          }
          deleteError = undefined;
        } catch (err) {
          return { success: false, error: `${deleteError}; fs.delete 也失败: ${err instanceof Error ? err.message : String(err)}` };
        }
      } else {
        return { success: false, error: deleteError };
      }
    }

    this.unregisterExtensionContributions(extId);
    this.extensions.delete(extId);
    console.log(`[ExtensionBridge] 扩展已卸载: ${extId}`);
    return { success: true };
  }

  getAllExtensions(): ExtensionState[] {
    return Array.from(this.extensions.values());
  }

  getExtension(extId: string): ExtensionState | undefined {
    return this.extensions.get(extId);
  }

  async invokeExtension(extId: string, method: string, args?: unknown[]): Promise<unknown> {
    const response = (await this.sendToHost('ext.invoke', { extId, method, args })) as {
      success: boolean;
      result?: unknown;
      error?: string;
    };
    if (!response.success) {
      throw new Error(response.error || '扩展调用失败');
    }
    return response.result;
  }

  /* ─── WebView 管理 ─── */

  getWebViewPanels(): WebViewPanel[] {
    return Array.from(this.webviewPanels.values());
  }

  getWebViewPanel(id: string): WebViewPanel | undefined {
    return this.webviewPanels.get(id);
  }

  postMessageToWebView(id: string, message: unknown): void {
    const callbacks = this.webviewMessageCallbacks.get(id);
    if (callbacks) {
      for (const cb of callbacks) {
        cb(message);
      }
    }
  }

  onWebViewMessage(id: string, callback: (message: unknown) => void): () => void {
    if (!this.webviewMessageCallbacks.has(id)) {
      this.webviewMessageCallbacks.set(id, []);
    }
    this.webviewMessageCallbacks.get(id)!.push(callback);
    return () => {
      const callbacks = this.webviewMessageCallbacks.get(id);
      if (callbacks) {
        const idx = callbacks.indexOf(callback);
        if (idx >= 0) callbacks.splice(idx, 1);
      }
    };
  }

  /* ─── 内部工具 ─── */

  async sendToHost(method: string, params: unknown): Promise<unknown> {
    if (!window.electronAPI?.extension?.rpc) {
      throw new Error('Extension Host 未连接');
    }
    return window.electronAPI.extension.rpc(method, params);
  }

  dispose(): void {
    this.unsubscribers.forEach((unsub) => unsub());
    this.unsubscribers = [];
  }
}

let bridgeInstance: ExtensionBridge | null = null;

export function createExtensionBridge(store: Store<RootState>): ExtensionBridge {
  bridgeInstance = new ExtensionBridge(store);
  return bridgeInstance;
}

export function getExtensionBridge(): ExtensionBridge | null {
  return bridgeInstance;
}
