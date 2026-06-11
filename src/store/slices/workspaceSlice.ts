import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import type { FileEntry, FileSource } from '../../services/fileService';
import { isSameSource, readFile, readDirectory, writeFile, isPath } from '../../services/fileService';
import { addRecentProject, getRecentProjects, removeRecentProject } from '../../services/fileHistory';
import type { RecentProject, GitStatusMap } from '../../types/electron';

export interface OpenedFile {
  id: string;
  name: string;
  source: FileSource;
  content: string;
  language: string;
  isDirty: boolean;
  isPreview?: boolean;
}

export interface SearchHighlight {
  keyword: string;
  line: number;
  column: number;
}

export interface ClipboardItem {
  source: FileSource;
  name: string;
  kind: 'file' | 'directory';
  parentSource: FileSource;
  action: 'cut' | 'copy';
}

/** 编辑器状态快照（光标、滚动位） */
export interface EditorSnapshot {
  cursor: { line: number; column: number };
  scrollTop: number;
}

/** 分屏生命周期阶段 */
export type SplitPhase = 'closed' | 'opening' | 'open' | 'closing';

interface WorkspaceState {
  rootSource: FileSource | null;
  rootName: string;
  entries: FileEntry[];
  openedFiles: OpenedFile[];
  activeFileId: string | null;
  activeFileSource: FileSource | null;
  recentProjects: RecentProject[];
  searchHighlight: SearchHighlight | null;
  clipboard: ClipboardItem | null;
  pendingSearchQuery: string | null;
  gitStatus: GitStatusMap;
  allFilePaths: string[];
  expandPaths: string[];
  expandedDirs: string[];
  leftFileIds: string[];
  rightFileIds: string[];
  rightActiveFileId: string | null;
  activeGroupIndex: number;
  /** 左右面板的分割比例 (left flex ratio, 默认 golden ≈ 1.618) */
  splitRatio: number;
  /** 编辑器快照缓存: `${fileId}::${groupIndex}` → snapshot */
  editorSnapshots: Record<string, EditorSnapshot>;
  /** 左面板 tab 访问历史栈 (MRU, 栈顶最新) */
  leftTabHistory: string[];
  /** 右面板 tab 访问历史栈 (MRU, 栈顶最新) */
  rightTabHistory: string[];
  /** 同文件跨面板时的独立编辑内容: `${fileId}::${groupIndex}` → content */
  mirrorContent: Record<string, string>;
  /** 分屏生命周期阶段 */
  splitPhase: SplitPhase;
}

const initialState: WorkspaceState = {
  rootSource: null,
  rootName: '',
  entries: [],
  openedFiles: [],
  activeFileId: null,
  activeFileSource: null,
  recentProjects: [],
  searchHighlight: null,
  clipboard: null,
  pendingSearchQuery: null,
  gitStatus: {},
  allFilePaths: [],
  expandPaths: [],
  expandedDirs: [],
  leftFileIds: [],
  rightFileIds: [],
  rightActiveFileId: null,
  activeGroupIndex: 0,
  splitRatio: 1.618,
  editorSnapshots: {},
  leftTabHistory: [],
  rightTabHistory: [],
  mirrorContent: {},
  splitPhase: 'closed',
};

export const loadDirectory = createAsyncThunk(
  'workspace/loadDirectory',
  async ({ source, name }: { source: FileSource; name: string }, { dispatch }) => {
    const entries = await readDirectory(source);

    if (isPath(source)) {
      try {
        await addRecentProject(source, name);
      } catch { /* 历史记录写入失败不应阻塞主流程 */ }
    }

    dispatch(refreshGitStatus());
    dispatch(refreshAllFilePaths(source));

    return { source, name, entries };
  }
);

export const openFile = createAsyncThunk(
  'workspace/openFile',
  async (entry: FileEntry) => {
    if (entry.kind !== 'file') return null;
    const content = await readFile(entry.source);

    const ext = entry.name.split('.').pop()?.toLowerCase() || '';
    const langMap: Record<string, string> = {
      ts: 'typescript', tsx: 'typescript',
      js: 'javascript', jsx: 'javascript',
      css: 'css', html: 'html', json: 'json',
      md: 'markdown', py: 'python',
    };
    const language = langMap[ext] || 'plaintext';

    return { id: entry.name, name: entry.name, source: entry.source, content, language, isDirty: false };
  }
);

export const refreshDirectory = createAsyncThunk(
  'workspace/refreshDirectory',
  async (source: FileSource) => {
    const entries = await readDirectory(source);
    return { source, entries };
  }
);

export const fetchRecentProjects = createAsyncThunk(
  'workspace/fetchRecentProjects',
  async () => getRecentProjects()
);

export const removeRecentProjectThunk = createAsyncThunk(
  'workspace/removeRecentProject',
  async (projectPath: string) => {
    await removeRecentProject(projectPath);
    return projectPath;
  }
);

export const saveFile = createAsyncThunk(
  'workspace/saveFile',
  async (payload: string | { id: string; groupIndex?: number }, { getState, dispatch }) => {
    const { id, groupIndex: gIdx = 0 } = typeof payload === 'string' ? { id: payload } : payload;
    const state = (getState() as { workspace: WorkspaceState }).workspace;
    const file = state.openedFiles.find((f) => f.id === id);
    if (!file) throw new Error('文件未找到');
    const mirrorKey = `${id}::${gIdx}`;
    const contentToSave = state.mirrorContent[mirrorKey] ?? file.content;
    await writeFile(file.source, contentToSave);
    dispatch(refreshGitStatus());
    return { id, groupIndex: gIdx, content: contentToSave };
  }
);

export const refreshGitStatus = createAsyncThunk(
  'workspace/refreshGitStatus',
  async (_: void, { getState }) => {
    const state = (getState() as { workspace: WorkspaceState }).workspace;
    const rootSource = state.rootSource;
    if (!rootSource || !isPath(rootSource)) return {};
    if (!window.electronAPI?.git) return {};
    try {
      return await window.electronAPI.git.getStatus(rootSource);
    } catch {
      return {};
    }
  }
);

export const refreshAllFilePaths = createAsyncThunk(
  'workspace/refreshAllFilePaths',
  async (overrideSource?: FileSource, { getState }) => {
    const state = (getState() as { workspace: WorkspaceState }).workspace;
    const rootSource = overrideSource || state.rootSource;
    if (!rootSource) return [];

    const paths: string[] = [];
    const excludeDirs = new Set([
      'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
      'out', '.vscode', '.idea', '__pycache__', 'vendor', '.yarn',
      '.nuxt', '.output', '.cache', 'tmp', 'temp',
    ]);

    async function collect(source: FileSource, prefix: string) {
      try {
        const entries = await readDirectory(source);
        for (const entry of entries) {
          if (entry.kind === 'directory' && excludeDirs.has(entry.name)) continue;
          const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.kind === 'file') { paths.push(fullPath); }
          else { await collect(entry.source, fullPath); }
        }
      } catch { /* 跳过无法读取的目录 */ }
    }

    await collect(rootSource, '');
    return paths;
  }
);

/* ─── MRU 历史栈工具 ─── */

function pushToHistory(stack: string[], id: string, maxLen = 20): string[] {
  const filtered = stack.filter((h) => h !== id);
  filtered.push(id);
  if (filtered.length > maxLen) filtered.shift();
  return filtered;
}

function removeFromHistory(stack: string[], id: string): string[] {
  return stack.filter((h) => h !== id);
}

function getTopOfHistory(stack: string[], exclude: string | null): string | undefined {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i] !== exclude) return stack[i];
  }
  return undefined;
}

const workspaceSlice = createSlice({
  name: 'workspace',
  initialState,
  reducers: {
    closeFile: (state, action) => {
      const payload = action.payload;
      const id = typeof payload === 'string' ? payload : (payload as { id: string; groupIndex?: number }).id;
      const groupIndex = typeof payload === 'string' ? state.activeGroupIndex : ((payload as { id: string; groupIndex?: number }).groupIndex ?? state.activeGroupIndex);
      const groupFileIds = groupIndex === 0 ? state.leftFileIds : state.rightFileIds;

      const newFileIds = groupFileIds.filter((fid) => fid !== id);
      if (groupIndex === 0) {
        state.leftFileIds = newFileIds;
        state.leftTabHistory = removeFromHistory(state.leftTabHistory, id);
        if (state.activeFileId === id) {
          const nextId = getTopOfHistory(state.leftTabHistory, id) ?? newFileIds[0] ?? null;
          state.activeFileId = nextId;
          const nextFile = state.openedFiles.find((f) => f.id === nextId);
          state.activeFileSource = nextFile?.source ?? null;
        }
      } else {
        state.rightFileIds = newFileIds;
        state.rightTabHistory = removeFromHistory(state.rightTabHistory, id);
        if (state.rightActiveFileId === id) {
          const nextId = getTopOfHistory(state.rightTabHistory, id) ?? newFileIds[0] ?? null;
          state.rightActiveFileId = nextId;
        }
      }

      const stillOpen = state.leftFileIds.includes(id) || state.rightFileIds.includes(id);
      if (!stillOpen) {
        state.openedFiles = state.openedFiles.filter((f) => f.id !== id);
        // 清理快照和镜像内容
        delete state.editorSnapshots[`${id}::0`];
        delete state.editorSnapshots[`${id}::1`];
        delete state.mirrorContent[`${id}::0`];
        delete state.mirrorContent[`${id}::1`];
      }
      // 文件不再跨面板存在时清理镜像，但先同步剩余面板内容
      const stillMirrored = state.leftFileIds.includes(id) && state.rightFileIds.includes(id);
      if (!stillMirrored) {
        // 将残留的镜像内容同步回共享文件
        const remainingGroup = state.leftFileIds.includes(id) ? 0 : (state.rightFileIds.includes(id) ? 1 : -1);
        if (remainingGroup >= 0) {
          const remainingContent = state.mirrorContent[`${id}::${remainingGroup}`];
          if (remainingContent !== undefined) {
            const file = state.openedFiles.find((f) => f.id === id);
            if (file) file.content = remainingContent;
          }
        }
        delete state.mirrorContent[`${id}::0`];
        delete state.mirrorContent[`${id}::1`];
      }

      if (state.leftFileIds.length === 0 && state.rightFileIds.length === 0) {
        state.activeFileId = null;
        state.activeFileSource = null;
        state.rightActiveFileId = null;
      }

      // 当一侧面板无 tab 而另一侧有 tab 时，自动收起分屏
      if (state.rightFileIds.length === 0 && state.leftFileIds.length > 0) {
        state.splitPhase = 'closed';
        state.rightActiveFileId = null;
        state.rightTabHistory = [];
        state.activeGroupIndex = 0;
      } else if (state.leftFileIds.length === 0 && state.rightFileIds.length > 0) {
        // 左面板空了，把右侧内容迁移到左侧
        state.leftFileIds = state.rightFileIds;
        state.activeFileId = state.rightActiveFileId;
        if (state.activeFileId) {
          const af = state.openedFiles.find((f) => f.id === state.activeFileId);
          state.activeFileSource = af?.source ?? null;
        }
        // 同步镜像内容
        for (const id of state.rightFileIds) {
          const mirrored = state.mirrorContent[`${id}::1`];
          if (mirrored !== undefined) {
            const file = state.openedFiles.find((f) => f.id === id);
            if (file) file.content = mirrored;
          }
          delete state.mirrorContent[`${id}::0`];
          delete state.mirrorContent[`${id}::1`];
        }
        state.rightFileIds = [];
        state.rightActiveFileId = null;
        state.rightTabHistory = [];
        state.activeGroupIndex = 0;
        state.splitPhase = 'closed';
      }
    },
    activateFile: (state, action) => {
      const id = action.payload as string;
      const fileIds = state.activeGroupIndex === 0 ? state.leftFileIds : state.rightFileIds;

      if (!fileIds.includes(id)) {
        fileIds.push(id);
      }

      if (state.activeGroupIndex === 0) {
        state.activeFileId = id;
        state.leftTabHistory = pushToHistory(state.leftTabHistory, id);
        const file = state.openedFiles.find((f) => f.id === id);
        if (file) {
          state.activeFileSource = file.source;
        }
      } else {
        state.rightActiveFileId = id;
        state.rightTabHistory = pushToHistory(state.rightTabHistory, id);
        // 同步更新 activeFileSource
        const file = state.openedFiles.find((f) => f.id === id);
        if (file) {
          state.activeFileSource = file.source;
        }
      }
    },
    /** Ctrl+Tab MRU 导航：在 activeGroupIndex 的面板内切换到历史栈上一个 */
    navigateTabHistory: (state, action) => {
      const direction = (action.payload as 'forward' | 'backward') || 'backward';
      const isLeft = state.activeGroupIndex === 0;
      const history = isLeft ? state.leftTabHistory : state.rightTabHistory;
      const currentId = isLeft ? state.activeFileId : state.rightActiveFileId;

      if (history.length <= 1) return;

      if (direction === 'backward') {
        // 在历史栈中找上一个（跳过当前 active 的）
        const target = getTopOfHistory(history, currentId);
        if (target) {
          if (isLeft) {
            state.activeFileId = target;
            const file = state.openedFiles.find((f) => f.id === target);
            if (file) state.activeFileSource = file.source;
            state.leftTabHistory = pushToHistory(state.leftTabHistory, target);
          } else {
            state.rightActiveFileId = target;
            const file = state.openedFiles.find((f) => f.id === target);
            if (file) state.activeFileSource = file.source;
            state.rightTabHistory = pushToHistory(state.rightTabHistory, target);
          }
        }
      }
    },
    setFileContent: (state, action) => {
      const { id, content } = action.payload as { id: string; content: string };
      // 同文件跨面板编辑：存入镜像而非直接覆盖共享内容
      const isMirrored = state.leftFileIds.includes(id) && state.rightFileIds.includes(id);
      if (isMirrored) {
        state.mirrorContent[`${id}::${state.activeGroupIndex}`] = content;
      }
      const file = state.openedFiles.find((f) => f.id === id);
      if (file) {
        if (!isMirrored) {
          file.content = content;
        }
        file.isDirty = true;
        file.isPreview = false;
      }
    },
    /** 设置镜像文件内容（跨面板编辑时用） */
    setMirrorFileContent: (state, action) => {
      const { fileId, groupIndex, content } = action.payload as {
        fileId: string;
        groupIndex: number;
        content: string;
      };
      state.mirrorContent[`${fileId}::${groupIndex}`] = content;
      const file = state.openedFiles.find((f) => f.id === fileId);
      if (file) {
        file.isDirty = true;
        file.isPreview = false;
      }
    },
    pinPreviewFile: (state) => {
      const fileIds = state.activeGroupIndex === 0 ? state.leftFileIds : state.rightFileIds;
      const previewId = fileIds.find((fid) => {
        const f = state.openedFiles.find((of) => of.id === fid);
        return f?.isPreview;
      });
      if (previewId) {
        const preview = state.openedFiles.find((f) => f.id === previewId);
        if (preview) {
          preview.isPreview = false;
        }
      }
    },
    markFileSaved: (state, action) => {
      const id = action.payload as string;
      const file = state.openedFiles.find((f) => f.id === id);
      if (file) { file.isDirty = false; }
    },
    setSearchHighlight: (state, action) => {
      state.searchHighlight = action.payload as SearchHighlight;
    },
    clearSearchHighlight: (state) => {
      state.searchHighlight = null;
    },
    setClipboard: (state, action) => {
      state.clipboard = action.payload as ClipboardItem | null;
    },
    clearClipboard: (state) => {
      state.clipboard = null;
    },
    setPendingSearchQuery: (state, action) => {
      state.pendingSearchQuery = action.payload as string | null;
    },
    expandToFile: (state, action) => {
      const filePath = action.payload as string;
      const parts = filePath.split('/');
      const paths: string[] = [];
      let current = '';
      for (let i = 0; i < parts.length - 1; i++) {
        current = current ? `${current}/${parts[i]}` : parts[i];
        paths.push(current);
      }
      state.expandPaths = paths;
    },
    clearExpandPaths: (state) => {
      state.expandPaths = [];
    },
    toggleExpandDir: (state, action) => {
      const { path, expand } = action.payload as { path: string; expand: boolean };
      if (expand) {
        if (!state.expandedDirs.includes(path)) {
          state.expandedDirs.push(path);
        }
      } else {
        state.expandedDirs = state.expandedDirs.filter((p) => p !== path);
      }
    },
    toggleSplitView: (state) => {
      if (state.rightFileIds.length === 0) {
        state.splitPhase = 'opening';
        if (state.activeFileId) {
          state.rightFileIds = [state.activeFileId];
          state.rightActiveFileId = state.activeFileId;
          // 同文件跨面板：初始化镜像内容
          const mirroredFile = state.openedFiles.find((f) => f.id === state.activeFileId);
          if (mirroredFile) {
            state.mirrorContent[`${state.activeFileId}::0`] = mirroredFile.content;
            state.mirrorContent[`${state.activeFileId}::1`] = mirroredFile.content;
          }
        }
        state.activeGroupIndex = 1;
        state.splitPhase = 'open';
      } else {
        state.splitPhase = 'closing';
        // 关闭前同步镜像内容回共享文件
        for (const id of state.rightFileIds) {
          if (!state.leftFileIds.includes(id)) {
            state.leftFileIds.push(id);
          }
          const mirrored = state.mirrorContent[`${id}::1`];
          if (mirrored !== undefined) {
            const file = state.openedFiles.find((f) => f.id === id);
            if (file) {
              file.content = mirrored;
            }
          }
          delete state.mirrorContent[`${id}::0`];
          delete state.mirrorContent[`${id}::1`];
        }
        state.rightFileIds = [];
        state.rightActiveFileId = null;
        state.rightTabHistory = [];
        state.activeGroupIndex = 0;
        state.splitPhase = 'closed';
      }
    },
    setActiveGroup: (state, action) => {
      state.activeGroupIndex = action.payload as number;
    },
    /** 保存编辑器快照 */
    saveEditorSnapshot: (state, action) => {
      const { fileId, groupIndex, snapshot } = action.payload as {
        fileId: string;
        groupIndex: number;
        snapshot: EditorSnapshot;
      };
      state.editorSnapshots[`${fileId}::${groupIndex}`] = snapshot;
    },
    /** 设置面板分割比例 */
    setSplitRatio: (state, action) => {
      state.splitRatio = Math.max(0.5, Math.min(4.0, action.payload as number));
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadDirectory.fulfilled, (state, action) => {
        state.rootSource = action.payload.source;
        state.rootName = action.payload.name;
        state.entries = action.payload.entries;
      })
      .addCase(openFile.fulfilled, (state, action) => {
        if (!action.payload) return;
        const file = action.payload;
        const fileIds = state.activeGroupIndex === 0 ? state.leftFileIds : state.rightFileIds;

        if (!state.openedFiles.find((f) => f.id === file.id)) {
          state.openedFiles.push({ ...file, isPreview: true });
        }

        // 文件已在当前面板 tab 列表中：直接激活
        if (fileIds.includes(file.id)) {
          if (state.activeGroupIndex === 0) {
            state.activeFileId = file.id;
            state.activeFileSource = file.source;
            state.leftTabHistory = pushToHistory(state.leftTabHistory, file.id);
          } else {
            state.rightActiveFileId = file.id;
            state.activeFileSource = file.source;
            state.rightTabHistory = pushToHistory(state.rightTabHistory, file.id);
          }
          return;
        }

        // 在当前面板 active Tab 后面插入新 tab
        const activeId = state.activeGroupIndex === 0 ? state.activeFileId : state.rightActiveFileId;
        const activeIndex = activeId ? fileIds.indexOf(activeId) : -1;
        if (activeIndex >= 0) {
          fileIds.splice(activeIndex + 1, 0, file.id);
        } else {
          fileIds.push(file.id);
        }

        if (state.activeGroupIndex === 0) {
          state.activeFileId = file.id;
          state.activeFileSource = file.source;
          state.leftTabHistory = pushToHistory(state.leftTabHistory, file.id);
        } else {
          state.rightActiveFileId = file.id;
          state.activeFileSource = file.source;
          state.rightTabHistory = pushToHistory(state.rightTabHistory, file.id);
        }
      })
      .addCase(fetchRecentProjects.fulfilled, (state, action) => {
        state.recentProjects = action.payload;
      })
      .addCase(refreshDirectory.fulfilled, (state, action) => {
        if (state.rootSource && isSameSource(state.rootSource, action.payload.source)) {
          state.entries = action.payload.entries;
        }
      })
      .addCase(removeRecentProjectThunk.fulfilled, (state, action) => {
        state.recentProjects = state.recentProjects.filter((p) => p.path !== action.payload);
      })
      .addCase(saveFile.fulfilled, (state, action) => {
        const { id, content } = action.payload;
        const file = state.openedFiles.find((f) => f.id === id);
        if (file) {
          file.content = content;
          file.isDirty = false;
        }
        // 清理所有镜像内容（已同步到共享文件）
        delete state.mirrorContent[`${id}::0`];
        delete state.mirrorContent[`${id}::1`];
      })
      .addCase(refreshGitStatus.fulfilled, (state, action) => {
        state.gitStatus = action.payload;
      })
      .addCase(refreshAllFilePaths.fulfilled, (state, action) => {
        state.allFilePaths = action.payload;
      });
  },
});

export const {
  closeFile, activateFile, navigateTabHistory, setFileContent, setMirrorFileContent, markFileSaved,
  pinPreviewFile, setSearchHighlight, clearSearchHighlight, setClipboard,
  clearClipboard, setPendingSearchQuery, expandToFile, clearExpandPaths,
  toggleExpandDir, toggleSplitView, setActiveGroup, saveEditorSnapshot, setSplitRatio,
} = workspaceSlice.actions;

export default workspaceSlice.reducer;
