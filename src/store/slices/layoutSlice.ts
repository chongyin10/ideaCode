import { createSlice } from '@reduxjs/toolkit';

export type PanelId = 'explorer' | 'search' | 'git' | 'debug' | 'extensions';
export type BottomTabId = 'terminal' | 'problems' | 'output' | 'debug-console' | 'ports' | 'gitlens';

export const DEFAULT_SIDEBAR_WIDTH = 260;
export const MIN_SIDEBAR_WIDTH = 150;
export const MAX_SIDEBAR_WIDTH = 600;

/** ActivityBar 面板默认顺序 */
export const DEFAULT_PANEL_ORDER: PanelId[] = ['explorer', 'search', 'git', 'debug', 'extensions'];

/** 底部面板 tab 默认顺序 */
export const DEFAULT_BOTTOM_TAB_ORDER: BottomTabId[] = ['problems', 'output', 'debug-console', 'terminal', 'ports', 'gitlens'];

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
  reorderPanel,
  reorderBottomTab,
} = layoutSlice.actions;
export default layoutSlice.reducer;
