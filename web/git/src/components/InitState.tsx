import { useState } from 'react';
import { GitBranch, FolderOpen, Loader2, Link2 } from 'lucide-react';

interface Props {
  rootPath: string;
  onInit: () => void;
  onOpenRepo: () => void;
  /** 关联远程仓库地址（git init + remote add origin + fetch） */
  onAssociateRemote: (url: string) => void;
  busy?: boolean;
}

export default function InitState({ rootPath, onInit, onOpenRepo, onAssociateRemote, busy }: Props) {
  const folderName = rootPath.split(/[\\/]/).filter(Boolean).pop() || rootPath;
  const [mode, setMode] = useState<'actions' | 'associate'>('actions');
  const [url, setUrl] = useState('');

  const submitAssociate = () => {
    const trimmed = url.trim();
    if (!trimmed || busy) return;
    onAssociateRemote(trimmed);
    setUrl('');
    setMode('actions');
  };

  if (mode === 'associate') {
    return (
      <div className="git-empty">
        <div className="git-empty__icon">
          <Link2 size={36} strokeWidth={1} />
        </div>
        <h2 className="git-empty__title">关联远程仓库</h2>
        <p className="git-empty__desc">
          输入远程仓库地址，将当前项目初始化并关联到该远程（git init + remote add origin + fetch）。
        </p>
        <div className="git-empty__associate">
          <input
            className="git-empty__input"
            type="text"
            placeholder="https://github.com/user/repo.git"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitAssociate();
              if (e.key === 'Escape') setMode('actions');
            }}
            autoFocus
            disabled={busy}
          />
          <div className="git-empty__actions">
            <button
              className="git-btn git-btn--primary"
              onClick={submitAssociate}
              disabled={busy || !url.trim()}
            >
              {busy ? <Loader2 size={14} className="git-spin" /> : <Link2 size={14} />}
              <span>关联</span>
            </button>
            <button className="git-btn" onClick={() => setMode('actions')} disabled={busy}>
              <span>取消</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="git-empty">
      <div className="git-empty__icon">
        <GitBranch size={36} strokeWidth={1} />
      </div>
      <h2 className="git-empty__title">{folderName}</h2>
      <p className="git-empty__desc">
        当前文件夹不是 Git 仓库。你可以初始化一个新仓库、关联到远程仓库，或打开其他文件夹。
      </p>
      <div className="git-empty__actions">
        <button className="git-btn git-btn--primary" onClick={onInit} disabled={busy}>
          {busy ? <Loader2 size={14} className="git-spin" /> : <GitBranch size={14} />}
          <span>初始化仓库</span>
        </button>
        <button className="git-btn" onClick={() => setMode('associate')} disabled={busy}>
          <Link2 size={14} />
          <span>关联远程仓库</span>
        </button>
        <button className="git-btn" onClick={onOpenRepo} disabled={busy}>
          <FolderOpen size={14} />
          <span>打开其他文件夹</span>
        </button>
      </div>
    </div>
  );
}
