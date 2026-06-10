/**
 * 插件系统核心
 *
 * 职责：
 * 1. 维护插件注册表（已注册/已激活的插件）
 * 2. 管理插件生命周期（加载 → 激活 → 停用 → 卸载）
 * 3. 提供命令注册与执行机制
 * 4. 协调各插件之间的通信
 */

import type {
  Plugin,
  PluginManifest,
  PluginState,
  PluginContext,
  PluginCommandsApi,
} from './types';

/* ─── 插件注册表 ─── */

class PluginRegistry {
  private plugins = new Map<string, PluginState>();
  private activePlugins = new Map<string, Plugin>();
  private contexts = new Map<string, PluginContext>();

  register(manifest: PluginManifest): PluginState {
    const state: PluginState = {
      id: manifest.id,
      manifest,
      isActive: false,
    };
    this.plugins.set(manifest.id, state);
    return state;
  }

  getState(id: string): PluginState | undefined {
    return this.plugins.get(id);
  }

  getAllStates(): PluginState[] {
    return Array.from(this.plugins.values());
  }

  getActivePlugin(id: string): Plugin | undefined {
    return this.activePlugins.get(id);
  }

  getContext(id: string): PluginContext | undefined {
    return this.contexts.get(id);
  }

  setActive(id: string, plugin: Plugin, context: PluginContext) {
    const state = this.plugins.get(id);
    if (state) {
      state.isActive = true;
      state.error = undefined;
    }
    this.activePlugins.set(id, plugin);
    this.contexts.set(id, context);
  }

  setInactive(id: string) {
    const state = this.plugins.get(id);
    if (state) {
      state.isActive = false;
    }
    this.activePlugins.delete(id);
    this.contexts.delete(id);
  }

  unregister(id: string) {
    this.plugins.delete(id);
    this.activePlugins.delete(id);
    this.contexts.delete(id);
  }
}

/* ─── 命令系统 ─── */

class CommandManager {
  private commands = new Map<string, (...args: unknown[]) => unknown>();
  private listeners: ((commandId: string, args: unknown[]) => void)[] = [];

  register(commandId: string, handler: (...args: unknown[]) => unknown): () => void {
    if (this.commands.has(commandId)) {
      console.warn(`[Plugin] 命令 ${commandId} 已被注册，将被覆盖`);
    }
    this.commands.set(commandId, handler);
    return () => this.commands.delete(commandId);
  }

  execute(commandId: string, ...args: unknown[]): unknown {
    const handler = this.commands.get(commandId);
    if (!handler) {
      throw new Error(`命令未找到: ${commandId}`);
    }
    const result = handler(...args);
    this.listeners.forEach((cb) => cb(commandId, args));
    return result;
  }

  onDidExecute(callback: (commandId: string, args: unknown[]) => void): () => void {
    this.listeners.push(callback);
    return () => {
      const idx = this.listeners.indexOf(callback);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  getAllCommands(): { id: string }[] {
    return Array.from(this.commands.keys()).map((id) => ({ id }));
  }
}

/* ─── 插件存储管理器（指数退避写合并） ─── */

class PluginStorageManager {
  private storage = new Map<string, Map<string, unknown>>();
  private storageKey = 'ideacode_plugin_storage';
  private dirty = false;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  // 指数退避参数
  private cooldownMs = 500;
  private consecutiveWrites = 0;

  constructor() {
    this.loadFromDisk();
  }

  private loadFromDisk() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        for (const [pluginId, data] of Object.entries(parsed)) {
          this.storage.set(pluginId, new Map(Object.entries(data as Record<string, unknown>)));
        }
      }
    } catch {
      // 忽略解析错误
    }
  }

  private scheduleFlush() {
    if (this.writeTimer) clearTimeout(this.writeTimer);

    // 指数退避：cooldown = min(500 * 2^writes, 30s)
    const delay = Math.min(
      500 * Math.pow(2, this.consecutiveWrites),
      30000
    );

    this.writeTimer = setTimeout(() => {
      this.flushToDisk();
    }, delay);
  }

  private flushToDisk() {
    if (!this.dirty) return;

    const obj: Record<string, Record<string, unknown>> = {};
    for (const [pluginId, data] of this.storage) {
      obj[pluginId] = Object.fromEntries(data);
    }
    localStorage.setItem(this.storageKey, JSON.stringify(obj));

    this.dirty = false;
    this.consecutiveWrites = 0;
    this.writeTimer = null;
  }

  getStorage(pluginId: string) {
    if (!this.storage.has(pluginId)) {
      this.storage.set(pluginId, new Map());
    }
    const data = this.storage.get(pluginId)!;

    return {
      get: <T>(key: string, defaultValue?: T): T | undefined => {
        const val = data.get(key);
        return val !== undefined ? (val as T) : defaultValue;
      },
      set: <T>(key: string, value: T) => {
        data.set(key, value);
        this.markDirty();
      },
      delete: (key: string) => {
        data.delete(key);
        this.markDirty();
      },
    };
  }

  private markDirty() {
    this.dirty = true;
    this.consecutiveWrites++;
    this.scheduleFlush();
  }

  /** 立即刷新（用于插件停用前确保数据写入） */
  flush() {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.flushToDisk();
  }
}

/* ─── 插件管理器 ─── */

export class PluginManager {
  private registry = new PluginRegistry();
  private commands = new CommandManager();
  private storage = new PluginStorageManager();
  private apiFactory: (pluginId: string, manifest: PluginManifest) => PluginContext;
  private listeners: (() => void)[] = [];

  constructor(apiFactory: (pluginId: string, manifest: PluginManifest) => PluginContext) {
    this.apiFactory = apiFactory;
  }

  register(manifest: PluginManifest): PluginState {
    return this.registry.register(manifest);
  }

  async activate(plugin: Plugin): Promise<void> {
    const { manifest } = plugin;
    const state = this.registry.getState(manifest.id);

    if (!state) {
      this.registry.register(manifest);
    }

    if (state?.isActive) {
      console.warn(`[Plugin] 插件 ${manifest.id} 已在运行中`);
      return;
    }

    try {
      const context = this.apiFactory(manifest.id, manifest);
      await plugin.activate(context);
      this.registry.setActive(manifest.id, plugin, context);

      console.log(`[Plugin] 插件已激活: ${manifest.id}`);
      this.notifyListeners();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (state) state.error = errorMsg;
      console.error(`[Plugin] 插件激活失败 ${manifest.id}:`, errorMsg);
    }
  }

  async deactivate(pluginId: string): Promise<void> {
    const plugin = this.registry.getActivePlugin(pluginId);
    const context = this.registry.getContext(pluginId);

    if (!plugin || !context) {
      console.warn(`[Plugin] 插件 ${pluginId} 未激活`);
      return;
    }

    try {
      // 先刷新存储，确保数据持久化
      this.storage.flush();

      context.subscriptions.forEach((dispose) => {
        try {
          dispose();
        } catch {
          // 忽略清理错误
        }
      });

      if (plugin.deactivate) {
        await plugin.deactivate();
      }

      this.registry.setInactive(pluginId);
      console.log(`[Plugin] 插件已停用: ${pluginId}`);
      this.notifyListeners();
    } catch (err) {
      console.error(`[Plugin] 插件停用失败 ${pluginId}:`, err);
    }
  }

  async uninstall(pluginId: string): Promise<void> {
    await this.deactivate(pluginId);
    this.registry.unregister(pluginId);
    this.notifyListeners();
  }

  onChange(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  private notifyListeners(): void {
    for (const l of this.listeners) l();
  }

  getAllPlugins(): PluginState[] {
    return this.registry.getAllStates();
  }

  getCommandManager(): PluginCommandsApi {
    return {
      registerCommand: (id, handler) => this.commands.register(id, handler),
      executeCommand: (id, ...args) => this.commands.execute(id, ...args),
      onDidExecuteCommand: (cb) => this.commands.onDidExecute(cb),
    };
  }

  getStorage(pluginId: string) {
    return this.storage.getStorage(pluginId);
  }
}

/* ─── 单例导出 ─── */

let instance: PluginManager | null = null;

export function createPluginManager(
  apiFactory: (pluginId: string, manifest: PluginManifest) => PluginContext
): PluginManager {
  instance = new PluginManager(apiFactory);
  return instance;
}

export function getPluginManager(): PluginManager | null {
  return instance;
}
