/**
 * 应用级事件总线（Observer 模式）
 *
 * 职责：解耦 IDE 各模块之间的通信，替代分散的 window.addEventListener。
 * 模块通过事件总线发布/订阅事件，无需知道彼此的存在。
 *
 * ## 设计
 *
 * - 类型安全的事件映射：每个事件有明确的 payload 类型
 * - 支持一次性监听（once）
 * - 返回取消订阅函数（Disposable 模式）
 * - 支持通配符监听（debug 用）
 * - 错误隔离：单个 handler 的异常不影响其他 handler
 */

export type EventHandler<T> = (payload: T) => void;

export interface EventMap {
  'file:opened': { fileId: string; filePath: string; fileName: string };
  'file:closed': { fileId: string; groupIndex: number };
  'file:changed': { filePath: string; eventType: string };
  'file:saved': { fileId: string; filePath: string };
  'editor:focused': { groupIndex: number; fileId: string | null };
  'editor:changed': { fileId: string; groupIndex: number };
  'tab:activated': { fileId: string; groupIndex: number };
  'tab:closed': { fileId: string; groupIndex: number };
  'search:started': { query: string };
  'search:completed': { query: string; resultCount: number };
  'project:opened': { rootPath: string; rootName: string };
  'project:closed': void;
  'git:statusChanged': { changes: number; branch: string };
  'plugin:activated': { pluginId: string };
  'plugin:deactivated': { pluginId: string };
  'workspace:stateChanged': { action: string };
  'app:beforeQuit': void;
  'app:focus': void;
  'app:blur': void;
}

type EventNames = keyof EventMap;

class EventBusImpl {
  private listeners = new Map<string, Set<EventHandler<unknown>>>();
  private onceListeners = new Map<string, Set<EventHandler<unknown>>>();

  /**
   * 订阅事件
   * @returns 取消订阅函数
   */
  on<E extends EventNames>(event: E, handler: EventHandler<EventMap[E]>): () => void {
    const key = event as string;
    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }
    this.listeners.get(key)!.add(handler as EventHandler<unknown>);
    return () => this.off(event, handler);
  }

  /**
   * 一次性订阅
   */
  once<E extends EventNames>(event: E, handler: EventHandler<EventMap[E]>): () => void {
    const key = event as string;
    if (!this.onceListeners.has(key)) {
      this.onceListeners.set(key, new Set());
    }
    this.onceListeners.get(key)!.add(handler as EventHandler<unknown>);
    return () => {
      this.onceListeners.get(key)?.delete(handler as EventHandler<unknown>);
    };
  }

  /**
   * 取消订阅
   */
  off<E extends EventNames>(event: E, handler: EventHandler<EventMap[E]>): void {
    const key = event as string;
    this.listeners.get(key)?.delete(handler as EventHandler<unknown>);
    this.onceListeners.get(key)?.delete(handler as EventHandler<unknown>);
  }

  /**
   * 发布事件
   */
  emit<E extends EventNames>(event: E, payload: EventMap[E]): void {
    const key = event as string;

    // 常规监听器
    const handlers = this.listeners.get(key);
    if (handlers) {
      for (const handler of handlers) {
        try { handler(payload); }
        catch (err) { console.error(`[EventBus] 事件 ${key} 处理器异常:`, err); }
      }
    }

    // 一次性监听器
    const onceHandlers = this.onceListeners.get(key);
    if (onceHandlers) {
      const toRemove: EventHandler<unknown>[] = [];
      for (const handler of onceHandlers) {
        try { handler(payload); } catch { /* ... */ }
        toRemove.push(handler);
      }
      toRemove.forEach(h => onceHandlers.delete(h));
    }

    // 通配符监听器（debug）
    const wildcardHandlers = this.listeners.get('*');
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        try { handler({ event, payload }); } catch { /* ... */ }
      }
    }
  }

  /**
   * 订阅所有事件（调试用）
   */
  onAny(handler: EventHandler<{ event: string; payload: unknown }>): () => void {
    if (!this.listeners.has('*')) {
      this.listeners.set('*', new Set());
    }
    this.listeners.get('*')!.add(handler as EventHandler<unknown>);
    return () => this.listeners.get('*')?.delete(handler as EventHandler<unknown>);
  }

  /**
   * 获取订阅数（调试用）
   */
  listenerCount(event?: EventNames): number {
    if (event) {
      return (this.listeners.get(event as string)?.size ?? 0)
        + (this.onceListeners.get(event as string)?.size ?? 0);
    }
    let total = 0;
    for (const s of this.listeners.values()) total += s.size;
    for (const s of this.onceListeners.values()) total += s.size;
    return total;
  }

  /** 清除所有监听器 */
  clear(): void {
    this.listeners.clear();
    this.onceListeners.clear();
  }
}

/** 全局单例 */
export const eventBus = new EventBusImpl();

export { EventBusImpl as EventBus };
