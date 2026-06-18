import { createSlice } from '@reduxjs/toolkit';

export type PanelId = 'explorer' | 'search' | 'git' | 'debug' | 'extensions';
export type BottomTabId = 'terminal' | 'problems' | 'output' | 'debug-console' | 'ports' | 'gitlens';

export const DEFAULT_SIDEBAR_WIDTH = 260;
export const MIN_SIDEBAR_WIDTH = 150;
export const MAX_SIDEBAR_WIDTH = 600;

/** ActivityBar 面板默认顺序 */
export const DEFAULT_PANEL_ORDER: PanelId[] = ['explorer', 'search', 'git', 'debug', 'extensions'];

interface LayoutState {
  sidePanelVisible: boolean;
  sidePanelWidth: number;
  activePanel: PanelId;
  /** ActivityBar 面板顺序（可拖拽重排） */
  panelOrder: PanelId[];
  rightPanelVisible: boolean;
  bottomPanelVisible: boolean;
  activeBottomTab: BottomTabId;
}

const initialState: LayoutState = {
  sidePanelVisible: true,
  sidePanelWidth: DEFAULT_SIDEBAR_WIDTH,
  activePanel: 'explorer',
  panelOrder: [...DEFAULT_PANEL_ORDER],
  rightPanelVisible: false,
  bottomPanelVisible: false,
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
  },
});

export const {
  toggleSidePanel,
  switchPanel,
  setSidePanelWidth,
  setSidePanelVisible,
  toggleRightPanel,
  toggleBottomPanel,
  setBottomPanelVisible,
  switchBottomTab,
  openBottomTab,
  reorderPanel,
} = layoutSlice.actions;
export default layoutSlice.reducer;
