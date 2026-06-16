/**
 * TerminalEditorInput — 终端编辑器
 * 
 * 将终端作为编辑器 Tab 打开（类似 VS Code terminal.integrated.defaultLocation: editor）。
 * 支持在编辑器区域中独立显示终端，拥有完整的 xterm.js 实例。
 */

import { useEffect, useRef, useCallback } from 'react';
import { Terminal, X } from 'lucide-react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { removeEditorTerminal } from '../../store/slices/terminalSlice';
import { XtermTerminal } from '../BottomPanel/xtermInstance';
import {
  createTerminal, disposeTerminal, sendInput, resizeTerminal,
  onTerminalOutput,
} from '../../services/terminalManager';
import type { TerminalOutputEvent } from '../../types/electron';

interface TerminalEditorInputProps {
  terminalId: string;
}

const TerminalEditorInput: React.FC<TerminalEditorInputProps> = ({ terminalId }) => {
  const dispatch = useAppDispatch();
  const tab = useAppSelector(s => s.terminal.tabs[terminalId]);
  const settings = useAppSelector(s => s.terminal.settings);
  const rootSource = useAppSelector(s => s.workspace.rootSource);
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XtermTerminal | null>(null);
  const processIdRef = useRef<number | null>(null);

  /* ─── 初始化终端 ─── */
  useEffect(() => {
    if (!containerRef.current || !tab || xtermRef.current) return;

    let disposed = false;
    const xterm = new XtermTerminal({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      cursorStyle: settings.cursorStyle,
      cursorBlink: settings.cursorBlinking,
      scrollback: settings.scrollback,
      gpuAcceleration: settings.gpuAcceleration,
    });

    xterm.open(containerRef.current);
    xterm.fit();
    xtermRef.current = xterm;

    // 键盘输入
    xterm.raw.onData((data) => {
      if (!disposed && processIdRef.current) {
        sendInput(processIdRef.current, data);
      }
    });

    // 创建 PTY 进程
    const profile = tab.profile;
    const cwd = typeof rootSource === 'string' ? rootSource : undefined;
    createTerminal({
      cwd,
      executable: profile?.path,
      args: profile?.args,
      cols: xterm.raw.cols,
      rows: xterm.raw.rows,
    }).then(result => {
      if (!disposed && result.success && result.id) {
        processIdRef.current = result.id;
      }
    });

    // 监听输出
    const unsub = onTerminalOutput((event: TerminalOutputEvent) => {
      if (disposed) return;
      if (event.id !== processIdRef.current) return;
      if (event.type === 'data' && event.data) {
        xterm.write(event.data);
      } else if (event.type === 'exit') {
        xterm.write(`\r\n\x1b[33m[进程已退出，退出码: ${event.exitCode}]\x1b[0m\r\n`);
      }
    });

    // 尺寸响应
    const observer = new ResizeObserver(() => {
      if (disposed) return;
      xterm.fit();
      if (processIdRef.current) {
        resizeTerminal(processIdRef.current, xterm.raw.cols, xterm.raw.rows);
      }
    });
    if (containerRef.current) observer.observe(containerRef.current);

    return () => {
      disposed = true;
      unsub();
      observer.disconnect();
      const pid = processIdRef.current;
      if (pid) {
        disposeTerminal(pid);
        processIdRef.current = null;
      }
      xterm.dispose();
      xtermRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab?.id, settings.fontFamily, settings.fontSize, settings.lineHeight, settings.cursorStyle, settings.cursorBlinking, settings.scrollback, settings.gpuAcceleration, rootSource]);

  /* ─── 关闭 ─── */
  const handleClose = useCallback(() => {
    dispatch(removeEditorTerminal(terminalId));
  }, [dispatch, terminalId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#1e1e1e' }}>
      {/* 编辑器 Tab 头（由 TabBar 渲染，此处只展示标题栏）*/}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 12px', height: 28, background: '#252526',
        borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#cccccc' }}>
          <Terminal size={12} />
          <span>{tab?.name || '终端'}</span>
        </div>
        <button
          onClick={handleClose}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 20, height: 20, border: 'none', background: 'transparent',
            color: '#858585', borderRadius: 3, cursor: 'pointer',
          }}
        >
          <X size={12} />
        </button>
      </div>
      <div ref={containerRef} style={{ flex: 1, overflow: 'hidden' }} />
    </div>
  );
};

export default TerminalEditorInput;
