/**
 * Tool Executor
 *
 * 执行 Agent 调用的工具，包含：
 * - 参数校验
 * - 权限检查
 * - 执行时间统计
 * - 结果格式化
 * - 事件通知 WebView
 */

const { getToolSchema } = require('./toolSchema');

class ToolExecutor {
  constructor(registry, context, auditLogger) {
    this.registry = registry;
    this.context = context || {};
    this.auditLogger = auditLogger;
  }

  /**
   * 执行单个 tool_call
   * @param {string} name 工具名
   * @param {object} args 工具参数
   * @returns {Promise<object>} { success, ...result }
   */
  async execute(name, args) {
    const startTime = Date.now();
    const tool = this.registry.get(name);

    // 通知 WebView 开始执行
    this._notifyToolCall(name, args, 'running');

    if (!tool) {
      const error = `未知工具: ${name}`;
      this._notifyToolCall(name, args, 'error', { error }, Date.now() - startTime);
      return { success: false, error };
    }

    // 参数基础校验
    const schema = getToolSchema(name);
    if (schema) {
      const validation = this._validateArgs(args, schema);
      if (!validation.valid) {
        this._notifyToolCall(name, args, 'error', { error: validation.error }, Date.now() - startTime);
        return { success: false, error: validation.error };
      }
    }

    try {
      const result = await tool(args, this.context);
      const duration = Date.now() - startTime;
      const status = result.success ? 'success' : 'error';
      this._notifyToolCall(name, args, status, result, duration);
      this._audit(name, args, status, result);
      return result;
    } catch (err) {
      const duration = Date.now() - startTime;
      const error = err instanceof Error ? err.message : String(err);
      this._notifyToolCall(name, args, 'error', { error }, duration);
      this._audit(name, args, 'error', undefined, error);
      return { success: false, error };
    }
  }

  /**
   * 审计日志
   */
  _audit(tool, args, status, result, error) {
    if (!this.auditLogger) return;
    this.auditLogger.log({
      tool,
      args,
      status,
      result: result ? { success: result.success, message: result.message || result.error || '' } : undefined,
      error,
      confirmed: result ? result.pending === false : undefined,
    });
  }

  /**
   * 校验参数
   */
  _validateArgs(args, schema) {
    const params = schema.parameters || {};
    const properties = params.properties || {};
    const required = params.required || [];

    for (const key of required) {
      if (args[key] === undefined || args[key] === null) {
        return { valid: false, error: `缺少必填参数: ${key}` };
      }
    }

    for (const [key, value] of Object.entries(args)) {
      const prop = properties[key];
      if (!prop) continue;
      if (prop.type && typeof value !== prop.type && !(prop.type === 'number' && typeof value === 'number')) {
        return { valid: false, error: `参数 ${key} 类型错误，期望 ${prop.type}` };
      }
    }

    return { valid: true };
  }

  /**
   * 通知 WebView Tool 调用状态
   */
  _notifyToolCall(name, args, status, result, duration) {
    if (typeof this.context.postToWebView !== 'function') return;

    // 对结果做摘要，避免推送过大内容到 UI
    let summary = '';
    if (result) {
      if (result.error) summary = result.error;
      else if (result.content !== undefined) summary = `共 ${result.content.length} 字符`;
      else if (result.tree !== undefined) summary = `共 ${result.fileCount || 0} 个文件/目录`;
      else if (result.matches !== undefined) summary = `找到 ${result.matchCount || 0} 处匹配`;
      else if (result.output !== undefined) summary = result.output.slice(0, 200);
      else if (result.message) summary = result.message;
    }

    this.context.postToWebView({
      type: 'toolCall',
      tool: name,
      args,
      status,
      duration,
      summary,
      result: this._sanitizeResult(result),
    });
  }

  /**
   * 清理结果中不适合推给 UI 的过大字段
   */
  _sanitizeResult(result) {
    if (!result || typeof result !== 'object') return result;
    const clone = { ...result };
    // content / output / tree 等大字段保留但限制长度
    for (const key of ['content', 'output', 'tree']) {
      if (typeof clone[key] === 'string' && clone[key].length > 1000) {
        clone[key] = clone[key].slice(0, 1000) + '\n...（已截断）...';
      }
    }
    return clone;
  }
}

module.exports = { ToolExecutor };
