import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import type { FileEntry, FileSource } from '../../services/fileService';
import type { GitStatusMap, GitStatusCode } from '../../types/electron';
import { isSameSource } from '../../services/fileService';
import type { FileClipboardItem } from '../../services/fileClipboard';
import InlineInput from '../InlineInput';
import { FileIcon, ClosedFolderIcon, DefaultFileIcon } from './FileTree.icons';

/* ─── 拖拽移动：模块级状态（跨递归 FileTree 节点共享） ─── */
interface DragState {
  entry: FileEntry;
  parentSource: FileSource;
}
let currentDrag: DragState | null = null;

export interface PendingCreate {
  parentSource: FileSource;
  type: 'file' | 'folder';
}

export interface PendingRename {
  entry: FileEntry;
  parentSource: FileSource;
}

export interface LastOperation {
  targets: FileSource[];
  timestamp: number;
}

interface FileTreeProps {
  entry: FileEntry;
  level: number;
  activeSource: FileSource | null;
  onOpenFile: (entry: FileEntry) => void;
  parentSource: FileSource;
  rootSource: FileSource;
  onFindInFiles?: (name: string) => void;
  onContextMenu?: (e: React.MouseEvent, entry: FileEntry, parentSource: FileSource) => void;
  /** 全局内联新建状态 */
  pendingCreate?: PendingCreate | null;
  onCreateConfirm?: (parentSource: FileSource, type: 'file' | 'folder', name: string) => void;
  onCreateCancel?: () => void;
  /** 全局内联重命名状态 */
  pendingRename?: PendingRename | null;
  onRenameConfirm?: (parentSource: FileSource, oldName: string, newName: string, kind: 'file' | 'directory') => void;
  onRenameCancel?: () => void;
  /** 最近一次文件操作，用于触发目录刷新 */
  lastOperation?: LastOperation | null;
  /** 当前剪贴板内容，用于显示剪切状态 */
  clipboardItems?: FileClipboardItem[];
  /** 多选中的条目 */
  selectedEntries?: FileEntry[];
  /** 点击选中/多选回调 */
  onItemSelect?: (entry: FileEntry, parentSource: FileSource, isMultiSelect: boolean) => void;
  /** Git 文件状态映射 */
  gitStatus?: GitStatusMap;
  /** 相对于 Git 仓库根目录的路径前缀（递归传递） */
  relativePath?: string;
  /** 需要自动展开的目录路径链 */
  expandPaths?: string[];
  /** 用户手动展开的目录路径集合（持久化展开状态） */
  expandedDirs?: string[];
  /** 展开/折叠目录的回调 */
  onToggleExpand?: (path: string, expand: boolean) => void;
  /** 拖拽移动文件/文件夹 */
  onMoveFile?: (
    dragEntry: FileEntry,
    dragParentSource: FileSource,
    dropEntry: FileEntry | null,
    dropParentSource: FileSource,
  ) => void;
  /** 根节点右侧自定义工具按钮（仅在 level=0 时生效） */
  headerTools?: React.ReactNode;
  /** 根节点额外 className（仅在 level=0 时生效） */
  rootClassName?: string;
  /** 根节点左侧起始缩进（默认 12px），用于远程根与区域标题对齐 */
  rootIndentOffset?: number;
}

/**
 * 文件树递归组件
 *
 * 性能优化要点：
 * 1. React.memo: 阻止父组件无关重渲染导致的整树重渲染
 * 2. useCallback: 稳定内部回调引用，配合 memo 生效
 * 3. 静态图标组件: 避免每次渲染创建新的 JSX 对象
 */
const FileTree = memo(({
  entry,
  level,
  activeSource,
  onOpenFile,
  parentSource,
  rootSource,
  onFindInFiles,
  onContextMenu,
  pendingCreate,
  onCreateConfirm,
  onCreateCancel,
  pendingRename,
  onRenameConfirm,
  onRenameCancel,
  lastOperation,
  clipboardItems,
  selectedEntries,
  onItemSelect,
  gitStatus,
  relativePath,
  expandPaths,
  expandedDirs,
  onToggleExpand,
  onMoveFile,
  headerTools,
  rootClassName,
  rootIndentOffset,
}: FileTreeProps) => {
  const { t } = useTranslation();
  const [children, setChildren] = useState<FileEntry[]>([]);

  // ── 拖拽高亮状态 ──
  const [isDragOver, setIsDragOver] = useState(false);
  const onMoveFileRef = useRef(onMoveFile);
  onMoveFileRef.current = onMoveFile;

  const baseIndent = rootIndentOffset ?? 12;

  // 计算当前 entry 的相对路径（用于 Git 状态查询 + 自动展开匹配）
  const entryRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

  // 展开状态由外部 expandedDirs 控制
  const expanded = expandedDirs?.includes(entryRelPath) ?? false;

  // 享元模式：缓存展开/折叠状态下的图标 JSX 对象
  // 避免每次渲染都创建新的 JSX 对象
  const iconElement = useMemo(() => (
    <FileIcon name={entry.name} kind={entry.kind} expanded={expanded} />
  ), [entry.name, entry.kind, expanded]);

  // 享元：缓存缩进引导线 JSX（大目录下节省大量对象分配）
  const indentGuides = useMemo(() => {
    if (level <= 0) return null;
    return (
      <div className="tree-indent-guides" style={{ left: 0, width: baseIndent + level * 12 + 6 }}>
        {Array.from({ length: level }).map((_, i) => (
          <span
            key={i}
            className="tree-indent-guide"
            style={{ left: baseIndent + i * 12 + 5 }}
          />
        ))}
      </div>
    );
  }, [level, baseIndent]);

  // 用 ref 存储最新 expanded 值，避免 useCallback 闭包捕获过期值
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  // 由当前节点自行判断是否匹配 pending 状态
  const myPendingCreateType =
    pendingCreate && entry.kind === 'directory' && isSameSource(entry.source, pendingCreate.parentSource)
      ? pendingCreate.type
      : undefined;

  const myIsRenaming =
    pendingRename && isSameSource(entry.source, pendingRename.entry.source);

  // 当有 pendingCreateType 且是目录时，自动展开
  const onToggleExpandRef = useRef(onToggleExpand);
  onToggleExpandRef.current = onToggleExpand;
  useEffect(() => {
    if (myPendingCreateType && entry.kind === 'directory' && !expanded) {
      onToggleExpandRef.current?.(entryRelPath, true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myPendingCreateType, entry.kind, entry.source, expanded]);

  // 新建/重命名/删除/粘贴等操作完成后，如果本目录是目标目录，自动刷新
  const lastOpRef = useRef(lastOperation);
  useEffect(() => {
    const prevOp = lastOpRef.current;
    lastOpRef.current = lastOperation;

    if (!lastOperation || entry.kind !== 'directory') return;
    if (prevOp && prevOp.timestamp === lastOperation.timestamp) return;

    if (lastOperation.targets.some((t) => isSameSource(entry.source, t))) {
      if (expanded) {
        refreshChildren();
      } else {
        setChildren([]); // 折叠状态：清空缓存，展开时重新加载
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastOperation]);

  // 新建/重命名输入框消失后自动刷新子节点列表
  const prevPendingRef = useRef(myPendingCreateType);
  const prevRenamingRef = useRef(myIsRenaming);
  useEffect(() => {
    const wasCreating = !!prevPendingRef.current;
    const wasRenaming = !!prevRenamingRef.current;
    prevPendingRef.current = myPendingCreateType;
    prevRenamingRef.current = myIsRenaming;

    if (entry.kind === 'directory' && expanded) {
      if (wasCreating && !myPendingCreateType) {
        refreshChildren();
      }
      if (wasRenaming && !myIsRenaming) {
        refreshChildren();
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myPendingCreateType, myIsRenaming]);

  // 当 expanded 变为 true 且 children 为空时，异步加载子节点
  useEffect(() => {
    if (entry.kind === 'directory' && expanded && children.length === 0) {
      import('../../services/fileService').then(({ readDirectory }) => {
        readDirectory(entry.source).then(setChildren).catch(() => {});
      });
    }
  }, [expanded, children.length, entry.kind, entry.source]);

  // 当 expandPaths 包含当前目录路径，或当前目录包含激活文件时，自动展开
  const autoExpandedRef = useRef(false);
  const activeFileExpandedRef = useRef(false);
  useEffect(() => {
    if (entry.kind !== 'directory') return;

    // QuickOpen 触发的展开 — expandPaths 变化时重置 ref 以确保优先展开
    if (expandPaths?.length && expandPaths.includes(entryRelPath) && !expanded) {
      autoExpandedRef.current = true;
      onToggleExpandRef.current?.(entryRelPath, true);
    }

    // 当前目录包含激活文件（Electron 环境下 source 为路径字符串）
    const containsActiveFile =
      typeof activeSource === 'string' &&
      typeof entry.source === 'string' &&
      activeSource.startsWith(entry.source + '/');
    if (containsActiveFile && !expanded && !activeFileExpandedRef.current) {
      activeFileExpandedRef.current = true;
      onToggleExpandRef.current?.(entryRelPath, true);
    }
  }, [expandPaths, activeSource, entryRelPath, entry.kind, entry.source, expanded]);

  const isActive = activeSource ? isSameSource(entry.source, activeSource) : false;
  const isSelected = selectedEntries?.some((e) => isSameSource(e.source, entry.source)) ?? false;
  const isCut = clipboardItems?.some(
    (item) => item.action === 'cut' && isSameSource(entry.source, item.source)
  ) ?? false;

  // 文件的 git 状态
  const gitCode: GitStatusCode | undefined = gitStatus?.[entryRelPath];

  // 目录的派生 git 状态：检查是否有任何子文件被 git 跟踪变更
  const dirGitCode: GitStatusCode | undefined = useMemo(() => {
    if (entry.kind !== 'directory' || !gitStatus) return undefined;
    const prefix = entryRelPath + '/';
    for (const key of Object.keys(gitStatus)) {
      if (key.startsWith(prefix)) {
        const code = gitStatus[key];
        // 优先级: M > U > A > D > R
        return code;
      }
    }
    return undefined;
  }, [entry.kind, entryRelPath, gitStatus]);

  // 实际生效的状态码（目录用派生值，文件用直接值）
  const activeGitCode = entry.kind === 'directory' ? dirGitCode : gitCode;

  const handleClick = useCallback(
    async (e: React.MouseEvent) => {
      const isMultiSelect = e.metaKey || e.ctrlKey;

      if (isMultiSelect) {
        e.preventDefault();
        e.stopPropagation();
        onItemSelect?.(entry, parentSource, true);
        return;
      }

      onItemSelect?.(entry, parentSource, false);

      if (entry.kind === 'directory') {
        // 手动折叠时标记为已操作，防止 containsActiveFile effect 立刻重新展开
        if (expandedRef.current) {
          activeFileExpandedRef.current = true;
        }
        onToggleExpand?.(entryRelPath, !expandedRef.current);
      } else {
        onOpenFile(entry);
      }
    },
    [entry, entryRelPath, parentSource, onOpenFile, onItemSelect, onToggleExpand]
  );

  const refreshChildren = useCallback(async () => {
    const { readDirectory } = await import('../../services/fileService');
    const vals = await readDirectory(entry.source);
    setChildren(vals);
  }, [entry.source]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onContextMenu?.(e, entry, parentSource);
    },
    [onContextMenu, entry, parentSource]
  );

  // ── 拖拽移动事件 ──
  const handleDragStart = useCallback((e: React.DragEvent) => {
    currentDrag = { entry, parentSource };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', entry.name);
  }, [entry, parentSource]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!currentDrag) return;
    // 不能拖到自己身上
    if (isSameSource(currentDrag.entry.source, entry.source)) return;
    // 文件夹不能拖到自己的子目录（路径前缀检测）
    if (
      currentDrag.entry.kind === 'directory' &&
      typeof entry.source === 'string' &&
      typeof currentDrag.entry.source === 'string' &&
      entry.source.startsWith(currentDrag.entry.source + '/')
    ) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setIsDragOver(true);
  }, [entry]);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!currentDrag) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    // 调用移动回调
    onMoveFileRef.current?.(currentDrag.entry, currentDrag.parentSource, entry, parentSource);
    currentDrag = null;
  }, [entry, parentSource]);

  const handleDragEnd = useCallback(() => {
    currentDrag = null;
    setIsDragOver(false);
  }, []);

  return (
    <div className="tree-row" onContextMenu={handleContextMenu} data-name={entry.name}>
      {/* 享元缩进引导线 */}
      {indentGuides}
      <div
        className={`tree-item ${isActive ? 'active' : ''} ${isSelected ? 'selected' : ''} ${isCut ? 'is-cut' : ''} ${isDragOver ? 'drag-over' : ''} ${level === 0 && rootClassName ? rootClassName : ''}`}
        style={{ paddingLeft: baseIndent + level * 12 }}
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onDragEnd={handleDragEnd}
        onClick={handleClick}
      >
        <span className={`tree-item__chevron ${expanded ? 'expanded' : ''}`} >
          {entry.kind === 'directory' ? (
            <ChevronRight size={12} strokeWidth={1.5} />
          ) : (
            <span className="tree-item__indent" />
          )}
        </span>
        <span className="tree-item__icon">
          {iconElement}
        </span>
        {myIsRenaming ? (
          <InlineInput
            defaultValue={entry.name}
            onConfirm={(name) =>
              onRenameConfirm?.(parentSource, entry.name, name, entry.kind)
            }
            onCancel={() => onRenameCancel?.()}
          />
        ) : (
          <span className={`tree-item__label ${activeGitCode ? 'git-' + activeGitCode.toLowerCase() : ''}`}>{entry.name}</span>
        )}
        {activeGitCode && (
          entry.kind === 'directory' ? (
            <span className="git-dot" title={t('explorer.git.containsChanges')} />
          ) : (
            <span className={`git-status ${activeGitCode}`}>{activeGitCode}</span>
          )
        )}
        {level === 0 && headerTools && (
          <span className="tree-item__tools" onClick={(e) => e.stopPropagation()}>
            {headerTools}
          </span>
        )}
      </div>

      {expanded && myPendingCreateType && (
        <div
          className="tree-item inline-create-item"
          style={{ paddingLeft: 12 + (level + 1) * 12 }}
        >
          <span className="tree-item__indent" />
          <span className="tree-item__icon">
            {myPendingCreateType === 'file' ? <DefaultFileIcon /> : <ClosedFolderIcon />}
          </span>
          <InlineInput
            placeholder={myPendingCreateType === 'file' ? t('explorer.inputPlaceholder.fileName') : t('explorer.inputPlaceholder.folderName')}
            onConfirm={(name) => onCreateConfirm?.(entry.source, myPendingCreateType, name)}
            onCancel={() => onCreateCancel?.()}
          />
        </div>
      )}

      {expanded &&
        children.map((child) => (
          <FileTree
            key={`${child.name}:${child.kind}`}
            entry={child}
            level={level + 1}
            activeSource={activeSource}
            onOpenFile={onOpenFile}
            parentSource={entry.source}
            rootSource={rootSource}
            rootIndentOffset={rootIndentOffset}
            onFindInFiles={onFindInFiles}
            onContextMenu={onContextMenu}
            pendingCreate={pendingCreate}
            onCreateConfirm={onCreateConfirm}
            onCreateCancel={onCreateCancel}
            pendingRename={pendingRename}
            onRenameConfirm={onRenameConfirm}
            onRenameCancel={onRenameCancel}
            lastOperation={lastOperation}
            clipboardItems={clipboardItems}
            selectedEntries={selectedEntries}
            onItemSelect={onItemSelect}
            gitStatus={gitStatus}
            relativePath={entryRelPath}
            expandPaths={expandPaths}
            expandedDirs={expandedDirs}
            onToggleExpand={onToggleExpand}
            onMoveFile={onMoveFile}
          />
        ))}
    </div>
  );
});

FileTree.displayName = 'FileTree';

/** 拖拽辅助：供 ExplorerContent 获取当前拖拽状态（拖到空白区域时） */
export function getCurrentDrag(): DragState | null {
  return currentDrag;
}
export function currentDragExists(): boolean {
  return currentDrag !== null;
}
export function clearCurrentDrag(): void {
  currentDrag = null;
}

export default FileTree;
