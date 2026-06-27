/**
 * Agent Runtime
 *
 * 核心职责：
 * 1. 接收用户任务
 * 2. 组装上下文与 tools
 * 3. 驱动 LLM 多轮调用
 * 4. 执行 tool_call 并回传结果
 * 5. 总结输出并通知 UI
 *
 * 设计要点：
 * - 队列：同一实例只允许 1 个 active 任务；新任务请求会被加入队列，按 FIFO 等待
 * - AbortController：cancel() 会立即终止正在进行的 LLM 请求（不再等响应）
 * - 流式：通过 adapter.chat 的 onToken 实时把 token 推给调用方
 */

const { ToolRegistry } = require('./toolRegistry');
const { ToolExecutor } = require('./toolExecutor');
const { LlmAdapter } = require('./llmAdapter');
const { Planner } = require('./planner');
const { AuditLogger } = require('./auditLogger');

const MAX_ROUNDS = 10;
const DEFAULT_TIMEOUT = 5 * 60 * 1000; // 5 分钟

class AgentRuntime {
  /**
   * @param {object} llmClient LLM 客户端
   * @param {AgentContext} context 运行时上下文
   */
  constructor(llmClient, context = {}) {
    this.llmClient = llmClient;
    this.context = context;
    this.registry = new ToolRegistry();
    this.auditLogger = new AuditLogger();
    this.executor = new ToolExecutor(this.registry, context, this.auditLogger);
    this.adapter = new LlmAdapter(llmClient);
    this.planner = new Planner();
    this.isRunning = false;
    this.cancelled = false;
    /** @type {AbortController|null} 当前任务的 AbortController */
    this._abortController = null;
    /** @type {Array<{userInput: string, context: object, callbacks: object, resolve: Function, reject: Function}>} 任务队列 */
    this._queue = [];
  }

  /**
   * 运行一个 Agent 任务
   * - 若已有任务在跑，新任务进入队列
   * - 返回 Promise，在该任务执行结束时 resolve / reject
   * @param {string} userInput 用户输入
   * @param {object} initialContext 初始代码上下文
   * @param {object} callbacks { onToken, onToolCall, onDone, onError }
   * @returns {Promise<string>} 最终总结
   */
  run(userInput, initialContext, callbacks = {}) {
    return new Promise((resolve, reject) => {
      this._queue.push({ userInput, initialContext, callbacks, resolve, reject });
      this._drainQueue();
    });
  }

  /** 队列调度：依次执行任务（同时只跑一个） */
  async _drainQueue() {
    if (this.isRunning) return;
    const next = this._queue.shift();
    if (!next) return;
    this.isRunning = true;
    this.cancelled = false;
    this._abortController = new AbortController();
    try {
      const result = await this._runOne(next);
      next.resolve(result);
    } catch (err) {
      next.reject(err);
    } finally {
      this.isRunning = false;
      this._abortController = null;
      // 递归处理队列中剩余任务
      if (this._queue.length > 0) this._drainQueue();
    }
  }

  /**
   * 内部：执行单个任务
   * @returns {Promise<string>} 最终总结
   */
  async _runOne({ userInput, initialContext, callbacks }) {
    const { onToken, onToolCall, onDone, onError } = callbacks;
    const signal = this._abortController.signal;
    const startTime = Date.now();

    try {
      // 初始上下文提示
      const contextStr = this._formatContext(initialContext);
      const messages = [
        { role: 'user', content: `${contextStr}\n\n## 用户任务\n${userInput}` },
      ];

      // 可选：复杂任务先让 LLM 做计划
      if (this.planner.needsPlanning(userInput)) {
        this._notifyStep('think', '制定执行计划');
        const plan = await this._generatePlan(userInput, signal);
        if (plan && plan.length > 0) {
          messages.push({
            role: 'user',
            content: `## 执行计划\n${JSON.stringify(plan, null, 2)}\n请按此计划调用工具完成任务。`,
          });
        }
      }

      let finalResponse = '';
      // 跟踪任务是否自然收敛（LLM 不再发 tool_call）。
      // 若循环跑满 MAX_ROUNDS 仍未收敛，需要给用户明确提示，
      // 否则用户会以为任务正常完成，而实际上 LLM 还想继续调工具但被截断了。
      let converged = false;

      for (let round = 0; round < MAX_ROUNDS; round++) {
        if (this.cancelled) {
          finalResponse = '任务已取消';
          break;
        }
        if (signal.aborted) {
          finalResponse = '任务已中止';
          break;
        }
        if (Date.now() - startTime > DEFAULT_TIMEOUT) {
          finalResponse = '任务执行超时';
          break;
        }

        // 调用 LLM（带 AbortSignal，cancel() 时立即终止）
        let currentResponse = '';
        const response = await this.adapter.chat(messages, {
          stream: true,
          onToken: (token) => {
            currentResponse += token;
            if (typeof onToken === 'function') {
              onToken(token);
            }
          },
          signal,
        });

        // 统一处理返回值：native 返回 { content, toolCalls }，prompt-based 返回字符串
        let responseContent = '';
        let responseObject = null;
        if (response && typeof response === 'object') {
          responseContent = response.content || '';
          responseObject = response;
        } else if (typeof response === 'string') {
          responseContent = response;
        } else {
          responseContent = currentResponse;
        }

        finalResponse = responseContent;

        // 解析 tool_call（native 或 prompt-based）
        const toolCall = this.adapter.extractToolCall(responseObject || responseContent);
        if (!toolCall) {
          // 没有 tool_call，任务完成
          converged = true;
          break;
        }

        // 通知 UI 有 tool_call
        if (typeof onToolCall === 'function') {
          onToolCall(toolCall);
        }

        // 生成 tool_call_id，用于 native tool calling 的消息关联
        const callId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

        // S4: 把本轮 LLM 回复的 reasoning_content 一起带入 messages，
        // 否则 DeepSeek 等 Provider 的思维链在 Agent 多轮中断裂，
        // 后续轮次 LLM 看不到自己上一步的推理内容，可能导致重复思考或上下文不一致
        const reasoningContent = (responseObject && responseObject.reasoningContent) || '';
        // 将 assistant 的 tool_call 追加到 messages
        messages.push(this.adapter.buildToolCallMessage(toolCall.name, toolCall.arguments, callId, reasoningContent));

        // 执行 tool（也支持中止）
        const result = await this.executor.execute(toolCall.name, toolCall.arguments);
        if (signal.aborted || this.cancelled) {
          finalResponse = '任务已中止';
          break;
        }

        // 将 tool 结果追加到 messages
        messages.push(this.adapter.buildToolResultMessage(toolCall.name, result, callId));

        // 更新上下文（如 workspaceRoot 在执行过程中可能变化）
        this.context.workspaceRoot = this.context.workspaceRoot || '';
      }

      // 达到最大轮次仍未收敛：补充提示，避免用户误以为任务正常完成
      if (!converged && !this.cancelled && !signal.aborted && finalResponse !== '任务执行超时') {
        finalResponse = (finalResponse || '') + `\n\n[已达到最大轮次 ${MAX_ROUNDS}，任务自动停止。如需继续，请重新发起。]`;
        this._notifyStep('done', `达到最大轮次 ${MAX_ROUNDS}，任务停止`);
      }

      if (typeof onDone === 'function') {
        onDone(finalResponse);
      }

      return finalResponse;
    } catch (err) {
      // 中止错误转成普通取消，不抛
      if (err && (err.isAbort || err.name === 'AbortError' || this.cancelled)) {
        const msg = '任务已取消';
        if (typeof onError === 'function') onError(msg);
        return msg;
      }
      const error = err instanceof Error ? err.message : String(err);
      if (typeof onError === 'function') {
        onError(error);
      }
      throw err;
    }
  }

  /**
   * 取消当前任务。
   * - 若有正在进行的 LLM / tool 调用，会通过 AbortController 立即中断
   * - 队列中等待的任务也会被中止（resolve 时 isRunning 已被 reset）
   */
  cancel() {
    this.cancelled = true;
    if (this._abortController) {
      try { this._abortController.abort(); } catch { /* ignore */ }
    }
  }

  /**
   * 当前是否在运行（包括队列）
   */
  get isBusy() {
    return this.isRunning || this._queue.length > 0;
  }

  /**
   * 清空任务队列（已开始的当前任务继续）
   */
  clearQueue() {
    for (const task of this._queue) {
      task.reject(new Error('任务队列已清空'));
    }
    this._queue.length = 0;
  }

  /**
   * 生成任务计划
   */
  async _generatePlan(userInput, signal) {
    if (!this.llmClient) return [];
    const { formatToolSchemasForPrompt } = require('./toolSchema');
    const prompt = this.planner.buildPlanningPrompt(userInput, formatToolSchemasForPrompt());
    try {
      const planContent = await this.llmClient.chat(
        [
          { role: 'system', content: this.adapter.buildAgentSystemPrompt() },
          { role: 'user', content: prompt },
        ],
        { systemPrompt: null, signal }
      );
      return this.planner.parsePlan(planContent);
    } catch {
      return [];
    }
  }

  /**
   * 格式化代码上下文为 prompt
   */
  _formatContext(context) {
    if (!context) return '';
    const parts = [];

    if (context.workspaceRoot) {
      parts.push(`## 工作区\n${context.workspaceRoot}`);
    }
    if (context.fileTree) {
      parts.push(`## 项目结构\n${context.fileTree}`);
    }
    if (context.activeFile) {
      const f = context.activeFile;
      parts.push(`## 当前文件: ${f.filePath}\n\`\`\`${f.language}\n${f.content}\n\`\`\``);
    }
    if (context.selection) {
      parts.push(`## 选中代码\n\`\`\`\n${context.selection}\n\`\`\``);
    }
    if (context.relatedFiles && context.relatedFiles.length > 0) {
      parts.push('## 相关文件');
      for (const f of context.relatedFiles) {
        parts.push(`### ${f.filePath}\n\`\`\`${f.language}\n${f.content}\n\`\`\``);
      }
    }

    return parts.join('\n\n');
  }

  /**
   * 通知 UI 步骤
   */
  _notifyStep(type, target) {
    if (typeof this.context.postToWebView === 'function') {
      this.context.postToWebView({
        type: 'step',
        stepType: type,
        target,
        status: 'running',
      });
    }
  }
}

/**
 * Agent 运行时上下文接口（仅作 JSDoc 提示）
 * @typedef {Object} AgentContext
 * @property {string} [workspaceRoot] 工作区根目录
 * @property {Function} [postToWebView] 推送消息到 webview
 * @property {Function} [executeShell] 执行 shell 命令
 * @property {Function} [registerPendingEdit] 注册待用户确认的编辑
 * @property {Function} [rpc] JSON-RPC 调用
 */

module.exports = { AgentRuntime };
