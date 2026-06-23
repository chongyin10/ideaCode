import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export interface ExtensionViewContainer {
  id: string;
  title: string;
  icon: string;
  extensionId: string;
}

export interface ExtensionViewAction {
  command: string;
  title?: string;
  icon?: string;
  tooltip?: string;
  type?: 'button' | 'switch';
}

export interface ExtensionView {
  id: string;
  name: string;
  containerId: string;
  extensionId: string;
  actions?: ExtensionViewAction[];
}

export interface ExtensionWebViewPanel {
  id: string;
  viewType: string;
  title: string;
  html: string;
  extensionId: string;
  extensionPath: string;
  visible: boolean;
}

interface ExtensionUIState {
  viewContainers: ExtensionViewContainer[];
  views: ExtensionView[];
  webviewPanels: ExtensionWebViewPanel[];
}

const initialState: ExtensionUIState = {
  viewContainers: [],
  views: [],
  webviewPanels: [],
};

const extensionUISlice = createSlice({
  name: 'extensionUI',
  initialState,
  reducers: {
    registerViewContainer: (state, action: PayloadAction<ExtensionViewContainer>) => {
      const container = action.payload;
      const existing = state.viewContainers.findIndex((c) => c.id === container.id);
      if (existing >= 0) {
        state.viewContainers[existing] = container;
      } else {
        state.viewContainers.push(container);
      }
    },
    unregisterViewContainer: (state, action: PayloadAction<string>) => {
      const id = action.payload;
      state.viewContainers = state.viewContainers.filter((c) => c.id !== id);
    },
    registerView: (state, action: PayloadAction<ExtensionView>) => {
      const view = action.payload;
      const existing = state.views.findIndex((v) => v.id === view.id);
      if (existing >= 0) {
        state.views[existing] = view;
      } else {
        state.views.push(view);
      }
    },
    unregisterView: (state, action: PayloadAction<string>) => {
      const id = action.payload;
      state.views = state.views.filter((v) => v.id !== id);
    },
    createWebviewPanel: (state, action: PayloadAction<ExtensionWebViewPanel>) => {
      const panel = action.payload;
      state.webviewPanels.push(panel);
    },
    disposeWebviewPanel: (state, action: PayloadAction<string>) => {
      const id = action.payload;
      state.webviewPanels = state.webviewPanels.filter((p) => p.id !== id);
    },
    setWebviewPanelHtml: (state, action: PayloadAction<{ id: string; html: string }>) => {
      const { id, html } = action.payload;
      const panel = state.webviewPanels.find((p) => p.id === id);
      if (panel) {
        panel.html = html;
      }
    },
    setWebviewPanelVisible: (state, action: PayloadAction<{ id: string; visible: boolean }>) => {
      const { id, visible } = action.payload;
      const panel = state.webviewPanels.find((p) => p.id === id);
      if (panel) {
        panel.visible = visible;
      }
    },
  },
});

export const {
  registerViewContainer,
  unregisterViewContainer,
  registerView,
  unregisterView,
  createWebviewPanel,
  disposeWebviewPanel,
  setWebviewPanelHtml,
  setWebviewPanelVisible,
} = extensionUISlice.actions;

export default extensionUISlice.reducer;
