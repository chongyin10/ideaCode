import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { ChatMessage, CodeContext, WebViewRequest, ExtensionMessage, LlmConfig, ProviderType, ToolCallInfo, SuggestionChange } from '../types';
import { PROVIDER_META, getConnectionStatusColor } from '../types';
import { SuggestionList } from './SuggestionList';
import { ContentBlocks } from './ContentBlocks';
import { AgentModeToggle } from './agent/AgentModeToggle';
import { AgentStatusBar } from './agent/AgentStatusBar';
import { ToolCallLog } from './agent/ToolCallLog';
import { DiffConfirmDialog } from './agent/DiffConfirmDialog';
import { ShieldCheck, Brain, ArrowDown, User, Sparkles, Paperclip, Send, MessageSquare, Loader2, Check, Square, ChevronDown, X, GripVertical, Pencil, MoreHorizontal, FileText, Terminal, RefreshCw, Network, Lightbulb, GitCompare } from 'lucide-react';

/** 预处理：检测并补齐未闭合的 markdown 结构（供 chatResponse 处理时使用） */
function groupConfigsByProviderOrder(configs: LlmConfig[]) {
  const order: ProviderType[] = [];
  const map = new Map<ProviderType, LlmConfig[]>();
  for (const cfg of configs) {
    if (!map.has(cfg.provider)) {
      order.push(cfg.provider);
      map.set(cfg.provider, []);
    }
    map.get(cfg.provider)!.push(cfg);
  }
  return order.map((provider) => ({ provider, configs: map.get(provider)! }));
}

function preprocessMarkdown(content: string): { processed: string; incomplete: boolean; reasons: string[] } {
  let result = content;
  const reasons: string[] = [];

  // 1. 未闭合的代码块 fence（``` 数量为奇数）
  const fenceMatches = result.match(/```/g);
  if (fenceMatches && fenceMatches.length % 2 !== 0) {
    result += '\n\n```';
    reasons.push('代码块未闭合');
  }

  // 2. 未闭合的 HTML 标签
  const openTags: Record<string, number> = {};
  const tagRegex = /<\/?(code|strong|em|del|a|b|i|u|span)\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRegex.exec(result)) !== null) {
    const full = m[0];
    const isClose = full.startsWith('</');
    const tag = m[1].toLowerCase();
    if (isClose) {
      if ((openTags[tag] || 0) > 0) openTags[tag]--;
    } else if (!full.endsWith('/>')) {
      openTags[tag] = (openTags[tag] || 0) + 1;
    }
  }
  let suffix = '';
  for (const [tag, count] of Object.entries(openTags)) {
    if (count > 0) {
      suffix += `</${tag}>`.repeat(count);
      reasons.push(`${tag} 标签未闭合`);
    }
  }
  if (suffix) result += suffix;

  return { processed: result, incomplete: reasons.length > 0, reasons };
}

function getVsCodeApi() {
  if (typeof window !== 'undefined' && window.acquireVsCodeApi) {
    return window.acquireVsCodeApi();
  }
  return null;
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function finalizeSteps(content: string): string {
  // 对话结束时，把仍在运行或未写 status 的步骤标记为完成，防止 spinner 一直转
  return content
    .replace(/<step\b([^>]*)status=["']running["']([^>]*)>/gi, '<step$1status="done"$2>')
    .replace(/<step\b(?![^>]*\bstatus=["'])([^>]*?)(\/?)>/gi, '<step$1 status="done"$2>');
}

/**
 * 稳定序列化：先按 key 排序再 stringify。
 * Bug 17: toolCall 去重原用 JSON.stringify，对相同内容但键顺序不同的对象
 * （如 {a:1,b:2} vs {b:2,a:1}）会判为不同，导致重复 toolCall 无法去重。
 */
function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify((obj as Record<string, unknown>)[k])).join(',') + '}';
}

/* ─── 聊天历史管理 ─── */

interface ChatHistoryItem {
  id: string;
  title: string;
  timestamp: number;
  messages: ChatMessage[];
}

const HISTORY_KEY = 'lifeAiCode_chat_history';
const MAX_HISTORY = 20;

function loadHistory(): ChatHistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveHistory(items: ChatHistoryItem[]) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, MAX_HISTORY))); } catch { /* ignore */ }
}

function historyTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user');
  return first
    ? first.content.slice(0, 40) + (first.content.length > 40 ? '…' : '')
    : '空对话';
}

interface ChatPanelProps {
  initialContext?: CodeContext;
  isPopup?: boolean;
  activeConfig: LlmConfig | null;
  configs: LlmConfig[];
  onOpenConfig: () => void;
}

export function ChatPanel({ initialContext, isPopup, activeConfig, configs, onOpenConfig }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  // §4.6: 直接使用 prop，让父组件切换文件/上下文时 ChatPanel 能拿到最新值。
  // 之前用 useState 初次化后再不更新，导致切换文件后 AI 仍拿到旧 context。
  const context = initialContext || null;
  const [error, setError] = useState<string | null>(null);
  const [aiEditMode, setAiEditMode] = useState(true);
  const [autoAccept, setAutoAccept] = useState(false);
  const [thinkingEnabled, setThinkingEnabled] = useState(true);
  const [showConfigPicker, setShowConfigPicker] = useState(false);
  const [history, setHistory] = useState<ChatHistoryItem[]>(loadHistory);
  const [showHistory, setShowHistory] = useState(false);
  // §继续会话：当前恢复的历史会话 ID（用于继续对话时拼接历史上下文，以及更新历史项）
  const [currentHistoryId, setCurrentHistoryId] = useState<string | null>(null);
  const [historyDragId, setHistoryDragId] = useState<string | null>(null);
  const [historyDropTarget, setHistoryDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  const [shellOutputs, setShellOutputs] = useState<Record<string, { output: string; status: 'running' | 'success' | 'error' | 'killed' }>>({});
  const [notice, setNotice] = useState<{ level: 'info' | 'success' | 'warning' | 'error'; message: string; id: number } | null>(null);
  const [agentMode, setAgentMode] = useState(false);
  const [agentStatus, setAgentStatus] = useState<{ status: string; message: string; stepType?: string } | null>(null);
  const [toolCalls, setToolCalls] = useState<ToolCallInfo[]>([]);
  // Bug 4: 改为数组队列，支持多个 pending 编辑同时存在
  // 原来单个 state 会被后续 edit 覆盖，用户丢失前一个确认弹窗
  const [pendingAgentEdits, setPendingAgentEdits] = useState<Array<{ editId: string; filePath: string; original: string; modified: string }>>([]);
  // 持久记录本次会话中所有被 AI 修改过的文件（包括 suggestion 和 agent edit）
  const [agentEditedFiles, setAgentEditedFiles] = useState<SuggestionChange[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const configPickerRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const actionOverflowRef = useRef<HTMLDivElement>(null);
  const vscode = getVsCodeApi();
  // 响应式 input-actions：面板宽度不足时把次要按钮收进 ... 溢出菜单
  const [compactActions, setCompactActions] = useState(false);
  const [showActionOverflow, setShowActionOverflow] = useState(false);

  const activeMeta = activeConfig ? PROVIDER_META[activeConfig.provider] : null;

  // §4.5: 把易变 state/props 存到 ref，message listener useEffect 只依赖稳定的 vscode，
  // 避免每次 autoAccept/pendingAgentEdit 变化时重订阅（重订阅期间到达的消息可能丢失）。
  const autoAcceptRef = useRef(autoAccept);
  autoAcceptRef.current = autoAccept;
  // autoAccept 绑定到 aiEditMode：编辑模式开启时自动接受建议，关闭时手动接受
  useEffect(() => { setAutoAccept(aiEditMode); }, [aiEditMode]);
  const pendingAgentEditsRef = useRef(pendingAgentEdits);
  pendingAgentEditsRef.current = pendingAgentEdits;
  const onOpenConfigRef = useRef(onOpenConfig);
  onOpenConfigRef.current = onOpenConfig;
  // §继续会话：用 ref 让 message listener 能访问最新的 currentHistoryId / messages
  const currentHistoryIdRef = useRef<string | null>(null);
  currentHistoryIdRef.current = currentHistoryId;
  const messagesRef = useRef<ChatMessage[]>(messages);
  messagesRef.current = messages;

  // 点击外部关闭下拉面板
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (showConfigPicker && configPickerRef.current && !configPickerRef.current.contains(e.target as Node)) {
        setShowConfigPicker(false);
      }
      if (showHistory && historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setShowHistory(false);
      }
      if (showActionOverflow && actionOverflowRef.current && !actionOverflowRef.current.contains(e.target as Node)) {
        setShowActionOverflow(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [showConfigPicker, showHistory, showActionOverflow]);

  // 响应式 input-actions：监测工具栏宽度，空间不足时启用紧凑模式
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setCompactActions(entry.contentRect.width < 400);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // WebView 失去焦点时（点击面板外部）关闭下拉
  useEffect(() => {
    const handleBlur = () => {
      setShowConfigPicker(false);
      setShowHistory(false);
    };
    window.addEventListener('blur', handleBlur);
    return () => window.removeEventListener('blur', handleBlur);
  }, []);

  // 自动滚动到底部：用 rAF 节流 + 直接设置 scrollTop，避免高频 scrollIntoView 导致抖动
  useEffect(() => {
    if (userScrolledUp) return;
    const el = messagesContainerRef.current;
    if (!el) return;
    if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current);
    scrollRafRef.current = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
      scrollRafRef.current = null;
    });
    return () => {
      if (scrollRafRef.current != null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, [messages, toolCalls, agentStatus, userScrolledUp]);

  // 监听滚动，判断用户是否主动离开底部
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const threshold = 80;
    const handleScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      setUserScrolledUp(distance > threshold);
    };
    el.addEventListener('scroll', handleScroll);
    handleScroll();
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  // 聚焦输入框
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 监听来自 Extension Host 的消息
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as ExtensionMessage;
      if (!msg || !msg.type) return;

      switch (msg.type) {
        case 'chatResponse': {
          let finalContent = msg.done ? finalizeSteps(msg.content) : msg.content;
          let incomplete = false;
          let incompleteReasons: string[] = [];
          if (msg.done) {
            const processed = preprocessMarkdown(finalContent);
            finalContent = processed.processed;
            incomplete = processed.incomplete;
            incompleteReasons = processed.reasons;
          }
          setMessages((prev) => {
            // AI 真正开始返回时，移除所有占位消息
            const noPlaceholder = prev.filter((m) => !m.placeholder);
            const existing = noPlaceholder.find((m) => m.id === msg.id);
            if (existing) {
              return noPlaceholder.map((m) =>
                m.id === msg.id
                  ? {
                      ...m,
                      content: finalContent,
                      streaming: !msg.done,
                      incomplete: msg.done ? incomplete : m.incomplete,
                      incompleteReasons: msg.done ? incompleteReasons : m.incompleteReasons,
                    }
                  : m
              );
            }
            return [...noPlaceholder, {
              id: msg.id, role: 'assistant', content: finalContent,
              timestamp: Date.now(), streaming: !msg.done,
              incomplete, incompleteReasons,
            }];
          });
          setIsProcessing(!msg.done);
          if (msg.done) {
            // 对话结束：保留状态栏，显示"任务完成"
            setAgentStatus({ status: 'done', message: '任务完成', stepType: 'done' });
          }
          break;
        }
        case 'suggestions': {
          setMessages((prev) => {
            const noPlaceholder = prev.filter((m) => !m.placeholder);
            const lastMsg = noPlaceholder[noPlaceholder.length - 1];
            if (lastMsg && lastMsg.role === 'assistant') {
              return noPlaceholder.map((m, i) =>
                i === noPlaceholder.length - 1 ? { ...m, suggestions: msg.suggestions, streaming: false } : m
              );
            }
            return noPlaceholder;
          });
          // §4.1: autoAccept=false 时不要自动 reject（否则建议功能在默认配置下完全失效，
          // 用户根本看不到建议就被拒绝了）。仅 autoAccept=true 时自动接受；
          // autoAccept=false 时让用户通过 SuggestionList 的接受/拒绝按钮手动决策。
          if (msg.suggestions.length > 0 && autoAcceptRef.current) {
            setTimeout(() => {
              msg.suggestions.forEach((s) => {
                vscode?.postMessage({ command: 'acceptSuggestion', suggestionId: s.id } as WebViewRequest);
              });
            }, 0);
          }
          setIsProcessing(false);
          // 建议返回也视为对话结束，显示"任务完成"
          setAgentStatus({ status: 'done', message: '任务完成', stepType: 'done' });
          break;
        }
        case 'suggestionStatus': {
          setMessages((prev) =>
            prev.map((m) => {
              if (!m.suggestions) return m;
              return {
                ...m,
                suggestions: m.suggestions.map((s) =>
                  s.id === msg.suggestionId ? { ...s, status: msg.status } : s
                ),
              };
            })
          );
          break;
        }
        case 'diffPreview': {
          setMessages((prev) =>
            prev.map((m) => {
              if (!m.suggestions) return m;
              return {
                ...m,
                suggestions: m.suggestions.map((s) =>
                  s.id === msg.suggestionId ? { ...s, diffData: msg.changes } : s
                ),
              };
            })
          );
          break;
        }
        case 'error': {
          // 错误时也清掉占位
          setMessages((prev) => prev.filter((m) => !m.placeholder));
          setError(msg.message);
          setIsProcessing(false);
          // 错误不显示完成状态，清空状态栏
          setAgentStatus(null);
          break;
        }
        case 'aiEditMode': {
          setAiEditMode(msg.enabled);
          break;
        }
        case 'newChat': {
          // 保存当前对话到历史并清空
          setMessages((prevMessages) => {
            // 保存历史前过滤掉占位消息
            const realMessages = prevMessages.filter((m) => !m.placeholder && m.content.trim());
            if (realMessages.length > 0 && realMessages.some((m) => m.role === 'user')) {
              const existingId = currentHistoryIdRef.current;
              setHistory((prevHistory) => {
                // §继续会话：若当前是从历史恢复的会话，更新该历史项；否则新建
                if (existingId) {
                  const updated = prevHistory.map((h) => h.id === existingId ? {
                    ...h,
                    messages: realMessages,
                    timestamp: Date.now(),
                    title: historyTitle(realMessages),
                  } : h);
                  saveHistory(updated);
                  return updated;
                }
                const item: ChatHistoryItem = {
                  id: `chat-${Date.now()}`,
                  title: historyTitle(realMessages),
                  timestamp: Date.now(),
                  messages: realMessages,
                };
                const updated = [item, ...prevHistory.filter((h) => h.id !== item.id)];
                saveHistory(updated);
                return updated;
              });
            }
            return [];
          });
          // 新建会话时清空历史跟踪状态与执行记录
          setCurrentHistoryId(null);
          setAgentEditedFiles([]);
          setAgentStatus(null);
          setToolCalls([]);
          setPendingAgentEdits([]);
          setError(null);
          break;
        }
        case 'openConfig': {
          onOpenConfigRef.current?.();
          break;
        }
        case 'showHistory': {
          setShowHistory((prev) => !prev);
          break;
        }
        case 'shellUpdate': {
          console.log('[LifeAiCode WebView] shellUpdate received:', { id: msg.id, status: msg.status, outputLen: msg.output?.length });
          // 增量追加：executeShellInTerminal 通过 terminal.onDidWriteData 推送的是
          // 逐段 chunk，webview 必须累加显示，否则每次会被覆盖只剩最后一段。
          setShellOutputs((prev) => {
            const existing = prev[msg.id];
            const prevOutput = existing?.output || '';
            const newOutput = prevOutput + (msg.output || '');
            return {
              ...prev,
              [msg.id]: { output: newOutput, status: msg.status },
            };
          });
          // Bug 16: shell 结束后延迟清理对应条目，避免 shellOutputs 无限累积导致内存增长。
          // 保留 30 秒让用户能查看最终输出，之后自动移除。
          if (msg.status === 'success' || msg.status === 'error' || msg.status === 'killed') {
            const shellId = msg.id;
            setTimeout(() => {
              setShellOutputs((prev) => {
                if (!prev[shellId]) return prev;
                const next = { ...prev };
                delete next[shellId];
                return next;
              });
            }, 30_000);
          }
          break;
        }
        case 'step': {
          // Bug 21: 处理 step 进度消息，更新 agentStatus 显示当前步骤。
          // 原代码未处理该消息类型，extension.js/agentRuntime.js 发送的 step 进度被静默丢弃。
          if (msg.status === 'running') {
            const STEP_LABELS: Record<string, string> = {
              think: '正在思考',
              read: '正在读取文件',
              agent: '正在分配工作',
              edit: '正在编辑',
              run: '正在执行命令',
            };
            const label = msg.label || msg.target || STEP_LABELS[msg.stepType] || msg.stepType;
            setAgentStatus({ status: 'running', message: String(label), stepType: msg.stepType });
          }
          break;
        }
        case 'notice': {
          // 显示轻量级通知，3 秒后自动消失
          const id = Date.now();
          setNotice({ level: msg.level, message: msg.message, id });
          setTimeout(() => {
            setNotice((cur) => (cur && cur.id === id ? null : cur));
          }, 3000);
          break;
        }
        case 'agentStatus': {
          if (msg.status === 'done') {
            // Agent 任务完成：保留状态栏显示"任务完成"
            setAgentStatus({ status: 'done', message: msg.message || '任务完成', stepType: 'done' });
            setIsProcessing(false);
          } else if (msg.status === 'error' || msg.status === 'cancelled') {
            // 错误/取消：不显示完成状态，清空状态栏
            setAgentStatus(null);
            setIsProcessing(false);
          } else {
            setAgentStatus({ status: msg.status, message: msg.message });
          }
          break;
        }
        case 'toolCall': {
          setToolCalls((prev) => {
            // Bug 17: 用 stableStringify 代替 JSON.stringify 做参数去重，
            // 避免相同内容但键顺序不同的对象被判为不同导致重复 toolCall 无法合并。
            const existingIndex = prev.findIndex((t) => t.tool === msg.tool && stableStringify(t.args) === stableStringify(msg.args));
            if (existingIndex >= 0) {
              const updated = [...prev];
              updated[existingIndex] = msg;
              return updated;
            }
            return [...prev, msg];
          });
          break;
        }
        case 'agentEditPending': {
          // Bug 4: 追加到队列而非覆盖
          setPendingAgentEdits((prev) => [...prev, {
            editId: msg.editId,
            filePath: msg.filePath,
            original: msg.original,
            modified: msg.modified,
          }]);
          // 持久记录被 AI 修改的文件（用于"文件变更"列表）
          setAgentEditedFiles((prev) => {
            const change: SuggestionChange = { filePath: msg.filePath, original: msg.original, modified: msg.modified, explanation: '', startLine: 0, endLine: 0 };
            const filtered = prev.filter((c) => c.filePath !== change.filePath);
            return [...filtered, change];
          });
          break;
        }
        case 'agentEditStatus': {
          // §4.5: 通过 ref 读取最新 pendingAgentEdits
          // Bug 4: 从队列中移除匹配的 editId
          if (pendingAgentEditsRef.current.some((e) => e.editId === msg.editId)) {
            setPendingAgentEdits((prev) => prev.filter((e) => e.editId !== msg.editId));
          }
          break;
        }
      }
    };

    window.addEventListener('message', handler);
    console.log('[LifeAiCode WebView] message listener attached');
    return () => window.removeEventListener('message', handler);
    // §4.5: deps 仅保留稳定的 vscode；autoAccept/pendingAgentEdit/onOpenConfig 通过 ref 读取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vscode]);

  // 从历史恢复对话：渲染历史消息，并标记 currentHistoryId 以便后续继续会话时拼接上下文
  const restoreHistory = useCallback((item: ChatHistoryItem) => {
    setMessages(item.messages);
    setCurrentHistoryId(item.id);
    // 恢复历史时清空执行状态与文件变更记录，避免上一次会话的残留干扰
    setAgentStatus({ status: 'done', message: '历史会话已恢复', stepType: 'done' });
    setAgentEditedFiles([]);
    setToolCalls([]);
    setPendingAgentEdits([]);
    setError(null);
    setShowHistory(false);
  }, []);

  // §继续会话：对话完成（agentStatus.status === 'done'）时自动保存/更新历史
  // 避免重复保存：用 messages 内容签名判断是否有变化
  const lastSavedSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (agentStatus?.status !== 'done') return;
    const realMessages = messagesRef.current.filter((m) => !m.placeholder && m.content.trim());
    if (realMessages.length === 0 || !realMessages.some((m) => m.role === 'user')) return;

    // 用内容签名避免重复保存（恢复历史时 signature 与已保存的一致，会跳过）
    const signature = realMessages.map((m) => `${m.role}:${m.content.length}`).join('|');
    if (lastSavedSignatureRef.current === signature) return;
    lastSavedSignatureRef.current = signature;

    const existingId = currentHistoryIdRef.current;
    setHistory((prev) => {
      if (existingId) {
        // 更新现有历史项
        const updated = prev.map((h) => h.id === existingId ? {
          ...h,
          messages: realMessages,
          timestamp: Date.now(),
          title: historyTitle(realMessages),
        } : h);
        saveHistory(updated);
        return updated;
      }
      // 新建历史项
      const item: ChatHistoryItem = {
        id: `chat-${Date.now()}`,
        title: historyTitle(realMessages),
        timestamp: Date.now(),
        messages: realMessages,
      };
      setCurrentHistoryId(item.id);
      const updated = [item, ...prev].slice(0, MAX_HISTORY);
      saveHistory(updated);
      return updated;
    });
  }, [agentStatus]);

  const reorderHistory = useCallback((fromId: string, toId: string, after: boolean) => {
    if (fromId === toId) return;
    setHistory((prev) => {
      const fromIndex = prev.findIndex((h) => h.id === fromId);
      const toIndex = prev.findIndex((h) => h.id === toId);
      if (fromIndex < 0 || toIndex < 0) return prev;
      const next = prev.slice();
      const [moved] = next.splice(fromIndex, 1);
      let insertIndex = toIndex;
      if (after) {
        insertIndex = toIndex > fromIndex ? toIndex : toIndex + 1;
      } else {
        insertIndex = toIndex > fromIndex ? toIndex - 1 : toIndex;
      }
      next.splice(insertIndex, 0, moved);
      saveHistory(next);
      return next;
    });
  }, []);

  const sendMessage = async (text: string) => {
    if (!text.trim() || isProcessing) return;

    setError(null);
    const userMsg: ChatMessage = { id: generateId(), role: 'user', content: text.trim(), timestamp: Date.now() };
    // 占位消息：填充用户提交到 AI 返回第一个字符之间的时间空隙
    const placeholderMsg: ChatMessage = {
      id: `placeholder-${Date.now()}`,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      placeholder: true,
      streaming: true, // 让它也能被流式过滤器识别
    };
    setMessages((prev) => [...prev, userMsg, placeholderMsg]);
    setInput('');
    setIsProcessing(true);
    // 新对话开始时清空上一次的完成状态与执行记录，避免显示到新的占位消息上
    setAgentStatus(null);
    if (agentMode) {
      setToolCalls([]);
    }

    if (!vscode) {
      setTimeout(() => {
        setMessages((prev) => [
          // 移除占位消息
          ...prev.filter((m) => !m.placeholder),
          {
            id: generateId(), role: 'assistant',
            content: '> ⚠️ AI 服务需要通过 Extension Host 连接。\n\n请在 IDEACODE 中运行此扩展以获得完整的 AI 辅助功能。',
            timestamp: Date.now(),
          },
        ]);
        setIsProcessing(false);
        setAgentStatus({ status: 'done', message: '任务完成', stepType: 'done' });
      }, 500);
      return;
    }

    vscode.postMessage({
      command: 'sendMessage',
      text: text.trim(),
      context,
      thinkingEnabled,
      agentMode,
      // §继续会话：把当前已有对话作为历史上下文传给后端，让 LLM 能理解多轮上下文
      // 排除占位消息和空内容，最多保留最近 20 条避免 token 爆炸
      history: messagesRef.current
        .filter((m) => !m.placeholder && m.content.trim())
        .slice(-20)
        .map((m) => ({ role: m.role === 'assistant' ? 'assistant' as const : 'user' as const, content: m.content })),
    } as WebViewRequest);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input); }
  };

  const handleAcceptSuggestion = (suggestionId: string) => {
    setMessages((prev) => prev.map((m) => ({
      ...m,
      suggestions: m.suggestions?.map((s) => s.id === suggestionId ? { ...s, status: 'accepted' as const } : s),
    })));
    if (vscode) vscode.postMessage({ command: 'acceptSuggestion', suggestionId } as WebViewRequest);
  };

  const handleRejectSuggestion = (suggestionId: string) => {
    setMessages((prev) => prev.map((m) => ({
      ...m,
      suggestions: m.suggestions?.map((s) => s.id === suggestionId ? { ...s, status: 'rejected' as const } : s),
    })));
    if (vscode) vscode.postMessage({ command: 'rejectSuggestion', suggestionId } as WebViewRequest);
  };

  // 在 IDE 代码编辑区域打开 diff 对比 tab（纯内存内容，不依赖磁盘文件）
  const handleOpenDiffInEditor = (change: { filePath: string; original: string; modified: string }) => {
    if (vscode) vscode.postMessage({ command: 'openDiffInEditor', filePath: change.filePath, original: change.original, modified: change.modified } as WebViewRequest);
  };

  // 收集本次对话中的所有代码变更（从 suggestions 中提取）
  const collectedChanges = useMemo<SuggestionChange[]>(() => {
    const all: SuggestionChange[] = [];
    for (const msg of messages) {
      if (msg.suggestions) {
        for (const s of msg.suggestions) {
          if (s.changes) all.push(...s.changes);
          if (s.diffData) all.push(...s.diffData);
        }
      }
    }
    // 按 filePath 去重，保留最新
    const seen = new Map<string, SuggestionChange>();
    for (const c of all) {
      seen.set(c.filePath, c);
    }
    return Array.from(seen.values());
  }, [messages]);

  // 合并 suggestions 变更 + agent 编辑变更（按 filePath 去重）
  const allChanges = useMemo<SuggestionChange[]>(() => {
    const seen = new Map<string, SuggestionChange>();
    for (const c of [...collectedChanges, ...agentEditedFiles]) {
      seen.set(c.filePath, c);
    }
    return Array.from(seen.values());
  }, [collectedChanges, agentEditedFiles]);

  // 估算本次对话的 token 使用率百分比
  const tokenPercent = useMemo(() => estimateTokenPercent(messages), [messages]);

  // Bug 4: 队列模式，当前显示的是第一个
  const currentPendingEdit = pendingAgentEdits[0] || null;

  const handleConfirmAgentEdit = () => {
    if (vscode && currentPendingEdit) {
      vscode.postMessage({ command: 'confirmAgentEdit', editId: currentPendingEdit.editId } as WebViewRequest);
    }
  };

  const handleRejectAgentEdit = () => {
    if (vscode && currentPendingEdit) {
      vscode.postMessage({ command: 'rejectAgentEdit', editId: currentPendingEdit.editId } as WebViewRequest);
    }
  };

  const handleCancelAgent = () => {
    if (vscode) {
      vscode.postMessage({ command: 'cancelAgent' } as WebViewRequest);
    }
  };

  const contextFile = context?.activeFile?.filePath;
  const fileName = contextFile ? contextFile.split('/').pop() || contextFile : '';

  const providerLabel = activeMeta?.label;
  const modelLabel = activeConfig?.model;

  const formatMessageTime = (ts: number) => {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  /** 让 LLM 继续完成被截断的回答 */
  const handleContinue = (messageId: string) => {
    if (!vscode) return;
    const target = messages.find((m) => m.id === messageId);
    if (!target) return;
    // 清除该消息的 incomplete 状态
    setMessages((prev) => prev.map((m) =>
      m.id === messageId ? { ...m, incomplete: false, incompleteReasons: undefined, streaming: true } : m
    ));
    vscode.postMessage({
      command: 'continueMessage',
      messageId,
      continueFromContent: target.content,
    } as WebViewRequest);
    setIsProcessing(true);
    // 继续生成视为新一轮处理，清空完成状态
    setAgentStatus(null);
  };

  return (
    <div className={`lifeAiCode-panel ${isPopup ? 'lifeAiCode-panel--popup' : ''}`}>
      {/* 对话历史侧边栏 */}
      {showHistory && (
        <div className="history-sidebar" ref={historyRef}>
          <div className="history-sidebar__header">
            <span className="history-sidebar__title">对话历史</span>
            <button
              className="history-sidebar__close"
              onClick={() => setShowHistory(false)}
              title="关闭"
            >
              <X size={14} strokeWidth={2} />
            </button>
          </div>
          <div className="history-list">
            {history.length === 0 && (
              <div className="history-empty">暂无历史对话</div>
            )}
            {history.map((item) => (
              <div
                key={item.id}
                draggable
                className={`history-item ${historyDragId === item.id ? 'history-item--dragging' : ''}`}
                onClick={() => restoreHistory(item)}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', item.id);
                  setHistoryDragId(item.id);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (historyDragId === item.id || !historyDragId) return;
                  const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                  setHistoryDropTarget({ id: item.id, after: e.clientY > rect.top + rect.height / 2 });
                }}
                onDragLeave={() => {
                  if (historyDropTarget?.id === item.id) setHistoryDropTarget(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const fromId = e.dataTransfer.getData('text/plain');
                  if (fromId && historyDropTarget) {
                    reorderHistory(fromId, historyDropTarget.id, historyDropTarget.after);
                  }
                  setHistoryDragId(null);
                  setHistoryDropTarget(null);
                }}
                onDragEnd={() => {
                  setHistoryDragId(null);
                  setHistoryDropTarget(null);
                }}
              >
                {historyDropTarget?.id === item.id && !historyDropTarget.after && (
                  <div className="history-item__drop-line" />
                )}
                <span className="history-item__drag" title="拖拽排序">
                  <GripVertical size={14} strokeWidth={2} />
                </span>
                <div className="history-item__body">
                  <div className="history-item__title">{item.title}</div>
                  <div className="history-item__meta">
                    {new Date(item.timestamp).toLocaleString('zh-CN', {
                      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                    })}
                  </div>
                </div>
                {historyDropTarget?.id === item.id && historyDropTarget.after && (
                  <div className="history-item__drop-line" />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="messages-area">
      <div className="messages-container" ref={messagesContainerRef}>
        {notice && (
          <div className={`chat-notice chat-notice--${notice.level}`}>
            {notice.level === 'success' && <Check size={13} strokeWidth={2.5} />}
            {notice.level === 'info' && <Sparkles size={13} strokeWidth={2} />}
            {notice.level === 'warning' && <ShieldCheck size={13} strokeWidth={2} />}
            {notice.level === 'error' && <ShieldCheck size={13} strokeWidth={2} />}
            <span>{notice.message}</span>
          </div>
        )}
        {messages.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state__logo">
              <Sparkles size={28} color="#fff" strokeWidth={2} />
            </div>
            <div className="empty-state__title">开始与 AI 对话</div>
            <div className="empty-state__hint">
              {aiEditMode
                ? '编辑模式 — AI 可以直接修改当前文件代码，请确认后再使用。'
                : '只读模式 — AI 分析代码并提供建议，不会直接修改你的代码。'}
            </div>

            <div className="empty-state__suggestions">
              <button className="empty-state__suggestion" onClick={() => setInput('解释当前文件的主要功能')}>
                <span className="empty-state__suggestion-icon">
                  <MessageSquare size={12} strokeWidth={2} />
                </span>
                <span>解释当前文件的主要功能</span>
              </button>
              <button className="empty-state__suggestion" onClick={() => setInput('找出可能存在的 bug 并修复')}>
                <span className="empty-state__suggestion-icon">
                  <ShieldCheck size={12} strokeWidth={2} />
                </span>
                <span>找出可能存在的 bug 并修复</span>
              </button>
              <button className="empty-state__suggestion" onClick={() => setInput('优化性能并解释改进点')}>
                <span className="empty-state__suggestion-icon">
                  <Sparkles size={12} strokeWidth={2} />
                </span>
                <span>优化性能并解释改进点</span>
              </button>
              <button className="empty-state__suggestion" onClick={() => setInput('为这段代码添加单元测试')}>
                <span className="empty-state__suggestion-icon">
                  <Paperclip size={12} strokeWidth={2} />
                </span>
                <span>为这段代码添加单元测试</span>
              </button>
            </div>

            {!activeConfig?.verified && (
              <button className="config-btn config-btn--primary" style={{ marginTop: 8 }} onClick={onOpenConfig}>
                <Sparkles size={13} strokeWidth={2} />
                配置 AI 服务商
              </button>
            )}
          </div>
        ) : (
          messages.map((msg, index) => {
            const isLast = index === messages.length - 1;
            const isLastAssistant = msg.role === 'assistant' && isLast;
            const showAgentPanel = isLastAssistant && agentMode && (agentStatus !== null || toolCalls.length > 0);

            // 占位消息：渲染独立的"准备中"提示（必须在 streaming 过滤之前判断）
            if (msg.placeholder) {
              return (
                <div key={msg.id} className="message-row message-row--assistant">
                  <div className="message-inner">
                    <div className="message-avatar message-avatar--assistant">
                      <Sparkles size={16} strokeWidth={2} />
                    </div>
                    <div className="message-body">
                      {showAgentPanel && (
                        <>
                          {agentStatus && (
                            <AgentStatusBar
                              status={agentStatus.status}
                              message={agentStatus.message}
                              onCancel={agentStatus.status === 'running' ? handleCancelAgent : undefined}
                            />
                          )}
                          {agentMode && <ToolCallLog toolCalls={toolCalls} />}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            }
            // 跳过内容为空且仍在流式传输的 assistant 消息，避免显示空白卡片
            // （真实 chatResponse 第一帧到达但内容仍空时短暂出现）
            if (msg.role === 'assistant' && !msg.content.trim() && msg.streaming && !showAgentPanel) {
              return null;
            }
            return (
            <div key={msg.id} className={`message-row message-row--${msg.role}`}>
              <div className="message-inner">
                {/* Avatar */}
                {msg.role === 'assistant' ? (
                  <div className="message-avatar message-avatar--assistant">
                    <Sparkles size={16} strokeWidth={2} />
                  </div>
                ) : (
                  <div className="message-avatar message-avatar--user">
                    <User size={16} strokeWidth={2} />
                  </div>
                )}

                {/* Body */}
                <div className="message-body">
                  {/* Header (only for assistant) */}
                  {msg.role === 'assistant' && (
                    <div className="assistant-header">
                      <span className="assistant-header__name">AI Assistant</span>
                      <span className="assistant-header__divider" />
                      <span className="assistant-header__meta">{formatMessageTime(msg.timestamp)}</span>
                      {providerLabel && (
                        <>
                          <span className="assistant-header__divider" />
                          <span className="assistant-header__meta">{providerLabel}</span>
                        </>
                      )}
                    </div>
                  )}

                  {/* Agent 执行过程（嵌入到当前 AI 回复中，保持从上到下的流程） */}
                  {showAgentPanel && (
                    <>
                      {agentStatus && (
                        <AgentStatusBar
                          status={agentStatus.status}
                          message={agentStatus.message}
                          onCancel={agentStatus.status === 'running' ? handleCancelAgent : undefined}
                        />
                      )}
                      {agentMode && <ToolCallLog toolCalls={toolCalls} />}
                    </>
                  )}

                  {/* Content */}
                  <ContentBlocks
                    content={msg.content}
                    role={msg.role}
                    shellOutputs={shellOutputs}
                    completed={!msg.streaming}
                    providerLabel={msg.role === 'assistant' ? providerLabel : undefined}
                    modelLabel={msg.role === 'assistant' ? modelLabel : undefined}
                    provider={activeConfig?.provider || 'custom'}
                    onCopy={msg.role === 'assistant' ? (text) => navigator.clipboard.writeText(text).catch(() => {}) : undefined}
                    onContinue={msg.role === 'assistant' && msg.incomplete ? () => handleContinue(msg.id) : undefined}
                    onExecuteShell={(id, shellCommand) => {
                      vscode?.postMessage({ command: 'executeShell', id, shellCommand, cwd: context?.workspaceRoot || '' } as WebViewRequest);
                    }}
                    onKillShell={(id) => {
                      vscode?.postMessage({ command: 'killShell', id } as WebViewRequest);
                    }}
                    onOptionClick={(text) => sendMessage(text)}
                  />

                  {/* Suggestions */}
                  {msg.suggestions && msg.suggestions.length > 0 && (
                    <SuggestionList
                      suggestions={msg.suggestions}
                      onAccept={handleAcceptSuggestion}
                      onReject={handleRejectSuggestion}
                      onOpenDiffInEditor={handleOpenDiffInEditor}
                    />
                  )}
                </div>
              </div>
            </div>
            );
          })
        )}

        {error && <div className="error-message">⚠️ {error}</div>}
        <div ref={messagesEndRef} />
      </div>

      {/* 底部状态指示器：处理中显示动态状态；完成后保留显示；有消息时也显示（含历史会话） */}
      {(isProcessing || agentStatus?.status === 'done' || messages.some((m) => m.role === 'assistant' && !m.placeholder)) && (
        <div className="status-indicator-zone">
          <PreparingPlaceholder
            agentStatus={agentStatus}
            changes={allChanges}
            onOpenDiff={handleOpenDiffInEditor}
            tokenPercent={tokenPercent}
          />
        </div>
      )}

      {/* Scroll to bottom button */}
      {userScrolledUp && (
        <button
          className="scroll-to-bottom"
          title="回到底部"
          onClick={() => {
            setUserScrolledUp(false);
            messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
          }}
        >
          <ArrowDown size={16} strokeWidth={2} />
        </button>
      )}
      </div>

      {/* Agent 编辑确认弹窗 */}
      {currentPendingEdit && (
        <DiffConfirmDialog
          filePath={currentPendingEdit.filePath}
          original={currentPendingEdit.original}
          modified={currentPendingEdit.modified}
          onConfirm={handleConfirmAgentEdit}
          onReject={handleRejectAgentEdit}
        />
      )}
      {/* Bug 4: 多个 pending 编辑时的队列计数器 */}
      {pendingAgentEdits.length > 1 && (
        <div style={{ position: 'fixed', bottom: '220px', right: '24px', background: 'var(--vscode-statusBarItem-warningBackground, #fffce0)', color: 'var(--vscode-statusBarItem-warningForeground, #333)', padding: '4px 12px', borderRadius: '4px', fontSize: '12px', zIndex: 1000, boxShadow: '0 2px 8px rgba(0,0,0,0.15)' }}>
          还有 {pendingAgentEdits.length - 1} 个编辑待确认
        </div>
      )}

      {/* Input bar */}
      <div className="input-bar">
        <div className="input-wrapper">
          <textarea
            ref={inputRef}
            className="input-textarea"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isProcessing
                ? (agentStatus ? `Agent ${agentStatus.status === 'running' ? '执行中' : agentStatus.status}…（可在状态条停止）` : '生成中…')
                : '输入消息... (Enter 发送，Shift+Enter 换行)'
            }
            disabled={isProcessing}
            rows={1}
          />
          <div className="input-toolbar" ref={toolbarRef}>
            <div className="input-tags">
              {fileName && (
                <button className="input-tag" title={contextFile}>
                  <Paperclip size={11} strokeWidth={2} />
                  {fileName}
                </button>
              )}
              {/* Model selector */}
              <div className={`kc-config-selector ${isProcessing ? 'kc-config-selector--disabled' : ''}`} ref={configPickerRef} style={{ position: 'relative' }}>
                <button
                  className="input-tag input-tag--model"
                  title={isProcessing ? '当前正在对话中，功能暂不可用' : (activeConfig ? `${activeMeta?.label || '未知'}: ${activeConfig.model || activeConfig.name}` : '未配置')}
                  disabled={isProcessing}
                  onClick={() => !isProcessing && setShowConfigPicker(!showConfigPicker)}
                >
                  <span className="kc-config-indicator" style={{
                    background: getConnectionStatusColor(activeConfig?.connectionStatus),
                  }} />
                  <span className="kc-config-selector__label">
                    {activeMeta?.label || '未配置'}
                    {activeConfig?.model && <span className="kc-config-selector__model">/ {activeConfig.model}</span>}
                  </span>
                  <ChevronDown size={12} strokeWidth={2} className={`kc-config-selector__chevron ${showConfigPicker ? 'kc-config-selector__chevron--open' : ''}`} />
                </button>

                {showConfigPicker && (
                  <div className="kc-dropdown kc-dropdown--models">
                    {configs.length === 0 && (
                      <div className="kc-dropdown__header">暂无配置</div>
                    )}
                    {groupConfigsByProviderOrder(configs).map(({ provider, configs: group }) => {
                      const meta = PROVIDER_META[provider];
                      return (
                        <div key={provider} className="kc-dropdown__group">
                          <div className="kc-dropdown__header">{meta.label}</div>
                          {group.map((cfg) => {
                            const isActive = cfg.id === activeConfig?.id;
                            return (
                              <button
                                key={cfg.id}
                                className={`kc-dropdown__item ${isActive ? 'kc-dropdown__item--active' : ''}`}
                                onClick={() => {
                                  if (isActive) {
                                    setShowConfigPicker(false);
                                    return;
                                  }
                                  vscode?.postMessage({ command: 'switchConfig', configId: cfg.id } as WebViewRequest);
                                  setShowConfigPicker(false);
                                }}
                                title={`${cfg.name || meta.label} / ${cfg.model}`}
                              >
                                <span className="kc-dropdown__item-title">{cfg.name || meta.label}</span>
                                <span className="kc-dropdown__item-meta">{cfg.model}</span>
                              </button>
                            );
                          })}
                        </div>
                      );
                    })}
                    <div className="kc-dropdown__divider" />
                    <button className="kc-dropdown__manage" onClick={() => { setShowConfigPicker(false); onOpenConfig(); }}>
                      <Sparkles size={13} strokeWidth={2} />
                      管理配置
                    </button>
                  </div>
                )}
              </div>
            </div>
            <div className="input-actions">
              <div title={isProcessing ? '当前正在对话中，功能暂不可用' : undefined} style={{ display: 'inline-flex' }}>
                <AgentModeToggle enabled={agentMode} onToggle={() => !isProcessing && setAgentMode(!agentMode)} disabled={isProcessing} />
              </div>
              {!compactActions && (
                <>
                  <button
                    className={`input-icon-btn ${thinkingEnabled ? 'input-icon-btn--active' : ''} ${isProcessing ? 'input-icon-btn--disabled' : ''}`}
                    title={isProcessing ? '当前正在对话中，功能暂不可用' : (thinkingEnabled ? '思考模式已开启' : '思考模式已关闭')}
                    disabled={isProcessing}
                    onClick={() => !isProcessing && setThinkingEnabled(!thinkingEnabled)}
                  >
                    <Brain size={15} strokeWidth={1.8} />
                  </button>
                  <button
                    className={`input-icon-btn ${aiEditMode ? 'input-icon-btn--active' : ''} ${isProcessing ? 'input-icon-btn--disabled' : ''}`}
                    title={isProcessing ? '当前正在对话中，功能暂不可用' : (aiEditMode ? '编辑模式已开启（AI 可直接修改代码，自动接受建议）' : '只读模式已开启（AI 仅提供建议，不修改代码）')}
                    disabled={isProcessing}
                    onClick={() => {
                      if (!isProcessing) vscode?.postMessage({ command: 'toggleEditMode' } as WebViewRequest);
                    }}
                  >
                    <Pencil size={15} strokeWidth={1.8} />
                  </button>
                </>
              )}
              {compactActions && (
                <div className="action-overflow" ref={actionOverflowRef} style={{ position: 'relative' }}>
                  <button
                    className={`input-icon-btn ${showActionOverflow ? 'input-icon-btn--active' : ''} ${isProcessing ? 'input-icon-btn--disabled' : ''}`}
                    title={isProcessing ? '当前正在对话中，功能暂不可用' : '更多操作'}
                    disabled={isProcessing}
                    onClick={() => !isProcessing && setShowActionOverflow(!showActionOverflow)}
                  >
                    <MoreHorizontal size={15} strokeWidth={1.8} />
                  </button>
                  {showActionOverflow && !isProcessing && (
                    <div className="action-overflow-menu">
                      <button
                        className={`action-overflow-menu__item ${thinkingEnabled ? 'action-overflow-menu__item--active' : ''}`}
                        onClick={() => { setThinkingEnabled(!thinkingEnabled); }}
                      >
                        <Brain size={14} strokeWidth={1.8} />
                        <span>思考模式</span>
                        <span className="action-overflow-menu__state">{thinkingEnabled ? '开' : '关'}</span>
                      </button>
                      <button
                        className={`action-overflow-menu__item ${aiEditMode ? 'action-overflow-menu__item--active' : ''}`}
                        onClick={() => { vscode?.postMessage({ command: 'toggleEditMode' } as WebViewRequest); }}
                      >
                        <Pencil size={14} strokeWidth={1.8} />
                        <span>编辑模式</span>
                        <span className="action-overflow-menu__state">{aiEditMode ? '开' : '关'}</span>
                      </button>
                    </div>
                  )}
                </div>
              )}
              <button
                className={`input-send ${isProcessing ? 'input-send--stop' : ''}`}
                onClick={() => {
                  if (isProcessing) {
                    vscode?.postMessage({ command: 'abortGeneration' } as WebViewRequest);
                  } else {
                    sendMessage(input);
                  }
                }}
                disabled={!isProcessing && !input.trim()}
                title={isProcessing ? '停止生成' : '发送'}
              >
                {isProcessing ? <Square size={15} strokeWidth={2} fill="currentColor" /> : <Send size={15} strokeWidth={2} />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────── */
/*  准备中占位（用户提交后 → AI 真实返回前的过渡态）                   */
/* ─────────────────────────────────────────────────────────────────── */

/**
 * 动态状态卡片：根据 agentStatus 的 stepType/message 智能匹配当前状态，
 * 显示对应的图标、文案和动画。
 * 状态类型：思考中、读取文件、编辑、执行命令、分配工作、恢复中断、回复中、任务完成
 */
const STATUS_VARIANTS = {
  thinking:  { Icon: Brain,       text: '思考中',       variant: 'thinking'  },
  reading:   { Icon: FileText,    text: '读取文件',    variant: 'reading'   },
  editing:   { Icon: Pencil,      text: '编辑中',       variant: 'editing'   },
  running:   { Icon: Terminal,    text: '执行命令',    variant: 'running'   },
  planning:  { Icon: Network,     text: '分配工作',    variant: 'planning'  },
  recovering:{ Icon: RefreshCw,   text: '尝试恢复中断', variant: 'recovering' },
  done:      { Icon: Check,       text: '任务完成',       variant: 'done'      },
  default:   { Icon: Lightbulb,   text: '回复中',    variant: 'default'   },
} as const;

function resolveStatusVariant(stepType?: string, message?: string) {
  const msg = message || '';
  // 任务完成状态优先识别（对话结束后保留显示）
  if (stepType === 'done') return STATUS_VARIANTS.done;
  if (stepType === 'think' || /思考/.test(msg)) return STATUS_VARIANTS.thinking;
  if (stepType === 'read' || /读取|读文件/.test(msg)) return STATUS_VARIANTS.reading;
  if (stepType === 'edit' || /编辑|修改/.test(msg)) return STATUS_VARIANTS.editing;
  if (stepType === 'run' || /执行|命令/.test(msg)) return STATUS_VARIANTS.running;
  if (stepType === 'agent' || /分配|工具/.test(msg)) return STATUS_VARIANTS.planning;
  if (/恢复|中断/.test(msg)) return STATUS_VARIANTS.recovering;
  if (/回答|回复/.test(msg)) return STATUS_VARIANTS.default;
  return STATUS_VARIANTS.default;
}

/** LCS 行级 diff，统计 added/removed 行数 */
function computeChangeStats(change: SuggestionChange): { added: number; removed: number } {
  const oldLines = change.original.split('\n');
  const newLines = change.modified.split('\n');
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0, j = 0, added = 0, removed = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { removed++; i++; }
    else { added++; j++; }
  }
  while (i < m) { removed++; i++; }
  while (j < n) { added++; j++; }
  return { added, removed };
}

/** 估算 token 使用率百分比（基于消息内容长度，中英混合约 3 字符/token） */
function estimateTokenPercent(messages: ChatMessage[]): number {
  const totalChars = messages.reduce((sum, m) => {
    const content = m.content || '';
    const blocks = m.blocks?.reduce((s: number, b) => s + (b.type === 'text' ? b.content.length : b.type === 'reasoning' ? b.content.length : 0), 0) || 0;
    return sum + content.length + blocks;
  }, 0);
  if (totalChars === 0) return 0;
  const estimatedTokens = Math.ceil(totalChars / 3);
  const contextWindow = 128000;
  return Math.min((estimatedTokens / contextWindow) * 100, 100);
}

function PreparingPlaceholder({
  agentStatus,
  changes = [],
  onOpenDiff,
  tokenPercent,
}: {
  agentStatus?: { status: string; message: string; stepType?: string } | null;
  changes?: SuggestionChange[];
  onOpenDiff?: (change: SuggestionChange) => void;
  tokenPercent?: number;
}) {
  const isDone = agentStatus?.status === 'done';
  const [showChanges, setShowChanges] = useState(false);
  // 任务完成：静态无动画，使用 status-card--done 停止 iconPulse/iconSpin
  if (isDone) {
    return (
      <div className="status-card status-card--done" style={{ position: 'relative' }}>
        <span className="status-card__icon">
          <Check size={12} strokeWidth={2} />
        </span>
        <span className="status-card__text">任务完成</span>
        {changes.length > 0 && onOpenDiff && (
          <button
            className={`status-card__action ${showChanges ? 'status-card__action--active' : ''}`}
            onClick={() => setShowChanges(!showChanges)}
            title="查看代码变更"
          >
            <GitCompare size={11} strokeWidth={1.8} />
            <span>代码变更</span>
            <span className="status-card__action-count">{changes.length}</span>
          </button>
        )}
        {typeof tokenPercent === 'number' && tokenPercent > 0 && (
          <span className="status-card__token" title="上下文窗口 Token 使用率（估算）">
            Token {tokenPercent.toFixed(1)}%
          </span>
        )}
        {showChanges && changes.length > 0 && (
          <div className="status-changes-popup">
            <div className="status-changes-popup__header">
              <span>变更文件</span>
              <span className="status-changes-popup__count">{changes.length}</span>
            </div>
            <div className="status-changes-popup__list">
              {changes.map((change, idx) => {
                const stats = computeChangeStats(change);
                const fileName = change.filePath.split(/[\\/]/).pop() || change.filePath;
                return (
                  <button
                    key={idx}
                    className="status-changes-popup__item"
                    onClick={() => { onOpenDiff?.(change); setShowChanges(false); }}
                    title={change.filePath}
                  >
                    <span className="status-changes-popup__file">{fileName}</span>
                    <span className="status-changes-popup__path">{change.filePath}</span>
                    <span className="status-changes-popup__stats">
                      {stats.added > 0 && <span className="status-changes-popup__added">+{stats.added}</span>}
                      {stats.removed > 0 && <span className="status-changes-popup__removed">-{stats.removed}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  }
  const { Icon, text, variant } = resolveStatusVariant(agentStatus?.stepType, agentStatus?.message);
  return (
    <div className={`status-card status-card--${variant}`} style={{ position: 'relative' }}>
      <span className="status-card__icon">
        <Icon size={12} strokeWidth={2} />
      </span>
      <span className="status-card__text">{text}</span>
      {changes.length > 0 && onOpenDiff && (
        <button
          className={`status-card__action ${showChanges ? 'status-card__action--active' : ''}`}
          onClick={() => setShowChanges(!showChanges)}
          title="查看代码变更"
        >
          <GitCompare size={11} strokeWidth={1.8} />
          <span>文件变更</span>
          <span className="status-card__action-count">{changes.length}</span>
        </button>
      )}
      {typeof tokenPercent === 'number' && tokenPercent > 0 && (
        <span className="status-card__token" title="上下文窗口 Token 使用率（估算）">
          Token {tokenPercent.toFixed(1)}%
        </span>
      )}
      <span className="status-card__dots">
        <span /><span /><span />
      </span>
      {showChanges && changes.length > 0 && (
        <div className="status-changes-popup">
          <div className="status-changes-popup__header">
            <span>变更文件</span>
            <span className="status-changes-popup__count">{changes.length}</span>
          </div>
          <div className="status-changes-popup__list">
            {changes.map((change, idx) => {
              const stats = computeChangeStats(change);
              const fileName = change.filePath.split(/[\\/]/).pop() || change.filePath;
              return (
                <button
                  key={idx}
                  className="status-changes-popup__item"
                  onClick={() => { onOpenDiff?.(change); setShowChanges(false); }}
                  title={change.filePath}
                >
                  <span className="status-changes-popup__file">{fileName}</span>
                  <span className="status-changes-popup__path">{change.filePath}</span>
                  <span className="status-changes-popup__stats">
                    {stats.added > 0 && <span className="status-changes-popup__added">+{stats.added}</span>}
                    {stats.removed > 0 && <span className="status-changes-popup__removed">-{stats.removed}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
