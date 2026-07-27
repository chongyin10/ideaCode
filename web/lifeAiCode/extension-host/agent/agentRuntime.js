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
const { buildUserContent } = require('../imageUtils');

// §需求：创建项目/多文件任务需要大量 tool_call 轮次（每个文件至少一轮），
// 10 轮远不够（标准 Vite+React 项目就有 8-10 个文件 + npm install）。
// 增大到 30，确保复杂任务能完整执行。
const MAX_ROUNDS = 30;
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
    const { onToken, onToolCall, onDone, onError, history, images } = callbacks;
    const signal = this._abortController.signal;
    const startTime = Date.now();

    try {
      // 初始上下文提示
      const contextStr = this._formatContext(initialContext);
      // §继续会话：若调用方传入历史消息，作为多轮上下文前置拼接
      // （过滤空内容，最多保留最近 20 条避免 token 爆炸）
      // §DeepSeek thinking mode：assistant 消息需保留 reasoning_content，
      //   否则 API 报 400 "reasoning_content must be passed back"。
      //   llmClient._buildRequestBody 会根据 provider 决定是否发送给 API。
      const historyMessages = Array.isArray(history) && history.length > 0
        ? history
            .filter((m) => m && m.content && typeof m.content === 'string' && m.content.trim())
            .slice(-20)
            .map((m) => {
              const msg = { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content };
              if (m.role === 'assistant' && m.reasoning_content) {
                msg.reasoning_content = m.reasoning_content;
              }
              return msg;
            })
        : [];
      const messages = [
        ...historyMessages,
        // §多模态：有图片附件时 content 为 OpenAI 多模态数组（text + image_url）
        { role: 'user', content: buildUserContent(`${contextStr}\n\n## 用户任务\n${userInput}`, images) },
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

        // 统一处理返回值：returnRaw=true 时 native 和 prompt-based 均返回 { content, toolCalls, reasoningContent }
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

      // §任务总结：Agent 调用过工具且自然收敛时，额外生成一段自然语言总结。
      // 避免某些模型只输出 reasoning/空内容，导致用户看不到最终结论。
      if (converged && !this.cancelled && !signal.aborted && this._hasToolCalls(messages)) {
        try {
          const summary = await this._generateFinalSummary(userInput, messages, finalResponse, onToken, signal);
          if (summary) {
            finalResponse += summary;
          }
        } catch (err) {
          if (err && (err.isAbort || err.name === 'AbortError' || this.cancelled)) {
            // 中止时忽略总结错误
          } else {
            console.warn('[AgentRuntime] 生成最终总结失败:', err?.message || err);
          }
        }
      }

      // §同步阻塞模式：shell 命令在主循环中已同步等待完成（waitShellCompletion 阻塞），
      // 不再有 deferred 后台队列。主循环结束 = 所有 shell 已完成，直接触发 onDone。
      // 类似微任务/宏任务模式：shell = 同步屏障，主流程被卡住直到 shell 完成，
      // 所有 shell 完成后继续渲染主线。若主线中再次遇到 shell，同样阻塞等待。

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
   * 生成任务计划（流式）
   * §改为流式请求：把 LLM 输出的 token 实时推给前端渲染，
   * 避免用户在"制定执行计划"阶段看到长时间空白等待。
   */
  async _generatePlan(userInput, signal) {
    if (!this.llmClient) return [];
    const { formatToolSchemasForPrompt } = require('./toolSchema');
    const prompt = this.planner.buildPlanningPrompt(userInput, formatToolSchemasForPrompt());
    let planTokenListener = null;
    try {
      planTokenListener = (token) => {
        if (typeof this.context.postToWebView === 'function') {
          this.context.postToWebView({ type: 'planStreamToken', token });
        }
      };
      this.llmClient.on('token', planTokenListener);
      const planContent = await this.llmClient.chatStream(
        [
          { role: 'system', content: this.adapter.buildAgentSystemPrompt() },
          { role: 'user', content: prompt },
        ],
        { systemPrompt: null, signal }
      );
      return this.planner.parsePlan(planContent);
    } catch {
      return [];
    } finally {
      if (planTokenListener) {
        try { this.llmClient.off('token', planTokenListener); } catch { /* ignore */ }
      }
      // 通知前端计划流式输出结束（token: null 表示结束）
      if (typeof this.context.postToWebView === 'function') {
        this.context.postToWebView({ type: 'planStreamToken', token: null });
      }
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
        // §多模态消息：content 为数组时只取文本部分，图片以占位符表示，
        // 避免把 base64 图片数据（MB 级）塞进压缩 prompt
        const content = typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((part) => (part && part.type === 'text' ? part.text : '[图片]')).join('\n')
            : JSON.stringify(m.content || '');
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
      // §改为流式请求，与非流式保持一致，避免出现"非流式请求"日志
      const summary = await this.llmClient.chatStream(summaryPrompt, { signal });
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
   * §任务总结：判断本次任务是否调用过工具
   */
  _hasToolCalls(messages) {
    return messages.some((m) =>
      m.role === 'tool' ||
      m.tool_calls ||
      (typeof m.content === 'string' && (m.content.includes('<tool_call>') || m.content.includes('<tool_result>')))
    );
  }

  /**
   * §任务总结：基于任务执行过程和当前回复，生成一段自然语言总结。
   * 通过 onToken 把总结 token 推给调用方，让前端流式显示。
   */
  async _generateFinalSummary(userInput, messages, finalResponse, onToken, signal) {
    const executionLines = [];
    for (const m of messages) {
      if (m.role === 'tool') {
        let result = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        result = result.length > 200 ? result.slice(0, 200) + '...' : result;
        executionLines.push(`- 工具结果：${result}`);
      } else if (m.role === 'assistant' && m.tool_calls) {
        for (const tc of m.tool_calls) {
          const args = typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {});
          const argsShort = args.length > 150 ? args.slice(0, 150) + '...' : args;
          executionLines.push(`- 调用工具：${tc.function?.name}，参数：${argsShort}`);
        }
      } else if (m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('<tool_call>')) {
        const match = m.content.match(/<tool_call>\s*({[\s\S]*?})\s*<\/tool_call>/);
        if (match) {
          try {
            const tc = JSON.parse(match[1]);
            executionLines.push(`- 调用工具：${tc.name}，参数：${JSON.stringify(tc.arguments).slice(0, 200)}`);
          } catch {
            executionLines.push(`- 调用工具：${m.content.slice(0, 200)}`);
          }
        }
      } else if (m.role === 'user' && typeof m.content === 'string' && m.content.includes('<tool_result>')) {
        const result = m.content.replace(/<tool_result>\n?|\n?<\/tool_result>/g, '').slice(0, 200);
        executionLines.push(`- 工具结果：${result}`);
      }
    }

    const executionSummary = executionLines.join('\n') || '无';

    const summaryPrompt = [
      { role: 'system', content: '你是 LifeAiCode Agent 的总结助手。请根据用户任务和 Agent 执行过程，用中文生成一段简洁的最终总结。总结控制在 200 字以内，说明任务目标、执行了什么、关键发现。不要输出工具调用、步骤标签、代码块。' },
      { role: 'user', content: `## 用户任务\n${userInput}\n\n## 执行过程\n${executionSummary}\n\n## 当前回复\n${finalResponse || '（无）'}\n\n请生成最终总结：` }
    ];

    const prefix = '\n\n---\n\n**任务总结**：\n';
    if (typeof onToken === 'function') {
      onToken(prefix);
    }

    let summary = '';
    const summaryListener = (token) => {
      summary += token;
      if (typeof onToken === 'function') {
        onToken(token);
      }
    };

    try {
      this.llmClient.on('token', summaryListener);
      await this.llmClient.chatStream(summaryPrompt, { signal });
      return prefix + summary;
    } finally {
      try { this.llmClient.off('token', summaryListener); } catch { /* ignore */ }
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
