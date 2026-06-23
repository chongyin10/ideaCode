import { createSlice } from '@reduxjs/toolkit';

export type PanelId = 'explorer' | 'search' | 'git' | 'debug' | 'extensions' | string;
export type BottomTabId = 'terminal' | 'problems' | 'output' | 'debug-console' | 'ports' | 'gitlens';
export type DockLocation = 'left' | 'right' | 'bottom';

export interface DockableItem {
  id: string;
  title: string;
  icon: string;
  location: DockLocation;
  type: 'explorer' | 'search' | 'git' | 'debug' | 'extensions' | 'terminal' | 'output' | 'problems' | 'debug-console' | 'ports' | 'gitlens' | 'viewContainer' | 'custom';
  sourceContainerId?: string;
  sourceViewId?: string;
}

export const DEFAULT_SIDEBAR_WIDTH = 260;
export const MIN_SIDEBAR_WIDTH = 150;
export const MAX_SIDEBAR_WIDTH = 600;

/** ActivityBar 面板默认顺序 */
export const DEFAULT_PANEL_ORDER: PanelId[] = ['explorer', 'search', 'git', 'debug', 'extensions'];

/** 底部面板 tab 默认顺序 */
export const DEFAULT_BOTTOM_TAB_ORDER: BottomTabId[] = ['problems', 'output', 'debug-console', 'terminal', 'ports', 'gitlens'];

/** 统一的 dockable items 默认配置 */
const DEFAULT_DOCKABLE_ITEMS: DockableItem[] = [
  { id: 'explorer', title: 'activityBar.explorer', icon: '$(files)', location: 'left', type: 'explorer' },
  { id: 'search', title: 'activityBar.search', icon: '$(search)', location: 'left', type: 'search' },
  { id: 'git', title: 'activityBar.sourceControl', icon: '$(git-branch)', location: 'left', type: 'git' },
  { id: 'debug', title: 'activityBar.runAndDebug', icon: '$(bug)', location: 'left', type: 'debug' },
  { id: 'extensions', title: 'activityBar.extensions', icon: '$(blocks)', location: 'left', type: 'extensions' },

  { id: 'right-kimi-code', title: 'KIMI CODE', icon: '$(sparkles)', location: 'right', type: 'custom' },

  { id: 'problems', title: 'bottomPanel.problems', icon: '$(alert-circle)', location: 'bottom', type: 'problems' },
  { id: 'output', title: 'bottomPanel.output', icon: '$(panel-top-open)', location: 'bottom', type: 'output' },
  { id: 'debug-console', title: 'bottomPanel.debugConsole', icon: '$(bug)', location: 'bottom', type: 'debug-console' },
  { id: 'terminal', title: 'bottomPanel.terminal', icon: '$(terminal)', location: 'bottom', type: 'terminal' },
  { id: 'ports', title: 'bottomPanel.ports', icon: '$(plug)', location: 'bottom', type: 'ports' },
  { id: 'gitlens', title: 'bottomPanel.gitlens', icon: '$(git-branch)', location: 'bottom', type: 'gitlens' },
];

interface LayoutState {
  sidePanelVisible: boolean;
  sidePanelWidth: number;
  activePanel: PanelId;
  /** ActivityBar 面板顺序（可拖拽重排） */
  panelOrder: PanelId[];
  rightPanelVisible: boolean;
  /** 右侧面板是否最大化（全屏） */
  rightPanelMaximized: boolean;
  bottomPanelVisible: boolean;
  activeBottomTab: BottomTabId;
  /** 底部面板 tab 顺序（可拖拽重排） */
  bottomTabOrder: BottomTabId[];
  /** 统一的 dockable items（左/右/底三区共享） */
  dockableItems: DockableItem[];
  activeRightItem: string;
}

const initialState: LayoutState = {
  sidePanelVisible: true,
  sidePanelWidth: DEFAULT_SIDEBAR_WIDTH,
  activePanel: 'explorer',
  panelOrder: [...DEFAULT_PANEL_ORDER],
  rightPanelVisible: false,
  rightPanelMaximized: false,
  bottomPanelVisible: false,
  bottomTabOrder: [...DEFAULT_BOTTOM_TAB_ORDER],
  activeBottomTab: 'terminal',
  dockableItems: [...DEFAULT_DOCKABLE_ITEMS],
  activeRightItem: 'right-kimi-code',
};

const layoutSlice = createSlice({
  name: 'layout',
  initialState,
  reducers: {
    toggleSidePanel: (state) => {
      state.sidePanelVisible = !state.sidePanelVisible;
      if (state.sidePanelVisible && state.sidePanelWidth < MIN_SIDEBAR_WIDTH) {
        state.sidePanelWidth = DEFAULT_SIDEBAR_WIDTH;
      }
    },
    switchPanel: (state, action) => {
      const panel = action.payload as PanelId;
      // 右侧面板全屏时，点击任意菜单 → 退出全屏，恢复半屏
      if (state.rightPanelMaximized) {
        state.rightPanelMaximized = false;
      }
      if (state.activePanel === panel && state.sidePanelVisible) {
        state.sidePanelVisible = false;
      } else {
        state.activePanel = panel;
        state.sidePanelVisible = true;
        if (state.sidePanelWidth < MIN_SIDEBAR_WIDTH) {
          state.sidePanelWidth = DEFAULT_SIDEBAR_WIDTH;
        }
        // 如果面板不在 panelOrder 中（是动态添加的扩展面板），添加到末尾
        if (!state.panelOrder.includes(panel)) {
          state.panelOrder.push(panel);
        }
      }
    },
    setSidePanelWidth: (state, action) => {
      state.sidePanelWidth = Math.max(
        MIN_SIDEBAR_WIDTH,
        Math.min(MAX_SIDEBAR_WIDTH, action.payload as number),
      );
    },
    setSidePanelVisible: (state, action) => {
      state.sidePanelVisible = action.payload as boolean;
      if (state.sidePanelVisible && state.sidePanelWidth < MIN_SIDEBAR_WIDTH) {
        state.sidePanelWidth = DEFAULT_SIDEBAR_WIDTH;
      }
    },
    toggleRightPanel: (state) => {
      state.rightPanelVisible = !state.rightPanelVisible;
      // 关闭面板时同时退出全屏
      if (!state.rightPanelVisible) {
        state.rightPanelMaximized = false;
      }
    },
    /** 设置右侧面板全屏/半屏状态 */
    setRightPanelMaximized: (state, action) => {
      state.rightPanelMaximized = action.payload as boolean;
    },
    toggleBottomPanel: (state) => {
      state.bottomPanelVisible = !state.bottomPanelVisible;
    },
    setBottomPanelVisible: (state, action) => {
      state.bottomPanelVisible = action.payload;
    },
    switchBottomTab: (state, action) => {
      state.activeBottomTab = action.payload as BottomTabId;
      state.bottomPanelVisible = true;
    },
    openBottomTab: (state, action) => {
      state.activeBottomTab = action.payload as BottomTabId;
      state.bottomPanelVisible = true;
    },
    /**
     * 将面板加入 ActivityBar 顺序（不切换激活状态）
     */
    addPanelToOrder: (state, action) => {
      const panel = action.payload as PanelId;
      if (!state.panelOrder.includes(panel)) {
        state.panelOrder.push(panel);
      }
    },
    removePanelFromOrder: (state, action) => {
      const panel = action.payload as PanelId;
      state.panelOrder = state.panelOrder.filter((id) => id !== panel);
    },
    /**
     * 拖拽重排 ActivityBar 面板顺序
     * @param payload { fromId, toId, position } 将 fromId 移到 toId 的 before/after
     */
    reorderPanel: (state, action) => {
      const { fromId, toId, position = 'before' } = action.payload as {
        fromId: PanelId; toId: PanelId; position?: 'before' | 'after';
      };
      if (fromId === toId) return;
      const order = state.panelOrder;
      const fromIdx = order.indexOf(fromId);
      const toIdx = order.indexOf(toId);
      if (fromIdx === -1 || toIdx === -1) return;
      order.splice(fromIdx, 1);
      const newToIdx = order.indexOf(toId);
      const insertIdx = position === 'after' ? newToIdx + 1 : newToIdx;
      order.splice(insertIdx, 0, fromId);
    },

    /**
     * 拖拽重排底部面板 tab 顺序
     * @param payload { fromId, toId, position } 将 fromId 移到 toId 的 before/after
     */
    reorderBottomTab: (state, action) => {
      const { fromId, toId, position = 'before' } = action.payload as {
        fromId: BottomTabId; toId: BottomTabId; position?: 'before' | 'after';
      };
      if (fromId === toId) return;
      const order = state.bottomTabOrder;
      const fromIdx = order.indexOf(fromId);
      const toIdx = order.indexOf(toId);
      if (fromIdx === -1 || toIdx === -1) return;
      order.splice(fromIdx, 1);
      const newToIdx = order.indexOf(toId);
      const insertIdx = position === 'after' ? newToIdx + 1 : newToIdx;
      order.splice(insertIdx, 0, fromId);
    },

    // ── 统一 dockable items ──
    registerDockableItem: (state, action) => {
      const item = action.payload as DockableItem;
      const idx = state.dockableItems.findIndex((i) => i.id === item.id);
      if (idx >= 0) {
        state.dockableItems[idx] = item;
      } else {
        state.dockableItems.push(item);
      }
    },
    unregisterDockableItem: (state, action) => {
      const id = action.payload as string;
      state.dockableItems = state.dockableItems.filter((i) => i.id !== id);
    },
    moveDockableItem: (state, action) => {
      const { id, targetLocation, targetId, position = 'after' } = action.payload as {
        id: string;
        targetLocation: DockLocation;
        targetId?: string;
        position?: 'before' | 'after';
      };
      const item = state.dockableItems.find((i) => i.id === id);
      if (!item) return;
      item.location = targetLocation;

      if (targetId && targetId !== id) {
        const items = state.dockableItems;
        const fromIdx = items.findIndex((i) => i.id === id);
        const toIdx = items.findIndex((i) => i.id === targetId);
        if (fromIdx !== -1 && toIdx !== -1) {
          items.splice(fromIdx, 1);
          const newToIdx = items.findIndex((i) => i.id === targetId);
          const insertIdx = position === 'after' ? newToIdx + 1 : newToIdx;
          items.splice(insertIdx, 0, item);
        }
      }

      // 同步兼容旧字段
      if (targetLocation === 'left' && !state.panelOrder.includes(id)) {
        state.panelOrder.push(id);
      }
      if (targetLocation !== 'left') {
        state.panelOrder = state.panelOrder.filter((p) => p !== id);
      }
      if (targetLocation === 'bottom' && !state.bottomTabOrder.includes(id as BottomTabId)) {
        state.bottomTabOrder.push(id as BottomTabId);
      }
      if (targetLocation !== 'bottom') {
        state.bottomTabOrder = state.bottomTabOrder.filter((b) => b !== id);
      }
      if (targetLocation === 'right') {
        state.activeRightItem = id;
        state.rightPanelVisible = true;
      }
      if (targetLocation === 'bottom') {
        state.activeBottomTab = id as BottomTabId;
        state.bottomPanelVisible = true;
      }
      if (targetLocation === 'left') {
        state.activePanel = id;
        state.sidePanelVisible = true;
      }

      // 如果当前激活项被移出原区域，切换到该区域其他可用项
      const leftItems = state.dockableItems.filter((i) => i.location === 'left');
      if (!leftItems.find((i) => i.id === state.activePanel)) {
        state.activePanel = leftItems[0]?.id || 'explorer';
      }
      const bottomItems = state.dockableItems.filter((i) => i.location === 'bottom');
      if (!bottomItems.find((i) => i.id === state.activeBottomTab)) {
        state.activeBottomTab = (bottomItems[0]?.id as BottomTabId) || 'terminal';
      }
      const rightItems = state.dockableItems.filter((i) => i.location === 'right');
      if (!rightItems.find((i) => i.id === state.activeRightItem)) {
        state.activeRightItem = rightItems[0]?.id || '';
      }
    },
    reorderDockableItem: (state, action) => {
      const { fromId, toId, position = 'after' } = action.payload as {
        fromId: string; toId: string; position?: 'before' | 'after';
      };
      if (fromId === toId) return;
      const items = state.dockableItems;
      const fromIdx = items.findIndex((i) => i.id === fromId);
      const toIdx = items.findIndex((i) => i.id === toId);
      if (fromIdx === -1 || toIdx === -1) return;
      const [item] = items.splice(fromIdx, 1);
      const newToIdx = items.findIndex((i) => i.id === toId);
      const insertIdx = position === 'after' ? newToIdx + 1 : newToIdx;
      items.splice(insertIdx, 0, item);
    },
    switchRightItem: (state, action) => {
      state.activeRightItem = action.payload as string;
      state.rightPanelVisible = true;
    },
  },
});

export const {
  toggleSidePanel,
  switchPanel,
  setSidePanelWidth,
  setSidePanelVisible,
  toggleRightPanel,
  setRightPanelMaximized,
  toggleBottomPanel,
  setBottomPanelVisible,
  switchBottomTab,
  openBottomTab,
  addPanelToOrder,
  removePanelFromOrder,
  reorderPanel,
  reorderBottomTab,
  registerDockableItem,
  unregisterDockableItem,
  moveDockableItem,
  reorderDockableItem,
  switchRightItem,
} = layoutSlice.actions;
export default layoutSlice.reducer;
