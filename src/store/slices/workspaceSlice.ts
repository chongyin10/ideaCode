import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import type { FileEntry, FileSource } from '../../services/fileService';
import { isSameSource } from '../../services/fileService';
import type { RecentProject } from '../../types/electron';

export interface OpenedFile {
  id: string;
  name: string;
  source: FileSource;
  content: string;
  language: string;
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
};

export const loadDirectory = createAsyncThunk(
  'workspace/loadDirectory',
  async ({ source, name }: { source: FileSource; name: string }) => {
    const { readDirectory, addRecentProject, isPath } = await import('../../services/fileService');
    const entries = await readDirectory(source);

    // Electron 环境下自动记录到历史
    if (isPath(source)) {
      try {
        await addRecentProject(source, name);
      } catch {
        // 历史记录写入失败不应阻塞主流程
      }
    }

    return { source, name, entries };
  }
);

export const openFile = createAsyncThunk(
  'workspace/openFile',
  async (entry: FileEntry) => {
    if (entry.kind !== 'file') return null;
    const { readFile } = await import('../../services/fileService');
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
    };
  }
);

export const refreshDirectory = createAsyncThunk(
  'workspace/refreshDirectory',
  async (source: FileSource) => {
    const { readDirectory } = await import('../../services/fileService');
    const entries = await readDirectory(source);
    return { source, entries };
  }
);

export const fetchRecentProjects = createAsyncThunk(
  'workspace/fetchRecentProjects',
  async () => {
    const { getRecentProjects } = await import('../../services/fileService');
    return getRecentProjects();
  }
);

export const removeRecentProjectThunk = createAsyncThunk(
  'workspace/removeRecentProject',
  async (projectPath: string) => {
    const { removeRecentProject } = await import('../../services/fileService');
    await removeRecentProject(projectPath);
    return projectPath;
  }
);

const workspaceSlice = createSlice({
  name: 'workspace',
  initialState,
  reducers: {
    closeFile: (state, action) => {
      const id = action.payload as string;
      state.openedFiles = state.openedFiles.filter((f) => f.id !== id);
      if (state.activeFileId === id) {
        const last = state.openedFiles[state.openedFiles.length - 1];
        state.activeFileId = last ? last.id : null;
        state.activeFileSource = last ? last.source : null;
      }
    },
    activateFile: (state, action) => {
      const id = action.payload as string;
      state.activeFileId = id;
      const file = state.openedFiles.find((f) => f.id === id);
      state.activeFileSource = file ? file.source : null;
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
        const exists = state.openedFiles.find((f) => f.id === file.id);
        if (!exists) {
          state.openedFiles.push(file);
        }
        state.activeFileId = file.id;
        state.activeFileSource = file.source;
        // 打开文件后保留 searchHighlight（供 MonacoEditor 消费）
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
      });
  },
});

export const { closeFile, activateFile, setSearchHighlight, clearSearchHighlight, setClipboard, clearClipboard, setPendingSearchQuery } = workspaceSlice.actions;
export default workspaceSlice.reducer;
