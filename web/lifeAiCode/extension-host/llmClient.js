/**
 * LLM API 客户端
 *
 * 职责：
 * - 封装与 LLM API（OpenAI / Anthropic / Ollama 等）的通信
 * - 支持流式（SSE）和非流式响应
 * - 支持多 Provider 切换
 * - 请求重试与超时
 *
 * 原则：
 * - 只读：此客户端仅用于获取分析结果和建议，绝不写入文件
 */

const https = require('https');
const http = require('http');
const { EventEmitter } = require('events');

const PROVIDERS = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    chatPath: '/chat/completions',
    models: ['gpt-4', 'gpt-4-turbo', 'gpt-4o', 'gpt-3.5-turbo'],
    defaultModel: 'gpt-4o',
    headers: (apiKey) => ({
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }),
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    chatPath: '/messages',
    models: ['claude-3-opus-20240229', 'claude-3-sonnet-20240229', 'claude-3-haiku-20240307'],
    defaultModel: 'claude-3-sonnet-20240229',
    headers: (apiKey) => ({
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    }),
  },
  ollama: {
    baseUrl: 'http://localhost:11434',
    chatPath: '/api/chat',
    models: ['codellama', 'deepseek-coder', 'llama3', 'qwen2.5-coder'],
    defaultModel: 'deepseek-coder',
    headers: () => ({ 'Content-Type': 'application/json' }),
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    chatPath: '/chat/completions',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-v4-flash',
    headers: (apiKey) => ({
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }),
  },
  glm: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    chatPath: '/chat/completions',
    models: ['glm-5.2', 'glm-5.1', 'glm-5', 'glm-4.5', 'glm-4-plus', 'glm-4-air', 'glm-4-flash'],
    defaultModel: 'glm-5.2',
    headers: (apiKey) => ({
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }),
  },
  qwen: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    chatPath: '/chat/completions',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen2.5-coder-32b-instruct', 'qwen2.5-72b-instruct'],
    defaultModel: 'qwen-plus',
    headers: (apiKey) => ({
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }),
  },
  kimi: {
    baseUrl: 'https://api.moonshot.cn/v1',
    chatPath: '/chat/completions',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'moonshot-v1-auto'],
    defaultModel: 'moonshot-v1-32k',
    headers: (apiKey) => ({
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }),
  },
  MiniMax: {
    baseUrl: 'https://api.minimaxi.com/v1',
    chatPath: '/chat/completions',
    models: ['MiniMax-M3', 'MiniMax-Text-01', 'MiniMax-Text-01-32K', 'MiniMax-Text-01-128K', 'abab6.5s-chat', 'abab6.5-chat'],
    defaultModel: 'MiniMax-M3',
    headers: (apiKey) => ({
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }),
  },
  doubao: {
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    chatPath: '/chat/completions',
    models: ['doubao-lite-4k', 'doubao-lite-16k', 'doubao-lite-32k', 'doubao-lite-128k', 'doubao-pro-4k', 'doubao-pro-32k', 'doubao-pro-128k'],
    defaultModel: 'doubao-pro-32k',
    headers: (apiKey) => ({
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }),
  },
  custom: {
    baseUrl: 'https://api.openai.com/v1',
    chatPath: '/chat/completions',
    models: [],
    defaultModel: 'gpt-4o',
    headers: (apiKey) => ({
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }),
  },
};

class LlmClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.provider = options.provider || 'openai';
    this.apiKey = options.apiKey || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || '';
    this.model = options.model || PROVIDERS[this.provider]?.defaultModel || 'gpt-4o';
    this.baseUrl = options.baseUrl || PROVIDERS[this.provider]?.baseUrl || '';
    this.timeout = options.timeout || 30000;
    this.maxRetries = options.maxRetries || 3;
    this.systemPrompt = options.systemPrompt || this._defaultSystemPrompt();
    /** @type {import('http').ClientRequest|null} */
    this.activeRequest = null;
    this.aborted = false;
    /** @type {AbortController|null} 用于在多轮调用间传递的中止控制器 */
    this._abortController = null;
  }

  /**
   * 中止当前正在进行的请求
   * - 销毁活跃 HTTP 请求
   * - 标记 aborted，重试循环会立即退出
   */
  abort() {
    this.aborted = true;
    if (this._abortController && !this._abortController.signal.aborted) {
      try { this._abortController.abort(); } catch { /* ignore */ }
    }
    if (this.activeRequest && !this.activeRequest.destroyed) {
      this.activeRequest.destroy();
      this.activeRequest = null;
    }
  }

  resetAbort() {
    this.aborted = false;
  }

  _createAbortError() {
    const err = new Error('请求已中止');
    err.isAbort = true;
    return err;
  }

  /**
   * 检查是否中止（统一从 signal / aborted 标志读取）
   */
  _isAborted(signal) {
    if (this.aborted) return true;
    if (signal && signal.aborted) return true;
    return false;
  }

  /**
   * 默认系统提示词 — 强调只读分析原则
   */
  _defaultSystemPrompt() {
    return `你是 LifeAiCode，运行在 IDEACODE IDE 中的一个 AI 代码辅助工具。

## 工作区上下文
- 你已经通过 IDE 获得了用户当前打开的工作区信息
- 每次对话的提示词中都会包含「## 工作区」和「## 项目结构」等上下文
- 你可以基于这些上下文回答用户关于项目结构、代码定位、文件关系等问题
- 不要说自己无法访问本地文件系统；当上下文已提供时，直接基于上下文进行分析

## 核心原则：只读分析，绝不修改代码
- 你只能分析代码并提供建议，绝对不能直接修改用户的代码文件
- 你的输出必须是建议性质的，格式为代码片段（diff 格式或完整函数）
- 用户需要明确确认后，才会应用你的建议

## 输出格式要求
当提供代码建议时，请在回答中使用以下格式标记建议块：

\`\`\`suggestion
// 文件名: path/to/file.ts
// 类型: refactor | bugfix | feature | optimization | explanation

对建议的简短解释

- 原始代码行（需要删除/修改的部分）
+ 修改后的代码行（新增/替换的部分）
\`\`\`

- 建议使用代码块（\`\`\`）包裹代码片段，并标注语言（如 \`\`\`typescript、\`\`\`json）。
- 普通说明请使用无序列表或有序列表；不要对列表项使用 Markdown 的 > 引用语法，避免产生嵌套引用块。
- 描述文件关系、项目结构时，使用缩进列表、表格或纯文本，不要插入 →、-> 等箭头符号。

## 步骤可视化
当你在分析过程中执行读取文件、思考、编辑、运行命令等动作时，请使用以下标签让 IDE 实时显示进度：
- 读取文件：\`<step type="read" target="path/to/file.ts" status="done">读取</step>\`
- 推理思考：\`<step type="think">正在分析...</step>\`
- 编辑文件：\`<step type="edit" target="path/to/file.ts">正在编辑</step>\`
- 运行命令：\`<step type="run" target="npm run build">运行</step>\`
- 调用 Agent：\`<step type="agent" target="search">调用 Agent</step>\`

## 行为准则
1. 分析代码上下文时，保持客观准确
2. 不确定时，明确指出不确定性
3. 优先推荐安全的、类型友好的修改
4. 解释每个建议的理由和潜在影响
5. 如果建议涉及多个文件，分别列出每个文件的变更
6. 对复杂变更提供步骤说明`;
  }

  configure(options) {
    if (options.provider && PROVIDERS[options.provider]) {
      this.provider = options.provider;
      this.baseUrl = options.baseUrl || PROVIDERS[this.provider]?.baseUrl || this.baseUrl;
    }
    if (options.apiKey) this.apiKey = options.apiKey;
    if (options.model) this.model = options.model;
    if (options.systemPrompt) this.systemPrompt = options.systemPrompt;
    if (options.timeout) this.timeout = options.timeout;
  }

  /**
   * 发送聊天请求（非流式）
   * @param {Array} messages
   * @param {object} options { systemPrompt?, tools?, tool_choice?, returnRaw?, signal? }
   * @returns {string|{content:string,toolCalls:Array}} 默认返回 content 字符串；options.returnRaw=true 时返回对象
   */
  async chat(messages, options = {}) {
    this.resetAbort();
    const provider = PROVIDERS[this.provider];
    if (!provider) throw new Error(`不支持的 Provider: ${this.provider}`);

    const body = this._buildRequestBody(provider, messages, false, options);
    const url = this._getRequestUrl(provider);

    let lastError = null;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      if (this._isAborted(options.signal)) throw this._createAbortError();
      try {
        const res = await this._httpRequest(url.toString(), {
          method: 'POST',
          headers: provider.headers(this.apiKey),
          body: JSON.stringify(body),
          timeout: this.timeout,
        }, options);
        const parsed = this._parseResponse(provider, res);
        return options.returnRaw ? parsed : (parsed.content || '');
      } catch (err) {
        lastError = err;
        console.warn(`[LifeAiCode] LLM 请求失败 (${attempt + 1}/${this.maxRetries}):`, err.message);
        if (this._isAborted(options.signal)) throw this._createAbortError();
        if (err.isAbort) throw err;
        if (attempt < this.maxRetries - 1) {
          await this._sleep(500 * (attempt + 1));
        }
      }
    }
    throw lastError;
  }

  /**
   * 发送聊天请求（流式）
   * @param {Array} messages
   * @param {object} options { systemPrompt?, tools?, tool_choice?, returnRaw?, signal? }
   * @returns {Promise<string|{content:string,toolCalls:Array}>} 默认返回 content 字符串；options.returnRaw=true 时返回对象
   *
   * 注意：流式过程会持续 emit 'token' 事件（每个 delta），end 时 emit 'end'。
   * 最终返回值仅在所有 chunks 处理完后由 Promise resolve。
   */
  async chatStream(messages, options = {}) {
    // B1: chatStream 缺少 resetAbort()，全局共享单例下上一次 abort() 的残留标志会导致本次请求立即被判定为已中止
    this.resetAbort();
    const provider = PROVIDERS[this.provider];
    if (!provider) throw new Error(`不支持的 Provider: ${this.provider}`);

    const body = this._buildRequestBody(provider, messages, true, options);
    const url = this._getRequestUrl(provider);

    // B2: 流式请求不重试 — 已 emit 给 UI 的 token 无法回收，重试会导致输出重复
    // 若需重试，应由上层（agentRuntime）丢弃本次部分输出后整体重发
    if (this._isAborted(options.signal)) throw this._createAbortError();
    try {
      const result = await this._httpStreamRequest(url.toString(), {
        method: 'POST',
        headers: provider.headers(this.apiKey),
        body: JSON.stringify(body),
        timeout: this.timeout,
      }, options);
      if (this._isAborted(options.signal)) throw this._createAbortError();
      if (options.returnRaw) return result;
      // 非 raw 模式返回 content 字符串
      return typeof result === 'string' ? result : (result.content || '');
    } catch (err) {
      if (this._isAborted(options.signal)) throw this._createAbortError();
      if (err && err.isAbort) throw err;
      throw err;
    }
  }

  _getRequestUrl(provider) {
    const base = this.baseUrl || provider.baseUrl;
    if (!base) {
      throw new Error('Base URL 未配置，请在配置面板填写');
    }
    // 保证 baseUrl 末尾有斜杠，且 chatPath 是相对路径，避免 /v1 被覆盖
    const normalizedBase = base.endsWith('/') ? base : `${base}/`;
    const chatPath = provider.chatPath.startsWith('/') ? provider.chatPath.slice(1) : provider.chatPath;
    return new URL(chatPath, normalizedBase);
  }

  _buildRequestBody(provider, messages, stream, options = {}) {
    const systemPrompt = options.systemPrompt !== undefined ? options.systemPrompt : this.systemPrompt;
    // 当 systemPrompt 为 null 或空字符串时，不附加默认 system 消息（由调用方在 messages 中自行提供）
    const prependSystem = systemPrompt ? [{ role: 'system', content: systemPrompt }] : [];
    // 仅 DeepSeek 支持 reasoning_content 回传；其他 Provider 需剥离，避免报错
    const supportsReasoning = this.provider === 'deepseek';
    const sanitizedMessages = messages.map((m) => {
      const hasReasoning = supportsReasoning && m.role === 'assistant' && m.reasoning_content;
      const { reasoning_content, ...rest } = m;
      return hasReasoning ? { ...rest, reasoning_content } : rest;
    });
    const body = {
      model: this.model,
      stream,
      messages: [
        ...prependSystem,
        ...sanitizedMessages,
      ],
    };

    // 只有 OpenAI 兼容 Provider 支持 tools/tool_choice
    if (options.tools && ['openai', 'deepseek', 'glm', 'qwen', 'kimi', 'MiniMax', 'doubao', 'custom'].includes(this.provider)) {
      body.tools = options.tools;
      if (options.tool_choice) {
        body.tool_choice = options.tool_choice;
      }
    }

    switch (this.provider) {
      case 'anthropic':
        return {
          model: this.model,
          max_tokens: 4096,
          stream,
          system: systemPrompt || undefined,
          messages: messages.map((m) => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: m.content,
          })),
        };
      case 'ollama':
        return {
          model: this.model,
          stream,
          messages: [
            ...prependSystem,
            ...messages,
          ],
        };
      case 'openai':
      default:
        return body;
    }
  }

  _parseResponse(provider, responseBody) {
    let data;
    try {
      data = JSON.parse(responseBody);
    } catch {
      throw new Error(`LLM 响应解析失败: ${responseBody.slice(0, 200)}`);
    }

    const message = data.choices?.[0]?.message || {};
    const toolCalls = message.tool_calls || [];
    const reasoningContent = message.reasoning_content || '';

    switch (this.provider) {
      case 'anthropic':
        return { content: data.content?.[0]?.text || '', toolCalls: [], reasoningContent: '' };
      case 'ollama':
        return { content: data.message?.content || '', toolCalls: [], reasoningContent: '' };
      case 'openai':
      default:
        return {
          content: message.content || '',
          toolCalls: Array.isArray(toolCalls) ? toolCalls : [],
          reasoningContent,
        };
    }
  }

  /**
   * 流式 HTTP 请求（SSE）
   */
  _httpStreamRequest(urlString, options, requestOptions = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlString);
      const isHttps = url.protocol === 'https:';
      const requester = isHttps ? https : http;

      const reqOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: options.method,
        headers: options.headers,
        timeout: options.timeout,
      };

      console.log(`[LifeAiCode] 流式请求: ${options.method} ${urlString}`);

      // 处理外部 signal 中止
      const signal = requestOptions.signal;
      if (signal) {
        if (signal.aborted) {
          reject(this._createAbortError());
          return;
        }
        signal.addEventListener('abort', () => {
          if (!req.destroyed) {
            try { req.destroy(); } catch { /* ignore */ }
          }
          reject(this._createAbortError());
        }, { once: true });
      }

      const req = requester.request(reqOptions, (res) => {
        this.activeRequest = req;
        // 检查 HTTP 状态码，非 2xx 时直接拒绝
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          let errorData = '';
          res.on('data', (chunk) => { errorData += chunk.toString(); });
          res.on('end', () => {
            reject(new Error(`LLM API 错误 ${res.statusCode}: ${errorData.slice(0, 500)}`));
          });
          res.on('error', reject);
          return;
        }

        let fullContent = '';
        let fullReasoningContent = '';
        let buffer = '';
        // reasoning → content 切换跟踪：把 DeepSeek 的 reasoning_content
        // 包装成 <think>...</think> 标签 emit 给前端，让 llmTags 能实时解析展示思维链。
        // fullContent / fullReasoningContent 仍只累加纯内容（不含标签），不影响返回值。
        let inReasoning = false;
        // 流式 tool_calls 累加：index -> { id, type, function: { name, arguments } }
        const toolCallDeltas = new Map();

        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':')) continue;

            if (trimmed.startsWith('data: ')) {
              const data = trimmed.slice(6);
              if (data === '[DONE]') continue;

              try {
                const parsed = JSON.parse(data);
                let delta = '';
                const toolCallsDelta = parsed.choices?.[0]?.delta?.tool_calls;

                let reasoningDelta = '';
                switch (this.provider) {
                  case 'anthropic':
                    if (parsed.type === 'content_block_delta') {
                      delta = parsed.delta?.text || '';
                    } else if (parsed.type === 'content_block_start') {
                      delta = parsed.content_block?.text || '';
                    }
                    break;
                  case 'ollama':
                    delta = parsed.message?.content || '';
                    break;
                  case 'openai':
                  default:
                    delta = parsed.choices?.[0]?.delta?.content || '';
                    reasoningDelta = parsed.choices?.[0]?.delta?.reasoning_content || '';
                    // 累加 tool_calls delta（OpenAI 兼容格式）
                    if (Array.isArray(toolCallsDelta)) {
                      for (const tc of toolCallsDelta) {
                        const idx = tc.index || 0;
                        if (!toolCallDeltas.has(idx)) {
                          toolCallDeltas.set(idx, { function: {} });
                        }
                        const entry = toolCallDeltas.get(idx);
                        if (tc.id) entry.id = tc.id;
                        if (tc.type) entry.type = tc.type;
                        if (tc.function?.name) {
                          entry.function.name = (entry.function.name || '') + tc.function.name;
                        }
                        if (tc.function?.arguments) {
                          entry.function.arguments = (entry.function.arguments || '') + tc.function.arguments;
                        }
                      }
                    }
                    break;
                }

                // reasoning_content（DeepSeek）单独字段，不在 content 流中。
                // 把 reasoningDelta 包装成 🧠...</thinking> 标签 emit 给前端，
                // 让 llmTags.ts 能实时解析并展示思维链。
                // fullContent / fullReasoningContent 仍只累加纯内容（不含标签），不影响返回值。
                if (reasoningDelta) {
                  if (!inReasoning) {
                    inReasoning = true;
                    this.emit('token', '🧠');
                  }
                  fullReasoningContent += reasoningDelta;
                  this.emit('token', reasoningDelta);
                }
                if (delta) {
                  if (inReasoning) {
                    inReasoning = false;
                    this.emit('token', '</thinking>');
                  }
                  fullContent += delta;
                  this.emit('token', delta);
                }
              } catch {
                // 忽略解析错误
              }
            }
          }
        });

        res.on('end', () => {
          // 流结束时若仍处于 reasoning（DeepSeek 只输出 reasoning 未输出 content），
          // 补闭合标签，避免前端 <think> 标签未闭合导致解析异常
          if (inReasoning) {
            inReasoning = false;
            this.emit('token', '</think>');
          }
          this.emit('end');
          // 组装完整的 tool_calls
          const toolCalls = [];
          const indices = Array.from(toolCallDeltas.keys()).sort((a, b) => a - b);
          for (const idx of indices) {
            const tc = toolCallDeltas.get(idx);
            if (tc.function?.name) {
              toolCalls.push({
                id: tc.id || `call-${idx}`,
                type: tc.type || 'function',
                function: {
                  name: tc.function.name,
                  arguments: tc.function.arguments || '{}',
                },
              });
            }
          }
          resolve(requestOptions.returnRaw
            ? { content: fullContent, toolCalls, reasoningContent: fullReasoningContent }
            : fullContent);
        });

        res.on('error', (err) => {
          reject(this.aborted ? this._createAbortError() : err);
        });
      });

      req.on('error', (err) => {
        reject(this.aborted ? this._createAbortError() : err);
      });
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('LLM 请求超时'));
      });

      this.activeRequest = req;
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  _httpRequest(urlString, options, requestOptions = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlString);
      const isHttps = url.protocol === 'https:';
      const requester = isHttps ? https : http;

      const reqOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: options.method,
        headers: options.headers,
        timeout: options.timeout,
      };

      console.log(`[LifeAiCode] 非流式请求: ${options.method} ${urlString}`);

      // 处理外部 signal 中止
      const signal = requestOptions.signal;
      if (signal) {
        if (signal.aborted) {
          reject(this._createAbortError());
          return;
        }
        signal.addEventListener('abort', () => {
          if (!req.destroyed) {
            try { req.destroy(); } catch { /* ignore */ }
          }
          reject(this._createAbortError());
        }, { once: true });
      }

      const req = requester.request(reqOptions, (res) => {
        this.activeRequest = req;
        let data = '';
        res.on('data', (chunk) => (data += chunk.toString()));
        res.on('end', () => {
          if (this.aborted) {
            reject(this._createAbortError());
            return;
          }
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`LLM API 错误 ${res.statusCode}: ${data.slice(0, 500)}`));
          }
        });
        res.on('error', (err) => {
          reject(this.aborted ? this._createAbortError() : err);
        });
      });

      req.on('error', (err) => {
        reject(this.aborted ? this._createAbortError() : err);
      });
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('LLM 请求超时'));
      });

      this.activeRequest = req;
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = { LlmClient, PROVIDERS };
