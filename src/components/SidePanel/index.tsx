import { useRef, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import {
  setSidePanelWidth,
  setSidePanelVisible,
  MIN_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
} from '../../store/slices/layoutSlice';
import ExplorerContent from './ExplorerContent';
import SearchPanel from '../SearchPanel';
import ExtensionsPanel from '../ExtensionsPanel';
import SourceControlPanel from '../SourceControlPanel';
import WebViewPanel from '../WebViewPanel';
import './SidePanel.css';

const SidePanel = () => {
  const { t } = useTranslation();
  const { sidePanelVisible, activePanel, sidePanelWidth } = useAppSelector((state) => state.layout);
  const viewContainers = useAppSelector((state) => state.extensionUI.viewContainers);
  const views = useAppSelector((state) => state.extensionUI.views);
  const webviewPanels = useAppSelector((state) => state.extensionUI.webviewPanels);
  const dispatch = useAppDispatch();

  // 面板标题映射（固定面板 + 扩展视图容器）
  const panelTitles = useMemo(() => {
    const titles: Record<string, string> = {
      explorer: t('sidePanel.explorer'),
      search: t('sidePanel.search'),
      git: t('sidePanel.sourceControl'),
      debug: t('sidePanel.runAndDebug'),
      extensions: t('sidePanel.extensions'),
    };
    // 添加扩展视图容器的标题
    for (const container of viewContainers) {
      titles[container.id] = container.title;
    }
    // 添加 WebView 面板的标题
    for (const panel of webviewPanels) {
      titles[panel.id] = panel.title;
    }
    return titles;
  }, [t, viewContainers, webviewPanels]);

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
          // 拖到最小宽度以下时自动折叠，只保留 ActivityBar
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

  // 判断当前面板是否是扩展视图容器
  const isExtensionViewContainer = viewContainers.some((c) => c.id === activePanel);
  
  // 判断当前面板是否是 WebView 面板
  const activeWebViewPanel = webviewPanels.find((p) => p.id === activePanel);

  // 获取当前激活的视图（如果是扩展视图容器）
  const activeViews = views.filter((v) => v.containerId === activePanel);

  return (
    <div
      className={`side-panel ${sidePanelVisible ? 'is-visible' : ''} ${isResizing ? 'is-resizing' : ''}`}
      style={{ width: sidePanelVisible ? sidePanelWidth : 0 }}
    >
      {/* 扩展视图/WebView 自身带有标题栏，不需要再显示侧栏标题 */}
      {!isExtensionViewContainer && !activeWebViewPanel && (
        <div className="side-panel__header">
          {activePanel ? (panelTitles[activePanel] || activePanel) : t('sidePanel.noPanel')}
        </div>
      )}
      <div className="side-panel__content">
        {/* 所有面板同时存在，通过 CSS display 切换可见性。
           这样可以保留各面板的组件状态（如搜索内容、展开目录等），
           避免切换面板时组件卸载导致的状态丢失。 */}
        <div style={{ display: activePanel === 'explorer' ? 'block' : 'none', height: '100%' }}>
          <ExplorerContent />
        </div>
        <div style={{ display: activePanel === 'search' ? 'block' : 'none', height: '100%' }}>
          <SearchPanel />
        </div>
        <div style={{ display: activePanel === 'git' ? 'block' : 'none', height: '100%' }}>
          <SourceControlPanel />
        </div>
        <div style={{ display: activePanel === 'debug' ? 'block' : 'none', height: '100%' }}>
          <div className="panel-placeholder">{t('sidePanel.runAndDebug')}</div>
        </div>
        <div style={{ display: activePanel === 'extensions' ? 'block' : 'none', height: '100%' }}>
          <ExtensionsPanel />
        </div>
        
        {/* 扩展视图容器面板 */}
        {isExtensionViewContainer && (
          <div style={{ display: 'block', height: '100%' }}>
            {activeViews.length > 0 ? (
              <div className="extension-views">
                {activeViews.map((view) => (
                  <div key={view.id} className="extension-view">
                    <div className="extension-view__header">{view.name}</div>
                    <div className="extension-view__content">
                      {/* 查找对应的 WebView 面板 */}
                      {(() => {
                        const webview = webviewPanels.find(
                          (p) => p.viewType === view.id || p.id.startsWith(`webview-${view.id}`)
                        );
                        if (webview) {
                          return <WebViewPanel html={webview.html} panelId={webview.id} extensionPath={webview.extensionPath} />;
                        }
                        return <div className="panel-placeholder">{view.name}</div>;
                      })()}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="panel-placeholder">{panelTitles[activePanel] || activePanel}</div>
            )}
          </div>
        )}
        
        {/* 独立的 WebView 面板 */}
        {activeWebViewPanel && (
          <div style={{ display: 'block', height: '100%' }}>
            <WebViewPanel html={activeWebViewPanel.html} panelId={activeWebViewPanel.id} extensionPath={activeWebViewPanel.extensionPath} />
          </div>
        )}
        
        <div style={{ display: activePanel ? 'none' : 'block', height: '100%' }}>
          <div className="panel-placeholder">{t('sidePanel.selectView')}</div>
        </div>
      </div>
      <div className="side-panel__resize-handle" onMouseDown={startResize} />
      {isResizing && <div className="side-panel__resize-overlay" />}
    </div>
  );
};

export default SidePanel;
