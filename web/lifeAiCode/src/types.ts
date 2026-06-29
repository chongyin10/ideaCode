/* ─── WebView ←→ Extension Host 消息类型 ─── */

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  suggestions?: Suggestion[];
  streaming?: boolean;
  blocks?: ContentBlock[];
  /** 占位消息：用户发送后到 AI 真正返回前的过渡态 */
  placeholder?: boolean;
  /** LLM 回复被检测到不完整（未闭合 markdown 结构），用户可点击「继续」 */
  incomplete?: boolean;
  /** 检测到的截断原因（用于 UI 显示） */
  incompleteReasons?: string[];
}

export type FileStatus = 'modified' | 'created' | 'deleted';

/** §变更文件列表中的状态标签
 * - completed: 已完成（AI 已应用修改，默认态）
 * - applied:   已应用（用户在弹窗里点击了"接受"，明确确认改动保留）
 * - reverted:  已撤销（用户主动撤销改动，文件已恢复到 original）
 * - reading:   读写中（正在写入/读取磁盘，带脉动动画）
 * - queued:    排队中（等待依赖前置文件先完成）
 * - failed:    失败（磁盘写入失败或权限错误等）
 */
export type FileChangeStatus = 'completed' | 'applied' | 'reverted' | 'reading' | 'queued' | 'failed';

export type StepStatus = 'running' | 'done' | 'error';
export type StepType = 'read' | 'think' | 'agent' | 'edit' | 'run';

export interface ToolCallInfo {
  tool: string;
  args: Record<string, unknown>;
  status: 'running' | 'success' | 'error';
  duration?: number;
  summary?: string;
  result?: Record<string, unknown>;
}

export type ContentBlock =
  | { type: 'text'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'edit'; filePath: string; additions: number; deletions: number }
  | { type: 'shell'; command: string; output?: string; status?: 'running' | 'success' | 'error' }
  | { type: 'fileStatus'; filePath: string; status: FileStatus }
  | { type: 'step'; stepType: StepType; target?: string; params?: string; label?: string; status: StepStatus }
  | { type: 'environment'; lines: string[]; raw: string };

export interface Suggestion {
  id: string;
  type: 'refactor' | 'bugfix' | 'feature' | 'optimization' | 'explanation';
  title: string;
  description: string;
  changes: SuggestionChange[];
  status: 'pending' | 'accepted' | 'rejected' | 'applied';
  createdAt: number;
  diffData?: SuggestionChange[];
}

export interface SuggestionChange {
  filePath: string;
  original: string;
  modified: string;
  explanation: string;
  startLine: number;
  endLine: number;
  /** §变更文件状态标签：用于状态栏"变更文件"列表右侧色块展示
   *  可选；缺省时由 ChatPanel 兜底推断（已完成） */
  status?: FileChangeStatus;
  /** §失败原因（仅 status === 'failed' 时使用），显示在 tag 的 title 上 */
  errorMessage?: string;
}

export interface CodeContext {
  activeFile: FileInfo | null;
  relatedFiles: FileInfo[];
  workspaceRoot: string;
  diagnostics: DiagnosticInfo[];
  selection: string;
}

export interface FileInfo {
  filePath: string;
  content: string;
  language: string;
  size: number;
  summarized?: boolean;
}

export interface DiagnosticInfo {
  file: string;
  line: number;
  message: string;
  severity?: number;
}

/* ─── 厂商 / Provider 配置 ─── */

export type ProviderType = 'openai' | 'anthropic' | 'deepseek' | 'glm' | 'qwen' | 'kimi' | 'MiniMax' | 'doubao' | 'ollama' | 'custom';

/** 模型下拉/卡片展示时的厂商排序 */
export const PROVIDER_ORDER: ProviderType[] = [
  'openai', 'anthropic', 'deepseek', 'qwen', 'glm', 'kimi', 'MiniMax', 'doubao', 'ollama', 'custom',
];

export const PROVIDER_META: Record<ProviderType, {
  label: string;
  icon: string;
  defaultModel: string;
  baseUrl: string;
  models: string[];
  docsUrl: string;
  placeholder: string;
  color: string;
}> = {
  openai: {
    label: 'OpenAI',
    icon: '🔵',
    defaultModel: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo', 'gpt-4o-mini'],
    docsUrl: 'https://platform.openai.com/api-keys',
    placeholder: 'sk-...',
    color: '#00a67e',
  },
  anthropic: {
    label: 'Anthropic',
    icon: '🟣',
    defaultModel: 'claude-3-sonnet-20240229',
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-3-opus-20240229', 'claude-3-sonnet-20240229', 'claude-3-haiku-20240307', 'claude-3-5-sonnet-20240620'],
    docsUrl: 'https://console.anthropic.com/',
    placeholder: 'sk-ant-...',
    color: '#d97757',
  },
  ollama: {
    label: 'Ollama',
    icon: '🦙',
    defaultModel: 'deepseek-coder',
    baseUrl: 'http://localhost:11434',
    models: ['deepseek-coder', 'codellama', 'llama3', 'qwen2.5-coder', 'mistral', 'phi3'],
    docsUrl: 'https://ollama.ai/',
    placeholder: '无需 API Key',
    color: '#f5a623',
  },
  glm: {
    label: 'GLM (智谱)',
    icon: '🔮',
    defaultModel: 'glm-4.6',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.6', 'glm-4.5', 'glm-4-plus', 'glm-4-air', 'glm-4-flash', 'glm-4-long'],
    docsUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    placeholder: 'API Key',
    color: '#1a7f8d',
  },
  qwen: {
    label: 'Qwen (千问)',
    icon: '🌙',
    defaultModel: 'qwen-plus',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen2.5-coder-32b-instruct', 'qwen2.5-72b-instruct'],
    docsUrl: 'https://help.aliyun.com/zh/dashscope/',
    placeholder: 'sk-...',
    color: '#1677ff',
  },
  deepseek: {
    label: 'DeepSeek',
    icon: '🔍',
    defaultModel: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder'],
    docsUrl: 'https://platform.deepseek.com/api_keys',
    placeholder: 'sk-...',
    color: '#4f6bf5',
  },
  kimi: {
    label: 'KIMI (月之暗面)',
    icon: '🌙',
    defaultModel: 'moonshot-v1-32k',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'moonshot-v1-auto'],
    docsUrl: 'https://platform.moonshot.cn/docs',
    placeholder: 'sk-...',
    color: '#1a1a2e',
  },
  MiniMax: {
    label: 'MiniMax',
    icon: '🐙',
    defaultModel: 'MiniMax-M3',
    baseUrl: 'https://api.minimaxi.com/v1',
    models: ['MiniMax-M3', 'MiniMax-Text-01', 'MiniMax-Text-01-32K', 'MiniMax-Text-01-128K', 'abab6.5s-chat', 'abab6.5-chat'],
    docsUrl: 'https://platform.minimaxi.com/docs/token-plan/codex',
    placeholder: 'API Key',
    color: '#6366f1',
  },
  doubao: {
    label: '豆包 (字节跳动)',
    icon: '🫘',
    defaultModel: 'doubao-pro-32k',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-lite-4k', 'doubao-lite-16k', 'doubao-lite-32k', 'doubao-lite-128k', 'doubao-pro-4k', 'doubao-pro-32k', 'doubao-pro-128k'],
    docsUrl: 'https://www.volcengine.com/docs/82379/1542112',
    placeholder: 'API Key',
    color: '#f97316',
  },
  custom: {
    label: 'Custom',
    icon: '⚙',
    defaultModel: 'gpt-4o',
    baseUrl: '',
    models: [],
    docsUrl: '',
    placeholder: 'API Key',
    color: '#888',
  },
};

/* ─── §需求8：模型上下文窗口映射 ─── */
// 按 provider 的默认窗口（找不到具体模型时回退使用）
const PROVIDER_DEFAULT_CONTEXT_WINDOW: Partial<Record<ProviderType, number>> = {
  openai: 128000,
  anthropic: 200000,
  deepseek: 64000,
  qwen: 128000,
  glm: 128000,
  kimi: 32000,
  MiniMax: 245000,
  doubao: 32000,
  ollama: 8192,
  custom: 128000,
};

// 按模型名精确映射（key 为模型名，value 为 context window tokens）
const MODEL_CONTEXT_WINDOW: Record<string, number> = {
  // OpenAI
  'gpt-4o': 128000, 'gpt-4o-mini': 128000, 'gpt-4-turbo': 128000,
  'gpt-4': 8192, 'gpt-4-32k': 32768, 'gpt-3.5-turbo': 16385,
  // Anthropic
  'claude-3-opus-20240229': 200000, 'claude-3-sonnet-20240229': 200000,
  'claude-3-haiku-20240307': 200000, 'claude-3-5-sonnet-20240620': 200000,
  // DeepSeek
  'deepseek-chat': 64000, 'deepseek-reasoner': 64000, 'deepseek-coder': 64000,
  // Qwen
  'qwen-max': 32768, 'qwen-plus': 131072, 'qwen-turbo': 1000000,
  'qwen2.5-coder-32b-instruct': 131072, 'qwen2.5-72b-instruct': 131072,
  // GLM
  'glm-4.6': 131072, 'glm-4.5': 131072, 'glm-4-plus': 131072,
  'glm-4-air': 131072, 'glm-4-flash': 131072, 'glm-4-long': 1000000,
  // Kimi
  'moonshot-v1-8k': 8192, 'moonshot-v1-32k': 32768, 'moonshot-v1-128k': 131072,
  // MiniMax
  'MiniMax-M3': 1000000, 'MiniMax-Text-01': 1000000,
  'MiniMax-Text-01-32K': 32768, 'MiniMax-Text-01-128K': 131072,
  'abab6.5s-chat': 8192, 'abab6.5-chat': 8192,
  // Doubao（窗口在模型名中体现）
  'doubao-lite-4k': 4096, 'doubao-lite-16k': 16384, 'doubao-lite-32k': 32768, 'doubao-lite-128k': 131072,
  'doubao-pro-4k': 4096, 'doubao-pro-32k': 32768, 'doubao-pro-128k': 131072,
};

/** 查询模型的 context window（token 上限），用于 token 使用率显示与压缩阈值判断 */
export function getModelContextWindow(provider: ProviderType, model: string): number {
  if (MODEL_CONTEXT_WINDOW[model]) return MODEL_CONTEXT_WINDOW[model];
  return PROVIDER_DEFAULT_CONTEXT_WINDOW[provider] ?? 128000;
}

export interface LlmConfig {
  id: string;
  name: string;
  provider: ProviderType;
  apiKey: string;
  model: string;
  baseUrl: string;
  verified: boolean;
  /** 连接验证状态 */
  connectionStatus?: 'idle' | 'testing' | 'success' | 'error';
}

export function defaultLlmConfig(): LlmConfig {
  return {
    id: `cfg-${Date.now()}`,
    name: '',
    provider: 'openai',
    apiKey: '',
    model: 'gpt-4o',
    baseUrl: '',
    verified: false,
    connectionStatus: 'idle',
  };
}

/** 根据连接状态返回指示器颜色（蓝=成功，红=失败，黄=验证中，灰=未验证） */
export function getConnectionStatusColor(status?: LlmConfig['connectionStatus']): string {
  switch (status) {
    case 'success': return '#3b82f6';
    case 'error': return '#ef4444';
    case 'testing': return '#eab308';
    default: return '#9ca3af';
  }
}

/** 根据连接状态返回展示文案 */
export function getConnectionStatusText(status?: LlmConfig['connectionStatus'], verified = false): string {
  switch (status) {
    case 'success': return '连接成功';
    case 'error': return '连接失败';
    case 'testing': return '验证中…';
    default: return verified ? '已验证' : '未验证';
  }
}

/* ─── WebView 消息 ─── */

/** 历史会话消息（用于继续会话时传给后端的多轮上下文） */
export interface ChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type WebViewRequest =
  | { command: 'sendMessage'; text: string; context: CodeContext; thinkingEnabled?: boolean; agentMode?: boolean; history?: ChatHistoryMessage[] }
  | { command: 'continueMessage'; messageId: string; continueFromContent: string }
  | { command: 'acceptSuggestion'; suggestionId: string }
  | { command: 'rejectSuggestion'; suggestionId: string }
  | { command: 'previewDiff'; suggestionId: string }
  | { command: 'openDiffInEditor'; filePath: string; original: string; modified: string }
  | { command: 'applySuggestion'; suggestionId: string }
  | { command: 'explainCode'; code: string; context: CodeContext }
  | { command: 'suggestRefactor'; context: CodeContext }
  | { command: 'configure'; config: LlmConfig }
  | { command: 'updateConfigs'; configs: LlmConfig[] }
  | { command: 'testConnection'; config: LlmConfig }
  | { command: 'switchConfig'; configId: string }
  | { command: 'requestConfig' }
  | { command: 'toggleEditMode' }
  | { command: 'executeShell'; id: string; shellCommand: string; cwd?: string }
  | { command: 'killShell'; id: string }
  | { command: 'cancelAgent' }
  | { command: 'abortGeneration' }
  | { command: 'confirmAgentEdit'; editId: string }
  | { command: 'rejectAgentEdit'; editId: string }
  // §需求8：手动压缩上下文 — 调 LLM 生成历史摘要替换早期消息
  | { command: 'compactHistory'; messages: { role: 'user' | 'assistant'; content: string }[] }
  // §撤销修改：将 AI 自动修改的文件恢复到修改前的内容
  | { command: 'revertFiles'; changes: Array<{ filePath: string; original: string }> };

export type ExtensionMessage =
  | { type: 'chatResponse'; id: string; content: string; done: boolean }
  | { type: 'suggestions'; suggestions: Suggestion[] }
  | { type: 'suggestionStatus'; suggestionId: string; status: Suggestion['status'] }
  | { type: 'diffPreview'; suggestionId: string; changes: SuggestionChange[] }
  | { type: 'configLoaded'; configs: LlmConfig[]; activeId: string }
  | { type: 'aiEditMode'; enabled: boolean }
  | { type: 'connectionTestResult'; success: boolean; message: string }
  | { type: 'newChat' }
  | { type: 'openConfig' }
  | { type: 'showHistory' }
  | { type: 'shellUpdate'; id: string; shellCommand: string; output: string; status: 'running' | 'success' | 'error' | 'killed'; exitCode?: number; signal?: string; longRunning?: boolean }
  | { type: 'notice'; level: 'info' | 'success' | 'warning' | 'error'; message: string; suggestionId?: string }
  | { type: 'toolCall'; tool: string; args: Record<string, unknown>; status: 'running' | 'success' | 'error'; duration?: number; summary?: string; result?: Record<string, unknown> }
  | { type: 'agentStatus'; status: 'running' | 'done' | 'error' | 'cancelled'; message: string }
  | { type: 'agentEditPending'; editId: string; filePath: string; original: string; modified: string }
  | { type: 'agentEditStatus'; editId: string; status: 'applied' | 'rejected' }
  // Bug 21: extension.js / agentRuntime.js 会发送 step 进度消息，但原 ExtensionMessage
  // 联合类型未声明该类型，导致 ChatPanel 无法类型安全地处理。补充声明。
  | { type: 'step'; stepType: StepType; target?: string; params?: string; label?: string; status: StepStatus }
  // §需求8：上下文压缩完成通知，前端据此替换 messages
  | { type: 'historyCompacted'; summary: string; beforeTokens: number; afterTokens: number }
  // §需求9：任务拆解 — Planner 生成计划后下发，前端渲染 checklist
  | { type: 'planGenerated'; steps: Array<{ step: number; tool: string; args: Record<string, unknown>; reason: string }> }
  // §需求9：计划步骤状态变更（pending/running/done/error/skipped）
  | { type: 'planStepUpdate'; index: number; status: 'pending' | 'running' | 'done' | 'error' | 'skipped'; summary?: string }
  // §撤销修改：文件恢复完成通知
  | { type: 'filesReverted'; filePaths: string[]; success: boolean; message?: string }
  | { type: 'error'; message: string };

/* ─── VSCode API 类型 ─── */

export interface VsCodeApi {
  postMessage(message: WebViewRequest | Record<string, unknown>): void;
  setState(state: unknown): void;
  getState(): unknown;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
    __lifeAiCodePopupData?: Record<string, unknown>;
  }
}
