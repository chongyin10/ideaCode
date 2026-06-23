import { useState, useEffect, useCallback, useRef } from 'react';
import type { LlmConfig, ProviderType } from '../types';
import { PROVIDER_META, defaultLlmConfig, getConnectionStatusColor, getConnectionStatusText } from '../types';

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

export function ConfigPanel({ configs, activeConfigId, onConfigsChange, onSwitchConfig, onBack }: ConfigPanelProps) {
  const [editing, setEditing] = useState<LlmConfig | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [customModelInput, setCustomModelInput] = useState('');
  const [testResult, setTestResult] = useState<{ success: boolean; message: string; configId: string } | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [customModels, setCustomModels] = useState<string[]>([]);
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
  };

  const startEdit = (cfg: LlmConfig) => {
    setEditing({ ...cfg });
    setIsNew(false);
    setTestResult(null);
    setCustomModels([]);
  };

  const cancelEdit = () => {
    setEditing(null);
    setCustomModelInput('');
    setCustomModels([]);
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
      newConfigs = configs.map((c) => c.id === updated.id ? updated : c);
    }
    onConfigsChange(newConfigs, isNew ? updated.id : undefined);
    setEditing(null);
    setCustomModelInput('');
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
    if (!editing) return;
    setEditing({ ...editing, ...partial });
  }, [editing]);

  const editingMeta = editing ? PROVIDER_META[editing.provider] || PROVIDER_META.openai : null;

  // ── 编辑表单 ──
  if (editing) {
    return (
      <div className="config-panel">
        <div className="config-panel__header">
          <button className="kc-icon-btn kc-back-btn" onClick={cancelEdit}>
            <svg width="14" height="14" viewBox="0 0 10 10" fill="currentColor">
              <path d="M7 1L3 5l4 4"/>
            </svg>
          </button>
          <h3 className="config-panel__title">{isNew ? '添加配置' : '编辑配置'}</h3>
        </div>

        {/* 名称 */}
        <div className="config-section">
          <label className="config-label">名称</label>
          <input className="config-input" type="text" value={editing.name}
            onChange={(e) => updateEditing({ name: e.target.value })}
            placeholder={editingMeta?.label || '配置名称'} />
        </div>

        {/* Provider */}
        <div className="config-section">
          <label className="config-label">服务商</label>
          <div className="provider-grid">
            {(Object.entries(PROVIDER_META) as [ProviderType, typeof PROVIDER_META[ProviderType]][]).map(([key, m]) => (
              <button key={key}
                className={`provider-card ${editing.provider === key ? 'provider-card--active' : ''}`}
                onClick={() => updateEditing({ provider: key, model: m.defaultModel, baseUrl: m.baseUrl, verified: false, connectionStatus: 'idle' })}>
                <span className="provider-card__name">{m.label}</span>
                <span className="provider-card__desc">{m.icon} {m.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Base URL（ollama 不需要） */}
        {editing.provider !== 'ollama' && (
          <div className="config-section">
            <label className="config-label">基础 URL</label>
            <input className="config-input config-input--mono" type="text" value={editing.baseUrl}
              onChange={(e) => updateEditing({ baseUrl: e.target.value, verified: false, connectionStatus: 'idle' })}
              placeholder={editingMeta?.baseUrl || 'https://api.example.com/v1'} />
          </div>
        )}

        {/* API Key */}
        {editing.provider !== 'ollama' && (
          <div className="config-section">
            <label className="config-label">
              API Key
              {editingMeta?.docsUrl && (
                <a className="config-link" href={editingMeta.docsUrl} target="_blank" rel="noreferrer">
                  获取 Key ↗
                </a>
              )}
            </label>
            <div className="config-input-wrap">
              <input className="config-input config-input--mono" type="password" value={editing.apiKey}
                onChange={(e) => updateEditing({ apiKey: e.target.value, verified: false, connectionStatus: 'idle' })}
                placeholder={editingMeta?.placeholder || 'API Key'} />
              <button className="config-input-toggle" onClick={(e) => {
                const inp = (e.target as HTMLElement).previousElementSibling as HTMLInputElement;
                inp.type = inp.type === 'password' ? 'text' : 'password';
              }}>👁</button>
            </div>
          </div>
        )}

        {editing.provider === 'ollama' && (
          <div className="config-section config-hint">
            <span className="config-hint__icon">🦙</span>
            <span>Ollama 本地运行无需 API Key，确保 <code>http://localhost:11434</code> 可访问。</span>
          </div>
        )}

          {/* 模型 */}
          <div className="config-section">
            <label className="config-label">模型</label>
            <div className="model-chips">
              {/* 预置模型列表 */}
              {editingMeta && editingMeta.models.map((m) => (
                <button key={m}
                  className={`model-chip ${editing.model === m ? 'model-chip--active' : ''}`}
                  onClick={() => updateEditing({ model: m, verified: false, connectionStatus: 'idle' })}>{m}</button>
              ))}
              {/* 自定义模型列表（带删除图标） */}
              {customModels.map((m) => (
                <span key={m} className="model-chip model-chip--custom">
                  <span className="model-chip__label" onClick={() => updateEditing({ model: m, verified: false, connectionStatus: 'idle' })}>{m}</span>
                  <button className="model-chip__del"
                    onClick={(e) => {
                      e.stopPropagation();
                      const next = customModels.filter((x) => x !== m);
                      setCustomModels(next);
                      if (editing?.model === m) {
                        updateEditing({ model: editingMeta?.defaultModel || '' });
                      }
                    }}
                    title="删除">✕</button>
                </span>
              ))}
            </div>
            <div className="config-input-row">
              <input className="config-input config-input--small" type="text" value={customModelInput}
                onChange={(e) => setCustomModelInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { const t = customModelInput.trim(); if (t) { setCustomModels((prev) => prev.includes(t) ? prev : [...prev, t]); updateEditing({ model: t, verified: false, connectionStatus: 'idle' }); setCustomModelInput(''); } }}}
                placeholder="自定义模型名，回车添加" />
              <button className="config-btn config-btn--secondary" onClick={() => {
                const t = customModelInput.trim();
                if (t) {
                  setCustomModels((prev) => prev.includes(t) ? prev : [...prev, t]);
                  updateEditing({ model: t, verified: false, connectionStatus: 'idle' });
                  setCustomModelInput('');
                }
              }}>添加</button>
            </div>
          </div>

        {/* 测试结果 */}
        {testResult && (
          <div className={`config-test-result ${testResult.success ? 'config-test-result--success' : 'config-test-result--fail'}`}>
            <span>{testResult.success ? '✓' : '✕'}</span>
            <span>{testResult.message}</span>
          </div>
        )}

        {/* 操作 */}
        <div className="config-section config-actions-bar">
          <button className="config-btn config-btn--primary" onClick={saveEdit}>
            {isNew ? '添加' : '保存'}
          </button>
          <button className="config-btn" onClick={cancelEdit}>取消</button>
          <button className="config-btn config-btn--secondary" onClick={() => testConnection(editing)} disabled={testingId === editing.id}>
            {testingId === editing.id ? '测试中…' : '测试'}
          </button>
        </div>
      </div>
    );
  }

  // ── 配置列表 ──
  return (
    <div className="config-panel">
      {onBack && (
        <button className="kc-back-btn kc-icon-btn" onClick={onBack} title="返回对话">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M10 12L4 7l6-5" />
          </svg>
        </button>
      )}
      <div className="config-panel__header config-panel__header--row">
        <div>
          <h3 className="config-panel__title">AI 配置</h3>
          <span className="config-panel__subtitle">{configs.length} 个配置</span>
        </div>
        <button className="config-btn config-btn--primary" onClick={startNew}>+ 添加</button>
      </div>

      {configs.length === 0 ? (
        <div className="config-empty-state">
          <div className="config-empty-state__icon">⚙</div>
          <div className="config-empty-state__text">暂无配置</div>
          <div className="config-empty-state__hint">添加一个 AI 服务商配置开始使用</div>
          <button className="config-btn config-btn--primary" onClick={startNew} style={{ marginTop: 12 }}>+ 添加配置</button>
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
              <div key={cfg.id} className={`config-card ${isActive ? 'config-card--active' : ''}`}>
                <div className="config-card__main" onClick={() => setExpandedId(isExpanded ? null : cfg.id)}>
                  <span className="config-card__indicator" style={{ background: statusColor }} title={statusText} />
                  <div className="config-card__info">
                    <div className="config-card__name">
                      {cfg.name || meta.label}
                      {cfg.verified && <span className="config-card__verified" title="已验证">✓</span>}
                    </div>
                    <div className="config-card__meta">
                      {meta.label} · {cfg.model || meta.defaultModel}
                    </div>
                  </div>
                  <div className="config-card__actions" onClick={(e) => e.stopPropagation()}>
                    {!isActive && (
                      <button className="config-card__action" onClick={() => onSwitchConfig(cfg.id)}
                        title="切换到此配置">
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <path d="M2 7h10M8 3l4 4-4 4"/>
                        </svg>
                      </button>
                    )}
                    {isActive && <span className="config-card__active-badge">当前</span>}
                    <button className="config-card__action" onClick={() => testConnection(cfg)}
                      disabled={testingId === cfg.id} title="测试连接">
                      {testingId === cfg.id ? '…' :
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <path d="M7 1v2M7 11v2M1 7h2M11 7h2M3.5 3.5l1.5 1.5M9 9l1.5 1.5M10.5 3.5L9 5M5 9l-1.5 1.5"/>
                        </svg>
                      }
                    </button>
                  </div>
                </div>

                {/* 展开详情 */}
                {isExpanded && (
                  <div className="config-card__detail">
                    <div className="config-card__detail-row">
                      <span className="config-card__detail-label">提供商</span>
                      <span>{meta.label}</span>
                    </div>
                    <div className="config-card__detail-row">
                      <span className="config-card__detail-label">模型</span>
                      <span>{cfg.model || meta.defaultModel}</span>
                    </div>
                    <div className="config-card__detail-row">
                      <span className="config-card__detail-label">API Key</span>
                      <span className="config-card__detail-mono">{cfg.apiKey ? cfg.apiKey.slice(0, 12) + '…' : '未设置'}</span>
                    </div>
                    {cfg.baseUrl && (
                      <div className="config-card__detail-row">
                        <span className="config-card__detail-label">Base URL</span>
                        <span className="config-card__detail-mono">{cfg.baseUrl}</span>
                      </div>
                    )}
                    <div className="config-card__detail-row">
                      <span className="config-card__detail-label">状态</span>
                      <span className={
                        cfg.connectionStatus === 'success' ? 'c-green' :
                        cfg.connectionStatus === 'error' ? 'c-red' :
                        cfg.connectionStatus === 'testing' ? 'c-yellow' : 'c-muted'
                      }>
                        {statusText}
                      </span>
                    </div>

                    {/* 测试结果 */}
                    {testResult && testResult.configId === cfg.id && (
                      <div className={`config-test-result config-test-result--inline ${testResult.success ? 'config-test-result--success' : 'config-test-result--fail'}`}>
                        <span>{testResult.success ? '✓' : '✕'}</span>
                        <span>{testResult.message}</span>
                      </div>
                    )}

                    <div className="config-card__detail-actions">
                      <button className="config-btn" onClick={() => startEdit(cfg)}>编辑</button>
                      <button className="config-btn config-btn--secondary" onClick={() => deleteConfig(cfg.id)}>删除</button>
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
