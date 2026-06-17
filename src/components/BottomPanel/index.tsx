/**
 * BottomPanel — 终端面板（BrowserView 版）
 *
 * 终端渲染已迁移到独立的 Electron BrowserView 进程。
 * 本组件只负责：tab UI、占位 div、布局边界同步、状态管理。
 */

import { useState, useCallback, useMemo, useRef, useEffect, type ElementType } from 'react';
import {
  Plus, X, Trash2, Search, Bookmark, SplitSquareVertical,
  Maximize2, Minimize2, Terminal, ChevronDown,
  Wifi, WifiOff, Copy, ClipboardPaste, Sparkles,
  AlertCircle, PanelTopOpen, Bug, Plug, GitBranch,
} from 'lucide-react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { toggleBottomPanel, setBottomPanelVisible, switchBottomTab, type BottomTabId } from '../../store/slices/layoutSlice';
import {
  addTab, removeTab, setTabProcessId, setTabReady, setTabExited,
  setPanelVisible, setPanelHeight, toggleMaximize as toggleMaximizeAction,
  setSidebarWidth, splitPane, setActivePane, setActiveGroup,
  removeBookmark,
  setBroadcastMode, setProfiles,
  TerminalTab,
} from '../../store/slices/terminalSlice';
import { useTerminalFileTreeSync } from '../../services/terminalFileTreeSync';
import {
  createTerminal, disposeTerminal,
  listProfiles, onTerminalOutput,
  clearTerminal,
} from '../../services/terminalManager';
import {
  setTerminalViewBounds,
  focusTerminalView,
  setTerminalBroadcast,
} from '../../services/terminalViewManager';
import type { TerminalOutputEvent, TerminalProfile, TerminalViewBounds } from '../../types/electron';
import './BottomPanel.css';

/* ─── 常量 ─── */
const MIN_PANEL_HEIGHT = 100;
const MAX_PANEL_HEIGHT_RATIO = 0.85;

/* ─── 数据结构 ─── */
interface BottomTab {
  id: BottomTabId;
  name: string;
  icon: ElementType;
}

const bottomTabs: BottomTab[] = [
  { id: 'terminal', name: '终端', icon: Terminal },
  { id: 'problems', name: '问题', icon: AlertCircle },
  { id: 'output', name: '输出', icon: PanelTopOpen },
  { id: 'debug-console', name: '调试控制台', icon: Bug },
  { id: 'ports', name: '端口', icon: Plug },
  { id: 'gitlens', name: 'GITLENS', icon: GitBranch },
];

const BottomPanel = () => {
  const dispatch = useAppDispatch();
  const { bottomPanelVisible, activeBottomTab } = useAppSelector((s) => s.layout);
  const terminal = useAppSelector((s) => s.terminal);
  const rootSource = useAppSelector((s) => s.workspace.rootSource);

  /* ─── 派生数据 ─── */
  const activeGroup = useMemo(() => {
    return terminal.panelLayout.groups.find(
      g => g.id === terminal.panelLayout.activeGroupId
    );
  }, [terminal.panelLayout.activeGroupId, terminal.panelLayout.groups]);

  const activeTabIdMemo = useMemo((): string | undefined => {
    if (!activeGroup) return undefined;
    const activePane = activeGroup.panes.find(p => p.id === activeGroup.activePaneId);
    return activePane?.terminalId;
  }, [activeGroup]);

  const activeTab = activeTabIdMemo ? terminal.tabs[activeTabIdMemo] : undefined;

  const allTabs = useMemo(() => {
    const tabs: TerminalTab[] = [];
    for (const group of terminal.panelLayout.groups) {
      for (const pane of group.panes) {
        const tab = terminal.tabs[pane.terminalId];
        if (tab) tabs.push(tab);
      }
    }
    for (const tid of terminal.editorTerminals) {
      const tab = terminal.tabs[tid];
      if (tab && !tabs.find(t => t.id === tab.id)) {
        tabs.push(tab);
      }
    }
    return tabs;
  }, [terminal.panelLayout.groups, terminal.tabs, terminal.editorTerminals]);

  /* ─── 本地状态 ─── */
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [isResizing, setIsResizing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  /* ─── 占位 div 引用与 ResizeObserver ─── */
  const placeholderRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const resizeObservers = useRef<Map<string, ResizeObserver>>(new Map());

  /* ─── 稳定引用 ─── */
  const terminalStateRef = useRef(terminal);
  terminalStateRef.current = terminal;
  const activeTabIdRef = useRef(activeTabIdMemo);
  activeTabIdRef.current = activeTabIdMemo;
  const rootSourceRef = useRef(rootSource);
  rootSourceRef.current = rootSource;

  /* ─── 终端 ↔ 文件树联动 ─── */
  useTerminalFileTreeSync(activeTabIdMemo);

  /* ─── 初始化：加载 Shell Profile ─── */
  useEffect(() => {
    listProfiles().then((result) => {
      if (result.success && result.profiles) {
        const zshProfile = result.profiles.find(p => p.name === 'zsh');
        const bashProfile = result.profiles.find(p => p.name === 'bash');
        const defaultProfile = zshProfile || bashProfile || result.defaultShell || result.profiles[0];
        dispatch(setProfiles({
          profiles: result.profiles,
          defaultProfile,
        }));
      }
    });
  }, [dispatch]);

  /* ─── 面板可见性同步 + 自动创建首 Tab ─── */
  useEffect(() => {
    if (bottomPanelVisible && !terminal.panelVisible) {
      dispatch(setPanelVisible(true));
    }
    if (!bottomPanelVisible && terminal.panelVisible) {
      dispatch(setPanelVisible(false));
    }
    if ((bottomPanelVisible || terminal.panelVisible) && allTabs.length === 0) {
      handleCreateTab();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bottomPanelVisible]);

  /* ─── 监听终端输出（ready / exit）─── */
  useEffect(() => {
    const unsub = onTerminalOutput((event: TerminalOutputEvent) => {
      const state = terminalStateRef.current;
      let tabId: string | undefined;
      for (const [id, tab] of Object.entries(state.tabs)) {
        if (tab.processId === event.id) { tabId = id; break; }
      }
      if (!tabId) return;

      if (event.type === 'ready') {
        dispatch(setTabReady({ id: tabId, pid: event.pid || 0, cwd: event.cwd || '' }));
      } else if (event.type === 'exit') {
        dispatch(setTabExited({ id: tabId, exitCode: event.exitCode }));
      }
    });
    return () => { unsub(); };
  }, [dispatch]);

  /* ─── Tab 操作 ─── */
  const handleCreateTab = useCallback(async (profile?: TerminalProfile | null) => {
    const state = terminalStateRef.current;
    const profileToUse = profile || state.defaultProfile;
    const tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    dispatch(addTab({ id: tabId, name: profileToUse?.name, profile: profileToUse || undefined }));
    if (!state.panelVisible) dispatch(setPanelVisible(true));

    const cwd = typeof rootSourceRef.current === 'string' ? rootSourceRef.current : undefined;
    const result = await createTerminal({
      cwd,
      executable: profileToUse?.path,
      args: profileToUse?.args,
    });

    if (result.success && result.id) {
      dispatch(setTabProcessId({ id: tabId, processId: result.id }));
    } else {
      dispatch(setTabExited({ id: tabId, exitCode: -1 }));
    }
  }, [dispatch]);

  const handleCloseTab = useCallback((tabId: string) => {
    const tab = terminalStateRef.current.tabs[tabId];
    if (tab?.processId) {
      disposeTerminal(tab.processId);
    }
    dispatch(removeTab(tabId));
  }, [dispatch]);

  const handleSplitTab = useCallback(async () => {
    const state = terminalStateRef.current;
    const groupId = state.panelLayout.activeGroupId;
    if (!groupId) return;
    dispatch(splitPane({ groupId }));

    // splitPane 会创建新的 tab，为其创建 PTY + BrowserView
    requestAnimationFrame(() => {
      const nextState = terminalStateRef.current;
      const group = nextState.panelLayout.groups.find(g => g.id === groupId);
      const newPane = group?.panes.find(p => !nextState.tabs[p.terminalId]?.processId);
      if (newPane) {
        const tab = nextState.tabs[newPane.terminalId];
        const profile = tab?.profile || nextState.defaultProfile;
        const cwd = typeof rootSourceRef.current === 'string' ? rootSourceRef.current : undefined;
        createTerminal({ cwd, executable: profile?.path, args: profile?.args }).then((result) => {
          if (result.success && result.id) {
            dispatch(setTabProcessId({ id: newPane.terminalId, processId: result.id }));
          }
        });
      }
    });
  }, [dispatch]);

  const handleSwitchTab = useCallback((tabId: string) => {
    const state = terminalStateRef.current;
    for (const group of state.panelLayout.groups) {
      for (const pane of group.panes) {
        if (pane.terminalId === tabId) {
          dispatch(setActiveGroup(group.id));
          dispatch(setActivePane({ groupId: group.id, paneId: pane.id }));
          return;
        }
      }
    }
  }, [dispatch]);

  const handleSwitchBottomTab = useCallback((tabId: BottomTabId) => {
    dispatch(switchBottomTab(tabId));
  }, [dispatch]);

  /* ─── 面板尺寸 ─── */
  const panelHeightRef = useRef(terminal.panelHeight);
  panelHeightRef.current = terminal.panelHeight;

  const startResizeHeight = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    const startY = e.clientY;
    const startHeight = panelHeightRef.current;

    const handleMouseMove = (event: MouseEvent) => {
      const delta = startY - event.clientY;
      dispatch(setPanelHeight(Math.max(MIN_PANEL_HEIGHT,
        Math.min(window.innerHeight * MAX_PANEL_HEIGHT_RATIO, startHeight + delta))));
    };
    const handleMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [dispatch]);

  const sidebarWidthRef = useRef(terminal.sidebarWidth);
  sidebarWidthRef.current = terminal.sidebarWidth;

  const startResizeSidebar = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidthRef.current;

    const handleMouseMove = (event: MouseEvent) => {
      const delta = startX - event.clientX;
      dispatch(setSidebarWidth(Math.max(60, Math.min(400, startWidth + delta))));
    };
    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'ew-resize';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [dispatch]);

  /* ─── BrowserView 边界同步 ─── */
  const syncAllBounds = useCallback(() => {
    const state = terminalStateRef.current;
    const isTerminalTab = activeBottomTab === 'terminal';
    const panelVisible = bottomPanelVisible || state.panelVisible;
    const visibleTabIds = new Set<string>();

    for (const [tabId, element] of placeholderRefs.current.entries()) {
      const tab = state.tabs[tabId];
      if (!tab || !tab.processId) continue;

      const rect = element.getBoundingClientRect();
      const visible = panelVisible && isTerminalTab && rect.width > 0 && rect.height > 0;
      const bounds: TerminalViewBounds = {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        visible,
      };
      setTerminalViewBounds(tab.processId, bounds);
      if (visible) visibleTabIds.add(tabId);
    }

    // 当前未渲染的 tab（例如非活跃 group）需要隐藏，避免 BrowserView 残留覆盖 UI
    for (const tab of Object.values(state.tabs)) {
      if (tab.processId && !visibleTabIds.has(tab.id)) {
        setTerminalViewBounds(tab.processId, { x: 0, y: 0, width: 0, height: 0, visible: false });
      }
    }
  }, [activeBottomTab, bottomPanelVisible]);

  const observePlaceholder = useCallback((tabId: string, element: HTMLDivElement | null) => {
    const existing = resizeObservers.current.get(tabId);
    if (!element) {
      if (existing) { existing.disconnect(); resizeObservers.current.delete(tabId); }
      placeholderRefs.current.delete(tabId);
      return;
    }
    if (placeholderRefs.current.get(tabId) === element) return;
    if (existing) { existing.disconnect(); }

    placeholderRefs.current.set(tabId, element);
    const observer = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        syncAllBounds();
      });
    });
    observer.observe(element);
    resizeObservers.current.set(tabId, observer);

    // 初次同步
    requestAnimationFrame(() => syncAllBounds());
  }, [syncAllBounds]);

  // 关键状态变化时全量同步（切换 tab、显隐面板、最大化等）
  useEffect(() => {
    const raf = requestAnimationFrame(() => syncAllBounds());
    return () => cancelAnimationFrame(raf);
  }, [activeTabIdMemo, activeBottomTab, bottomPanelVisible, terminal.panelVisible, terminal.isMaximized, terminal.panelHeight, terminal.sidebarWidth, syncAllBounds]);

  // 窗口 resize 兜底
  useEffect(() => {
    const handleResize = () => syncAllBounds();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [syncAllBounds]);

  // 组件卸载时隐藏所有 BrowserView（面板关闭）
  useEffect(() => {
    return () => {
      for (const tab of Object.values(terminalStateRef.current.tabs)) {
        if (tab.processId) {
          setTerminalViewBounds(tab.processId, { x: 0, y: 0, width: 0, height: 0, visible: false });
        }
      }
    };
  }, []);

  /* ─── 快捷键 ─── */
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.ctrlKey && e.shiftKey && e.key === '`') {
      e.preventDefault(); dispatch(toggleBottomPanel());
    }
    if (e.ctrlKey && e.shiftKey && e.key === 'B') {
      e.preventDefault(); addCurrentBookmark();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ─── 搜索（Phase 2 再接入 BrowserView）─── */
  const handleSearch = useCallback(async () => {
    // TODO: 通过 terminalView.find 发送给当前 BrowserView
  }, []);

  const handleSearchPrev = useCallback(async () => {
    // TODO
  }, []);

  const closeSearch = useCallback(() => {
    setSearchVisible(false); setSearchTerm('');
  }, []);

  /* ─── 书签 ─── */
  const addCurrentBookmark = useCallback(() => {
    const tid = activeTabIdRef.current;
    if (!tid) return;
    // TODO: 从 BrowserView 获取当前行号
  }, []);

  const jumpToBookmark = useCallback((bookmarkLine: number) => {
    // TODO: 发送 scrollToLine 给 BrowserView
    void bookmarkLine;
  }, []);

  /* ─── 广播 ─── */
  const toggleBroadcast = useCallback(() => {
    const next = !terminalStateRef.current.broadcastMode;
    dispatch(setBroadcastMode(next));
    setTerminalBroadcast(next);
  }, [dispatch]);

  /* ─── 清屏/最大化 ─── */
  const handleClear = useCallback(() => {
    const state = terminalStateRef.current;
    const tab = activeTabIdRef.current ? state.tabs[activeTabIdRef.current] : undefined;
    if (tab?.processId && tab.processId > 0) clearTerminal(tab.processId);
  }, []);

  const handleToggleMaximize = useCallback(() => dispatch(toggleMaximizeAction()), [dispatch]);

  /* ─── 渲染 ─── */
  if (!bottomPanelVisible && !terminal.panelVisible) return null;

  return (
    <div
      ref={panelRef}
      className={`bottom-panel ${isResizing ? 'is-resizing' : ''}`}
      style={{ height: terminal.isMaximized ? '100%' : terminal.panelHeight }}
      onKeyDown={handleKeyDown}
    >
      <div className="bottom-panel__resize-handle" onMouseDown={startResizeHeight} />

      {/* 头部工具栏 */}
      <div className="bottom-panel__header">
        <div className="bottom-panel__tab-bar">
          {bottomTabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <div
                key={tab.id}
                className={`bottom-panel__tab ${tab.id === activeBottomTab ? 'active' : ''}`}
                onClick={() => handleSwitchBottomTab(tab.id)}
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
              <select
                className="bottom-panel__profile-select"
                value={activeTab?.profile?.name || terminal.defaultProfile?.name || ''}
                onChange={(e) => {
                  const name = e.target.value;
                  const profile = terminal.profiles.find(p => p.name === name);
                  if (profile) handleCreateTab(profile);
                }}
                title="选择 Shell 创建新终端"
              >
                <option value="" disabled>新建终端</option>
                {terminal.profiles.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                {terminal.profiles.length === 0 && <option value="">...</option>}
              </select>
              <button className="bottom-panel__btn" onClick={() => handleCreateTab()} title="新建终端">
                <Plus size={14} />
              </button>
              <button className="bottom-panel__btn" onClick={handleSplitTab} title="拆分终端">
                <SplitSquareVertical size={14} />
              </button>
              <button className={`bottom-panel__btn ${terminal.broadcastMode ? 'active' : ''}`} onClick={toggleBroadcast} title="广播模式">
                {terminal.broadcastMode ? <Wifi size={14} /> : <WifiOff size={14} />}
              </button>
              <button className="bottom-panel__btn" title="AI 分析（暂不可用）"><Sparkles size={14} /></button>
              <button className={`bottom-panel__btn ${searchVisible ? 'active' : ''}`} onClick={() => setSearchVisible(!searchVisible)} title="搜索">
                <Search size={14} />
              </button>
              <button className="bottom-panel__btn" title="复制（暂不可用）"><Copy size={14} /></button>
              <button className="bottom-panel__btn" title="粘贴（暂不可用）"><ClipboardPaste size={14} /></button>
              <button className="bottom-panel__btn" onClick={handleClear} title="清屏"><Trash2 size={14} /></button>
            </>
          )}
          <button className="bottom-panel__btn" onClick={handleToggleMaximize} title="最大化">
            {terminal.isMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button className="bottom-panel__btn" onClick={() => dispatch(setBottomPanelVisible(false))} title="关闭面板"><X size={14} /></button>
        </div>
      </div>

      {/* 终端 Tab：占位 div，实际渲染在 BrowserView 中 */}
      <div
        className="bottom-panel__tab-panel"
        style={{ display: activeBottomTab === 'terminal' ? 'flex' : 'none' }}
      >
        {/* 搜索栏 */}
        {searchVisible && (
          <div className="bottom-panel__search-bar">
            <input
              className="bottom-panel__search-input"
              placeholder="搜索..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  if (e.shiftKey) handleSearchPrev();
                  else handleSearch();
                } else if (e.key === 'Escape') {
                  closeSearch();
                }
              }}
              autoFocus
            />
            <button className="bottom-panel__btn" onClick={handleSearch}><ChevronDown size={14} /></button>
            <button className="bottom-panel__btn" onClick={handleSearchPrev}><ChevronDown size={14} style={{ transform: 'rotate(180deg)' }} /></button>
            <button className="bottom-panel__btn" onClick={closeSearch}><X size={14} /></button>
          </div>
        )}

        {/* 终端内容区：只有占位 div */}
        <div className="bottom-panel__content">
          <div className="terminal-content">
            {activeGroup?.panes.map((pane) => (
              <div
                key={pane.terminalId}
                ref={(el) => observePlaceholder(pane.terminalId, el)}
                className="terminal-view-placeholder"
                data-terminal-id={pane.terminalId}
              />
            ))}
            {!activeTabIdMemo && allTabs.length === 0 && (
              <div className="terminal-empty">
                <Terminal size={32} opacity={0.3} />
                <p>点击 + 创建终端</p>
              </div>
            )}
          </div>

          {/* 侧边栏 */}
          <div className="terminal-sidebar" style={{ width: terminal.sidebarWidth }}>
            <div className="terminal-sidebar__resize-handle" onMouseDown={startResizeSidebar} />
            <div className="terminal-sidebar__tabs">
              <div className="terminal-sidebar__section-title">终端</div>
              {allTabs.map(tab => (
                <div
                  key={tab.id}
                  className={`terminal-tab ${tab.id === activeTabIdMemo ? 'active' : ''} ${tab.exited ? 'exited' : ''}`}
                  onClick={() => {
                    handleSwitchTab(tab.id);
                    const t = terminalStateRef.current.tabs[tab.id];
                    if (t?.processId) focusTerminalView(t.processId);
                  }}
                  title={tab.name}
                >
                  <div className="terminal-tab__icon">
                    <span className={`terminal-tab__status ${tab.ready ? 'ready' : ''} ${tab.exited ? 'exited' : ''}`} />
                  </div>
                  <span className="terminal-tab__name">{tab.name}</span>
                  <div className="terminal-tab__actions">
                    <button className="terminal-tab__close" onClick={e => { e.stopPropagation(); handleCloseTab(tab.id); }}>
                      <X size={10} />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {activeTab && activeTab.bookmarks.length > 0 && (
              <div className="terminal-sidebar__bookmarks">
                <div className="terminal-sidebar__section-title">书签</div>
                {activeTab.bookmarks.map(bk => (
                  <div key={bk.id} className="terminal-bookmark" onClick={() => jumpToBookmark(bk.line)} title={`跳转到行 ${bk.line}`}>
                    <Bookmark size={12} />
                    <span className="terminal-bookmark__label">{bk.label}</span>
                    <button className="terminal-bookmark__remove" onClick={e => {
                      e.stopPropagation();
                      dispatch(removeBookmark({ tabId: activeTab.id, bookmarkId: bk.id }));
                    }}><X size={9} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 其他 Tab 占位 */}
      <div className="bottom-panel__placeholder" style={{ display: activeBottomTab === 'problems' ? 'flex' : 'none' }}>问题面板</div>
      <div className="bottom-panel__placeholder" style={{ display: activeBottomTab === 'output' ? 'flex' : 'none' }}>输出面板</div>
      <div className="bottom-panel__placeholder" style={{ display: activeBottomTab === 'debug-console' ? 'flex' : 'none' }}>调试控制台</div>
      <div className="bottom-panel__placeholder" style={{ display: activeBottomTab === 'ports' ? 'flex' : 'none' }}>端口面板</div>
      <div className="bottom-panel__placeholder" style={{ display: activeBottomTab === 'gitlens' ? 'flex' : 'none' }}>GITLENS</div>
    </div>
  );
};

export default BottomPanel;
