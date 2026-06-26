/**
 * 新扩展桥接器
 *
 * 替代 src/plugin/extensionBridge.ts (1327行单体)
 * 基于 ServiceBus 实现，将 40+ RPC handler 拆分为独立服务适配器。
 *
 * 架构：
 * ExtensionBridge 本身变得很薄，只负责：
 * 1. 扩展生命周期管理 (扫描/激活/停用)
 * 2. 将 Extension Host 消息路由到 ServiceBus
 * 3. 将 ServiceBus 事件反向路由到 Extension Host
 */

import { ServiceBus } from '@ideacode/kernel';
import type { IServiceBus } from '@ideacode/kernel';
import type {
  ExtensionManifest,
  Disposable,
} from '@ideacode/types';

export interface ExtensionState {
  id: string;
  manifest: ExtensionManifest;
  path: string;
  activated: boolean;
  error?: string;
}

/**
 * 扩展桥接器 (轻量版)
 * 所有重负载逻辑拆分到 serviceAdapters/
 */
export class ExtensionBridge {
  private bus: IServiceBus;
  private extensions: Map<string, ExtensionState> = new Map();
  private disabledExtensions: Set<string> = new Set();
  private unsubscribers: Disposable[] = [];

  /** 远程 RPC 函数 (调用 Extension Host) */
  private hostRpc: ((method: string, params?: unknown) => Promise<unknown>) | null = null;

  constructor(bus: IServiceBus) {
    this.bus = bus;
  }

  /**
   * 设置与 Extension Host 的通信通道
   */
  setHostRpc(fn: (method: string, params?: unknown) => Promise<unknown>): void {
    this.hostRpc = fn;
  }

  /**
   * 初始化
   */
  async initialize(): Promise<void> {
    if (!this.hostRpc) {
      console.warn('[ExtensionBridge] 未设置 Host RPC 通道');
      return;
    }

    // 等待 Extension Host 就绪
    await this._waitForHostReady();

    // 扫描并激活扩展
    await this.scanExtensions();

    console.log(`[ExtensionBridge] 已初始化，${this.extensions.size} 个扩展`);
  }

  private async _waitForHostReady(timeout = 10000): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      try {
        const result = await this.hostRpc!('host.ping', {});
        if (result && (result as { pong?: boolean }).pong) {
          console.log('[ExtensionBridge] Extension Host 已就绪');
          return;
        }
      } catch {
        // 等待 500ms 后重试
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    throw new Error('Extension Host 就绪超时');
  }

  // ─── 扩展管理 ───

  async scanExtensions(): Promise<ExtensionState[]> {
    if (!this.hostRpc) return [];

    try {
      const response = await this.hostRpc('ext.scan', {});
      const manifests = (response as { manifests?: Array<{ id: string; manifest: ExtensionManifest; path: string }> })?.manifests || [];

      for (const { id, manifest, path } of manifests) {
        const isDisabled = this.disabledExtensions.has(id);
        this.extensions.set(id, { id, manifest, path, activated: false });

        // 自动激活 onStartupFinished
        if (!isDisabled && manifest.activationEvents?.includes('onStartupFinished')) {
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
    if (!this.hostRpc) return false;

    const ext = this.extensions.get(extId);
    if (!ext) return false;
    if (ext.activated) return true;

    this.disabledExtensions.delete(extId);

    try {
      await this.hostRpc('ext.activate', { extId });
      ext.activated = true;
      console.log(`[ExtensionBridge] 扩展已激活: ${extId}`);
      return true;
    } catch (err) {
      ext.error = err instanceof Error ? err.message : String(err);
      console.error(`[ExtensionBridge] 激活失败: ${extId}`, ext.error);
      return false;
    }
  }

  async deactivateExtension(extId: string): Promise<boolean> {
    if (!this.hostRpc) return false;

    const ext = this.extensions.get(extId);
    if (!ext || !ext.activated) return true;

    try {
      await this.hostRpc('ext.deactivate', { extId });
      ext.activated = false;
      ext.error = undefined;
      return true;
    } catch (err) {
      console.error(`[ExtensionBridge] 停用失败: ${extId}`, err);
      return false;
    }
  }

  async invokeExtension(extId: string, method: string, args?: unknown[]): Promise<unknown> {
    return this.hostRpc?.('ext.invoke', { extId, method, args });
  }

  getAllExtensions(): ExtensionState[] {
    return Array.from(this.extensions.values());
  }

  getExtension(extId: string): ExtensionState | undefined {
    return this.extensions.get(extId);
  }

  // ─── 清理 ───

  dispose(): void {
    this.unsubscribers.forEach((u) => u.dispose());
    this.unsubscribers = [];
  }
}
