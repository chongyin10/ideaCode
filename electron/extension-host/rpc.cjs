/**
 * JSON-RPC 2.0 协议实现
 * 
 * 扩展宿主进程与主进程之间的通信协议。
 * 基于 JSON-RPC 2.0 规范，支持请求-响应模式和通知模式。
 */

class JsonRpcServer {
  constructor() {
    /** @type {Map<string, Function>} */
    this.handlers = new Map();
    /** @type {Map<number, {resolve: Function, reject: Function}>} */
    this.pending = new Map();
    this.messageId = 0;
    /** @type {Function|null} */
    this.sendFn = null;
  }

  /**
   * 注册方法处理器
   * @param {string} method
   * @param {Function} handler
   */
  on(method, handler) {
    this.handlers.set(method, handler);
  }

  /**
   * 设置发送消息的回调函数
   * @param {Function} sendFn
   */
  setSendFunction(sendFn) {
    this.sendFn = sendFn;
  }

  /**
   * 处理接收到的消息
   * @param {object} message
   */
  handleMessage(message) {
    // 请求 / 通知
    if (message.method) {
      this.handleRequest(message);
      return;
    }

    // 响应
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        reject(new Error(message.error.message || message.error));
      } else {
        resolve(message.result);
      }
    }
  }

  /**
   * 处理请求或通知
   */
  async handleRequest(message) {
    const { id, method, params } = message;
    const handler = this.handlers.get(method);

    if (!handler) {
      if (id !== undefined) {
        this.sendResponse(id, null, {
          code: -32601,
          message: `Method not found: ${method}`,
        });
      }
      return;
    }

    try {
      const result = await handler(params);
      if (id !== undefined) {
        this.sendResponse(id, result, null);
      }
    } catch (err) {
      if (id !== undefined) {
        this.sendResponse(id, null, {
          code: -32603,
          message: err.message || 'Internal error',
        });
      }
    }
  }

  /**
   * 发送响应
   */
  sendResponse(id, result, error) {
    if (!this.sendFn) return;
    const response = { jsonrpc: '2.0', id };
    if (error) {
      response.error = error;
    } else {
      response.result = result;
    }
    this.sendFn(response);
  }

  /**
   * 发送请求（期待响应）
   */
  request(method, params) {
    if (!this.sendFn) return Promise.reject(new Error('未设置发送函数'));
    const id = ++this.messageId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sendFn({ jsonrpc: '2.0', id, method, params });
    });
  }

  /**
   * 发送通知（无需响应）
   */
  notify(method, params) {
    if (!this.sendFn) return;
    this.sendFn({ jsonrpc: '2.0', method, params });
  }
}

module.exports = { JsonRpcServer };
