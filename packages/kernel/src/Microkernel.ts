/**
 * 微内核启动器
 *
 * 负责：
 * - 创建 ServiceBus 实例
 * - 注册平台适配器
 * - 启动服务 (声明式，拓扑排序)
 * - 管理内核生命周期
 */

import { ServiceBus } from './bus/ServiceBus.js';
import { ProcessManager } from './process/ProcessManager.js';
import type { ServiceManifest, IServiceBus } from '@ideacode/types';

export interface KernelConfig {
  /** 进程管理器配置 */
  processes?: Array<{
    id: string;
    entry: string;
    autoRestart?: boolean;
  }>;

  /** 服务声明列表 */
  services?: Array<{
    manifest: ServiceManifest;
    factory?: () => unknown;
  }>;
}

export interface KernelContext {
  bus: IServiceBus;
  processManager: ProcessManager;
  isRunning: boolean;
}

export class Microkernel {
  readonly bus: ServiceBus;
  readonly processManager: ProcessManager;
  private _isRunning = false;

  constructor() {
    this.bus = new ServiceBus();
    this.processManager = new ProcessManager();
  }

  /**
   * 获取内核上下文
   */
  get context(): KernelContext {
    return {
      bus: this.bus,
      processManager: this.processManager,
      isRunning: this._isRunning,
    };
  }

  /**
   * 初始化内核
   * - 设置 IPC 桥接
   * - 注册本地处理器
   */
  async init(config?: KernelConfig): Promise<void> {
    console.log('[Microkernel] 初始化微内核...');

    // 注册服务
    if (config?.services) {
      for (const { manifest, factory } of config.services) {
        const instance = factory ? factory() : {};
        this.bus.registerService(manifest, instance);
      }
    }

    console.log(`[Microkernel] 已注册 ${this.bus.registry.getAll().length} 个服务`);
  }

  /**
   * 启动内核
   */
  async start(): Promise<void> {
    if (this._isRunning) {
      console.warn('[Microkernel] 内核已在运行');
      return;
    }

    this._isRunning = true;
    console.log('[Microkernel] 微内核已启动');

    // 健康检查
    this.bus.subscribe('kernel.healthCheck', async () => {
      const results = await this.bus.registry.healthCheck();
      return { healthy: Array.from(results.values()).every(Boolean), results: Object.fromEntries(results) };
    });
  }

  /**
   * 停止内核
   */
  async stop(): Promise<void> {
    if (!this._isRunning) return;

    console.log('[Microkernel] 正在停止微内核...');
    this.processManager.stopAll();
    this._isRunning = false;
    console.log('[Microkernel] 微内核已停止');
  }

  /**
   * 注册平台 IPC 适配器
   */
  setupIpcBridge(adapter: IpcBridgeAdapter): void {
    this.bus.setRemoteInvoke((method, params) => adapter.invoke(method, params));
    this.bus.setRemoteNotify((method, params) => adapter.notify(method, params));
    adapter.onRequest(async (method, params) => {
      return this.bus.invokeLocal(method, params);
    });
    console.log('[Microkernel] IPC 桥接已配置');
  }
}

/**
 * IPC 桥接适配器接口
 * 不同平台 (Electron / Web) 实现此接口
 */
export interface IpcBridgeAdapter {
  invoke(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  onRequest(handler: (method: string, params: unknown) => Promise<unknown>): void;
}
