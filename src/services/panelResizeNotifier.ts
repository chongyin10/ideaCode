/**
 * 面板拖拽缩放通知器
 *
 * 当用户拖拽面板分隔条（右侧面板 / 底部面板高度 / 终端侧边栏）时，
 * 面板宽度/高度会以极高频率变化。若终端在拖拽过程中持续 fit，
 * 会导致 xterm 内部 cols 与 PTY cols 频繁失步，触发 shell readline
 * 对当前输入行重复换行（表现为"输入 1 行变 2 行"）。
 *
 * 本模块提供一个轻量的全局信号：拖拽开始 → 抑制终端 fit；
 * 拖拽结束 → 统一触发一次 fit，仅以最终尺寸自适应终端。
 */

type Listener = () => void;

let resizeDepth = 0;
const startListeners = new Set<Listener>();
const endListeners = new Set<Listener>();

/** 拖拽开始时调用（支持嵌套，多次 start 需等量次 end 才算结束） */
export function notifyPanelResizeStart(): void {
  resizeDepth++;
  if (resizeDepth === 1) {
    startListeners.forEach((fn) => fn());
  }
}

/** 拖拽结束时调用 */
export function notifyPanelResizeEnd(): void {
  if (resizeDepth === 0) return;
  resizeDepth--;
  if (resizeDepth === 0) {
    endListeners.forEach((fn) => fn());
  }
}

/** 当前是否处于面板拖拽中 */
export function isPanelResizing(): boolean {
  return resizeDepth > 0;
}

/** 订阅拖拽开始事件，返回取消订阅函数 */
export function onPanelResizeStart(listener: Listener): () => void {
  startListeners.add(listener);
  return () => {
    startListeners.delete(listener);
  };
}

/** 订阅拖拽结束事件，返回取消订阅函数 */
export function onPanelResizeEnd(listener: Listener): () => void {
  endListeners.add(listener);
  return () => {
    endListeners.delete(listener);
  };
}
