/**
 * §需求8-阶段2：模型上下文窗口映射表
 *
 * 与 web/lifeAiCode/src/types.ts 中的 MODEL_CONTEXT_WINDOW 保持同步。
 * 后端 AgentRuntime 用它估算 messages 的 token 占用，超阈值时自动压缩。
 */

/** 各 Provider 的默认上下文窗口（token） */
const PROVIDER_DEFAULT_CONTEXT_WINDOW = {
  openai: 128000,
  anthropic: 200000,
  deepseek: 64000,
  zhipu: 128000,
  dashscope: 32000,
  ollama: 8192,
  custom: 128000,
};

/** 指定模型的上下文窗口（优先级高于 Provider 默认值） */
const MODEL_CONTEXT_WINDOW = {
  // OpenAI
  'gpt-4': 8192,
  'gpt-4-0613': 8192,
  'gpt-4-32k': 32768,
  'gpt-4-turbo': 128000,
  'gpt-4-turbo-preview': 128000,
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-4.1': 1047576,
  'gpt-4.1-mini': 1047576,
  'gpt-5': 1047576,
  'o1': 200000,
  'o1-mini': 128000,
  'o1-pro': 200000,
  'o3': 200000,
  'o3-mini': 200000,
  'o4-mini': 200000,
  // Anthropic
  'claude-3-opus-20240229': 200000,
  'claude-3-sonnet-20240229': 200000,
  'claude-3-haiku-20240307': 200000,
  'claude-3-5-sonnet-20240620': 200000,
  'claude-3-5-sonnet-20241022': 200000,
  'claude-3-5-haiku-20241022': 200000,
  'claude-3-7-sonnet-20250219': 200000,
  'claude-sonnet-4-20250514': 200000,
  'claude-opus-4-20250514': 200000,
  'claude-opus-4-1-20250805': 200000,
  // DeepSeek
  'deepseek-chat': 64000,
  'deepseek-reasoner': 64000,
  'deepseek-coder': 64000,
  // Zhipu
  'glm-4': 128000,
  'glm-4-plus': 128000,
  'glm-4-air': 128000,
  'glm-4-flash': 128000,
  'glm-4.5': 128000,
  'glm-4.6': 128000,
  // DashScope (Qwen)
  'qwen-max': 32000,
  'qwen-plus': 131072,
  'qwen-turbo': 1000000,
  'qwen2.5-72b-instruct': 131072,
  'qwen2.5-coder-32b-instruct': 131072,
  'qwen3-235b-a22b': 131072,
  'qwen3-coder-plus': 131072,
};

/**
 * 获取指定 provider + model 的上下文窗口大小
 * 优先查 MODEL_CONTEXT_WINDOW，否则回退到 PROVIDER_DEFAULT_CONTEXT_WINDOW，再否则 128000
 */
function getModelContextWindow(provider, model) {
  if (model && MODEL_CONTEXT_WINDOW[model]) return MODEL_CONTEXT_WINDOW[model];
  if (provider && PROVIDER_DEFAULT_CONTEXT_WINDOW[provider]) {
    return PROVIDER_DEFAULT_CONTEXT_WINDOW[provider];
  }
  return 128000;
}

/**
 * 估算 messages 数组的 token 数量。
 *
 * 精确 token 计数需要 tokenizer（gpt-tokenizer / tiktoken），
 * 但引入 tokenizer 会显著增加打包体积（>1MB）。
 * 这里采用启发式估算：
 * - 英文：~4 chars/token
 * - 中文：~1.5 chars/token（中文 token 密度更高）
 * - 综合：取 chars/3 作为折中估算（偏保守，提前触发压缩）
 *
 * @param {Array<{role: string, content: string}>} messages
 * @returns {number} 估算的 token 数
 */
function estimateTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let totalChars = 0;
  for (const m of messages) {
    if (!m) continue;
    const content = typeof m.content === 'string' ? m.content : '';
    totalChars += content.length;
    // tool_calls / name 等 overhead 估算：每条消息 +4 tokens
    totalChars += 12;
  }
  return Math.ceil(totalChars / 3);
}

/**
 * 估算单条字符串的 token 数
 */
function estimateStringTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  return Math.ceil(text.length / 3);
}

module.exports = {
  PROVIDER_DEFAULT_CONTEXT_WINDOW,
  MODEL_CONTEXT_WINDOW,
  getModelContextWindow,
  estimateTokens,
  estimateStringTokens,
};
