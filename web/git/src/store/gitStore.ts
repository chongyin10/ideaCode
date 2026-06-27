/**
 * Git WebView 本地状态管理
 *
 * 使用 zustand-like 的极简实现，避免引入额外依赖。
 * 状态由 Extension Host 推送过来，本地只缓存。
 */

import { useSyncExternalStore } from 'react';
import type { GitStatus, GitBranch, GitCommit, GitStash } from '../types';

interface GitStoreState {
  rootPath: string | null;
  repoRoot: string | null;
  isRepo: boolean;
  gitAvailable: boolean;
  status: GitStatus | null;
  branches: GitBranch[];
  log: GitCommit[];
  stashes: GitStash[];
  lastError: string | null;
  loading: boolean;
  activeFile: { path: string | null; staged: boolean | null };
}

const initialState: GitStoreState = {
  rootPath: null,
  repoRoot: null,
  isRepo: false,
  gitAvailable: true,
  status: null,
  branches: [],
  log: [],
  stashes: [],
  lastError: null,
  loading: false,
  activeFile: { path: null, staged: null },
};

let state: GitStoreState = initialState;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) {
    try { l(); } catch { /* ignore */ }
  }
}

function setState(partial: Partial<GitStoreState>) {
  state = { ...state, ...partial };
  emit();
}

export const gitStore = {
  getState: () => state,
  setState,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /* ─── 由 host 消息更新 ─── */

  applyState(payload: {
    rootPath: string | null;
    repoRoot: string | null;
    isRepo: boolean;
    gitAvailable: boolean;
    state: GitStatus | null;
    lastError: string | null;
    loading?: boolean;
  }) {
    setState({
      rootPath: payload.rootPath,
      repoRoot: payload.repoRoot,
      isRepo: payload.isRepo,
      gitAvailable: payload.gitAvailable,
      status: payload.state,
      lastError: payload.lastError,
      loading: payload.loading ?? false,
    });
  },

  applyBranches(branches: GitBranch[]) {
    setState({ branches });
  },

  applyLog(log: GitCommit[]) {
    setState({ log });
  },

  applyStashes(stashes: GitStash[]) {
    setState({ stashes });
  },

  applyActiveFile(activeFile: { path: string | null; staged: boolean | null }) {
    setState({ activeFile });
  },

  reset() {
    state = initialState;
    emit();
  },
};

/** Hook 订阅整个 store */
export function useGitStore<T>(selector: (s: GitStoreState) => T): T {
  return useSyncExternalStore(
    (listener) => gitStore.subscribe(listener),
    () => selector(gitStore.getState()),
    () => selector(initialState)
  );
}