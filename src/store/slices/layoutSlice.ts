import { createSlice } from '@reduxjs/toolkit';

export type PanelId = 'explorer' | 'search' | 'git' | 'debug' | 'extensions';

interface LayoutState {
  sidePanelVisible: boolean;
  activePanel: PanelId;
  rightPanelVisible: boolean;
  bottomPanelVisible: boolean;
}

const initialState: LayoutState = {
  sidePanelVisible: true,
  activePanel: 'explorer',
  rightPanelVisible: false,
  bottomPanelVisible: false,
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
  },
});

export const { toggleSidePanel, switchPanel, toggleRightPanel, toggleBottomPanel } = layoutSlice.actions;
export default layoutSlice.reducer;
