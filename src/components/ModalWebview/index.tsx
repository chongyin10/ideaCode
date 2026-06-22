import { useState, useRef, useEffect, useCallback } from 'react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { closeModalWebview } from '../../store/slices/modalSlice';
import WebViewPanel from '../WebViewPanel';
import './ModalWebview.css';

const CLOSE_ANIMATION_DURATION = 200;

export default function ModalWebview() {
  const modal = useAppSelector((state) => state.modal.modalWebview);
  const dispatch = useAppDispatch();
  const [size, setSize] = useState({ width: 640, height: 400 });
  const [isResizing, setIsResizing] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const ignoreOverlayClickUntilRef = useRef(0);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const isDraggingRef = useRef(false);

  const performClose = useCallback(() => {
    const bridge = (window as unknown as { __extensionBridge?: { sendToHost: (method: string, params: unknown) => Promise<unknown> } }).__extensionBridge;
    if (bridge && modal) {
      bridge.sendToHost('webview.dispose', { id: modal.id }).catch(() => {});
    }
    dispatch(closeModalWebview());
  }, [dispatch, modal]);

  const handleClose = useCallback(() => {
    if (isClosing || Date.now() < ignoreOverlayClickUntilRef.current) return;
    setIsClosing(true);
    setTimeout(() => {
      performClose();
    }, CLOSE_ANIMATION_DURATION);
  }, [isClosing, performClose]);

  useEffect(() => {
    if (!modal) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [modal, handleClose]);

  const startDrag = (e: React.MouseEvent) => {
    if (!containerRef.current || isClosing) return;
    e.preventDefault();
    e.stopPropagation();
    isDraggingRef.current = true;
    const el = containerRef.current;
    const rect = el.getBoundingClientRect();
    dragOffsetRef.current = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
    const maxX = window.innerWidth - size.width;
    const maxY = window.innerHeight - size.height;
    el.style.transform = 'none';
    const onMove = (ev: MouseEvent) => {
      if (!isDraggingRef.current) return;
      let x = ev.clientX - dragOffsetRef.current.x;
      let y = ev.clientY - dragOffsetRef.current.y;
      x = Math.max(0, Math.min(x, maxX));
      y = Math.max(0, Math.min(y, maxY));
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    };
    const onUp = () => {
      isDraggingRef.current = false;
      ignoreOverlayClickUntilRef.current = Date.now() + 150;
      const finalX = parseInt(el.style.left || '0', 10);
      const finalY = parseInt(el.style.top || '0', 10);
      setPosition({ x: finalX, y: finalY });
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const startResize = (e: React.MouseEvent, direction: 'right' | 'bottom' | 'corner') => {
    if (isClosing) return;
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = size.width;
    const startH = size.height;
    const onMove = (ev: MouseEvent) => {
      let newW = startW;
      let newH = startH;
      if (direction === 'right' || direction === 'corner') {
        newW = Math.max(320, startW + (ev.clientX - startX));
      }
      if (direction === 'bottom' || direction === 'corner') {
        newH = Math.max(240, startH + (ev.clientY - startY));
      }
      setSize({ width: newW, height: newH });
    };
    const onUp = () => {
      ignoreOverlayClickUntilRef.current = Date.now() + 150;
      setIsResizing(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const toggleFullscreen = async () => {
    if (!containerRef.current || isClosing) return;
    try {
      if (!document.fullscreenElement) {
        await containerRef.current.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      // ignore
    }
  };

  if (!modal) return null;

  const isPositioned = !!position;
  const transform = isClosing
    ? (isPositioned ? 'scale(0.95)' : 'translate(-50%, -50%) scale(0.95)')
    : (isPositioned ? 'none' : 'translate(-50%, -50%)');

  return (
    <div
      className={`modal-webview-overlay ${isClosing ? 'modal-webview-overlay--closing' : ''}`}
      onClick={handleClose}
      style={{ pointerEvents: isResizing || isClosing ? 'none' : 'auto' }}
    >
      <div
        ref={containerRef}
        className={`modal-webview ${isClosing ? 'modal-webview--closing' : ''}`}
        style={{
          position: 'absolute',
          left: isPositioned ? position.x : '50%',
          top: isPositioned ? position.y : '50%',
          transform,
          width: size.width,
          height: size.height,
          opacity: isClosing ? 0 : 1,
          transition: `opacity ${CLOSE_ANIMATION_DURATION}ms ease, transform ${CLOSE_ANIMATION_DURATION}ms ease`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-webview__titlebar" onMouseDown={startDrag}>
          <span className="modal-webview__title">{modal.title}</span>
          <div className="modal-webview__controls" onMouseDown={(e) => e.stopPropagation()}>
            <button className="icon-btn" title="全屏" onClick={toggleFullscreen}>⛶</button>
            <button className="icon-btn" title="关闭" onClick={handleClose}>✕</button>
          </div>
        </div>
        <div className="modal-webview__body">
          <WebViewPanel html={modal.html} panelId={modal.id} extensionPath={modal.extensionPath} />
        </div>
        <div className="modal-webview__resize-handle modal-webview__resize-handle--right" onMouseDown={(e) => startResize(e, 'right')} />
        <div className="modal-webview__resize-handle modal-webview__resize-handle--bottom" onMouseDown={(e) => startResize(e, 'bottom')} />
        <div className="modal-webview__resize-handle modal-webview__resize-handle--corner" onMouseDown={(e) => startResize(e, 'corner')} />
      </div>
    </div>
  );
}
