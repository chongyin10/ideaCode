import { useState, useCallback, useMemo, useRef } from 'react';
import {
  Plus,
  X,
  Columns2,
  Maximize2,
  Minimize2,
  Terminal,
  AlertCircle,
  PanelTopOpen,
  Bug,
  Plug,
  GitBranch,
} from 'lucide-react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import {
  toggleBottomPanel,
  switchBottomTab,
  type BottomTabId,
} from '../../store/slices/layoutSlice';
import './BottomPanel.css';

interface TerminalItem {
  id: string;
  name: string;
}

let nextTerminalId = 1;

const defaultShells = ['bash', 'zsh', 'fish', 'node', 'powershell'];

const createTerminal = (name?: string): TerminalItem => ({
  id: `terminal-${nextTerminalId++}`,
  name: name || `终端 ${nextTerminalId - 1}`,
});

interface BottomTab {
  id: BottomTabId;
  name: string;
  icon: React.ElementType;
}

const bottomTabs: BottomTab[] = [
  { id: 'terminal', name: '终端', icon: Terminal },
  { id: 'problems', name: '问题', icon: AlertCircle },
  { id: 'output', name: '输出', icon: PanelTopOpen },
  { id: 'debug-console', name: '调试控制台', icon: Bug },
  { id: 'ports', name: '端口', icon: Plug },
  { id: 'gitlens', name: 'GITLENS', icon: GitBranch },
];

const DEFAULT_PANEL_HEIGHT = 200;
const MIN_PANEL_HEIGHT = 120;
const MAX_PANEL_HEIGHT_RATIO = 0.85;

const DEFAULT_SIDEBAR_WIDTH = 120;
const MIN_SIDEBAR_WIDTH = 80;
const MAX_SIDEBAR_WIDTH = 400;

const BottomPanel = () => {
  const dispatch = useAppDispatch();
  const { bottomPanelVisible, activeBottomTab } = useAppSelector((state) => state.layout);

  // 终端相关状态（仅 terminal Tab 使用）
  const [terminals, setTerminals] = useState<TerminalItem[]>(() => [createTerminal('zsh')]);
  const [activeTerminalId, setActiveTerminalId] = useState<string>(terminals[0].id);
  const [panelHeight, setPanelHeight] = useState(DEFAULT_PANEL_HEIGHT);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [isMaximized, setIsMaximized] = useState(false);
  const [resizingHeight, setResizingHeight] = useState(false);
  const [resizingWidth, setResizingWidth] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const preMaximizeHeightRef = useRef(DEFAULT_PANEL_HEIGHT);

  const activeTerminal = useMemo(
    () => terminals.find((t) => t.id === activeTerminalId) || terminals[terminals.length - 1],
    [terminals, activeTerminalId]
  );

  const handleSwitchTab = useCallback(
    (tabId: BottomTabId) => {
      dispatch(switchBottomTab(tabId));
    },
    [dispatch]
  );

  const addTerminal = useCallback(() => {
    const newName = defaultShells[(nextTerminalId - 1) % defaultShells.length];
    const terminal = createTerminal(newName);
    setTerminals((prev) => [...prev, terminal]);
    setActiveTerminalId(terminal.id);
  }, []);

  const splitActiveTerminal = useCallback(() => {
    addTerminal();
  }, [addTerminal]);

  const closeTerminal = useCallback(
    (id: string) => {
      if (terminals.length === 1) {
        dispatch(toggleBottomPanel());
        return;
      }

      setTerminals((prev) => {
        const idx = prev.findIndex((t) => t.id === id);
        if (idx === -1) return prev;

        const next = prev.filter((t) => t.id !== id);
        if (activeTerminalId === id) {
          const nextActive = prev[idx - 1] || next[0];
          setActiveTerminalId(nextActive.id);
        }
        return next;
      });
    },
    [activeTerminalId, dispatch, terminals.length]
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

  const startResizeHeight = useCallback(
    (e: React.MouseEvent) => {
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
    },
    [isMaximized]
  );

  const startResizeWidth = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setResizingWidth(true);
      const startX = e.clientX;
      const startWidth = sidebarWidth;

      const handleMouseMove = (event: MouseEvent) => {
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
    },
    [sidebarWidth]
  );

  const panelStyle = useMemo(() => {
    if (!bottomPanelVisible) return undefined;
    if (isMaximized) return { height: '100%' };
    return { height: panelHeight };
  }, [bottomPanelVisible, isMaximized, panelHeight]);

  const renderTabContent = () => {
    switch (activeBottomTab) {
      case 'terminal':
        return (
          <>
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
                  className={`terminal-tab ${terminal.id === activeTerminalId ? 'active' : ''}`}
                  onClick={() => setActiveTerminalId(terminal.id)}
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
          </>
        );
      case 'problems':
        return <div className="panel-placeholder">问题面板</div>;
      case 'output':
        return <div className="panel-placeholder">输出面板</div>;
      case 'debug-console':
        return <div className="panel-placeholder">调试控制台</div>;
      case 'ports':
        return <div className="panel-placeholder">端口面板</div>;
      case 'gitlens':
        return <div className="panel-placeholder">GITLENS</div>;
      default:
        return null;
    }
  };

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
        <div className="bottom-panel__tab-bar">
          {bottomTabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <div
                key={tab.id}
                className={`bottom-panel__tab ${tab.id === activeBottomTab ? 'active' : ''}`}
                onClick={() => handleSwitchTab(tab.id)}
                title={tab.name}
              >
                <Icon size={12} strokeWidth={1.5} className="bottom-panel__tab-icon" />
                <span className="bottom-panel__tab-name">{tab.name}</span>
              </div>
            );
          })}
        </div>
        <div className="bottom-panel__actions">
          {activeBottomTab === 'terminal' && (
            <>
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
            </>
          )}
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
      <div className="bottom-panel__content">{renderTabContent()}</div>
    </div>
  );
};

export default BottomPanel;
