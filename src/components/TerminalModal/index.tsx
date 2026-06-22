import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { closeTerminalModal } from '../../store/slices/modalSlice';
import { terminalSDK } from '../../services/terminalSDK';
import { TerminalInstance, type TerminalInstanceHandle } from '../Terminal/TerminalInstance';
import './TerminalModal.css';

const CLOSE_ANIMATION_DURATION = 200;

export default function TerminalModal() {
  const modal = useAppSelector((state) => state.modal.terminalModal);
  const dispatch = useAppDispatch();
  const [isClosing, setIsClosing] = useState(false);
  const terminalRef = useRef<TerminalInstanceHandle | null>(null);

  const handleClose = () => {
    if (isClosing || !modal) return;
    setIsClosing(true);
    const tabId = modal.tabId;
    setTimeout(() => {
      dispatch(closeTerminalModal());
      terminalSDK.disposeTab(tabId).catch(() => {});
      setIsClosing(false);
    }, CLOSE_ANIMATION_DURATION);
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
