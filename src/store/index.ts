import { configureStore } from '@reduxjs/toolkit';
import workspaceReducer from './slices/workspaceSlice';
import layoutReducer from './slices/layoutSlice';
import gitReducer from './slices/gitSlice';
import settingsReducer, { persistSettings } from './slices/settingsSlice';
import terminalReducer from './slices/terminalSlice';

export const store = configureStore({
  reducer: {
    workspace: workspaceReducer,
    layout: layoutReducer,
    git: gitReducer,
    settings: settingsReducer,
    terminal: terminalReducer,
  },
});

// 设置变更去抖持久化到 localStorage（避免 Reducer 内同步 I/O 阻塞主线程）
let settingsSaveTimer: ReturnType<typeof setTimeout>;
store.subscribe(() => {
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => {
    persistSettings(store.getState().settings);
  }, 300);
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
