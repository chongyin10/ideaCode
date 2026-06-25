/**
 * Tool Registry
 *
 * 注册并管理所有 Agent 可调用的工具。
 * 每个 tool 是一个函数：async (args, context) => result
 */

const tools = require('./tools');

class ToolRegistry {
  constructor() {
    this._tools = new Map();
    this._registerBuiltins();
  }

  _registerBuiltins() {
    for (const [name, tool] of Object.entries(tools)) {
      this.register(name, tool);
    }
  }

  /**
   * 注册一个工具
   * @param {string} name
   * @param {Function} handler async (args, context) => result
   */
  register(name, handler) {
    if (typeof handler !== 'function') {
      throw new Error(`Tool ${name} 必须是一个函数`);
    }
    this._tools.set(name, handler);
  }

  /**
   * 获取工具
   */
  get(name) {
    return this._tools.get(name) || null;
  }

  /**
   * 是否存在指定工具
   */
  has(name) {
    return this._tools.has(name);
  }

  /**
   * 列出所有已注册工具名
   */
  list() {
    return Array.from(this._tools.keys());
  }
}

module.exports = { ToolRegistry };
