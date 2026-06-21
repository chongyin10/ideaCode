import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon as SearchAddonType } from '@xterm/addon-search';
import { useAppSelector } from '../../store/hooks';
import {
  sendInput,
  resizeTerminal,
  onTerminalOutput,
} from '../../services/terminalManager';
import { onPanelResizeStart, onPanelResizeEnd } from '../../services/panelResizeNotifier';
import '@xterm/xterm/css/xterm.css';
import './TerminalInstance.css';

const ACK_BATCH = 5000;

export interface TerminalInstanceHandle {
  focus: () => void;
  find: (term: string) => Promise<boolean>;
  findPrevious: (term: string) => Promise<boolean>;
  clearSelection: () => void;
  /** 获取选中文本（无选中返回空串） */
  getSelection: () => string;
  /** 是否有选中文本 */
  hasSelection: () => boolean;
  /** 选中全部内容 */
  selectAll: () => void;
  /** 粘贴剪贴板内容到终端 */
  paste: () => void;
}

interface TerminalInstanceProps {
  terminalId: string;
  className?: string;
  style?: React.CSSProperties;
  active?: boolean;
  /** 右键菜单回调，返回是否已有选中内容 */
  onContextMenu?: (e: { x: number; y: number; hasSelection: boolean }) => void;
}

export const TerminalInstance = forwardRef<TerminalInstanceHandle, TerminalInstanceProps>(
  function TerminalInstance({ terminalId, className = '', style, active = true, onContextMenu }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const searchAddonRef = useRef<SearchAddonType | null>(null);
    const resizeObserverRef = useRef<ResizeObserver | null>(null);
    const unsubscribeOutputRef = useRef<(() => void) | null>(null);
    const unackedCharsRef = useRef(0);
    const ackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingResizeRef = useRef<{ cols: number; rows: number } | null>(null);
    const pendingFitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingFitRetriesRef = useRef(0);
    const viewportElementRef = useRef<HTMLElement | null>(null);
    const wasActiveRef = useRef(active);
    /** 激活过渡中：抑制 ResizeObserver，避免与 active effect 的 fit 竞态 */
    const activatingRef = useRef(false);
    /** 面板拖拽中：抑制 ResizeObserver，避免高频 fit 导致输入行重复换行 */
    const resizingRef = useRef(false);

    const tab = useAppSelector((state) => state.terminal.tabs[terminalId]);
    const processId = tab?.processId ?? null;
    const gpuAcceleration = useAppSelector((state) => state.terminal.settings.gpuAcceleration);

    useImperativeHandle(ref, () => ({
      focus: () => {
        terminalRef.current?.focus();
      },
      find: async (term: string) => {
        const addon = await ensureSearchAddon();
        return addon ? addon.findNext(term) : false;
      },
      findPrevious: async (term: string) => {
        const addon = await ensureSearchAddon();
        return addon ? addon.findPrevious(term) : false;
      },
      clearSelection: () => {
        terminalRef.current?.clearSelection();
      },
      getSelection: () => {
        return terminalRef.current?.getSelection() ?? '';
      },
      hasSelection: () => {
        return terminalRef.current?.hasSelection() ?? false;
      },
      selectAll: () => {
        terminalRef.current?.selectAll();
      },
      paste: () => {
        navigator.clipboard.readText().then((text) => {
          const pid = processIdRef.current;
          if (pid != null) {
            sendInput(pid, text);
          }
        }).catch(() => {});
      },
    }));

    async function ensureSearchAddon(): Promise<SearchAddonType | null> {
      if (searchAddonRef.current) return searchAddonRef.current;
      const terminal = terminalRef.current;
      if (!terminal) return null;
      try {
        const { SearchAddon } = await import('@xterm/addon-search');
        const addon = new SearchAddon();
        terminal.loadAddon(addon);
        searchAddonRef.current = addon;
        return addon;
      } catch {
        return null;
      }
    }

    // 初始化 xterm.js
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const terminal = new Terminal({
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
        reflowCursorLine: false,
      });

      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);

      terminal.open(container);
      viewportElementRef.current = container.querySelector('.xterm-viewport') as HTMLElement | null;

      // 可选：WebGL / Unicode11
      // 默认关闭 WebGL：隐藏/切换 tab 时 WebGL 上下文容易丢失导致黑屏，
      // 只有用户在设置中显式开启 gpuAcceleration=on 时才加载。
      loadOptionalAddons(terminal, gpuRef.current).catch(() => {});

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;

      // 输入 → PTY（附加 activeRef 守卫作为防御：即使 disableStdin
      // 因某种原因未生效，非活跃 tab 的输入也不会被转发到 PTY。）
      terminal.onData((data) => {
        if (!activeRef.current) return;
        const pid = processIdRef.current;
        if (pid != null) {
          sendInput(pid, data);
        }
      });

      // 右键：有选区复制，无选区粘贴
      terminal.element?.addEventListener('contextmenu', handleContextMenu);

      // 尺寸变化时 fit 并通知 PTY（激活过渡期间跳过，由 active effect 统一处理）
      const ro = new ResizeObserver(() => {
        if (!activeRef.current || activatingRef.current || resizingRef.current) return;
        scheduleFit();
      });
      ro.observe(container);
      resizeObserverRef.current = ro;

      // 首次 fit
      requestAnimationFrame(() => {
        if (activeRef.current) {
          fitAndResize();
        }
      });

      return () => {
        cleanup();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 使用 ref 保存最新 processId / active，避免 effect 重创建 xterm
    const processIdRef = useRef(processId);
    processIdRef.current = processId;
    const activeRef = useRef(active);
    activeRef.current = active;
    const gpuRef = useRef(gpuAcceleration);
    gpuRef.current = gpuAcceleration;
    const onContextMenuRef = useRef(onContextMenu);
    onContextMenuRef.current = onContextMenu;

    // 订阅 PTY 输出
    useEffect(() => {
      if (processId == null) return;

      const unsubscribe = onTerminalOutput((event) => {
        if (event.id !== processId) return;
        const terminal = terminalRef.current;
        if (!terminal) return;

        if (event.type === 'data' && event.data) {
          let data = event.data;
          if (tab?.outputFilter) {
            try {
              const regex = new RegExp(tab.outputFilter, 'gi');
              data = data.replace(regex, '');
              // 过滤后去掉开头的空行，避免残留 \r\n 导致顶部空白
              data = data.replace(/^[\r\n]+/, '');
            } catch {
              // 非法正则则忽略过滤
            }
          }
          if (data) {
            terminal.write(data);
            trackOutput(data.length);
          }
        } else if (event.type === 'exit') {
          terminal.write(
            `\r\n\x1b[33m[进程已退出，退出码: ${event.exitCode}]\x1b[0m\r\n`
          );
        }
      });

      unsubscribeOutputRef.current = unsubscribe;
      return () => {
        unsubscribe();
        unsubscribeOutputRef.current = null;
      };
    }, [processId]);

    // active 变化时：失焦隐藏实例；激活时使用双重 rAF 等待浏览器完成
    // 布局提交和 Canvas 图层重建，再 fit 并强制刷新全屏，避免切换 tab 后
    // Canvas 内容丢失（黑屏 / 输入消失）问题。
    useEffect(() => {
      const terminal = terminalRef.current;
      if (active) {
        activatingRef.current = true;
        pendingFitRetriesRef.current = 0;
        terminal?.focus();
        // 第一帧：等待 CSS 类切换引起的布局生效
        requestAnimationFrame(() => {
          // 第二帧：确保浏览器已完成绘制提交、Canvas 图层已就绪
          requestAnimationFrame(() => {
            fitAndResize(true);
            activatingRef.current = false;
          });
        });
      } else {
        terminal?.blur();
      }
      if (terminal) {
        terminal.options.disableStdin = !active;
      }
      wasActiveRef.current = active;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active]);

    // 面板拖拽期间抑制 ResizeObserver 的 fit，拖拽结束后以最终尺寸
    // 做一次自适应 fit，避免高频 fit 导致 xterm cols 与 PTY cols 失步、
    // shell readline 对当前输入行重复换行（输入 1 行变 2 行）。
    useEffect(() => {
      const onStart = () => {
        resizingRef.current = true;
        // 取消拖拽期间已排队的延迟 fit，防止其在新尺寸前误触发
        if (pendingFitTimerRef.current) {
          clearTimeout(pendingFitTimerRef.current);
          pendingFitTimerRef.current = null;
        }
        pendingFitRetriesRef.current = 0;
      };
      const onEnd = () => {
        resizingRef.current = false;
        // 拖拽结束后以最终尺寸做一次 fit（非活跃实例由 active effect 处理）
        if (activeRef.current) {
          requestAnimationFrame(() => fitAndResize(true));
        }
      };
      const unsubStart = onPanelResizeStart(onStart);
      const unsubEnd = onPanelResizeEnd(onEnd);
      return () => {
        unsubStart();
        unsubEnd();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    function handleContextMenu(e: MouseEvent) {
      e.preventDefault();
      const terminal = terminalRef.current;
      if (!terminal) return;
      // 通过回调通知父组件显示自定义右键菜单
      onContextMenuRef.current?.({ x: e.clientX, y: e.clientY, hasSelection: terminal.hasSelection() });
    }

    function scheduleFit() {
      if (pendingFitTimerRef.current) return;
      if (pendingFitRetriesRef.current >= 3) return;
      pendingFitRetriesRef.current++;
      pendingFitTimerRef.current = setTimeout(() => {
        pendingFitTimerRef.current = null;
        fitAndResize();
      }, 100);
    }

    function fitAndResize(forceRefresh = false) {
      const terminal = terminalRef.current;
      const fitAddon = fitAddonRef.current;
      const container = containerRef.current;
      if (!terminal || !fitAddon || !container) return;
      if (!activeRef.current) return;

      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        scheduleFit();
        return;
      }

      try {
        // 根据实际滚动条宽度调整 overviewRuler，让 FitAddon 准确计算列数
        const viewport = viewportElementRef.current;
        const scrollbarWidth = viewport ? viewport.offsetWidth - viewport.clientWidth : 0;
        terminal.options.overviewRuler = { width: scrollbarWidth || 0.01 };

        fitAddon.fit();
        const { cols, rows } = terminal;
        debouncedResize(cols, rows);
        pendingFitRetriesRef.current = 0;

        if (forceRefresh && rows > 0) {
          terminal.refresh(0, rows - 1);
        }
      } catch {
        // ignore
      }
    }

    function debouncedResize(cols: number, rows: number) {
      pendingResizeRef.current = { cols, rows };
      if (resizeTimerRef.current) {
        clearTimeout(resizeTimerRef.current);
      }
      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = null;
        const pending = pendingResizeRef.current;
        const pid = processIdRef.current;
        if (pending && pid != null) {
          resizeTerminal(pid, pending.cols, pending.rows);
          pendingResizeRef.current = null;
        }
      }, 150);
    }

    function trackOutput(length: number) {
      unackedCharsRef.current += length;
      if (unackedCharsRef.current >= ACK_BATCH) {
        const pid = processIdRef.current;
        if (pid != null) {
          window.electronAPI?.terminal?.ack(pid, unackedCharsRef.current);
        }
        unackedCharsRef.current = 0;
        if (ackTimerRef.current) {
          clearTimeout(ackTimerRef.current);
          ackTimerRef.current = null;
        }
      } else if (!ackTimerRef.current) {
        ackTimerRef.current = setTimeout(() => {
          ackTimerRef.current = null;
          const pid = processIdRef.current;
          if (unackedCharsRef.current > 0 && pid != null) {
            window.electronAPI?.terminal?.ack(pid, unackedCharsRef.current);
          }
          unackedCharsRef.current = 0;
        }, 100);
      }
    }

    async function loadOptionalAddons(terminal: Terminal, gpu: string) {
      if (gpu === 'on') {
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
              terminal.loadAddon(replacement);
            } catch {
              // fallback to canvas/dom
            }
          });
          terminal.loadAddon(addon);
        } catch {
          // ignore
        }
      }

      try {
        const { Unicode11Addon } = await import('@xterm/addon-unicode11');
        const addon = new Unicode11Addon();
        terminal.loadAddon(addon);
        terminal.unicode.activeVersion = '11';
      } catch {
        // ignore
      }
    }

    function cleanup() {
      terminalRef.current?.element?.removeEventListener('contextmenu', handleContextMenu);
      unsubscribeOutputRef.current?.();
      unsubscribeOutputRef.current = null;
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      if (ackTimerRef.current) {
        clearTimeout(ackTimerRef.current);
        ackTimerRef.current = null;
      }
      if (resizeTimerRef.current) {
        clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      if (pendingFitTimerRef.current) {
        clearTimeout(pendingFitTimerRef.current);
        pendingFitTimerRef.current = null;
      }
      try {
        terminalRef.current?.dispose();
      } catch {
        // ignore
      }
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    }

    return (
      <div
        ref={containerRef}
        className={`terminal-instance ${className}`}
        style={style}
        data-terminal-id={terminalId}
      >
        {(tab?.connecting || !tab?.ready) && (
          <div className="terminal-instance__loading">
            <Loader2 size={20} className="spin" />
            <span>{tab?.connecting ? '连接中...' : '正在启动终端...'}</span>
          </div>
        )}
      </div>
    );
  }
);

export default TerminalInstance;
