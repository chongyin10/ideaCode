import { useState, useRef, useEffect, useCallback } from 'react';
import type { ChatMessage, Suggestion, CodeContext, WebViewRequest, ExtensionMessage, LlmConfig } from '../types';
import { PROVIDER_META, getConnectionStatusColor } from '../types';
import { SuggestionList } from './SuggestionList';
import { ContentBlocks } from './ContentBlocks';
import { ShieldCheck, Brain, ArrowDown, User, Sparkles, Paperclip, Send, MessageSquare, Loader2 } from 'lucide-react';

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

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  const now = new Date();
  const isToday = d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  if (isToday) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
  }, [messages, userScrolledUp]);

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
          const finalContent = msg.done ? finalizeSteps(msg.content) : msg.content;
          setMessages((prev) => {
            // AI 真正开始返回时，移除所有占位消息
            const noPlaceholder = prev.filter((m) => !m.placeholder);
            const existing = noPlaceholder.find((m) => m.id === msg.id);
            if (existing) {
              return noPlaceholder.map((m) =>
                m.id === msg.id ? { ...m, content: finalContent, streaming: !msg.done } : m
              );
            }
            return [...noPlaceholder, {
              id: msg.id, role: 'assistant', content: finalContent,
              timestamp: Date.now(), streaming: !msg.done,
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
          setShellOutputs((prev) => ({
            ...prev,
            [msg.id]: { output: msg.output, status: msg.status },
          }));
          break;
        }
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onOpenConfig, autoAccept]);

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
    };
    setMessages((prev) => [...prev, userMsg, placeholderMsg]);
    setInput('');
    setIsProcessing(true);

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

    vscode.postMessage({ command: 'sendMessage', text: text.trim(), context, thinkingEnabled } as WebViewRequest);
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
        vscode.postMessage({ command: 'sendMessage', text: lastUserMsg.content, context, thinkingEnabled } as WebViewRequest);
      }
    }
  };

  return (
    <div className={`lifeAiCode-panel ${isPopup ? 'lifeAiCode-panel--popup' : ''}`}>
      <div className="messages-container" ref={messagesContainerRef}>
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
          messages.map((msg) => {
            // 占位消息：渲染独立的"准备中"提示
            if (msg.placeholder) {
              return <PreparingPlaceholder key={msg.id} />;
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
                className="input-send"
                onClick={() => sendMessage(input)}
                disabled={!input.trim() || isProcessing}
                title="发送"
              >
                <Send size={15} strokeWidth={2} />
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
    <div className="message-row message-row--assistant">
      <div className="message-inner">
        <div className="message-avatar message-avatar--assistant preparing-avatar">
          <Sparkles size={16} strokeWidth={2} />
        </div>
        <div className="message-body">
          <div className="preparing-placeholder">
            <span className="preparing-placeholder__icon">
              <Loader2 size={13} strokeWidth={2.4} />
            </span>
            <span className="preparing-placeholder__text">正在准备回复</span>
            <span className="preparing-placeholder__dots">
              <span /><span /><span />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
