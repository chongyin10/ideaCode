import { useAppSelector } from '../../store/hooks';
import type { PanelId } from '../../store/slices/layoutSlice';
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
  const { sidePanelVisible, activePanel } = useAppSelector((state) => state.layout);

  return (
    <div className={`side-panel ${sidePanelVisible ? 'is-visible' : ''}`}>
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
    </div>
  );
};

export default SidePanel;
