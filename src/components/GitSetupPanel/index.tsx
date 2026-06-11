import { useState, useCallback, useEffect } from 'react';
import { Check, Loader2, FolderOpen } from 'lucide-react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { loadDirectory } from '../../store/slices/workspaceSlice';
import { cloneRepo, initRepo } from '../../store/slices/gitSlice';
import { openDirectory } from '../../services/fileService';
import './GitSetupPanel.css';

const GitSetupPanel = () => {
  const dispatch = useAppDispatch();
  const rootSource = useAppSelector((s) => s.workspace.rootSource);
  const rootPath = typeof rootSource === 'string' ? rootSource : null;
  const loading = useAppSelector((s) => s.git.loading);
  const error = useAppSelector((s) => s.git.error);
  const cloneProgress = useAppSelector((s) => s.git.cloneProgress);
  const clonePercent = useAppSelector((s) => s.git.clonePercent);
  const [eta, setEta] = useState<number | null>(null);

  // 监听 ETA 消息
  useEffect(() => {
    if (cloneProgress.startsWith('eta:')) {
      setEta(parseInt(cloneProgress.slice(4), 10) || null);
    }
  }, [cloneProgress]);

  const [repoUrl, setRepoUrl] = useState('');
  const [clonePath, setClonePath] = useState('');

  const platformHint = (() => {
    if (!repoUrl) return '';
    if (repoUrl.includes('github.com')) return '检测到 GitHub 仓库';
    if (repoUrl.includes('gitlab')) return '检测到 GitLab 仓库';
    if (repoUrl.includes('gitee.com')) return '检测到 Gitee 仓库';
    return '';
  })();

  const handleClone = useCallback(() => {
    if (!repoUrl.trim() || !clonePath.trim()) return;
    dispatch(cloneRepo({ url: repoUrl.trim(), targetPath: clonePath.trim() }));
  }, [dispatch, repoUrl, clonePath]);

  const handleInit = useCallback(() => {
    dispatch(initRepo());
  }, [dispatch]);

  const handleOpenFolder = useCallback(async () => {
    const dir = await openDirectory();
    if (dir) {
      dispatch(loadDirectory({ source: dir.source, name: dir.name }));
    }
  }, [dispatch]);

  if (rootPath) {
    return (
      <div className="gitsetup">
        <div className="gitsetup-hero">
          <h2>初始化 Git 仓库</h2>
          <p>当前文件夹尚未初始化 Git 版本控制</p>
          <button className="gitsetup-btn gitsetup-btn--primary" onClick={handleInit} disabled={loading}>
            {loading ? <Loader2 size={16} className="gitsetup-spin" /> : <span>初始化仓库</span>}
          </button>
          {error && <p className="gitsetup-error">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="gitsetup">
      {loading ? (
        <div className="gitsetup-progress">
          <h2>{clonePercent > 0 ? `正在克隆... ${clonePercent}%` : '正在克隆仓库...'}</h2>
          <div className="gitsetup-progress__bar">
            <div className="gitsetup-progress__fill" style={{ width: `${Math.max(clonePercent, 3)}%` }} />
          </div>
          {eta !== null && <span className="gitsetup-progress__eta">预计剩余 {eta} 秒</span>}
          {cloneProgress && (
            <pre className="gitsetup-progress__log">{cloneProgress}</pre>
          )}
        </div>
      ) : (
        <div className="gitsetup-form">
          <h2>克隆 Git 仓库</h2>
          <p>输入仓库地址和本地目标路径</p>
          <div className="gitsetup-field">
            <label>仓库 URL</label>
            <input
              type="text"
              placeholder="https://github.com/user/repo.git"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              autoFocus
            />
            {platformHint && <span className="gitsetup-hint">{platformHint}</span>}
          </div>
          <div className="gitsetup-field">
            <label>本地目标路径</label>
            <button
              className="gitsetup-path-selector"
              onClick={async () => {
                const dir = await openDirectory();
                if (dir && typeof dir.source === 'string') {
                  setClonePath(dir.source);
                }
              }}
            >
              {clonePath || '点击选择本地文件夹'}
            </button>
          </div>
          <div className="gitsetup-form__actions">
            <button
              className="gitsetup-btn gitsetup-btn--primary"
              onClick={handleClone}
              disabled={loading || !repoUrl.trim() || !clonePath.trim()}
            >
              {loading ? <Loader2 size={16} className="gitsetup-spin" /> : <Check size={16} />}
              克隆
            </button>
            <button className="gitsetup-btn" onClick={handleOpenFolder}>
              <FolderOpen size={16} /> 打开本地文件夹
            </button>
          </div>
          {error && <p className="gitsetup-error">{error}</p>}
        </div>
      )}
    </div>
  );
};

export default GitSetupPanel;
