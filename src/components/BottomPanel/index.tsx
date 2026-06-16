/**
 * BottomPanel — 终端面板
 *
 * 已修复的 Bug 清单：
 * BUG-1:  useTerminalFileTreeSync 现在在 activeTabIdMemo 之后调用
 * BUG-2:  onTerminalOutput 使用 useRef 避免重复注册
 * BUG-3:  initTerminalForTab 使用 useRef 避免闭包过期
 * BUG-4/18: panelVisible ↔ bottomPanelVisible 同步
 * BUG-5/6/19: ref 回调改为 useEffect + containerRefs Map
 * BUG-7:  resize 回调使用 ref 捕获当前高度
 * BUG-8:  sidebar 布局使用绝对定位
 * BUG-9:  未使用的 broadcastToOthers 别名移除
 * BUG-10: handleKeyDown 的 addCurrentBookmark 依赖处理
 * BUG-11: allTabs 包含 editorTerminals
 * BUG-12: getActiveTabId 使用 useMemo 代替 useCallback
 * BUG-13: Profile 选择器默认只显示信息，支持创建新 Tab
 * BUG-14: TerminalEditorInput 进程清理加 race condition 防护
 * BUG-15: tabBarWidth 保留（编辑器终端 TabBar 可用）
 * BUG-16: resize abort 时恢复 cursor（已正确处理）
 * BUG-17: switchToTab 合并为单次 dispatch
 * BUG-20: 内存管理器集成
 */

import { useState, useCallback, useMemo, useRef, useEffect, type ElementType } from 'react';
import { Plus, X, Trash2, Search, Bookmark, SplitSquareVertical,
         Maximize2, Minimize2, Terminal, ChevronDown, Zap,
         Wifi, WifiOff, Copy, ClipboardPaste, Sparkles,
         AlertCircle, PanelTopOpen, Bug, Plug, GitBranch } from 'lucide-react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { toggleBottomPanel, setBottomPanelVisible, switchBottomTab, type BottomTabId } from '../../store/slices/layoutSlice';
import {
  addTab, removeTab, setTabProcessId, setTabReady, setTabExited,
  setPanelVisible, setPanelHeight, toggleMaximize as toggleMaximizeAction,
  setSidebarWidth, splitPane, setActivePane, setActiveGroup,
  addBookmark, removeBookmark,
  setBroadcastMode, setProfiles,
  TerminalTab,
} from '../../store/slices/terminalSlice';
import { XtermTerminal } from './xtermInstance';
import {
  createTerminal, disposeTerminal, sendInput, resizeTerminal,
  listProfiles, onTerminalOutput,
  clearTerminal,
  detectAnomaly, updateAIContext, getAIContext,
} from '../../services/terminalManager';
import { useTerminalFileTreeSync } from '../../services/terminalFileTreeSync';
import { terminalMemoryManager } from '../../services/terminalMemoryManager';
import { goldenSplit } from '../../services/terminalMath';
import TerminalInlineEditor from './TerminalInlineEditor';
import type { TerminalOutputEvent, TerminalProfile } from '../../types/electron';
import '@xterm/xterm/css/xterm.css';
import './BottomPanel.css';

/* ─── 常量 ─── */
const MIN_PANEL_HEIGHT = 100;
const MAX_PANEL_HEIGHT_RATIO = 0.85;

/* ─── 数据结构 ─── */
interface ActiveXtermInstance {
  xterm: XtermTerminal;
  processId: number;
}

// ====================================================================
//  BottomPanel 组件
// ====================================================================
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

  /* ─── 派生数据（useMemo 在最前面，避免顺序 bug） ─── */

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
    // 面板中的 Tab
    for (const group of terminal.panelLayout.groups) {
      for (const pane of group.panes) {
        const tab = terminal.tabs[pane.terminalId];
        if (tab) tabs.push(tab);
      }
    }
    // 编辑器区域中的 Tab
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
  const [inlineEditorVisible, setInlineEditorVisible] = useState(false);
  const [inlineEditorInitial, setInlineEditorInitial] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);

  /* ─── xterm 实例管理（useRef 避免闭包过期） ─── */
  const xtermInstances = useRef<Map<string, ActiveXtermInstance>>(new Map());
  const containerRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  /* ─── 数学优化：Kalman 滤波器 + 指数退避 — 尺寸平滑 (优化 #5, #6) ─── */

  const resizeObservers = useRef<Map<string, ResizeObserver>>(new Map());
  const observedElements = useRef<Map<string, HTMLElement>>(new Map());

  /* ─── 稳定引用（通过 ref 避免 stale closure） ─── */
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
        // 默认优先 zsh，其次使用主进程返回的 defaultShell，最后取第一个可用 shell
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
    // 当面板打开且无 Tab 时，自动创建
    if ((bottomPanelVisible || terminal.panelVisible) && allTabs.length === 0) {
      handleCreateTab();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bottomPanelVisible]);

  /* ─── 监听终端输出（只注册一次） ─── */
  useEffect(() => {
    const unsub = onTerminalOutput((event: TerminalOutputEvent) => {
      // 通过 ref 访问最新状态
      const state = terminalStateRef.current;

      let tabId: string | undefined;
      for (const [id, tab] of Object.entries(state.tabs)) {
        if (tab.processId === event.id) { tabId = id; break; }
      }
      if (!tabId) return;

      const instance = xtermInstances.current.get(tabId);
      if (!instance?.xterm) return;

      if (event.type === 'data' && event.data) {
        instance.xterm.write(event.data);
      } else if (event.type === 'ready') {
        dispatch(setTabReady({ id: tabId, pid: event.pid || 0, cwd: event.cwd || '' }));
      } else if (event.type === 'exit') {
        dispatch(setTabExited({ id: tabId, exitCode: event.exitCode }));
        instance.xterm.write(`\r\n\x1b[33m[进程已退出，退出码: ${event.exitCode}]\x1b[0m\r\n`);
      }
    });
    return () => { unsub(); };
  }, [dispatch]); // dispatch 是稳定的，不需要其他 deps

  /* ─── Tab 操作 ─── */

  const handleCreateTab = useCallback(async (profile?: TerminalProfile | null) => {
    const state = terminalStateRef.current;
    const profileToUse = profile || state.defaultProfile;
    dispatch(addTab({ name: profileToUse?.name, profile: profileToUse || undefined }));
    if (!state.panelVisible) dispatch(setPanelVisible(true));
  }, [dispatch]);

  const handleCloseTab = useCallback((tabId: string) => {
    const instance = xtermInstances.current.get(tabId);
    if (instance) {
      if (instance.processId) disposeTerminal(instance.processId);
      instance.xterm.dispose();
      xtermInstances.current.delete(tabId);
      containerRefs.current.delete(tabId);
      terminalMemoryManager.dispose(tabId);
    }
    dispatch(removeTab(tabId));
  }, [dispatch]);

  const handleSplitTab = useCallback(() => {
    const state = terminalStateRef.current;
    const groupId = state.panelLayout.activeGroupId;
    if (groupId) {
      const group = state.panelLayout.groups.find(g => g.id === groupId);
      // 数学优化 #12: 二分屏使用黄金比例而非均分
      if (group && group.panes.length === 1) {
        const [main, sub] = goldenSplit();
        dispatch(splitPane({ groupId, ratios: [main, sub] }));
      } else {
        dispatch(splitPane({ groupId }));
      }
    }
  }, [dispatch]);

  /* ─── Tab 切换 (记录统计) ─── */
  const handleSwitchTab = useCallback((tabId: string) => {
    const prev = activeTabIdRef.current;
    const state = terminalStateRef.current;
    // 记录统计并触发内存管理预解冻
    terminalMemoryManager.switchActive(tabId, prev || undefined);
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
  /** 是否正在拖拽侧边栏 — 拖拽期间只做视觉 resize，延迟 PTY 同步 */
  const isDraggingSidebar = useRef(false);

  const startResizeSidebar = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidthRef.current;
    isDraggingSidebar.current = true;
    // 开始拖拽时取消所有待执行的 PTY resize，避免拖拽中旧定时器触发
    pendingPtyResizes.current.forEach((timer) => clearTimeout(timer));
    pendingPtyResizes.current.clear();

    const handleMouseMove = (event: MouseEvent) => {
      const delta = startX - event.clientX;
      dispatch(setSidebarWidth(Math.max(60, Math.min(400, startWidth + delta))));
    };
    const handleMouseUp = () => {
      isDraggingSidebar.current = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';

      // 拖拽结束：立即清空所有待执行的 PTY resize，并强制同步全部可见终端
      pendingPtyResizes.current.forEach((timer) => clearTimeout(timer));
      pendingPtyResizes.current.clear();

      xtermInstances.current.forEach(({ xterm }, tid) => {
        xterm.fit();
        const tab = terminalStateRef.current.tabs[tid];
        if (tab?.processId && tab.processId > 0) {
          resizeTerminal(tab.processId, xterm.raw.cols, xterm.raw.rows);
          lastPtySize.current.set(tid, { cols: xterm.raw.cols, rows: xterm.raw.rows });
          lastPtyResizeTime.current.set(tid, Date.now());
        }
      });
    };
    document.body.style.cursor = 'ew-resize';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [dispatch]);

  /* ─── ResizeObserver 绑定到每个 pane 容器 ─── */
  const setupResizeObserver = useCallback((tabId: string, element: HTMLDivElement | null) => {
    const existing = resizeObservers.current.get(tabId);
    if (!element) {
      if (existing) { existing.disconnect(); resizeObservers.current.delete(tabId); }
      observedElements.current.delete(tabId);
      return;
    }
    if (observedElements.current.get(tabId) === element) return;
    if (existing) { existing.disconnect(); }
    observedElements.current.set(tabId, element);

    let rafId = 0;
    const observer = new ResizeObserver(() => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        const inst = xtermInstances.current.get(tabId);
        if (!inst?.xterm) return;
        inst.xterm.fit();

        // 拖拽终端侧边栏期间：只视觉 resize，PTY 延迟到 mouseup
        if (isDraggingSidebar.current) return;

        const tab = terminalStateRef.current.tabs[tabId];
        if (tab?.processId && tab.processId > 0) {
          resizeTerminal(tab.processId, inst.xterm.raw.cols, inst.xterm.raw.rows);
        }
      });
    });

    observer.observe(element);
    resizeObservers.current.set(tabId, observer);
  }, []);

  /* ─── 终端挂载（通过 containerRefs + useEffect 避免 ref 回调重复问题） ─── */

  const mountTerminal = useCallback(async (tabId: string, container: HTMLDivElement, autoFocus = true) => {
    const state = terminalStateRef.current;
    const tab = state.tabs[tabId];
    if (!tab) return;

    containerRefs.current.set(tabId, container);

    // 容器尚未获得实际尺寸（例如父级 display:none），跳过初始化，等待激活时重试
    if (container.clientWidth === 0 || container.clientHeight === 0) {
      console.log(`[Terminal] ${tabId} 容器尺寸为 0，延迟初始化`);
      return;
    }

    // 若已有实例且仍挂载在当前容器，直接自适应/聚焦即可
    const existing = xtermInstances.current.get(tabId);
    if (existing?.xterm) {
      const element = existing.xterm.raw.element;
      if (element && element.parentElement === container) {
        existing.xterm.fit();
        if (autoFocus) existing.xterm.focus();
        return;
      }
      // 容器被重建（例如 React 重新挂载或切换 Group），释放旧 xterm，保留 PTY 复用
      try { existing.xterm.dispose(); } catch { /* 忽略 dispose 异常 */ }
      xtermInstances.current.delete(tabId);
      terminalMemoryManager.dispose(tabId);
    }

    const settings = state.settings;
    const xterm = new XtermTerminal({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      cursorStyle: settings.cursorStyle,
      cursorBlink: settings.cursorBlinking,
      scrollback: settings.scrollback,
      gpuAcceleration: settings.gpuAcceleration,
    });

    xterm.open(container);

    // 若所有字体已就绪，立即 fit；否则等待最多 200ms
    const fontsReady = typeof document !== 'undefined' && document.fonts && document.fonts.ready;
    if (fontsReady) {
      const alreadyLoaded = (document as any).fonts?.status === 'loaded';
      if (!alreadyLoaded) {
        try {
          await Promise.race([
            document.fonts.ready,
            new Promise((resolve) => setTimeout(resolve, 200)),
          ]);
        } catch { /* ignore */ }
      }
    }
    // 等下一帧布局稳定后 fit
    await new Promise((resolve) => requestAnimationFrame(resolve));
    xterm.fit();
    if (autoFocus) xterm.focus();

    console.log(`[Terminal] ${tabId} 容器 ${container.clientWidth}x${container.clientHeight} -> xterm ${xterm.raw.cols}x${xterm.raw.rows}`);

    // 注册到内存管理器
    terminalMemoryManager.registerActive(tabId, xterm);

    // 键盘输入
    xterm.raw.onData((data) => {
      const currState = terminalStateRef.current;
      const currTab = currState.tabs[tabId];
      if (!currTab?.processId || currTab.exited) return;
      sendInput(currTab.processId, data);

      if (data === '\r') updateAIContext({ lastExitCode: undefined });
      updateAIContext({ lastLine: data });
    });

    // 右键菜单
    xterm.raw.element?.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (xterm.hasSelection()) {
        navigator.clipboard.writeText(xterm.getSelection()).catch(() => {});
        xterm.clearSelection();
      } else {
        navigator.clipboard.readText().then(text => {
          const currTab = terminalStateRef.current.tabs[tabId];
          if (currTab?.processId && !currTab.exited) {
            sendInput(currTab.processId, text);
          }
        }).catch(() => {});
      }
    });

    // 创建或复用 PTY
    let processId = tab.processId || 0;
    if (!processId || processId <= 0) {
      const profile = tab.profile || state.defaultProfile;
      const cwd = typeof rootSourceRef.current === 'string' ? rootSourceRef.current : undefined;
      const result = await createTerminal({
        cwd,
        executable: profile?.path,
        args: profile?.args,
        cols: xterm.raw.cols,
        rows: xterm.raw.rows,
      });

      if (result.success && result.id) {
        processId = result.id;
        dispatch(setTabProcessId({ id: tabId, processId: result.id }));
      } else {
        xtermInstances.current.set(tabId, { xterm, processId: -1 });
        xterm.write(`\r\n\x1b[31m[终端启动失败] ${result.error || '无法创建 PTY 进程'}\x1b[0m\r\n`);
        return;
      }
    }

    xtermInstances.current.set(tabId, { xterm, processId });
    if (processId > 0) {
      // PTY 创建完成后以当前容器尺寸同步
      xterm.fit();
      resizeTerminal(processId, xterm.raw.cols, xterm.raw.rows);
    }
  }, [dispatch]);

  // 当 activeTabId 变化时，检查是否需要挂载
  useEffect(() => {
    const tabId = activeTabIdMemo;
    if (!tabId) return;
    const container = containerRefs.current.get(tabId);
    if (container) {
      mountTerminal(tabId, container, true);
    }
  }, [activeTabIdMemo, mountTerminal]);

  /* ─── 分屏 pane 挂载 ─── */
  useEffect(() => {
    for (const group of terminal.panelLayout.groups) {
      for (const pane of group.panes) {
        const container = containerRefs.current.get(pane.terminalId);
        if (container) {
          mountTerminal(pane.terminalId, container, false);
        }
      }
    }
  }, [terminal.panelLayout.groups, mountTerminal]);

  /* ─── 终端 Tab 显示/激活时自适应并聚焦 ─── */
  useEffect(() => {
    if (activeBottomTab !== 'terminal' || (!bottomPanelVisible && !terminal.panelVisible)) return;
    const tabId = activeTabIdMemo;
    if (!tabId) return;

    const instance = xtermInstances.current.get(tabId);
    const container = containerRefs.current.get(tabId);

    // 延迟一帧，确保容器已完成 display 切换并获得实际尺寸
    const rafId = requestAnimationFrame(() => {
      if (!instance?.xterm && container) {
        // 之前因容器不可见跳过初始化，现在可见了，执行挂载
        mountTerminal(tabId, container, true);
        return;
      }
      if (!instance?.xterm) return;

      instance.xterm.fit();
      const state = terminalStateRef.current;
      const tab = state.tabs[tabId];
      if (tab?.processId && tab.processId > 0) {
        resizeTerminal(tab.processId, instance.xterm.raw.cols, instance.xterm.raw.rows);
        console.log(`[Terminal] ${tabId} 激活时 resize PTY ${tab.processId} 到 ${instance.xterm.raw.cols}x${instance.xterm.raw.rows}`);
      }
      instance.xterm.focus();
      // 延迟再 resize 一次，确保面板动画/布局稳定后 PTY 尺寸正确
      setTimeout(() => {
        const container2 = containerRefs.current.get(tabId);
        if (!container2?.clientWidth || !container2.clientHeight) return;
        instance.xterm?.fit();
        const state2 = terminalStateRef.current;
        const tab2 = state2.tabs[tabId];
        if (tab2?.processId && tab2.processId > 0) {
          resizeTerminal(tab2.processId, instance.xterm!.raw.cols, instance.xterm!.raw.rows);
          console.log(`[Terminal] ${tabId} 延迟 resize PTY ${tab2.processId} 到 ${instance.xterm!.raw.cols}x${instance.xterm!.raw.rows}`);
        }
      }, 150);
    });

    return () => cancelAnimationFrame(rafId);
  }, [activeBottomTab, bottomPanelVisible, terminal.panelVisible, activeTabIdMemo, mountTerminal]);

  /* ─── 快捷键 ─── */

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.ctrlKey && e.shiftKey && e.key === '`') {
      e.preventDefault(); dispatch(toggleBottomPanel());
    }
    if (e.ctrlKey && e.shiftKey && e.key === 'E') {
      e.preventDefault();
      const tid = activeTabIdRef.current;
      if (tid) {
        const inst = xtermInstances.current.get(tid);
        if (inst?.xterm) setInlineEditorInitial(inst.xterm.getSelection() || '');
      }
      setInlineEditorVisible(true);
    }
    if (e.ctrlKey && e.shiftKey && e.key === 'B') {
      e.preventDefault(); addCurrentBookmark();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch]);

  /* ─── 搜索 ─── */

  const handleSearch = useCallback(async () => {
    const tid = activeTabIdRef.current;
    if (!tid || !searchTerm) return;
    const inst = xtermInstances.current.get(tid);
    await inst?.xterm?.findNext(searchTerm);
  }, [searchTerm]);

  const handleSearchPrev = useCallback(async () => {
    const tid = activeTabIdRef.current;
    if (!tid || !searchTerm) return;
    const inst = xtermInstances.current.get(tid);
    await inst?.xterm?.findPrevious(searchTerm);
  }, [searchTerm]);

  const closeSearch = useCallback(() => {
    setSearchVisible(false); setSearchTerm('');
    const inst = xtermInstances.current.get(activeTabIdRef.current || '');
    inst?.xterm?.clearSearchDecorations();
  }, []);

  /* ─── 书签 ─── */

  const addCurrentBookmark = useCallback(() => {
    const tid = activeTabIdRef.current;
    if (!tid) return;
    const inst = xtermInstances.current.get(tid);
    if (!inst?.xterm) return;
    const buf = inst.xterm.raw.buffer.active;
    dispatch(addBookmark({ tabId: tid, line: buf.baseY + buf.cursorY, label: `行 ${buf.baseY + buf.cursorY}` }));
  }, [dispatch]);

  const jumpToBookmark = useCallback((bookmarkLine: number) => {
    const inst = xtermInstances.current.get(activeTabIdRef.current || '');
    inst?.xterm?.scrollToLine(bookmarkLine);
  }, []);

  /* ─── 广播 ─── */

  const toggleBroadcast = useCallback(() => {
    dispatch(setBroadcastMode(!terminalStateRef.current.broadcastMode));
  }, [dispatch]);

  /* ─── AI ─── */

  const handleAIExplain = useCallback(() => {
    const tid = activeTabIdRef.current;
    if (!tid) return;
    const inst = xtermInstances.current.get(tid);
    if (!inst?.xterm) return;
    const sel = inst.xterm.getSelection() || inst.xterm.getContentsAsText().split('\n').slice(-10).join('\n');
    if (!sel.trim()) return;

    const ctx = getAIContext();
    let analysis = '';
    if (sel.includes('error') || sel.includes('Error')) {
      analysis = '检测到错误信息。建议检查语法或环境配置。';
    } else if (sel.includes('warning') || sel.includes('Warning')) {
      analysis = '检测到警告信息，通常不影响运行。';
    } else if (ctx.lastExitCode && ctx.lastExitCode !== 0) {
      const s = detectAnomaly(ctx.lastExitCode, ctx.lastCommand);
      if (s) analysis = s;
    }
    const state = terminalStateRef.current;
    const tab = state.tabs[tid];
    if (analysis && tab?.processId) {
      inst.xterm.write(`\r\n\x1b[35m[AI 分析] ${analysis}\x1b[0m\r\n`);
    }
  }, []);

  /* ─── 复制/粘贴 ─── */

  const handleCopy = useCallback(() => {
    const inst = xtermInstances.current.get(activeTabIdRef.current || '');
    if (inst?.xterm?.hasSelection()) {
      navigator.clipboard.writeText(inst.xterm.getSelection()).catch(() => {});
    }
  }, []);

  const handlePaste = useCallback(() => {
    const state = terminalStateRef.current;
    const tab = activeTabIdRef.current ? state.tabs[activeTabIdRef.current] : undefined;
    if (!tab?.processId || tab.exited) return;
    navigator.clipboard.readText().then(text => sendInput(tab.processId!, text)).catch(() => {});
  }, []);

  /* ─── 清除/最大化/移动 ─── */

  const handleClear = useCallback(() => {
    const state = terminalStateRef.current;
    const tab = activeTabIdRef.current ? state.tabs[activeTabIdRef.current] : undefined;
    if (tab?.processId && tab.processId > 0) clearTerminal(tab.processId);
    xtermInstances.current.get(activeTabIdRef.current || '')?.xterm?.clear();
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
              <button className="bottom-panel__btn" onClick={handleAIExplain} title="AI 分析"><Sparkles size={14} /></button>
              <button className={`bottom-panel__btn ${searchVisible ? 'active' : ''}`} onClick={() => setSearchVisible(!searchVisible)} title="搜索 (Ctrl+Shift+F)">
                <Search size={14} />
              </button>
              <button className="bottom-panel__btn" onClick={handleCopy} title="复制"><Copy size={14} /></button>
              <button className="bottom-panel__btn" onClick={handlePaste} title="粘贴"><ClipboardPaste size={14} /></button>
              {/* <button className="bottom-panel__btn" onClick={handleMoveToEditor} title="移动到编辑器"><Columns2 size={14} /></button> */}
              <button className="bottom-panel__btn" onClick={handleClear} title="清屏"><Trash2 size={14} /></button>
            </>
          )}
          <button className="bottom-panel__btn" onClick={handleToggleMaximize} title="最大化">
            {terminal.isMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button className="bottom-panel__btn" onClick={() => dispatch(setBottomPanelVisible(false))} title="关闭面板"><X size={14} /></button>
        </div>
      </div>

      {/* 终端 Tab：保持挂载，用 display 切换，避免 xterm 实例被销毁 */}
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

        {/* 终端内容区 */}
        <div className="bottom-panel__content">
          <div className="terminal-content">
            {activeGroup?.panes.map((pane) => {
              const isActive = pane.terminalId === activeTabIdMemo;
              return (
                <div
                  key={pane.terminalId}
                  className={`terminal-instance ${isActive ? 'terminal-instance--active' : 'terminal-instance--inactive'}`}
                  ref={(el) => {
                    setupResizeObserver(pane.terminalId, el);
                    if (el) {
                      containerRefs.current.set(pane.terminalId, el);
                      mountTerminal(pane.terminalId, el, isActive);
                    } else {
                      containerRefs.current.delete(pane.terminalId);
                    }
                  }}
                  onClick={() => {
                    handleSwitchTab(pane.terminalId);
                    xtermInstances.current.get(pane.terminalId)?.xterm?.focus();
                  }}
                />
              );
            })}
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
                  onClick={() => handleSwitchTab(tab.id)}
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

        {allTabs.length > 5 && (
          <div className="bottom-panel__memory-hint">
            <Zap size={12} /> {allTabs.length} 个终端运行中 — 非活跃终端自动节能
          </div>
        )}

        <TerminalInlineEditor
          visible={inlineEditorVisible}
          onExecute={cmd => {
            const state = terminalStateRef.current;
            const tab = activeTabIdRef.current ? state.tabs[activeTabIdRef.current] : undefined;
            if (tab?.processId && !tab.exited) sendInput(tab.processId, cmd + '\r');
          }}
          onClose={() => setInlineEditorVisible(false)}
          initialValue={inlineEditorInitial}
        />
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
