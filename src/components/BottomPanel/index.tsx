/**
 * BottomPanel — 终端面板（DOM 版）
 *
 * 终端直接渲染在 React 主 DOM 中，不再使用独立的 BrowserView。
 * 本组件负责：tab UI、终端实例挂载/切换、状态管理。
 */

import { useState, useCallback, useMemo, useRef, useEffect, type ElementType } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plus, X, Trash2, Search, Bookmark, SplitSquareVertical,
  Maximize2, Minimize2, Terminal, ChevronDown,
  Wifi, WifiOff, Copy, ClipboardPaste, Sparkles,
  AlertCircle, PanelTopOpen, Bug, Plug, GitBranch, Pencil,
} from 'lucide-react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { toggleBottomPanel, setBottomPanelVisible, switchBottomTab, reorderBottomTab, type BottomTabId } from '../../store/slices/layoutSlice';
import {
  addTab, removeTab, setTabProcessId, setTabReady, setTabExited,
  setPanelVisible, setPanelHeight, toggleMaximize as toggleMaximizeAction,
  setSidebarWidth, splitPane, setActivePane, setActiveGroup,
  removeBookmark, renameTab, reorderTerminalTab,
  setBroadcastMode, setProfiles,
  TerminalTab,
} from '../../store/slices/terminalSlice';
import { useTerminalFileTreeSync } from '../../services/terminalFileTreeSync';
import {
  createTerminal, disposeTerminal,
  listProfiles, onTerminalOutput,
  clearTerminal, setTerminalBroadcastMode,
} from '../../services/terminalManager';
import { notifyPanelResizeStart, notifyPanelResizeEnd } from '../../services/panelResizeNotifier';
import TerminalInstance, { type TerminalInstanceHandle } from '../Terminal/TerminalInstance';
import ContextMenu, { type MenuItem } from '../ContextMenu';
import type { TerminalOutputEvent, TerminalProfile } from '../../types/electron';
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

const useBottomTabs = (): BottomTab[] => {
  const { t } = useTranslation();
  return useMemo(
    () => [
      { id: 'problems', name: t('bottomPanel.problems'), icon: AlertCircle },
      { id: 'output', name: t('bottomPanel.output'), icon: PanelTopOpen },
      { id: 'debug-console', name: t('bottomPanel.debugConsole'), icon: Bug },
      { id: 'terminal', name: t('bottomPanel.terminal'), icon: Terminal },
      { id: 'ports', name: t('bottomPanel.ports'), icon: Plug },
      { id: 'gitlens', name: t('bottomPanel.gitlens'), icon: GitBranch },
    ],
    [t]
  );
};

const BottomPanel = () => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const allBottomTabs = useBottomTabs();
  const { bottomPanelVisible, activeBottomTab, bottomTabOrder } = useAppSelector((s) => s.layout);
  const terminal = useAppSelector((s) => s.terminal);
  const rootSource = useAppSelector((s) => s.workspace.rootSource);

  // 按 bottomTabOrder 排序的 tab 列表
  const bottomTabs = useMemo(() => {
    const tabMap = new Map(allBottomTabs.map(t => [t.id, t]));
    return bottomTabOrder.map(id => tabMap.get(id)).filter((t): t is BottomTab => !!t);
  }, [allBottomTabs, bottomTabOrder]);

  // ── 底部 tab 拖拽重排状态 ──
  const [draggingBottomTab, setDraggingBottomTab] = useState<BottomTabId | null>(null);
  const [dragOverBottomTab, setDragOverBottomTab] = useState<BottomTabId | null>(null);
  const [dragOverBottomPos, setDragOverBottomPos] = useState<'before' | 'after'>('after');
  const draggingBottomTabRef = useRef<BottomTabId | null>(null);
  draggingBottomTabRef.current = draggingBottomTab;

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

  // 面板中所有终端 pane 的稳定列表：每个 TerminalInstance 在数组中位置不变，
  // 只通过 active/style/className 切换显示/隐藏，避免切换 tab 时 React 移动/重挂实例。
  const panelTabs = useMemo(() => {
    const activeGroupId = terminal.panelLayout.activeGroupId;
    return terminal.panelLayout.groups.flatMap((group) =>
      group.panes.map((pane) => ({
        id: pane.terminalId,
        relativeSize: pane.relativeSize,
        active: group.id === activeGroupId,
      }))
    );
  }, [terminal.panelLayout.groups, terminal.panelLayout.activeGroupId]);

  /* ─── 本地状态 ─── */
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [isResizing, setIsResizing] = useState(false);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);
  const terminalRefs = useRef<Map<string, TerminalInstanceHandle>>(new Map());

  // ── 终端 tab 拖拽重排状态 ──
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  const [dragOverPos, setDragOverPos] = useState<'before' | 'after'>('after');
  const draggingTabIdRef = useRef<string | null>(null);
  draggingTabIdRef.current = draggingTabId;

  const handleTabDragStart = useCallback((e: React.DragEvent, tabId: string) => {
    setDraggingTabId(tabId);
    draggingTabIdRef.current = tabId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tabId);
  }, []);

  const handleTabDrop = useCallback((e: React.DragEvent, tabId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!draggingTabIdRef.current) return;
    const fromId = draggingTabIdRef.current;
    if (fromId !== tabId) {
      dispatch(reorderTerminalTab({ fromId, toId: tabId, position: dragOverPos }));
    }
    setDraggingTabId(null);
    setDragOverTabId(null);
    draggingTabIdRef.current = null;
  }, [dispatch, dragOverPos]);

  const handleTabDragEnd = useCallback(() => {
    setDraggingTabId(null);
    setDragOverTabId(null);
    draggingTabIdRef.current = null;
  }, []);

  // ── 终端右键菜单 ──
  const [terminalContextMenu, setTerminalContextMenu] = useState<{ x: number; y: number; tabId: string; hasSelection: boolean } | null>(null);

  const handleTerminalContextMenu = useCallback((e: { x: number; y: number; hasSelection: boolean }, tabId: string) => {
    setTerminalContextMenu({ x: e.x, y: e.y, tabId, hasSelection: e.hasSelection });
  }, []);

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

  const terminalContextItems = useMemo<MenuItem[]>(() => {
    if (!terminalContextMenu) return [];
    const tabId = terminalContextMenu.tabId;
    const termRef = terminalRefs.current.get(tabId);
    const hasSel = terminalContextMenu.hasSelection;
    return [
      {
        id: 'new-terminal',
        label: t('bottomPanel.newTerminal'),
        icon: <Plus size={14} strokeWidth={1.5} />,
        group: 'terminal',
        onClick: () => handleCreateTab(),
      },
      {
        id: 'copy',
        label: t('bottomPanel.copy'),
        icon: <Copy size={14} strokeWidth={1.5} />,
        group: 'edit',
        disabled: !hasSel,
        onClick: () => {
          const sel = termRef?.getSelection() ?? '';
          if (sel) {
            navigator.clipboard.writeText(sel).catch(() => {});
            termRef?.clearSelection();
          }
        },
      },
      {
        id: 'paste',
        label: t('bottomPanel.paste'),
        icon: <ClipboardPaste size={14} strokeWidth={1.5} />,
        group: 'edit',
        onClick: () => {
          termRef?.paste();
        },
      },
      {
        id: 'select-all',
        label: t('bottomPanel.selectAll'),
        icon: <PanelTopOpen size={14} strokeWidth={1.5} />,
        group: 'edit',
        onClick: () => {
          termRef?.selectAll();
        },
      },
      {
        id: 'clear',
        label: t('bottomPanel.clear'),
        icon: <Trash2 size={14} strokeWidth={1.5} />,
        group: 'edit',
        onClick: () => {
          const state = terminalStateRef.current;
          const tab = state.tabs[tabId];
          if (tab?.processId && tab.processId > 0) clearTerminal(tab.processId);
        },
      },
    ];
  }, [terminalContextMenu, t, handleCreateTab]);

  const handleCloseTab = useCallback((tabId: string) => {
    const tab = terminalStateRef.current.tabs[tabId];
    if (tab?.processId) {
      disposeTerminal(tab.processId);
    }
    dispatch(removeTab(tabId));
  }, [dispatch]);

  const startRenameTab = useCallback((tabId: string) => {
    const tab = terminalStateRef.current.tabs[tabId];
    if (!tab) return;
    setEditingTabId(tabId);
    setEditingName(tab.name);
  }, []);

  const finishRenameTab = useCallback(() => {
    if (editingTabId) {
      const trimmed = editingName.trim();
      if (trimmed) {
        dispatch(renameTab({ id: editingTabId, name: trimmed }));
      }
    }
    setEditingTabId(null);
    setEditingName('');
  }, [editingTabId, editingName, dispatch]);

  const handleSplitTab = useCallback(async () => {
    const state = terminalStateRef.current;
    const groupId = state.panelLayout.activeGroupId;
    if (!groupId) return;
    dispatch(splitPane({ groupId }));

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

  // ── 底部 tab 拖拽重排 ──
  const handleBottomTabDragStart = useCallback((e: React.DragEvent, tabId: BottomTabId) => {
    setDraggingBottomTab(tabId);
    draggingBottomTabRef.current = tabId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tabId);
  }, []);

  const handleBottomTabDragOver = useCallback((e: React.DragEvent, tabId: BottomTabId) => {
    if (!draggingBottomTabRef.current || draggingBottomTabRef.current === tabId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    setDragOverBottomTab(tabId);
    setDragOverBottomPos(e.clientX < midX ? 'before' : 'after');
  }, []);

  const handleBottomTabDrop = useCallback((e: React.DragEvent, tabId: BottomTabId) => {
    e.preventDefault();
    e.stopPropagation();
    if (!draggingBottomTabRef.current) return;
    const fromId = draggingBottomTabRef.current;
    if (fromId !== tabId) {
      dispatch(reorderBottomTab({ fromId, toId: tabId, position: dragOverBottomPos }));
    }
    setDraggingBottomTab(null);
    setDragOverBottomTab(null);
    draggingBottomTabRef.current = null;
  }, [dispatch, dragOverBottomPos]);

  const handleBottomTabDragEnd = useCallback(() => {
    setDraggingBottomTab(null);
    setDragOverBottomTab(null);
    draggingBottomTabRef.current = null;
  }, []);

  /* ─── 面板尺寸 ─── */
  const panelHeightRef = useRef(terminal.panelHeight);
  panelHeightRef.current = terminal.panelHeight;

  const startResizeHeight = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    notifyPanelResizeStart();
    const startY = e.clientY;
    const startHeight = panelHeightRef.current;

    const handleMouseMove = (event: MouseEvent) => {
      const delta = startY - event.clientY;
      dispatch(setPanelHeight(Math.max(MIN_PANEL_HEIGHT,
        Math.min(window.innerHeight * MAX_PANEL_HEIGHT_RATIO, startHeight + delta))));
    };
    const handleMouseUp = () => {
      setIsResizing(false);
      notifyPanelResizeEnd();
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
    notifyPanelResizeStart();
    const startX = e.clientX;
    const startWidth = sidebarWidthRef.current;

    const handleMouseMove = (event: MouseEvent) => {
      const delta = startX - event.clientX;
      dispatch(setSidebarWidth(Math.max(60, Math.min(400, startWidth + delta))));
    };
    const handleMouseUp = () => {
      notifyPanelResizeEnd();
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'ew-resize';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [dispatch]);

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

  /* ─── 搜索 ─── */
  const handleSearch = useCallback(async () => {
    const ref = activeTabIdRef.current ? terminalRefs.current.get(activeTabIdRef.current) : undefined;
    if (ref && searchTerm) {
      await ref.find(searchTerm);
    }
  }, [searchTerm]);

  const handleSearchPrev = useCallback(async () => {
    const ref = activeTabIdRef.current ? terminalRefs.current.get(activeTabIdRef.current) : undefined;
    if (ref && searchTerm) {
      await ref.findPrevious(searchTerm);
    }
  }, [searchTerm]);

  const closeSearch = useCallback(() => {
    setSearchVisible(false); setSearchTerm('');
  }, []);

  /* ─── 书签 ─── */
  const addCurrentBookmark = useCallback(() => {
    const tid = activeTabIdRef.current;
    if (!tid) return;
    // TODO: 从 xterm 获取当前行号
  }, []);

  const jumpToBookmark = useCallback((bookmarkLine: number) => {
    // TODO: 滚动到指定行
    void bookmarkLine;
  }, []);

  /* ─── 广播 ─── */
  const toggleBroadcast = useCallback(() => {
    const next = !terminalStateRef.current.broadcastMode;
    dispatch(setBroadcastMode(next));
    setTerminalBroadcastMode(next);
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
                className={`bottom-panel__tab ${tab.id === activeBottomTab ? 'active' : ''} ${draggingBottomTab === tab.id ? 'bottom-panel__tab--dragging' : ''} ${dragOverBottomTab === tab.id ? `bottom-panel__tab--drag-over bottom-panel__tab--drag-${dragOverBottomPos}` : ''}`}
                draggable
                onDragStart={(e) => handleBottomTabDragStart(e, tab.id)}
                onDragOver={(e) => handleBottomTabDragOver(e, tab.id)}
                onDrop={(e) => handleBottomTabDrop(e, tab.id)}
                onDragEnd={handleBottomTabDragEnd}
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
                title={t('bottomPanel.selectShellTooltip')}
              >
                <option value="" disabled>{t('bottomPanel.newTerminal')}</option>
                {terminal.profiles.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                {terminal.profiles.length === 0 && <option value="">...</option>}
              </select>
              <button className="bottom-panel__btn" onClick={() => handleCreateTab()} title={t('bottomPanel.newTerminal')}>
                <Plus size={14} />
              </button>
              <button className="bottom-panel__btn" onClick={handleSplitTab} title={t('bottomPanel.splitTerminal')}>
                <SplitSquareVertical size={14} />
              </button>
              <button className={`bottom-panel__btn ${terminal.broadcastMode ? 'active' : ''}`} onClick={toggleBroadcast} title={t('bottomPanel.broadcastMode')}>
                {terminal.broadcastMode ? <Wifi size={14} /> : <WifiOff size={14} />}
              </button>
              <button className="bottom-panel__btn" title={t('bottomPanel.aiAnalyze')}><Sparkles size={14} /></button>
              <button className={`bottom-panel__btn ${searchVisible ? 'active' : ''}`} onClick={() => setSearchVisible(!searchVisible)} title={t('bottomPanel.search')}>
                <Search size={14} />
              </button>
              <button className="bottom-panel__btn" title={t('bottomPanel.copy')}><Copy size={14} /></button>
              <button className="bottom-panel__btn" title={t('bottomPanel.paste')}><ClipboardPaste size={14} /></button>
              <button className="bottom-panel__btn" onClick={handleClear} title={t('bottomPanel.clear')}><Trash2 size={14} /></button>
            </>
          )}
          <button className="bottom-panel__btn" onClick={handleToggleMaximize} title={terminal.isMaximized ? t('bottomPanel.restore') : t('bottomPanel.maximize')}>
            {terminal.isMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button className="bottom-panel__btn" onClick={() => dispatch(setBottomPanelVisible(false))} title={t('bottomPanel.closePanel')}><X size={14} /></button>
        </div>
      </div>

      {/* 终端 Tab */}
      <div
        className="bottom-panel__tab-panel"
        style={{ display: activeBottomTab === 'terminal' ? 'flex' : 'none' }}
      >
        {/* 搜索栏 */}
        {searchVisible && (
          <div className="bottom-panel__search-bar">
            <input
              className="bottom-panel__search-input"
              placeholder={t('bottomPanel.searchPlaceholder')}
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

        {/* 终端内容区 */}
        <div className="bottom-panel__content">
          <div className="terminal-content">
            {panelTabs.map((pane) => (
              <TerminalInstance
                key={pane.id}
                ref={(el) => {
                  if (el) terminalRefs.current.set(pane.id, el);
                  else terminalRefs.current.delete(pane.id);
                }}
                terminalId={pane.id}
                className={`terminal-pane ${pane.active ? 'terminal-pane--active' : 'terminal-pane--hidden'}`}
                style={pane.active ? { flex: pane.relativeSize } : undefined}
                active={pane.active}
                onContextMenu={(e) => handleTerminalContextMenu(e, pane.id)}
              />
            ))}
            {!activeTabIdMemo && allTabs.length === 0 && (
              <div className="terminal-empty">
                <Terminal size={32} opacity={0.3} />
                <p>{t('bottomPanel.empty')}</p>
              </div>
            )}
          </div>

          {/* 侧边栏 */}
          <div className="terminal-sidebar" style={{ width: terminal.sidebarWidth }}>
            <div className="terminal-sidebar__resize-handle" onMouseDown={startResizeSidebar} />
            <div
              className={`terminal-sidebar__tabs ${draggingTabId ? 'terminal-sidebar__tabs--dragging' : ''}`}
              onDragOver={(e) => {
                if (!draggingTabIdRef.current) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                // 计算最近的 tab 作为悬停目标（间隙也归属最近的 tab）
                const container = e.currentTarget;
                const children = Array.from(container.querySelectorAll<HTMLElement>('[data-tab-id]'));
                let bestId: string | null = null;
                let bestDist = Infinity;
                for (const child of children) {
                  const rect = child.getBoundingClientRect();
                  const midY = rect.top + rect.height / 2;
                  const dist = Math.abs(e.clientY - midY);
                  if (dist < bestDist) { bestDist = dist; bestId = child.dataset.tabId || null; }
                }
                if (bestId && bestId !== draggingTabIdRef.current) {
                  const targetChild = children.find(c => c.dataset.tabId === bestId);
                  if (targetChild) {
                    const rect = targetChild.getBoundingClientRect();
                    const midY = rect.top + rect.height / 2;
                    setDragOverTabId(bestId);
                    setDragOverPos(e.clientY < midY ? 'before' : 'after');
                  }
                } else if (bestId === draggingTabIdRef.current) {
                  setDragOverTabId(null);
                }
              }}
              onDrop={(e) => {
                if (dragOverTabId && draggingTabIdRef.current) {
                  handleTabDrop(e, dragOverTabId);
                } else {
                  e.preventDefault();
                  setDraggingTabId(null);
                  setDragOverTabId(null);
                  draggingTabIdRef.current = null;
                }
              }}
            >
              <div className="terminal-sidebar__section-title">{t('bottomPanel.terminals')}</div>
              {allTabs.map(tab => (
                <div
                  key={tab.id}
                  data-tab-id={tab.id}
                  className={`terminal-tab ${tab.id === activeTabIdMemo ? 'active' : ''} ${tab.exited ? 'exited' : ''} ${draggingTabId === tab.id ? 'terminal-tab--dragging' : ''} ${dragOverTabId === tab.id ? `terminal-tab--drag-over terminal-tab--drag-${dragOverPos}` : ''}`}
                  draggable
                  onDragStart={(e) => handleTabDragStart(e, tab.id)}
                  onDragEnd={handleTabDragEnd}
                  onClick={() => {
                    handleSwitchTab(tab.id);
                    terminalRefs.current.get(tab.id)?.focus();
                  }}
                  title={tab.name}
                >
                  <div className="terminal-tab__icon">
                    <span className={`terminal-tab__status ${tab.ready ? 'ready' : ''} ${tab.exited ? 'exited' : ''}`} />
                  </div>
                  {editingTabId === tab.id ? (
                    <input
                      className="terminal-tab__rename-input"
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      onBlur={() => finishRenameTab()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          finishRenameTab();
                        } else if (e.key === 'Escape') {
                          setEditingTabId(null);
                          setEditingName('');
                        }
                      }}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                    />
                  ) : (
                    <span className="terminal-tab__name">{tab.name}</span>
                  )}
                  <div className={`terminal-tab__actions ${editingTabId === tab.id ? 'is-editing' : ''}`}>
                    {editingTabId !== tab.id && (
                      <button
                        className="terminal-tab__edit"
                        title={t('bottomPanel.renameTooltip')}
                        onClick={(e) => { e.stopPropagation(); startRenameTab(tab.id); }}
                      >
                        <Pencil size={10} />
                      </button>
                    )}
                    {editingTabId !== tab.id && (
                      <button
                        className="terminal-tab__close"
                        onClick={(e) => { e.stopPropagation(); handleCloseTab(tab.id); }}
                      >
                        <X size={10} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {activeTab && activeTab.bookmarks.length > 0 && (
              <div className="terminal-sidebar__bookmarks">
                <div className="terminal-sidebar__section-title">{t('bottomPanel.bookmarks')}</div>
                {activeTab.bookmarks.map(bk => (
                  <div key={bk.id} className="terminal-bookmark" onClick={() => jumpToBookmark(bk.line)} title={t('bottomPanel.bookmarkLine', { line: bk.line })}>
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
      <div className="bottom-panel__placeholder" style={{ display: activeBottomTab === 'problems' ? 'flex' : 'none' }}>{t('bottomPanel.problemsPanel')}</div>
      <div className="bottom-panel__placeholder" style={{ display: activeBottomTab === 'output' ? 'flex' : 'none' }}>{t('bottomPanel.outputPanel')}</div>
      <div className="bottom-panel__placeholder" style={{ display: activeBottomTab === 'debug-console' ? 'flex' : 'none' }}>{t('bottomPanel.debugConsolePanel')}</div>
      <div className="bottom-panel__placeholder" style={{ display: activeBottomTab === 'ports' ? 'flex' : 'none' }}>{t('bottomPanel.portsPanel')}</div>
      <div className="bottom-panel__placeholder" style={{ display: activeBottomTab === 'gitlens' ? 'flex' : 'none' }}>GITLENS</div>

      {/* 终端右键菜单 */}
      {terminalContextMenu && (
        <ContextMenu
          items={terminalContextItems}
          x={terminalContextMenu.x}
          y={terminalContextMenu.y}
          visible={!!terminalContextMenu}
          onClose={() => setTerminalContextMenu(null)}
        />
      )}
    </div>
  );
};

export default BottomPanel;
