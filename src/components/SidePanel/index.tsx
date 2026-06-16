import { useRef, useState, useCallback } from 'react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import type { PanelId } from '../../store/slices/layoutSlice';
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
import './SidePanel.css';

const panelTitles: Record<PanelId, string> = {
  explorer: '资源管理器',
  search: '搜索',
  git: '源代码管理',
  debug: '运行和调试',
  extensions: '扩展',
};

const SidePanel = () => {
  const { sidePanelVisible, activePanel, sidePanelWidth } = useAppSelector((state) => state.layout);
  const dispatch = useAppDispatch();
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

  return (
    <div
      className={`side-panel ${sidePanelVisible ? 'is-visible' : ''} ${isResizing ? 'is-resizing' : ''}`}
      style={{ width: sidePanelVisible ? sidePanelWidth : 0 }}
    >
      <div className="side-panel__header">
        {activePanel ? panelTitles[activePanel] : '面板'}
      </div>
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
          <div className="panel-placeholder">运行和调试</div>
        </div>
        <div style={{ display: activePanel === 'extensions' ? 'block' : 'none', height: '100%' }}>
          <ExtensionsPanel />
        </div>
        <div style={{ display: activePanel ? 'none' : 'block', height: '100%' }}>
          <div className="panel-placeholder">选择一个视图</div>
        </div>
      </div>
      <div className="side-panel__resize-handle" onMouseDown={startResize} />
    </div>
  );
};

export default SidePanel;
