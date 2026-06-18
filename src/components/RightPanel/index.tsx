import { useState, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X, Maximize2, Minimize2 } from 'lucide-react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { toggleRightPanel, setRightPanelMaximized } from '../../store/slices/layoutSlice';
import { notifyPanelResizeStart, notifyPanelResizeEnd } from '../../services/panelResizeNotifier';
import './RightPanel.css';

interface RightPanelTab {
  id: string;
  name: string;
}

let nextTabId = 1;

const DEFAULT_WIDTH = 260;
const MIN_WIDTH = 180;
const MAX_WIDTH_RATIO = 0.85;

const RightPanel = () => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const { rightPanelVisible, rightPanelMaximized } = useAppSelector((state) => state.layout);

  const createTab = useCallback(
    (name?: string): RightPanelTab => {
      const index = nextTabId++;
      return {
        id: `right-tab-${index}`,
        name: name || t('rightPanel.defaultTabName', { index }),
      };
    },
    [t]
  );

  const [tabs, setTabs] = useState<RightPanelTab[]>(() => [createTab('KIMI CODE')]);
  const [activeId, setActiveId] = useState<string>(tabs[0].id);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_WIDTH);
  const isMaximized = rightPanelMaximized;
  const [isResizing, setIsResizing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const preMaximizeWidthRef = useRef(DEFAULT_WIDTH);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeId) || tabs[tabs.length - 1],
    [tabs, activeId]
  );

  const addTab = useCallback(() => {
    const newTab = createTab();
    setTabs((prev) => [...prev, newTab]);
    setActiveId(newTab.id);
  }, [createTab]);

  const closeTab = useCallback(
    (tabId: string) => {
      setTabs((prev) => {
        // 只有一个标签时，直接收缩整个右侧面板
        if (prev.length === 1) {
          dispatch(toggleRightPanel());
          return prev;
        }

        const idx = prev.findIndex((tab) => tab.id === tabId);
        if (idx === -1) return prev;

        const next = prev.filter((tab) => tab.id !== tabId);
        // 如果关闭的是当前活跃 tab，自动切换到相邻 tab
        if (tabId === activeId) {
          const nextActive = prev[idx - 1] || next[0];
          setActiveId(nextActive.id);
        }
        return next;
      });
    },
    [activeId, dispatch]
  );

  const toggleMaximize = useCallback(() => {
    if (!isMaximized) {
      preMaximizeWidthRef.current = panelWidth;
      dispatch(setRightPanelMaximized(true));
    } else {
      setPanelWidth(preMaximizeWidthRef.current);
      dispatch(setRightPanelMaximized(false));
    }
  }, [dispatch, isMaximized, panelWidth]);

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      notifyPanelResizeStart();
      const startX = e.clientX;
      const startWidth = panelRef.current?.offsetWidth ?? panelWidth;
      const maxWidth = window.innerWidth * MAX_WIDTH_RATIO;

      const handleMouseMove = (event: MouseEvent) => {
        const delta = startX - event.clientX;
        const nextWidth = Math.max(MIN_WIDTH, Math.min(maxWidth, startWidth + delta));
        setPanelWidth(nextWidth);
        if (isMaximized) {
          dispatch(setRightPanelMaximized(false));
        }
      };

      const handleMouseUp = () => {
        setIsResizing(false);
        notifyPanelResizeEnd();
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
    [panelWidth, isMaximized, dispatch]
  );

  const panelStyle = useMemo(() => {
    if (!rightPanelVisible) return undefined;
    if (isMaximized) return undefined; // 最大化样式由 CSS .is-maximized 控制
    return { width: panelWidth };
  }, [rightPanelVisible, isMaximized, panelWidth]);

  return (
    <div
      ref={panelRef}
      className={`right-panel ${rightPanelVisible ? 'is-visible' : ''} ${
        isMaximized ? 'is-maximized' : ''
      } ${isResizing ? 'is-resizing' : ''}`}
      style={panelStyle}
    >
      <div className="right-panel__resize-handle" onMouseDown={startResize} />
      <div className="right-panel__tab-bar">
        <div className="right-panel__tabs">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`right-panel__tab ${tab.id === activeId ? 'active' : ''}`}
              onClick={() => setActiveId(tab.id)}
            >
              <span className="right-panel__tab-name">{tab.name}</span>
              <button
                className="right-panel__tab-close"
                title={t('rightPanel.closeTab')}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
              >
                <X size={10} strokeWidth={1.5} />
              </button>
            </div>
          ))}
        </div>
        <div className="right-panel__actions">
          <button
            className="right-panel__action-btn"
            onClick={addTab}
            title={t('rightPanel.addTab')}
          >
            <Plus size={12} strokeWidth={1.5} />
          </button>
          <button
            className="right-panel__action-btn"
            onClick={toggleMaximize}
            title={isMaximized ? t('rightPanel.restore') : t('rightPanel.maximize')}
          >
            {isMaximized ? (
              <Minimize2 size={12} strokeWidth={1.5} />
            ) : (
              <Maximize2 size={12} strokeWidth={1.5} />
            )}
          </button>
          <button
            className="right-panel__action-btn"
            onClick={() => dispatch(toggleRightPanel())}
            title={t('rightPanel.closePanel')}
          >
            <X size={12} strokeWidth={1.5} />
          </button>
        </div>
      </div>
      <div className="right-panel__content">
        <div className="right-panel__placeholder">{t('rightPanel.placeholder', { name: activeTab.name })}</div>
      </div>
    </div>
  );
};

export default RightPanel;
