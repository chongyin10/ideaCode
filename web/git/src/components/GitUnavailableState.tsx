import { AlertCircle } from 'lucide-react';

export default function GitUnavailableState() {
  return (
    <div className="git-empty">
      <div className="git-empty__icon" style={{ color: '#f48771' }}>
        <AlertCircle size={36} strokeWidth={1} />
      </div>
      <h2 className="git-empty__title">Git 不可用</h2>
      <p className="git-empty__desc">
        未检测到 <code>git</code> 命令行工具。请安装 Git 并确保它在系统 PATH 中可用。
      </p>
      <p className="git-empty__desc">
        下载地址：<a href="https://git-scm.com/downloads" target="_blank" rel="noreferrer">git-scm.com/downloads</a>
      </p>
    </div>
  );
}