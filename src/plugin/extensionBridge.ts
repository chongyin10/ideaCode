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
import { openFile } from '../store/slices/workspaceSlice';
import { getPluginManager } from './core';
import type { PluginManifest } from './types';
import {
  registerViewContainer,
  unregisterViewContainer,
  registerView,
  unregisterView,
  createWebviewPanel,
  disposeWebviewPanel,
  setWebviewPanelHtml,
} from '../store/slices/extensionUISlice';

interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  main: string;
  activationEvents?: string[];
  contributes?: {
    commands?: Array<{ command: string; title: string; category?: string; icon?: string }>;
    menus?: Record<string, Array<{ command: string; group?: string; order?: number; when?: string }>>;
    configuration?: { title: string; properties: Record<string, unknown> };
    views?: Record<string, Array<{ id: string; name: string; when?: string }>>;
    viewsContainers?: Record<string, Array<{ id: string; title: string; icon: string }>>;
  };
  capabilities?: Record<string, boolean>;
}

interface ExtensionState {
  id: string;
  manifest: ExtensionManifest;
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

  private _waitForHostReady(timeout = 10000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new Error('Extension Host 就绪超时'));
      }, timeout);

      const unsub = window.electronAPI!.extension!.onMessage((msg) => {
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
          this._sendToHost('commands.execute', { command, args });
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
      const { id, viewType, title, extensionPath } = params as { id: string; viewType: string; title: string; extensionPath?: string };
      this.store.dispatch(createWebviewPanel({
        id,
        viewType,
        title,
        html: '',
        extensionId: 'unknown',
        extensionPath: extensionPath || '',
        visible: true,
      }));
      console.log(`[WebView] 创建面板: ${id} (${title})`);
      return { created: true };
    });

    this.rpcHandlers.set('webview.setHtml', (params) => {
      const { id, html } = params as { id: string; html: string };
      this.store.dispatch(setWebviewPanelHtml({ id, html }));
      console.log(`[WebView] 设置 HTML: ${id} (${html.length} bytes)`);
      return { set: true };
    });

    this.rpcHandlers.set('webview.dispose', (params) => {
      const { id } = params as { id: string };
      this.store.dispatch(disposeWebviewPanel(id));
      console.log(`[WebView] 销毁面板: ${id}`);
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
      const result = (response as { result?: { manifests: Array<{ id: string; manifest: ExtensionManifest }> } }).result;
      const manifests = result?.manifests || [];

      for (const { id, manifest } of manifests) {
        this.extensions.set(id, {
          id,
          manifest,
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

        // 自动激活有 onStartupFinished 的扩展
        if (manifest.activationEvents?.includes('onStartupFinished')) {
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

  getAllExtensions(): ExtensionState[] {
    return Array.from(this.extensions.values());
  }

  getExtension(extId: string): ExtensionState | undefined {
    return this.extensions.get(extId);
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

  private async _sendToHost(method: string, params: unknown): Promise<unknown> {
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
