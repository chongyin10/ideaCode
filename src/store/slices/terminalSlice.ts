import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { TerminalProfile } from '../../types/electron';

/* ─── 数据类型 ─── */

export interface TerminalTab {
  id: string;
  processId: number | null;
  name: string;
  profile?: TerminalProfile;
  cwd?: string;
  ready: boolean;
  exited: boolean;
  exitCode?: number;
  bookmarks: TerminalBookmark[];
  isBroadcastReceiver: boolean;
  isEditorTerminal: boolean;
}

export interface TerminalBookmark {
  id: string;
  line: number;
  label: string;
  createdAt: number;
}

/**
 * 书签插入时保持按行号排序 (O(n) 但 n 通常 < 20, 数学优化 #17)
 * 使用二分查找定位插入位置
 */
export function addBookmarkSorted(bookmarks: TerminalBookmark[], item: TerminalBookmark): TerminalBookmark[] {
  const idx = binarySearch(bookmarks, item.line);
  const result = [...bookmarks];
  result.splice(idx, 0, item);
  return result;
}

function binarySearch(bookmarks: TerminalBookmark[], line: number): number {
  let lo = 0, hi = bookmarks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bookmarks[mid].line < line) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface SplitPane {
  id: string;
  /** 该分屏中终端 Tab ID 的引用 */
  terminalId: string;
  /** 相对尺寸占比 (0-1) */
  relativeSize: number;
}

export interface TerminalGroup {
  id: string;
  /** 分屏列表（至少一个） */
  panes: SplitPane[];
  /** 活跃的 pane ID */
  activePaneId: string;
}

export interface TerminalLayoutInfo {
  groups: TerminalGroup[];
  /** 活跃的 group ID */
  activeGroupId: string;
  /** 编辑器区域中的终端 Tab ID 列表 */
  editorTerminals: string[];
}

/* ─── 初始状态 ─── */

interface TerminalState {
  /** 所有终端 Tab（包括面板中和编辑器中的） */
  tabs: Record<string, TerminalTab>;
  /** 面板中的终端组布局 */
  panelLayout: TerminalLayoutInfo;
  /** 编辑器区域终端 */
  editorTerminals: string[];
  /** 面板高度 */
  panelHeight: number;
  /** 面板是否打开 */
  panelVisible: boolean;
  /** 是否最大化 */
  isMaximized: boolean;
  /** 侧边栏宽度 */
  sidebarWidth: number;
  /** 左侧 Tab 栏宽度 */
  tabBarWidth: number;
  /** Shell Profile 列表（由主进程检测） */
  profiles: TerminalProfile[];
  /** 默认 Shell */
  defaultProfile: TerminalProfile | null;
  /** 全局终端配置 */
  settings: TerminalSettingsState;
  /** 广播模式：true 表示输入发送到所有广播接收终端 */
  broadcastMode: boolean;
}

export interface TerminalSettingsState {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorBlinking: boolean;
  scrollback: number;
  copyOnSelection: boolean;
  gpuAcceleration: 'auto' | 'on' | 'off';
  /** AI 辅助功能开关 */
  aiExplainEnabled: boolean;
  aiAutoDetect: boolean;
  /** 终端输出折叠 */
  outputFoldingEnabled: boolean;
}

const defaultSettings: TerminalSettingsState = {
  fontFamily: "Menlo, 'Courier New', monospace",
  fontSize: 14,
  lineHeight: 1.2,
  cursorStyle: 'block',
  cursorBlinking: true,
  scrollback: 5000,
  copyOnSelection: true,
  gpuAcceleration: 'auto',
  aiExplainEnabled: false,
  aiAutoDetect: false,
  outputFoldingEnabled: true,
};

function createDefaultGroup(id: string, terminalId: string): TerminalGroup {
  return {
    id,
    panes: [{ id: `pane-${id}`, terminalId, relativeSize: 1 }],
    activePaneId: `pane-${id}`,
  };
}

const initialState: TerminalState = {
  tabs: {},
  panelLayout: {
    groups: [],
    activeGroupId: '',
    editorTerminals: [],
  },
  editorTerminals: [],
  panelHeight: 250,
  panelVisible: false,
  isMaximized: false,
  sidebarWidth: 160,
  tabBarWidth: 48,
  profiles: [],
  defaultProfile: null,
  broadcastMode: false,
  settings: defaultSettings,
};

/* ─── 辅助函数 ─── */

let tabCounter = 0;
function nextTabId(): string {
  return `tab-${++tabCounter}`;
}
function nextGroupId(): string {
  return `group-${Date.now()}`;
}

/* ─── Slice ─── */

const terminalSlice = createSlice({
  name: 'terminal',
  initialState,
  reducers: {
    /* — 终端 Tab 生命周期 — */
    addTab(state, action: PayloadAction<{ id?: string; name?: string; profile?: TerminalProfile; isEditor?: boolean; processId?: number }>) {
      const { id: providedId, name, profile, isEditor, processId } = action.payload;
      const id = providedId || nextTabId();
      const tab: TerminalTab = {
        id,
        processId: processId ?? null,
        name: name || profile?.name || '终端',
        profile,
        ready: false,
        exited: false,
        bookmarks: [],
        isBroadcastReceiver: false,
        isEditorTerminal: !!isEditor,
      };
      state.tabs[id] = tab;

      if (isEditor) {
        state.editorTerminals.push(id);
      } else {
        const groupId = nextGroupId();
        const group = createDefaultGroup(groupId, id);
        state.panelLayout.groups.push(group);
        state.panelLayout.activeGroupId = groupId;
      }

      state.panelVisible = true;
    },

    removeTab(state, action: PayloadAction<string>) {
      const id = action.payload;
      const tab = state.tabs[id];
      if (!tab) return;

      delete state.tabs[id];

      // 从编辑器终端列表移除
      state.editorTerminals = state.editorTerminals.filter(tid => tid !== id);

      // 从面板布局移除
      for (const group of state.panelLayout.groups) {
        group.panes = group.panes.filter(p => p.terminalId !== id);
      }
      state.panelLayout.groups = state.panelLayout.groups.filter(g => g.panes.length > 0);

      if (state.panelLayout.activeGroupId) {
        const activeGroup = state.panelLayout.groups.find(g => g.id === state.panelLayout.activeGroupId);
        if (!activeGroup && state.panelLayout.groups.length > 0) {
          state.panelLayout.activeGroupId = state.panelLayout.groups[0].id;
        } else if (state.panelLayout.groups.length === 0) {
          state.panelLayout.activeGroupId = '';
        }
      }
    },

    removeEditorTerminal(state, action: PayloadAction<string>) {
      state.editorTerminals = state.editorTerminals.filter(id => id !== action.payload);
      delete state.tabs[action.payload];
    },

    setTabProcessId(state, action: PayloadAction<{ id: string; processId: number }>) {
      const tab = state.tabs[action.payload.id];
      if (tab) {
        tab.processId = action.payload.processId;
      }
    },

    setTabReady(state, action: PayloadAction<{ id: string; pid: number; cwd: string }>) {
      const tab = state.tabs[action.payload.id];
      if (tab) {
        tab.ready = true;
        tab.cwd = action.payload.cwd;
      }
    },

    setTabExited(state, action: PayloadAction<{ id: string; exitCode?: number }>) {
      const tab = state.tabs[action.payload.id];
      if (tab) {
        tab.exited = true;
        tab.exitCode = action.payload.exitCode;
      }
    },

    setTabCwd(state, action: PayloadAction<{ id: string; cwd: string }>) {
      const tab = state.tabs[action.payload.id];
      if (tab) {
        tab.cwd = action.payload.cwd;
      }
    },

    renameTab(state, action: PayloadAction<{ id: string; name: string }>) {
      const tab = state.tabs[action.payload.id];
      if (tab) {
        tab.name = action.payload.name;
      }
    },

    /* — 面板控制 — */
    setPanelVisible(state, action: PayloadAction<boolean>) {
      state.panelVisible = action.payload;
    },

    togglePanel(state) {
      state.panelVisible = !state.panelVisible;
    },

    setPanelHeight(state, action: PayloadAction<number>) {
      state.panelHeight = Math.max(100, action.payload);
    },

    toggleMaximize(state) {
      state.isMaximized = !state.isMaximized;
    },

    setSidebarWidth(state, action: PayloadAction<number>) {
      state.sidebarWidth = Math.max(60, Math.min(400, action.payload));
    },

    /* — 终端组管理 — */
    setActiveGroup(state, action: PayloadAction<string>) {
      state.panelLayout.activeGroupId = action.payload;
    },

    splitPane(state, action: PayloadAction<{ groupId?: string; ratios?: [number, number] }>) {
      const groupId = action.payload.groupId || state.panelLayout.activeGroupId;
      const group = state.panelLayout.groups.find(g => g.id === groupId);
      if (!group) return;

      // 创建新终端 Tab
      const id = nextTabId();
      const tab: TerminalTab = {
        id,
        processId: null,
        name: '终端',
        ready: false,
        exited: false,
        bookmarks: [],
        isBroadcastReceiver: false,
        isEditorTerminal: false,
      };
      state.tabs[id] = tab;

      // 使用传入的 ratio 或均分
      if (action.payload.ratios && group.panes.length === 1) {
        const [r0, r1] = action.payload.ratios;
        group.panes[0].relativeSize = r0;
        group.panes.push({ id: `pane-${id}`, terminalId: id, relativeSize: r1 });
      } else {
        const currentSize = 1 / (group.panes.length + 1);
        group.panes.forEach(p => { p.relativeSize = currentSize; });
        group.panes.push({ id: `pane-${id}`, terminalId: id, relativeSize: currentSize });
      }
      group.activePaneId = `pane-${id}`;
    },

    closePane(state, action: PayloadAction<{ groupId: string; paneId: string }>) {
      const group = state.panelLayout.groups.find(g => g.id === action.payload.groupId);
      if (!group || group.panes.length <= 1) return;

      const removedPane = group.panes.find(p => p.id === action.payload.paneId);
      group.panes = group.panes.filter(p => p.id !== action.payload.paneId);

      // 移除对应的 tab
      if (removedPane) {
        delete state.tabs[removedPane.terminalId];
      }

      // 重新分配尺寸
      const newSize = 1 / group.panes.length;
      group.panes.forEach(p => { p.relativeSize = newSize; });

      if (group.activePaneId === action.payload.paneId) {
        group.activePaneId = group.panes[0]?.id || '';
      }
    },

    setActivePane(state, action: PayloadAction<{ groupId: string; paneId: string }>) {
      const group = state.panelLayout.groups.find(g => g.id === action.payload.groupId);
      if (group) {
        group.activePaneId = action.payload.paneId;
      }
    },

    /**
     * 拖拽重排终端 tab 顺序（仅改变侧边栏显示顺序，不改变分屏布局）
     * @param payload { fromId, toId, position } 将 fromId 对应的终端移到 toId 的 before/after
     *
     * 策略：按 group 粒度重排。每个非拆分终端是一个独立 group，重排 groups 数组顺序即可。
     * 拆分终端（同 group 多 pane）作为整体移动，不拆散。
     */
    reorderTerminalTab(state, action: PayloadAction<{
      fromId: string; toId: string; position: 'before' | 'after';
    }>) {
      const { fromId, toId, position } = action.payload;
      if (fromId === toId) return;

      // 查找 from / to 所在的 group 索引
      const groups = state.panelLayout.groups;
      let fromGroupIdx = -1;
      let toGroupIdx = -1;

      for (let i = 0; i < groups.length; i++) {
        if (groups[i].panes.some(p => p.terminalId === fromId)) fromGroupIdx = i;
        if (groups[i].panes.some(p => p.terminalId === toId)) toGroupIdx = i;
      }

      // 情况 1：都在面板组中 → 重排 groups 数组顺序
      if (fromGroupIdx !== -1 && toGroupIdx !== -1) {
        if (fromGroupIdx === toGroupIdx) return; // 同组不操作
        const movedGroup = groups.splice(fromGroupIdx, 1)[0];
        // 移除后 toGroupIdx 可能偏移
        const newToIdx = groups.findIndex(g => g.panes.some(p => p.terminalId === toId));
        const insertIdx = position === 'after' ? newToIdx + 1 : newToIdx;
        groups.splice(insertIdx, 0, movedGroup);
        return;
      }

      // 情况 2：都在 editorTerminals 中 → 重排编辑器终端顺序
      const fromInEditor = state.editorTerminals.includes(fromId);
      const toInEditor = state.editorTerminals.includes(toId);
      if (fromInEditor && toInEditor) {
        state.editorTerminals = state.editorTerminals.filter(id => id !== fromId);
        const newToIdx = state.editorTerminals.indexOf(toId);
        const insertIdx = position === 'after' ? newToIdx + 1 : newToIdx;
        state.editorTerminals.splice(insertIdx, 0, fromId);
        return;
      }

      // 跨组/跨区域拖拽：不支持（会改变分屏布局）
    },

    moveToEditor(state, action: PayloadAction<string>) {
      const id = action.payload;
      const tab = state.tabs[id];
      if (!tab) return;
      tab.isEditorTerminal = true;
      state.editorTerminals.push(id);
      // 从面板布局移除
      for (const group of state.panelLayout.groups) {
        group.panes = group.panes.filter(p => p.terminalId !== id);
      }
      state.panelLayout.groups = state.panelLayout.groups.filter(g => g.panes.length > 0);
    },

    moveToPanel(state, action: PayloadAction<string>) {
      const id = action.payload;
      state.editorTerminals = state.editorTerminals.filter(tid => tid !== id);
      const tab = state.tabs[id];
      if (tab) {
        tab.isEditorTerminal = false;
      }
      const groupId = nextGroupId();
      const group = createDefaultGroup(groupId, id);
      state.panelLayout.groups.push(group);
      state.panelLayout.activeGroupId = groupId;
    },

    /* — Shell Profile — */
    setProfiles(state, action: PayloadAction<{ profiles: TerminalProfile[]; defaultProfile: TerminalProfile }>) {
      state.profiles = action.payload.profiles;
      state.defaultProfile = action.payload.defaultProfile;
    },

    /* — 书签 — */
    addBookmark(state, action: PayloadAction<{ tabId: string; line: number; label: string }>) {
      const tab = state.tabs[action.payload.tabId];
      if (!tab) return;
      const item: TerminalBookmark = {
        id: `bk-${Date.now()}`,
        line: action.payload.line,
        label: action.payload.label,
        createdAt: Date.now(),
      };
      // 二分插入保持有序 (O(log n + n) 但 Redux-Immer 安全)
      const idx = binarySearch(tab.bookmarks, item.line);
      tab.bookmarks.splice(idx, 0, item);
    },

    removeBookmark(state, action: PayloadAction<{ tabId: string; bookmarkId: string }>) {
      const tab = state.tabs[action.payload.tabId];
      if (!tab) return;
      tab.bookmarks = tab.bookmarks.filter(b => b.id !== action.payload.bookmarkId);
    },

    /* — 广播模式 — */
    setBroadcastMode(state, action: PayloadAction<boolean>) {
      state.broadcastMode = action.payload;
    },

    toggleBroadcastReceiver(state, action: PayloadAction<string>) {
      const tab = state.tabs[action.payload];
      if (tab) {
        tab.isBroadcastReceiver = !tab.isBroadcastReceiver;
      }
    },

    /* — 配置 — */
    updateTerminalSettings(state, action: PayloadAction<Partial<TerminalSettingsState>>) {
      Object.assign(state.settings, action.payload);
    },

    /* — 重置 — */
    resetTerminalState() {
      // 注意：不能直接返回新的 initialState 引用，需要逐个字段重置
      // createSlice 使用 Immer，我们需要将当前 state 替换为初始值
      return { ...initialState, settings: { ...defaultSettings } };
    },
  },
});

export const {
  addTab, removeTab, removeEditorTerminal,
  setTabProcessId, setTabReady, setTabExited, setTabCwd, renameTab,
  setPanelVisible, togglePanel, setPanelHeight, toggleMaximize, setSidebarWidth,
  setActiveGroup, splitPane, closePane, setActivePane,
  reorderTerminalTab,
  moveToEditor, moveToPanel,
  setProfiles,
  addBookmark, removeBookmark,
  setBroadcastMode, toggleBroadcastReceiver,
  updateTerminalSettings,
  resetTerminalState,
} = terminalSlice.actions;

export default terminalSlice.reducer;
