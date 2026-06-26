import { useEffect } from 'react';
import { initMessageListener, sendReady } from './api';
import { gitStore } from './store/gitStore';
import type { HostMessage } from './types';
import SourceControlView from './components/SourceControlView';

export default function App() {
  useEffect(() => {
    const unsub = initMessageListener((msg: HostMessage) => {
      switch (msg.type) {
        case 'state':
          gitStore.applyState({
            rootPath: msg.rootPath,
            repoRoot: msg.repoRoot,
            isRepo: msg.isRepo,
            gitAvailable: msg.gitAvailable,
            state: msg.state,
            lastError: msg.lastError,
          });
          break;
        case 'branches':
          gitStore.applyBranches(msg.branches);
          break;
        case 'log':
          gitStore.applyLog(msg.log);
          break;
        case 'stashes':
          gitStore.applyStashes(msg.stashes);
          break;
      }
    });

    // 通知 host WebView 已就绪
    sendReady().catch(() => { /* ignore */ });

    return () => {
      if (typeof unsub === 'function') unsub();
    };
  }, []);

  return <SourceControlView />;
}