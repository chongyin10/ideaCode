import { useState } from 'react';
import { ChevronRight, Plus, Minus, Undo2, FileText, Trash2 } from 'lucide-react';
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
  actions?: SectionAction[];
  onStage?: (paths: string[]) => void;
  onUnstage?: (paths: string[]) => void;
  onDiscard?: (paths: string[]) => void;
  onDelete?: (paths: string[]) => void;
  onOpen?: (path: string) => void;
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
  actions = [],
  onStage,
  onUnstage,
  onDiscard,
  onDelete,
  onOpen,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);

  const handleStageAll = () => {
    onStage?.(items.map((i) => i.path));
  };
  const handleUnstageAll = () => {
    onUnstage?.(items.map((i) => i.path));
  };
  const handleDiscardAll = () => {
    onDiscard?.(items.map((i) => i.path));
  };
  const handleDeleteAll = () => {
    onDelete?.(items.map((i) => i.path));
  };

  const isEmpty = items.length === 0;

  return (
    <div className={`git-section ${isEmpty ? 'git-section--empty' : ''} ${open && !isEmpty ? 'git-section--expanded' : ''}`}>
      <div className="git-section__header" onClick={() => collapsible && !isEmpty && setOpen((v) => !v)}>
        {collapsible && (
          <ChevronRight size={12} className={open && !isEmpty ? 'git-rotated' : ''} />
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
                disabled={a.disabled}
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
          {items.map((item) => (
            <div
              key={item.path}
              className={`git-item git-item--${statusBadge(item.workingStatus !== ' ' ? item.workingStatus : item.indexStatus)}`}
              onClick={() => onOpen?.(item.path)}
              title={item.path}
            >
              <span className="git-item__status">
                {statusLabel(item.workingStatus !== ' ' ? item.workingStatus : item.indexStatus)}
              </span>
              <span className="git-item__name">{item.path.split('/').pop()}</span>
              <span className="git-item__path">{item.path}</span>
              <span className="git-item__actions" onClick={(e) => e.stopPropagation()}>
                {kind === 'changes' && (
                  <>
                    {onStage && (
                      <button className="git-icon-btn" title="暂存" onClick={() => onStage([item.path])}>
                        <Plus size={12} />
                      </button>
                    )}
                    {onDiscard && (
                      <button className="git-icon-btn" title="放弃" onClick={() => onDiscard([item.path])}>
                        <Undo2 size={12} />
                      </button>
                    )}
                  </>
                )}
                {kind === 'staged' && (
                  <>
                    {onUnstage && (
                      <button className="git-icon-btn" title="取消暂存" onClick={() => onUnstage([item.path])}>
                        <Minus size={12} />
                      </button>
                    )}
                  </>
                )}
                {kind === 'untracked' && (
                  <>
                    {onStage && (
                      <button className="git-icon-btn" title="暂存" onClick={() => onStage([item.path])}>
                        <Plus size={12} />
                      </button>
                    )}
                    {onDelete && (
                      <button className="git-icon-btn" title="删除" onClick={() => onDelete([item.path])}>
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
          ))}
        </div>
      )}
      {open && isEmpty && <div className="git-section__empty">{emptyText}</div>}
    </div>
  );
}