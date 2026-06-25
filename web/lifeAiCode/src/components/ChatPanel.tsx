import { useState, useRef, useEffect, useCallback } from 'react';
import type { ChatMessage, CodeContext, WebViewRequest, ExtensionMessage, LlmConfig, ToolCallInfo } from '../types';
import { PROVIDER_META, getConnectionStatusColor } from '../types';
import { SuggestionList } from './SuggestionList';
import { ContentBlocks } from './ContentBlocks';
import { AgentModeToggle } from './agent/AgentModeToggle';
import { AgentStatusBar } from './agent/AgentStatusBar';
import { ToolCallLog } from './agent/ToolCallLog';
import { DiffConfirmDialog } from './agent/DiffConfirmDialog';
import { ShieldCheck, Brain, ArrowDown, User, Sparkles, Paperclip, Send, MessageSquare, Loader2, Check, Square } from 'lucide-react';

/** 预处理：检测并补齐未闭合的 markdown 结构（供 chatResponse 处理时使用） */
function preprocessMarkdown(content: string): { processed: string; incomplete: boolean; reasons: string[] } {
  let result = content;
  const reasons: string[] = [];

  const fenceMatches = content.match(/```/g);
  if (fenceMatches && fenceMatches.length % 2 !== 0) {
    result += '\n\n```';
    reasons.push('代码块未闭合');
  }

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

  return { processed: result.trimEnd(), incomplete: reasons.length > 0, reasons };
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
  onSwitchConfig: (id: string) => void;
  onOpenConfig: () => void;
}

export function ChatPanel({ initialContext, isPopup, activeConfig, configs, onSwitchConfig, onOpenConfig }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [context, setContext] = useState<CodeContext | null>(initialContext || null);
  const [error, setError] = useState<string | null>(null);
  const [aiEditMode, setAiEditMode] = useState(true);
  const [autoAccept, setAutoAccept] = useState(false);
  const [thinkingEnabled, setThinkingEnabled] = useState(true);
  const [showConfigPicker, setShowConfigPicker] = useState(false);
  const [history, setHistory] = useState<ChatHistoryItem[]>(loadHistory);
  const [showHistory, setShowHistory] = useState(false);
  const [shellOutputs, setShellOutputs] = useState<Record<string, { output: string; status: 'running' | 'success' | 'error' }>>({});
  const [notice, setNotice] = useState<{ level: 'info' | 'success' | 'warning' | 'error'; message: string; id: number } | null>(null);
  const [agentMode, setAgentMode] = useState(false);
  const [agentStatus, setAgentStatus] = useState<{ status: string; message: string } | null>(null);
  const [toolCalls, setToolCalls] = useState<ToolCallInfo[]>([]);
  const [pendingAgentEdit, setPendingAgentEdit] = useState<{ editId: string; filePath: string; original: string; modified: string } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const configPickerRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const vscode = getVsCodeApi();

  const activeMeta = activeConfig ? PROVIDER_META[activeConfig.provider] : null;

  // 点击外部关闭下拉面板
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (showConfigPicker && configPickerRef.current && !configPickerRef.current.contains(e.target as Node)) {
        setShowConfigPicker(false);
      }
      if (showHistory && historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setShowHistory(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [showConfigPicker, showHistory]);

  // 自动滚动到底部（仅在用户未主动上滑时即时跟随，避免平滑滚动导致按钮抖动）
  useEffect(() => {
    if (!userScrolledUp) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
    }
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
          if (msg.suggestions.length > 0) {
            setTimeout(() => {
              msg.suggestions.forEach((s) => {
                if (autoAccept) {
                  vscode?.postMessage({ command: 'acceptSuggestion', suggestionId: s.id } as WebViewRequest);
                } else {
                  vscode?.postMessage({ command: 'rejectSuggestion', suggestionId: s.id } as WebViewRequest);
                }
              });
            }, 0);
          }
          setIsProcessing(false);
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
            const realMessages = prevMessages.filter((m) => !m.placeholder);
            if (realMessages.length > 0) {
              const item: ChatHistoryItem = {
                id: `chat-${Date.now()}`,
                title: historyTitle(realMessages),
                timestamp: Date.now(),
                messages: realMessages,
              };
              setHistory((prevHistory) => {
                const updated = [item, ...prevHistory.filter((h) => h.id !== item.id)];
                saveHistory(updated);
                return updated;
              });
            }
            return [];
          });
          setError(null);
          break;
        }
        case 'openConfig': {
          onOpenConfig();
          break;
        }
        case 'showHistory': {
          setShowHistory((prev) => !prev);
          break;
        }
        case 'shellUpdate': {
          console.log('[LifeAiCode WebView] shellUpdate received:', { id: msg.id, status: msg.status, outputLen: msg.output?.length });
          setShellOutputs((prev) => ({
            ...prev,
            [msg.id]: { output: msg.output, status: msg.status },
          }));
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
          setAgentStatus({ status: msg.status, message: msg.message });
          if (msg.status === 'done' || msg.status === 'error' || msg.status === 'cancelled') {
            setIsProcessing(false);
          }
          break;
        }
        case 'toolCall': {
          setToolCalls((prev) => {
            const existingIndex = prev.findIndex((t) => t.tool === msg.tool && JSON.stringify(t.args) === JSON.stringify(msg.args));
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
          setPendingAgentEdit({
            editId: msg.editId,
            filePath: msg.filePath,
            original: msg.original,
            modified: msg.modified,
          });
          break;
        }
        case 'agentEditStatus': {
          if (pendingAgentEdit && pendingAgentEdit.editId === msg.editId) {
            setPendingAgentEdit(null);
          }
          break;
        }
      }
    };

    window.addEventListener('message', handler);
    console.log('[LifeAiCode WebView] message listener attached');
    return () => window.removeEventListener('message', handler);
  }, [onOpenConfig, autoAccept, pendingAgentEdit, vscode]);

  // 新开对话：保存当前对话到历史，然后清空
  const newChat = useCallback(() => {
    const realMessages = messages.filter((m) => !m.placeholder);
    if (realMessages.length > 0) {
      const item: ChatHistoryItem = {
        id: `chat-${Date.now()}`,
        title: historyTitle(realMessages),
        timestamp: Date.now(),
        messages: realMessages,
      };
      const updated = [item, ...history.filter((h) => h.id !== item.id)];
      setHistory(updated);
      saveHistory(updated);
    }
    setMessages([]);
    setError(null);
  }, [messages, history]);

  // 从历史恢复对话
  const restoreHistory = useCallback((item: ChatHistoryItem) => {
    setMessages(item.messages);
    setShowHistory(false);
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
    // 新 Agent 任务开始时清空上一次的执行记录，避免显示到新的占位消息上
    if (agentMode) {
      setAgentStatus(null);
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
      }, 500);
      return;
    }

    vscode.postMessage({ command: 'sendMessage', text: text.trim(), context, thinkingEnabled, agentMode } as WebViewRequest);
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

  const handlePreviewDiff = (suggestionId: string) => {
    if (vscode) vscode.postMessage({ command: 'previewDiff', suggestionId } as WebViewRequest);
  };

  const handleConfirmAgentEdit = () => {
    if (vscode && pendingAgentEdit) {
      vscode.postMessage({ command: 'confirmAgentEdit', editId: pendingAgentEdit.editId } as WebViewRequest);
    }
  };

  const handleRejectAgentEdit = () => {
    if (vscode && pendingAgentEdit) {
      vscode.postMessage({ command: 'rejectAgentEdit', editId: pendingAgentEdit.editId } as WebViewRequest);
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

  const handleRegenerate = () => {
    if (vscode && messages.length >= 2) {
      const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
      if (lastUserMsg) {
        vscode.postMessage({ command: 'sendMessage', text: lastUserMsg.content, context, thinkingEnabled, agentMode } as WebViewRequest);
      }
    }
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
  };

  return (
    <div className={`lifeAiCode-panel ${isPopup ? 'lifeAiCode-panel--popup' : ''}`}>
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
                      <PreparingPlaceholder />
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
                    onCopy={msg.role === 'assistant' ? (text) => navigator.clipboard.writeText(text).catch(() => {}) : undefined}
                    onRegenerate={msg.role === 'assistant' && !msg.streaming ? handleRegenerate : undefined}
                    onContinue={msg.role === 'assistant' && msg.incomplete ? () => handleContinue(msg.id) : undefined}
                    onExecuteShell={(id, shellCommand) => {
                      vscode?.postMessage({ command: 'executeShell', id, shellCommand, cwd: context?.workspaceRoot || '' } as WebViewRequest);
                    }}
                    onOptionClick={(text) => sendMessage(text)}
                  />

                  {/* Suggestions */}
                  {msg.suggestions && msg.suggestions.length > 0 && (
                    <SuggestionList
                      suggestions={msg.suggestions}
                      onAccept={handleAcceptSuggestion}
                      onReject={handleRejectSuggestion}
                      onPreviewDiff={handlePreviewDiff}
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

      {/* Agent 编辑确认弹窗 */}
      {pendingAgentEdit && (
        <DiffConfirmDialog
          filePath={pendingAgentEdit.filePath}
          original={pendingAgentEdit.original}
          modified={pendingAgentEdit.modified}
          onConfirm={handleConfirmAgentEdit}
          onReject={handleRejectAgentEdit}
        />
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
            placeholder="输入消息... (Enter 发送，Shift+Enter 换行)"
            disabled={isProcessing}
            rows={1}
          />
          <div className="input-toolbar">
            <div className="input-tags">
              {fileName && (
                <button className="input-tag" title={contextFile}>
                  <Paperclip size={11} strokeWidth={2} />
                  {fileName}
                </button>
              )}
              {/* Config selector */}
              <div className="kc-config-selector" ref={configPickerRef} style={{ position: 'relative' }}>
                <button
                  className="input-tag input-tag--model"
                  title={activeConfig ? `${activeMeta?.label || '未知'}: ${activeConfig.model || activeConfig.name}` : '未配置'}
                  onClick={() => setShowConfigPicker(!showConfigPicker)}
                >
                  <span className="kc-config-indicator" style={{
                    background: getConnectionStatusColor(activeConfig?.connectionStatus),
                  }} />
                  {activeMeta?.label || '未配置'}
                  {activeConfig?.model && ` / ${activeConfig.model}`}
                </button>

                {showConfigPicker && (
                  <div className="kc-dropdown">
                    {configs.map((cfg) => {
                      const m = PROVIDER_META[cfg.provider];
                      return (
                        <button
                          key={cfg.id}
                          className={`kc-dropdown__item ${cfg.id === activeConfig?.id ? 'kc-dropdown__item--active' : ''}`}
                          onClick={() => { onSwitchConfig(cfg.id); setShowConfigPicker(false); }}
                        >
                          <span className="kc-dropdown__item-title">
                            {cfg.name || m?.label || cfg.provider}
                          </span>
                          <span className="kc-dropdown__item-meta">{cfg.model} · {m?.label}</span>
                        </button>
                      );
                    })}
                    {configs.length === 0 && (
                      <div className="kc-dropdown__header">暂无配置</div>
                    )}
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
              <AgentModeToggle enabled={agentMode} onToggle={() => setAgentMode(!agentMode)} />
              <button
                className={`input-icon-btn ${thinkingEnabled ? 'input-icon-btn--active' : ''}`}
                title={thinkingEnabled ? '思考模式已开启' : '思考模式已关闭'}
                onClick={() => setThinkingEnabled(!thinkingEnabled)}
              >
                <Brain size={15} strokeWidth={1.8} />
              </button>
              <button
                className={`input-icon-btn ${autoAccept ? 'input-icon-btn--active' : ''}`}
                title={autoAccept ? '自动接受已开启' : '自动接受已关闭'}
                onClick={() => setAutoAccept(!autoAccept)}
              >
                <ShieldCheck size={15} strokeWidth={1.8} />
              </button>
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

function PreparingPlaceholder() {
  return (
    <div className="preparing-placeholder">
      <span className="preparing-placeholder__icon">
        <Loader2 size={14} strokeWidth={2.4} />
      </span>
      <span className="preparing-placeholder__text">正在准备回复</span>
      <span className="preparing-placeholder__dots">
        <span /><span /><span />
      </span>
    </div>
  );
}
