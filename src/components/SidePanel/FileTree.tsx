import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { ChevronRight, FileText } from 'lucide-react';
import type { FileEntry, FileSource, FileClipboardItem } from '../../services/fileService';
import { isSameSource } from '../../services/fileService';
import InlineInput from '../InlineInput';

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
}: FileTreeProps) => {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[]>([]);

  // 由当前节点自行判断是否匹配 pending 状态
  const myPendingCreateType =
    pendingCreate && entry.kind === 'directory' && isSameSource(entry.source, pendingCreate.parentSource)
      ? pendingCreate.type
      : undefined;

  const myIsRenaming =
    pendingRename && isSameSource(entry.source, pendingRename.entry.source);

  // 当有 pendingCreateType 且是目录时，自动展开并加载子节点
  useEffect(() => {
    if (myPendingCreateType && entry.kind === 'directory' && !expanded) {
      setExpanded(true);
      if (children.length === 0) {
        import('../../services/fileService').then(({ readDirectory }) => {
          readDirectory(entry.source).then(setChildren).catch(() => {});
        });
      }
    }
  }, [myPendingCreateType, entry.kind, entry.source, expanded, children.length]);

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

  const isActive = activeSource ? isSameSource(entry.source, activeSource) : false;
  const isSelected = selectedEntries?.some((e) => isSameSource(e.source, entry.source)) ?? false;
  const isCut = clipboardItems?.some(
    (item) => item.action === 'cut' && isSameSource(entry.source, item.source)
  ) ?? false;

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
        const nextExpanded = !expanded;
        setExpanded(nextExpanded);
        if (nextExpanded && children.length === 0) {
          const { readDirectory } = await import('../../services/fileService');
          const vals = await readDirectory(entry.source);
          setChildren(vals);
        }
      } else {
        onOpenFile(entry);
      }
    },
    [entry, parentSource, expanded, children.length, onOpenFile, onItemSelect]
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

  return (
    <div onContextMenu={handleContextMenu} data-name={entry.name}>
      <div
        className={`tree-item ${isActive ? 'active' : ''} ${isSelected ? 'selected' : ''} ${isCut ? 'is-cut' : ''}`}
        style={{ paddingLeft: 12 + level * 12 }}
        onClick={handleClick}
      >
        <span className={`tree-item__chevron ${expanded ? 'expanded' : ''}`}>
          {entry.kind === 'directory' ? (
            <ChevronRight size={14} strokeWidth={1.5} />
          ) : (
            <span className="tree-item__indent" />
          )}
        </span>
        <span className="tree-item__icon">
          {entry.kind === 'directory' ? (
            <MemoFolderIcon expanded={expanded} />
          ) : (
            <StaticFileIcon />
          )}
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
          entry.name
        )}
      </div>

      {expanded && myPendingCreateType && (
        <div
          className="tree-item inline-create-item"
          style={{ paddingLeft: 12 + (level + 1) * 12 }}
        >
          <span className="tree-item__indent" />
          <span className="tree-item__icon">
            {myPendingCreateType === 'file' ? <StaticFileIcon /> : <StaticClosedFolderIcon />}
          </span>
          <InlineInput
            placeholder={myPendingCreateType === 'file' ? '请输入文件名' : '请输入文件夹名'}
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
          />
        ))}
    </div>
  );
});

FileTree.displayName = 'FileTree';

/* ─── 静态图标组件（避免每次渲染创建新的 JSX 对象） ─── */

const StaticFileIcon = memo(() => (
  <FileText size={14} strokeWidth={1.5} />
));
StaticFileIcon.displayName = 'StaticFileIcon';

const StaticClosedFolderIcon = memo(() => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
  </svg>
));
StaticClosedFolderIcon.displayName = 'StaticClosedFolderIcon';

/** 文件夹图标：闭合为文件夹，展开为打开的文件夹 */
const FolderIcon = ({ expanded }: { expanded: boolean }) => {
  return expanded ? (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
      <path d="M2 10h20" />
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
    </svg>
  );
};

const MemoFolderIcon = memo(FolderIcon);
MemoFolderIcon.displayName = 'MemoFolderIcon';

export default FileTree;
