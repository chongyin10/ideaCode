import { GitBranch, FolderOpen, Loader2 } from 'lucide-react';
import EmptyState from './EmptyState';

interface Props {
  rootPath: string;
  onInit: () => void;
  onOpenRepo: () => void;
  busy?: boolean;
}

export default function InitState({ rootPath, onInit, onOpenRepo, busy }: Props) {
  const folderName = rootPath.split(/[\\/]/).filter(Boolean).pop() || rootPath;
  return (
    <div className="git-empty">
      <div className="git-empty__icon">
        <GitBranch size={36} strokeWidth={1} />
      </div>
      <h2 className="git-empty__title">{folderName}</h2>
      <p className="git-empty__desc">当前文件夹不是 Git 仓库。你可以初始化一个新仓库，或打开其他文件夹。</p>
      <div className="git-empty__actions">
        <button className="git-btn git-btn--primary" onClick={onInit} disabled={busy}>
          {busy ? <Loader2 size={14} className="git-spin" /> : <GitBranch size={14} />}
          <span>初始化仓库</span>
        </button>
        <button className="git-btn" onClick={onOpenRepo} disabled={busy}>
          <FolderOpen size={14} />
          <span>打开其他文件夹</span>
        </button>
      </div>
    </div>
  );
}