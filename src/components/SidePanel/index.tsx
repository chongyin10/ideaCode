import { useState, useCallback } from 'react';
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
} from '../../store/slices/workspaceSlice';
import { switchPanel } from '../../store/slices/layoutSlice';
import type { PanelId } from '../../store/slices/layoutSlice';
import { openDirectory } from '../../services/fileService';
import type { FileEntry, FileSource } from '../../services/fileService';
import {
  isPath,
  isElectron,
  isSameSource,
  exists,
  createFile,
  createDirectory,
  deleteEntry,
  renameEntry,
  copyEntry,
  generateCopyName,
  revealInExplorer,
  getFileClipboard,
  setFileClipboard,
} from '../../services/fileService';
import FileTree, { type PendingCreate, type PendingRename, type LastOperation } from './FileTree';
import SearchPanel from '../SearchPanel';
import ExtensionsPanel from '../ExtensionsPanel';
import ContextMenu, { type MenuItem } from '../ContextMenu';
import InlineInput from '../InlineInput';
import { getMenuManager } from '../../plugin/menuManager';
import type { MenuContribution } from '../../plugin/menuManager';
import './SidePanel.css';

const panelTitles: Record<PanelId, string> = {
  explorer: '资源管理器',
  search: '搜索',
  git: '源代码管理',
  debug: '运行和调试',
  extensions: '扩展',
};

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  targetEntry: FileEntry | null;
  targetParentSource: FileSource | null;
}

/* ────────────────────────────────────────────── */
/*  ExplorerContent                               */
/* ────────────────────────────────────────────── */

const ExplorerContent = () => {
  const dispatch = useAppDispatch();

  // 选择性订阅 Redux：只订阅需要的字段，避免整个 workspace 变化导致重渲染
  const rootSource = useAppSelector((state) => state.workspace.rootSource);
  const rootName = useAppSelector((state) => state.workspace.rootName);
  const entries = useAppSelector((state) => state.workspace.entries);
  const activeFileSource = useAppSelector((state) => state.workspace.activeFileSource);

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
  const [clipboardItem, setClipboardItem] = useState<FileClipboardItem | null>(null);

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

  // ─── 粘贴操作（含同名冲突处理）───

  const handlePaste = useCallback(async (destSource: FileSource) => {
    const item = getFileClipboard();
    if (!item) return;

    const nameConflict = await exists(destSource, item.name);

    if (nameConflict) {
      const choice = window.confirm(
        `"${item.name}" 已存在，是否创建副本？`
      );

      if (!choice) return;
      // 确定 → 自动序列命名
      const newName = await generateCopyName(destSource, item.name, item.kind);
      await copyEntry(item.parentSource, item.name, destSource, newName);
    } else {
      await copyEntry(item.parentSource, item.name, destSource, item.name);
    }

    if (item.action === 'cut') {
      await deleteEntry(item.parentSource, item.name, item.kind);
      setFileClipboard(null);
    }

    if (item.action === 'cut') {
      notifyChange(destSource, item.parentSource);
    } else {
      notifyChange(destSource);
    }
    setClipboardItem(null);
    if (rootSource && isSameSource(destSource, rootSource)) {
      dispatch(refreshDirectory(destSource));
    }
  }, [rootSource, dispatch, notifyChange]);

  // ─── 菜单构建 ───

  const buildMenuItems = useCallback((): MenuItem[] => {
    if (!rootSource) return [];
    const { targetEntry, targetParentSource } = contextMenu;
    const clipboard = getFileClipboard();

    // targetParentSource 在有 targetEntry 时不应为 null，但类型上可能为 null
    const safeParentSource = targetParentSource || rootSource;

    const createTargetSource =
      targetEntry?.kind === 'directory'
        ? targetEntry.source
        : targetEntry
        ? safeParentSource
        : rootSource;

    const canPasteHere = clipboard !== null && (!targetEntry || targetEntry.kind === 'directory');
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
        onClick: () => startCreate(createTargetSource, 'file'),
      },
      {
        id: 'new-folder',
        label: '新建文件夹',
        icon: <FolderPlus size={14} strokeWidth={1.5} />,
        group: '1_new',
        order: 2,
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
          disabled: !isElectron(),
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
          onClick: () => handleFindInFiles(targetEntry.name),
        },
        {
          id: 'cut',
          label: '剪切',
          icon: <Scissors size={14} strokeWidth={1.5} />,
          group: '3_edit',
          order: 5,
          onClick: () => {
            const item = {
              source: targetEntry.source,
              name: targetEntry.name,
              kind: targetEntry.kind,
              parentSource: safeParentSource,
              action: 'cut' as const,
            };
            setFileClipboard(item);
            setClipboardItem(item);
          },
        },
        {
          id: 'copy',
          label: '复制',
          icon: <Copy size={14} strokeWidth={1.5} />,
          group: '3_edit',
          order: 6,
          onClick: () => {
            setFileClipboard({
              source: targetEntry.source,
              name: targetEntry.name,
              kind: targetEntry.kind,
              parentSource: safeParentSource,
              action: 'copy',
            });
            setClipboardItem(null);
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
          disabled: !isPath(targetEntry.source),
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
          disabled: !isPath(targetEntry.source) || !isPath(rootSource),
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
          onClick: () => startRename(targetEntry, safeParentSource),
        },
        {
          id: 'delete',
          label: '删除',
          icon: <Trash2 size={14} strokeWidth={1.5} />,
          group: '5_file',
          order: 11,
          onClick: async () => {
            if (!window.confirm(`确定要删除 "${targetEntry.name}" 吗？`)) return;
            try {
              await deleteEntry(safeParentSource, targetEntry.name, targetEntry.kind);
              notifyChange(safeParentSource);
            } catch (err) {
              alert(`删除失败: ${err instanceof Error ? err.message : String(err)}`);
            }
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
  }, [contextMenu, rootSource, startCreate, startRename, handleFindInFiles, handlePaste, notifyChange]);

  // 稳定回调引用（传递给 FileTree 的 props）
  const stableOnOpenFile = useCallback((entry: FileEntry) => {
    dispatch(openFile(entry));
  }, [dispatch]);

  const stableOnContextMenu = useCallback(
    (e: React.MouseEvent, entry: FileEntry, parentSource: FileSource) => {
      openContextMenu(e, entry, parentSource);
    },
    [openContextMenu]
  );

  // 根目录新建的内联输入框
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
          clipboardItem={clipboardItem}
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

function contributionToMenuItem(c: MenuContribution): MenuItem {
  return {
    id: c.id,
    label: c.label,
    icon: c.icon,
    shortcut: c.shortcut,
    disabled: c.disabled,
    group: c.group,
    order: c.order,
    children: c.children?.map(contributionToMenuItem),
    command: c.command,
    onClick: c.onClick,
  };
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

const SidePanel = () => {
  const { sidePanelVisible, activePanel } = useAppSelector((state) => state.layout);

  return (
    <div className={`side-panel ${sidePanelVisible ? 'is-visible' : ''}`}>
      <div className="side-panel__header">
        {activePanel ? panelTitles[activePanel] : '面板'}
      </div>
      <div className="side-panel__content">
        {/* 所有面板同时存在，通过 CSS display 切换可见性。
           这样可以保留各面板的组件状态（如搜索内容、展开目录等），
           避免切换面板时组件卸载导致的状态丢失。 */}
        <div style={{ display: activePanel === 'explorer' ? 'block' : 'none', height: '100%' }}>
          <ExplorerContent />
        </div>
        <div style={{ display: activePanel === 'search' ? 'block' : 'none', height: '100%' }}>
          <SearchPanel />
        </div>
        <div style={{ display: activePanel === 'git' ? 'block' : 'none', height: '100%' }}>
          <div className="panel-placeholder">源代码管理</div>
        </div>
        <div style={{ display: activePanel === 'debug' ? 'block' : 'none', height: '100%' }}>
          <div className="panel-placeholder">运行和调试</div>
        </div>
        <div style={{ display: activePanel === 'extensions' ? 'block' : 'none', height: '100%' }}>
          <ExtensionsPanel />
        </div>
        <div style={{ display: activePanel ? 'none' : 'block', height: '100%' }}>
          <div className="panel-placeholder">选择一个视图</div>
        </div>
      </div>
    </div>
  );
};

export default SidePanel;
