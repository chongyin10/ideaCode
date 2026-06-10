import { configureStore } from '@reduxjs/toolkit';
import workspaceReducer from './slices/workspaceSlice';
import layoutReducer from './slices/layoutSlice';

export const store = configureStore({
  reducer: {
    workspace: workspaceReducer,
    layout: layoutReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
