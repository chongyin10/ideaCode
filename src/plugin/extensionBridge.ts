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
import type { RootState } from '../store';
import { openFile, openVirtualFile, addWorkspaceFolder, removeWorkspaceFolder } from '../store/slices/workspaceSlice';
import { addPanelToOrder, removePanelFromOrder } from '../store/slices/layoutSlice';
import { getPluginManager } from './core';
import type { PluginManifest } from './types';
import { terminalSDK, type TerminalCreateOptions } from '../services/terminalSDK';
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
    views?: Record<string, Array<{ id: string; name: string; when?: string }>>;
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

  constructor(store: Store<RootState>) {
    this.store = store;
    this._setupRpcHandlers();
    this._setupIpcListeners();
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
    console.log('[ExtensionBridge] 扩展桥接已初始化');
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
      const { message, type } = params as { message: string; type: string };
      console.log(`[Extension] ${type}: ${message}`);
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
      return (settings as Record<string, unknown>)[section] || {};
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
    this.rpcHandlers.set('secrets.get', (params) => {
      const { extensionId, key } = params as { extensionId: string; key: string };
      // 使用安全的存储方式（如 keytar）
      return { value: null };
    });

    this.rpcHandlers.set('secrets.store', (params) => {
      const { extensionId, key, value } = params as { extensionId: string; key: string; value: string };
      return { stored: true };
    });

    this.rpcHandlers.set('secrets.delete', (params) => {
      const { extensionId, key } = params as { extensionId: string; key: string };
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
      // 切换面板显示
      const { switchPanel } = require('../store/slices/layoutSlice');
      this.store.dispatch(switchPanel(id));
      return { revealed: true };
    });

    this.rpcHandlers.set('webview.postMessage', (params) => {
      const { id, message } = params as { id: string; message: unknown };
      this.postMessageToWebView(id, message);
      return { posted: true };
    });

    this.rpcHandlers.set('webview.message', (params) => {
      const { id, message } = params as { id: string; message: unknown };
      console.log(`[WebView] 收到消息: ${id}`, message);
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
  }

  /* ─── IPC 监听 ─── */

  private _setupIpcListeners(): void {
    if (!window.electronAPI?.extension?.onMessage) return;

    const unsub = window.electronAPI.extension.onMessage((msg) => {
      this._handleHostMessage(msg);
    });

    this.unsubscribers.push(unsub);
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
