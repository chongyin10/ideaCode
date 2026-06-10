import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import type { FileEntry, FileSource } from '../../services/fileService';
import { isSameSource, readFile, readDirectory, writeFile, addRecentProject, isPath, getRecentProjects, removeRecentProject } from '../../services/fileService';
import type { RecentProject } from '../../types/electron';

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
    const entries = await readDirectory(source);

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
  async (id: string, { getState }) => {
    const state = (getState() as { workspace: { openedFiles: OpenedFile[] } }).workspace;
    const file = state.openedFiles.find((f) => f.id === id);
    if (!file) throw new Error('文件未找到');
    await writeFile(file.source, file.content);
    return id;
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
      });
  },
});

export const { closeFile, activateFile, setFileContent, markFileSaved, pinPreviewFile, setSearchHighlight, clearSearchHighlight, setClipboard, clearClipboard, setPendingSearchQuery } = workspaceSlice.actions;

export default workspaceSlice.reducer;
