/**
 * 统一消息总线 (ServiceBus)
 *
 * 微内核的核心通信层。负责：
 * - 服务间请求-响应 (RPC)
 * - 发布-订阅模式 (Pub/Sub)
 * - 本地处理器注册
 * - 远程调用代理
 *
 * 设计原则：
 * - 所有通信必须经过 ServiceBus，不允许直接模块依赖
 * - 支持同进程和跨进程通信（通过适配器桥接）
 * - 类型安全：通过 TypeScript 泛型保证编译期类型检查
 */

import type { IServiceBus, ServiceManifest, Disposable } from '@ideacode/types';
import { ServiceRegistry } from './ServiceRegistry.js';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ServiceBus implements IServiceBus {
  readonly registry: ServiceRegistry;

  private requestId = 0;
  private pendingRequests: Map<number, PendingRequest> = new Map();
  private localHandlers: Map<string, (params: unknown) => unknown | Promise<unknown>> = new Map();
  private topicSubscribers: Map<string, Set<(data: unknown) => void>> = new Map();

  /** 远程调用函数 (由环境实现注入) */
  private remoteInvokeFn: ((method: string, params: unknown) => Promise<unknown>) | null = null;
  /** 远程通知函数 */
  private remoteNotifyFn: ((method: string, params: unknown) => void) | null = null;
  /** 超时毫秒数 */
  private defaultTimeout = 30000;

  constructor() {
    this.registry = new ServiceRegistry();
  }

  // ─── 远程代理设置 ───

  /**
   * 设置远程调用函数 (用于跨进程通信)
   * 在渲染进程中指 ipcRenderer.invoke，在主进程中指 process.send
   */
  setRemoteInvoke(fn: (method: string, params: unknown) => Promise<unknown>): void {
    this.remoteInvokeFn = fn;
  }

  /**
   * 设置远程通知函数
   */
  setRemoteNotify(fn: (method: string, params: unknown) => void): void {
    this.remoteNotifyFn = fn;
  }

  /**
   * 处理来自远程的请求
   */
  async handleRemoteRequest(method: string, params: unknown): Promise<unknown> {
    const handler = this.localHandlers.get(method);
    if (!handler) {
      throw new Error(`Method not found: ${method}`);
    }
    return handler(params);
  }

  // ─── 服务注册 ───

  registerService(manifest: ServiceManifest, instance: unknown): void {
    this.registry.register(manifest, instance);
  }

  unregisterService(serviceId: string): void {
    this.registry.unregister(serviceId);
  }

  getService<T>(serviceId: string): T | undefined {
    return this.registry.get<T>(serviceId);
  }

  // ─── 本地处理器 ───

  /**
   * 注册本地处理器
   */
  handle(method: string, handler: (params: unknown) => unknown | Promise<unknown>): void {
    if (this.localHandlers.has(method)) {
      console.warn(`[ServiceBus] 处理器覆盖: ${method}`);
    }
    this.localHandlers.set(method, handler);
  }

  /**
   * 移除本地处理器
   */
  removeHandler(method: string): boolean {
    return this.localHandlers.delete(method);
  }

  // ─── 请求-响应 ───

  /**
   * 发起请求 (自动选择本地或远程)
   */
  async request<T = unknown>(service: string, method: string, params?: unknown): Promise<T> {
    const fullMethod = `${service}:${method}`;

    // 优先本地处理
    const localHandler = this.localHandlers.get(fullMethod);
    if (localHandler) {
      return localHandler(params) as Promise<T>;
    }

    // 远程调用
    if (this.remoteInvokeFn) {
      return this.remoteInvokeFn(fullMethod, params) as Promise<T>;
    }

    throw new Error(`[ServiceBus] 无法处理请求: ${fullMethod} (无本地处理器且无远程通道)`);
  }

  /**
   * 发送通知 (fire-and-forget)
   */
  notify(service: string, method: string, params?: unknown): void {
    const fullMethod = `${service}:${method}`;

    // 优先本地
    const localHandler = this.localHandlers.get(fullMethod);
    if (localHandler) {
      const result = localHandler(params);
      if (result instanceof Promise) {
        result.catch(console.error);
      }
      return;
    }

    // 远程
    if (this.remoteNotifyFn) {
      this.remoteNotifyFn(fullMethod, params);
    }
  }

  // ─── 发布-订阅 ───

  publish(topic: string, data: unknown): void {
    const subscribers = this.topicSubscribers.get(topic);
    if (subscribers) {
      for (const handler of subscribers) {
        try {
          handler(data);
        } catch (err) {
          console.error(`[ServiceBus] 订阅处理失败: ${topic}`, err);
        }
      }
    }
  }

  subscribe(topic: string, handler: (data: unknown) => void): Disposable {
    if (!this.topicSubscribers.has(topic)) {
      this.topicSubscribers.set(topic, new Set());
    }
    this.topicSubscribers.get(topic)!.add(handler);

    return {
      dispose: () => {
        const subscribers = this.topicSubscribers.get(topic);
        if (subscribers) {
          subscribers.delete(handler);
          if (subscribers.size === 0) {
            this.topicSubscribers.delete(topic);
          }
        }
      },
    };
  }

  // ─── 本地调用 (用于双向桥接) ───

  async invokeLocal(method: string, params?: unknown): Promise<unknown> {
    const handler = this.localHandlers.get(method);
    if (!handler) {
      throw new Error(`Local handler not found: ${method}`);
    }
    return handler(params);
  }

  // ─── JSON-RPC 适配 ───

  /**
   * 处理 JSON-RPC 请求/通知
   * 兼容现有的 extension-host 协议
   */
  async handleJsonRpc(message: {
    jsonrpc: '2.0';
    id?: number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { code: number; message: string };
  }): Promise<void> {
    // 响应
    if (message.id !== undefined && (message.result !== undefined || message.error)) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }

    // 请求
    if (message.method && message.id !== undefined) {
      try {
        const result = await this.invokeLocal(message.method, message.params);
        // 需要通过远程发送响应
        if (this.remoteNotifyFn) {
          this.remoteNotifyFn('__rpc_response', {
            id: message.id,
            result,
          });
        }
      } catch (err) {
        if (this.remoteNotifyFn) {
          this.remoteNotifyFn('__rpc_response', {
            id: message.id,
            error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
          });
        }
      }
      return;
    }

    // 通知
    if (message.method) {
      try {
        await this.invokeLocal(message.method, message.params);
      } catch (err) {
        console.error(`[ServiceBus] 通知处理失败: ${message.method}`, err);
      }
    }
  }

  /**
   * 创建对应 JSON-RPC 请求并等待响应
   */
  async requestJsonRpc(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, this.defaultTimeout);

      this.pendingRequests.set(id, { resolve, reject, timer });

      if (this.remoteNotifyFn) {
        this.remoteNotifyFn('__rpc_request', { jsonrpc: '2.0', id, method, params: params || {} });
      } else {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(new Error('远程通道未设置'));
      }
    });
  }
}
