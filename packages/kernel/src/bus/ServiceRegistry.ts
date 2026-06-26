/**
 * 服务注册表
 *
 * 微内核的核心组件之一。负责：
 * - 服务注册/注销
 * - 服务发现
 * - 依赖拓扑排序
 * - 服务健康检查
 */

import type { ServiceManifest, Disposable } from '@ideacode/types';

export interface RegisteredService {
  manifest: ServiceManifest;
  instance: unknown;
  status: 'registered' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error';
  startTime?: number;
  error?: string;
}

export class ServiceRegistry {
  private services: Map<string, RegisteredService> = new Map();
  private startOrder: string[] = [];
  private healthChecks: Map<string, () => Promise<boolean>> = new Map();

  /**
   * 注册服务
   */
  register(manifest: ServiceManifest, instance: unknown): void {
    if (this.services.has(manifest.id)) {
      console.warn(`[ServiceRegistry] 服务已存在，将覆盖: ${manifest.id}`);
    }

    this.services.set(manifest.id, {
      manifest,
      instance,
      status: 'registered',
    });

    console.log(`[ServiceRegistry] 注册服务: ${manifest.id} v${manifest.version} (${manifest.capabilities.join(', ')})`);
  }

  /**
   * 注销服务
   */
  unregister(serviceId: string): boolean {
    this.healthChecks.delete(serviceId);
    const service = this.services.get(serviceId);
    if (service) {
      service.status = 'stopped';
    }
    return this.services.delete(serviceId);
  }

  /**
   * 获取服务实例
   */
  get<T = unknown>(serviceId: string): T | undefined {
    const service = this.services.get(serviceId);
    if (!service) return undefined;
    return service.instance as T;
  }

  /**
   * 获取所有已注册服务
   */
  getAll(): RegisteredService[] {
    return Array.from(this.services.values());
  }

  /**
   * 获取服务状态
   */
  getStatus(serviceId: string): RegisteredService['status'] | undefined {
    return this.services.get(serviceId)?.status;
  }

  /**
   * 注册健康检查
   */
  registerHealthCheck(serviceId: string, check: () => Promise<boolean>): void {
    this.healthChecks.set(serviceId, check);
  }

  /**
   * 拓扑排序：根据依赖关系确定启动顺序
   */
  topologicalSort(): string[] {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const order: string[] = [];

    const visit = (id: string): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        throw new Error(`[ServiceRegistry] 循环依赖检测: ${id}`);
      }
      visiting.add(id);

      const service = this.services.get(id);
      if (service?.manifest.dependencies) {
        for (const dep of service.manifest.dependencies) {
          if (this.services.has(dep)) {
            visit(dep);
          }
        }
      }

      visiting.delete(id);
      visited.add(id);
      order.push(id);
    };

    for (const id of this.services.keys()) {
      visit(id);
    }

    this.startOrder = order;
    return order;
  }

  /**
   * 按序启动所有服务
   */
  async startAll(
    starter: (serviceId: string) => Promise<boolean>
  ): Promise<{ success: string[]; failed: string[] }> {
    const order = this.topologicalSort();
    const success: string[] = [];
    const failed: string[] = [];

    for (const id of order) {
      const service = this.services.get(id);
      if (!service) continue;

      service.status = 'starting';
      try {
        const ok = await starter(id);
        if (ok) {
          service.status = 'running';
          service.startTime = Date.now();
          success.push(id);
          console.log(`[ServiceRegistry] 启动成功: ${id}`);
        } else {
          service.status = 'error';
          service.error = '启动返回 false';
          failed.push(id);
          console.error(`[ServiceRegistry] 启动失败: ${id}`);
        }
      } catch (err) {
        service.status = 'error';
        service.error = err instanceof Error ? err.message : String(err);
        failed.push(id);
        console.error(`[ServiceRegistry] 启动异常: ${id}`, service.error);
      }
    }

    return { success, failed };
  }

  /**
   * 停止所有服务 (逆序)
   */
  async stopAll(
    stopper: (serviceId: string) => Promise<void>
  ): Promise<void> {
    const order = [...this.startOrder].reverse();
    for (const id of order) {
      const service = this.services.get(id);
      if (!service || service.status !== 'running') continue;

      service.status = 'stopping';
      try {
        await stopper(id);
        service.status = 'stopped';
      } catch (err) {
        console.error(`[ServiceRegistry] 停止异常: ${id}`, err);
        service.status = 'error';
      }
    }
  }

  /**
   * 健康检查所有运行中的服务
   */
  async healthCheck(): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();
    for (const [id, check] of this.healthChecks) {
      const service = this.services.get(id);
      if (service?.status !== 'running') continue;
      try {
        results.set(id, await check());
      } catch {
        results.set(id, false);
      }
    }
    return results;
  }
}
