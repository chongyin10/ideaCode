import { useState, useCallback, useMemo, useRef } from 'react';
import { Plus, X, Columns2, Maximize2, Minimize2, Terminal } from 'lucide-react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { toggleBottomPanel } from '../../store/slices/layoutSlice';
import './BottomPanel.css';

interface Terminal {
  id: string;
  name: string;
}

let nextTerminalId = 1;

const defaultShells = ['bash', 'zsh', 'fish', 'node', 'powershell'];

const createTerminal = (name?: string): Terminal => ({
  id: `terminal-${nextTerminalId++}`,
  name: name || `终端 ${nextTerminalId - 1}`,
});

const DEFAULT_PANEL_HEIGHT = 200;
const MIN_PANEL_HEIGHT = 120;
const MAX_PANEL_HEIGHT_RATIO = 0.85;

const DEFAULT_SIDEBAR_WIDTH = 120;
const MIN_SIDEBAR_WIDTH = 80;
const MAX_SIDEBAR_WIDTH = 400;

const BottomPanel = () => {
  const dispatch = useAppDispatch();
  const { bottomPanelVisible } = useAppSelector((state) => state.layout);
  const [terminals, setTerminals] = useState<Terminal[]>(() => [createTerminal('zsh')]);
  const [activeId, setActiveId] = useState<string>(terminals[0].id);
  const [panelHeight, setPanelHeight] = useState(DEFAULT_PANEL_HEIGHT);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [isMaximized, setIsMaximized] = useState(false);
  const [resizingHeight, setResizingHeight] = useState(false);
  const [resizingWidth, setResizingWidth] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const preMaximizeHeightRef = useRef(DEFAULT_PANEL_HEIGHT);

  const activeTerminal = useMemo(
    () => terminals.find((t) => t.id === activeId) || terminals[terminals.length - 1],
    [terminals, activeId]
  );

  const addTerminal = useCallback(() => {
    const newName = defaultShells[(nextTerminalId - 1) % defaultShells.length];
    const terminal = createTerminal(newName);
    setTerminals((prev) => [...prev, terminal]);
    setActiveId(terminal.id);
  }, []);

  // 拆分终端在 VS Code 风格下等价于新建一个终端并在右侧标签列表展示
  const splitActiveTerminal = useCallback(() => {
    addTerminal();
  }, [addTerminal]);

  const closeTerminal = useCallback(
    (id: string) => {
      // 只有一个终端时，直接收缩整个底部面板
      if (terminals.length === 1) {
        dispatch(toggleBottomPanel());
        return;
      }

      setTerminals((prev) => {
        const idx = prev.findIndex((t) => t.id === id);
        if (idx === -1) return prev;

        const next = prev.filter((t) => t.id !== id);
        if (activeId === id) {
          const nextActive = prev[idx - 1] || next[0];
          setActiveId(nextActive.id);
        }
        return next;
      });
    },
    [activeId, dispatch, terminals.length]
  );

  const toggleMaximize = useCallback(() => {
    setIsMaximized((prev) => {
      const next = !prev;
      if (next) {
        preMaximizeHeightRef.current = panelHeight;
      } else {
        setPanelHeight(preMaximizeHeightRef.current);
      }
      return next;
    });
  }, [panelHeight]);

  const closePanel = useCallback(() => {
    dispatch(toggleBottomPanel());
  }, [dispatch]);

  const startResizeHeight = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setResizingHeight(true);
    const startY = e.clientY;
    const startHeight = panelRef.current?.offsetHeight ?? DEFAULT_PANEL_HEIGHT;
    const maxHeight = window.innerHeight * MAX_PANEL_HEIGHT_RATIO;

    const handleMouseMove = (event: MouseEvent) => {
      const delta = startY - event.clientY;
      const nextHeight = Math.max(MIN_PANEL_HEIGHT, Math.min(maxHeight, startHeight + delta));
      setPanelHeight(nextHeight);
      if (isMaximized) {
        setIsMaximized(false);
      }
    };

    const handleMouseUp = () => {
      setResizingHeight(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [isMaximized]);

  const startResizeWidth = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setResizingWidth(true);
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const handleMouseMove = (event: MouseEvent) => {
      // 内容区在左、名称栏在右，向右拖动分隔线时内容区应扩大，名称栏应收窄
      const delta = startX - event.clientX;
      const nextWidth = Math.max(
        MIN_SIDEBAR_WIDTH,
        Math.min(MAX_SIDEBAR_WIDTH, startWidth + delta)
      );
      setSidebarWidth(nextWidth);
    };

    const handleMouseUp = () => {
      setResizingWidth(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [sidebarWidth]);

  const panelStyle = useMemo(() => {
    if (!bottomPanelVisible) return undefined;
    if (isMaximized) return { height: '100%' };
    return { height: panelHeight };
  }, [bottomPanelVisible, isMaximized, panelHeight]);

  return (
    <div
      ref={panelRef}
      className={`bottom-panel ${bottomPanelVisible ? 'is-visible' : ''} ${
        isMaximized ? 'is-maximized' : ''
      } ${resizingHeight || resizingWidth ? 'is-resizing' : ''}`}
      style={panelStyle}
    >
      <div
        className={`bottom-panel__resize-handle ${resizingHeight ? 'is-resizing' : ''}`}
        onMouseDown={startResizeHeight}
      />
      <div className="bottom-panel__header">
        <div className="bottom-panel__title">终端</div>
        <div className="bottom-panel__actions">
          <button
            className="bottom-panel__action-btn"
            onClick={addTerminal}
            title="新建终端"
          >
            <Plus size={12} strokeWidth={1.5} />
          </button>
          <button
            className="bottom-panel__action-btn"
            onClick={splitActiveTerminal}
            title="拆分终端"
          >
            <Columns2 size={12} strokeWidth={1.5} />
          </button>
          <button
            className="bottom-panel__action-btn"
            onClick={toggleMaximize}
            title={isMaximized ? '恢复' : '最大化'}
          >
            {isMaximized ? (
              <Minimize2 size={12} strokeWidth={1.5} />
            ) : (
              <Maximize2 size={12} strokeWidth={1.5} />
            )}
          </button>
          <button
            className="bottom-panel__action-btn"
            onClick={closePanel}
            title="关闭面板"
          >
            <X size={12} strokeWidth={1.5} />
          </button>
        </div>
      </div>
      <div className="bottom-panel__content">
        <div className="terminal-content">
          <span className="terminal-instance__prompt">{activeTerminal.name} $ </span>
          <span className="terminal-instance__cursor" />
        </div>
        <div
          className={`terminal-sidebar__resize-handle ${resizingWidth ? 'is-resizing' : ''}`}
          onMouseDown={startResizeWidth}
        />
        <div className="terminal-sidebar" style={{ width: sidebarWidth }}>
          {terminals.map((terminal) => (
            <div
              key={terminal.id}
              className={`terminal-tab ${terminal.id === activeId ? 'active' : ''}`}
              onClick={() => setActiveId(terminal.id)}
            >
              <Terminal size={12} strokeWidth={1.5} className="terminal-tab__icon" />
              <span className="terminal-tab__name">{terminal.name}</span>
              <button
                className="terminal-tab__close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTerminal(terminal.id);
                }}
                title="关闭终端"
              >
                <X size={10} strokeWidth={1.5} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default BottomPanel;
