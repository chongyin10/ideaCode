import { useState, useEffect } from 'react';
import {
  Search,
  Settings,
  Minus,
  Square,
  X,
  PanelRight,
  PanelBottom,
} from 'lucide-react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { setSettingsVisible } from '../../store/slices/workspaceSlice';
import { toggleRightPanel, toggleBottomPanel } from '../../store/slices/layoutSlice';
import QuickOpen from '../QuickOpen';
import './TopBar.css';

/**
 * 自定义标题栏 / 工具栏
 *
 * 将原生系统标题栏（红色区域）与 IDE 工具栏（黄色区域）合并为一个统一工具栏。
 *
 * 设计要点：
 * - macOS：titleBarStyle='hidden'，系统 traffic lights 保留在左上角，
 *          工具栏左侧留出 80px 空间与之融合
 * - Windows/Linux：frame=false，完全无边框，右侧渲染自定义窗口控制按钮
 * - 标题栏主体为拖拽区域（-webkit-app-region: drag），按钮区域排除
 */
const TopBar = () => {
  const dispatch = useAppDispatch();
  const [quickOpenVisible, setQuickOpenVisible] = useState(false);
  const [, setIsMaximized] = useState(false);
  const rootName = useAppSelector((state) => state.workspace.rootName);
  const { rightPanelVisible, bottomPanelVisible } = useAppSelector((state) => state.layout);

  const platform = window.electronAPI?.platform || 'browser';
  const isMac = platform === 'darwin';
  const isElectron = !!window.electronAPI?.isElectron;

  // 全局快捷键：Ctrl+P / Cmd+P 打开 QuickOpen
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault();
        setQuickOpenVisible(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // 监听窗口最大化状态
  useEffect(() => {
    if (!isElectron) return;

    const unsub = window.electronAPI!.window.onStateChanged((data) => {
      setIsMaximized(data.state === 'maximized');
    });

    return () => unsub();
  }, [isElectron]);

  const handleMinimize = () => {
    window.electronAPI?.window.minimize();
  };

  const handleMaximize = () => {
    window.electronAPI?.window.maximize();
  };

  const handleClose = () => {
    window.electronAPI?.window.close();
  };

  return (
    <>
      {quickOpenVisible && <QuickOpen onClose={() => setQuickOpenVisible(false)} />}
      <div className={`topbar ${isMac ? 'topbar--mac' : ''}`}>
        {/* 左侧：macOS 留出 traffic lights 空间 */}
        <div className="topbar__left">
          <span className="topbar__brand">IDEACODE</span>
        </div>

        {/* 中间：搜索触发区域 */}
        <div className="topbar__center">
          <button
            className="topbar__search-trigger"
            onClick={() => setQuickOpenVisible(true)}
            title="搜索文件 (Ctrl+P)"
          >
            <Search size={12} strokeWidth={1.5} />
            <span>{rootName || 'IdeaCode'}</span>
          </button>
        </div>

        {/* 右侧：工具按钮 + Win/Linux 窗口控制 */}
        <div className="topbar__right">
          <button
            className="topbar__btn"
            aria-label="搜索"
            onClick={() => setQuickOpenVisible(true)}
          >
            <Search size={14} strokeWidth={1.5} />
          </button>
          <button
            className="topbar__btn"
            aria-label="设置"
            onClick={() => dispatch(setSettingsVisible(true))}
          >
            <Settings size={14} strokeWidth={1.5} />
          </button>
          <button
            className={`topbar__btn ${rightPanelVisible ? 'active' : ''}`}
            aria-label="切换右侧面板"
            onClick={() => dispatch(toggleRightPanel())}
            title="切换右侧面板"
          >
            <PanelRight size={14} strokeWidth={1.5} />
          </button>
          <button
            className={`topbar__btn ${bottomPanelVisible ? 'active' : ''}`}
            aria-label="切换底部面板"
            onClick={() => dispatch(toggleBottomPanel())}
            title="切换底部面板"
          >
            <PanelBottom size={14} strokeWidth={1.5} />
          </button>

          {/* Windows/Linux 自定义窗口控制按钮 */}
          {!isMac && isElectron && (
            <div className="window-controls">
              <button
                className="window-controls__btn"
                aria-label="最小化"
                onClick={handleMinimize}
              >
                <Minus size={12} strokeWidth={1.5} />
              </button>
              <button
                className="window-controls__btn"
                aria-label="最大化"
                onClick={handleMaximize}
              >
                <Square size={10} strokeWidth={1.5} />
              </button>
              <button
                className="window-controls__btn window-controls__btn--close"
                aria-label="关闭"
                onClick={handleClose}
              >
                <X size={12} strokeWidth={1.5} />
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default TopBar;
