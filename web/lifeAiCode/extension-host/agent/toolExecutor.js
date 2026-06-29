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
  /**
   * §需求：读取类工具名单——执行这类工具时会把 args.path 记入 context.recentReadFiles，
   * suggestionGenerator 用它做 filePath 兑底推断。
   */
  static get READ_FILE_TOOLS() {
    return new Set([
      'read_file',
      'read_file_outline',
      'read_file_lines',
      'read_file_chunks',
      'search_in_file',
    ]);
  }

  /**
   * §需求：记录读取类工具调用过的路径，供 suggestionGenerator 推断 filePath。
   * - 保序、去重、保留最近 10 个。
   * - 若同一路径连续多次读取，只保留一次。
   */
  _trackRecentReadFile(tool, args) {
    if (!ToolExecutor.READ_FILE_TOOLS.has(tool)) return;
    if (!args || typeof args.path !== 'string' || !args.path) return;
    const filePath = args.path;
    if (!this.context.recentReadFiles || !Array.isArray(this.context.recentReadFiles)) {
      this.context.recentReadFiles = [];
    }
    const list = this.context.recentReadFiles;
    // 移除已存在的同路径（保持“最近”语义）
    const idx = list.indexOf(filePath);
    if (idx !== -1) list.splice(idx, 1);
    // 推入头部
    list.unshift(filePath);
    // 保留最近 10 个
    if (list.length > 10) list.length = 10;
  }

  async execute(name, args) {
    const startTime = Date.now();
    const tool = this.registry.get(name);

    // 通知 WebView 开始执行
    this._notifyToolCall(name, args, 'running');

    // §需求：跟踪读取类工具的路径，以便后续 suggestion 兑底推断 filePath
    this._trackRecentReadFile(name, args);

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
      if (!prop || !prop.type) continue;
      // 补充 array / object 类型的校验：
      // typeof [] === 'object'，原逻辑 `typeof value !== prop.type` 会把数组误判为类型错误。
      if (prop.type === 'array') {
        if (!Array.isArray(value)) {
          return { valid: false, error: `参数 ${key} 类型错误，期望 array` };
        }
      } else if (prop.type === 'object') {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          return { valid: false, error: `参数 ${key} 类型错误，期望 object` };
        }
      } else if (prop.type === 'number') {
        // Bug 20: typeof NaN === 'number' 为 true，原校验会让 NaN / Infinity 通过，
        // 导致后续工具（如分页 limit: NaN）产生异常。用 Number.isFinite 严格拦截。
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          return { valid: false, error: `参数 ${key} 类型错误，期望有限数值（number）` };
        }
      } else if (typeof value !== prop.type) {
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
      else if (result.largeFile) summary = `大文件模式: ${result.symbols?.length || 0} 符号, ${result.totalLines || 0} 行`;
      else if (result.outline !== undefined) summary = `大纲: ${result.symbols?.length || 0} 符号, ${result.totalLines || 0} 行`;
      else if (result.content !== undefined && result.startLine !== undefined) summary = `L${result.startLine}-L${result.endLine}, ${result.content.length} 字符`;
      else if (result.content !== undefined && result.chunkIndex !== undefined) summary = `块 ${result.chunkIndex}/${Math.max(0, (result.totalChunks || 1) - 1)}, ${result.content.length} 字符`;
      else if (result.matches !== undefined) summary = `找到 ${result.matchCount || result.totalMatches || 0} 处匹配`;
      else if (result.content !== undefined) summary = `共 ${result.content.length} 字符`;
      else if (result.tree !== undefined) summary = `共 ${result.fileCount || 0} 个文件/目录`;
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
    // 大字段保留但限制长度/数量，避免推给 WebView 的消息过大导致渲染卡顿
    // matches（searchFiles 返回）可能包含大量匹配项，单独处理数组截断
    for (const key of ['content', 'output', 'tree', 'matches', 'outline', 'symbols', 'imports', 'exports']) {
      const v = clone[key];
      if (typeof v === 'string' && v.length > 1000) {
        clone[key] = v.slice(0, 1000) + '\n...（已截断）...';
      } else if (Array.isArray(v) && v.length > 20) {
        clone[key] = v.slice(0, 20).concat([`...（共 ${v.length} 项，已截断）...`]);
      }
    }
    return clone;
  }
}

module.exports = { ToolExecutor };
