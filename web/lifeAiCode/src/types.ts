/* ─── WebView ←→ Extension Host 消息类型 ─── */

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  suggestions?: Suggestion[];
  streaming?: boolean;
  blocks?: ContentBlock[];
}

export type FileStatus = 'modified' | 'created' | 'deleted';

export type StepStatus = 'running' | 'done' | 'error';
export type StepType = 'read' | 'think' | 'agent' | 'edit' | 'run';

export type ContentBlock =
  | { type: 'text'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'edit'; filePath: string; additions: number; deletions: number }
  | { type: 'shell'; command: string; output?: string; status?: 'success' | 'error' }
  | { type: 'fileStatus'; filePath: string; status: FileStatus }
  | { type: 'step'; stepType: StepType; target?: string; params?: string; label?: string; status: StepStatus };

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

export type ProviderType = 'openai' | 'anthropic' | 'deepseek' | 'glm' | 'qwen' | 'ollama' | 'custom';

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
    defaultModel: 'glm-5.2',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-5.2', 'glm-5.1', 'glm-5', 'glm-4.5', 'glm-4-plus', 'glm-4-air', 'glm-4-flash'],
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
    defaultModel: 'deepseek-v4-flash',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
    docsUrl: 'https://platform.deepseek.com/api_keys',
    placeholder: 'sk-...',
    color: '#4f6bf5',
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

export type WebViewRequest =
  | { command: 'sendMessage'; text: string; context: CodeContext }
  | { command: 'acceptSuggestion'; suggestionId: string }
  | { command: 'rejectSuggestion'; suggestionId: string }
  | { command: 'previewDiff'; suggestionId: string }
  | { command: 'applySuggestion'; suggestionId: string }
  | { command: 'explainCode'; code: string; context: CodeContext }
  | { command: 'suggestRefactor'; context: CodeContext }
  | { command: 'configure'; config: LlmConfig }
  | { command: 'testConnection'; config: LlmConfig }
  | { command: 'switchConfig'; configId: string }
  | { command: 'requestConfig' }
  | { command: 'toggleEditMode' };

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
