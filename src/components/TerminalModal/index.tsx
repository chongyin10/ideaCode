import { useEffect, useRef, useState } from 'react';
import { X, Maximize2 } from 'lucide-react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { closeTerminalModal } from '../../store/slices/modalSlice';
import { moveToEditor } from '../../store/slices/terminalSlice';
import { openVirtualFile } from '../../store/slices/workspaceSlice';
import { terminalSDK } from '../../services/terminalSDK';
import { TerminalInstance, type TerminalInstanceHandle } from '../Terminal/TerminalInstance';
import './TerminalModal.css';

const CLOSE_ANIMATION_DURATION = 200;

export default function TerminalModal() {
  const modal = useAppSelector((state) => state.modal.terminalModal);
  const editorTerminals = useAppSelector((state) => state.terminal.editorTerminals);
  const dispatch = useAppDispatch();
  const [isClosing, setIsClosing] = useState(false);
  const terminalRef = useRef<TerminalInstanceHandle | null>(null);

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
    // 将终端迁移到编辑器区域
    dispatch(moveToEditor(tabId));
    // 创建一个虚拟文件，使其在 Tab 栏中显示
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
    dispatch(closeTerminalModal());
  };

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

  return (
    <div className="terminal-modal-overlay" onClick={handleClose}>
      <div
        className={`terminal-modal ${isClosing ? 'terminal-modal--closing' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="terminal-modal__titlebar">
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
