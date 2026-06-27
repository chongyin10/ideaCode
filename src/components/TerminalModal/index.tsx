import { useEffect, useRef, useState, useCallback } from 'react';
import { X, Maximize2 } from 'lucide-react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { closeTerminalModal } from '../../store/slices/modalSlice';
import { moveToEditor } from '../../store/slices/terminalSlice';
import { openVirtualFile } from '../../store/slices/workspaceSlice';
import { terminalSDK } from '../../services/terminalSDK';
import { setTerminalSnapshot } from '../../services/terminalSnapshot';
import { TerminalInstance, type TerminalInstanceHandle } from '../Terminal/TerminalInstance';
import './TerminalModal.css';

const CLOSE_ANIMATION_DURATION = 200;

export default function TerminalModal() {
  const modal = useAppSelector((state) => state.modal.terminalModal);
  const editorTerminals = useAppSelector((state) => state.terminal.editorTerminals);
  const dispatch = useAppDispatch();
  const [isClosing, setIsClosing] = useState(false);
  const terminalRef = useRef<TerminalInstanceHandle | null>(null);

  // 拖拽相关状态
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const dragStartRef = useRef<{ mouseX: number; mouseY: number; modalX: number; modalY: number } | null>(null);

  const handleClose = () => {
    if (isClosing || !modal) return;
    setIsClosing(true);
    const tabId = modal.tabId;
    setTimeout(() => {
      dispatch(closeTerminalModal());
      // 如果终端已嵌入编辑器区域，关闭弹窗时不销毁进程
      if (!editorTerminals.includes(tabId)) {
        terminalSDK.disposeTab(tabId).catch(() => {});
      }
      setIsClosing(false);
    }, CLOSE_ANIMATION_DURATION);
  };

  const handleExpandToTab = () => {
    if (!modal) return;
    const { tabId, title } = modal;
    // 主动序列化当前屏幕内容写入快照，避免依赖卸载 cleanup 的被动执行时序。
    // 此前用 requestAnimationFrame 把迁移推迟到下一帧，会使卸载(cleanup serialize)
    // 与挂载(setup getSnapshot)分属两次 commit，React 不保证两者 passive effects
    // 的执行顺序，导致首次迁移时 setup 读不到快照而清屏。
    const snapshot = terminalRef.current?.serializeSnapshot();
    if (snapshot) {
      setTerminalSnapshot(tabId, snapshot);
    }
    // 同步 dispatch：卸载与挂载在同一次 commit，且快照已先行写入，新实例 setup 必能读到
    dispatch(closeTerminalModal());
    dispatch(moveToEditor(tabId));
    dispatch(
      openVirtualFile({
        id: tabId,
        name: title || '终端',
        source: `terminal://${tabId}`,
        content: '',
        language: 'terminal',
        isDirty: false,
      })
    );
  };

  // Header 拖拽：mousedown 记录起点，mousemove 更新位置，mouseup 结束
  const handleTitlebarMouseDown = useCallback((e: React.MouseEvent) => {
    // 仅响应左键，且不拦截按钮点击
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('button')) return;

    const overlay = (e.currentTarget as HTMLElement).closest('.terminal-modal-overlay') as HTMLElement | null;
    const modalEl = overlay?.querySelector('.terminal-modal') as HTMLElement | null;
    if (!modalEl) return;

    const rect = modalEl.getBoundingClientRect();
    // 初始化拖拽位置为当前实际位置（相对视口）
    setDragPos({ x: rect.left, y: rect.top });
    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      modalX: rect.left,
      modalY: rect.top,
    };

    const onMove = (ev: MouseEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      let nextX = start.modalX + (ev.clientX - start.mouseX);
      let nextY = start.modalY + (ev.clientY - start.mouseY);
      // 限制在视口范围内
      const maxX = window.innerWidth - 80;
      const maxY = window.innerHeight - 40;
      nextX = Math.max(0, Math.min(nextX, maxX));
      nextY = Math.max(0, Math.min(nextY, maxY));
      setDragPos({ x: nextX, y: nextY });
    };
    const onUp = () => {
      dragStartRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    e.preventDefault();
  }, []);

  // Modal 关闭时重置拖拽位置
  useEffect(() => {
    if (!modal) {
      setDragPos(null);
      dragStartRef.current = null;
    }
  }, [modal]);

  useEffect(() => {
    if (!modal) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    // 自动聚焦到终端输入区域
    setTimeout(() => {
      terminalRef.current?.focus();
    }, 100);
    return () => window.removeEventListener('keydown', handleKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal]);

  if (!modal) return null;

  const modalStyle: React.CSSProperties = dragPos
    ? { position: 'fixed', left: dragPos.x, top: dragPos.y, margin: 0, transform: 'none' }
    : {};

  return (
    <div className="terminal-modal-overlay" onClick={handleClose}>
      <div
        className={`terminal-modal ${isClosing ? 'terminal-modal--closing' : ''}`}
        style={modalStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="terminal-modal__titlebar" onMouseDown={handleTitlebarMouseDown}>
          <span className="terminal-modal__title">{modal.title || '终端'}</span>
          <div className="terminal-modal__controls">
            <button className="icon-btn" title="嵌入到标签页" onClick={handleExpandToTab}>
              <Maximize2 size={14} />
            </button>
            <button className="icon-btn" title="关闭" onClick={handleClose}>
              <X size={14} />
            </button>
          </div>
        </div>
        <div className="terminal-modal__body">
          <TerminalInstance
            ref={terminalRef}
            terminalId={modal.tabId}
            active
            className="terminal-modal__instance"
          />
        </div>
      </div>
    </div>
  );
}
