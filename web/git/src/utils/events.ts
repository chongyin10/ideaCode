/**
 * Git WebView 内部事件总线
 * 用于跨组件触发一些宿主下发的命令（如打开分支选择器）
 */

type Listener = () => void;

const listeners = new Set<Listener>();

export const branchPickerEvents = {
  emit() {
    listeners.forEach((l) => {
      try { l(); } catch { /* ignore */ }
    });
  },
  on(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
