/**
 * IPC 消息类型定义
 *
 * 所有跨进程通信的请求/响应/事件类型在此统一定义。
 * 替代 electron/shared/channels.cjs 和 preload.cjs 中的内联常量。
 */

// ─── 基础类型 ───

export interface IpcRequest<T = unknown> {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: T;
}

export interface IpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  result?: T;
  error?: IpcError;
}

export interface IpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface IpcNotification<T = unknown> {
  jsonrpc: '2.0';
  method: string;
  params?: T;
}

// ─── 服务命名空间枚举 ───

export enum ServiceNamespace {
  DIALOG = 'dialog',
  FS = 'fs',
  WINDOW = 'window',
  EXTENSION = 'extension',
  EXTENSION_HOST = 'extensionHost',
  APP = 'app',
  MENU = 'menu',
  HISTORY = 'history',
  TSSERVER = 'tsserver',
  TERMINAL = 'terminal',
  GIT = 'git',
  SYSTEM = 'system',
  EDITOR = 'editor',
  WORKSPACE = 'workspace',
  CONFIGURATION = 'configuration',
  STORAGE = 'storage',
  SECRETS = 'secrets',
  ENV = 'env',
  WEBVIEW = 'webview',
}

// ─── 通道名构建工具 ───

export function channel(ns: ServiceNamespace, method: string): string {
  return `${ns}:${method}`;
}

// ─── Disposable 接口 ───

export interface Disposable {
  dispose(): void;
}

// ─── 事件发射器接口 ───

export interface Event<T> {
  (listener: (data: T) => void): Disposable;
}

// ─── URI 类型 ───

export interface Uri {
  readonly scheme: string;
  readonly fsPath: string;
}
