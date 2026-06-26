/**
 * Git WebView 与 Extension Host 的通信桥
 *
 * 通过 acquireVsCodeApi() 获取 postMessage 接口（VS Code 风格）。
 * 由于 IDEACODE 没有 acquireVsCodeApi，我们直接使用 parent.postMessage 兼容。
 */

import type { HostMessage, RpcReply, RpcRequest } from './types';

declare global {
  interface Window {
    __IDEACODE_WEBVIEW_API__?: {
      postMessage: (message: unknown) => void;
      onMessage: (callback: (msg: HostMessage) => void) => () => void;
    };
  }
}

let nextRpcId = 1;
const pendingReplies = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function getApi() {
  // IDEACODE 注入的 WebView 桥（在 WebViewPanel 加载时由渲染进程注入）
  if (typeof window !== 'undefined' && window.__IDEACODE_WEBVIEW_API__) {
    return window.__IDEACODE_WEBVIEW_API__;
  }
  // 降级：直接用 window.parent.postMessage（用于在 iframe 中运行的情况）
  return null;
}

/** 初始化消息监听 */
export function initMessageListener(onState: (msg: HostMessage) => void) {
  const api = getApi();
  if (api) {
    return api.onMessage((msg) => {
      if (msg.type === 'rpc:reply') {
        const reply = msg as RpcReply;
        const pending = pendingReplies.get(reply.id);
        if (pending) {
          pendingReplies.delete(reply.id);
          if (reply.success) pending.resolve(reply);
          else pending.reject(new Error(reply.error || 'RPC failed'));
        }
        return;
      }
      onState(msg);
    });
  } else {
    // 浏览器开发模式：监听 window message
    const handler = (e: MessageEvent) => {
      const msg = e.data as HostMessage;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'rpc:reply') {
        const reply = msg as RpcReply;
        const pending = pendingReplies.get(reply.id);
        if (pending) {
          pendingReplies.delete(reply.id);
          if (reply.success) pending.resolve(reply);
          else pending.reject(new Error(reply.error || 'RPC failed'));
        }
        return;
      }
      onState(msg);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }
}

/** 向 Extension Host 发送命令并等待回复 */
export function sendRpc<T = any>(command: string, params: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = nextRpcId++;
    pendingReplies.set(id, { resolve, reject });

    const request: RpcRequest = { id, command, ...params };
    const api = getApi();
    if (api) {
      api.postMessage(request);
    } else if (window.parent && window.parent !== window) {
      window.parent.postMessage(request, '*');
    } else {
      pendingReplies.delete(id);
      reject(new Error('WebView API 不可用'));
      return;
    }

    // 超时
    setTimeout(() => {
      if (pendingReplies.has(id)) {
        pendingReplies.delete(id);
        reject(new Error(`RPC 超时: ${command}`));
      }
    }, 60000);
  });
}

/** 通知扩展 WebView 已就绪 */
export function sendReady() {
  return sendRpc('ready');
}