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
  /** 文件内容是否已被修改但未保存 */
  isDirty: boolean;
  /** 是否为预览模式（单点打开、未编辑），再打开新文件会覆盖 */
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
  /** 待执行的搜索查询（由外部触发） */
  pendingSearchQuery: string | null;
  /** Git 文件状态映射：相对路径 → 状态码 */
  gitStatus: GitStatusMap;
  /** 所有文件路径（用于 QuickOpen） */
  allFilePaths: string[];
  /** 需要自动展开的目录路径链（从 QuickOpen 打开文件时触发） */
  expandPaths: string[];
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
};

export const loadDirectory = createAsyncThunk(
  'workspace/loadDirectory',
  async ({ source, name }: { source: FileSource; name: string }, { dispatch }) => {
    const entries = await readDirectory(source);

    if (isPath(source)) {
      try {
        await addRecentProject(source, name);
      } catch {
        // 历史记录写入失败不应阻塞主流程
      }
    }

    // 异步刷新 Git 状态和文件路径列表，不阻塞目录加载
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
      ts: 'typescript',
      tsx: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
      css: 'css',
      html: 'html',
      json: 'json',
      md: 'markdown',
      py: 'python',
    };
    const language = langMap[ext] || 'plaintext';

    return {
      id: entry.name,
      name: entry.name,
      source: entry.source,
      content,
      language,
      isDirty: false,
    };
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
  async () => {
    return getRecentProjects();
  }
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
  async (id: string, { getState, dispatch }) => {
    const state = (getState() as { workspace: { openedFiles: OpenedFile[] } }).workspace;
    const file = state.openedFiles.find((f) => f.id === id);
    if (!file) throw new Error('文件未找到');
    await writeFile(file.source, file.content);
    dispatch(refreshGitStatus());
    return id;
  }
);

export const refreshGitStatus = createAsyncThunk(
  'workspace/refreshGitStatus',
  async (_: void, { getState }) => {
    const state = (getState() as { workspace: WorkspaceState }).workspace;
    const rootSource = state.rootSource;

    if (!rootSource || !isPath(rootSource)) {
      return {};
    }

    if (!window.electronAPI?.git) {
      return {};
    }

    try {
      return await window.electronAPI.git.getStatus(rootSource);
    } catch {
      return {};
    }
  }
);

/**
 * 递归收集所有文件路径（用于 QuickOpen）
 */
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
          if (entry.kind === 'file') {
            paths.push(fullPath);
          } else {
            await collect(entry.source, fullPath);
          }
        }
      } catch {
        // 跳过无法读取的目录
      }
    }

    await collect(rootSource, '');
    return paths;
  }
);

const workspaceSlice = createSlice({
  name: 'workspace',
  initialState,
  reducers: {
    closeFile: (state, action) => {
      const id = action.payload as string;
      // 记录被关闭文件在 openedFiles 中的索引（filter 前获取）
      const closedIndex = state.openedFiles.findIndex((f) => f.id === id);
      state.openedFiles = state.openedFiles.filter((f) => f.id !== id);
      if (state.activeFileId === id) {
        // 优先选中后一位
        const nextFile = state.openedFiles[closedIndex];
        if (nextFile) {
          state.activeFileId = nextFile.id;
          state.activeFileSource = nextFile.source;
        } else if (state.openedFiles.length > 0) {
          // 后一位不存在，选中前一位（最后一个）
          const last = state.openedFiles[state.openedFiles.length - 1];
          state.activeFileId = last.id;
          state.activeFileSource = last.source;
        } else {
          state.activeFileId = null;
          state.activeFileSource = null;
        }
      }
    },
    activateFile: (state, action) => {
      const id = action.payload as string;
      state.activeFileId = id;
      const file = state.openedFiles.find((f) => f.id === id);
      if (file) {
        state.activeFileSource = file.source;
      }
    },
    setFileContent: (state, action) => {
      const { id, content } = action.payload as { id: string; content: string };
      const file = state.openedFiles.find((f) => f.id === id);
      if (file) {
        file.content = content;
        file.isDirty = true;
        file.isPreview = false; // 编辑后固定
      }
    },
    pinPreviewFile: (state) => {
      const preview = state.openedFiles.find((f) => f.isPreview);
      if (preview) {
        preview.isPreview = false;
      }
    },
    markFileSaved: (state, action) => {
      const id = action.payload as string;
      const file = state.openedFiles.find((f) => f.id === id);
      if (file) {
        file.isDirty = false;
      }
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
      // 构建需要展开的目录路径链（排除文件名本身）
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

        // 已在 openedFiles 中：直接激活
        const inOpened = state.openedFiles.find((f) => f.id === file.id);
        if (inOpened) {
          state.activeFileId = file.id;
          state.activeFileSource = file.source;
          return;
        }

        // 如果已有预览 Tab，替换它（保持位置）
        const previewIndex = state.openedFiles.findIndex((f) => f.isPreview);
        if (previewIndex >= 0) {
          state.openedFiles[previewIndex] = { ...file, isPreview: true };
          state.activeFileId = file.id;
          state.activeFileSource = file.source;
          return;
        }

        // 在当前 active Tab 后面插入新的预览 Tab
        const activeIndex = state.openedFiles.findIndex((f) => f.id === state.activeFileId);
        if (activeIndex >= 0) {
          state.openedFiles.splice(activeIndex + 1, 0, { ...file, isPreview: true });
        } else {
          state.openedFiles.push({ ...file, isPreview: true });
        }
        state.activeFileId = file.id;
        state.activeFileSource = file.source;
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
        state.recentProjects = state.recentProjects.filter(
          (p) => p.path !== action.payload
        );
      })
      .addCase(saveFile.fulfilled, (state, action) => {
        const file = state.openedFiles.find((f) => f.id === action.payload);
        if (file) {
          file.isDirty = false;
        }
      })
      .addCase(refreshGitStatus.fulfilled, (state, action) => {
        state.gitStatus = action.payload;
      })
      .addCase(refreshAllFilePaths.fulfilled, (state, action) => {
        state.allFilePaths = action.payload;
      });
  },
});

export const { closeFile, activateFile, setFileContent, markFileSaved, pinPreviewFile, setSearchHighlight, clearSearchHighlight, setClipboard, clearClipboard, setPendingSearchQuery, expandToFile, clearExpandPaths } = workspaceSlice.actions;

export default workspaceSlice.reducer;
