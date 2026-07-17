import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { ChatMessage, ChatHistoryMessage, CodeContext, WebViewRequest, ExtensionMessage, LlmConfig, ProviderType, ToolCallInfo, SuggestionChange, FileChangeStatus } from '../types';
import { PROVIDER_META, getConnectionStatusColor, getModelContextWindow } from '../types';
import { SuggestionList } from './SuggestionList';
import { ContentBlocks } from './ContentBlocks';
import { AgentStatusBar } from './agent/AgentStatusBar';
import { ToolCallLog } from './agent/ToolCallLog';
import { DiffConfirmDialog } from './agent/DiffConfirmDialog';
import type { PlanStep } from './agent/PlanChecklist';
import { TodoDropdown } from './agent/TodoDropdown';

import { AgentStatusSummary } from './agent/AgentStatusSummary';
import { PlanTaskPanel } from './agent/PlanTaskPanel';
import { TaskSummary } from './agent/TaskSummary';
import { TodoListBlock } from './agent/TodoListBlock';
import { ShieldCheck, Brain, Pencil, ArrowDown, User, Sparkles, Paperclip, Send, MessageSquare, Loader2, Check, Square, ChevronDown, X, GripVertical, Code2, MessageCircleQuestion, FileText, Terminal, RefreshCw, Network, Lightbulb, GitCompare, Trash2, Archive, MapPin, Undo2, Info, Copy } from 'lucide-react';

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

/**
 * §需求4：将毫秒格式化为 "3h12m32s" / "12m32s" / "32s" 形式。
 * - < 1s 显示 "<1s"
 * - < 1m 显示 "Ns"
 * - < 1h 显示 "NmSs"
 * - ≥ 1h 显示 "NhMmSs"
 */
function AssistantCopyButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`assistant-header__copy ${copied ? 'assistant-header__copy--active' : ''}`}
      title={copied ? '已复制' : '复制整条回复'}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(content);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch { /* ignore */ }
      }}
    >
      {copied ? <Check size={12} strokeWidth={2} /> : <Copy size={12} strokeWidth={1.8} />}
    </button>
  );
}

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 1) return '<1s';
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${m}m${s}s`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
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
  /** §模型识别：记录该会话使用的模型 ID，恢复时自动选中 */
  modelId?: string;
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
  // §模式选择：Code = agent+thinking+edit 全开；Ask = thinking 开，其他关
  // 默认 Code 模式。底层三个 boolean 默认值要与 mode='code' 保持一致，
  // 否则首次发送消息时 sendMessage 仍读 agentMode=false，路由到普通 processMessage 而非 runAgentTask。
  const [aiEditMode, setAiEditMode] = useState(true);
  const [autoAccept, setAutoAccept] = useState(false);
  const [thinkingEnabled, setThinkingEnabled] = useState(true);
  const [agentMode, setAgentMode] = useState(true);
  const [mode, setMode] = useState<'code' | 'ask'>('code');
  const [showModePicker, setShowModePicker] = useState(false);
  const [showConfigPicker, setShowConfigPicker] = useState(false);
  const [history, setHistory] = useState<ChatHistoryItem[]>(loadHistory);
  const [showHistory, setShowHistory] = useState(false);
  // §继续会话：当前恢复的历史会话 ID（用于继续对话时拼接历史上下文，以及更新历史项）
  const [currentHistoryId, setCurrentHistoryId] = useState<string | null>(null);
  const [historyDragId, setHistoryDragId] = useState<string | null>(null);
  const [historyDropTarget, setHistoryDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  const [shellOutputs, setShellOutputs] = useState<Record<string, { output: string; status: 'running' | 'success' | 'error' | 'killed' | 'deferred'; longRunning?: boolean; deferred?: boolean }>>({});
  const [notice, setNotice] = useState<{ level: 'info' | 'success' | 'warning' | 'error'; message: string; id: number } | null>(null);
  const [agentStatus, setAgentStatus] = useState<{ status: string; message: string; stepType?: string } | null>(null);
  const [toolCalls, setToolCalls] = useState<ToolCallInfo[]>([]);
  // Bug 4: 改为数组队列，支持多个 pending 编辑同时存在
  // 原来单个 state 会被后续 edit 覆盖，用户丢失前一个确认弹窗
  const [pendingAgentEdits, setPendingAgentEdits] = useState<Array<{ editId: string; filePath: string; original: string; modified: string }>>([]);
  // 持久记录本次会话中所有被 AI 修改过的文件（包括 suggestion 和 agent edit）
  const [agentEditedFiles, setAgentEditedFiles] = useState<SuggestionChange[]>([]);
  // §shell 命令产生的文件变更（如 npx create-vite 创建的文件）
  const [shellChangedFiles, setShellChangedFiles] = useState<SuggestionChange[]>([]);
  // §需求9：当前 Agent 任务的 plan steps（含状态），任务结束后保留供查看
  const [planSteps, setPlanSteps] = useState<PlanStep[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  // §需求1：使用 ref 实时跟踪是否吸附在底部，避免 React state 延迟导致自动滚动与用户滚动冲突
  const isPinnedRef = useRef(true);
  // §滚动空闲计时器：用户上滑停止 3 秒后自动回到底部
  const scrollIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isAutoScrollingRef = useRef(false);
  const configPickerRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const actionOverflowRef = useRef<HTMLDivElement>(null);
  // §模式选择器：Code/Ask 下拉的容器 ref
  const modePickerRef = useRef<HTMLDivElement>(null);
  // §需求2：动态测量 input-tags / input-actions 的宽度来判断是否需要紧凑模式
  const inputTagsRef = useRef<HTMLDivElement>(null);
  const inputActionsRef = useRef<HTMLDivElement>(null);
  const fullActionsWidthRef = useRef<number>(0);
  const vscode = getVsCodeApi();
  // 响应式 input-actions：面板宽度不足时把次要按钮收进 ... 溢出菜单
  const [compactActions, setCompactActions] = useState(false);
  const compactActionsRef = useRef(compactActions);
  compactActionsRef.current = compactActions;
  const [showActionOverflow, setShowActionOverflow] = useState(false);

  const activeMeta = activeConfig ? PROVIDER_META[activeConfig.provider] : null;

  // §4.5: 把易变 state/props 存到 ref，message listener useEffect 只依赖稳定的 vscode，
  // 避免每次 autoAccept/pendingAgentEdit 变化时重订阅（重订阅期间到达的消息可能丢失）。
  const autoAcceptRef = useRef(autoAccept);
  autoAcceptRef.current = autoAccept;
  // §Agent 模式：用户授权"增删改查读"，前端不再弹 DiffConfirmDialog，
  //   收到 agentEditPending 时直接转发 confirmAgentEdit 给后端。
  const agentModeRef = useRef(agentMode);
  agentModeRef.current = agentMode;
  // autoAccept 绑定到 aiEditMode：编辑模式开启时自动接受建议，关闭时手动接受
  useEffect(() => { setAutoAccept(aiEditMode); }, [aiEditMode]);

  // §模式选择：当 mode 变化时同步设置底层三个 boolean。
  //   Code = agent+thinking+edit 全开；Ask = thinking 开，其他关。
  //   这样所有下游逻辑（agentEditPending 自动确认 / sendMessage thinkingEnabled / autoAccept）都按当前模式工作。
  // 注：不再调用 toggleEditMode，因为它是相对 toggle，无法保证后端 aiEditMode 与当前 mode 一致；
  // 后端 aiEditMode 实际只影响 SuggestionList 的 autoAccept，不影响 runAgentTask 工具调用。
  const handleModeChange = useCallback((next: 'code' | 'ask') => {
    setMode(next);
    if (next === 'code') {
      setAgentMode(true);
      setThinkingEnabled(true);
      setAiEditMode(true);
    } else {
      setAgentMode(false);
      setThinkingEnabled(true);
      setAiEditMode(false);
    }
  }, []);
  const pendingAgentEditsRef = useRef(pendingAgentEdits);
  pendingAgentEditsRef.current = pendingAgentEdits;
  const onOpenConfigRef = useRef(onOpenConfig);
  onOpenConfigRef.current = onOpenConfig;
  // §模型识别：ref 让 restoreHistory 能访问最新的 activeConfig
  const activeConfigRef = useRef(activeConfig);
  activeConfigRef.current = activeConfig;
  // §继续会话：用 ref 让 message listener 能访问最新的 currentHistoryId / messages
  const currentHistoryIdRef = useRef<string | null>(null);
  currentHistoryIdRef.current = currentHistoryId;
  const messagesRef = useRef<ChatMessage[]>(messages);
  messagesRef.current = messages;
  // §流式渲染节流：LLM 每个 token 都会 postToWebView 一次 chatResponse，
  // 高频 setMessages 会导致 React 渲染队列积压（用户感知为"卡3秒后一下子输出很多"），
  // 并可能触发样式错乱。用 rAF 合并同一帧内的多次 token 更新，保证渲染与刷新率同步。
  const streamingUpdateRef = useRef<{ id: string; content: string; incomplete: boolean; incompleteReasons: string[] } | null>(null);
  const streamingRafRef = useRef<number | null>(null);

  // §需求3：中止标志位。点击暂停时立即置 true，chatResponse 等消息回调看到 true
  // 就直接丢弃后续内容（阻断输出），避免后端无响应时 UI 卡死在 isProcessing=true
  const abortedRef = useRef<boolean>(false);
  const isProcessingRef = useRef<boolean>(false);
  isProcessingRef.current = isProcessing;
  // §需求4：回复计时——
  //  - questionStartTimeRef：用户发出问题的时间戳（毫秒）。
  //    设为 ref 而不是 state，避免在每次 send 时触发额外渲染；
  //    同时 LLM 长回复中不会被 React 状态批处理逻辑影响。
  //  - lastResponseDuration：上一次回复的耗时（毫秒），用于在 status-indicator-zone
  //    右侧渲染如 "3h12m32s" 的字符串。
  //  - isResponseTimerActive：当前回复是否仍在计时（用户已发问但未结束）。
  //    用于在等待中显示动态时间（每秒更新）。
  const questionStartTimeRef = useRef<number | null>(null);
  const [lastResponseDuration, setLastResponseDuration] = useState<number | null>(null);
  const [isResponseTimerActive, setIsResponseTimerActive] = useState(false);

  // §需求4：动态计时器——
  // 当 isResponseTimerActive=true（即用户已发问、LLM 正在回复中）时，
  // 每秒更新 lastResponseDuration，让 status-indicator-zone 右侧的时间实时跳动。
  // 这样用户在等待 LLM 回复时能看到当前耗时（与最终耗时不同：等待中未结束）。
  useEffect(() => {
    if (!isResponseTimerActive) return;
    const tick = () => {
      const start = questionStartTimeRef.current;
      if (start != null) {
        setLastResponseDuration(Date.now() - start);
      }
    };
    tick(); // 立即触发一次，避免首帧空白
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isResponseTimerActive]);

  // §需求4：回复计时器辅助函数——
  //  - finalizeResponseTimer：对话自然结束（chatResponse done / suggestions / agentStatus done）时调用，
  //    固化最终耗时并停掉动态 tick。
  //  - clearResponseTimer：新建会话 / 切换历史时调用，清空所有计时器状态。
  //  - stopResponseTimerOnError：错误 / 手动中止时调用，仅停掉动态 tick 不再记录耗时。
  const finalizeResponseTimer = useCallback(() => {
    const start = questionStartTimeRef.current;
    if (start != null) {
      setLastResponseDuration(Date.now() - start);
    }
    setIsResponseTimerActive(false);
  }, []);

  const stopResponseTimerOnError = useCallback(() => {
    setIsResponseTimerActive(false);
  }, []);

  const clearResponseTimer = useCallback(() => {
    questionStartTimeRef.current = null;
    setIsResponseTimerActive(false);
    setLastResponseDuration(null);
  }, []);

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
      if (showModePicker && modePickerRef.current && !modePickerRef.current.contains(e.target as Node)) {
        setShowModePicker(false);
      }
    };
    document.addEventListener('mousedown', close);
    // §iframe 失焦兜底：webview 在 iframe 内，点击 IDE 区域不会触发 iframe 的 mousedown，
    // 用 window blur 监听 iframe 失焦来关闭下拉面板
    const handleBlur = () => {
      if (showHistory) setShowHistory(false);
      if (showConfigPicker) setShowConfigPicker(false);
      if (showActionOverflow) setShowActionOverflow(false);
      if (showModePicker) setShowModePicker(false);
    };
    window.addEventListener('blur', handleBlur);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('blur', handleBlur);
    };
  }, [showConfigPicker, showHistory, showActionOverflow, showModePicker]);

  // §需求2：响应式 input-actions — 动态测量 input-tags 内容是否溢出，
  // 仅当空间确实不足（input-tags 右边界被触碰）时才把次要按钮收进 ... 溢出菜单，
  // 替代原固定 400px 阈值，避免过早显示“...”图标
  useEffect(() => {
    const toolbar = toolbarRef.current;
    const tagsEl = inputTagsRef.current;
    const actionsEl = inputActionsRef.current;
    if (!toolbar || !tagsEl || !actionsEl) return;

    const measure = () => {
      // 测量 input-tags 子元素的天然宽度（不受 flex 收缩影响）
      const children = Array.from(tagsEl.children) as HTMLElement[];
      const TAGS_GAP = 6;
      const tagsNaturalWidth = children.reduce((sum, child) => sum + child.offsetWidth, 0)
        + Math.max(0, children.length - 1) * TAGS_GAP;

      // 非紧凑模式下记录 input-actions 的完整宽度，用于稳定比较
      if (!compactActionsRef.current) {
        fullActionsWidthRef.current = actionsEl.offsetWidth;
      }
      const actionsWidth = fullActionsWidthRef.current || actionsEl.offsetWidth;

      const TOOLBAR_GAP = 8;
      const TOOLBAR_PADDING = 20; // 10px left + 10px right
      const totalNeeded = tagsNaturalWidth + actionsWidth + TOOLBAR_GAP;
      const available = toolbar.clientWidth - TOOLBAR_PADDING;

      setCompactActions(totalNeeded > available);
    };

    const ro = new ResizeObserver(measure);
    ro.observe(toolbar);
    measure();
    return () => ro.disconnect();
  }, []);

  // WebView 失去焦点时（点击面板外部）关闭下拉
  useEffect(() => {
    const handleBlur = () => {
      setShowConfigPicker(false);
      setShowHistory(false);
      setShowModePicker(false);
    };
    window.addEventListener('blur', handleBlur);
    return () => window.removeEventListener('blur', handleBlur);
  }, []);

  // 自动滚动到底部：用 rAF 节流 + 直接设置 scrollTop，避免高频 scrollIntoView 导致抖动
  // §需求1：改用 ref 而非 state 判断是否吸附底部，避免 React 渲染延迟导致
  // 自动滚动与用户向上滚动冲突。
  // §需求5：LLM 回复中允许用户上滑浏览；只要用户未主动离开底部（isPinnedRef=true），
  // 内容更新时继续跟随。若用户已上滑，则不强制拉回，由 scroll 空闲计时器处理。
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    if (!isPinnedRef.current) return;
    if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current);
    scrollRafRef.current = requestAnimationFrame(() => {
      if (isPinnedRef.current) {
        isAutoScrollingRef.current = true;
        el.scrollTop = el.scrollHeight;
        // 连续跟随：实际滚动后保持 pinned，让后续 content 能继续跟随
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            isAutoScrollingRef.current = false;
          });
        });
      }
      scrollRafRef.current = null;
    });
    return () => {
      if (scrollRafRef.current != null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, [messages, toolCalls, agentStatus, isProcessing]);

  // §需求5：监听 wheel/touch/scroll 事件，实时检测用户滚动方向。
  // LLM 回复中也允许用户上滑；上滑后启动 3 秒空闲计时器，停止滚动 3 秒后自动回底。
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const threshold = 120;

    const updatePinned = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const pinned = distance <= threshold;
      isPinnedRef.current = pinned;
      setUserScrolledUp(!pinned);
      return pinned;
    };

    const scrollToBottom = () => {
      isAutoScrollingRef.current = true;
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          isAutoScrollingRef.current = false;
        });
      });
    };

    const clearIdleTimer = () => {
      if (scrollIdleTimerRef.current) {
        clearTimeout(scrollIdleTimerRef.current);
        scrollIdleTimerRef.current = null;
      }
    };

    const startIdleTimer = () => {
      clearIdleTimer();
      // §需求5- refine：只有大模型正在输出时才启动回底计时器；
      // 若 5 秒内模型已回答完毕，不再自动拉回底部。
      if (!isProcessingRef.current) return;
      scrollIdleTimerRef.current = setTimeout(() => {
        scrollIdleTimerRef.current = null;
        if (!isProcessingRef.current) return;
        isPinnedRef.current = true;
        setUserScrolledUp(false);
        scrollToBottom();
      }, 5000);
    };

    // wheel 事件：用户向上滚动时立即取消吸附
    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY < 0 && isPinnedRef.current) {
        isPinnedRef.current = false;
        setUserScrolledUp(true);
      }
    };

    // touch 事件：移动端向上滑动时立即取消吸附
    let touchStartY = 0;
    const handleTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0]?.clientY ?? 0;
    };
    const handleTouchMove = (e: TouchEvent) => {
      const deltaY = touchStartY - (e.touches[0]?.clientY ?? 0);
      if (deltaY < 0 && isPinnedRef.current) {
        isPinnedRef.current = false;
        setUserScrolledUp(true);
      }
    };

    const handleScroll = () => {
      // 忽略程序触发的滚动（auto-scroll）
      if (isAutoScrollingRef.current) return;
      const pinned = updatePinned();
      if (pinned) {
        clearIdleTimer();
      } else {
        startIdleTimer();
      }
    };

    el.addEventListener('wheel', handleWheel, { passive: true });
    el.addEventListener('touchstart', handleTouchStart, { passive: true });
    el.addEventListener('touchmove', handleTouchMove, { passive: true });
    el.addEventListener('scroll', handleScroll, { passive: true });
    updatePinned();

    return () => {
      el.removeEventListener('wheel', handleWheel);
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchmove', handleTouchMove);
      el.removeEventListener('scroll', handleScroll);
      clearIdleTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          // §需求3：已被用户中止时直接丢弃内容（阻断输出），
          // 避免后端响应延迟到达造成状态错乱（已恢复的 UI 不会重新进入 isProcessing）
          if (abortedRef.current) {
            // msg.done 时同时清掉占位 + 标记 streaming=false
            if (msg.done) {
              // 取消 pending 的 rAF，避免中止后还有一次延迟渲染
              if (streamingRafRef.current != null) {
                cancelAnimationFrame(streamingRafRef.current);
                streamingRafRef.current = null;
              }
              streamingUpdateRef.current = null;
              setMessages((prev) => {
                const noPlaceholder = prev.filter((m) => !m.placeholder);
                return noPlaceholder.map((m) =>
                  m.id === msg.id
                    ? { ...m, content: m.content || '> ⏹ 已停止生成', streaming: false, incomplete: false, incompleteReasons: [] }
                    : m
                );
              });
            }
            return;
          }

          if (msg.done) {
            // §done 消息：立即处理，取消 pending 的 rAF 避免延迟渲染最终内容
            if (streamingRafRef.current != null) {
              cancelAnimationFrame(streamingRafRef.current);
              streamingRafRef.current = null;
            }
            streamingUpdateRef.current = null;

            let finalContent = finalizeSteps(msg.content);
            const processed = preprocessMarkdown(finalContent);
            finalContent = processed.processed;
            const incomplete = processed.incomplete;
            const incompleteReasons = processed.reasons;

            setMessages((prev) => {
              const noPlaceholder = prev.filter((m) => !m.placeholder);
              const existing = noPlaceholder.find((m) => m.id === msg.id);
              if (existing) {
                return noPlaceholder.map((m) =>
                  m.id === msg.id
                    ? {
                        ...m,
                        content: finalContent,
                        streaming: false,
                        incomplete,
                        incompleteReasons,
                      }
                    : m
                );
              }
              return [...noPlaceholder, {
                id: msg.id, role: 'assistant', content: finalContent,
                timestamp: Date.now(), streaming: false,
                incomplete, incompleteReasons,
              }];
            });
            setIsProcessing(false);
            // 对话结束：保留状态栏，显示"任务完成"
            setAgentStatus({ status: 'done', message: '任务完成', stepType: 'done' });
            // §需求4：固化最终耗时并停掉动态 tick（chatResponse 是最常见的"完成"路径）
            finalizeResponseTimer();
          } else {
            // §流式更新：缓存最新 content 到 ref，用 rAF 合并同一帧内的多次 token。
            // 这样无论 LLM 每秒推送多少 token，setMessages 最多每帧执行一次（约 60fps），
            // 避免渲染队列积压导致"卡3秒后一下子输出"和样式错乱。
            streamingUpdateRef.current = {
              id: msg.id,
              content: msg.content,
              incomplete: false,
              incompleteReasons: [],
            };
            if (streamingRafRef.current == null) {
              streamingRafRef.current = requestAnimationFrame(() => {
                streamingRafRef.current = null;
                const pending = streamingUpdateRef.current;
                if (!pending) return;
                streamingUpdateRef.current = null;
                setMessages((prev) => {
                  const noPlaceholder = prev.filter((m) => !m.placeholder);
                  const existing = noPlaceholder.find((m) => m.id === pending.id);
                  if (existing) {
                    return noPlaceholder.map((m) =>
                      m.id === pending.id
                        ? { ...m, content: pending.content, streaming: true }
                        : m
                    );
                  }
                  return [...noPlaceholder, {
                    id: pending.id, role: 'assistant', content: pending.content,
                    timestamp: Date.now(), streaming: true,
                    incomplete: false, incompleteReasons: [],
                  }];
                });
              });
            }
            setIsProcessing(true);
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
          // §需求4：固化最终耗时并停掉动态 tick
          finalizeResponseTimer();
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
          // §需求3：已被中止时不再处理 error（避免把后端的 abort 错误消息重新显示给用户）
          if (abortedRef.current) {
            return;
          }
          // 错误时也清掉占位
          setMessages((prev) => prev.filter((m) => !m.placeholder));
          setError(msg.message);
          setIsProcessing(false);
          // §需求4：错误时停掉计时器（保留上次耗时，不覆盖为"无耗时"）
          stopResponseTimerOnError();
          // 错误不显示完成状态，清空状态栏
          setAgentStatus(null);
          break;
        }
        case 'aiEditMode': {
          setAiEditMode(msg.enabled);
          break;
        }
        case 'systemMessage': {
          // §Agent 自动创建目录/文件等系统级反馈，以 system 角色渲染在聊天框中
          if (msg.content) {
            setMessages((prev) => [
              ...prev,
              {
                id: generateId(),
                role: 'system',
                content: msg.content,
                timestamp: Date.now(),
              },
            ]);
          }
          break;
        }
        case 'shellFileChanges': {
          // §shell 命令产生的文件变更（如 npx create-vite）：合并到底部变更列表
          const { cwd, created = [], modified = [], deleted = [] } = msg;
          const next: SuggestionChange[] = [];
          for (const p of created) {
            next.push({ filePath: `${cwd}/${p}`, original: '', modified: '[created]', explanation: '由 shell 命令创建', startLine: 0, endLine: 0, status: 'completed' });
          }
          for (const p of modified) {
            next.push({ filePath: `${cwd}/${p}`, original: '[before]', modified: '[after]', explanation: '由 shell 命令修改', startLine: 0, endLine: 0, status: 'completed' });
          }
          for (const p of deleted) {
            next.push({ filePath: `${cwd}/${p}`, original: '[deleted]', modified: '', explanation: '由 shell 命令删除', startLine: 0, endLine: 0, status: 'completed' });
          }
          if (next.length > 0) {
            setShellChangedFiles((prev) => {
              const seen = new Map<string, SuggestionChange>(prev.map((c) => [c.filePath, c]));
              for (const c of next) seen.set(c.filePath, c);
              return Array.from(seen.values());
            });
          }
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
                  modelId: activeConfig?.id,
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
          setShellChangedFiles([]);
          setAgentStatus(null);
          setToolCalls([]);
          setPendingAgentEdits([]);
          setError(null);
          // §需求4：新建会话时清空回复计时器与耗时显示
          clearResponseTimer();
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
              [msg.id]: {
                output: newOutput,
                status: msg.status,
                // 长驻进程标识：后端 extension.js 在 spawn 后会带 longRunning=true，
                // 一次确认后保留（避免 close 事件不带 longRunning 时丢失标识）。
                longRunning: existing?.longRunning === true || msg.longRunning === true,
              },
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
        // §后台任务管理器：命令执行超阈值后转入后台队列
        case 'shellDeferred': {
          console.log('[LifeAiCode WebView] shellDeferred received:', { id: msg.id, shellCommand: msg.shellCommand });
          setShellOutputs((prev) => {
            const existing = prev[msg.id];
            return {
              ...prev,
              [msg.id]: {
                output: (existing?.output || '') + (msg.message ? `\n⏳ ${msg.message}\n` : ''),
                status: 'deferred',
                deferred: true,
                longRunning: existing?.longRunning === true,
              },
            };
          });
          break;
        }
        // §后台任务管理器：后台命令执行完成
        case 'deferredShellDone': {
          console.log('[LifeAiCode WebView] deferredShellDone received:', { id: msg.id, success: msg.success, exitCode: msg.exitCode });
          setShellOutputs((prev) => {
            const existing = prev[msg.id];
            if (!existing) return prev;
            const durationSec = msg.deferredDurationMs ? Math.round(msg.deferredDurationMs / 1000) : 0;
            const tailOutput = msg.output || '';
            const statusText = msg.success
              ? `✅ 后台任务完成（耗时 ${durationSec}s）`
              : `❌ 后台任务失败（exit code ${msg.exitCode}）`;
            return {
              ...prev,
              [msg.id]: {
                output: (existing.output || '') + `\n${statusText}\n` + tailOutput,
                status: msg.success ? 'success' : 'error',
                deferred: true,
                longRunning: existing?.longRunning === true,
              },
            };
          });
          // 延迟清理
          const shellId = msg.id;
          setTimeout(() => {
            setShellOutputs((prev) => {
              if (!prev[shellId]) return prev;
              const next = { ...prev };
              delete next[shellId];
              return next;
            });
          }, 30_000);
          break;
        }
        // §后台任务管理器：Agent 主循环结束后等待后台任务
        case 'deferredWaitStart': {
          const shellList = (msg.shells || [])
            .map((s: { cmd: string }, i: number) => `${i + 1}. \`${s.cmd}\``)
            .join('  ');
          setAgentStatus({ status: 'running', message: `等待 ${msg.pending} 个后台任务完成：${shellList}`, stepType: 'deferred' });
          break;
        }
        case 'deferredWaitDone': {
          if (msg.pending === 0) {
            setAgentStatus({ status: 'done', message: '所有后台任务已完成', stepType: 'deferred' });
          } else {
            setAgentStatus({ status: 'done', message: `${msg.pending} 个后台任务仍在执行中`, stepType: 'deferred' });
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
            // §需求4：固化最终耗时并停掉动态 tick
            finalizeResponseTimer();
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
          // 持久记录被 AI 修改的文件（用于"文件变更"列表），无论模式
          setAgentEditedFiles((prev) => {
            const change: SuggestionChange = { filePath: msg.filePath, original: msg.original, modified: msg.modified, explanation: '', startLine: 0, endLine: 0 };
            const filtered = prev.filter((c) => c.filePath !== change.filePath);
            return [...filtered, change];
          });
          // §Agent 模式：后端 registerPendingEdit 时已自动落盘，
          //   webview 只需把文件变更记录到列表，不再发 confirmAgentEdit。
          if (agentModeRef.current) {
            break;
          }
          // 非 agent 模式（理论上 message listener 不会到这里，保留兜底）：
          // Bug 4: 追加到队列而非覆盖
          setPendingAgentEdits((prev) => [...prev, {
            editId: msg.editId,
            filePath: msg.filePath,
            original: msg.original,
            modified: msg.modified,
          }]);
          break;
        }
        case 'agentEditStatus': {
          // §4.5: 通过 ref 读取最新 pendingAgentEdits
          // Bug 4: 从队列中移除匹配的 editId
          if (pendingAgentEditsRef.current.some((e) => e.editId === msg.editId)) {
            setPendingAgentEdits((prev) => prev.filter((e) => e.editId !== msg.editId));
          }
          // §Agent 自动模式：对应工具调用的 pending 标记清除，ReadFileGroup 显示为已完成
          if (msg.status === 'applied') {
            setToolCalls((prev) => prev.map((t) => {
              if (t.status !== 'success' || !t.result || typeof t.result !== 'object') return t;
              if (t.result.editId === msg.editId) {
                return { ...t, result: { ...t.result, pending: false } };
              }
              return t;
            }));
          }
          break;
        }
        case 'historyCompacted': {
          // §需求8：上下文压缩完成，用摘要替换早期消息
          // 保留最近 2 轮对话（4 条消息）+ 摘要作为首条 user 消息
          setMessages((prev) => {
            const realMsgs = prev.filter((m) => !m.placeholder && m.content.trim());
            if (realMsgs.length <= 4) return prev; // 消息太少不压缩
            const recent = realMsgs.slice(-4);
            const summaryMsg: ChatMessage = {
              id: `summary-${Date.now()}`,
              role: 'user',
              content: `[历史对话摘要]\n${msg.summary}`,
              timestamp: Date.now(),
            };
            return [summaryMsg, ...recent];
          });
          // 重置签名避免立即重新保存历史
          lastSavedSignatureRef.current = null;
          // 显示压缩完成提示
          const id = Date.now();
          setNotice({
            level: 'success',
            message: `上下文已压缩：${msg.beforeTokens} → ${msg.afterTokens} tokens`,
            id,
          });
          setTimeout(() => {
            setNotice((cur) => (cur && cur.id === id ? null : cur));
          }, 3000);
          break;
        }
        case 'planGenerated': {
          // §需求9：Planner 下发计划，初始化所有 step 为 pending
          const initSteps: PlanStep[] = msg.steps.map((s) => ({
            step: s.step,
            tool: s.tool,
            args: s.args,
            reason: s.reason,
            status: 'pending' as const,
          }));
          setPlanSteps(initSteps);
          // §待办任务：同步写入最后一条 assistant 消息的 todos，随消息持久化
          setMessages((prev) => {
            const idx = prev.length - 1;
            if (idx < 0 || prev[idx].role !== 'assistant') return prev;
            const next = prev.slice();
            next[idx] = { ...next[idx], todos: initSteps };
            return next;
          });
          break;
        }
        case 'planStepUpdate': {
          // §需求9：更新某个 step 的状态（pending/running/done/error/skipped）
          setPlanSteps((prev) => {
            if (msg.index < 0 || msg.index >= prev.length) return prev;
            const next = prev.slice();
            next[msg.index] = {
              ...next[msg.index],
              status: msg.status,
              summary: msg.summary ?? next[msg.index].summary,
              ...(msg.startTime != null ? { startTime: msg.startTime } : {}),
              ...(msg.endTime != null ? { endTime: msg.endTime } : {}),
            };
            // §待办任务：同步更新最后一条 assistant 消息的 todos
            const updatedTodos = next;
            setMessages((prevMsgs) => {
              const mIdx = prevMsgs.length - 1;
              if (mIdx < 0 || prevMsgs[mIdx].role !== 'assistant') return prevMsgs;
              const nextMsgs = prevMsgs.slice();
              nextMsgs[mIdx] = { ...nextMsgs[mIdx], todos: updatedTodos };
              return nextMsgs;
            });
            return next;
          });
          break;
        }
        case 'filesReverted': {
          // §撤销修改：文件恢复完成通知。
          // 不仅清空 agentEditedFiles，还要把 messages 中嵌入的 suggestions / diffData 里
          // 对应文件的 status 改为 'reverted'，这样状态栏弹窗里能看到「已撤销」标签。
          if (msg.success) {
            const revertedPaths = new Set(msg.filePaths);
            setAgentEditedFiles((prev) => prev.map((c) =>
              revertedPaths.has(c.filePath) ? { ...c, status: 'reverted' as FileChangeStatus } : c,
            ));
            setMessages((prev) => prev.map((m) => {
              if (!m.suggestions?.length) return m;
              return {
                ...m,
                suggestions: m.suggestions.map((s) => ({
                  ...s,
                  changes: s.changes?.map((c) => revertedPaths.has(c.filePath) ? { ...c, status: 'reverted' as FileChangeStatus } : c),
                  diffData: s.diffData?.map((c) => revertedPaths.has(c.filePath) ? { ...c, status: 'reverted' as FileChangeStatus } : c),
                })),
              };
            }));
          }
          const id = Date.now();
          setNotice({
            level: msg.success ? 'success' : 'error',
            message: msg.success
              ? `已撤销 ${msg.filePaths.length} 个文件的 AI 修改`
              : (msg.message || '撤销失败'),
            id,
          });
          setTimeout(() => {
            setNotice((cur) => (cur && cur.id === id ? null : cur));
          }, 3000);
          break;
        }
      }
    };

    window.addEventListener('message', handler);
    console.log('[LifeAiCode WebView] message listener attached');
    return () => {
      window.removeEventListener('message', handler);
      // §清理 pending 的 rAF，避免组件卸载后仍触发 setMessages
      if (streamingRafRef.current != null) {
        cancelAnimationFrame(streamingRafRef.current);
        streamingRafRef.current = null;
      }
    };
    // §4.5: deps 仅保留稳定的 vscode；autoAccept/pendingAgentEdit/onOpenConfig 通过 ref 读取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vscode]);

  // 从历史恢复对话：渲染历史消息，并标记 currentHistoryId 以便后续继续会话时拼接上下文
  const restoreHistory = useCallback((item: ChatHistoryItem) => {
    setMessages(item.messages);
    setCurrentHistoryId(item.id);
    // §模型识别：若历史会话记录了模型 ID，且与当前不同，自动切换到该模型
    // 若 modelId 不存在或后端找不到对应配置，activeConfig 保持不变（即用当前选中的模型）
    if (item.modelId && item.modelId !== activeConfigRef.current?.id) {
      vscode?.postMessage({ command: 'switchConfig', configId: item.modelId } as WebViewRequest);
    }
    // 恢复历史时清空执行状态与文件变更记录，避免上一次会话的残留干扰
    setAgentStatus({ status: 'done', message: '历史会话已恢复', stepType: 'done' });
    setAgentEditedFiles([]);
    setShellChangedFiles([]);
    setToolCalls([]);
    setPlanSteps([]);
    setPendingAgentEdits([]);
    setError(null);
    // §需求4：切换历史会话时清空回复计时器与耗时显示
    clearResponseTimer();
    setShowHistory(false);
  }, []);

  // §历史删除：从历史列表中移除指定会话项
  const deleteHistoryItem = useCallback((id: string) => {
    setHistory((prev) => {
      const updated = prev.filter((h) => h.id !== id);
      saveHistory(updated);
      return updated;
    });
    // 如果删除的是当前恢复的会话，清空 currentHistoryId
    if (currentHistoryIdRef.current === id) {
      setCurrentHistoryId(null);
    }
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
        modelId: activeConfig?.id,
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
    // §需求3：新一轮对话开始前重置中止标志位，允许正常接收后续响应
    abortedRef.current = false;
    // §需求1：新对话开启时强制重置“跟随底部”标志位——
    // 上一轮用户可能浏览了历史消息（导致 isPinnedRef 被置 false），
    // 现在发新消息，必须让 auto-scroll 重新生效才能跟随 LLM 输出
    isPinnedRef.current = true;
    setUserScrolledUp(false);
    isAutoScrollingRef.current = false;
    if (scrollIdleTimerRef.current) {
      clearTimeout(scrollIdleTimerRef.current);
      scrollIdleTimerRef.current = null;
    }
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
    // §需求4：用户发问时启动回复计时器——记录起点时间、激活动态 tick、清空上次结果。
    // 这里在 setIsProcessing(true) 之后立即同步写入，确保 useEffect 调度时拿到一致状态。
    questionStartTimeRef.current = Date.now();
    setIsResponseTimerActive(true);
    setLastResponseDuration(null);
    // 新对话开始时清空上一次的完成状态与执行记录，避免显示到新的占位消息上
    setAgentStatus(null);
    if (agentMode) {
      setToolCalls([]);
      setPlanSteps([]);
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
      // §DeepSeek thinking mode：assistant 消息必须回传 reasoning_content，否则 API 报 400
      //   "The reasoning_content in the thinking mode must be passed back to the API."
      //   reasoning 内容存在 ChatMessage.blocks 的 { type: 'reasoning' } 块中，提取后作为
      //   reasoning_content 字段传给后端；llmClient 会根据 provider 决定是否发送给 API。
      history: messagesRef.current
        .filter((m) => !m.placeholder && m.content.trim())
        .slice(-20)
        .map((m) => {
          const msg: ChatHistoryMessage = {
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: m.content,
          };
          if (m.role === 'assistant' && m.blocks) {
            for (const b of m.blocks) {
              if (b.type === 'reasoning' && b.content) {
                msg.reasoning_content = b.content;
                break;
              }
            }
          }
          return msg;
        }),
    } as WebViewRequest);
  };

  // §需求3：点击暂停时的统一处理
  // 1) 通知后端（让流式生成尽早停止，避免后端继续烧 token）
  // 2) 立即同步恢复前端 UI 状态——不管后端是否响应，UI 都不能卡死
  // 3) 设置 abortedRef 阻断后续 chatResponse/error 等消息的输出
  // 4) 把所有 running 中的 streaming 消息标记为停止，避免 spinner 一直转
  const handleAbort = useCallback(() => {
    // 通知后端（即便失败也无所谓，前端已自行恢复）
    vscode?.postMessage({ command: 'abortGeneration' } as WebViewRequest);
    // 阻断后续输出
    abortedRef.current = true;
    // 同步恢复 UI 状态
    setIsProcessing(false);
    setAgentStatus(null);
    setToolCalls((prev) => prev.map((t) => (t.status === 'running' ? { ...t, status: 'error' as const } : t)));
    // §结束对话时：正在执行的步骤标记为失败，未执行的保持未执行
    setPlanSteps((prev) => prev.map((s) =>
      s.status === 'running' ? { ...s, status: 'error' as const } : s
    ));
    // 把所有 streaming 消息标记为停止，并清掉占位消息
    setMessages((prev) => {
      const noPlaceholder = prev.filter((m) => !m.placeholder);
      return noPlaceholder.map((m) =>
        m.streaming
          ? { ...m, streaming: false, content: m.content || '> ⏹ 已停止生成' }
          : m
      );
    });
  }, []);

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

  // 合并 suggestions 变更 + agent 编辑变更（按 filePath 去重），并过滤空值
  // §空值定义：1) filePath 为空；2) original === modified（未产生实际改动）。
  // 这两类 entry 通常是流式占位/LLM 抖动产物，列在弹窗里会让计数虚高、误导用户。
  const allChanges = useMemo<SuggestionChange[]>(() => {
    const seen = new Map<string, SuggestionChange>();
    for (const c of [...collectedChanges, ...agentEditedFiles, ...shellChangedFiles]) {
      if (!c || !c.filePath) continue;
      if (c.original !== undefined && c.modified !== undefined && c.original === c.modified) continue;
      seen.set(c.filePath, c);
    }
    return Array.from(seen.values());
  }, [collectedChanges, agentEditedFiles, shellChangedFiles]);

  // §需求8：估算本次对话的 token 使用情况（token 数 + 百分比 + context window）
  // 用当前选中模型的 context window 代替硬编码 128K
  const tokenUsage = useMemo(() => {
    const cw = activeConfig ? getModelContextWindow(activeConfig.provider, activeConfig.model) : 128000;
    return estimateTokenUsage(messages, cw);
  }, [messages, activeConfig]);

  // §定位提问：收集当前会话的用户提问
  const userQuestions = useMemo(
    () => messages
      .filter((m) => m.role === 'user' && m.content.trim() && !m.placeholder)
      .map((m) => ({ id: m.id, content: m.content.trim() })),
    [messages],
  );

  // §定位提问：滚动到指定消息并临时高亮
  const handleLocateMessage = useCallback((id: string) => {
    const el = document.getElementById(`msg-${id}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('message-row--located');
      setTimeout(() => el.classList.remove('message-row--located'), 2000);
    }
  }, []);

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

  // §撤销修改：将 AI 自动修改的文件恢复到修改前的内容
  const handleRevertChanges = useCallback((changes: SuggestionChange[]) => {
    if (!vscode || changes.length === 0) return;
    vscode.postMessage({
      command: 'revertFiles',
      changes: changes.map((c) => ({ filePath: c.filePath, original: c.original })),
    } as WebViewRequest);
  }, [vscode]);

  // §接受修改：用户确认保留 AI 改动。
  // 不需要再调后端（completed 状态时文件已默认同步到磁盘），只需把 UI 状态从 completed 升级为 applied。
  const handleAcceptChanges = useCallback((changes: SuggestionChange[]) => {
    if (changes.length === 0) return;
    const updatedPaths = new Set(changes.map((c) => c.filePath));
    setAgentEditedFiles((prev) => prev.map((c) =>
      updatedPaths.has(c.filePath) ? { ...c, status: 'applied' as FileChangeStatus } : c,
    ));
    setMessages((prev) => prev.map((m) => {
      if (!m.suggestions?.length) return m;
      return {
        ...m,
        suggestions: m.suggestions.map((s) => ({
          ...s,
          changes: s.changes?.map((c) => updatedPaths.has(c.filePath) ? { ...c, status: 'applied' as FileChangeStatus } : c),
          diffData: s.diffData?.map((c) => updatedPaths.has(c.filePath) ? { ...c, status: 'applied' as FileChangeStatus } : c),
        })),
      };
    }));
  }, []);

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
    <div
      className={`lifeAiCode-panel ${isPopup ? 'lifeAiCode-panel--popup' : ''}`}
      onMouseDown={(e) => {
        // §历史 Dropdown 关闭：点击 history-dropdown 之外的任何区域都关闭
        if (showHistory && historyRef.current && !historyRef.current.contains(e.target as Node)) {
          setShowHistory(false);
        }
      }}
    >
      {/* 对话历史下拉菜单 */}
      {showHistory && (
        <div className="history-dropdown" ref={historyRef}>
          <div className="history-dropdown__header">
            <span className="history-dropdown__title">对话历史</span>
            <button
              className="history-dropdown__close"
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
                <button
                  className="history-item__delete"
                  title="删除此会话"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteHistoryItem(item.id);
                  }}
                >
                  <Trash2 size={13} strokeWidth={1.8} />
                </button>
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
              // §即使已经切换到 Agent 面板，只要还没有实际内容（planSteps/toolCalls 都为空），
              // 就继续显示 thinking indicator，避免用户以为界面卡住。
              const hasAgentContent = planSteps.length > 0 || toolCalls.length > 0;
              const thinkingText = agentStatus?.message
                ? `正在处理：${agentStatus.message}`
                : '正在思考';
              return (
                <div key={msg.id} className="message-row message-row--assistant">
                  <div className="message-inner">
                    <div className="message-avatar message-avatar--assistant">
                      <Sparkles size={16} strokeWidth={2} />
                    </div>
                    <div className="message-body">
                      {agentMode && planSteps.length > 0 && <TodoListBlock steps={planSteps} defaultExpanded />}
                      {agentMode && <ToolCallLog toolCalls={toolCalls} />}
                      {(!showAgentPanel || !hasAgentContent) && (
                        // §等待 LLM 首个 token / Agent 计划生成前的视觉反馈
                        <div className="thinking-indicator">
                          <span className="thinking-indicator__icon">
                            <Sparkles size={14} strokeWidth={2} />
                          </span>
                          <span className="thinking-indicator__text">{thinkingText}</span>
                          <span className="thinking-indicator__dots">
                            <span className="thinking-indicator__dot" />
                            <span className="thinking-indicator__dot" />
                            <span className="thinking-indicator__dot" />
                          </span>
                        </div>
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
            // 去掉独立的“任务完成”占位卡片，状态由 status-indicator-zone 统一展示
            if (msg.role === 'assistant' && msg.content.trim() === '任务完成' && !msg.streaming) {
              return null;
            }
            return (
            <div key={msg.id} id={`msg-${msg.id}`} className={`message-row message-row--${msg.role}`}>
              <div className="message-inner">
                {/* Avatar */}
                {msg.role === 'assistant' ? (
                  <div className="message-avatar message-avatar--assistant">
                    <Sparkles size={16} strokeWidth={2} />
                  </div>
                ) : msg.role === 'system' ? (
                  <div className="message-avatar message-avatar--system">
                    <Info size={13} strokeWidth={2} />
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
                      <AssistantCopyButton content={msg.content} />
                    </div>
                  )}

                  {/* Agent 执行过程（嵌入到当前 AI 回复中，保持从上到下的流程） */}
                  {showAgentPanel && (
                    <>
                      {agentMode && <ToolCallLog toolCalls={toolCalls} />}
                    </>
                  )}

                  {/* §待办任务：按消息持久化的任务清单（历史会话也保留） */}
                  {msg.todos && msg.todos.length > 0 && (
                    <TodoListBlock steps={msg.todos} defaultExpanded={index === messages.length - 1} />
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
                    agentStatus={msg.role === 'assistant' && index === messages.length - 1 ? agentStatus : undefined}
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
                    // §需求：传入工作区根路径让 SuggestionList 能把相对路径
                    // （./vite.config.ts / vite.config.ts）解析为绝对路径做去重。
                    <SuggestionList
                      suggestions={msg.suggestions}
                      onAccept={handleAcceptSuggestion}
                      onReject={handleRejectSuggestion}
                      onOpenDiffInEditor={handleOpenDiffInEditor}
                      workspaceRoot={context?.workspaceRoot}
                    />
                  )}

                  {/* §任务末尾总结：Agent 完成后展示计划/读/写/改/删/命令等统计 */}
                  {msg.role === 'assistant' && agentStatus?.status === 'done' && index === messages.length - 1 && (
                    <TaskSummary
                      toolCalls={toolCalls}
                      planSteps={planSteps}
                      changes={allChanges}
                      duration={lastResponseDuration}
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
            onAcceptChanges={handleAcceptChanges}
            onRejectChanges={handleRevertChanges}
            tokenUsage={tokenUsage}
            onCompact={() => {
              const realMsgs = messagesRef.current
                .filter((m) => !m.placeholder && m.content.trim())
                .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
              if (realMsgs.length > 4) {
                vscode?.postMessage({ command: 'compactHistory', messages: realMsgs } as WebViewRequest);
              }
            }}
            userQuestions={userQuestions}
            onLocateMessage={handleLocateMessage}
          />
          {/* §运行中动态状态 + 停止按钮：从消息体顶部迁移到底部状态栏 */}
          {agentStatus?.status === 'running' && (
            <AgentStatusBar
              status="running"
              message={agentStatus.message}
              onCancel={handleCancelAgent}
              inline
            />
          )}
          {/* §需求4：status-indicator-zone 右侧显示回复耗时——
              等待中（isResponseTimerActive=true）实时跳动；已结束时显示最终耗时；
              未发问时不渲染。 */}
          {lastResponseDuration != null && (
            <span
              className={`status-indicator-zone__response-time ${isResponseTimerActive ? 'status-indicator-zone__response-time--active' : ''}`}
              title={isResponseTimerActive ? '本次回复已运行时间' : '上次回复耗时'}
            >
              {formatDuration(lastResponseDuration)}
            </span>
          )}
          {/* §待办任务：状态区按钮，点击展开任务列表 Dropdown。置于最右侧 */}
          <TodoDropdown steps={planSteps} />
        </div>
      )}

      {/* §底部计划任务面板：显示当前执行到第几步及每步状态 */}
      {planSteps.length > 0 && (
        <div className="agent-summary-zone">
          <PlanTaskPanel steps={planSteps} />
        </div>
      )}

      {/* Scroll to bottom button */}
      {userScrolledUp && (
        <button
          className="scroll-to-bottom"
          title="回到底部"
          onClick={() => {
            isPinnedRef.current = true;
            setUserScrolledUp(false);
            isAutoScrollingRef.current = false;
            if (scrollIdleTimerRef.current) {
              clearTimeout(scrollIdleTimerRef.current);
              scrollIdleTimerRef.current = null;
            }
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
            <div className="input-tags" ref={inputTagsRef}>
              {fileName && (
                <button className="input-tag" title={contextFile}>
                  <Paperclip size={11} strokeWidth={2} />
                  {fileName}
                </button>
              )}
              {/* §模式选择器：Code / Ask —— 放在模型选择器左侧，点击弹出下拉 */}
              <div className={`mode-selector ${isProcessing ? 'mode-selector--disabled' : ''}`} ref={modePickerRef} style={{ position: 'relative' }}>
                <button
                  className="input-tag input-tag--mode"
                  title={isProcessing ? '当前正在对话中，功能暂不可用' : `当前模式：${mode === 'code' ? 'Code' : 'Ask'}`}
                  disabled={isProcessing}
                  onClick={() => !isProcessing && setShowModePicker((v) => !v)}
                >
                  {mode === 'code'
                    ? <Code2 size={11} strokeWidth={2} />
                    : <MessageCircleQuestion size={11} strokeWidth={2} />}
                  <span className="mode-selector__label">{mode === 'code' ? 'Code' : 'Ask'}</span>
                  <ChevronDown size={12} strokeWidth={2} className={`mode-selector__chevron ${showModePicker ? 'mode-selector__chevron--open' : ''}`} />
                </button>

                {showModePicker && !isProcessing && (
                  <div className="mode-dropdown">
                    <button
                      className={`mode-dropdown__item ${mode === 'code' ? 'mode-dropdown__item--active' : ''}`}
                      onClick={() => { handleModeChange('code'); setShowModePicker(false); }}
                    >
                      <span className="mode-dropdown__item-title">
                        <Code2 size={14} strokeWidth={2} />
                        <span>Code</span>
                      </span>
                      <span className="mode-dropdown__item-desc">
                        The default agent. Executes tools based on configured permissions.
                      </span>
                    </button>
                    <button
                      className={`mode-dropdown__item ${mode === 'ask' ? 'mode-dropdown__item--active' : ''}`}
                      onClick={() => { handleModeChange('ask'); setShowModePicker(false); }}
                    >
                      <span className="mode-dropdown__item-title">
                        <MessageCircleQuestion size={14} strokeWidth={2} />
                        <span>Ask</span>
                      </span>
                      <span className="mode-dropdown__item-desc">
                        Get answers and explanations without making changes to the codebase.
                      </span>
                    </button>
                  </div>
                )}
              </div>
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
            <div className="input-actions" ref={inputActionsRef}>
              <button
                className={`input-send ${isProcessing || agentStatus?.status === 'running' ? 'input-send--stop' : ''}`}
                onClick={() => {
                  if (isProcessing || agentStatus?.status === 'running') {
                    handleAbort();
                  } else {
                    sendMessage(input);
                  }
                }}
                disabled={!(isProcessing || agentStatus?.status === 'running') && !input.trim()}
                title={isProcessing || agentStatus?.status === 'running' ? '停止生成' : '发送'}
              >
                {isProcessing || agentStatus?.status === 'running' ? <Square size={15} strokeWidth={2} /> : <Send size={15} strokeWidth={2} />}
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

/** §变更文件状态标签：根据 SuggestionChange.status 推断当前文件的处理状态
 *  返回 { status, label, title }：
 *    - status: 用于 BEM 类名（status-tag--completed/reverted/reading/queued/failed）
 *    - label:  2~3 字中文简写（已完成/已撤销/读写中/排队中/失败）
 *    - title:  hover 提示文本（hover 时能看到详细原因）
 *  优先使用 change.status；缺省时：
 *    - 若当前对话正在处理 → reading
 *    - 若对话已完成（isDone） → completed
 *  这样在 status 字段未传递时也能与顶部状态卡联动，避免空洞状态 */
function resolveChangeStatus(
  change: SuggestionChange,
  ctx: { isProcessing: boolean },
): { status: FileChangeStatus; label: string; title: string } {
  const fallback: FileChangeStatus = ctx.isProcessing ? 'reading' : 'completed';
  const status: FileChangeStatus = change.status || fallback;
  const labelMap: Record<FileChangeStatus, string> = {
    completed: '已完成',
    applied: '已应用',
    reverted: '已撤销',
    reading: '读写中',
    queued: '排队中',
    failed: '失败',
  };
  const label = labelMap[status];
  let title = '';
  if (status === 'failed' && change.errorMessage) {
    title = `失败原因：${change.errorMessage}`;
  } else if (status === 'reading') {
    title = '正在写入/读取磁盘，请稍候';
  } else if (status === 'queued') {
    title = '等待依赖文件先处理完成';
  } else if (status === 'reverted') {
    title = '用户已撤销该文件的 AI 修改';
  } else if (status === 'applied') {
    title = '用户已确认接受该文件的 AI 修改';
  } else {
    title = `文件修改${label}`;
  }
  return { status, label, title };
}

/** §需求8：格式化 token 数为 K 简写（128000 → 128K） */
function formatK(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/** §需求8：估算当前对话的 token 使用情况
 *  返回估算 token 数、context window、百分比。
 *  估算方式：中英混合约 3 字符/token（粗估，阶段2 将引入 tiktoken 精确计数）
 *  仅统计前端 messages 的 content + blocks，不含 system prompt / tool schema（后端占大头） */
function estimateTokenUsage(messages: ChatMessage[], contextWindow: number): { tokens: number; percent: number; contextWindow: number } {
  const totalChars = messages.reduce((sum, m) => {
    const content = m.content || '';
    const blocks = m.blocks?.reduce((s: number, b) => s + (b.type === 'text' ? b.content.length : b.type === 'reasoning' ? b.content.length : 0), 0) || 0;
    return sum + content.length + blocks;
  }, 0);
  if (totalChars === 0) return { tokens: 0, percent: 0, contextWindow };
  const estimatedTokens = Math.ceil(totalChars / 3);
  const percent = Math.min((estimatedTokens / contextWindow) * 100, 100);
  return { tokens: estimatedTokens, percent, contextWindow };
}

function PreparingPlaceholder({
  agentStatus,
  changes = [],
  onOpenDiff,
  tokenUsage,
  onCompact,
  userQuestions,
  onLocateMessage,
  onAcceptChanges,
  onRejectChanges,
}: {
  agentStatus?: { status: string; message: string; stepType?: string } | null;
  changes?: SuggestionChange[];
  onOpenDiff?: (change: SuggestionChange) => void;
  tokenUsage?: { tokens: number; percent: number; contextWindow: number };
  onCompact?: () => void;
  /** §定位提问：当前会话的用户提问列表 */
  userQuestions?: { id: string; content: string }[];
  /** §定位提问：点击某条提问后滚动定位 */
  onLocateMessage?: (id: string) => void;
  /** §接受修改：把所有变更标记为“已应用”（文件已同步到磁盘，仅更新 UI 状态） */
  onAcceptChanges?: (changes: SuggestionChange[]) => void;
  /** §拒绝修改：撤销所有变更（后端调用 lifeAiCode.applyChanges 写回 original） */
  onRejectChanges?: (changes: SuggestionChange[]) => void;
}) {
  const isDone = agentStatus?.status === 'done';
  const [showChanges, setShowChanges] = useState(false);
  // §定位提问 Dropdown
  const [showQuestionNav, setShowQuestionNav] = useState(false);
  const questionNavRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showQuestionNav) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (questionNavRef.current && !questionNavRef.current.contains(e.target as Node)) {
        setShowQuestionNav(false);
      }
    };
    // §iframe 失焦兜底：webview 在 iframe 内，点击 IDE 区域不触发 mousedown
    const handleBlur = () => setShowQuestionNav(false);
    document.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('blur', handleBlur);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('blur', handleBlur);
    };
  }, [showQuestionNav]);
  // §变更文件 批量接受/拒绝：仅作用于未结束的项（未 reverted / 未 applied）
  // 避免重复点同一动作造成消息反复。
  const pendingChanges = useMemo(
    () => changes.filter((c) => c.status !== 'reverted' && c.status !== 'applied'),
    [changes],
  );
  const handleAcceptAll = () => {
    if (!onAcceptChanges || pendingChanges.length === 0) return;
    onAcceptChanges(pendingChanges);
  };
  const handleRejectAll = () => {
    if (!onRejectChanges || pendingChanges.length === 0) return;
    onRejectChanges(pendingChanges);
  };
  const { Icon, text, variant } = resolveStatusVariant(isDone ? 'done' : agentStatus?.stepType, agentStatus?.message);
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
      {tokenUsage && tokenUsage.tokens > 0 && (
        <span className="status-card__token" title={`上下文 Token 使用率（估算）\n当前: ${tokenUsage.tokens.toLocaleString()} / ${tokenUsage.contextWindow.toLocaleString()}\n占比: ${tokenUsage.percent.toFixed(1)}%`}>
          Token {formatK(tokenUsage.tokens)}/{formatK(tokenUsage.contextWindow)}
          <span className={`status-card__token-percent ${tokenUsage.percent > 80 ? 'status-card__token-percent--high' : ''}`}>
            {tokenUsage.percent.toFixed(0)}%
          </span>
          {onCompact && (
            <button
              className="status-card__compact-btn"
              onClick={onCompact}
              title="压缩上下文：生成历史摘要替换早期消息"
            >
              <Archive size={11} strokeWidth={1.8} />
            </button>
          )}
        </span>
      )}
      {!isDone && (
        <span className="status-card__dots">
          <span /><span /><span />
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
              const tag = resolveChangeStatus(change, { isProcessing: agentStatus?.status === 'running' });
              return (
                <button
                  key={idx}
                  className={`status-changes-popup__item status-changes-popup__item--${tag.status}`}
                  onClick={() => { onOpenDiff?.(change); setShowChanges(false); }}
                  title={change.filePath}
                >
                  <span className="status-changes-popup__file">{fileName}</span>
                  <span className="status-changes-popup__path">{change.filePath}</span>
                  <span className="status-changes-popup__stats">
                    {stats.added > 0 && <span className="status-changes-popup__added">+{stats.added}</span>}
                    {stats.removed > 0 && <span className="status-changes-popup__removed">-{stats.removed}</span>}
                  </span>
                  {/* §变更文件状态标签：已完成/已撤销/读写中/排队中/失败 */}
                  <span
                    className={`status-tag status-tag--${tag.status}`}
                    title={tag.title}
                    data-status={tag.status}
                  >
                    {tag.status === 'reading' && <span className="status-tag__dot" aria-hidden="true" />}
                    {tag.label}
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
