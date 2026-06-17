import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon as SearchAddonType } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import './TerminalRenderer.css';

const ACK_BATCH = 5000;

export class TerminalRenderer {
  readonly id: number;
  private terminal: Terminal;
  private fitAddon: FitAddon;
  private searchAddon?: SearchAddonType;
  private container: HTMLElement;
  private unackedChars = 0;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private unsubscribeOutput: (() => void) | undefined = undefined;
  private disposed = false;
  private viewportElement: HTMLElement | null = null;
  private pendingFitTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFitRetries = 0;
  private static readonly MAX_FIT_RETRIES = 3;
  private fitTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingResize: { cols: number; rows: number } | null = null;
  /** 右侧面板拖拽期间暂停终端 reflow/resize */
  private isPanelResizing = false;
  private panelResizeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(container: HTMLElement) {
    this.container = container;

    const params = new URLSearchParams(window.location.search);
    const id = Number(params.get('id'));
    if (!Number.isFinite(id)) {
      throw new Error('[TerminalRenderer] 缺少终端 id');
    }
    this.id = id;

    this.terminal = new Terminal({
      allowProposedApi: true,
      cols: 80,
      rows: 24,
      fontFamily: "Menlo, 'Courier New', monospace",
      fontSize: 14,
      lineHeight: 1.2,
      cursorStyle: 'block',
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: '#1e1e1e',
        foreground: '#cccccc',
        cursor: '#cccccc',
        selectionBackground: '#264f78',
      },
      drawBoldTextInBrightColors: true,
      macOptionIsMeta: true,
      allowTransparency: true,
      // 默认 false：光标行由 shell 自己重绘，避免 xterm 重排与 shell 重绘冲突导致乱码
      reflowCursorLine: false,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
  }

  async init(): Promise<void> {
    if (this.disposed) return;

    // 可选加载 WebGL/Unicode 等 addons
    await this.loadOptionalAddons();

    this.terminal.open(this.container);

    // 缓存 viewport 元素，用于精确测量滚动条宽度
    this.viewportElement = this.container.querySelector('.xterm-viewport') as HTMLElement | null;

    // 输入直接发到 PTY
    this.terminal.onData((data) => {
      window.electronAPI?.terminal?.input(this.id, data);
    });

    // 右键菜单：有选区则复制，否则粘贴
    this.terminal.element?.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.terminal.hasSelection()) {
        navigator.clipboard.writeText(this.terminal.getSelection()).catch(() => {});
        this.terminal.clearSelection();
      } else {
        navigator.clipboard.readText().then((text) => {
          window.electronAPI?.terminal?.input(this.id, text);
        }).catch(() => {});
      }
    });

    // 监听 PTY 输出
    this.unsubscribeOutput = window.electronAPI?.terminal?.onOutput((event) => {
      if (event.id !== this.id) return;
      if (event.type === 'data' && event.data) {
        this.terminal.write(event.data);
        this.trackOutput(event.data.length);
      } else if (event.type === 'exit') {
        this.terminal.write(
          `\r\n\x1b[33m[进程已退出，退出码: ${event.exitCode}]\x1b[0m\r\n`
        );
      }
    });

    // 监听主窗口发来的搜索/清除选区指令
    window.electronAPI?.terminalView?.onFind((data) => {
      this.find(data.term, data.previous);
    });
    window.electronAPI?.terminalView?.onClearSelection(() => {
      this.terminal.clearSelection();
    });

    // 监听右侧面板拖拽状态：拖拽期间暂停 reflow，松开后（及频繁切换后的静止期）再触发一次 fit。
    window.electronAPI?.terminalView?.onResizeState((state) => {
      this.handlePanelResizeState(state);
    });

    // 尺寸变化时 fit 并通知 PTY。用 trailing debounce 避免拖拽/动画过程中频繁 reflow，
    // 等尺寸稳定后再一次性重排，减少 shell 重绘时产生重复行。
    this.resizeObserver = new ResizeObserver(() => {
      if (this.isPanelResizing) return;
      if (this.fitTimer) {
        clearTimeout(this.fitTimer);
        this.fitTimer = null;
      }
      this.fitTimer = setTimeout(() => {
        this.fitTimer = null;
        this.fitAndResize();
      }, 250);
    });
    this.resizeObserver.observe(this.container);

    // 等待字体就绪后首次 fit
    if (document.fonts) {
      try {
        await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 200))]);
      } catch { /* ignore */ }
    }
    await new Promise((r) => requestAnimationFrame(r));
    this.fitAndResize();

    // 通知主进程 view 已就绪
    window.electronAPI?.terminalView?.ready(this.id);
  }

  private async loadOptionalAddons(): Promise<void> {
    try {
      const { WebglAddon } = await import('@xterm/addon-webgl');
      const addon = new WebglAddon();
      let recovered = false;
      addon.onContextLoss(() => {
        if (recovered) return;
        recovered = true;
        try {
          addon.dispose();
          const replacement = new WebglAddon();
          this.terminal.loadAddon(replacement);
        } catch {
          // fallback to canvas/dom
        }
      });
      this.terminal.loadAddon(addon);
    } catch {
      // WebGL 不可用，使用默认 canvas/dom 渲染
    }

    try {
      const { Unicode11Addon } = await import('@xterm/addon-unicode11');
      const addon = new Unicode11Addon();
      this.terminal.loadAddon(addon);
      this.terminal.unicode.activeVersion = '11';
    } catch {
      // ignore
    }
  }

  private fitAndResize(): void {
    if (this.disposed) return;
    try {
      const rect = this.container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        // 布局尚未就绪，稍后重试
        this.scheduleFit();
        return;
      }

      // 根据实际渲染的滚动条宽度调整 overviewRuler，让 FitAddon 准确计算列数，
      // 避免因为默认 14px 与自定义 6px 滚动条不一致导致提前换行。
      const scrollbarWidth = this.viewportElement
        ? this.viewportElement.offsetWidth - this.viewportElement.clientWidth
        : 0;
      // FitAddon 会把 0 回退到 14，所以用极小值表示“无滚动条/overlay 滚动条”
      this.terminal.options.overviewRuler = { width: scrollbarWidth || 0.01 };

      this.fitAddon.fit();
      const { cols, rows } = this.terminal;
      // 等尺寸稳定后再通知 PTY，减少 shell 收到多次 SIGWINCH 后重绘出重复行
      this.debouncedResize(cols, rows);
      // 成功 fit 后重置重试计数
      this.pendingFitRetries = 0;
    } catch {
      // ignore
    }
  }

  private scheduleFit(): void {
    if (this.pendingFitTimer || document.visibilityState !== 'visible') return;
    if (this.pendingFitRetries >= TerminalRenderer.MAX_FIT_RETRIES) return;
    this.pendingFitRetries++;
    this.pendingFitTimer = setTimeout(() => {
      this.pendingFitTimer = null;
      this.fitAndResize();
    }, 100);
  }

  /** 供外部在页面重新可见时主动触发一次尺寸同步 */
  syncBounds(): void {
    if (this.isPanelResizing) return;
    this.fitAndResize();
  }

  /** 处理右侧面板拖拽状态：拖拽中忽略尺寸变化，松开后防抖触发最终 fit */
  private handlePanelResizeState(state: 'start' | 'end'): void {
    if (state === 'start') {
      if (this.panelResizeTimer) {
        clearTimeout(this.panelResizeTimer);
        this.panelResizeTimer = null;
      }
      this.isPanelResizing = true;
      return;
    }

    if (state === 'end') {
      if (this.panelResizeTimer) {
        clearTimeout(this.panelResizeTimer);
        this.panelResizeTimer = null;
      }
      this.panelResizeTimer = setTimeout(() => {
        this.panelResizeTimer = null;
        this.isPanelResizing = false;
        this.fitAndResize();
      }, 150);
    }
  }

  private debouncedResize(cols: number, rows: number): void {
    this.pendingResize = { cols, rows };
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      if (this.pendingResize) {
        window.electronAPI?.terminal?.resize(this.id, this.pendingResize.cols, this.pendingResize.rows);
        this.pendingResize = null;
      }
    }, 150);
  }

  private trackOutput(length: number): void {
    this.unackedChars += length;
    if (this.unackedChars >= ACK_BATCH) {
      window.electronAPI?.terminal?.ack(this.id, this.unackedChars);
      this.unackedChars = 0;
      if (this.ackTimer) {
        clearTimeout(this.ackTimer);
        this.ackTimer = null;
      }
    } else if (!this.ackTimer) {
      this.ackTimer = setTimeout(() => {
        this.ackTimer = null;
        if (this.unackedChars > 0) {
          window.electronAPI?.terminal?.ack(this.id, this.unackedChars);
          this.unackedChars = 0;
        }
      }, 100);
    }
  }

  focus(): void {
    this.terminal.focus();
  }

  async find(term: string, previous?: boolean): Promise<boolean> {
    try {
      if (!this.searchAddon) {
        const { SearchAddon } = await import('@xterm/addon-search');
        this.searchAddon = new SearchAddon();
        this.terminal.loadAddon(this.searchAddon);
      }
      return previous
        ? this.searchAddon.findPrevious(term)
        : this.searchAddon.findNext(term);
    } catch {
      return false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.unsubscribeOutput?.();
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
    if (this.fitTimer) {
      clearTimeout(this.fitTimer);
      this.fitTimer = null;
    }
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    if (this.pendingFitTimer) {
      clearTimeout(this.pendingFitTimer);
      this.pendingFitTimer = null;
    }
    if (this.panelResizeTimer) {
      clearTimeout(this.panelResizeTimer);
      this.panelResizeTimer = null;
    }
    try {
      this.terminal.dispose();
    } catch { /* ignore */ }
  }
}
