/**
 * @ideacode/kernel - 微内核核心包
 *
 * 提供微内核架构的核心组件：
 * - ServiceBus: 统一消息总线
 * - ServiceRegistry: 服务注册发现
 * - ProcessManager: 子进程管理
 * - Microkernel: 内核启动器
 */

export { ServiceBus } from './bus/ServiceBus.js';
export type { IServiceBus } from '../../types/src/index.js';
export { ServiceRegistry } from './bus/ServiceRegistry.js';
export type { RegisteredService } from './bus/ServiceRegistry.js';

export { ProcessManager } from './process/ProcessManager.js';
export type { ChildProcess, ProcessConfig, ProcessInfo } from './process/ProcessManager.js';

export { Microkernel } from './Microkernel.js';
export type { KernelConfig, KernelContext, IpcBridgeAdapter } from './Microkernel.js';
