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
  }

  /**
   * 默认系统提示词 — 强调只读分析原则
   */
  _defaultSystemPrompt() {
    return `你是 LifeAiCode，运行在 IDEACODE IDE 中的一个 AI 代码辅助工具。

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
   */
  async chat(messages) {
    const provider = PROVIDERS[this.provider];
    if (!provider) throw new Error(`不支持的 Provider: ${this.provider}`);

    const body = this._buildRequestBody(provider, messages, false);
    const url = this._getRequestUrl(provider);

    let lastError = null;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await this._httpRequest(url.toString(), {
          method: 'POST',
          headers: provider.headers(this.apiKey),
          body: JSON.stringify(body),
          timeout: this.timeout,
        });
        return this._parseResponse(provider, response);
      } catch (err) {
        lastError = err;
        console.warn(`[LifeAiCode] LLM 请求失败 (${attempt + 1}/${this.maxRetries}):`, err.message);
        if (attempt < this.maxRetries - 1) {
          await this._sleep(Math.pow(2, attempt) * 1000);
        }
      }
    }
    throw lastError || new Error('LLM 请求失败');
  }

  /**
   * 发送聊天请求（流式）
   */
  async chatStream(messages) {
    const provider = PROVIDERS[this.provider];
    if (!provider) throw new Error(`不支持的 Provider: ${this.provider}`);

    const body = this._buildRequestBody(provider, messages, true);
    const url = this._getRequestUrl(provider);

    let lastError = null;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        return await this._httpStreamRequest(url.toString(), {
          method: 'POST',
          headers: provider.headers(this.apiKey),
          body: JSON.stringify(body),
          timeout: this.timeout,
        });
      } catch (err) {
        lastError = err;
        console.warn(`[LifeAiCode] 流式请求失败 (${attempt + 1}/${this.maxRetries}):`, err.message);
        if (attempt < this.maxRetries - 1) {
          await this._sleep(Math.pow(2, attempt) * 1000);
        }
      }
    }
    throw lastError || new Error('LLM 流式请求失败');
  }

  _getRequestUrl(provider) {
    const base = this.baseUrl || provider.baseUrl;
    if (!base) {
      throw new Error('Base URL 未配置，请在配置面板填写');
    }
    return new URL(provider.chatPath, base);
  }

  _buildRequestBody(provider, messages, stream) {
    switch (this.provider) {
      case 'anthropic':
        return {
          model: this.model,
          max_tokens: 4096,
          stream,
          system: this.systemPrompt,
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
            { role: 'system', content: this.systemPrompt },
            ...messages,
          ],
        };
      case 'openai':
      default:
        return {
          model: this.model,
          stream,
          messages: [
            { role: 'system', content: this.systemPrompt },
            ...messages,
          ],
        };
    }
  }

  _parseResponse(provider, responseBody) {
    let data;
    try {
      data = JSON.parse(responseBody);
    } catch {
      throw new Error(`LLM 响应解析失败: ${responseBody.slice(0, 200)}`);
    }

    switch (this.provider) {
      case 'anthropic':
        return data.content?.[0]?.text || '';
      case 'ollama':
        return data.message?.content || '';
      case 'openai':
      default:
        return data.choices?.[0]?.message?.content || '';
    }
  }

  /**
   * 流式 HTTP 请求（SSE）
   */
  _httpStreamRequest(urlString, options) {
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

      const req = requester.request(reqOptions, (res) => {
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
        let buffer = '';

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
                    break;
                }

                if (delta) {
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
          this.emit('end');
          resolve(fullContent);
        });

        res.on('error', reject);
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('LLM 请求超时'));
      });

      if (options.body) req.write(options.body);
      req.end();
    });
  }

  _httpRequest(urlString, options) {
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

      const req = requester.request(reqOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk.toString()));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`LLM API 错误 ${res.statusCode}: ${data.slice(0, 500)}`));
          }
        });
        res.on('error', reject);
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('LLM 请求超时'));
      });

      if (options.body) req.write(options.body);
      req.end();
    });
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = { LlmClient, PROVIDERS };
