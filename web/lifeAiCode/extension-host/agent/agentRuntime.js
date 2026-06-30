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
const { estimateTokens, estimateStringTokens } = require('./modelContextWindow');

const MAX_ROUNDS = 10;
const DEFAULT_TIMEOUT = 5 * 60 * 1000; // 5 分钟
// §需求8-阶段3：自动压缩阈值（占 contextWindow 的比例）
const AUTO_COMPACT_THRESHOLD = 0.8;
// §需求8-阶段3：压缩后保留的最近消息数（user/assistant 成对）
const AUTO_COMPACT_KEEP_RECENT = 4;

class AgentRuntime {
  /**
   * @param {object} llmClient LLM 客户端
   * @param {AgentContext} context 运行时上下文
   */
  constructor(llmClient, context = {}) {
    this.llmClient = llmClient;
    // §需求：初始化 recentReadFiles —— toolExecutor 在调用读取类工具时会向该数组推入路径，
    // suggestionGenerator 用它兑底推断 suggestion.changes[i].filePath。
    this.context = { ...context, recentReadFiles: Array.isArray(context.recentReadFiles) ? context.recentReadFiles : [] };
    this.registry = new ToolRegistry();
    this.auditLogger = new AuditLogger();
    this.executor = new ToolExecutor(this.registry, this.context, this.auditLogger);
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
    // §需求8-阶段3：每个新任务允许触发一次自动压缩
    this._autoCompacted = false;
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
    const { onToken, onToolCall, onDone, onError, history } = callbacks;
    const signal = this._abortController.signal;
    const startTime = Date.now();

    try {
      // 初始上下文提示
      const contextStr = this._formatContext(initialContext);
      // §继续会话：若调用方传入历史消息，作为多轮上下文前置拼接
      // （过滤空内容，最多保留最近 20 条避免 token 爆炸）
      const historyMessages = Array.isArray(history) && history.length > 0
        ? history
            .filter((m) => m && m.content && typeof m.content === 'string' && m.content.trim())
            .slice(-20)
            .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
        : [];
      const messages = [
        ...historyMessages,
        { role: 'user', content: `${contextStr}\n\n## 用户任务\n${userInput}` },
      ];

      // 可选：复杂任务先让 LLM 做计划
      let planExecuted = false;
      if (this.planner.needsPlanning(userInput)) {
        this._notifyStep('think', '制定执行计划');
        // §需求8-阶段3：plan 生成前也检查 token 占用
        await this._maybeAutoCompact(messages, signal);
        const plan = await this._generatePlan(userInput, signal);
        if (plan && plan.length > 0) {
          // §需求9：下发计划给前端渲染 checklist
          this._notifyPlanGenerated(plan);
          // §需求9：按 plan step 顺序强制执行（而非仅作为提示塞进 messages）
          const planResults = await this._executePlan(plan, signal, onToolCall);
          planExecuted = true;
          // 把 plan 执行结果作为上下文塞进 messages，让 LLM 做最终总结
          const resultsText = planResults.map((r, i) => {
            const step = plan[i];
            const status = r.error ? '失败' : '完成';
            const summary = r.error ? r.error : (r.summary || '成功');
            return `步骤 ${i + 1} [${step.tool}] ${status}: ${summary}`;
          }).join('\n');
          messages.push({
            role: 'user',
            content: `## 计划执行结果\n${resultsText}\n\n请根据以上执行结果，给出任务总结。若有步骤失败，请说明原因和建议。`,
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

        // §需求8-阶段3：LLM 调用前检查 token 占用，超阈值自动压缩
        await this._maybeAutoCompact(messages, signal);

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
   * §需求9：下发计划给前端渲染 checklist
   */
  _notifyPlanGenerated(plan) {
    if (typeof this.context.postToWebView === 'function') {
      this.context.postToWebView({
        type: 'planGenerated',
        steps: plan.map((s, i) => ({
          step: i + 1,
          tool: s.tool,
          args: s.args || {},
          reason: s.reason || '',
        })),
      });
    }
  }

  /**
   * §需求9：按 plan step 顺序强制执行
   * 每个 step 调用 executor.execute(tool, args)，发送状态变更给前端
   * @returns {Promise<Array<{summary?: string, error?: string}>>} 每个 step 的结果
   */
  async _executePlan(plan, signal, onToolCall) {
    const results = [];
    for (let i = 0; i < plan.length; i++) {
      const step = plan[i];
      // 检查取消
      if (this.cancelled || signal.aborted) {
        this._notifyPlanStep(i, 'skipped');
        results.push({ error: '任务已取消' });
        continue;
      }

      // 通知前端：该步骤开始执行（记录开始时间）
      const stepStartTime = Date.now();
      this._notifyPlanStep(i, 'running', undefined, stepStartTime);
      this._notifyStep('think', `执行步骤 ${i + 1}/${plan.length}: ${step.tool}`);

      // 通知 UI tool_call（复用现有 ToolCallCard）
      if (typeof onToolCall === 'function') {
        onToolCall({
          name: step.tool,
          arguments: step.args || {},
        });
      }

      try {
        const result = await this.executor.execute(step.tool, step.args || {});
        const stepEndTime = Date.now();
        if (signal.aborted || this.cancelled) {
          this._notifyPlanStep(i, 'skipped', undefined, stepStartTime, stepEndTime);
          results.push({ error: '任务已取消' });
          continue;
        }
        // 提取结果摘要
        const summary = typeof result === 'string'
          ? result.slice(0, 200)
          : (result && result.summary) || (result && JSON.stringify(result).slice(0, 200)) || '成功';
        this._notifyPlanStep(i, 'done', summary, stepStartTime, stepEndTime);
        results.push({ summary });
      } catch (err) {
        const stepEndTime = Date.now();
        const errMsg = err instanceof Error ? err.message : String(err);
        this._notifyPlanStep(i, 'error', errMsg, stepStartTime, stepEndTime);
        results.push({ error: errMsg });
      }
    }
    return results;
  }

  /**
   * §需求9：通知前端某个 plan step 的状态变更
   * 待办任务：附带 startTime/endTime 时间戳，供 UI 显示执行时长
   */
  _notifyPlanStep(index, status, summary, startTime, endTime) {
    if (typeof this.context.postToWebView === 'function') {
      const msg = { type: 'planStepUpdate', index, status, summary };
      if (startTime !== undefined) msg.startTime = startTime;
      if (endTime !== undefined) msg.endTime = endTime;
      this.context.postToWebView(msg);
    }
  }

  /**
   * §需求8-阶段3：自动压缩检查
   *
   * 在每次 LLM 调用前调用：
   * 1. 估算 messages 的 token 占用
   * 2. 如果超过 contextWindow 的 80%，调 LLM 生成历史摘要
   * 3. 用摘要 + 最近 N 条消息替换 messages 数组（in-place 修改）
   * 4. 发 historyCompacted 消息通知前端同步替换
   *
   * 安全保证：
   * - 同一任务内压缩只触发一次（避免循环压缩）
   * - 压缩失败时不阻塞，继续用原 messages 调 LLM
   * - 保留最近 N 条消息，避免丢失最近上下文
   *
   * @param {Array} messages 可变数组，压缩会就地修改
   * @param {AbortSignal} signal
   */
  async _maybeAutoCompact(messages, signal) {
    if (this._autoCompacted) return; // 同一任务只压缩一次
    if (!messages || messages.length <= AUTO_COMPACT_KEEP_RECENT + 1) return;

    const contextWindow = typeof this.context.getContextWindow === 'function'
      ? this.context.getContextWindow()
      : 128000;
    const usedTokens = estimateTokens(messages);
    if (usedTokens < contextWindow * AUTO_COMPACT_THRESHOLD) return;

    if (!this.llmClient) return;
    if (signal.aborted || this.cancelled) return;

    this._autoCompacted = true;
    const toCompress = messages.slice(0, -AUTO_COMPACT_KEEP_RECENT);
    const recent = messages.slice(-AUTO_COMPACT_KEEP_RECENT);
    const beforeTokens = estimateTokens(toCompress);

    const transcript = toCompress
      .map((m) => {
        const role = m.role === 'assistant' ? 'AI' : '用户';
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
        return `${role}: ${content.slice(0, 1200)}`;
      })
      .join('\n\n');

    const summaryPrompt = [{
      role: 'user',
      content: `请将以下对话历史压缩为简洁的摘要（保留关键事实、用户意图、已完成的工作、关键决策、文件路径、错误信息，省略寒暄和冗余代码）。

对话历史：
${transcript}

请直接输出摘要，不要添加额外说明：`,
    }];

    try {
      this._notifyStep('think', '上下文超阈值，自动压缩中…');
      const summary = await this.llmClient.chat(summaryPrompt, { signal });
      const cleanSummary = String(summary || '')
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .trim();

      if (!cleanSummary) return;

      // 用摘要 + 最近消息替换 messages 内容（in-place）
      messages.length = 0;
      messages.push({
        role: 'user',
        content: `[历史对话摘要]\n${cleanSummary}`,
      }, ...recent);

      const afterTokens = estimateTokens(messages);

      // 通知前端替换 UI 中的消息
      if (typeof this.context.postToWebView === 'function') {
        this.context.postToWebView({
          type: 'historyCompacted',
          summary: cleanSummary,
          beforeTokens,
          afterTokens,
        });
      }

      this._notifyStep('think', `上下文已自动压缩：${beforeTokens} → ${afterTokens} tokens`);
    } catch (err) {
      if (err && (err.isAbort || err.name === 'AbortError' || this.cancelled)) return;
      console.warn('[AgentRuntime] 自动压缩失败:', err?.message || err);
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
