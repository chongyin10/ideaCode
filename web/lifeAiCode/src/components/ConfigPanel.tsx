import { useState, useEffect, useCallback, useRef } from 'react';
import {
  ArrowLeft, Plus, Trash2, Edit3, Check, X, Loader2,
  Power, Eye, EyeOff, FlaskConical, Save, Sparkles, Settings, Globe,
} from 'lucide-react';
import type { LlmConfig, ProviderType } from '../types';
import {
  PROVIDER_META, defaultLlmConfig,
  getConnectionStatusColor, getConnectionStatusText,
} from '../types';

interface ConfigPanelProps {
  configs: LlmConfig[];
  activeConfigId: string;
  onConfigsChange: (configs: LlmConfig[], newActiveId?: string) => void;
  onSwitchConfig: (id: string) => void;
  onBack?: () => void;
}

function getVsCodeApi() {
  if (typeof window !== 'undefined' && window.acquireVsCodeApi) return window.acquireVsCodeApi();
  return null;
}

export function ConfigPanel({
  configs, activeConfigId, onConfigsChange, onSwitchConfig, onBack,
}: ConfigPanelProps) {
  const [editing, setEditing] = useState<LlmConfig | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [customModelInput, setCustomModelInput] = useState('');
  const [testResult, setTestResult] = useState<{ success: boolean; message: string; configId: string } | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [customModels, setCustomModels] = useState<string[]>([]);
  const [showApiKey, setShowApiKey] = useState(false);
  const vscode = getVsCodeApi();

  const configsRef = useRef(configs);
  const onConfigsChangeRef = useRef(onConfigsChange);
  configsRef.current = configs;
  onConfigsChangeRef.current = onConfigsChange;

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg?.type === 'connectionTestResult') {
        setTestingId(null);
        const status: LlmConfig['connectionStatus'] = msg.success ? 'success' : 'error';
        setTestResult({ success: msg.success, message: msg.message, configId: msg.configId || '' });
        const next = configsRef.current.map((c) =>
          c.id === msg.configId ? { ...c, verified: msg.success, connectionStatus: status } : c
        );
        onConfigsChangeRef.current(next);
        setEditing((prev) =>
          prev && prev.id === msg.configId
            ? { ...prev, verified: msg.success, connectionStatus: status }
            : prev
        );
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const startNew = () => {
    setEditing(defaultLlmConfig());
    setIsNew(true);
    setTestResult(null);
    setCustomModels([]);
    setShowApiKey(false);
  };

  const startEdit = (cfg: LlmConfig) => {
    setEditing({ ...cfg });
    setIsNew(false);
    setTestResult(null);
    setCustomModels([]);
    setShowApiKey(false);
  };

  const cancelEdit = () => {
    setEditing(null);
    setCustomModelInput('');
    setCustomModels([]);
    setShowApiKey(false);
    setTestResult(null);
  };

  const saveEdit = () => {
    if (!editing) return;
    const name = editing.name.trim() || PROVIDER_META[editing.provider]?.label || editing.provider;
    const model = editing.model || PROVIDER_META[editing.provider]?.defaultModel || 'gpt-4o';
    const baseUrl = editing.baseUrl.trim() || PROVIDER_META[editing.provider]?.baseUrl || '';
    const updated = { ...editing, name, model, baseUrl };

    let newConfigs: LlmConfig[];
    if (isNew) {
      newConfigs = [...configs, updated];
    } else {
      newConfigs = configs.map((c) => (c.id === updated.id ? updated : c));
    }
    onConfigsChange(newConfigs, isNew ? updated.id : undefined);
    setEditing(null);
    setCustomModelInput('');
    setShowApiKey(false);
  };

  const deleteConfig = (id: string) => {
    const newConfigs = configs.filter((c) => c.id !== id);
    const newActive = id === activeConfigId ? newConfigs[0]?.id : undefined;
    onConfigsChange(newConfigs, newActive);
    if (expandedId === id) setExpandedId(null);
  };

  const testConnection = (cfg: LlmConfig) => {
    setTestingId(cfg.id);
    setTestResult(null);
    onConfigsChange(configs.map((c) =>
      c.id === cfg.id ? { ...c, connectionStatus: 'testing' } : c
    ));
    setEditing((prev) =>
      prev && prev.id === cfg.id ? { ...prev, connectionStatus: 'testing' } : prev
    );
    if (vscode) {
      vscode.postMessage({ command: 'testConnection', config: cfg });
    } else {
      setTimeout(() => {
        setTestingId(null);
        const status: LlmConfig['connectionStatus'] = 'error';
        setTestResult({ success: false, message: 'Extension Host 未连接', configId: cfg.id });
        onConfigsChange(configs.map((c) =>
          c.id === cfg.id ? { ...c, verified: false, connectionStatus: status } : c
        ));
        setEditing((prev) =>
          prev && prev.id === cfg.id
            ? { ...prev, verified: false, connectionStatus: status }
            : prev
        );
      }, 500);
    }
  };

  const updateEditing = useCallback((partial: Partial<LlmConfig>) => {
    setEditing((prev) => prev ? { ...prev, ...partial } : prev);
  }, []);

  const handleAddCustomModel = () => {
    const t = customModelInput.trim();
    if (!t) return;
    setCustomModels((prev) => (prev.includes(t) ? prev : [...prev, t]));
    updateEditing({ model: t, verified: false, connectionStatus: 'idle' });
    setCustomModelInput('');
  };

  const editingMeta = editing ? PROVIDER_META[editing.provider] || PROVIDER_META.openai : null;

  // ── 编辑表单 ──
  if (editing) {
    return (
      <div className="config-panel">
        <div className="config-panel__header">
          <button className="config-back-btn" onClick={cancelEdit} title="返回">
            <ArrowLeft size={14} strokeWidth={2} />
          </button>
          <h2 className="config-panel__title">
            {isNew ? '添加 AI 配置' : '编辑配置'}
          </h2>
        </div>

        {/* Provider 选择 */}
        <div className="config-section">
          <label className="config-label">服务商</label>
          <div className="provider-grid">
            {(Object.entries(PROVIDER_META) as [ProviderType, typeof PROVIDER_META[ProviderType]][]).map(([key, m]) => (
              <button
                key={key}
                className={`provider-card ${editing.provider === key ? 'provider-card--active' : ''}`}
                onClick={() => updateEditing({
                  provider: key,
                  model: m.defaultModel,
                  baseUrl: m.baseUrl,
                  verified: false,
                  connectionStatus: 'idle',
                })}
                type="button"
              >
                <div className="provider-card__head">
                  <span className="provider-card__name">{m.label}</span>
                  {editing.provider === key && (
                    <Check size={14} strokeWidth={2.5} className="provider-card__check" />
                  )}
                </div>
                <div className="provider-card__desc">{m.placeholder}</div>
              </button>
            ))}
          </div>
        </div>

        {/* 名称 */}
        <div className="config-section">
          <label className="config-label">配置名称（可选）</label>
          <input
            className="config-input"
            type="text"
            value={editing.name}
            onChange={(e) => updateEditing({ name: e.target.value })}
            placeholder={editingMeta?.label || '例如：我的主力模型'}
          />
        </div>

        {/* Base URL */}
        {editing.provider !== 'ollama' && (
          <div className="config-section">
            <label className="config-label">
              <Globe size={11} strokeWidth={2} />
              基础 URL
            </label>
            <input
              className="config-input config-input--mono"
              type="text"
              value={editing.baseUrl}
              onChange={(e) => updateEditing({
                baseUrl: e.target.value,
                verified: false,
                connectionStatus: 'idle',
              })}
              placeholder={editingMeta?.baseUrl || 'https://api.example.com/v1'}
            />
          </div>
        )}

        {/* API Key */}
        {editing.provider !== 'ollama' && (
          <div className="config-section">
            <label className="config-label">
              API Key
              {editingMeta?.docsUrl && (
                <a
                  className="config-link"
                  href={editingMeta.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  获取 Key ↗
                </a>
              )}
            </label>
            <div className="config-input-wrap">
              <input
                className="config-input config-input--mono"
                type={showApiKey ? 'text' : 'password'}
                value={editing.apiKey}
                onChange={(e) => updateEditing({
                  apiKey: e.target.value,
                  verified: false,
                  connectionStatus: 'idle',
                })}
                placeholder={editingMeta?.placeholder || 'sk-...'}
              />
              <button
                className="config-input-toggle"
                onClick={() => setShowApiKey(!showApiKey)}
                title={showApiKey ? '隐藏' : '显示'}
                type="button"
              >
                {showApiKey ? <EyeOff size={13} strokeWidth={2} /> : <Eye size={13} strokeWidth={2} />}
              </button>
            </div>
          </div>
        )}

        {editing.provider === 'ollama' && (
          <div className="config-hint">
            <span className="config-hint__icon">🦙</span>
            <span>Ollama 本地运行无需 API Key，请确保 <code>http://localhost:11434</code> 可访问。</span>
          </div>
        )}

        {/* 模型选择 */}
        <div className="config-section">
          <label className="config-label">模型</label>
          <div className="model-chips">
            {editingMeta && editingMeta.models.map((m) => (
              <button
                key={m}
                type="button"
                className={`model-chip ${editing.model === m ? 'model-chip--active' : ''}`}
                onClick={() => updateEditing({
                  model: m, verified: false, connectionStatus: 'idle',
                })}
              >
                {editing.model === m && <Check size={11} strokeWidth={2.5} />}
                {m}
              </button>
            ))}
            {customModels.map((m) => (
              <span
                key={m}
                className={`model-chip model-chip--custom ${editing.model === m ? 'model-chip--active' : ''}`}
              >
                <span
                  className="model-chip__label"
                  onClick={() => updateEditing({
                    model: m, verified: false, connectionStatus: 'idle',
                  })}
                >
                  {editing.model === m && <Check size={11} strokeWidth={2.5} />}
                  {m}
                </span>
                <button
                  type="button"
                  className="model-chip__del"
                  onClick={() => {
                    setCustomModels((prev) => prev.filter((x) => x !== m));
                    if (editing.model === m) {
                      updateEditing({ model: editingMeta?.defaultModel || '' });
                    }
                  }}
                  title="移除自定义模型"
                >
                  <X size={10} strokeWidth={2.5} />
                </button>
              </span>
            ))}
          </div>
          <div className="config-input-row">
            <input
              className="config-input"
              type="text"
              value={customModelInput}
              onChange={(e) => setCustomModelInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleAddCustomModel(); }}
              placeholder="自定义模型名（如 claude-3.7-sonnet），回车添加"
            />
            <button
              type="button"
              className="config-btn"
              onClick={handleAddCustomModel}
              disabled={!customModelInput.trim()}
            >
              <Plus size={12} strokeWidth={2.5} />
              添加
            </button>
          </div>
        </div>

        {/* 测试结果 */}
        {testResult && (
          <div className={`config-test-result ${testResult.success ? 'config-test-result--success' : 'config-test-result--fail'}`}>
            {testResult.success ? <Check size={14} strokeWidth={2.5} /> : <X size={14} strokeWidth={2.5} />}
            <span>{testResult.message}</span>
          </div>
        )}

        {/* 操作栏 */}
        <div className="config-actions-bar">
          <button
            type="button"
            className="config-btn config-btn--primary"
            onClick={saveEdit}
          >
            <Save size={13} strokeWidth={2} />
            {isNew ? '添加配置' : '保存修改'}
          </button>
          <button
            type="button"
            className="config-btn"
            onClick={() => editing && testConnection(editing)}
            disabled={testingId === editing?.id}
          >
            {testingId === editing?.id ? (
              <Loader2 size={13} strokeWidth={2.5} className="config-spinner" />
            ) : (
              <FlaskConical size={13} strokeWidth={2} />
            )}
            {testingId === editing?.id ? '测试中…' : '测试连接'}
          </button>
          <button type="button" className="config-btn" onClick={cancelEdit}>
            取消
          </button>
        </div>
      </div>
    );
  }

  // ── 配置列表 ──
  return (
    <div className="config-panel">
      {/* 头部 */}
      <div className="config-panel__header">
        {onBack && (
          <button className="config-back-btn" onClick={onBack} title="返回对话">
            <ArrowLeft size={14} strokeWidth={2} />
          </button>
        )}
        <div className="config-panel__title-group">
          <h2 className="config-panel__title">AI 服务商配置</h2>
          <p className="config-panel__subtitle">
            {configs.length === 0
              ? '添加一个 AI 服务商开始使用'
              : `已配置 ${configs.length} 个服务${activeConfigId ? '，当前使用中' : ''}`}
          </p>
        </div>
        {configs.length > 0 && (
          <button type="button" className="config-btn config-btn--primary" onClick={startNew}>
            <Plus size={13} strokeWidth={2.5} />
            添加配置
          </button>
        )}
      </div>

      {/* 列表 / 空状态 */}
      {configs.length === 0 ? (
        <div className="config-empty-state">
          <div className="config-empty-state__logo">
            <Settings size={28} strokeWidth={1.6} />
          </div>
          <div className="config-empty-state__title">还没有 AI 服务商配置</div>
          <div className="config-empty-state__hint">
            选择一个服务商，填入 API Key 即可开始使用
          </div>
          <button type="button" className="config-btn config-btn--primary config-btn--lg" onClick={startNew}>
            <Sparkles size={14} strokeWidth={2} />
            配置 AI 服务商
          </button>
          <div className="config-empty-state__suggestions">
            <span>支持的供应商：</span>
            {(['openai', 'anthropic', 'deepseek', 'qwen', 'glm', 'kimi', 'MiniMax', 'doubao', 'ollama'] as ProviderType[]).map((p) => (
              <span key={p} className="config-empty-state__chip">{PROVIDER_META[p].label}</span>
            ))}
          </div>
        </div>
      ) : (
        <div className="config-list">
          {configs.map((cfg) => {
            const meta = PROVIDER_META[cfg.provider] || PROVIDER_META.openai;
            const isActive = cfg.id === activeConfigId;
            const isExpanded = expandedId === cfg.id;
            const statusColor = getConnectionStatusColor(cfg.connectionStatus);
            const statusText = getConnectionStatusText(cfg.connectionStatus, cfg.verified);

            return (
              <div
                key={cfg.id}
                className={`config-card ${isActive ? 'config-card--active' : ''} ${isExpanded ? 'config-card--expanded' : ''}`}
              >
                <div
                  className="config-card__main"
                  onClick={() => setExpandedId(isExpanded ? null : cfg.id)}
                >
                  <span
                    className="config-card__indicator"
                    style={{ background: statusColor }}
                    title={statusText}
                  />
                  <div className="config-card__info">
                    <div className="config-card__name">
                      {cfg.name || meta.label}
                      {isActive && <span className="config-card__active-badge">使用中</span>}
                    </div>
                    <div className="config-card__meta">
                      {meta.label} · {cfg.model || meta.defaultModel}
                    </div>
                  </div>
                  <div className="config-card__actions" onClick={(e) => e.stopPropagation()}>
                    {!isActive && (
                      <button
                        type="button"
                        className="config-card__action"
                        onClick={() => onSwitchConfig(cfg.id)}
                        title="切换到此配置"
                      >
                        <Power size={14} strokeWidth={2} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="config-card__action"
                      onClick={() => testConnection(cfg)}
                      disabled={testingId === cfg.id}
                      title="测试连接"
                    >
                      {testingId === cfg.id
                        ? <Loader2 size={14} strokeWidth={2} className="config-spinner" />
                        : <FlaskConical size={14} strokeWidth={2} />}
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="config-card__detail">
                    <div className="config-card__detail-row">
                      <span className="config-card__detail-label">服务商</span>
                      <span className="config-card__detail-value">{meta.label}</span>
                    </div>
                    <div className="config-card__detail-row">
                      <span className="config-card__detail-label">模型</span>
                      <span className="config-card__detail-value config-card__detail-mono">
                        {cfg.model || meta.defaultModel}
                      </span>
                    </div>
                    <div className="config-card__detail-row">
                      <span className="config-card__detail-label">API Key</span>
                      <span className="config-card__detail-value config-card__detail-mono">
                        {cfg.apiKey ? cfg.apiKey.slice(0, 8) + '••••' + cfg.apiKey.slice(-4) : '未设置'}
                      </span>
                    </div>
                    {cfg.baseUrl && (
                      <div className="config-card__detail-row">
                        <span className="config-card__detail-label">Base URL</span>
                        <span className="config-card__detail-value config-card__detail-mono">
                          {cfg.baseUrl}
                        </span>
                      </div>
                    )}
                    <div className="config-card__detail-row">
                      <span className="config-card__detail-label">状态</span>
                      <span className={`config-status config-status--${cfg.connectionStatus || 'idle'}`}>
                        <span
                          className="config-status__dot"
                          style={{ background: statusColor }}
                        />
                        {statusText}
                      </span>
                    </div>

                    {testResult && testResult.configId === cfg.id && (
                      <div className={`config-test-result config-test-result--inline ${testResult.success ? 'config-test-result--success' : 'config-test-result--fail'}`}>
                        {testResult.success
                          ? <Check size={13} strokeWidth={2.5} />
                          : <X size={13} strokeWidth={2.5} />}
                        <span>{testResult.message}</span>
                      </div>
                    )}

                    <div className="config-card__detail-actions">
                      <button
                        type="button"
                        className="config-btn"
                        onClick={() => startEdit(cfg)}
                      >
                        <Edit3 size={12} strokeWidth={2} />
                        编辑
                      </button>
                      <button
                        type="button"
                        className="config-btn config-btn--danger"
                        onClick={() => deleteConfig(cfg.id)}
                      >
                        <Trash2 size={12} strokeWidth={2} />
                        删除
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
