import { useState, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Maximize2, Minimize2, History } from 'lucide-react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import {
  toggleRightPanel,
  setRightPanelMaximized,
  moveDockableItem,
  reorderDockableItem,
  switchRightItem,
  type DockLocation,
} from '../../store/slices/layoutSlice';
import { notifyPanelResizeStart, notifyPanelResizeEnd } from '../../services/panelResizeNotifier';
import { DockableContent, ExtensionViewActions } from '../DockableContent';
import { HistoryPopover } from './HistoryPopover';
import './RightPanel.css';

const DOCK_MIME = 'application/lifeai-dock-item';

const DEFAULT_WIDTH = 260;
const MIN_WIDTH = 180;
const MAX_WIDTH_RATIO = 0.85;

const RightPanel = () => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const { rightPanelVisible, rightPanelMaximized, dockableItems, activeRightItem } = useAppSelector((state) => state.layout);
  const views = useAppSelector((state) => state.extensionUI.views);

  const rightItems = useMemo(() => dockableItems.filter((i) => i.location === 'right'), [dockableItems]);
  const activeItem = useMemo(
    () => rightItems.find((i) => i.id === activeRightItem) || rightItems[0],
    [rightItems, activeRightItem]
  );

  // 当前激活面板自带的扩展 actions（如 LifeAiCode 的 newChat/history/config/readonly）
  const activeItemActions = useMemo(() => {
    if (activeItem?.type !== 'viewContainer' || !activeItem.sourceContainerId) return [];
    const containerViews = views.filter((v) => v.containerId === activeItem.sourceContainerId);
    // 目前一个 container 对应一个 view，取第一个的 actions
    return containerViews[0]?.actions || [];
  }, [activeItem, views]);

  const [panelWidth, setPanelWidth] = useState(DEFAULT_WIDTH);
  const isMaximized = rightPanelMaximized;
  const [isResizing, setIsResizing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const preMaximizeWidthRef = useRef(DEFAULT_WIDTH);
  const historyBtnRef = useRef<HTMLButtonElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  // ── tab 拖拽状态 ──
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  const [dragOverPos, setDragOverPos] = useState<'before' | 'after'>('after');
  const draggingTabIdRef = useRef<string | null>(null);
  draggingTabIdRef.current = draggingTabId;

  const buildDragData = (id: string, source: DockLocation) => JSON.stringify({ id, source });
  const readDragData = (e: React.DragEvent): { id: string; source: DockLocation } | null => {
    try {
      const data = e.dataTransfer.getData(DOCK_MIME);
      if (data) return JSON.parse(data);
    } catch { /* ignore */ }
    return null;
  };
  const hasDockData = (e: React.DragEvent) => e.dataTransfer.types.includes(DOCK_MIME);

  const handleTabDragStart = useCallback((e: React.DragEvent, tabId: string) => {
    setDraggingTabId(tabId);
    draggingTabIdRef.current = tabId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(DOCK_MIME, buildDragData(tabId, 'right'));
  }, []);

  const handleTabDragOver = useCallback((e: React.DragEvent, tabId: string) => {
    // dragover 阶段不能可靠读取 getData，改由 types 判断
    if (!hasDockData(e) || draggingTabIdRef.current === tabId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    setDragOverTabId(tabId);
    setDragOverPos(e.clientX < midX ? 'before' : 'after');
  }, []);

  const handleTabDrop = useCallback((e: React.DragEvent, tabId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const dragData = readDragData(e);
    if (!dragData) {
      resetDrag();
      return;
    }
    const fromId = dragData.id;
    if (fromId === tabId) {
      resetDrag();
      return;
    }
    if (dragData.source === 'right') {
      dispatch(reorderDockableItem({ fromId, toId: tabId, position: dragOverPos }));
    } else {
      dispatch(moveDockableItem({ id: fromId, targetLocation: 'right', targetId: tabId, position: dragOverPos }));
      dispatch(switchRightItem(fromId));
    }
    resetDrag();
  }, [dispatch, dragOverPos]);

  const handleContainerDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const dragData = readDragData(e);
    if (!dragData || dragData.source === 'right') {
      resetDrag();
      return;
    }
    // 在 tab-bar 空白处释放时，自动吸附到最近的 tab
    const container = e.currentTarget as HTMLElement;
    const children = Array.from(container.querySelectorAll<HTMLElement>('[data-tab-id]'));
    if (children.length === 0) {
      dispatch(moveDockableItem({ id: dragData.id, targetLocation: 'right' }));
    } else {
      let bestId: string | null = null;
      let bestPos: 'before' | 'after' = 'after';
      let bestDist = Infinity;
      for (const child of children) {
        const rect = child.getBoundingClientRect();
        const midX = rect.left + rect.width / 2;
        const dist = Math.abs(e.clientX - midX);
        if (dist < bestDist) {
          bestDist = dist;
          bestId = child.dataset.tabId || null;
          bestPos = e.clientX < midX ? 'before' : 'after';
        }
      }
      if (bestId && bestId !== dragData.id) {
        dispatch(moveDockableItem({ id: dragData.id, targetLocation: 'right', targetId: bestId, position: bestPos }));
      } else {
        dispatch(moveDockableItem({ id: dragData.id, targetLocation: 'right' }));
      }
    }
    dispatch(switchRightItem(dragData.id));
    resetDrag();
  }, [dispatch]);

  const handleTabDragEnd = useCallback(() => {
    resetDrag();
  }, []);

  const resetDrag = () => {
    setDraggingTabId(null);
    setDragOverTabId(null);
    draggingTabIdRef.current = null;
  };

  const closeTab = useCallback(
    (tabId: string) => {
      const idx = rightItems.findIndex((i) => i.id === tabId);
      if (rightItems.length === 1) {
        dispatch(toggleRightPanel());
        return;
      }
      dispatch(moveDockableItem({ id: tabId, targetLocation: 'bottom' }));
      if (activeRightItem === tabId) {
        const next = rightItems[idx - 1] || rightItems.find((i) => i.id !== tabId);
        if (next) dispatch(switchRightItem(next.id));
      }
    },
    [activeRightItem, dispatch, rightItems]
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
    [dispatch, isMaximized, panelWidth]
  );

  const panelStyle = useMemo(() => {
    if (!rightPanelVisible) return undefined;
    if (isMaximized) return undefined;
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
      <div
        className="right-panel__tab-bar"
        onDragOver={(e) => {
          // 只要拖的是 dock item 就允许进入容器，drop 时再按 source 处理
          if (hasDockData(e)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
          }
        }}
        onDrop={handleContainerDrop}
      >
        <div className="right-panel__tabs">
          {rightItems.map((item) => (
            <div
              key={item.id}
              data-tab-id={item.id}
              className={`right-panel__tab ${item.id === activeRightItem ? 'active' : ''} ${draggingTabId === item.id ? 'right-panel__tab--dragging' : ''} ${dragOverTabId === item.id ? `right-panel__tab--drag-over right-panel__tab--drag-${dragOverPos}` : ''}`}
              draggable
              onDragStart={(e) => handleTabDragStart(e, item.id)}
              onDragOver={(e) => handleTabDragOver(e, item.id)}
              onDrop={(e) => handleTabDrop(e, item.id)}
              onDragEnd={handleTabDragEnd}
              onClick={() => dispatch(switchRightItem(item.id))}
            >
              <span className="right-panel__tab-name">{t(item.title) || item.title}</span>
              <button
                className="right-panel__tab-close"
                title={t('rightPanel.closeTab')}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(item.id);
                }}
              >
                <X size={10} strokeWidth={1.5} />
              </button>
            </div>
          ))}
        </div>
        <div className="right-panel__actions">
          {activeItemActions.length > 0 && (
            <>
              <div className="right-panel__actions-group">
                <ExtensionViewActions
                  actions={activeItemActions}
                  renderAction={(action) => {
                    if (action.command !== 'lifeAiCode.showHistory') return null;
                    return (
                      <span className="right-panel__action-popover-anchor">
                        <button
                          ref={historyBtnRef}
                          className="extension-view__action-btn"
                          title={action.tooltip || action.title || action.command}
                          onClick={() => setHistoryOpen((v) => !v)}
                        >
                          <History size={14} strokeWidth={1.5} />
                        </button>
                        <HistoryPopover
                          open={historyOpen}
                          onClose={() => setHistoryOpen(false)}
                          anchorRef={historyBtnRef}
                        />
                      </span>
                    );
                  }}
                />
              </div>
              <div className="right-panel__actions-separator" />
            </>
          )}
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
        {activeItem ? (
          <DockableContent item={activeItem} showViewHeader={false} />
        ) : (
          <div className="right-panel__placeholder">{t('rightPanel.placeholder', { name: '' })}</div>
        )}
      </div>
    </div>
  );
};

export default RightPanel;
