import { useEffect, useState } from 'react';
import { ChevronRight, Plus, Minus, Undo2, FileText, Trash2, Inbox, Folder } from 'lucide-react';
import type { GitChange } from '../types';

interface SectionAction {
  label: string;
  handler: () => void;
  disabled?: boolean;
}

interface Props {
  title: string;
  badge: number;
  items: GitChange[];
  kind: 'staged' | 'changes' | 'merge' | 'untracked';
  collapsible?: boolean;
  defaultOpen?: boolean;
  emptyText?: string;
  activeFile?: { path: string | null; staged: boolean | null };
  actions?: SectionAction[];
  onStage?: (paths: string[]) => void;
  onUnstage?: (paths: string[]) => void;
  onDiscard?: (paths: string[]) => void;
  onDelete?: (paths: string[]) => void;
  onOpen?: (path: string) => void;
  /** 未关联远程仓库时屏蔽所有改动操作（批量+单文件 stage/unstage/discard/delete），保留打开 */
  actionsDisabled?: boolean;
}

function statusBadge(code: string) {
  const map: Record<string, string> = {
    M: 'modified',
    A: 'added',
    D: 'deleted',
    R: 'renamed',
    C: 'copied',
    U: 'conflict',
    '?': 'untracked',
    ' ': ' ',
    untracked: 'untracked',
  };
  return map[code] || code.toLowerCase();
}

function statusLabel(code: string) {
  const map: Record<string, string> = {
    M: 'M',
    A: 'A',
    D: 'D',
    R: 'R',
    C: 'C',
    U: 'U',
    '?': 'U',
    ' ': '·',
    untracked: 'U',
  };
  return map[code] || code || '?';
}

export default function ChangesSection({
  title,
  badge,
  items,
  kind,
  collapsible = true,
  defaultOpen = true,
  emptyText = '空',
  activeFile = { path: null, staged: null },
  actions = [],
  onStage,
  onUnstage,
  onDiscard,
  onDelete,
  onOpen,
  actionsDisabled = false,
}: Props) {
  const isEmpty = items.length === 0;
  const [open, setOpen] = useState(isEmpty ? false : defaultOpen);
  const [optimisticActive, setOptimisticActive] = useState<{ path: string; staged: boolean } | null>(null);

  useEffect(() => {
    setOptimisticActive(null);
  }, [activeFile?.path, activeFile?.staged]);

  return (
    <div className={`git-section ${isEmpty ? 'git-section--empty' : ''} ${open ? 'git-section--expanded' : ''}`}>
      <div className="git-section__header" onClick={() => collapsible && setOpen((v) => !v)}>
        {collapsible && (
          <ChevronRight size={12} className={open ? 'git-rotated' : ''} />
        )}
        <span className="git-section__title">{title}</span>
        <span className="git-section__badge">{badge}</span>
        {!isEmpty && actions.length > 0 && (
          <span className="git-section__actions" onClick={(e) => e.stopPropagation()}>
            {actions.map((a, idx) => (
              <button
                key={idx}
                className="git-icon-btn"
                title={a.label}
                disabled={a.disabled || actionsDisabled}
                onClick={a.handler}
              >
                {a.label === '全部暂存' && <Plus size={12} />}
                {a.label === '全部取消暂存' && <Minus size={12} />}
                {(a.label === '全部放弃' || a.label === '放弃') && <Undo2 size={12} />}
                {(a.label === '全部删除' || a.label === '删除') && <Trash2 size={12} />}
                {!['全部暂存', '全部取消暂存', '全部放弃', '放弃', '全部删除', '删除'].includes(a.label) && <span>{a.label}</span>}
              </button>
            ))}
          </span>
        )}
      </div>

      {open && !isEmpty && (
        <div className="git-section__content">
          {items.map((item) => {
            // 聚合条目：第三方目录（node_modules/ 等）下大量文件已 stage/修改时，
            // 聚合成单条「目录/ (N 个文件)」，不可单文件操作（打开/diff/暂存/取消暂存）。
            if (item.aggregated) {
              const dirName = item.path.replace(/\/$/, '');
              return (
                <div
                  key={item.path}
                  className="git-item git-item--aggregated"
                  title={`${item.path}（${item.count} 个文件，位于默认忽略目录，已聚合显示）`}
                >
                  <span className="git-item__status">
                    <Folder size={12} />
                  </span>
                  <span className="git-item__name-row">
                    <span className="git-item__name">{dirName}</span>
                    <span className="git-item__aggregate-count">{item.count} 个文件</span>
                  </span>
                </div>
              );
            }
            const fileName = item.path.replace(/\/$/, '').split('/').pop() || item.path;
            const showPath = item.path !== fileName;
            return (
            <div
              key={item.path}
              className={`git-item git-item--${statusBadge(item.workingStatus !== ' ' ? item.workingStatus : item.indexStatus)} ${
                (activeFile?.path === item.path && activeFile?.staged === (kind === 'staged')) ||
                (optimisticActive?.path === item.path && optimisticActive?.staged === (kind === 'staged'))
                  ? 'git-item--active'
                  : ''
              }`}
              onClick={() => {
                setOptimisticActive({ path: item.path, staged: kind === 'staged' });
                onOpen?.(item.path);
              }}
              title={item.path}
            >
              <span className="git-item__status">
                {statusLabel(item.workingStatus !== ' ' ? item.workingStatus : item.indexStatus)}
              </span>
              <span className="git-item__name-row">
                <span className="git-item__name">{fileName}</span>
                {showPath && <span className="git-item__path">{item.path}</span>}
              </span>
              <span className="git-item__actions" onClick={(e) => e.stopPropagation()}>
                {kind === 'changes' && (
                  <>
                    {onStage && (
                      <button className="git-icon-btn" title="暂存" disabled={actionsDisabled} onClick={() => onStage([item.path])}>
                        <Plus size={12} />
                      </button>
                    )}
                    {onDiscard && (
                      <button className="git-icon-btn" title="放弃" disabled={actionsDisabled} onClick={() => onDiscard([item.path])}>
                        <Undo2 size={12} />
                      </button>
                    )}
                  </>
                )}
                {kind === 'staged' && (
                  <>
                    {onUnstage && (
                      <button className="git-icon-btn" title="取消暂存" disabled={actionsDisabled} onClick={() => onUnstage([item.path])}>
                        <Minus size={12} />
                      </button>
                    )}
                  </>
                )}
                {kind === 'untracked' && (
                  <>
                    {onStage && (
                      <button className="git-icon-btn" title="暂存" disabled={actionsDisabled} onClick={() => onStage([item.path])}>
                        <Plus size={12} />
                      </button>
                    )}
                    {onDelete && (
                      <button className="git-icon-btn" title="删除" disabled={actionsDisabled} onClick={() => onDelete([item.path])}>
                        <Trash2 size={12} />
                      </button>
                    )}
                  </>
                )}
                {onOpen && (
                  <button className="git-icon-btn" title="打开" onClick={() => onOpen(item.path)}>
                    <FileText size={12} />
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
      )}
      {open && isEmpty && (
        <div className="git-section__empty">
          <Inbox size={16} strokeWidth={1.5} />
          <span>{emptyText}</span>
        </div>
      )}
    </div>
  );
}