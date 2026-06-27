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
} from 'lucide-react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import {
  loadDirectory,
  openFile,
  refreshDirectory,
  setPendingSearchQuery,
  refreshAllFilePaths,
  clearExpandPaths,
  toggleExpandDir,
  activateFile,
  removeWorkspaceFolder,
} from '../../store/slices/workspaceSlice';
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
import FileTree, { type PendingCreate, type PendingRename, type LastOperation, getCurrentDrag, currentDragExists, clearCurrentDrag } from './FileTree';
import ContextMenu, { type MenuItem } from '../ContextMenu';
import InlineInput from '../InlineInput';
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
  const [openEditorsExpanded, setOpenEditorsExpanded] = useState(true);
  const [projectExpanded, setProjectExpanded] = useState(true);
  const [timelineExpanded, setTimelineExpanded] = useState(false);

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
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
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

  // 提取为稳定引用：原 selectedEntries.map() 在每次渲染生成新数组，
  // 直接传给 FileTree 会击穿 React.memo，导致点击文件时整树重渲染。
  const selectedEntryList = useMemo(
    () => selectedEntries.map((s) => s.entry),
    [selectedEntries],
  );

  const notifyChange = useCallback((...targets: FileSource[]) => {
    setLastOperation({ targets, timestamp: Date.now() });
  }, []);

  const handleOpenFolder = useCallback(async () => {
    const dir = await openDirectory();
    if (dir) dispatch(loadDirectory({ source: dir.source, name: dir.name }));
  }, [dispatch]);

  const handleFindInFiles = useCallback((name: string) => {
    dispatch(switchPanel('search'));
    dispatch(setPendingSearchQuery(name));
  }, [dispatch]);

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
          id: 'find-in-files',
          label: t('explorer.contextMenu.findInFiles'),
          icon: <Search size={14} strokeWidth={1.5} />,
          group: '2_search',
          order: 4,
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
          onClick: wrapWithClickTracking('delete', async () => {
            const names = activeTargets.map((target) => target.entry.name).join('", "');
            if (!window.confirm(t('explorer.confirm.delete', { names }))) return;
            const parentSources = new Set<FileSource>();
            for (const target of activeTargets) {
              try {
                await deleteEntry(target.parentSource, target.entry.name, target.entry.kind);
                parentSources.add(target.parentSource);
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
              <button className="explorer-empty__btn" onClick={() => dispatch(switchPanel('workbench.scm'))}>
                <Download size={14} strokeWidth={1.5} />
                {t('explorer.empty.cloneRepo')}
              </button>
            </div>
          </div>
        </div>
      )}

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
                    onClick={(e) => { e.stopPropagation(); dispatch(clearExpandPaths()); }}
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
                <div className="explorer-section__content" style={{ height: heights.timeline }}>
                  <div className="explorer-timeline--empty">{t('explorer.empty.timelineComingSoon')}</div>
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
    </div>
  );
};

export default ExplorerContent;
