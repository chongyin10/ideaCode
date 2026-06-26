/**
 * 服务适配器基础接口
 *
 * 所有服务适配器实现此接口，向 ServiceBus 注册自己处理的方法。
 * 这替代了原 ExtensionBridge 中 40+ 个内联 RPC handler。
 */

import type { IServiceBus } from '@ideacode/kernel';

export interface ServiceAdapter {
  /** 适配器唯一标识 */
  readonly id: string;

  /**
   * 向 ServiceBus 注册处理器
   * 在 ExtensionBridge 初始化时调用
   */
  register(bus: IServiceBus): void;
}
