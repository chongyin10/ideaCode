import { useState, useCallback, useRef } from 'react';
import {
  FolderOpen,
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
} from 'lucide-react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import {
  loadDirectory,
  openFile,
  refreshDirectory,
  setPendingSearchQuery,
  refreshGitStatus,
} from '../../store/slices/workspaceSlice';
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
  const gitStatus = useAppSelector((state) => state.workspace.gitStatus);

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

  // ─── 菜单构建 ───

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
        onClick: () => startCreate(createTargetSource, 'file'),
      },
      {
        id: 'new-folder',
        label: '新建文件夹',
        icon: <FolderPlus size={14} strokeWidth={1.5} />,
        group: '1_new',
        order: 2,
        disabled: isMultiSelect,
        onClick: () => startCreate(createTargetSource, 'folder'),
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
          onClick: async () => {
            try {
              if (isPath(targetEntry.source)) {
                await revealInExplorer(targetEntry.source);
              }
            } catch (err) {
              alert(`打开失败: ${err instanceof Error ? err.message : String(err)}`);
            }
          },
        },
        {
          id: 'find-in-files',
          label: '在文件中查找',
          icon: <Search size={14} strokeWidth={1.5} />,
          group: '2_search',
          order: 4,
          disabled: isMultiSelect,
          onClick: () => handleFindInFiles(targetEntry.name),
        },
        {
          id: 'cut',
          label: '剪切',
          icon: <Scissors size={14} strokeWidth={1.5} />,
          group: '3_edit',
          order: 5,
          disabled: activeTargets.length === 0,
          onClick: () => {
            const items = activeTargets.map((s) => ({
              source: s.entry.source,
              name: s.entry.name,
              kind: s.entry.kind,
              parentSource: s.parentSource,
              action: 'cut' as const,
            }));
            setFileClipboard('cut', items);
            setClipboardState({ action: 'cut', items });
          },
        },
        {
          id: 'copy',
          label: '复制',
          icon: <Copy size={14} strokeWidth={1.5} />,
          group: '3_edit',
          order: 6,
          disabled: activeTargets.length === 0,
          onClick: () => {
            const items = activeTargets.map((s) => ({
              source: s.entry.source,
              name: s.entry.name,
              kind: s.entry.kind,
              parentSource: s.parentSource,
              action: 'copy' as const,
            }));
            setFileClipboard('copy', items);
            setClipboardState({ action: 'copy', items });
          },
        },
        {
          id: 'paste',
          label: '粘贴',
          icon: <ClipboardPaste size={14} strokeWidth={1.5} />,
          group: '3_edit',
          order: 7,
          disabled: !canPasteHere,
          onClick: () => handlePaste(pasteTargetSource),
        },
        {
          id: 'copy-path',
          label: '复制路径',
          icon: <Link size={14} strokeWidth={1.5} />,
          group: '4_path',
          order: 8,
          disabled: !isPath(targetEntry.source) || isMultiSelect,
          onClick: () => {
            if (isPath(targetEntry.source)) {
              navigator.clipboard.writeText(targetEntry.source).catch(() => {});
            }
          },
        },
        {
          id: 'copy-relative-path',
          label: '复制相对路径',
          icon: <Link size={14} strokeWidth={1.5} />,
          group: '4_path',
          order: 9,
          disabled: !isPath(targetEntry.source) || !isPath(rootSource) || isMultiSelect,
          onClick: () => {
            if (isPath(targetEntry.source) && isPath(rootSource)) {
              const rel = targetEntry.source.replace(rootSource + '/', '');
              navigator.clipboard.writeText(rel).catch(() => {});
            }
          },
        },
        {
          id: 'rename',
          label: '重命名',
          icon: <FileSignature size={14} strokeWidth={1.5} />,
          group: '5_file',
          order: 10,
          disabled: isMultiSelect,
          onClick: () => startRename(targetEntry, safeParentSource),
        },
        {
          id: 'delete',
          label: '删除',
          icon: <Trash2 size={14} strokeWidth={1.5} />,
          group: '5_file',
          order: 11,
          disabled: activeTargets.length === 0,
          onClick: async () => {
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
          },
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
        onClick: () => handlePaste(pasteTargetSource),
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

    items.sort((a, b) => {
      const ga = a.group || '';
      const gb = b.group || '';
      if (ga !== gb) return ga.localeCompare(gb);
      return (a.order ?? 0) - (b.order ?? 0);
    });

    return items;
  }, [contextMenu, rootSource, startCreate, startRename, handleFindInFiles, handlePaste, notifyChange, selectedEntries]);

  const stableOnOpenFile = useCallback((entry: FileEntry) => {
    dispatch(openFile(entry));
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
      <div className="side-panel__actions">
        {rootSource ? (
          <span className="folder-name">{rootName}</span>
        ) : (
          <button className="open-folder-btn" onClick={handleOpenFolder}>
            <FolderOpen size={14} strokeWidth={1.5} />
            打开文件夹
          </button>
        )}
      </div>
      {rootSource && entries.map((entry) => (
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
        />
      ))}
      {renderRootInlineInput()}
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
