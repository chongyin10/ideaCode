import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export type EditorTheme = 'vs' | 'vs-dark' | 'hc-black';
export type WordWrapOption = 'on' | 'off' | 'bounded';

export interface SettingsState {
  theme: EditorTheme;
  fontSize: number;
  semanticHighlightingEnabled: boolean;
  wordWrap: WordWrapOption;
  minimapEnabled: boolean;
}

export const SETTINGS_STORAGE_KEY = 'ideacode_settings';

export const defaultSettings: SettingsState = {
  theme: 'vs-dark',
  fontSize: 14,
  semanticHighlightingEnabled: true,
  wordWrap: 'on',
  minimapEnabled: true,
};

export function loadSettings(): Partial<SettingsState> {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as Partial<SettingsState>;
  } catch {
    /* 忽略解析错误 */
  }
  return {};
}

export function persistSettings(state: SettingsState) {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* 忽略写入错误 */
  }
}

const initialState: SettingsState = { ...defaultSettings, ...loadSettings() };

const settingsSlice = createSlice({
  name: 'settings',
  initialState,
  reducers: {
    setTheme: (state, action: PayloadAction<EditorTheme>) => {
      state.theme = action.payload;
    },
    setFontSize: (state, action: PayloadAction<number>) => {
      state.fontSize = Math.max(8, Math.min(32, action.payload));
    },
    setSemanticHighlightingEnabled: (state, action: PayloadAction<boolean>) => {
      state.semanticHighlightingEnabled = action.payload;
    },
    setWordWrap: (state, action: PayloadAction<WordWrapOption>) => {
      state.wordWrap = action.payload;
    },
    setMinimapEnabled: (state, action: PayloadAction<boolean>) => {
      state.minimapEnabled = action.payload;
    },
    resetSettings: (state) => {
      Object.assign(state, defaultSettings);
    },
  },
});

export const {
  setTheme,
  setFontSize,
  setSemanticHighlightingEnabled,
  setWordWrap,
  setMinimapEnabled,
  resetSettings,
} = settingsSlice.actions;

export default settingsSlice.reducer;
