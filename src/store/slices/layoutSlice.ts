import { createSlice } from '@reduxjs/toolkit';

export type PanelId = 'explorer' | 'search' | 'git' | 'debug' | 'extensions';

interface LayoutState {
  sidePanelVisible: boolean;
  activePanel: PanelId;
}

const initialState: LayoutState = {
  sidePanelVisible: true,
  activePanel: 'explorer',
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
  },
});

export const { toggleSidePanel, switchPanel } = layoutSlice.actions;
export default layoutSlice.reducer;
