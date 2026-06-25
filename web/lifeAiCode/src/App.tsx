import { useState, useEffect, useCallback, useMemo } from 'react';
import { ChatPanel } from './components/ChatPanel';
import { ConfigPanel } from './components/ConfigPanel';
import type { CodeContext, ExtensionMessage, LlmConfig } from './types';

type View = 'chat' | 'config';

function getVsCodeApi() {
  if (typeof window !== 'undefined' && window.acquireVsCodeApi) return window.acquireVsCodeApi();
  return null;
}

function App() {
  const [view, setView] = useState<View>('chat');
  const [initialContext, setInitialContext] = useState<CodeContext | undefined>(undefined);
  const [configs, setConfigs] = useState<LlmConfig[]>([]);
  const [activeConfigId, setActiveConfigId] = useState<string>('');
  const [configReady, setConfigReady] = useState(false);
  const vscode = useMemo(() => getVsCodeApi(), []);

  useEffect(() => {
    const popupData = (window as unknown as { __lifeAiCodePopupData?: CodeContext }).__lifeAiCodePopupData;
    if (popupData) setInitialContext(popupData);
  }, []);

  // 监听 Extension Host 发来的配置
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as ExtensionMessage;
      if (msg?.type === 'configLoaded') {
        setConfigs(msg.configs || []);
        setActiveConfigId(msg.activeId || '');
        setConfigReady(true);
      }
      if (msg?.type === 'openConfig') {
        setView('config');
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // 启动后向 Extension Host 请求配置
  useEffect(() => {
    if (!vscode) {
      setConfigReady(true);
      return;
    }
    vscode.postMessage({ command: 'requestConfig' });
    // 3 秒兜底：Extension Host 未响应时强制进入主界面，避免黑屏
    const timeout = setTimeout(() => {
      setConfigReady((prev) => prev ? prev : true);
    }, 3000);
    return () => clearTimeout(timeout);
  }, [vscode]);

  const activeConfig = configs.find((c) => c.id === activeConfigId) || configs[0] || null;

  const handleConfigsChange = useCallback((newConfigs: LlmConfig[], newActiveId?: string) => {
    setConfigs(newConfigs);

    const nextActiveId = newActiveId
      || (newConfigs.find((c) => c.id === activeConfigId) ? activeConfigId : newConfigs[0]?.id)
      || '';

    if (nextActiveId !== activeConfigId) {
      setActiveConfigId(nextActiveId);
    }

    // 同步到 Extension Host
    const active = newConfigs.find((c) => c.id === nextActiveId);
    if (active && vscode) {
      vscode.postMessage({ command: 'configure', config: active });
    }
  }, [activeConfigId, vscode]);

  const handleSwitchConfig = useCallback((id: string) => {
    setActiveConfigId(id);
    if (vscode) {
      vscode.postMessage({ command: 'switchConfig', configId: id });
    }
  }, [vscode]);

  if (!configReady) {
    return (
      <div className="lifeAiCode-root">
        <div className="empty-state">
          <div className="empty-state__text">加载配置中…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="lifeAiCode-root">
      {view === 'chat' ? (
        <ChatPanel
          initialContext={initialContext}
          isPopup={!!initialContext}
          activeConfig={activeConfig}
          configs={configs}
          onSwitchConfig={handleSwitchConfig}
          onOpenConfig={() => setView('config')}
        />
      ) : (
        <ConfigPanel
          configs={configs}
          activeConfigId={activeConfigId}
          onConfigsChange={handleConfigsChange}
          onSwitchConfig={handleSwitchConfig}
          onBack={() => setView('chat')}
        />
      )}
    </div>
  );
}

export default App;
