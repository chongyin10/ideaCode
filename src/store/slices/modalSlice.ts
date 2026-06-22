import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export interface ModalWebviewState {
  id: string;
  viewType: string;
  title: string;
  html: string;
  extensionId: string;
  extensionPath: string;
  visible: boolean;
}

export interface TerminalModalState {
  tabId: string;
  title?: string;
}

interface ModalState {
  modalWebview: ModalWebviewState | null;
  terminalModal: TerminalModalState | null;
}

const initialState: ModalState = {
  modalWebview: null,
  terminalModal: null,
};

const modalSlice = createSlice({
  name: 'modal',
  initialState,
  reducers: {
    openModalWebview: (state, action: PayloadAction<ModalWebviewState>) => {
      state.modalWebview = action.payload;
    },
    setModalWebviewHtml: (state, action: PayloadAction<{ id: string; html: string }>) => {
      if (state.modalWebview && state.modalWebview.id === action.payload.id) {
        state.modalWebview.html = action.payload.html;
      }
    },
    closeModalWebview: (state) => {
      state.modalWebview = null;
    },
    openTerminalModal: (state, action: PayloadAction<TerminalModalState>) => {
      state.terminalModal = action.payload;
    },
    closeTerminalModal: (state) => {
      state.terminalModal = null;
    },
  },
});

export const { openModalWebview, setModalWebviewHtml, closeModalWebview, openTerminalModal, closeTerminalModal } = modalSlice.actions;
export default modalSlice.reducer;
