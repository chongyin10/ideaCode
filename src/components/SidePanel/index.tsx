import { useRef, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import {
  setSidePanelWidth,
  setSidePanelVisible,
  MIN_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
} from '../../store/slices/layoutSlice';
import WebViewPanel from '../WebViewPanel';
import { DockableContent } from '../DockableContent';
import './SidePanel.css';

const SidePanel = () => {
  const { t } = useTranslation();
  const { sidePanelVisible, activePanel, sidePanelWidth } = useAppSelector((state) => state.layout);
  const dockableItems = useAppSelector((state) => state.layout.dockableItems);
  const viewContainers = useAppSelector((state) => state.extensionUI.viewContainers);
  const webviewPanels = useAppSelector((state) => state.extensionUI.webviewPanels);
  const dispatch = useAppDispatch();

  const panelTitles = useMemo(() => {
    const titles: Record<string, string> = {
      explorer: t('sidePanel.explorer'),
      search: t('sidePanel.search'),
      git: t('sidePanel.sourceControl'),
      debug: t('sidePanel.runAndDebug'),
      extensions: t('sidePanel.extensions'),
    };
    for (const item of dockableItems) {
      titles[item.id] = t(item.title) || item.title;
    }
    for (const container of viewContainers) {
      titles[container.id] = container.title;
    }
    for (const panel of webviewPanels) {
      titles[panel.id] = panel.title;
    }
    return titles;
  }, [t, dockableItems, viewContainers, webviewPanels]);

  const [isResizing, setIsResizing] = useState(false);
  const isDraggingRef = useRef(false);

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (!sidePanelVisible) return;
      isDraggingRef.current = true;
      setIsResizing(true);
      const startX = e.clientX;
      const startWidth = sidePanelWidth;

      const handleMouseMove = (event: MouseEvent) => {
        if (!isDraggingRef.current) return;
        const newWidth = startWidth + (event.clientX - startX);
        if (newWidth < MIN_SIDEBAR_WIDTH) {
          isDraggingRef.current = false;
          dispatch(setSidePanelVisible(false));
          setIsResizing(false);
          cleanup();
        } else {
          dispatch(setSidePanelWidth(Math.min(MAX_SIDEBAR_WIDTH, newWidth)));
        }
      };

      const handleMouseUp = () => {
        isDraggingRef.current = false;
        setIsResizing(false);
        cleanup();
      };

      const cleanup = () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    },
    [dispatch, sidePanelVisible, sidePanelWidth],
  );

  const leftItems = useMemo(() => dockableItems.filter((i) => i.location === 'left'), [dockableItems]);
  const activeItem = leftItems.find((i) => i.id === activePanel);
  const activeWebViewPanel = webviewPanels.find((p) => p.id === activePanel);
  const isExtensionView = activeItem?.type === 'viewContainer';

  return (
    <div
      className={`side-panel ${sidePanelVisible ? 'is-visible' : ''} ${isResizing ? 'is-resizing' : ''}`}
      style={{ width: sidePanelVisible ? sidePanelWidth : 0 }}
    >
      {!isExtensionView && !activeWebViewPanel && (
        <div className="side-panel__header">
          {activePanel ? (panelTitles[activePanel] || activePanel) : t('sidePanel.noPanel')}
        </div>
      )}
      <div className="side-panel__content">
        {leftItems.map((item) => (
          <div
            key={item.id}
            style={{ display: activePanel === item.id ? 'block' : 'none', height: '100%' }}
          >
            <DockableContent item={item} />
          </div>
        ))}

        {/* 独立的 WebView 面板回退 */}
        {activeWebViewPanel && (
          <div style={{ display: 'block', height: '100%' }}>
            <WebViewPanel
              html={activeWebViewPanel.html}
              panelId={activeWebViewPanel.id}
              extensionPath={activeWebViewPanel.extensionPath}
            />
          </div>
        )}

        {!activeItem && !activeWebViewPanel && (
          <div style={{ display: 'block', height: '100%' }}>
            <div className="panel-placeholder">{t('sidePanel.selectView')}</div>
          </div>
        )}
      </div>
      <div className="side-panel__resize-handle" onMouseDown={startResize} />
      {isResizing && <div className="side-panel__resize-overlay" />}
    </div>
  );
};

export default SidePanel;
