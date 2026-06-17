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
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
  }

  async init(): Promise<void> {
    if (this.disposed) return;

    // 可选加载 WebGL/Unicode 等 addons
    await this.loadOptionalAddons();

    this.terminal.open(this.container);

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

    // 尺寸变化时 fit 并通知 PTY
    let rafId = 0;
    this.resizeObserver = new ResizeObserver(() => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        this.fitAndResize();
      });
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
      if (rect.width === 0 || rect.height === 0) return;

      this.fitAddon.fit();
      const { cols, rows } = this.terminal;
      window.electronAPI?.terminal?.resize(this.id, cols, rows);
    } catch {
      // ignore
    }
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
    try {
      this.terminal.dispose();
    } catch { /* ignore */ }
  }
}
