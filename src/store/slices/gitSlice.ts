import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import type { GitBranch, GitRemote, GitBehindAhead } from '../../types/electron';
import { gitService } from '../../services/gitService';

/* ─── State ─── */

interface GitState {
  staged: Record<string, string>;
  changes: Record<string, string>;
  merge: Record<string, string>;
  untracked: Record<string, string>;
  branch: string;
  branches: GitBranch[];
  remotes: GitRemote[];
  behindAhead: GitBehindAhead;
  log: string[];
  stashes: string[];
  loading: boolean;
  error: string | null;
  showCloneForm: boolean;
  cloneProgress: string;
  clonePercent: number;
  /** #12 熔断器: 连续失败计数 */
  failureCount: number;
}

const initialState: GitState = {
  staged: {},
  changes: {},
  merge: {},
  untracked: {},
  branch: '',
  branches: [],
  remotes: [],
  behindAhead: { ahead: 0, behind: 0 },
  log: [],
  stashes: [],
  loading: false,
  error: null,
  showCloneForm: false,
  cloneProgress: '',
  clonePercent: 0,
  failureCount: 0,
};

/* ─── Thunks ─── */

function getRootPath(state: { workspace: { rootSource: string | FileSystemHandle | null } }): string | null {
  const root = state.workspace.rootSource;
  return typeof root === 'string' ? root : null;
}

export const refreshGitStatus = createAsyncThunk(
  'git/refreshStatus',
  async (_: void, { getState }) => {
    const root = getRootPath(getState() as { workspace: { rootSource: unknown } });
    if (!root) return null;
    const result = await gitService.getStatus(root);
    return result;
  }
);

export const refreshBranch = createAsyncThunk(
  'git/refreshBranch',
  async (_: void, { getState }) => {
    const root = getRootPath(getState() as { workspace: { rootSource: unknown } });
    if (!root) return null;
    const [branch, behindAhead, remotes] = await Promise.all([
      gitService.getBranch(root),
      gitService.getBehindAhead(root).catch(() => ({ ahead: 0, behind: 0 })),
      gitService.listRemotes(root),
    ]);
    return { branch, behindAhead, remotes };
  }
);

export const refreshBranches = createAsyncThunk(
  'git/refreshBranches',
  async (_: void, { getState }) => {
    const root = getRootPath(getState() as { workspace: { rootSource: unknown } });
    if (!root) return [];
    return gitService.listBranches(root);
  }
);

export const refreshLog = createAsyncThunk(
  'git/refreshLog',
  async (_: void, { getState }) => {
    const root = getRootPath(getState() as { workspace: { rootSource: unknown } });
    if (!root) return [];
    return gitService.getLog(root);
  }
);

export const refreshStashes = createAsyncThunk(
  'git/refreshStashes',
  async (_: void, { getState }) => {
    const root = getRootPath(getState() as { workspace: { rootSource: unknown } });
    if (!root) return [];
    return gitService.stashList(root);
  }
);

export const stageFiles = createAsyncThunk(
  'git/stage',
  async (files: string[], { getState, dispatch }) => {
    const root = getRootPath(getState() as { workspace: { rootSource: unknown } });
    if (!root) throw new Error('no project');
    // #1 分块批量暂存: 单批 ≤50 个文件，避免 shell 参数过长
    const BATCH = 50;
    for (let i = 0; i < files.length; i += BATCH) {
      await gitService.stage(root, files.slice(i, i + BATCH));
    }
    dispatch(refreshGitStatus());
  }
);

export const unstageFiles = createAsyncThunk(
  'git/unstage',
  async (files: string[], { getState, dispatch }) => {
    const root = getRootPath(getState() as { workspace: { rootSource: unknown } });
    if (!root) throw new Error('no project');
    await gitService.unstage(root, files);
    dispatch(refreshGitStatus());
  }
);

export const commit = createAsyncThunk(
  'git/commit',
  async (message: string, { getState, dispatch }) => {
    const root = getRootPath(getState() as { workspace: { rootSource: unknown } });
    if (!root) throw new Error('no project');
    const output = await gitService.commit(root, message);
    await Promise.all([
      dispatch(refreshGitStatus()),
      dispatch(refreshLog()),
    ]);
    return output;
  }
);

export const checkoutBranch = createAsyncThunk(
  'git/checkout',
  async (branch: string, { getState, dispatch }) => {
    const root = getRootPath(getState() as { workspace: { rootSource: unknown } });
    if (!root) throw new Error('no project');
    await gitService.checkout(root, branch);
    await Promise.all([
      dispatch(refreshGitStatus()),
      dispatch(refreshBranch()),
      dispatch(refreshBranches()),
    ]);
    // 切换分支后刷新资源管理器、检查已打开文件是否存在并刷新未修改文件内容
    const { refreshDirectory, checkMissingFiles, refreshOpenedFiles } = await import('./workspaceSlice');
    await dispatch(refreshDirectory(root));
    await dispatch(checkMissingFiles());
    await dispatch(refreshOpenedFiles());
  }
);

export const createBranch = createAsyncThunk(
  'git/createBranch',
  async ({ branch, startPoint }: { branch: string; startPoint?: string }, { getState, dispatch }) => {
    const root = getRootPath(getState() as { workspace: { rootSource: unknown } });
    if (!root) throw new Error('no project');
    await gitService.createBranch(root, branch, startPoint);
    await Promise.all([
      dispatch(refreshGitStatus()),
      dispatch(refreshBranch()),
      dispatch(refreshBranches()),
    ]);
  }
);

export const pullBranch = createAsyncThunk(
  'git/pull',
  async (_: void, { getState, dispatch }) => {
    const root = getRootPath(getState() as { workspace: { rootSource: unknown } });
    if (!root) throw new Error('no project');
    const output = await gitService.pull(root);
    await Promise.all([
      dispatch(refreshGitStatus()),
      dispatch(refreshBranch()),
      dispatch(refreshLog()),
    ]);
    return output;
  }
);

export const pushBranch = createAsyncThunk(
  'git/push',
  async (_: void, { getState, dispatch }) => {
    const root = getRootPath(getState() as { workspace: { rootSource: unknown } });
    if (!root) throw new Error('no project');
    const output = await gitService.push(root);
    await Promise.all([
      dispatch(refreshGitStatus()),
      dispatch(refreshBranch()),
    ]);
    return output;
  }
);

export const discardFile = createAsyncThunk(
  'git/discard',
  async (file: string, { getState, dispatch }) => {
    const root = getRootPath(getState() as { workspace: { rootSource: unknown } });
    if (!root) throw new Error('no project');
    await gitService.discard(root, file);
    dispatch(refreshGitStatus());
  }
);

export const stashPush = createAsyncThunk(
  'git/stashPush',
  async (message: string | undefined, { getState, dispatch }) => {
    const root = getRootPath(getState() as { workspace: { rootSource: unknown } });
    if (!root) throw new Error('no project');
    await gitService.stashPush(root, message);
    await Promise.all([
      dispatch(refreshGitStatus()),
      dispatch(refreshStashes()),
    ]);
  }
);

export const stashPop = createAsyncThunk(
  'git/stashPop',
  async (_: void, { getState, dispatch }) => {
    const root = getRootPath(getState() as { workspace: { rootSource: unknown } });
    if (!root) throw new Error('no project');
    await gitService.stashPop(root);
    await Promise.all([
      dispatch(refreshGitStatus()),
      dispatch(refreshStashes()),
    ]);
  }
);

export const initRepo = createAsyncThunk(
  'git/init',
  async (_: void, { getState, dispatch }) => {
    const root = getRootPath(getState() as { workspace: { rootSource: unknown } });
    if (!root) throw new Error('no project');
    await gitService.init(root);
    await Promise.all([
      dispatch(refreshGitStatus()),
      dispatch(refreshBranch()),
    ]);
  }
);

export const cloneRepo = createAsyncThunk(
  'git/clone',
  async ({ url, targetPath }: { url: string; targetPath: string }, { dispatch }) => {
    // 设置进度监听（主进程 → 渲染进程 IPC 事件）
    const api = window.electronAPI?.git;
    const unsub = api?.onCloneProgress
      ? api.onCloneProgress((data: string) => {
          dispatch(setCloneProgress(data));
        })
      : undefined;

    try {
      await gitService.clone(url, targetPath);
      dispatch(resetCloneProgress());
      // 克隆完成后触发加载新目录
      try {
        const { loadDirectory } = await import('./workspaceSlice');
        dispatch(loadDirectory({ source: targetPath, name: targetPath.split('/').pop() || targetPath }));
      } catch {
        // import 失败时仍尝试关闭表单
      }
      dispatch(setShowCloneForm(false));
    } catch (e) {
      dispatch(resetCloneProgress());
      throw e;
    } finally {
      unsub?.();
    }
  }
);

/* ─── Slice ─── */

const gitSlice = createSlice({
  name: 'git',
  initialState,
  reducers: {
    clearGitError: (state) => { state.error = null; },
    setShowCloneForm: (state, action) => {
      const show = action.payload as boolean;
      state.showCloneForm = show;
      // 打开克隆表单时清空上次进度
      if (show) {
        state.cloneProgress = '';
        state.clonePercent = 0;
      }
    },
    setCloneProgress: (state, action) => {
      const msg = action.payload as string;
      if (msg.startsWith('percent:')) {
        state.clonePercent = parseInt(msg.slice(8), 10) || 0;
      } else {
        state.cloneProgress = msg;
      }
    },
    resetCloneProgress: (state) => {
      state.cloneProgress = '';
      state.clonePercent = 0;
    },
    /** #12 熔断器: 重置失败计数 */
    resetFailureCount: (state) => { state.failureCount = 0; },
  },
  extraReducers: (builder) => {
    builder
      .addCase(refreshGitStatus.fulfilled, (state, action) => {
        if (action.payload) {
          state.staged = action.payload.staged;
          state.changes = action.payload.changes;
          state.merge = action.payload.merge;
          state.untracked = action.payload.untracked;
        }
      })
      .addCase(refreshBranch.fulfilled, (state, action) => {
        if (action.payload) {
          state.branch = action.payload.branch;
          state.behindAhead = action.payload.behindAhead;
          state.remotes = action.payload.remotes;
        }
      })
      .addCase(refreshBranches.fulfilled, (state, action) => {
        if (action.payload) state.branches = action.payload;
      })
      .addCase(refreshLog.fulfilled, (state, action) => {
        if (action.payload) state.log = action.payload;
      })
      .addCase(refreshStashes.fulfilled, (state, action) => {
        if (action.payload) state.stashes = action.payload;
      })
      // loading / error for all thunks
      .addMatcher(
        (action) => action.type.startsWith('git/') && action.type.endsWith('/pending'),
        (state) => { state.loading = true; state.error = null; }
      )
      .addMatcher(
        (action) => action.type.startsWith('git/') && action.type.endsWith('/fulfilled'),
        (state) => { state.loading = false; state.failureCount = 0; }
      )
      .addMatcher(
        (action) => action.type.startsWith('git/') && action.type.endsWith('/rejected'),
        (state, action) => {
          state.loading = false;
          state.error = (action.error as { message?: string }).message || '操作失败';
          // #12 熔断器: 连续失败计数
          state.failureCount = (state.failureCount || 0) + 1;
          if (state.failureCount >= 5) {
            state.error = 'Git 操作连续失败，请检查仓库状态。点击刷新重试。';
          }
        }
      );
  },
});

export const { clearGitError, setShowCloneForm, setCloneProgress, resetCloneProgress } = gitSlice.actions;
export default gitSlice.reducer;
