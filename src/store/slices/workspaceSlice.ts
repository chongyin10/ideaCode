import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import type { FileEntry, FileSource } from '../../services/fileService';
import { isSameSource, readFile, readDirectory, writeFile, isPath, isRemoteUri } from '../../services/fileService';
import { addRecentProject, getRecentProjects, removeRecentProject } from '../../services/fileHistory';
import type { RecentProject } from '../../types/electron';
export interface OpenedFile {
  id: string;
  name: string;
  source: FileSource;
  content: string;
  language: string;
  isDirty: boolean;
  isPreview?: boolean;
  /** 是否只读（可手动解锁） */
  readOnly?: boolean;
  /** 是否为 Git Diff 虚拟文件 */
  isDiff?: boolean;
  /** Diff 视图数据（仅当 isDiff 为 true 时有效） */
  diffData?: DiffView;
}

export interface SearchHighlight {
  keyword: string;
  line: number;
  column: number;
}

export interface WorkspaceRoot {
  id: string;
  name: string;
  source: FileSource;
}

/** §SSH 远程连接信息：从 SshFileTreePanel "添加到资源管理器" 时写入，
 *  资源管理器在右键 "在终端中打开" 时读取它来构造 SSH 终端命令。 */
export interface SshConnectionInfo {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  /** password / key 暂不持久化（终端需要时再由 SshFileTreePanel 提供） */
  authType: 'password' | 'key';
}

export interface ClipboardItem {
  source: FileSource;
  name: string;
  kind: 'file' | 'directory';
  parentSource: FileSource;
  action: 'cut' | 'copy';
}

export interface EditorSnapshot {
  cursor: { line: number; column: number };
  scrollTop: number;
}

export type SplitPhase = 'closed' | 'opening' | 'open' | 'closing';

/** 编辑器组（一个分屏列） */
export interface EditorGroup {
  id: string;
  fileIds: string[];
  activeFileId: string | null;
  tabHistory: string[];
  ratio: number;
}

/** Git Diff 视图数据 */
export interface DiffView {
  filePath: string;
  fileName: string;
  original: string;
  modified: string;
  language: string;
}

interface WorkspaceState {
  rootSource: FileSource | null;
  rootName: string;
  /** §项目环境类型：'local'（本地项目）或 'ssh'（SSH 远程项目）或 null（未加载）。
   *  在 loadDirectory.fulfilled 中根据 source 自动判断写入，作为终端、搜索等
   *  功能判断当前执行环境的单一数据源，避免每次解析 rootSource URI。 */
  projectType: 'local' | 'ssh' | null;
  entries: FileEntry[];
  openedFiles: OpenedFile[];
  /** 当前焦点组的 activeFileId 镜像 */
  activeFileId: string | null;
  /** 当前焦点组的 activeFileSource 镜像 */
  activeFileSource: FileSource | null;
  recentProjects: RecentProject[];
  searchHighlight: SearchHighlight | null;
  clipboard: ClipboardItem | null;
  pendingSearchQuery: string | null;
  allFilePaths: string[];
  expandPaths: string[];
  expandedDirs: string[];
  /** 编辑器组列表（多列分屏） */
  editorGroups: EditorGroup[];
  /** 当前焦点组索引 */
  activeGroupIndex: number;
  editorSnapshots: Record<string, EditorSnapshot>;
  mirrorContent: Record<string, string>;
  splitPhase: SplitPhase;
  /** 下一个 group ID 序号 */
  nextGroupId: number;
  /** Git Diff 视图 */
  diffView: DiffView | null;
  /** 设置面板是否显示在主区域 */
  settingsVisible: boolean;
  /** 当前已不存在的打开文件 ID 集合（如切换分支后文件被删除） */
  missingFileIds: string[];
  /** 远程/外部工作区根目录列表 */
  remoteRoots: WorkspaceRoot[];
  /** AI 编辑模式：true=AI可直接编辑代码 false=AI只给建议 */
  aiEditMode: boolean;
  /** Git 文件状态映射（由 web/git 扩展推送） */
  gitStatus: Record<string, string>;
  /** 当前 Git 分支名（由 web/git 扩展推送） */
  gitBranch: string | null;
  /** 外部文件变更通知（如 git discard），触发资源管理器精准刷新 */
  externalFileChange: { paths: string[]; timestamp: number } | null;
  /** §SSH 连接缓存：key=connectionId，value=连接元信息。供"在终端中打开"
   *  在已加载到资源管理器的 SSH 工作区路径上发起远程终端命令时使用。 */
  sshConnections: Record<string, SshConnectionInfo>;
}

const initialState: WorkspaceState = {
  rootSource: null,
  rootName: '',
  projectType: null,
  entries: [],
  openedFiles: [],
  activeFileId: null,
  activeFileSource: null,
  recentProjects: [],
  searchHighlight: null,
  clipboard: null,
  pendingSearchQuery: null,
  allFilePaths: [],
  expandPaths: [],
  expandedDirs: [],
  editorGroups: [{ id: 'g0', fileIds: [], activeFileId: null, tabHistory: [], ratio: 1 }],
  activeGroupIndex: 0,
  editorSnapshots: {},
  mirrorContent: {},
  splitPhase: 'closed',
  nextGroupId: 1,
  diffView: null,
  settingsVisible: false,
  missingFileIds: [],
  remoteRoots: [],
  aiEditMode: true,
  gitStatus: {},
  gitBranch: null,
  externalFileChange: null,
  sshConnections: {},
};

/* ─── 工具函数 ─── */

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

function activeGroup(state: WorkspaceState): EditorGroup {
  return state.editorGroups[state.activeGroupIndex];
}

function insertOpenedFile(state: WorkspaceState, file: OpenedFile) {
  if (!state.openedFiles.find((f) => f.id === file.id)) {
    state.openedFiles.push({ ...file, isPreview: true });
  }
  const group = activeGroup(state);

  if (group.fileIds.includes(file.id)) {
    group.activeFileId = file.id;
    group.tabHistory = pushToHistory(group.tabHistory, file.id);
    syncGlobalActive(state);
    return;
  }

  const activeFile = state.openedFiles.find((f) => f.id === group.activeFileId);
  if (activeFile?.isPreview && !activeFile?.isDiff) {
    const oldId = group.activeFileId!;
    const activeIdx = group.fileIds.indexOf(oldId);
    group.fileIds[activeIdx] = file.id;
    group.tabHistory = removeFromHistory(group.tabHistory, oldId);
    group.activeFileId = file.id;
    group.tabHistory = pushToHistory(group.tabHistory, file.id);
    if (!state.editorGroups.some((g) => g.fileIds.includes(oldId))) {
      state.openedFiles = state.openedFiles.filter((f) => f.id !== oldId);
    }
    syncGlobalActive(state);
    return;
  }

  const previewFileId = group.fileIds.find((fid) => {
    const f = state.openedFiles.find((of) => of.id === fid);
    return f?.isPreview && !f?.isDiff;
  });
  if (previewFileId) {
    const previewIdx = group.fileIds.indexOf(previewFileId);
    group.fileIds[previewIdx] = file.id;
    group.tabHistory = removeFromHistory(group.tabHistory, previewFileId);
    group.activeFileId = file.id;
    group.tabHistory = pushToHistory(group.tabHistory, file.id);
    if (!state.editorGroups.some((g) => g.fileIds.includes(previewFileId))) {
      state.openedFiles = state.openedFiles.filter((f) => f.id !== previewFileId);
    }
    syncGlobalActive(state);
    return;
  }

  const activeIdx = group.activeFileId ? group.fileIds.indexOf(group.activeFileId) : -1;
  if (activeIdx >= 0) {
    group.fileIds.splice(activeIdx + 1, 0, file.id);
  } else {
    group.fileIds.push(file.id);
  }
  group.activeFileId = file.id;
  group.tabHistory = pushToHistory(group.tabHistory, file.id);
  syncGlobalActive(state);
}

/** 同步 activeFileId / activeFileSource 到焦点组 */
function syncGlobalActive(state: WorkspaceState): void {
  const g = activeGroup(state);
  state.activeFileId = g.activeFileId;
  if (g.activeFileId) {
    const file = state.openedFiles.find((f) => f.id === g.activeFileId);
    state.activeFileSource = file?.source ?? null;
  } else {
    state.activeFileSource = null;
  }
}

/** 回收所有空组，保留至少一个组 */
function removeEmptyGroups(state: WorkspaceState): void {
  // 记住被关闭前的焦点组 ID
  const focusedGroupId = state.editorGroups[state.activeGroupIndex]?.id;

  // 构建旧索引 → 新索引的映射，用于后续修正 mirror / snapshot key 中的索引
  const oldCount = state.editorGroups.length;
  const nonEmpty = state.editorGroups.filter((g) => g.fileIds.length > 0);
  if (nonEmpty.length === 0) {
    // 全部空了，回到初始状态
    state.editorGroups = [{ id: 'g0', fileIds: [], activeFileId: null, tabHistory: [], ratio: 1 }];
    state.activeGroupIndex = 0;
    state.activeFileId = null;
    state.activeFileSource = null;
    state.splitPhase = 'closed';
    return;
  }

  // 构建 oldIndex → newIndex 映射（被移除的组映射为 -1）
  const indexMap = new Array<number>(oldCount).fill(-1);
  {
    let newIdx = 0;
    for (let oldIdx = 0; oldIdx < oldCount; oldIdx++) {
      if (state.editorGroups[oldIdx].fileIds.length > 0) {
        indexMap[oldIdx] = newIdx;
        newIdx++;
      }
    }
  }

  state.editorGroups = nonEmpty;

  // ── 修正 mirrorContent 和 editorSnapshots 中的组索引 ──
  // 当中间组被移除时，后续组的索引会前移，需要同步更新 key 中的索引。
  // 注意：不在 Immer draft 上边迭代边 delete/set，而是构建新对象后整体替换，
  // 避免与 Immer 的 Proxy 写时复制机制产生冲突导致白屏崩溃。
  if (nonEmpty.length < oldCount) {
    // 重映射 mirrorContent
    {
      const next: Record<string, string> = {};
      const entries = Object.entries(state.mirrorContent);
      for (const [key, value] of entries) {
        const match = key.match(/^(.+)::(\d+)$/);
        if (!match) { next[key] = value as string; continue; }
        const fileId = match[1];
        const oldIdx = parseInt(match[2], 10);
        if (oldIdx >= oldCount) { next[key] = value as string; continue; }
        const newIdx = indexMap[oldIdx];
        if (newIdx < 0) continue; // 组已移除，丢弃
        next[`${fileId}::${newIdx}`] = value as string;
      }
      state.mirrorContent = next;
    }
    // 重映射 editorSnapshots
    {
      const next: Record<string, EditorSnapshot> = {};
      const entries = Object.entries(state.editorSnapshots);
      for (const [key, value] of entries) {
        const match = key.match(/^(.+)::(\d+)$/);
        if (!match) { next[key] = value as EditorSnapshot; continue; }
        const fileId = match[1];
        const oldIdx = parseInt(match[2], 10);
        if (oldIdx >= oldCount) { next[key] = value as EditorSnapshot; continue; }
        const newIdx = indexMap[oldIdx];
        if (newIdx < 0) continue;
        next[`${fileId}::${newIdx}`] = value as EditorSnapshot;
      }
      state.editorSnapshots = next;
    }
  }

  // 尝试恢复到之前的焦点组位置
  const newIdx = state.editorGroups.findIndex((g) => g.id === focusedGroupId);
  state.activeGroupIndex = newIdx >= 0 ? newIdx : 0;
  if (state.editorGroups.length === 1) {
    state.splitPhase = 'closed';
  }
}

/* ─── Async Thunks ─── */

export const loadDirectory = createAsyncThunk(
  'workspace/loadDirectory',
  async ({ source, name }: { source: FileSource; name: string }, { dispatch }) => {
    const entries = await readDirectory(source);
    if (isPath(source) && !isRemoteUri(source)) {
      try { await addRecentProject(source, name); } catch { /* 忽略 */ }
      // 启动 tsserver 语言服务
      try { window.electronAPI?.tsserver?.start(source); } catch { /* tsserver 未可用 */ }
      // Git 状态由 web/git 扩展自动监听 workspace 变更并刷新
      // （扩展轮询 workspace.getRootPath，发现路径变更后自动 openRepository）
    }
    // §SSH 远程工作区也需要填充文件列表（TopBar 搜索文件 / QuickOpen 依赖 allFilePaths）。
    // refreshAllFilePaths 内部通过 FileSystemProvider 读取远程目录，对 SSH 可用。
    if (isPath(source)) {
      dispatch(refreshAllFilePaths(source));
    }
    return { source, name, entries };
  }
);

export const openFile = createAsyncThunk(
  'workspace/openFile',
  async (entry: FileEntry & { readOnly?: boolean }) => {
    if (entry.kind !== 'file') return null;
    const { getLanguageFromPath } = await import('../../utils/languageFromPath');
    const sourceStr = typeof entry.source === 'string' ? entry.source : entry.name;
    const language = getLanguageFromPath(entry.name);

    // §未保存的临时文件（untitled://）不读取磁盘，直接以空内容打开
    if (sourceStr.startsWith('untitled://')) {
      return {
        id: sourceStr,
        name: entry.name,
        source: entry.source,
        content: '',
        language,
        isDirty: false,
        readOnly: entry.readOnly ?? false,
      };
    }

    const content = await readFile(entry.source);
    // 用完整路径作为唯一 id，避免不同目录下的同名文件（如 index.tsx）冲突
    const id = sourceStr;
    return { id, name: entry.name, source: entry.source, content, language, isDirty: false, readOnly: entry.readOnly ?? false };
  }
);

export const openExtensionDetail = createAsyncThunk(
  'workspace/openExtensionDetail',
  async ({ extId, name, description }: { extId: string; name: string; description?: string }) => {
    const id = `extension://${extId}`;
    return {
      id,
      name,
      source: id,
      content: description || '',
      language: 'extension',
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
  async (payload: string | { id: string; groupIndex?: number }, { getState }) => {
    const { id, groupIndex: gIdx = 0 } = typeof payload === 'string' ? { id: payload } : payload;
    const state = (getState() as { workspace: WorkspaceState }).workspace;
    const file = state.openedFiles.find((f) => f.id === id);
    if (!file) throw new Error('文件未找到');

    let targetSource = file.source;
    let targetName = file.name;

    // §未保存的临时文件（untitled://）保存时弹出“另存为”对话框
    if (typeof file.source === 'string' && file.source.startsWith('untitled://')) {
      const savedPath = await window.electronAPI?.dialog?.saveFile({ defaultPath: file.name });
      if (!savedPath) throw new Error('用户取消保存');
      targetSource = savedPath;
      targetName = savedPath.split(/[\\/]/).pop() || file.name;
    }

    const mirrorKey = `${id}::${gIdx}`;
    const contentToSave = state.mirrorContent[mirrorKey] ?? file.content;
    await writeFile(targetSource, contentToSave);
    // Git 状态由 web/git 扩展自动监听 .git 目录变更并刷新
    return { id, groupIndex: gIdx, content: contentToSave, source: targetSource, name: targetName };
  }
);

export const refreshAllFilePaths = createAsyncThunk(
  'workspace/refreshAllFilePaths',
  async (overrideSource: FileSource | undefined, { getState }) => {
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
      } catch { /* 跳过 */ }
    }
    await collect(rootSource, '');
    return paths;
  }
);

/** 检查所有已打开文件是否仍然存在，返回缺失的文件 ID 列表 */
export const checkMissingFiles = createAsyncThunk(
  'workspace/checkMissingFiles',
  async (_: void, { getState }) => {
    const state = (getState() as { workspace: WorkspaceState }).workspace;
    const fs = window.electronAPI?.fs;
    if (!fs) return [];
    const results = await Promise.all(
      state.openedFiles.map(async (f) => {
        if (typeof f.source !== 'string' || isRemoteUri(f.source)) return null;
        try {
          const stat = await fs.stat(f.source);
          return stat ? null : f.id;
        } catch {
          return f.id;
        }
      })
    );
    return results.filter((id): id is string => !!id);
  }
);

/** 重新读取磁盘上已打开文件的内容（仅当文件存在且无未保存修改时） */
export const refreshOpenedFiles = createAsyncThunk(
  'workspace/refreshOpenedFiles',
  async (_: void, { getState }) => {
    const state = (getState() as { workspace: WorkspaceState }).workspace;
    const fs = window.electronAPI?.fs;
    if (!fs) return [];
    const updates: { id: string; content: string }[] = [];
    for (const file of state.openedFiles) {
      if (typeof file.source !== 'string' || isRemoteUri(file.source)) continue;
      if (file.isDirty) continue;
      try {
        const stat = await fs.stat(file.source);
        if (!stat) continue;
        const content = await fs.readFile(file.source);
        if (content !== file.content) {
          updates.push({ id: file.id, content });
        }
      } catch {
        // 文件不可读，忽略
      }
    }
    return updates;
  }
);

/** 强制重载指定路径的已打开文件内容（用于 git discard 等外部修改后同步编辑器）。
 *  与 refreshOpenedFiles 的区别：不跳过 isDirty 文件，且重载后清除 isDirty。 */
export const reloadFilesFromDisk = createAsyncThunk(
  'workspace/reloadFilesFromDisk',
  async (absolutePaths: string[], { getState }) => {
    const state = (getState() as { workspace: WorkspaceState }).workspace;
    const pathSet = new Set(absolutePaths);
    const updates: { id: string; content: string }[] = [];
    for (const file of state.openedFiles) {
      if (typeof file.source !== 'string' || isRemoteUri(file.source)) continue;
      if (!pathSet.has(file.source)) continue;
      try {
        const content = await readFile(file.source);
        updates.push({ id: file.id, content });
      } catch {
        // 文件不可读，忽略
      }
    }
    return updates;
  }
);

/* ─── Slice ─── */

const workspaceSlice = createSlice({
  name: 'workspace',
  initialState,
  reducers: {
    setSettingsVisible: (state, action) => {
      state.settingsVisible = action.payload as boolean;
    },
    addWorkspaceFolder: (state, action) => {
      const root = action.payload as WorkspaceRoot;
      if (!state.remoteRoots.find((r) => r.id === root.id)) {
        state.remoteRoots.push(root);
        const expandPath = `remote-root-${root.id}`;
        if (!state.expandedDirs.includes(expandPath)) {
          state.expandedDirs.push(expandPath);
        }
      }
    },
    removeWorkspaceFolder: (state, action) => {
      const id = action.payload as string;
      const removed = state.remoteRoots.find((r) => r.id === id);
      state.remoteRoots = state.remoteRoots.filter((r) => r.id !== id);
      // 关闭属于该远程根的所有已打开文件
      if (removed) {
        const rootUriPrefix = String(removed.source).replace(/\/$/, '') + '/';
        state.openedFiles = state.openedFiles.filter((f) => {
          if (isRemoteUri(f.source)) {
            return !String(f.source).startsWith(rootUriPrefix);
          }
          return true;
        });
      }
    },
    closeSettings: (state) => {
      state.settingsVisible = false;
    },
    setMissingFileIds: (state, action) => {
      state.missingFileIds = action.payload as string[];
    },
    /**
     * 设置 Git 文件状态映射（key 为相对仓库根路径，value 为 M/A/D/R/U/C 等）
     */
    setGitStatus: (state, action) => {
      state.gitStatus = action.payload as Record<string, string>;
    },
    /**
     * 设置当前 Git 分支名
     */
    setGitBranch: (state, action) => {
      state.gitBranch = typeof action.payload === 'string' && action.payload ? action.payload : null;
    },
    /**
     * 设置外部文件变更通知（如 git discard 后由扩展推送）。
     * ExplorerContent 监听此字段变化后，精准刷新受影响目录的子节点。
     */
    setExternalFileChange: (state, action) => {
      state.externalFileChange = action.payload as { paths: string[]; timestamp: number } | null;
    },
    /**
     * §缓存 SSH 连接信息：当 SshFileTreePanel 点击"添加到资源管理器"时调用，
     * 把连接写入 Redux；之后"在终端中打开"右键菜单能直接取出连接信息构造 ssh 命令。
     */
    setSshConnection: (state, action) => {
      const conn = action.payload as SshConnectionInfo;
      state.sshConnections[conn.id] = conn;
    },
    removeSshConnection: (state, action) => {
      const id = action.payload as string;
      delete state.sshConnections[id];
    },
    /**
     * 清空所有远程工作区根目录，同时清除关联的 Git 状态，
     * 避免切换到非 Git 远程目录时仍显示旧仓库信息。
     */
    clearWorkspaceFolders: (state) => {
      state.remoteRoots = [];
      state.gitStatus = {};
      state.gitBranch = null;
      // §同时清空 SSH 连接缓存，避免内存泄漏（旧连接仍指向已关闭的 SSH 会话）
      state.sshConnections = {};
      // §重置项目环境类型，避免清除工作区后残留旧环境标识
      state.projectType = null;
    },
    closeFile: (state, action) => {
      const payload = action.payload;
      const id = typeof payload === 'string' ? payload : (payload as { id: string; groupIndex?: number }).id;
      const groupIndex = typeof payload === 'string' ? state.activeGroupIndex : ((payload as { id: string; groupIndex?: number }).groupIndex ?? state.activeGroupIndex);
      const group = state.editorGroups[groupIndex];
      if (!group) return;

      const newFileIds = group.fileIds.filter((fid) => fid !== id);
      group.fileIds = newFileIds;
      group.tabHistory = removeFromHistory(group.tabHistory, id);
      if (group.activeFileId === id) {
        group.activeFileId = getTopOfHistory(group.tabHistory, id) ?? newFileIds[0] ?? null;
      }

      // 检查文件是否仍被任何组引用
      const stillOpen = state.editorGroups.some((g) => g.fileIds.includes(id));
      if (!stillOpen) {
        state.openedFiles = state.openedFiles.filter((f) => f.id !== id);
        // 清理所有组的快照和镜像
        state.editorGroups.forEach((_, idx) => {
          delete state.editorSnapshots[`${id}::${idx}`];
          delete state.mirrorContent[`${id}::${idx}`];
        });
      }

      // 文件不再跨组存在时，同步镜像内容回共享文件
      const groupsWithFile = state.editorGroups.filter((g) => g.fileIds.includes(id));
      if (groupsWithFile.length <= 1) {
        if (groupsWithFile.length === 1) {
          const gIdx = state.editorGroups.indexOf(groupsWithFile[0]);
          if (gIdx >= 0) {
            const remainingContent = state.mirrorContent[`${id}::${gIdx}`];
            if (remainingContent !== undefined) {
              const file = state.openedFiles.find((f) => f.id === id);
              if (file) file.content = remainingContent;
            }
          }
        }
        // 清理所有组的镜像（遍历所有可能的旧组索引）
        const maxGroups = state.editorGroups.length;
        for (let i = 0; i < maxGroups; i++) {
          delete state.mirrorContent[`${id}::${i}`];
        }
      }

      // 焦点组空了 → 迁移焦点到最近的非空组
      if (group.fileIds.length === 0) {
        let newFocus = -1;
        for (let i = 0; i < state.editorGroups.length; i++) {
          if (state.editorGroups[i].fileIds.length > 0) { newFocus = i; break; }
        }
        if (newFocus >= 0) state.activeGroupIndex = newFocus;
      }

      removeEmptyGroups(state);
      syncGlobalActive(state);
    },

    activateFile: (state, action) => {
      const id = action.payload as string;
      const group = activeGroup(state);
      if (!group.fileIds.includes(id)) {
        group.fileIds.push(id);
      }
      group.activeFileId = id;
      group.tabHistory = pushToHistory(group.tabHistory, id);
      syncGlobalActive(state);
    },

    openVirtualFile: (state, action) => {
      insertOpenedFile(state, action.payload as OpenedFile);
    },

    navigateTabHistory: (state, action) => {
      const direction = (action.payload as 'forward' | 'backward') || 'backward';
      const group = activeGroup(state);
      if (group.tabHistory.length <= 1) return;
      if (direction === 'backward') {
        const target = getTopOfHistory(group.tabHistory, group.activeFileId);
        if (target) {
          group.activeFileId = target;
          group.tabHistory = pushToHistory(group.tabHistory, target);
          syncGlobalActive(state);
        }
      }
    },

    setFileContent: (state, action) => {
      const { id, content } = action.payload as { id: string; content: string };
      // 跨组编辑：存入镜像
      const groupsWithFile = state.editorGroups.filter((g) => g.fileIds.includes(id));
      const isMirrored = groupsWithFile.length > 1;
      if (isMirrored) {
        state.mirrorContent[`${id}::${state.activeGroupIndex}`] = content;
      }
      const file = state.openedFiles.find((f) => f.id === id);
      if (file) {
        if (!isMirrored) file.content = content;
        file.isDirty = true;
        file.isPreview = false;
      }
    },

    setMirrorFileContent: (state, action) => {
      const { fileId, groupIndex, content } = action.payload as { fileId: string; groupIndex: number; content: string };
      state.mirrorContent[`${fileId}::${groupIndex}`] = content;
      const file = state.openedFiles.find((f) => f.id === fileId);
      if (file) {
        file.isDirty = true;
        file.isPreview = false;
      }
    },

    pinPreviewFile: (state) => {
      const group = activeGroup(state);
      // 优先固定当前激活的预览 Tab（如果它是预览态）
      const activeFile = state.openedFiles.find((f) => f.id === group.activeFileId);
      if (activeFile?.isPreview) {
        activeFile.isPreview = false;
        return;
      }
      // 否则固定第一个非 Diff 的预览 Tab
      const previewId = group.fileIds.find((fid) => {
        const f = state.openedFiles.find((of) => of.id === fid);
        return f?.isPreview && !f?.isDiff;
      });
      if (previewId) {
        const preview = state.openedFiles.find((f) => f.id === previewId);
        if (preview) preview.isPreview = false;
      }
    },

    markFileSaved: (state, action) => {
      const id = action.payload as string;
      const file = state.openedFiles.find((f) => f.id === id);
      if (file) file.isDirty = false;
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
      state.expandedDirs = [];
    },

    toggleExpandDir: (state, action) => {
      const { path, expand } = action.payload as { path: string; expand: boolean };
      if (expand) {
        if (!state.expandedDirs.includes(path)) state.expandedDirs.push(path);
      } else {
        state.expandedDirs = state.expandedDirs.filter((p) => p !== path);
      }
    },

    /** 在当前焦点组右侧新建分屏列（始终新建，不切换关闭） */
    toggleSplitView: (state) => {
      const totalOpen = state.editorGroups.reduce((s, g) => s + g.fileIds.length, 0);
      if (totalOpen === 0) return;
      state.splitPhase = 'opening';
      const srcGroup = activeGroup(state);
      const newGroup: EditorGroup = {
        id: `g${state.nextGroupId++}`,
        fileIds: srcGroup.activeFileId ? [srcGroup.activeFileId] : [],
        activeFileId: srcGroup.activeFileId,
        tabHistory: srcGroup.activeFileId ? [srcGroup.activeFileId] : [],
        ratio: 1,
      };
      state.editorGroups.splice(state.activeGroupIndex + 1, 0, newGroup);
      state.activeGroupIndex = state.activeGroupIndex + 1;

      if (srcGroup.activeFileId) {
        const mirroredId = srcGroup.activeFileId;
        const mirroredFile = state.openedFiles.find((f) => f.id === mirroredId);
        if (mirroredFile) {
          state.mirrorContent[`${mirroredId}::${state.activeGroupIndex - 1}`] = mirroredFile.content;
          state.mirrorContent[`${mirroredId}::${state.activeGroupIndex}`] = mirroredFile.content;
        }
      }
      state.splitPhase = 'open';
      syncGlobalActive(state);
    },

    /** 合并所有组到第一个（手动关闭所有分屏） */
    collapseAllGroups: (state) => {
      if (state.editorGroups.length <= 1) return;
      state.splitPhase = 'closing';
      const primary = state.editorGroups[0];
      for (let i = 1; i < state.editorGroups.length; i++) {
        const g = state.editorGroups[i];
        for (const id of g.fileIds) {
          if (!primary.fileIds.includes(id)) primary.fileIds.push(id);
          const mirrored = state.mirrorContent[`${id}::${i}`];
          if (mirrored !== undefined) {
            const file = state.openedFiles.find((f) => f.id === id);
            if (file) file.content = mirrored;
          }
        }
        g.fileIds.forEach((id) => { delete state.mirrorContent[`${id}::${i}`]; });
      }
      for (const key of Object.keys(state.mirrorContent)) { delete state.mirrorContent[key]; }
      state.editorGroups = [primary];
      state.activeGroupIndex = 0;
      state.splitPhase = 'closed';
      syncGlobalActive(state);
    },

    setActiveGroup: (state, action) => {
      const idx = action.payload as number;
      if (idx >= 0 && idx < state.editorGroups.length) {
        state.activeGroupIndex = idx;
        syncGlobalActive(state);
      }
    },

    saveEditorSnapshot: (state, action) => {
      const { fileId, groupIndex, snapshot } = action.payload as {
        fileId: string; groupIndex: number; snapshot: EditorSnapshot;
      };
      state.editorSnapshots[`${fileId}::${groupIndex}`] = snapshot;
    },

    /** 设置指定组的 flex 比例 */
    setGroupRatio: (state, action) => {
      const { groupIndex, ratio } = action.payload as { groupIndex: number; ratio: number };
      if (state.editorGroups[groupIndex]) {
        state.editorGroups[groupIndex].ratio = Math.max(0.3, Math.min(4.0, ratio));
      }
    },

    /** 均匀化所有组的比例 */
    equalizeGroupRatios: (state) => {
      for (const g of state.editorGroups) g.ratio = 1;
    },

    /**
     * 拖拽重排 tab 顺序
     * @param payload { fromId, toId, position }
     *   position='before': 将 fromId 插入到 toId 之前
     *   position='after':  将 fromId 插入到 toId 之后
     */
    reorderTab: (state, action) => {
      const { fromId, toId, position = 'before' } = action.payload as {
        fromId: string; toId: string; position?: 'before' | 'after';
      };
      if (fromId === toId) return;
      const group = activeGroup(state);
      const fromIdx = group.fileIds.indexOf(fromId);
      const toIdx = group.fileIds.indexOf(toId);
      if (fromIdx === -1 || toIdx === -1) return;

      // 先移除 fromId
      group.fileIds.splice(fromIdx, 1);

      // 移除后 toIdx 可能偏移，重新定位 toId
      const newToIdx = group.fileIds.indexOf(toId);
      const insertIdx = position === 'after' ? newToIdx + 1 : newToIdx;
      group.fileIds.splice(insertIdx, 0, fromId);
    },

    /** 打开 Git Diff 视图 */
    openDiffView: (state, action) => {
      const diffData = action.payload as DiffView;
      const diffId = `diff://${diffData.filePath}`;
      const diffName = `${diffData.fileName} (工作树)`;

      // 如果已存在，更新内容并激活
      const existingFile = state.openedFiles.find((f) => f.id === diffId);
      if (existingFile) {
        existingFile.diffData = diffData;
        existingFile.language = diffData.language;
      } else {
        // 创建虚拟 Diff 文件
        state.openedFiles.push({
          id: diffId,
          name: diffName,
          source: diffData.filePath as FileSource,
          content: diffData.modified,
          language: diffData.language,
          isDirty: false,
          isPreview: true,
          isDiff: true,
          diffData,
        });
      }

      // 打开到当前焦点组
      const group = activeGroup(state);

      // 已在当前组 → 直接激活
      if (group.fileIds.includes(diffId)) {
        group.activeFileId = diffId;
        group.tabHistory = pushToHistory(group.tabHistory, diffId);
        syncGlobalActive(state);
        return;
      }

      // 优先替换当前 active 的 Diff 预览 Tab（如果当前 active 是 Diff 预览）
      const activeFile = state.openedFiles.find((f) => f.id === group.activeFileId);
      if (activeFile?.isDiff && activeFile?.isPreview) {
        const activeIdx = group.fileIds.indexOf(group.activeFileId!);
        // 只替换 fileIds 中的 ID，保留 openedFiles 中的旧文件（避免 React 重新渲染 Tab 栏）
        // 旧文件会在后续 closeDiffView 或 cleanup 时清理
        group.fileIds[activeIdx] = diffId;
        group.tabHistory = removeFromHistory(group.tabHistory, group.activeFileId!);
        group.activeFileId = diffId;
        group.tabHistory = pushToHistory(group.tabHistory, diffId);
        syncGlobalActive(state);
        return;
      }

      // 否则查找当前组内的其他 Diff 预览 Tab，存在则替换它
      const diffPreviewId = group.fileIds.find((fid) => {
        const f = state.openedFiles.find((of) => of.id === fid);
        return f?.isDiff && f?.isPreview;
      });
      if (diffPreviewId) {
        const diffPreviewIdx = group.fileIds.indexOf(diffPreviewId);
        // 只替换 fileIds 中的 ID，保留 openedFiles 中的旧文件
        group.fileIds[diffPreviewIdx] = diffId;
        group.tabHistory = removeFromHistory(group.tabHistory, diffPreviewId);
        group.activeFileId = diffId;
        group.tabHistory = pushToHistory(group.tabHistory, diffId);
        syncGlobalActive(state);
        return;
      }

      // 没有 Diff 预览，直接添加
      group.fileIds.push(diffId);
      group.activeFileId = diffId;
      group.tabHistory = pushToHistory(group.tabHistory, diffId);
      syncGlobalActive(state);
    },

    /** 关闭 Git Diff 视图 */
    closeDiffView: (state, action) => {
      const diffId = action.payload as string | undefined;
      const targetId = diffId || state.activeFileId;
      if (!targetId || !targetId.startsWith('diff://')) return;

      // 从所有组中移除
      state.editorGroups.forEach((g) => {
        g.fileIds = g.fileIds.filter((id) => id !== targetId);
        g.tabHistory = removeFromHistory(g.tabHistory, targetId);
        if (g.activeFileId === targetId) {
          g.activeFileId = g.fileIds[g.fileIds.length - 1] || null;
        }
      });

      // 从 openedFiles 中移除
      state.openedFiles = state.openedFiles.filter((f) => f.id !== targetId);

      // 清理 mirror content 和 snapshots
      Object.keys(state.mirrorContent).forEach((key) => {
        if (key.startsWith(`${targetId}::`)) delete state.mirrorContent[key];
      });
      Object.keys(state.editorSnapshots).forEach((key) => {
        if (key.startsWith(`${targetId}::`)) delete state.editorSnapshots[key];
      });

      removeEmptyGroups(state);
      syncGlobalActive(state);
    },

    /** 更新 Git Diff 视图内容（替换操作后） */
    updateDiffView: (state, action) => {
      const diffData = action.payload as DiffView;
      const diffId = `diff://${diffData.filePath}`;
      const file = state.openedFiles.find((f) => f.id === diffId);
      if (file) {
        file.diffData = diffData;
        file.content = diffData.modified;
        file.language = diffData.language;
      }
    },

    /** 设置文件的语法高亮语言 */
    setFileLanguage: (state, action) => {
      const { id, language } = action.payload as { id: string; language: string };
      const file = state.openedFiles.find((f) => f.id === id);
      if (file) file.language = language;
    },
    toggleFileReadOnly: (state, action) => {
      const payload = action.payload;
      const id = typeof payload === 'string' ? payload : (payload as { id: string }).id;
      const file = state.openedFiles.find((f) => f.id === id);
      if (file) file.readOnly = !file.readOnly;
    },
    toggleAiEditMode: (state) => {
      state.aiEditMode = !state.aiEditMode;
    },
  },

  extraReducers: (builder) => {
    builder
      .addCase(loadDirectory.fulfilled, (state, action) => {
        state.rootSource = action.payload.source;
        state.rootName = action.payload.name;
        // §根据 source 自动判断项目环境类型并存储：
        //   - source 为 'ssh://' 前缀的 URI → 'ssh'（远程项目）
        //   - 其他（本地路径 / FileSystemHandle）→ 'local'（本地项目）
        // 终端、搜索等功能读取 projectType 作为执行环境的单一数据源，
        // 不再需要每次解析 rootSource URI 判断环境。
        state.projectType =
          typeof action.payload.source === 'string' && action.payload.source.startsWith('ssh://')
            ? 'ssh'
            : 'local';
        state.entries = action.payload.entries;
        // 打开新文件夹/工程时，重置所有编辑会话状态
        state.openedFiles = [];
        state.activeFileId = null;
        state.activeFileSource = null;
        state.editorGroups = [{ id: 'g0', fileIds: [], activeFileId: null, tabHistory: [], ratio: 1 }];
        state.activeGroupIndex = 0;
        state.editorSnapshots = {};
        state.mirrorContent = {};
        state.splitPhase = 'closed';
        state.nextGroupId = 1;
        state.diffView = null;
        state.settingsVisible = false;
        state.missingFileIds = [];
        state.remoteRoots = [];
        state.expandPaths = [];
        state.expandedDirs = [];
        state.clipboard = null;
        state.pendingSearchQuery = null;
        state.gitStatus = {};
        state.gitBranch = null;
      })
      .addCase(openFile.fulfilled, (state, action) => {
        if (!action.payload) return;
        const file = action.payload;
        if (!state.openedFiles.find((f) => f.id === file.id)) {
          state.openedFiles.push({ ...file, isPreview: true });
        }
        const group = activeGroup(state);

        // 已在当前组 → 直接激活
        if (group.fileIds.includes(file.id)) {
          group.activeFileId = file.id;
          group.tabHistory = pushToHistory(group.tabHistory, file.id);
          syncGlobalActive(state);
          return;
        }

        // 优先替换当前 active 的预览 Tab（如果它是预览态且非 Diff）
        const activeFile = state.openedFiles.find((f) => f.id === group.activeFileId);
        if (activeFile?.isPreview && !activeFile?.isDiff) {
          const oldId = group.activeFileId!;
          const activeIdx = group.fileIds.indexOf(oldId);
          group.fileIds[activeIdx] = file.id;
          group.tabHistory = removeFromHistory(group.tabHistory, oldId);
          group.activeFileId = file.id;
          group.tabHistory = pushToHistory(group.tabHistory, file.id);
          if (!state.editorGroups.some((g) => g.fileIds.includes(oldId))) {
            state.openedFiles = state.openedFiles.filter((f) => f.id !== oldId);
          }
          syncGlobalActive(state);
          return;
        }

        // 否则查找当前组内的其他预览 Tab（排除 Diff 文件），存在则替换它
        const previewFileId = group.fileIds.find((fid) => {
          const f = state.openedFiles.find((of) => of.id === fid);
          return f?.isPreview && !f?.isDiff;
        });
        if (previewFileId) {
          const previewIdx = group.fileIds.indexOf(previewFileId);
          group.fileIds[previewIdx] = file.id;
          group.tabHistory = removeFromHistory(group.tabHistory, previewFileId);
          group.activeFileId = file.id;
          group.tabHistory = pushToHistory(group.tabHistory, file.id);
          if (!state.editorGroups.some((g) => g.fileIds.includes(previewFileId))) {
            state.openedFiles = state.openedFiles.filter((f) => f.id !== previewFileId);
          }
          syncGlobalActive(state);
          return;
        }

        // 插入到当前 active tab 后面
        const activeIdx = group.activeFileId ? group.fileIds.indexOf(group.activeFileId) : -1;
        if (activeIdx >= 0) {
          group.fileIds.splice(activeIdx + 1, 0, file.id);
        } else {
          group.fileIds.push(file.id);
        }
        group.activeFileId = file.id;
        group.tabHistory = pushToHistory(group.tabHistory, file.id);
        syncGlobalActive(state);
      })
      .addCase(openExtensionDetail.fulfilled, (state, action) => {
        if (!action.payload) return;
        insertOpenedFile(state, action.payload);
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
        const { id, content, source, name } = action.payload;
        const file = state.openedFiles.find((f) => f.id === id);
        if (file) {
          file.content = content;
          file.isDirty = false;
          if (source) file.source = source;
          if (name) file.name = name;
        }
        // 清理所有组镜像
        state.editorGroups.forEach((_, idx) => {
          delete state.mirrorContent[`${id}::${idx}`];
        });
      })
      .addCase(refreshAllFilePaths.fulfilled, (state, action) => {
        state.allFilePaths = action.payload;
      })
      .addCase(checkMissingFiles.fulfilled, (state, action) => {
        state.missingFileIds = action.payload;
      })
      .addCase(refreshOpenedFiles.fulfilled, (state, action) => {
        for (const { id, content } of action.payload) {
          const file = state.openedFiles.find((f) => f.id === id);
          if (file) {
            file.content = content;
            file.isPreview = false;
            // 清除该文件在所有组中的镜像内容，避免显示旧分支内容
            state.editorGroups.forEach((_, idx) => {
              delete state.mirrorContent[`${id}::${idx}`];
            });
          }
        }
      })
      .addCase(reloadFilesFromDisk.fulfilled, (state, action) => {
        for (const { id, content } of action.payload) {
          const file = state.openedFiles.find((f) => f.id === id);
          if (file) {
            file.content = content;
            file.isDirty = false;  // discard 后文件回到干净状态
            file.isPreview = false;
            state.editorGroups.forEach((_, idx) => {
              delete state.mirrorContent[`${id}::${idx}`];
            });
          }
        }
      });
  },
});

export const {
  closeFile, activateFile, navigateTabHistory, setFileContent, setMirrorFileContent, markFileSaved,
  pinPreviewFile, setSearchHighlight, clearSearchHighlight, setClipboard,
  clearClipboard, setPendingSearchQuery, expandToFile, clearExpandPaths,
  toggleExpandDir, toggleSplitView, collapseAllGroups, setActiveGroup, saveEditorSnapshot, setGroupRatio, equalizeGroupRatios, reorderTab,
  openDiffView, closeDiffView, updateDiffView, setFileLanguage,
  setSettingsVisible, closeSettings, setMissingFileIds, openVirtualFile,
  addWorkspaceFolder, removeWorkspaceFolder, toggleFileReadOnly, toggleAiEditMode,
  setGitStatus,
  setGitBranch,
  setExternalFileChange,
  setSshConnection,
  removeSshConnection,
  clearWorkspaceFolders,
} = workspaceSlice.actions;

export default workspaceSlice.reducer;
