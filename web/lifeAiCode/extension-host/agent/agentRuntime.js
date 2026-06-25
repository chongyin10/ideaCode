/**
 * Agent Runtime
 *
 * 核心职责：
 * 1. 接收用户任务
 * 2. 组装上下文与 tools
 * 3. 驱动 LLM 多轮调用
 * 4. 执行 tool_call 并回传结果
 * 5. 总结输出并通知 UI
 */

const { ToolRegistry } = require('./toolRegistry');
const { ToolExecutor } = require('./toolExecutor');
const { LlmAdapter } = require('./llmAdapter');
const { Planner } = require('./planner');
const { AuditLogger } = require('./auditLogger');

const MAX_ROUNDS = 10;
const DEFAULT_TIMEOUT = 5 * 60 * 1000; // 5 分钟

class AgentRuntime {
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
  }

  /**
   * 运行一个 Agent 任务
   * @param {string} userInput 用户输入
   * @param {object} initialContext 初始代码上下文
   * @param {object} callbacks { onToken, onToolCall, onDone, onError }
   * @returns {Promise<string>} 最终总结
   */
  async run(userInput, initialContext, callbacks = {}) {
    if (this.isRunning) {
      throw new Error('已有 Agent 任务正在运行');
    }
    this.isRunning = true;
    this.cancelled = false;

    const { onToken, onToolCall, onDone, onError } = callbacks;
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
        const plan = await this._generatePlan(userInput);
        if (plan && plan.length > 0) {
          messages.push({
            role: 'user',
            content: `## 执行计划\n${JSON.stringify(plan, null, 2)}\n请按此计划调用工具完成任务。`,
          });
        }
      }

      let finalResponse = '';

      for (let round = 0; round < MAX_ROUNDS; round++) {
        if (this.cancelled) {
          finalResponse = '任务已取消';
          break;
        }

        if (Date.now() - startTime > DEFAULT_TIMEOUT) {
          finalResponse = '任务执行超时';
          break;
        }

        // 调用 LLM
        let currentResponse = '';
        const response = await this.adapter.chat(messages, {
          stream: true,
          onToken: (token) => {
            currentResponse += token;
            if (typeof onToken === 'function') {
              onToken(token);
            }
          },
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
          break;
        }

        // 通知 UI 有 tool_call
        if (typeof onToolCall === 'function') {
          onToolCall(toolCall);
        }

        // 生成 tool_call_id，用于 native tool calling 的消息关联
        const callId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

        // 将 assistant 的 tool_call 追加到 messages
        const reasoningContent = responseObject && typeof responseObject === 'object' ? responseObject.reasoningContent || '' : '';
        messages.push(this.adapter.buildToolCallMessage(toolCall.name, toolCall.arguments, callId, reasoningContent));

        // 执行 tool
        const result = await this.executor.execute(toolCall.name, toolCall.arguments);

        // 将 tool 结果追加到 messages
        messages.push(this.adapter.buildToolResultMessage(toolCall.name, result, callId));

        // 更新上下文（如 workspaceRoot 在执行过程中可能变化）
        this.context.workspaceRoot = this.context.workspaceRoot || '';
      }

      // 兜底：如果执行了工具但模型没有返回总结，再请求一次生成最终回答
      const executedToolCount = messages.filter((m) => m.role === 'tool').length;
      if (executedToolCount > 0 && (!finalResponse || !finalResponse.trim())) {
        try {
          const summaryMessages = [
            ...messages,
            { role: 'user', content: '请基于以上工具执行结果和读取到的文件内容，直接给出最终回答或改进建议。不要再次调用工具。' },
          ];
          const summaryResponse = await this.adapter.chat(summaryMessages, {
            stream: true,
            onToken: (token) => {
              if (typeof onToken === 'function') {
                onToken(token);
              }
            },
          });
          finalResponse =
            typeof summaryResponse === 'string'
              ? summaryResponse
              : (summaryResponse.content || summaryResponse.reasoningContent || '');
        } catch (err) {
          console.warn('[LifeAiCode][Agent] 生成总结失败:', err.message);
        }
      }

      if (typeof onDone === 'function') {
        onDone(finalResponse);
      }

      return finalResponse;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (typeof onError === 'function') {
        onError(error);
      }
      throw err;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * 取消当前任务
   */
  cancel() {
    this.cancelled = true;
  }

  /**
   * 生成任务计划
   */
  async _generatePlan(userInput) {
    if (!this.llmClient) return [];
    const { formatToolSchemasForPrompt } = require('./toolSchema');
    const prompt = this.planner.buildPlanningPrompt(userInput, formatToolSchemasForPrompt());
    try {
      const planContent = await this.llmClient.chat(
        [
          { role: 'system', content: this.adapter.buildAgentSystemPrompt() },
          { role: 'user', content: prompt },
        ],
        { systemPrompt: null }
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

module.exports = { AgentRuntime };
