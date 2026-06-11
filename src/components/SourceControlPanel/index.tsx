import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Plus, Minus, Check, RefreshCw, GitBranch, GitPullRequest,
  ChevronRight, Download, Loader2, Ellipsis, Undo2, FileText,
} from 'lucide-react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { openFile, openDiffView } from '../../store/slices/workspaceSlice';
import { gitService } from '../../services/gitService';
import { readFile } from '../../services/fileService';
import {
  refreshGitStatus,
  refreshBranch,
  stageFiles,
  unstageFiles,
  commit,
  pullBranch,
  pushBranch,
  discardFile,
  clearGitError,
  setShowCloneForm,
  initRepo,
} from '../../store/slices/gitSlice';
import './SourceControlPanel.css';

function statusClass(s: string): string { return `scm-${s.toLowerCase()}`; }

const SourceControlPanel = () => {
  const dispatch = useAppDispatch();
  const rootSource = useAppSelector((s) => s.workspace.rootSource);
  const rootPath = typeof rootSource === 'string' ? rootSource : null;
  const { staged, changes, merge, untracked, branch, loading, error, stashes } = useAppSelector((s) => s.git);

  const [commitMsg, setCommitMsg] = useState('');
  const [stagedOpen, setStagedOpen] = useState(true);
  const [changesOpen, setChangesOpen] = useState(true);
  const [mergeOpen, setMergeOpen] = useState(true);
  const [untrackedOpen, setUntrackedOpen] = useState(true);
  const [stashOpen, setStashOpen] = useState(false);

  useEffect(() => {
    if (rootPath) {
      dispatch(refreshGitStatus());
      dispatch(refreshBranch());
    }
  }, [dispatch, rootPath]);

  const stagedEntries = useMemo(() => Object.entries(staged).map(([p, c]) => ({ path: p, code: c })), [staged]);
  const changesEntries = useMemo(() => Object.entries(changes).map(([p, c]) => ({ path: p, code: c })), [changes]);
  const mergeEntries = useMemo(() => Object.entries(merge).map(([p, c]) => ({ path: p, code: c })), [merge]);
  const untrackedEntries = useMemo(() => Object.entries(untracked).map(([p, c]) => ({ path: p, code: c })), [untracked]);

  const handleStage = useCallback((f: string) => dispatch(stageFiles([f])), [dispatch]);
  const handleStageAllChanges = useCallback(() => {
    const files = changesEntries.map(e => e.path);
    if (files.length) dispatch(stageFiles(files));
  }, [dispatch, changesEntries]);
  const handleUnstage = useCallback((f: string) => dispatch(unstageFiles([f])), [dispatch]);
  const handleUnstageAll = useCallback(() => {
    const files = stagedEntries.map(e => e.path);
    if (files.length) dispatch(unstageFiles(files));
  }, [dispatch, stagedEntries]);
  const handleCommit = useCallback(() => {
    if (!commitMsg.trim()) return;
    dispatch(commit(commitMsg));
    setCommitMsg('');
  }, [dispatch, commitMsg]);
  const handleOpenFile = useCallback(async (filePath: string) => {
    if (!rootPath) return;
    const base = rootPath.replace(/\/$/, '');
    const file = filePath.replace(/^\//, '');
    const fullPath = `${base}/${file}`;
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const langMap: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', css: 'css', html: 'html', json: 'json', md: 'markdown', py: 'python' };
    const language = langMap[ext] || 'plaintext';

    try {
      // 获取 HEAD 版本（可能为空：新文件或 git 不可用）
      const [original, modified] = await Promise.all([
        gitService.getOriginalContent(rootPath, filePath).catch(() => ''),
        readFile(fullPath).catch(() => ''),
      ]);

      dispatch(openDiffView({
        filePath,
        fileName: filePath.split('/').pop() || filePath,
        original: original || '',
        modified: modified || '',
        language,
      }));
    } catch {
      // 所有操作都失败时回退到普通打开
      dispatch(openFile({ name: filePath, kind: 'file', source: fullPath }));
    }
  }, [dispatch, rootPath]);
  const handleDiscard = useCallback((file: string) => {
    if (window.confirm(`确定要丢弃 "${file}" 的更改吗？`)) dispatch(discardFile(file));
  }, [dispatch]);
  /** 打开文件到编辑器（正常模式，非 diff） */
  const handleOpenFileNormal = useCallback((filePath: string) => {
    if (!rootPath) return;
    const base = rootPath.replace(/\/$/, '');
    const file = filePath.replace(/^\//, '');
    dispatch(openFile({ name: filePath, kind: 'file', source: `${base}/${file}` }));
  }, [dispatch, rootPath]);
  const handleInit = useCallback(() => dispatch(initRepo()), [dispatch]);

  /** 渲染一个可折叠的文件分组 */
  const renderSection = useCallback(
    (
      title: string,
      entries: { path: string; code: string }[],
      open: boolean,
      setOpen: (v: boolean) => void,
      headerAction: 'plus' | 'undo' | 'alert' | 'none',
      headerBtns: { label: string; icon: React.FC<{ size: number; strokeWidth: number }>; handler: () => void }[],
      itemBtns: { icon: React.FC<{ size: number; strokeWidth: number }>; handler: (path: string) => void; title: string }[],
    ) => (
      <div className="scm-section">
        <div className="scm-section__header" onClick={() => setOpen(!open)}>
          <ChevronRight size={12} strokeWidth={1.5} className={open ? 'scm-rotated' : ''} />
          <span className="scm-section__title">{title}</span>
          <span className="scm-section__badge">{entries.length}</span>
          <span className="scm-section__actions">
            {headerBtns.map((b, i) => (
              <button key={i} onClick={(e) => { e.stopPropagation(); b.handler(); }} title={b.label}>
                <b.icon size={12} strokeWidth={1.5} />
              </button>
            ))}
          </span>
        </div>
        {open && entries.map(({ path, code }) => (
          <div key={path} className={`scm-item ${statusClass(code)}`} title={path} onClick={() => handleOpenFile(path)}>
            <span className="scm-item__status">{code}</span>
            <span className="scm-item__name">{path.split('/').pop()}</span>
            <span className="scm-item__path">{path}</span>
            <span className="scm-item__actions">
              {itemBtns.map((b, i) => (
                <button key={i} onClick={(e) => { e.stopPropagation(); b.handler(path); }} title={b.title}>
                  <b.icon size={13} strokeWidth={1.5} />
                </button>
              ))}
            </span>
          </div>
        ))}
        {open && entries.length === 0 && (
          <div className="scm-item scm-item--empty">没有{title}</div>
        )}
      </div>
    ), [handleOpenFile]
  );

  // ─── 无文件夹打开 ───
  if (!rootPath) {
    return (
      <div className="scm-panel scm-setup">
        <div className="scm-setup__hero">
          <GitBranch size={36} strokeWidth={1} className="scm-setup__hero-icon" />
          <h2>源代码管理</h2>
          <p>克隆仓库或打开文件夹以开始</p>
          <button className="scm-btn scm-btn--primary" onClick={() => dispatch(setShowCloneForm(true))}>
            <Download size={14} /> 克隆仓库
          </button>
        </div>
      </div>
    );
  }

  // ─── 非 Git 仓库 ───
  if (!branch) {
    return (
      <div className="scm-panel scm-setup">
        <div className="scm-setup__hero">
          <GitBranch size={36} strokeWidth={1} className="scm-setup__hero-icon" />
          <h2>初始化 Git 仓库</h2>
          <p>当前文件夹尚未初始化 Git</p>
          <button className="scm-btn scm-btn--primary" onClick={handleInit} disabled={loading}>
            {loading ? <Loader2 size={14} className="scm-spin" /> : <GitBranch size={14} />} 初始化仓库
          </button>
        </div>
      </div>
    );
  }

  // ─── 正常视图 ───
  return (
    <div className="scm-panel">
      {error && <div className="scm-error" onClick={() => dispatch(clearGitError())}>{error}</div>}

      {/* ── 头部：提交区 ── */}
      <div className="scm-header">
        <div className="scm-header__input-row">
          <input
            className="scm-header__input"
            placeholder="输入提交信息（Ctrl+Enter）"
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleCommit(); } }}
          />
          <button className="scm-header__commit" onClick={handleCommit} disabled={!commitMsg.trim()} title="提交 (Ctrl+Enter)">
            <Check size={16} strokeWidth={1.5} />
          </button>
        </div>

        {/* ── 头部：图标工具栏 ── */}
        <div className="scm-header__tools">
          <button className="scm-icon-btn" onClick={() => { dispatch(refreshGitStatus()); dispatch(refreshBranch()); }} title="刷新">
            <RefreshCw size={15} strokeWidth={1.5} className={loading ? 'scm-spin' : ''} />
          </button>
          <button className="scm-icon-btn" onClick={handleStageAllChanges} title="暂存所有更改">
            <Plus size={15} strokeWidth={1.5} />
          </button>
          <button className="scm-icon-btn" onClick={() => dispatch(pullBranch())} title="拉取">
            <GitPullRequest size={15} strokeWidth={1.5} />
          </button>
          <button className="scm-icon-btn" onClick={() => dispatch(pushBranch())} title="推送">
            <GitBranch size={15} strokeWidth={1.5} />
          </button>
          <span className="scm-header__spacer" />
          <button className="scm-icon-btn" onClick={() => dispatch(initRepo())} title="撤销所有更改">
            <Ellipsis size={15} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      {/* ── 暂存的更改 ── */}
      {renderSection('暂存的更改', stagedEntries, stagedOpen, setStagedOpen, 'undo', [
        { label: '全部取消暂存', icon: Minus, handler: handleUnstageAll },
      ], [
        { icon: Minus, handler: handleUnstage, title: '取消暂存' },
        { icon: FileText, handler: handleOpenFileNormal, title: '打开文件' },
      ])}

      {/* ── 更改 ── */}
      {renderSection('更改', changesEntries, changesOpen, setChangesOpen, 'plus', [
        { label: '全部暂存', icon: Plus, handler: handleStageAllChanges },
      ], [
        { icon: Plus, handler: handleStage, title: '暂存' },
        { icon: Undo2, handler: handleDiscard, title: '丢弃更改' },
        { icon: FileText, handler: handleOpenFileNormal, title: '打开文件' },
      ])}

      {/* ── 合并更改 ── */}
      {renderSection('合并更改', mergeEntries, mergeOpen, setMergeOpen, 'alert', [], [
        { icon: FileText, handler: handleOpenFileNormal, title: '打开文件' },
      ])}

      {/* ── 未跟踪的文件 ── */}
      {renderSection('未跟踪的文件', untrackedEntries, untrackedOpen, setUntrackedOpen, 'plus', [
        { label: '全部暂存', icon: Plus, handler: () => {
          const files = untrackedEntries.map(e => e.path);
          if (files.length) dispatch(stageFiles(files));
        }},
      ], [
        { icon: Plus, handler: handleStage, title: '暂存' },
        { icon: FileText, handler: handleOpenFileNormal, title: '打开文件' },
      ])}

      {/* ── Stash ── */}
      {stashes.length > 0 && (
        <div className="scm-section">
          <div className="scm-section__header" onClick={() => setStashOpen(!stashOpen)}>
            <ChevronRight size={12} strokeWidth={1.5} className={stashOpen ? 'scm-rotated' : ''} />
            <span className="scm-section__title">储藏</span>
            <span className="scm-section__badge">{stashes.length}</span>
          </div>
          {stashOpen && stashes.map((s, i) => <div key={i} className="scm-item scm-item--stash">{s}</div>)}
        </div>
      )}

    </div>
  );
};

export default SourceControlPanel;
