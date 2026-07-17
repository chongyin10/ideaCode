import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FilePlus,
  FolderPlus,
  FolderOpen as FolderOpenIcon,
  Search,
  Scissors,
  Copy,
  ClipboardPaste,
  Link,
  FileSignature,
  Trash2,
  FileText,
  RefreshCw,
  ChevronsDownUp,
  Download,
  ChevronRight,
  Terminal as TerminalIcon,
} from 'lucide-react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import {
  loadDirectory,
  openFile,
  refreshDirectory,
  setPendingSearchQuery,
  refreshAllFilePaths,
  clearExpandPaths,
  collapseAllDirs,
  toggleExpandDir,
  activateFile,
  removeWorkspaceFolder,
  closeFile,
  openCommitDetail,
} from '../../store/slices/workspaceSlice';
import type { CommitDetailData } from '../../store/slices/workspaceSlice';
import { switchPanel } from '../../store/slices/layoutSlice';
import { openDirectory } from '../../services/fileService';
import type { FileEntry, FileSource } from '../../services/fileService';
import {
  isPath,
  isElectron,
  isSameSource,
  isRemoteUri,
} from '../../services/fileService';
import {
  exists,
  createFile,
  createDirectory,
  deleteEntry,
  renameEntry,
  copyEntry,
  generateCopyName,
  revealInExplorer,
} from '../../services/fileOperations';
import type { FileClipboardState } from '../../services/fileClipboard';
import {
  getFileClipboard,
  setFileClipboard,
  clearFileClipboard,
} from '../../services/fileClipboard';
import { terminalSDK } from '../../services/terminalSDK';
import { getSshConnection, getSshRemotePath, getSshConnectionId, getSshCredentials } from '../../services/sshWorkspace';
import FileTree, { type PendingCreate, type PendingRename, type LastOperation, getCurrentDrag, currentDragExists, clearCurrentDrag } from './FileTree';
import ContextMenu, { type MenuItem } from '../ContextMenu';
import InlineInput from '../InlineInput';
import { DeleteConfirmDialog } from '../DeleteConfirmDialog';
import CloneRepoModal from '../CloneRepoModal';
import { getMenuManager, contributionToMenuItem } from '../../plugin/menuManager';

/* ─── Hebbian 菜单频率学习 ─── */

const MENU_FREQ_KEY = 'ideacode_menu_frequency';
const FREQ_DECAY = 0.95;
const FREQ_BOOST = 0.05;

interface MenuFreqMap {
  [menuItemId: string]: number;
}

function loadMenuFrequencies(): MenuFreqMap {
  try {
    const raw = localStorage.getItem(MENU_FREQ_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveMenuFrequencies(freqs: MenuFreqMap): void {
  try {
    const keys = Object.keys(freqs);
    if (keys.length > 50) {
      // 仅保留前 50 个最高频项
      const sorted = keys.sort((a, b) => freqs[b] - freqs[a]).slice(0, 50);
      const trimmed: MenuFreqMap = {};
      for (const k of sorted) trimmed[k] = freqs[k];
      localStorage.setItem(MENU_FREQ_KEY, JSON.stringify(trimmed));
    } else {
      localStorage.setItem(MENU_FREQ_KEY, JSON.stringify(freqs));
    }
  } catch { /* 忽略存储失败 */ }
}

let _menuFreqs: MenuFreqMap | null = null;

function getMenuFrequencies(): MenuFreqMap {
  if (!_menuFreqs) _menuFreqs = loadMenuFrequencies();
  return _menuFreqs;
}

/**
 * 记录菜单项点击，使用 Hebbian EMA 更新：
 *   freq_new = freq_old * 0.95 + 0.05 (如果点击)
 * 频繁使用的项频率逐渐升高，不使用的逐渐衰减。
 */
function recordMenuClick(id: string): void {
  const freqs = getMenuFrequencies();
  const old = freqs[id] || 0;
  freqs[id] = old * FREQ_DECAY + FREQ_BOOST;
  saveMenuFrequencies(freqs);
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  targetEntry: FileEntry | null;
  targetParentSource: FileSource | null;
}

/** §时间线 commit 项（与 Git 扩展 getLog 返回格式一致） */
interface TimelineCommit {
  hash: string;
  shortHash: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  timestamp: number;
}

/** §相对时间格式化：刚刚 / x 分钟前 / x 小时前 / x 天前 / x 周 / x 个月 / 日期 */
function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  if (seconds < 60) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (hours < 24) return `${hours} 小时前`;
  if (days < 7) return `${days} 天前`;
  if (weeks < 4) return `${weeks} 周`;
  if (months < 12) return `${months} 个月`;
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

/** 简易闭合文件夹图标 */
const FolderIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
  </svg>
);

const ExplorerContent = () => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();

  const rootSource = useAppSelector((state) => state.workspace.rootSource);
  const rootName = useAppSelector((state) => state.workspace.rootName);
  const entries = useAppSelector((state) => state.workspace.entries);
  const remoteRoots = useAppSelector((state) => state.workspace.remoteRoots);
  const activeFileSource = useAppSelector((state) => state.workspace.activeFileSource);
  // Git 文件状态由 web/git 扩展通过 extension bridge 推送到 Redux
  const gitStatus = useAppSelector((state) => state.workspace.gitStatus);
  // 外部文件变更（如 git discard），触发文件树精准刷新
  const externalFileChange = useAppSelector((state) => state.workspace.externalFileChange);
  const expandPaths = useAppSelector((state) => state.workspace.expandPaths);
  const openedFiles = useAppSelector((state) => state.workspace.openedFiles);
  const editorGroups = useAppSelector((state) => state.workspace.editorGroups);
  const activeFileId = useAppSelector((state) => state.workspace.activeFileId);

  // 打开的编辑器只显示当前被至少一个编辑器组引用的文件，保持与 Tab 栏同步
  const visibleOpenedFiles = useMemo(() => {
    const referencedIds = new Set(editorGroups.flatMap((g) => g.fileIds));
    return openedFiles.filter((f) => referencedIds.has(f.id));
  }, [openedFiles, editorGroups]);

  // 各区域展开状态
  // §打开的编辑器：没有已打开文件时默认收起，避免空列表占用空间
  const [openEditorsExpanded, setOpenEditorsExpanded] = useState(() => visibleOpenedFiles.length > 0);
  const [projectExpanded, setProjectExpanded] = useState(true);
  const [cloneRepoOpen, setCloneRepoOpen] = useState(false);
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  // §时间线 commit 列表 + 加载状态
  const [timelineCommits, setTimelineCommits] = useState<TimelineCommit[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);

  // §打开的编辑器：当从空状态首次打开文件时自动展开，方便查看；
  // 当所有文件关闭后（列表为空）自动收起，避免空区域占用空间
  useEffect(() => {
    if (visibleOpenedFiles.length === 0) {
      setOpenEditorsExpanded(false);
    } else if (!openEditorsExpanded) {
      setOpenEditorsExpanded(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleOpenedFiles.length]);

  // 打开的编辑器固定最大高度
  const OPEN_EDITORS_MAX_HEIGHT = 120;
  interface SectionHeights {
    timeline: number;
  }
  const [heights, setHeights] = useState<SectionHeights>({
    timeline: 120,
  });
  const [resizingSection, setResizingSection] = useState<keyof SectionHeights | null>(null);
  const scrollableRef = useRef<HTMLDivElement>(null);
  const SECTION_MIN_HEIGHT = 60;
  const RESIZE_HANDLE_HEIGHT = 10;

  const startResize = useCallback(
    (section: keyof SectionHeights, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setResizingSection(section);

      const handleRect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      const offsetY = e.clientY - (handleRect.top + handleRect.height / 2);

      const handleMouseMove = (event: MouseEvent) => {
        const container = scrollableRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const newHandleCenterY = event.clientY - offsetY;
        const nextHeight = Math.min(
          Math.max(SECTION_MIN_HEIGHT, rect.bottom - newHandleCenterY - RESIZE_HANDLE_HEIGHT / 2),
          rect.height - SECTION_MIN_HEIGHT - RESIZE_HANDLE_HEIGHT
        );
        setHeights((prev) => ({ ...prev, [section]: nextHeight }));
      };

      const handleMouseUp = () => {
        setResizingSection(null);
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        // §移除拖拽遮罩，恢复鼠标事件
        overlay.remove();
      };

      // §拖拽遮罩：防止鼠标划过 iframe/webview 等元素时丢失 mousemove 事件
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;cursor:ns-resize;background:transparent;';
      document.body.appendChild(overlay);

      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
      // §使用 window 而非 document，在 Electron 中更可靠
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    },
    []
  );

  // expandPaths 只在 QuickOpen 触发时设置一次，延迟清空避免影响后续手动折叠/展开
  const processedExpandPathsRef = useRef('');
  useEffect(() => {
    const key = expandPaths.join(',');
    if (expandPaths.length > 0 && key !== processedExpandPathsRef.current) {
      processedExpandPathsRef.current = key;
      const timer = setTimeout(() => {
        dispatch(clearExpandPaths());
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [expandPaths, dispatch]);

  // §时间线：监听选中文件 + 项目根变化，自动加载 commit 历史。
  //   - 选中文件时：显示该文件的提交历史（git log --follow <file>）
  //   - 未选中文件时：显示全部提交历史（git log）
  //   §防闪烁：延迟 150ms 才显示 loading，快速完成的请求不闪 loading icon
  useEffect(() => {
    let cancelled = false;
    let loadingTimer: ReturnType<typeof setTimeout> | null = null;

    async function loadTimeline() {
      if (!rootSource || typeof rootSource !== 'string') {
        setTimelineCommits([]);
        setTimelineLoading(false);
        return;
      }

      // 计算选中文件的相对路径（相对于项目根）
      let filePath: string | undefined;
      if (activeFileSource && typeof activeFileSource === 'string') {
        if (activeFileSource.startsWith(rootSource + '/')) {
          filePath = activeFileSource.slice(rootSource.length + 1);
        }
      }

      // §延迟显示 loading：150ms 内完成的请求不触发 loading 状态，避免快速切换时闪烁
      loadingTimer = setTimeout(() => {
        if (!cancelled) setTimelineLoading(true);
      }, 150);

      try {
        const api = window.electronAPI;
        if (!api?.extension?.rpc) return;
        const res = (await api.extension.rpc('ext.invoke', {
          extId: 'ideacode-git',
          method: 'getLog',
          args: [{ filePath, count: 50 }],
        })) as { success?: boolean; result?: TimelineCommit[] } | undefined;

        if (cancelled) return;
        if (loadingTimer) { clearTimeout(loadingTimer); loadingTimer = null; }
        if (res?.success && Array.isArray(res.result)) {
          setTimelineCommits(res.result);
        } else {
          setTimelineCommits([]);
        }
        setTimelineLoading(false);
      } catch {
        if (cancelled) return;
        if (loadingTimer) { clearTimeout(loadingTimer); loadingTimer = null; }
        setTimelineCommits([]);
        setTimelineLoading(false);
      }
    }

    loadTimeline();
    return () => {
      cancelled = true;
      if (loadingTimer) clearTimeout(loadingTimer);
    };
  }, [activeFileSource, rootSource]);

  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    targetEntry: null,
    targetParentSource: rootSource,
  });
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const [pendingRename, setPendingRename] = useState<PendingRename | null>(null);
  const [lastOperation, setLastOperation] = useState<LastOperation | null>(null);
  const [clipboardState, setClipboardState] = useState<FileClipboardState | null>(null);
  const [selectedEntries, setSelectedEntries] = useState<{ entry: FileEntry; parentSource: FileSource }[]>([]);
  const [pendingDeleteTargets, setPendingDeleteTargets] = useState<{ entry: FileEntry; parentSource: FileSource }[] | null>(null);

  // 提取为稳定引用：原 selectedEntries.map() 在每次渲染生成新数组，
  // 直接传给 FileTree 会击穿 React.memo，导致点击文件时整树重渲染。
  const selectedEntryList = useMemo(
    () => selectedEntries.map((s) => s.entry),
    [selectedEntries],
  );

  const notifyChange = useCallback((...targets: FileSource[]) => {
    setLastOperation({ targets, timestamp: Date.now() });
  }, []);

  // §删除文件并联动关闭已打开的编辑器 Tab
  const executeDelete = useCallback(async (targets: { entry: FileEntry; parentSource: FileSource }[]) => {
    if (!targets || targets.length === 0) return;
    const parentSources = new Set<FileSource>();
    for (const target of targets) {
      try {
        await deleteEntry(target.parentSource, target.entry.name, target.entry.kind);
        parentSources.add(target.parentSource);

        // 关闭与被删文件/目录匹配的编辑器 Tab
        const deletedSource =
          typeof target.parentSource === 'string'
            ? `${target.parentSource}/${target.entry.name}`
            : target.entry.source;
        if (deletedSource) {
          const filesToClose = openedFiles.filter((f) => {
            if (typeof f.source !== 'string' || typeof deletedSource !== 'string') return false;
            return f.source === deletedSource || f.source.startsWith(deletedSource + '/');
          });
          filesToClose.forEach((f) => dispatch(closeFile(f.id)));
        }
      } catch (err) {
        alert(t('explorer.errors.deleteFailed', {
          name: target.entry.name,
          message: err instanceof Error ? err.message : String(err),
        }));
      }
    }
    for (const ps of parentSources) {
      notifyChange(ps);
    }
    dispatch(refreshAllFilePaths());
    if (rootSource) {
      dispatch(refreshDirectory(rootSource));
    }
    setPendingDeleteTargets(null);
  }, [openedFiles, dispatch, notifyChange, rootSource, t]);

  // Git discard 等外部文件变更后，精准刷新受影响目录（不全量刷新，避免 CPU/GPU 卡顿）
  useEffect(() => {
    if (!externalFileChange || !rootSource) return;
    const rootPath = typeof rootSource === 'string' ? rootSource : '';
    if (!rootPath) return;

    // 计算受影响的所有祖先目录链（paths 是相对于仓库根的路径）
    // 例如 src/A/foo.ts → [rootPath/src, rootPath/src/A]
    // 仅刷新直接父目录无法让被删除的文件夹重新出现：因为该文件夹节点
    // 在删除操作时已被父目录的 children 移除，notifyChange(parent) 找不到
    // 匹配的 FileTree 节点；必须从 rootPath 之后的每一段都加入刷新集合，
    // 让最上层仍存在的祖先节点触发 refreshChildren 时逐级向下重建节点。
    const parentSources = new Set<string>();
    for (const p of externalFileChange.paths) {
      const lastSlash = p.lastIndexOf('/');
      if (lastSlash < 0) continue; // 顶级文件，由 refreshDirectory 刷新根级 entries
      const parts = p.substring(0, lastSlash).split('/');
      let current = rootPath;
      for (const part of parts) {
        if (!part) continue;
        current = current + '/' + part;
        parentSources.add(current);
      }
    }

    // 刷新根级条目（refreshDirectory 只更新 state.entries，性能可控）
    dispatch(refreshDirectory(rootSource));
    // 通知 FileTree 刷新受影响的展开子目录（通过 lastOperation 精准匹配）
    notifyChange(...Array.from(parentSources));
  }, [externalFileChange, rootSource, dispatch, notifyChange]);

  const handleOpenFolder = useCallback(async () => {
    const dir = await openDirectory();
    if (dir) dispatch(loadDirectory({ source: dir.source, name: dir.name }));
  }, [dispatch]);

  const handleFindInFiles = useCallback((name: string) => {
    dispatch(switchPanel('search'));
    dispatch(setPendingSearchQuery(name));
  }, [dispatch]);

  // §时间线 commit 点击：获取该 commit 的文件列表，在编辑区创建 tab 展示
  const handleTimelineClick = useCallback(async (commit: TimelineCommit) => {
    try {
      const api = window.electronAPI;
      if (!api?.extension?.rpc) return;
      const res = (await api.extension.rpc('ext.invoke', {
        extId: 'ideacode-git',
        method: 'getCommitFiles',
        args: [{ hash: commit.hash }],
      })) as { success?: boolean; result?: CommitDetailData | null } | undefined;

      if (res?.success && res.result) {
        dispatch(openCommitDetail(res.result));
      }
    } catch (e) {
      console.error('[Timeline] 获取 commit 文件列表失败:', e);
    }
  }, [dispatch]);

  // §"在终端中打开"：右键条目时触发
  //   - 本地路径：直接用 entry.source 作为 cwd，createTerminal 启动本地 shell
  //   - SSH 远程路径：通过 sshWorkspace 工具统一检测连接信息并构造 ssh 命令，
  //     与 BottomPanel/SshFileTreePanel 行为一致，由 terminalSDK.createTab 调度
  const handleOpenInTerminal = useCallback(async (entry: FileEntry) => {
    const source = entry.source;
    if (!isPath(source)) return;
    // SSH 远程条目：通过通道传递连接信息，主进程自动处理认证
    if (isRemoteUri(source)) {
      const conn = getSshConnection(source);
      if (!conn) {
        alert('未找到对应的 SSH 连接信息。请重新在"SSH 远程目录结构"中加载该目录。');
        return;
      }
      // 智能判断：右键文件夹 → 切到该目录；右键文件 → 进入父目录
      const remotePath = getSshRemotePath(source) || '/';
      const targetDir = entry.kind === 'directory'
        ? remotePath
        : remotePath.replace(/\/[^/]*$/, '') || '/';
      try {
        // §获取 SSH 凭据，通过通道传递给主进程，认证自动化在主进程完成
        const connectionId = getSshConnectionId(source);
        const credentials = connectionId ? await getSshCredentials(connectionId) : {};
        await terminalSDK.createTab({
          name: `${conn.name} · ${conn.username}@${conn.host}`,
          channel: 'ssh',
          sshConfig: {
            host: conn.host,
            port: conn.port,
            username: conn.username,
            password: credentials.password,
            privateKey: credentials.privateKey,
            passphrase: credentials.passphrase,
            remotePath: targetDir,
          },
        });
      } catch (err) {
        alert(`打开 SSH 终端失败: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    // 本地路径：cwd 设为 entry.source（若点击文件则用父目录）
    const localPath = String(source);
    const targetDir = entry.kind === 'directory'
      ? localPath
      : localPath.replace(/[/\\][^/\\]*$/, '') || localPath;
    try {
      await terminalSDK.createTab({ cwd: targetDir });
    } catch (err) {
      alert(`打开终端失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  const handleItemSelect = useCallback((entry: FileEntry, parentSource: FileSource, isMultiSelect: boolean) => {
    if (isMultiSelect) {
      setSelectedEntries((prev) => {
        const exists = prev.some((s) => isSameSource(s.entry.source, entry.source));
        if (exists) {
          return prev.filter((s) => !isSameSource(s.entry.source, entry.source));
        }
        return [...prev, { entry, parentSource }];
      });
    } else {
      setSelectedEntries([{ entry, parentSource }]);
    }
  }, []);

  const openContextMenu = useCallback(
    (e: React.MouseEvent, entry: FileEntry | null, parentSource: FileSource) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({
        visible: true,
        x: e.clientX,
        y: e.clientY,
        targetEntry: entry,
        targetParentSource: parentSource,
      });
    },
    []
  );

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }));
  }, []);

  const handleBlankContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!rootSource && remoteRoots.length === 0) return;
      if (e.currentTarget === e.target) {
        openContextMenu(e, null, rootSource || remoteRoots[0]!.source);
      }
    },
    [openContextMenu, rootSource, remoteRoots]
  );

  // ─── 新建操作 ───

  const startCreate = useCallback((parentSource: FileSource, type: 'file' | 'folder') => {
    closeContextMenu();
    setPendingCreate({ parentSource, type });
    setPendingRename(null);
  }, [closeContextMenu]);

  const handleCreateConfirm = useCallback(async (parentSource: FileSource, type: 'file' | 'folder', name: string) => {
    const alreadyExists = await exists(parentSource, name);
    if (alreadyExists) {
      alert(t('explorer.errors.nameExists', { name }));
      throw new Error(`名称 "${name}" 已被占用`);
    }
    try {
      if (type === 'file') {
        await createFile(parentSource, name);
      } else {
        await createDirectory(parentSource, name);
      }
      setPendingCreate(null);
      notifyChange(parentSource);
      dispatch(refreshAllFilePaths());
      if (rootSource && isSameSource(parentSource, rootSource)) {
        dispatch(refreshDirectory(parentSource));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Explorer] 创建失败:', msg);
      alert(t('explorer.errors.createFailed'));
      throw err;
    }
  }, [rootSource, dispatch, notifyChange, t]);

  const handleCreateCancel = useCallback(() => {
    setPendingCreate(null);
  }, []);

  // ─── 重命名操作 ───

  const startRename = useCallback((entry: FileEntry, parentSource: FileSource) => {
    closeContextMenu();
    setPendingRename({ entry, parentSource });
    setPendingCreate(null);
  }, [closeContextMenu]);

  const handleRenameConfirm = useCallback(async (parentSource: FileSource, oldName: string, newName: string, kind: 'file' | 'directory') => {
    if (!newName || newName === oldName) {
      setPendingRename(null);
      return;
    }
    const alreadyExists = await exists(parentSource, newName);
    if (alreadyExists) {
      alert(t('explorer.errors.nameExists', { name: newName }));
      throw new Error(`名称 "${newName}" 已被占用`);
    }
    try {
      await renameEntry(parentSource, oldName, newName, kind);
      setPendingRename(null);
      notifyChange(parentSource);
      dispatch(refreshAllFilePaths());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Explorer] 重命名失败:', msg);
      alert(t('explorer.errors.renameFailed'));
      throw err;
    }
  }, [dispatch, notifyChange, t]);

  const handleRenameCancel = useCallback(() => {
    setPendingRename(null);
  }, []);

  // ─── 拖拽移动文件/文件夹 ───

  const handleMoveFile = useCallback(async (
    dragEntry: FileEntry,
    dragParentSource: FileSource,
    dropEntry: FileEntry | null, // null = 放到根目录
    dropParentSource: FileSource,
  ) => {
    if (!rootSource) return;
    const isElectronMode = isElectron();

    // 计算源路径和目标路径
    let oldPath: string;
    let destDir: string;

    if (isElectronMode && isPath(dragParentSource)) {
      oldPath = dragParentSource + '/' + dragEntry.name;
    } else {
      return; // 浏览器模式暂不支持
    }

    if (dropEntry && dropEntry.kind === 'directory') {
      // 拖到文件夹上 → 放入该文件夹
      destDir = isPath(dropEntry.source) ? dropEntry.source : oldPath;
    } else if (dropEntry && dropEntry.kind === 'file') {
      // 拖到文件上 → 放到同级目录
      destDir = isPath(dropParentSource) ? dropParentSource : oldPath;
    } else {
      // 拖到空白 → 放到根目录
      destDir = isPath(rootSource) ? rootSource : oldPath;
    }

    const newPath = destDir + '/' + dragEntry.name;

    // 防止移动到自身
    if (oldPath === newPath) return;

    // 防止把文件夹移到自己的子目录（路径前缀检测 — Trie 思想）
    if (dragEntry.kind === 'directory' && newPath.startsWith(oldPath + '/')) {
      alert(t('explorer.errors.cannotMoveIntoSelf'));
      return;
    }

    // 同名冲突检测
    if (destDir !== (isPath(dragParentSource) ? dragParentSource : '')) {
      const conflict = await exists(destDir, dragEntry.name);
      if (conflict) {
        alert(t('explorer.errors.nameExists', { name: dragEntry.name }));
        return;
      }
    }

    try {
      const success = await window.electronAPI!.fs.rename(oldPath, newPath);
      if (!success) throw new Error('移动失败');

      // 通知源目录和目标目录刷新
      notifyChange(dragParentSource, destDir);
      dispatch(refreshAllFilePaths());
      if (isSameSource(destDir as FileSource, rootSource)) {
        dispatch(refreshDirectory(rootSource));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Explorer] 移动失败:', msg);
      alert(t('explorer.errors.moveFailed'));
    }
  }, [rootSource, dispatch, notifyChange, t]);

  // ─── 粘贴操作（批量，含同名冲突处理）───

  const handlePaste = useCallback(async (destSource: FileSource) => {
    const clipboard = getFileClipboard();
    if (!clipboard || clipboard.items.length === 0) return;

    const parentSources = new Set<FileSource>();

    for (const item of clipboard.items) {
      const nameConflict = await exists(destSource, item.name);
      const finalName = nameConflict
        ? await generateCopyName(destSource, item.name, item.kind)
        : item.name;

      await copyEntry(item.parentSource, item.name, destSource, finalName);

      if (clipboard.action === 'cut') {
        await deleteEntry(item.parentSource, item.name, item.kind);
        parentSources.add(item.parentSource);
      }
    }

    if (clipboard.action === 'cut') {
      clearFileClipboard();
      setClipboardState(null);
    }

    parentSources.add(destSource);
    notifyChange(...Array.from(parentSources));
    if (rootSource && isSameSource(destSource, rootSource)) {
      dispatch(refreshDirectory(destSource));
    }
  }, [rootSource, dispatch, notifyChange]);

  // ─── 菜单构建（含 Hebbian 频率加权排序）───

  const wrapWithClickTracking = useCallback((id: string, handler: () => void): (() => void) => {
    return () => {
      recordMenuClick(id);
      handler();
    };
  }, []);

  const buildMenuItems = useCallback((): MenuItem[] => {
    if (!rootSource && remoteRoots.length === 0) return [];
    const { targetEntry, targetParentSource } = contextMenu;
    const defaultRootSource: FileSource = rootSource || remoteRoots[0]!.source;

    const safeParentSource: FileSource = targetParentSource || defaultRootSource;

    const isMultiSelect = selectedEntries.length > 1;
    const activeTargets = isMultiSelect
      ? selectedEntries
      : targetEntry
      ? [{ entry: targetEntry, parentSource: safeParentSource }]
      : [];

    const createTargetSource =
      targetEntry?.kind === 'directory'
        ? targetEntry.source
        : targetEntry
        ? safeParentSource
        : defaultRootSource;

    const canPasteHere = clipboardState !== null;
    const pasteTargetSource =
      targetEntry?.kind === 'directory'
        ? targetEntry.source
        : targetEntry
        ? safeParentSource
        : defaultRootSource;

    const items: MenuItem[] = [
      {
        id: 'new-file',
        label: t('explorer.contextMenu.newFile'),
        icon: <FilePlus size={14} strokeWidth={1.5} />,
        group: '1_new',
        order: 1,
        disabled: isMultiSelect,
        onClick: wrapWithClickTracking('new-file', () => startCreate(createTargetSource, 'file')),
      },
      {
        id: 'new-folder',
        label: t('explorer.contextMenu.newFolder'),
        icon: <FolderPlus size={14} strokeWidth={1.5} />,
        group: '1_new',
        order: 2,
        disabled: isMultiSelect,
        onClick: wrapWithClickTracking('new-folder', () => startCreate(createTargetSource, 'folder')),
      },
    ];

    if (targetEntry) {
      items.push(
        {
          id: 'reveal',
          label: t('explorer.contextMenu.revealInExplorer'),
          icon: <FolderOpenIcon size={14} strokeWidth={1.5} />,
          group: '1_new',
          order: 3,
          disabled: !isElectron() || isMultiSelect || isRemoteUri(targetEntry.source),
          onClick: wrapWithClickTracking('reveal', async () => {
            try {
              if (isPath(targetEntry.source) && !isRemoteUri(targetEntry.source)) {
                await revealInExplorer(targetEntry.source);
              }
            } catch (err) {
              alert(t('explorer.errors.revealFailed', { message: err instanceof Error ? err.message : String(err) }));
            }
          }),
        },
        {
          // §需求：在右键菜单里提供"在终端中打开"入口。点中后：
          //   - 本地文件/目录：cwd 设为 entry 路径，createTerminal 直接打开本地 PTY。
          //   - SSH 远程条目（之前由 SshFileTreePanel "添加到资源管理器" 加载的）：
          //     从 Redux 取出 connection 信息，构造 ssh 命令：ssh -p 22 -t user@host
          //     "cd <path> && exec $SHELL -l"，让终端标签直接连到远程主机。
          id: 'open-in-terminal',
          label: '在终端中打开',
          icon: <TerminalIcon size={14} strokeWidth={1.5} />,
          group: '1_new',
          order: 4,
          disabled: isMultiSelect,
          onClick: wrapWithClickTracking('open-in-terminal', () => handleOpenInTerminal(targetEntry)),
        },
        {
          id: 'find-in-files',
          label: t('explorer.contextMenu.findInFiles'),
          icon: <Search size={14} strokeWidth={1.5} />,
          group: '2_search',
          order: 5,
          disabled: isMultiSelect,
          onClick: wrapWithClickTracking('find-in-files', () => handleFindInFiles(targetEntry.name)),
        },
        {
          id: 'cut',
          label: t('cut'),
          icon: <Scissors size={14} strokeWidth={1.5} />,
          group: '3_edit',
          order: 5,
          disabled: activeTargets.length === 0,
          onClick: wrapWithClickTracking('cut', () => {
            const cutItems = activeTargets.map((s) => ({
              source: s.entry.source,
              name: s.entry.name,
              kind: s.entry.kind,
              parentSource: s.parentSource,
              action: 'cut' as const,
            }));
            setFileClipboard('cut', cutItems);
            setClipboardState({ action: 'cut', items: cutItems });
          }),
        },
        {
          id: 'copy',
          label: t('copy'),
          icon: <Copy size={14} strokeWidth={1.5} />,
          group: '3_edit',
          order: 6,
          disabled: activeTargets.length === 0,
          onClick: wrapWithClickTracking('copy', () => {
            const copyItems = activeTargets.map((s) => ({
              source: s.entry.source,
              name: s.entry.name,
              kind: s.entry.kind,
              parentSource: s.parentSource,
              action: 'copy' as const,
            }));
            setFileClipboard('copy', copyItems);
            setClipboardState({ action: 'copy', items: copyItems });
          }),
        },
        {
          id: 'paste',
          label: t('paste'),
          icon: <ClipboardPaste size={14} strokeWidth={1.5} />,
          group: '3_edit',
          order: 7,
          disabled: !canPasteHere,
          onClick: wrapWithClickTracking('paste', () => handlePaste(pasteTargetSource)),
        },
        {
          id: 'copy-path',
          label: t('explorer.contextMenu.copyPath'),
          icon: <Link size={14} strokeWidth={1.5} />,
          group: '4_path',
          order: 8,
          disabled: !isPath(targetEntry.source) || isMultiSelect,
          onClick: wrapWithClickTracking('copy-path', () => {
            if (isPath(targetEntry.source)) {
              navigator.clipboard.writeText(targetEntry.source).catch(() => {});
            }
          }),
        },
        {
          id: 'copy-relative-path',
          label: t('explorer.contextMenu.copyRelativePath'),
          icon: <Link size={14} strokeWidth={1.5} />,
          group: '4_path',
          order: 9,
          disabled: !isPath(targetEntry.source) || !rootSource || !isPath(rootSource) || isMultiSelect,
          onClick: wrapWithClickTracking('copy-relative-path', () => {
            if (rootSource && isPath(targetEntry.source) && isPath(rootSource)) {
              const rel = targetEntry.source.replace(rootSource + '/', '');
              navigator.clipboard.writeText(rel).catch(() => {});
            }
          }),
        },
        {
          id: 'rename',
          label: t('rename'),
          icon: <FileSignature size={14} strokeWidth={1.5} />,
          group: '5_file',
          order: 10,
          disabled: isMultiSelect,
          onClick: wrapWithClickTracking('rename', () => startRename(targetEntry, safeParentSource)),
        },
        {
          id: 'delete',
          label: t('delete'),
          icon: <Trash2 size={14} strokeWidth={1.5} />,
          group: '5_file',
          order: 11,
          disabled: activeTargets.length === 0,
          onClick: wrapWithClickTracking('delete', () => {
            setPendingDeleteTargets(activeTargets);
          }),
        }
      );
    } else {
      items.push({
        id: 'paste',
        label: '粘贴',
        icon: <ClipboardPaste size={14} strokeWidth={1.5} />,
        group: '3_edit',
        order: 7,
        disabled: !canPasteHere,
        onClick: wrapWithClickTracking('paste', () => handlePaste(pasteTargetSource)),
      });
    }

    const menuManager = getMenuManager();
    const pluginItems = menuManager.getItems('fileTree', {
      entry: targetEntry,
      parentSource: targetParentSource,
      rootSource,
    });
    for (const p of pluginItems) {
      items.push(contributionToMenuItem(p));
    }

    // Hebbian 频率加权排序：同 group 内，高频项优先
    const freqs = getMenuFrequencies();
    items.sort((a, b) => {
      const ga = a.group || '';
      const gb = b.group || '';
      if (ga !== gb) return ga.localeCompare(gb);

      // 频率加权：freq = 0.7 × static_order + 0.3 × frequency_bonus
      const freqA = freqs[a.id] || 0;
      const freqB = freqs[b.id] || 0;
      const scoreA = (a.order ?? 0) - freqA * 3;
      const scoreB = (b.order ?? 0) - freqB * 3;
      return scoreA - scoreB;
    });

    return items;
  }, [contextMenu, dispatch, rootSource, startCreate, startRename, handleFindInFiles, handlePaste, notifyChange, selectedEntries, wrapWithClickTracking, t]);

  const stableOnOpenFile = useCallback((entry: FileEntry) => {
    dispatch(openFile(entry));
  }, [dispatch]);

  const stableOnToggleExpand = useCallback((path: string, expand: boolean) => {
    dispatch(toggleExpandDir({ path, expand }));
  }, [dispatch]);

  const selectedRef = useRef(selectedEntries);
  selectedRef.current = selectedEntries;

  const stableOnContextMenu = useCallback(
    (e: React.MouseEvent, entry: FileEntry, parentSource: FileSource) => {
      if (!selectedRef.current.some((s) => isSameSource(s.entry.source, entry.source))) {
        setSelectedEntries([{ entry, parentSource }]);
      }
      openContextMenu(e, entry, parentSource);
    },
    [openContextMenu]
  );

  const renderInlineInput = useCallback((parentSource: FileSource | null) => {
    if (!parentSource || !pendingCreate || !isSameSource(pendingCreate.parentSource, parentSource)) return null;
    return (
      <div className="tree-item inline-create-item" style={{ paddingLeft: 12 }}>
        <span className="tree-item__indent" />
        <span className="tree-item__icon">
          {pendingCreate.type === 'file' ? (
            <FileText size={14} strokeWidth={1.5} />
          ) : (
            <FolderIcon />
          )}
        </span>
        <InlineInput
          placeholder={pendingCreate.type === 'file' ? t('explorer.inputPlaceholder.fileName') : t('explorer.inputPlaceholder.folderName')}
          onConfirm={(name) => handleCreateConfirm(parentSource, pendingCreate.type, name)}
          onCancel={handleCreateCancel}
        />
      </div>
    );
  }, [pendingCreate, handleCreateConfirm, handleCreateCancel, t]);

  return (
    <div className="folder-tree" onContextMenu={handleBlankContextMenu}>
      {/* 空状态 */}
      {!rootSource && remoteRoots.length === 0 && (
        <div className="side-panel__actions">
          <div className="explorer-empty">
            <p className="explorer-empty__text">{t('explorer.empty.title')}</p>
            <div className="explorer-empty__btns">
              <button className="explorer-empty__btn" onClick={handleOpenFolder}>
                <FolderOpenIcon size={14} strokeWidth={1.5} />
                {t('explorer.empty.openFolder')}
              </button>
            </div>
            <p className="explorer-empty__label">本地克隆仓库</p>
            <div className="explorer-empty__btns">
              <button className="explorer-empty__btn" onClick={() => setCloneRepoOpen(true)}>
                <Download size={14} strokeWidth={1.5} />
                {t('explorer.empty.cloneRepo')}
              </button>
            </div>
          </div>
        </div>
      )}

      {cloneRepoOpen && <CloneRepoModal onClose={() => setCloneRepoOpen(false)} />}

      {(rootSource || remoteRoots.length > 0) && (
        <>
          {/* ── 打开的编辑器 ── */}
          <div className="explorer-section">
            <div
              className="explorer-section__header"
              onClick={() => setOpenEditorsExpanded(!openEditorsExpanded)}
            >
              <ChevronRight
                size={12}
                strokeWidth={1.5}
                className={openEditorsExpanded ? 'explorer-rotated' : ''}
              />
              <span className="explorer-section__title">{t('explorer.sections.openEditors')}</span>
            </div>
            {openEditorsExpanded && (
              <div className="explorer-section__content" style={{ maxHeight: OPEN_EDITORS_MAX_HEIGHT }}>
                {visibleOpenedFiles.length === 0 && (
                  <div className="explorer-open-editor explorer-open-editor--empty">
                    {t('explorer.empty.noOpenEditors')}
                  </div>
                )}
                {visibleOpenedFiles.map((file) => {
                  const fileRelPath = typeof file.source === 'string' && typeof rootSource === 'string' && rootSource
                    ? file.source.replace(rootSource + '/', '')
                    : '';
                  const fileGitCode = fileRelPath ? gitStatus[fileRelPath] : '';
                  return (
                    <div
                      key={file.id}
                      className={`explorer-open-editor ${file.id === activeFileId ? 'active' : ''}`}
                      onClick={() => dispatch(activateFile(file.id))}
                      title={typeof file.source === 'string' ? file.source : file.name}
                    >
                      <span className={`explorer-open-editor__name ${fileGitCode ? 'git-' + fileGitCode.toLowerCase() : ''}`}>{file.name}</span>
                      {file.isDirty && <span className="explorer-open-editor__dirty" />}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {/* 项目树/时间线等区域统一在下方可滚动区域中滚动，
              保证“打开的编辑器”始终固定在顶部不被遮罩 */}
          <div className="folder-tree__scrollable" ref={scrollableRef}>
            {/* ── IDEACODE 项目结构 ── */}
            {rootSource && (
            <div className={`explorer-section explorer-section--main ${!projectExpanded || entries.length === 0 ? 'explorer-section--collapsed' : ''}`}>
              <div
                className="explorer-section__header"
                onClick={() => setProjectExpanded(!projectExpanded)}
              >
                <ChevronRight
                  size={12}
                  strokeWidth={1.5}
                  className={projectExpanded ? 'explorer-rotated' : ''}
                />
                <span className="explorer-section__title">{rootName || 'IDEACODE'}</span>
                <span className="explorer-section__tools">
                  <button
                    className="explorer-header__icon"
                    title={t('explorer.header.newFile')}
                    onClick={(e) => { e.stopPropagation(); startCreate(rootSource, 'file'); }}
                  >
                    <FilePlus size={14} strokeWidth={1.5} />
                  </button>
                  <button
                    className="explorer-header__icon"
                    title={t('explorer.header.newFolder')}
                    onClick={(e) => { e.stopPropagation(); startCreate(rootSource, 'folder'); }}
                  >
                    <FolderPlus size={14} strokeWidth={1.5} />
                  </button>
                  <button
                    className="explorer-header__icon"
                    title={t('explorer.header.refresh')}
                    onClick={(e) => { e.stopPropagation(); dispatch(refreshDirectory(rootSource)); }}
                  >
                    <RefreshCw size={14} strokeWidth={1.5} />
                  </button>
                  <button
                    className="explorer-header__icon"
                    title={t('explorer.header.collapseAll')}
                    onClick={(e) => { e.stopPropagation(); dispatch(collapseAllDirs()); }}
                  >
                    <ChevronsDownUp size={14} strokeWidth={1.5} />
                  </button>
                </span>
              </div>
              {projectExpanded && (
                <div
                  className="explorer-section__content"
                  onDragOver={(e) => {
                    // 拖拽到空白区域也允许放置（移到根目录）
                    if (currentDragExists()) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
                  }}
                  onDrop={(e) => {
                    const drag = getCurrentDrag();
                    if (drag) {
                      e.preventDefault();
                      handleMoveFile(drag.entry, drag.parentSource, null, rootSource);
                      clearCurrentDrag();
                    }
                  }}
                >
                  {entries.length === 0 ? (
                    <div className="explorer-open-editor--empty">{t('explorer.empty.noFiles')}</div>
                  ) : (
                    <>
                      {entries.map((entry) => (
                        <FileTree
                          key={`${entry.name}:${entry.kind}`}
                          entry={entry}
                          level={0}
                          activeSource={activeFileSource}
                          onOpenFile={stableOnOpenFile}
                          parentSource={rootSource}
                          rootSource={rootSource}
                          onFindInFiles={handleFindInFiles}
                          onContextMenu={stableOnContextMenu}
                          pendingCreate={pendingCreate}
                          onCreateConfirm={handleCreateConfirm}
                          onCreateCancel={handleCreateCancel}
                          pendingRename={pendingRename}
                          onRenameConfirm={handleRenameConfirm}
                          onRenameCancel={handleRenameCancel}
                          onMoveFile={handleMoveFile}
                          lastOperation={lastOperation}
                          clipboardItems={clipboardState?.items}
                          selectedEntries={selectedEntryList}
                          onItemSelect={handleItemSelect}
                          gitStatus={gitStatus}
                          expandPaths={expandPaths}
                          onToggleExpand={stableOnToggleExpand}
                        />
                      ))}
                      {renderInlineInput(rootSource)}
                    </>
                  )}
                </div>
              )}
            </div>
            )}

            {/* ── 远程工作区根目录 ── */}
            {remoteRoots.map((root) => {
              const rootEntry: FileEntry = { name: root.name, kind: 'directory', source: root.source };
              const rootExpandPath = `remote-root-${root.id}`;
              const rootTools = (
                <>
                  <button
                    className="explorer-header__icon"
                    title={t('explorer.header.refresh')}
                    onClick={(e) => { e.stopPropagation(); notifyChange(root.source); }}
                  >
                    <RefreshCw size={14} strokeWidth={1.5} />
                  </button>
                  <button
                    className="explorer-header__icon"
                    title="从资源管理器移除"
                    onClick={(e) => { e.stopPropagation(); dispatch(removeWorkspaceFolder(root.id)); }}
                  >
                    <Trash2 size={14} strokeWidth={1.5} />
                  </button>
                </>
              );
              return (
                <div key={root.id} className="explorer-section explorer-section--remote">
                  <div className="explorer-section__content">
                    <FileTree
                      entry={rootEntry}
                      level={0}
                      activeSource={activeFileSource}
                      onOpenFile={stableOnOpenFile}
                      parentSource={root.source}
                      rootSource={root.source}
                      onFindInFiles={handleFindInFiles}
                      onContextMenu={stableOnContextMenu}
                      pendingCreate={pendingCreate}
                      onCreateConfirm={handleCreateConfirm}
                      onCreateCancel={handleCreateCancel}
                      pendingRename={pendingRename}
                      onRenameConfirm={handleRenameConfirm}
                      onRenameCancel={handleRenameCancel}
                      lastOperation={lastOperation}
                      clipboardItems={clipboardState?.items}
                      selectedEntries={selectedEntryList}
                      onItemSelect={handleItemSelect}
                      gitStatus={gitStatus}
                      expandPaths={expandPaths}
                      onToggleExpand={stableOnToggleExpand}
                      onMoveFile={handleMoveFile}
                      relativePath={rootExpandPath}
                      headerTools={rootTools}
                      rootClassName="tree-item--remote-root"
                      rootIndentOffset={2}
                    />
                    {renderInlineInput(root.source)}
                  </div>
                </div>
              );
            })}

            {projectExpanded && timelineExpanded && (
              <div
                className={`explorer-section__resize-handle ${resizingSection === 'timeline' ? 'is-resizing' : ''}`}
                onMouseDown={(e) => startResize('timeline', e)}
              />
            )}
            {/* ── 时间线 ── */}
            <div className="explorer-section">
              <div
                className="explorer-section__header"
                onClick={() => setTimelineExpanded(!timelineExpanded)}
              >
                <ChevronRight
                  size={12}
                  strokeWidth={1.5}
                  className={timelineExpanded ? 'explorer-rotated' : ''}
                />
                <span className="explorer-section__title">{t('explorer.sections.timeline')}</span>
              </div>
              {timelineExpanded && (
                <div className="explorer-section__content explorer-timeline" style={{ height: heights.timeline }}>
                  {timelineLoading ? (
                    <div className="explorer-timeline__loading">
                      <svg className="explorer-timeline__spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                      </svg>
                    </div>
                  ) : timelineCommits.length === 0 ? (
                    <div className="explorer-timeline--empty">暂无提交记录</div>
                  ) : (
                    <div className="explorer-timeline__list">
                      {timelineCommits.map((commit) => (
                        <div
                          key={commit.hash}
                          className="explorer-timeline__item"
                          style={{ cursor: 'pointer' }}
                          title={commit.subject}
                          onClick={() => handleTimelineClick(commit)}
                        >
                          <span className="explorer-timeline__dot" />
                          <div className="explorer-timeline__main">
                            <span className="explorer-timeline__message">{commit.subject}</span>
                            <span className="explorer-timeline__author">{commit.authorName}</span>
                          </div>
                          <span className="explorer-timeline__time">{formatRelativeTime(commit.timestamp)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      <ContextMenu
        items={buildMenuItems()}
        x={contextMenu.x}
        y={contextMenu.y}
        visible={contextMenu.visible}
        onClose={closeContextMenu}
      />

      {pendingDeleteTargets && (
        <DeleteConfirmDialog
          message={t('explorer.confirm.delete')}
          onConfirm={() => executeDelete(pendingDeleteTargets)}
          onCancel={() => setPendingDeleteTargets(null)}
        />
      )}
    </div>
  );
};

export default ExplorerContent;
