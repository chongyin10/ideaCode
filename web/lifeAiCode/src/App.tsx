import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
  const configsRef = useRef(configs);
  configsRef.current = configs;

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
    const nextActiveId = newActiveId
      || (newConfigs.find((c) => c.id === activeConfigId) ? activeConfigId : newConfigs[0]?.id)
      || '';

    if (nextActiveId !== activeConfigId) {
      setActiveConfigId(nextActiveId);
    }
    setConfigs(newConfigs);

    // 同步到 Extension Host：如果只是顺序调整，发送 updateConfigs；否则发送单个 configure
    const active = newConfigs.find((c) => c.id === nextActiveId);
    if (active && vscode) {
      const prevIds = configsRef.current.map((c) => c.id);
      const nextIds = newConfigs.map((c) => c.id);
      const orderChanged = prevIds.length !== nextIds.length || prevIds.some((id, i) => id !== nextIds[i]);
      if (orderChanged) {
        vscode.postMessage({ command: 'updateConfigs', configs: newConfigs });
      } else {
        vscode.postMessage({ command: 'configure', config: active });
      }
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

  // 使用 CSS display 切换视图而非条件渲染，避免 ChatPanel 在切换到配置页时被卸载，
  // 从而保留会话状态（messages、currentHistoryId、toolCalls 等）。
  // 从配置页返回时，ChatPanel 仍保持挂载，会话内容不会丢失。
  return (
    <div className="lifeAiCode-root">
      <div className="lifeAiCode-view" style={{ display: view === 'chat' ? 'flex' : 'none', flexDirection: 'column', height: '100%' }}>
        <ChatPanel
          initialContext={initialContext}
          isPopup={!!initialContext}
          activeConfig={activeConfig}
          configs={configs}
          onOpenConfig={() => setView('config')}
        />
      </div>
      <div className="lifeAiCode-view" style={{ display: view === 'config' ? 'flex' : 'none', flexDirection: 'column', height: '100%' }}>
        <ConfigPanel
          configs={configs}
          activeConfigId={activeConfigId}
          onConfigsChange={handleConfigsChange}
          onSwitchConfig={handleSwitchConfig}
          onBack={() => setView('chat')}
        />
      </div>
    </div>
  );
}

export default App;
