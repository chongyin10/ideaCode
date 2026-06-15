import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
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
  refreshGitStatus,
  refreshAllFilePaths,
  clearExpandPaths,
  toggleExpandDir,
  closeDiffView,
  activateFile,
} from '../../store/slices/workspaceSlice';
import { setShowCloneForm, refreshGitStatus as refreshGitSliceStatus } from '../../store/slices/gitSlice';
import { switchPanel } from '../../store/slices/layoutSlice';
import { openDirectory } from '../../services/fileService';
import type { FileEntry, FileSource } from '../../services/fileService';
import {
  isPath,
  isElectron,
  isSameSource,
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
import FileTree, { type PendingCreate, type PendingRename, type LastOperation } from './FileTree';
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
  const dispatch = useAppDispatch();

  const rootSource = useAppSelector((state) => state.workspace.rootSource);
  const rootName = useAppSelector((state) => state.workspace.rootName);
  const entries = useAppSelector((state) => state.workspace.entries);
  const activeFileSource = useAppSelector((state) => state.workspace.activeFileSource);
  const gitStaged = useAppSelector((s) => s.git.staged);
  const gitChanges = useAppSelector((s) => s.git.changes);
  const gitMerge = useAppSelector((s) => s.git.merge);
  const gitUntracked = useAppSelector((s) => s.git.untracked);
  // 合并供 FileTree 使用
  const gitStatus = useMemo(() => ({ ...gitStaged, ...gitChanges, ...gitMerge, ...gitUntracked }), [gitStaged, gitChanges, gitMerge, gitUntracked]);
  const expandPaths = useAppSelector((state) => state.workspace.expandPaths);
  const expandedDirs = useAppSelector((state) => state.workspace.expandedDirs);
  const openedFiles = useAppSelector((state) => state.workspace.openedFiles);
  const activeFileId = useAppSelector((state) => state.workspace.activeFileId);

  // 各区域展开状态
  const [openEditorsExpanded, setOpenEditorsExpanded] = useState(true);
  const [projectExpanded, setProjectExpanded] = useState(true);
  const [timelineExpanded, setTimelineExpanded] = useState(false);

  // 时间线高度可拖动调整；打开的编辑器固定最大高度，不再提供拖拽
  const SECTION_MIN_HEIGHT = 60;
  const OPEN_EDITORS_MAX_HEIGHT = 120;
  interface SectionHeights {
    timeline: number;
  }
  const [heights, setHeights] = useState<SectionHeights>({
    timeline: 120,
  });
  const [resizingSection, setResizingSection] = useState<keyof SectionHeights | null>(null);
  const scrollableRef = useRef<HTMLDivElement>(null);
  const RESIZE_HANDLE_HEIGHT = 10;

  const startResize = useCallback(
    (section: keyof SectionHeights, e: React.MouseEvent) => {
      e.preventDefault();
      setResizingSection(section);

      // 记录鼠标点击点与手柄中心的偏移，保证拖拽时手柄中心紧跟鼠标
      const handleRect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      const offsetY = e.clientY - (handleRect.top + handleRect.height / 2);

      const handleMouseMove = (event: MouseEvent) => {
        const container = scrollableRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const newHandleCenterY = event.clientY - offsetY;
        // 时间线高度 = 容器底部 - 手柄中心 - 半个手柄高度
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
      if (!rootSource) return;
      if (e.currentTarget === e.target) {
        openContextMenu(e, null, rootSource);
      }
    },
    [openContextMenu, rootSource]
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
      alert(`名称 "${name}" 已被占用，请更换名称后重试`);
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
      dispatch(refreshGitStatus());
      dispatch(refreshGitSliceStatus());
      dispatch(refreshAllFilePaths());
      if (rootSource && isSameSource(parentSource, rootSource)) {
        dispatch(refreshDirectory(parentSource));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Explorer] 创建失败:', msg);
      alert('创建失败，请检查名称是否合法或路径是否存在');
      throw err;
    }
  }, [rootSource, dispatch, notifyChange]);

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
      alert(`名称 "${newName}" 已被占用，请更换名称后重试`);
      throw new Error(`名称 "${newName}" 已被占用`);
    }
    try {
      await renameEntry(parentSource, oldName, newName, kind);
      setPendingRename(null);
      notifyChange(parentSource);
      dispatch(refreshGitStatus());
      dispatch(refreshGitSliceStatus());
      dispatch(refreshAllFilePaths());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Explorer] 重命名失败:', msg);
      alert('重命名失败，请检查名称是否合法');
      throw err;
    }
  }, [notifyChange]);

  const handleRenameCancel = useCallback(() => {
    setPendingRename(null);
  }, []);

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
    dispatch(refreshGitStatus());
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
    if (!rootSource) return [];
    const { targetEntry, targetParentSource } = contextMenu;
    const clipboard = getFileClipboard();

    const safeParentSource = targetParentSource || rootSource;

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
        : rootSource;

    const canPasteHere = clipboard !== null;
    const pasteTargetSource =
      targetEntry?.kind === 'directory'
        ? targetEntry.source
        : targetEntry
        ? safeParentSource
        : rootSource;

    const items: MenuItem[] = [
      {
        id: 'new-file',
        label: '新建文件',
        icon: <FilePlus size={14} strokeWidth={1.5} />,
        group: '1_new',
        order: 1,
        disabled: isMultiSelect,
        onClick: wrapWithClickTracking('new-file', () => startCreate(createTargetSource, 'file')),
      },
      {
        id: 'new-folder',
        label: '新建文件夹',
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
          label: '在磁盘中打开',
          icon: <FolderOpenIcon size={14} strokeWidth={1.5} />,
          group: '1_new',
          order: 3,
          disabled: !isElectron() || isMultiSelect,
          onClick: wrapWithClickTracking('reveal', async () => {
            try {
              if (isPath(targetEntry.source)) {
                await revealInExplorer(targetEntry.source);
              }
            } catch (err) {
              alert(`打开失败: ${err instanceof Error ? err.message : String(err)}`);
            }
          }),
        },
        {
          id: 'find-in-files',
          label: '在文件中查找',
          icon: <Search size={14} strokeWidth={1.5} />,
          group: '2_search',
          order: 4,
          disabled: isMultiSelect,
          onClick: wrapWithClickTracking('find-in-files', () => handleFindInFiles(targetEntry.name)),
        },
        {
          id: 'cut',
          label: '剪切',
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
          label: '复制',
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
          label: '粘贴',
          icon: <ClipboardPaste size={14} strokeWidth={1.5} />,
          group: '3_edit',
          order: 7,
          disabled: !canPasteHere,
          onClick: wrapWithClickTracking('paste', () => handlePaste(pasteTargetSource)),
        },
        {
          id: 'copy-path',
          label: '复制路径',
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
          label: '复制相对路径',
          icon: <Link size={14} strokeWidth={1.5} />,
          group: '4_path',
          order: 9,
          disabled: !isPath(targetEntry.source) || !isPath(rootSource) || isMultiSelect,
          onClick: wrapWithClickTracking('copy-relative-path', () => {
            if (isPath(targetEntry.source) && isPath(rootSource)) {
              const rel = targetEntry.source.replace(rootSource + '/', '');
              navigator.clipboard.writeText(rel).catch(() => {});
            }
          }),
        },
        {
          id: 'rename',
          label: '重命名',
          icon: <FileSignature size={14} strokeWidth={1.5} />,
          group: '5_file',
          order: 10,
          disabled: isMultiSelect,
          onClick: wrapWithClickTracking('rename', () => startRename(targetEntry, safeParentSource)),
        },
        {
          id: 'delete',
          label: '删除',
          icon: <Trash2 size={14} strokeWidth={1.5} />,
          group: '5_file',
          order: 11,
          disabled: activeTargets.length === 0,
          onClick: wrapWithClickTracking('delete', async () => {
            const names = activeTargets.map((t) => t.entry.name).join('", "');
            if (!window.confirm(`确定要删除 "${names}" 吗？`)) return;
            const parentSources = new Set<FileSource>();
            for (const t of activeTargets) {
              try {
                await deleteEntry(t.parentSource, t.entry.name, t.entry.kind);
                parentSources.add(t.parentSource);
              } catch (err) {
                alert(`删除 "${t.entry.name}" 失败: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
            for (const ps of parentSources) {
              notifyChange(ps);
            }
      dispatch(refreshGitStatus());
      dispatch(refreshGitSliceStatus());
      dispatch(refreshGitSliceStatus());
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
  }, [contextMenu, rootSource, startCreate, startRename, handleFindInFiles, handlePaste, notifyChange, selectedEntries, wrapWithClickTracking]);

  const stableOnOpenFile = useCallback((entry: FileEntry) => {
    dispatch(closeDiffView());
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

  const renderRootInlineInput = useCallback(() => {
    if (!rootSource || !pendingCreate || !isSameSource(pendingCreate.parentSource, rootSource)) return null;
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
          placeholder={pendingCreate.type === 'file' ? '请输入文件名' : '请输入文件夹名'}
          onConfirm={(name) => handleCreateConfirm(rootSource, pendingCreate.type, name)}
          onCancel={handleCreateCancel}
        />
      </div>
    );
  }, [pendingCreate, rootSource, handleCreateConfirm, handleCreateCancel]);

  return (
    <div className="folder-tree" onContextMenu={handleBlankContextMenu}>
      {/* 空状态 */}
      {!rootSource && (
        <div className="side-panel__actions">
          <div className="explorer-empty">
            <p className="explorer-empty__text">尚未打开文件夹</p>
            <div className="explorer-empty__btns">
              <button className="explorer-empty__btn" onClick={handleOpenFolder}>
                <FolderOpenIcon size={14} strokeWidth={1.5} />
                打开文件夹
              </button>
              <button className="explorer-empty__btn" onClick={() => dispatch(setShowCloneForm(true))}>
                <Download size={14} strokeWidth={1.5} />
                克隆仓库
              </button>
            </div>
          </div>
        </div>
      )}

      {rootSource && (
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
              <span className="explorer-section__title">打开的编辑器</span>
            </div>
            {openEditorsExpanded && (
              <div className="explorer-section__content" style={{ maxHeight: OPEN_EDITORS_MAX_HEIGHT }}>
                {openedFiles.length === 0 && (
                  <div className="explorer-open-editor explorer-open-editor--empty">
                    没有打开的编辑器
                  </div>
                )}
                {openedFiles.map((file) => {
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
            <div className="explorer-section explorer-section--main">
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
                    title="新建文件"
                    onClick={(e) => { e.stopPropagation(); startCreate(rootSource, 'file'); }}
                  >
                    <FilePlus size={14} strokeWidth={1.5} />
                  </button>
                  <button
                    className="explorer-header__icon"
                    title="新建文件夹"
                    onClick={(e) => { e.stopPropagation(); startCreate(rootSource, 'folder'); }}
                  >
                    <FolderPlus size={14} strokeWidth={1.5} />
                  </button>
                  <button
                    className="explorer-header__icon"
                    title="刷新"
                    onClick={(e) => { e.stopPropagation(); dispatch(refreshDirectory(rootSource)); }}
                  >
                    <RefreshCw size={14} strokeWidth={1.5} />
                  </button>
                  <button
                    className="explorer-header__icon"
                    title="折叠所有"
                    onClick={(e) => { e.stopPropagation(); dispatch(clearExpandPaths()); }}
                  >
                    <ChevronsDownUp size={14} strokeWidth={1.5} />
                  </button>
                </span>
              </div>
              {projectExpanded && (
                <div className="explorer-section__content">
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
                      lastOperation={lastOperation}
                      clipboardItems={clipboardState?.items}
                      selectedEntries={selectedEntries.map((s) => s.entry)}
                      onItemSelect={handleItemSelect}
                      gitStatus={gitStatus}
                      expandPaths={expandPaths}
                      expandedDirs={expandedDirs}
                      onToggleExpand={stableOnToggleExpand}
                    />
                  ))}
                  {renderRootInlineInput()}
                </div>
              )}
            </div>
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
                <span className="explorer-section__title">时间线</span>
              </div>
              {timelineExpanded && (
                <div className="explorer-section__content" style={{ height: heights.timeline }}>
                  <div className="explorer-timeline--empty">时间线功能即将推出</div>
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
