import { useState, useRef, useEffect, useCallback } from 'react';
import type { ChatMessage, Suggestion, CodeContext, WebViewRequest, ExtensionMessage, LlmConfig } from '../types';
import { PROVIDER_META, getConnectionStatusColor } from '../types';
import { SuggestionList } from './SuggestionList';
import { ContentBlocks } from './ContentBlocks';
import { ShieldCheck } from 'lucide-react';

function getVsCodeApi() {
  if (typeof window !== 'undefined' && window.acquireVsCodeApi) {
    return window.acquireVsCodeApi();
  }
  return null;
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
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
  const [showConfigPicker, setShowConfigPicker] = useState(false);
  const [history, setHistory] = useState<ChatHistoryItem[]>(loadHistory);
  const [showHistory, setShowHistory] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
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

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

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
          setMessages((prev) => {
            const existing = prev.find((m) => m.id === msg.id);
            if (existing) {
              return prev.map((m) =>
                m.id === msg.id ? { ...m, content: msg.content, streaming: !msg.done } : m
              );
            }
            return [...prev, {
              id: msg.id, role: 'assistant', content: msg.content,
              timestamp: Date.now(), streaming: !msg.done,
            }];
          });
          setIsProcessing(!msg.done);
          break;
        }
        case 'suggestions': {
          setMessages((prev) => {
            const lastMsg = prev[prev.length - 1];
            if (lastMsg && lastMsg.role === 'assistant') {
              return prev.map((m, i) =>
                i === prev.length - 1 ? { ...m, suggestions: msg.suggestions, streaming: false } : m
              );
            }
            return prev;
          });
          // 全局自动接受/拒绝开关
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
            if (prevMessages.length > 0) {
              const item: ChatHistoryItem = {
                id: `chat-${Date.now()}`,
                title: historyTitle(prevMessages),
                timestamp: Date.now(),
                messages: [...prevMessages],
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
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onOpenConfig]);

  // 新开对话：保存当前对话到历史，然后清空
  const newChat = useCallback(() => {
    if (messages.length > 0) {
      const item: ChatHistoryItem = {
        id: `chat-${Date.now()}`,
        title: historyTitle(messages),
        timestamp: Date.now(),
        messages: [...messages],
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
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsProcessing(true);

    if (!vscode) {
      setTimeout(() => {
        setMessages((prev) => [...prev, {
          id: generateId(), role: 'assistant',
          content: '> ⚠️ AI 服务需要通过 Extension Host 连接。\n\n请在 IDEACODE 中运行此扩展以获得完整的 AI 辅助功能。',
          timestamp: Date.now(),
        }]);
        setIsProcessing(false);
      }, 500);
      return;
    }

    vscode.postMessage({ command: 'sendMessage', text: text.trim(), context } as WebViewRequest);
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

  return (
    <div className={`lifeAiCode-panel ${isPopup ? 'lifeAiCode-panel--popup' : ''}`}>
      {/* 顶部标题栏由 IDE extension-view__header 提供，WebView 不再渲染自己的 header */}
      <div className="messages-container">
        {messages.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state__icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.3">
                <circle cx="12" cy="12" r="10"/>
                <path d="M12 6v6l4 2"/>
              </svg>
            </div>
            <div className="empty-state__text">{aiEditMode ? '编辑模式' : '只读模式'}</div>
            <div className="empty-state__hint">
              {aiEditMode
                ? '编辑模式 — AI 可以直接修改当前文件代码，请确认后再使用。'
                : '只读模式 — AI 分析代码并提供建议，不会直接修改你的代码。'}
            </div>
            {!activeConfig?.verified && (
              <div className="empty-state__action">
                <button className="kc-btn" onClick={onOpenConfig}>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="6" cy="6" r="4.5"/>
                    <path d="M6 3.5v5M3.5 6h5"/>
                  </svg>
                  配置 AI 服务商
                </button>
              </div>
            )}
          </div>
        ) : (
          messages.map((msg, idx) => (
            <div key={msg.id} className={`message-row message-row--${msg.role}`}>
              <div className="message-content">
                <div className="message-bubble">
                  <ContentBlocks content={msg.content} />
                  {msg.streaming && (
                    <div className="typing-indicator"><span /><span /><span /></div>
                  )}
                </div>
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
          ))
        )}

        {error && <div className="error-message">⚠️ {error}</div>}
        <div ref={messagesEndRef} />
      </div>

      {/* 输入区 — KILO CODE 风格卡片式输入框 */}
      <div className="chat-input-bar">
        <div className="chat-input-wrapper">
          <textarea
            ref={inputRef}
            className="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入消息... (Enter 发送，Shift+Enter 换行)"
            disabled={isProcessing}
            rows={1}
          />
          <div className="chat-input-toolbar">
            <div className="chat-input-tags">
              {fileName && (
                <button className="input-tag-btn input-tag-btn--file" title={contextFile}>
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor">
                    <path d="M2 1.5A.5.5 0 012.5 1h4.586a.5.5 0 01.353.146l2.415 2.415a.5.5 0 01.146.353V10.5a.5.5 0 01-.5.5h-7a.5.5 0 01-.5-.5v-9z"/>
                  </svg>
                  Code
                  <svg width="8" height="8" viewBox="0 0 10 10" fill="currentColor" className="input-tag-btn__arrow">
                    <path d="M2 3l3 4 3-4z" />
                  </svg>
                </button>
              )}
              {/* 配置选择器 — 底部模型下拉 */}
              <div className="kc-config-selector kc-config-selector--inline" ref={configPickerRef}>
                <button
                  className="input-tag-btn input-tag-btn--model"
                  title={activeConfig ? `${activeMeta?.label || '未知'}: ${activeConfig.model || activeConfig.name}` : '未配置'}
                  onClick={() => setShowConfigPicker(!showConfigPicker)}
                >
                  <span className="kc-config-indicator" style={{
                    background: getConnectionStatusColor(activeConfig?.connectionStatus),
                  }} />
                  {activeMeta?.label || '未配置'}
                  {activeConfig?.model && ` / ${activeConfig.model}`}
                  <svg width="8" height="8" viewBox="0 0 10 10" fill="currentColor" className="input-tag-btn__arrow">
                    <path d="M2 3l3 4 3-4z" />
                  </svg>
                </button>

                {showConfigPicker && (
                  <div className="kc-config-dropdown kc-config-dropdown--up">
                    {configs.map((cfg) => {
                      const m = PROVIDER_META[cfg.provider];
                      return (
                        <button
                          key={cfg.id}
                          className={`kc-config-option ${cfg.id === activeConfig?.id ? 'kc-config-option--active' : ''}`}
                          onClick={() => { onSwitchConfig(cfg.id); setShowConfigPicker(false); }}
                        >
                          <span className="kc-config-option__indicator" style={{ background: getConnectionStatusColor(cfg.connectionStatus) }} />
                          <span className="kc-config-option__name">{cfg.name || m?.label || cfg.provider}</span>
                          <span className="kc-config-option__model">{cfg.model}</span>
                          {cfg.verified && <span className="kc-config-option__check">✓</span>}
                        </button>
                      );
                    })}
                    {configs.length === 0 && (
                      <div className="kc-config-empty">暂无配置</div>
                    )}
                    <div className="kc-config-divider" />
                    <button className="kc-config-manage" onClick={() => { setShowConfigPicker(false); onOpenConfig(); }}>
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                        <path d="M6 0a.5.5 0 01.5.5V5h4.5a.5.5 0 010 1H6.5v4.5a.5.5 0 01-1 0V6H1a.5.5 0 010-1h4.5V.5A.5.5 0 016 0z"/>
                      </svg>
                      管理配置
                    </button>
                  </div>
                )}
              </div>
            </div>
            <div className="chat-input-actions">
              <button
                className={`kc-icon-btn kc-icon-btn--tool ${autoAccept ? 'kc-icon-btn--active' : ''}`}
                title={autoAccept ? '自动全部接受建议' : '自动全部拒绝建议'}
                onClick={() => setAutoAccept(!autoAccept)}
              >
                <ShieldCheck size={14} strokeWidth={1.5} />
              </button>
              <button
                className="kc-icon-btn kc-icon-btn--tool"
                title="添加上下文"
                disabled={!fileName}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M7 2v10M2 7h10"/>
                </svg>
              </button>
              <button
                className="kc-icon-btn kc-icon-btn--tool"
                title="复制输入内容"
                onClick={() => { navigator.clipboard.writeText(input).catch(() => {}); }}
                disabled={!input}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="3" y="3" width="7" height="7" rx="1"/>
                  <path d="M10 1h2a1 1 0 011 1v2"/>
                </svg>
              </button>
              <button
                className="kc-send-btn"
                onClick={() => sendMessage(input)}
                disabled={!input.trim() || isProcessing}
                title="发送"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                  <path d="M1.61 1.12a.5.5 0 01.53.07l10 7a.5.5 0 010 .82l-10 7A.5.5 0 011.5 15V1a.5.5 0 01.11-.88z"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
