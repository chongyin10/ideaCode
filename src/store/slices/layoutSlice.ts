import { createSlice } from '@reduxjs/toolkit';

export type PanelId = 'explorer' | 'search' | 'git' | 'debug' | 'extensions';
export type BottomTabId = 'terminal' | 'problems' | 'output' | 'debug-console' | 'ports' | 'gitlens';

export const DEFAULT_SIDEBAR_WIDTH = 260;
export const MIN_SIDEBAR_WIDTH = 150;
export const MAX_SIDEBAR_WIDTH = 600;

interface LayoutState {
  sidePanelVisible: boolean;
  sidePanelWidth: number;
  activePanel: PanelId;
  rightPanelVisible: boolean;
  bottomPanelVisible: boolean;
  activeBottomTab: BottomTabId;
  /** 状态栏弹出层需要预留的高度（用于 BrowserView 终端避让） */
  statusBarOverlayHeight: number;
  /** 是否有模态层打开，打开时隐藏终端 BrowserView 避免层级穿透 */
  modalOverlayOpen: boolean;
}

const initialState: LayoutState = {
  sidePanelVisible: true,
  sidePanelWidth: DEFAULT_SIDEBAR_WIDTH,
  activePanel: 'explorer',
  rightPanelVisible: false,
  bottomPanelVisible: false,
  activeBottomTab: 'terminal',
  statusBarOverlayHeight: 0,
  modalOverlayOpen: false,
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
    setStatusBarOverlayHeight: (state, action) => {
      state.statusBarOverlayHeight = action.payload as number;
    },
    setModalOverlayOpen: (state, action) => {
      state.modalOverlayOpen = action.payload as boolean;
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
  setStatusBarOverlayHeight,
  setModalOverlayOpen,
} = layoutSlice.actions;
export default layoutSlice.reducer;
