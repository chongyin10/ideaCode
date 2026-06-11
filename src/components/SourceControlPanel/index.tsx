import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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

/* ─── #9 赫布排序: 共暂存频率追踪 ─── */

const HEBBIAN_KEY = 'ideacode_scm_hebbian';
const HEBBIAN_DECAY = 0.95;

function loadHebbian(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(HEBBIAN_KEY) || '{}'); } catch { return {}; }
}
function saveHebbian(m: Record<string, number>) {
  try { localStorage.setItem(HEBBIAN_KEY, JSON.stringify(m)); } catch { /* ignore */ }
}
function boostHebbian(path: string) {
  const m = loadHebbian();
  for (const k of Object.keys(m)) m[k] *= HEBBIAN_DECAY;
  m[path] = (m[path] || 0) + 0.15;
  saveHebbian(m);
}
function sortByHebbian(entries: { path: string; code: string }[]): { path: string; code: string }[] {
  if (entries.length < 2) return entries;
  const weights = loadHebbian();
  return [...entries].sort((a, b) => (weights[b.path] || 0) - (weights[a.path] || 0));
}

/* ─── #6 贝叶斯语言推断 ─── */

const LANG_BASE: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript',
  mjs: 'javascript', cjs: 'javascript',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  html: 'html', htm: 'html', json: 'json',
  md: 'markdown', mdx: 'markdown',
  py: 'python', java: 'java', class: 'java',
  rs: 'rust', go: 'go', rb: 'ruby', php: 'php',
  xml: 'xml', yml: 'yaml', yaml: 'yaml', toml: 'ini',
  sql: 'sql', sh: 'shell', bash: 'shell', zsh: 'shell',
  graphql: 'graphql', gql: 'graphql',
};

function inferLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return LANG_BASE[ext] || 'plaintext';
}

/* ─── 组件 ─── */

const SourceControlPanel = () => {
  const dispatch = useAppDispatch();

  // #11 选择性注意力: 细粒度 selector，避免全量订阅
  const rootPath = useAppSelector((s) => {
    const r = s.workspace.rootSource;
    return typeof r === 'string' ? r : null;
  });
  const staged = useAppSelector((s) => s.git.staged);
  const changes = useAppSelector((s) => s.git.changes);
  const merge = useAppSelector((s) => s.git.merge);
  const untracked = useAppSelector((s) => s.git.untracked);
  const branch = useAppSelector((s) => s.git.branch);
  const loading = useAppSelector((s) => s.git.loading);
  const error = useAppSelector((s) => s.git.error);
  const stashes = useAppSelector((s) => s.git.stashes);

  const [commitMsg, setCommitMsg] = useState('');
  const [stagedOpen, setStagedOpen] = useState(true);
  const [changesOpen, setChangesOpen] = useState(true);
  const [mergeOpen, setMergeOpen] = useState(true);
  const [untrackedOpen, setUntrackedOpen] = useState(true);
  const [stashOpen, setStashOpen] = useState(false);

  // #7 自适应轮询: 空闲期指数退避
  const idleRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const scheduleNext = () => {
      const base = 3000;
      const max = 120000;
      const delay = Math.min(base * Math.pow(2, idleRef.current), max);
      timerRef.current = setTimeout(() => {
        if (rootPath) {
          dispatch(refreshGitStatus());
          dispatch(refreshBranch());
        }
        idleRef.current++;
        scheduleNext();
      }, delay);
    };
    if (rootPath) {
      idleRef.current = 0;
      dispatch(refreshGitStatus());
      dispatch(refreshBranch());
      scheduleNext();
    }
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [dispatch, rootPath]);

  /** 重置空闲计数器（操作后立即刷新） */
  const resetPolling = useCallback(() => {
    idleRef.current = 0;
    if (timerRef.current) clearTimeout(timerRef.current);
    dispatch(refreshGitStatus());
    dispatch(refreshBranch());
  }, [dispatch]);

  // #9 赫布排序应用于条目
  const stagedEntries = useMemo(() => sortByHebbian(
    Object.entries(staged).map(([p, c]) => ({ path: p, code: c }))
  ), [staged]);
  const changesEntries = useMemo(() => sortByHebbian(
    Object.entries(changes).map(([p, c]) => ({ path: p, code: c }))
  ), [changes]);
  const mergeEntries = useMemo(() =>
    Object.entries(merge).map(([p, c]) => ({ path: p, code: c })), [merge]);
  const untrackedEntries = useMemo(() =>
    Object.entries(untracked).map(([p, c]) => ({ path: p, code: c })), [untracked]);

  const handleStage = useCallback((f: string) => {
    boostHebbian(f);
    dispatch(stageFiles([f])).then(() => resetPolling());
  }, [dispatch, resetPolling]);
  const handleStageAllChanges = useCallback(() => {
    const files = changesEntries.map(e => e.path);
    if (files.length) {
      files.forEach(boostHebbian);
      dispatch(stageFiles(files)).then(() => resetPolling());
    }
  }, [dispatch, changesEntries, resetPolling]);
  const handleUnstage = useCallback((f: string) => {
    dispatch(unstageFiles([f])).then(() => resetPolling());
  }, [dispatch, resetPolling]);
  const handleUnstageAll = useCallback(() => {
    const files = stagedEntries.map(e => e.path);
    if (files.length) dispatch(unstageFiles(files)).then(() => resetPolling());
  }, [dispatch, stagedEntries, resetPolling]);
  const handleCommit = useCallback(() => {
    if (!commitMsg.trim()) return;
    dispatch(commit(commitMsg)).then(() => resetPolling());
    setCommitMsg('');
  }, [dispatch, commitMsg, resetPolling]);
  const handleOpenFile = useCallback(async (filePath: string) => {
    if (!rootPath) return;
    const base = rootPath.replace(/\/$/, '');
    const file = filePath.replace(/^\//, '');
    const fullPath = `${base}/${file}`;
    const language = inferLanguage(filePath);

    try {
      const [original, modified] = await Promise.all([
        gitService.getOriginalContent(rootPath, filePath).catch(() => ''),
        readFile(fullPath).catch(() => ''),
      ]);
      dispatch(openDiffView({
        filePath, fileName: filePath.split('/').pop() || filePath,
        original: original || '', modified: modified || '', language,
      }));
    } catch {
      dispatch(openFile({ name: filePath, kind: 'file', source: fullPath }));
    }
  }, [dispatch, rootPath]);
  const handleDiscard = useCallback((file: string) => {
    if (window.confirm(`确定要丢弃 "${file}" 的更改吗？`)) {
      dispatch(discardFile(file)).then(() => resetPolling());
    }
  }, [dispatch, resetPolling]);
  const handleOpenFileNormal = useCallback((filePath: string) => {
    if (!rootPath) return;
    const base = rootPath.replace(/\/$/, '');
    const file = filePath.replace(/^\//, '');
    dispatch(openFile({ name: filePath, kind: 'file', source: `${base}/${file}` }));
  }, [dispatch, rootPath]);
  const handleInit = useCallback(() => dispatch(initRepo()), [dispatch]);

  /** 渲染文件分组 */
  const renderSection = useCallback(
    (title: string, entries: { path: string; code: string }[], open: boolean,
     setOpen: (v: boolean) => void, _hAction: string,
     headerBtns: { label: string; icon: React.FC<{ size: number; strokeWidth: number }>; handler: () => void }[],
     itemBtns: { icon: React.FC<{ size: number; strokeWidth: number }>; handler: (p: string) => void; title: string }[]) => (
      <div className="scm-section">
        <div className="scm-section__header" onClick={() => setOpen(!open)}>
          <ChevronRight size={12} strokeWidth={1.5} className={open ? 'scm-rotated' : ''} />
          <span className="scm-section__title">{title}</span>
          <span className="scm-section__badge">{entries.length}</span>
          <span className="scm-section__actions">
            {headerBtns.map((b, i) => (
              <button key={i} onClick={e => { e.stopPropagation(); b.handler(); }} title={b.label}>
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
                <button key={i} onClick={e => { e.stopPropagation(); b.handler(path); }} title={b.title}>
                  <b.icon size={13} strokeWidth={1.5} />
                </button>
              ))}
            </span>
          </div>
        ))}
        {open && entries.length === 0 && <div className="scm-item scm-item--empty">没有{title}</div>}
      </div>
    ), [handleOpenFile]
  );

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

  return (
    <div className="scm-panel">
      {error && <div className="scm-error" onClick={() => dispatch(clearGitError())}>{error}</div>}

      <div className="scm-header">
        <div className="scm-header__input-row">
          <input className="scm-header__input" placeholder="输入提交信息（Ctrl+Enter）"
            value={commitMsg} onChange={e => setCommitMsg(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleCommit(); } }}
          />
          <button className="scm-header__commit" onClick={handleCommit} disabled={!commitMsg.trim()} title="提交 (Ctrl+Enter)">
            <Check size={16} strokeWidth={1.5} />
          </button>
        </div>
        <div className="scm-header__tools">
          <button className="scm-icon-btn" onClick={resetPolling} title="刷新">
            <RefreshCw size={15} strokeWidth={1.5} className={loading ? 'scm-spin' : ''} />
          </button>
          <button className="scm-icon-btn" onClick={handleStageAllChanges} title="暂存所有更改">
            <Plus size={15} strokeWidth={1.5} />
          </button>
          <button className="scm-icon-btn" onClick={() => dispatch(pullBranch()).then(resetPolling)} title="拉取">
            <GitPullRequest size={15} strokeWidth={1.5} />
          </button>
          <button className="scm-icon-btn" onClick={() => dispatch(pushBranch()).then(resetPolling)} title="推送">
            <GitBranch size={15} strokeWidth={1.5} />
          </button>
          <span className="scm-header__spacer" />
          <button className="scm-icon-btn" onClick={() => dispatch(initRepo())} title="更多">
            <Ellipsis size={15} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      {renderSection('暂存的更改', stagedEntries, stagedOpen, setStagedOpen, 'undo', [
        { label: '全部取消暂存', icon: Minus, handler: handleUnstageAll },
      ], [
        { icon: Minus, handler: handleUnstage, title: '取消暂存' },
        { icon: FileText, handler: handleOpenFileNormal, title: '打开文件' },
      ])}
      {renderSection('更改', changesEntries, changesOpen, setChangesOpen, 'plus', [
        { label: '全部暂存', icon: Plus, handler: handleStageAllChanges },
      ], [
        { icon: Plus, handler: handleStage, title: '暂存' },
        { icon: Undo2, handler: handleDiscard, title: '丢弃更改' },
        { icon: FileText, handler: handleOpenFileNormal, title: '打开文件' },
      ])}
      {renderSection('合并更改', mergeEntries, mergeOpen, setMergeOpen, 'alert', [], [
        { icon: FileText, handler: handleOpenFileNormal, title: '打开文件' },
      ])}
      {renderSection('未跟踪的文件', untrackedEntries, untrackedOpen, setUntrackedOpen, 'plus', [
        { label: '全部暂存', icon: Plus, handler: () => {
          const files = untrackedEntries.map(e => e.path);
          if (files.length) dispatch(stageFiles(files));
        }},
      ], [
        { icon: Plus, handler: handleStage, title: '暂存' },
        { icon: FileText, handler: handleOpenFileNormal, title: '打开文件' },
      ])}

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
