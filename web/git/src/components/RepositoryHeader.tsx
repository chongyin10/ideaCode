import { useState, useEffect, useRef } from 'react';
import { GitBranch, ChevronDown, Plus } from 'lucide-react';
import type { GitStatus } from '../types';
import { useGitStore } from '../store/gitStore';
import { sendRpc } from '../api';

interface Props {
  status: GitStatus;
  rootPath: string;
  onCheckout: (name: string) => void;
  onCreateBranch: (name: string) => void;
}

export default function RepositoryHeader({ status, rootPath, onCheckout, onCreateBranch }: Props) {
  const branches = useGitStore((s) => s.branches);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
        setNewName('');
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const currentBranch = branches.find((b) => b.current) || branches.find((b) => b.name === status.branch);
  const displayName = currentBranch?.name || status.branch || '(no branch)';

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    onCreateBranch(name);
    setCreating(false);
    setNewName('');
    setOpen(false);
  };

  return (
    <div className="git-repo-header" ref={ref}>
      <div className="git-repo-header__row">
        <span className="git-repo-header__name" title={rootPath}>
          {rootPath.split(/[\\/]/).filter(Boolean).pop() || rootPath}
        </span>
        <button className="git-branch-btn" onClick={() => setOpen((v) => !v)} title="切换分支">
          <GitBranch size={12} />
          <span>{displayName}</span>
          {(status.ahead > 0 || status.behind > 0) && (
            <span className="git-branch-btn__ab">
              {status.ahead > 0 && <span className="ahead">↑{status.ahead}</span>}
              {status.behind > 0 && <span className="behind">↓{status.behind}</span>}
            </span>
          )}
          <ChevronDown size={12} className={open ? 'git-rotated' : ''} />
        </button>
      </div>

      {open && (
        <div className="git-branch-popover">
          <div className="git-branch-popover__header">
            <span>分支</span>
            <button
              className="git-icon-btn"
              title="新建分支"
              onClick={() => {
                setCreating(true);
                sendRpc('getBranches').catch(() => {});
              }}
            >
              <Plus size={12} />
            </button>
          </div>

          {creating && (
            <div className="git-branch-popover__create">
              <input
                autoFocus
                placeholder="新分支名"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate();
                  if (e.key === 'Escape') {
                    setCreating(false);
                    setNewName('');
                  }
                }}
              />
            </div>
          )}

          <div className="git-branch-popover__list">
            {branches.filter((b) => !b.isRemote).length === 0 && (
              <div className="git-branch-popover__empty">暂无分支</div>
            )}
            {branches
              .filter((b) => !b.isRemote)
              .map((b) => (
                <button
                  key={b.name}
                  className={`git-branch-item ${b.current ? 'current' : ''}`}
                  onClick={() => {
                    if (!b.current) {
                      onCheckout(b.name);
                      setOpen(false);
                    }
                  }}
                >
                  <GitBranch size={12} />
                  <span className="git-branch-item__name">{b.name}</span>
                  {b.current && <span className="git-branch-item__badge">当前</span>}
                  {b.ahead > 0 && <span className="git-branch-item__ab ahead">↑{b.ahead}</span>}
                  {b.behind > 0 && <span className="git-branch-item__ab behind">↓{b.behind}</span>}
                </button>
              ))}
          </div>

          {branches.some((b) => b.isRemote) && (
            <>
              <div className="git-branch-popover__header" style={{ marginTop: 8 }}>
                <span>远程分支</span>
              </div>
              <div className="git-branch-popover__list">
                {branches
                  .filter((b) => b.isRemote)
                  .map((b) => (
                    <button
                      key={b.name}
                      className="git-branch-item"
                      onClick={() => {
                        const localName = b.name.includes('/') ? b.name.split('/').slice(1).join('/') : b.name;
                        onCheckout(localName);
                        setOpen(false);
                      }}
                    >
                      <GitBranch size={12} />
                      <span className="git-branch-item__name">{b.name}</span>
                    </button>
                  ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}