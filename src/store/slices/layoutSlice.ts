import { createSlice } from '@reduxjs/toolkit';

export type PanelId = 'explorer' | 'search' | 'git' | 'debug' | 'extensions';
export type BottomTabId = 'terminal' | 'problems' | 'output' | 'debug-console' | 'ports' | 'gitlens';

interface LayoutState {
  sidePanelVisible: boolean;
  activePanel: PanelId;
  rightPanelVisible: boolean;
  bottomPanelVisible: boolean;
  activeBottomTab: BottomTabId;
}

const initialState: LayoutState = {
  sidePanelVisible: true,
  activePanel: 'explorer',
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
    },
    switchPanel: (state, action) => {
      const panel = action.payload as PanelId;
      if (state.activePanel === panel && state.sidePanelVisible) {
        state.sidePanelVisible = false;
      } else {
        state.activePanel = panel;
        state.sidePanelVisible = true;
      }
    },
    toggleRightPanel: (state) => {
      state.rightPanelVisible = !state.rightPanelVisible;
    },
    toggleBottomPanel: (state) => {
      state.bottomPanelVisible = !state.bottomPanelVisible;
    },
    switchBottomTab: (state, action) => {
      state.activeBottomTab = action.payload as BottomTabId;
      state.bottomPanelVisible = true;
    },
    openBottomTab: (state, action) => {
      state.activeBottomTab = action.payload as BottomTabId;
      state.bottomPanelVisible = true;
    },
  },
});

export const { toggleSidePanel, switchPanel, toggleRightPanel, toggleBottomPanel, switchBottomTab, openBottomTab } = layoutSlice.actions;
export default layoutSlice.reducer;
