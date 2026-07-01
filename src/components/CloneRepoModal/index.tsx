import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, FolderOpen, Download, AlertCircle, Loader2 } from 'lucide-react';
import { useAppDispatch } from '../../store/hooks';
import { loadDirectory } from '../../store/slices/workspaceSlice';
import { openDirectory } from '../../services/fileService';
import './CloneRepoModal.css';

interface CloneRepoModalProps {
  onClose: () => void;
}

function repoNameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const base = pathname.split('/').filter(Boolean).pop() || '';
    return base.replace(/\.git$/i, '') || 'repository';
  } catch {
    return 'repository';
  }
}

export default function CloneRepoModal({ onClose }: CloneRepoModalProps) {
  const dispatch = useAppDispatch();
  const [url, setUrl] = useState('');
  const [parentPath, setParentPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string>('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handlePickParent = useCallback(async () => {
    const dir = await openDirectory();
    if (dir) setParentPath(typeof dir.source === 'string' ? dir.source : dir.name);
  }, []);

  const handleClone = useCallback(async () => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setError('请输入仓库地址');
      return;
    }
    if (!parentPath) {
      setError('请选择本地存放目录');
      return;
    }

    const repoName = repoNameFromUrl(trimmedUrl);
    const targetPath = parentPath.replace(/[/\\]+$/, '') + '/' + repoName;

    setLoading(true);
    setError(null);
    setProgress('开始克隆...');

    try {
      const result = await window.electronAPI!.git!.clone(trimmedUrl, targetPath);
      if (!result.success) {
        throw new Error(result.error || '克隆失败');
      }
      dispatch(loadDirectory({ source: targetPath, name: repoName }));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProgress('');
    } finally {
      setLoading(false);
    }
  }, [url, parentPath, dispatch, onClose]);

  const canClone = !!url.trim() && !!parentPath && !loading;

  return createPortal(
    <div
      className="clone-repo-modal__overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="clone-repo-modal">
        <div className="clone-repo-modal__header">
          <h3 className="clone-repo-modal__title">克隆 Git 仓库</h3>
          <button className="clone-repo-modal__close" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="clone-repo-modal__body">
          <div className="clone-repo-modal__field">
            <label className="clone-repo-modal__label">仓库地址</label>
            <input
              ref={inputRef}
              className="clone-repo-modal__input"
              type="text"
              placeholder="https://github.com/user/repo.git"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={loading}
            />
          </div>

          <div className="clone-repo-modal__field">
            <label className="clone-repo-modal__label">本地目录</label>
            <div className="clone-repo-modal__input-row">
              <input
                className="clone-repo-modal__input"
                type="text"
                placeholder="选择存放目录..."
                value={parentPath}
                onChange={(e) => setParentPath(e.target.value)}
                disabled={loading}
              />
              <button
                className="clone-repo-modal__icon-btn"
                onClick={handlePickParent}
                disabled={loading}
                title="选择目录"
              >
                <FolderOpen size={16} />
              </button>
            </div>
            {url.trim() && parentPath && (
              <p className="clone-repo-modal__hint">
                将克隆到：{parentPath.replace(/[/\\]+$/, '')}/{repoNameFromUrl(url.trim())}
              </p>
            )}
          </div>

          {error && (
            <div className="clone-repo-modal__error">
              <AlertCircle size={14} />
              <span>{error}</span>
            </div>
          )}
          {progress && !error && (
            <div className="clone-repo-modal__progress">
              <Loader2 size={14} className="clone-repo-modal__spinner" />
              <span>{progress}</span>
            </div>
          )}
        </div>

        <div className="clone-repo-modal__footer">
          <button className="clone-repo-modal__btn" onClick={onClose} disabled={loading}>
            取消
          </button>
          <button
            className="clone-repo-modal__btn clone-repo-modal__btn--primary"
            onClick={handleClone}
            disabled={!canClone}
          >
            <Download size={14} />
            {loading ? '克隆中...' : '克隆'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
