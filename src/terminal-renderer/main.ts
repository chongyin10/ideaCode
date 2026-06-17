import { TerminalRenderer } from './TerminalRenderer';

const root = document.getElementById('terminal-root');
if (!root) {
  console.error('[TerminalRenderer] 找不到 #terminal-root');
} else {
  const renderer = new TerminalRenderer(root);
  renderer.init().catch((err) => {
    console.error('[TerminalRenderer] 初始化失败:', err);
  });

  // 页面可见性变化时触发一次 fit，避免从隐藏状态恢复后尺寸不对
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      renderer.syncBounds();
    }
  });
}
