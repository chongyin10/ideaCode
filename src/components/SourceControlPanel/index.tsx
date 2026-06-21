import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
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
  discardFiles,
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
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  html: 'html', htm: 'html', json: 'json',
  md: 'markdown', mdx: 'markdown',
  py: 'python', java: 'java', class: 'java',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp',
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
  const { t } = useTranslation();
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
  const contentRef = useRef<HTMLDivElement>(null);

  // #7 自适应轮询: 空闲期指数退避
  const idleRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const POLL_BASE = 3000;
  const POLL_MAX = 30000; // 最大轮询间隔从 120s 缩短到 30s，避免长期不更新

  const scheduleNext = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const delay = Math.min(POLL_BASE * Math.pow(2, idleRef.current), POLL_MAX);
    timerRef.current = setTimeout(() => {
      if (rootPath) {
        dispatch(refreshGitStatus());
        dispatch(refreshBranch());
      }
      idleRef.current++;
      scheduleNext();
    }, delay);
  }, [dispatch, rootPath]);

  /** 重置空闲计数器并立即刷新（操作/事件后调用） */
  const resetPolling = useCallback(() => {
    idleRef.current = 0;
    scheduleNext();
    if (rootPath) {
      dispatch(refreshGitStatus());
      dispatch(refreshBranch());
    }
  }, [dispatch, rootPath, scheduleNext]);

  useEffect(() => {
    if (!rootPath) return;
    resetPolling();
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [rootPath, resetPolling]);

  // 监听终端 git 命令 / .git 目录变更通知，自动刷新状态
  const gitChangeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.git?.onStatusChanged) return;
    return api.git.onStatusChanged(() => {
      if (!rootPath) return;
      // 立即刷新 + 延迟兜底刷新，覆盖命令执行中的状态
      resetPolling();
      if (gitChangeTimerRef.current) clearTimeout(gitChangeTimerRef.current);
      gitChangeTimerRef.current = setTimeout(() => {
        gitChangeTimerRef.current = null;
        resetPolling();
      }, 300);
    });
  }, [dispatch, rootPath, resetPolling]);

  // 监听 .git 目录文件变更，确保外部/终端命令完成后尽快同步
  useEffect(() => {
    if (!rootPath || !window.electronAPI?.fs?.watch) return;
    const gitDir = `${rootPath.replace(/\/$/, '')}/.git`;
    let mounted = true;
    window.electronAPI.fs.watch(gitDir)
      .then((result) => {
        if (!mounted && !result.alreadyWatching) {
          window.electronAPI?.fs?.unwatch(gitDir).catch(() => {});
        }
      })
      .catch(() => {});
    return () => {
      mounted = false;
      window.electronAPI?.fs?.unwatch(gitDir).catch(() => {});
    };
  }, [rootPath]);

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

  // ── 自动折叠/展开 ──
  // 没有数据 → 自动折叠（不展开内容）
  // 有数据   → 自动展开（显示内容）
  // 用户手动折叠后，若数据未变不会强制重新展开
  useEffect(() => {
    setStagedOpen(stagedEntries.length > 0);
  }, [stagedEntries.length]);
  useEffect(() => {
    setChangesOpen(changesEntries.length > 0);
  }, [changesEntries.length]);
  useEffect(() => {
    setMergeOpen(mergeEntries.length > 0);
  }, [mergeEntries.length]);
  useEffect(() => {
    setUntrackedOpen(untrackedEntries.length > 0);
  }, [untrackedEntries.length]);

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
    if (window.confirm(t('sourceControlPanel.confirm.discardFile', { file }))) {
      dispatch(discardFile(file)).then(() => resetPolling());
    }
  }, [dispatch, resetPolling, t]);
  const handleDiscardAllChanges = useCallback(() => {
    const files = changesEntries.map((e) => e.path);
    if (!files.length) return;
    if (window.confirm(t('sourceControlPanel.confirm.discardFiles', { count: files.length }))) {
      dispatch(discardFiles(files)).then(() => resetPolling());
    }
  }, [dispatch, changesEntries, resetPolling, t]);
  const handleDiscardAllMerge = useCallback(() => {
    const files = mergeEntries.map((e) => e.path);
    if (!files.length) return;
    if (window.confirm(t('sourceControlPanel.confirm.discardMergeFiles', { count: files.length }))) {
      dispatch(discardFiles(files)).then(() => resetPolling());
    }
  }, [dispatch, mergeEntries, resetPolling, t]);
  const handleDeleteAllUntracked = useCallback(async () => {
    const files = untrackedEntries.map((e) => e.path);
    if (!files.length || !rootPath) return;
    if (window.confirm(t('sourceControlPanel.confirm.deleteUntracked', { count: files.length }))) {
      const base = rootPath.replace(/\/$/, '');
      await Promise.all(files.map((f) => window.electronAPI?.fs?.delete(`${base}/${f}`)));
      resetPolling();
    }
  }, [rootPath, untrackedEntries, resetPolling, t]);
  const handleOpenFileNormal = useCallback((filePath: string) => {
    if (!rootPath) return;
    const base = rootPath.replace(/\/$/, '');
    const file = filePath.replace(/^\//, '');
    dispatch(openFile({ name: filePath, kind: 'file', source: `${base}/${file}` }));
  }, [dispatch, rootPath]);
  const handleInit = useCallback(() => dispatch(initRepo()), [dispatch]);

  /** 动态均分各展开分组的内容高度 */
  const computeHeights = useCallback(() => {
    const container = contentRef.current;
    if (!container) return;
    const headers = Array.from(container.querySelectorAll<HTMLElement>('.scm-section__header'));
    const contents = Array.from(container.querySelectorAll<HTMLElement>('.scm-section__content'));
    if (headers.length === 0) return;
    const containerHeight = container.clientHeight;
    const headersHeight = headers.reduce((sum, h) => sum + h.offsetHeight, 0);
    const expandedCount = contents.length;
    if (expandedCount === 0) return;
    const available = Math.max(0, containerHeight - headersHeight);
    const per = Math.floor(available / expandedCount);
    contents.forEach((c) => { c.style.height = `${per}px`; });
  }, []);

  useLayoutEffect(() => {
    computeHeights();
  }, [computeHeights, stagedOpen, changesOpen, mergeOpen, untrackedOpen, stashOpen, stagedEntries, changesEntries, mergeEntries, untrackedEntries, stashes]);

  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => computeHeights());
    ro.observe(container);
    return () => ro.disconnect();
  }, [computeHeights]);

  /** 渲染文件分组（标题始终显示，空分组折叠内容） */
  const renderSection = useCallback(
    (title: string, entries: { path: string; code: string }[], open: boolean,
     setOpen: (v: boolean) => void, _hAction: string,
     headerBtns: { label: string; icon: React.ElementType<{ size?: number | string; strokeWidth?: number | string }>; handler: () => void }[],
     itemBtns: { icon: React.ElementType<{ size?: number | string; strokeWidth?: number | string }>; handler: (p: string) => void; title: string }[]) => {
      const isEmpty = entries.length === 0;
      return (
      <div className={`scm-section ${isEmpty ? 'scm-section--empty' : ''}`}>
        <div className="scm-section__header" onClick={() => { if (!isEmpty) setOpen(!open); }}>
          <ChevronRight size={12} strokeWidth={1.5} className={open && !isEmpty ? 'scm-rotated' : ''} />
          <span className="scm-section__title">{title}</span>
          <span className="scm-section__badge">{entries.length}</span>
          {!isEmpty && (
            <span className="scm-section__actions">
              {headerBtns.map((b, i) => (
                <button key={i} onClick={e => { e.stopPropagation(); b.handler(); }} title={b.label}>
                  <b.icon size={12} strokeWidth={1.5} />
                </button>
              ))}
            </span>
          )}
        </div>
        {open && !isEmpty && (
          <div className="scm-section__content">
            {entries.map(({ path, code }) => (
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
          </div>
        )}
      </div>
    );
    }, [handleOpenFile, t]
  );

  if (!rootPath) {
    return (
      <div className="scm-panel scm-setup">
        <div className="scm-setup__hero">
          <GitBranch size={36} strokeWidth={1} className="scm-setup__hero-icon" />
          <h2>{t('sidePanel.sourceControl')}</h2>
          <p>{t('sourceControlPanel.setupDesc')}</p>
          <button className="scm-btn scm-btn--primary" onClick={() => dispatch(setShowCloneForm(true))}>
            <Download size={14} /> {t('sourceControlPanel.cloneRepo')}
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
          <h2>{t('sourceControlPanel.initTitle')}</h2>
          <p>{t('sourceControlPanel.initDesc')}</p>
          <button className="scm-btn scm-btn--primary" onClick={handleInit} disabled={loading}>
            {loading ? <Loader2 size={14} className="scm-spin" /> : <GitBranch size={14} />} {t('sourceControlPanel.initRepo')}
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
          <input className="scm-header__input" placeholder={t('sourceControlPanel.commitPlaceholder')}
            value={commitMsg} onChange={e => setCommitMsg(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleCommit(); } }}
          />
          <button className="scm-header__commit" onClick={handleCommit} disabled={!commitMsg.trim()} title={t('sourceControlPanel.commitTooltip')}>
            <Check size={16} strokeWidth={1.5} />
          </button>
        </div>
        <div className="scm-header__tools">
          <button className="scm-icon-btn" onClick={resetPolling} title={t('sourceControlPanel.refresh')}>
            <RefreshCw size={15} strokeWidth={1.5} className={loading ? 'scm-spin' : ''} />
          </button>
          <button className="scm-icon-btn" onClick={handleStageAllChanges} title={t('sourceControlPanel.stageAllChanges')}>
            <Plus size={15} strokeWidth={1.5} />
          </button>
          <button className="scm-icon-btn" onClick={() => dispatch(pullBranch()).then(resetPolling)} title={t('sourceControlPanel.pull')}>
            <GitPullRequest size={15} strokeWidth={1.5} />
          </button>
          <button className="scm-icon-btn" onClick={() => dispatch(pushBranch()).then(resetPolling)} title={t('sourceControlPanel.push')}>
            <GitBranch size={15} strokeWidth={1.5} />
          </button>
          <span className="scm-header__spacer" />
          <button className="scm-icon-btn" onClick={() => dispatch(initRepo())} title={t('sourceControlPanel.more')}>
            <Ellipsis size={15} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      <div className="scm-content" ref={contentRef}>
        {renderSection(t('sourceControlPanel.sections.staged'), stagedEntries, stagedOpen, setStagedOpen, 'undo', [
          { label: t('sourceControlPanel.actions.unstageAll'), icon: Minus, handler: handleUnstageAll },
          { label: t('sourceControlPanel.actions.revertStagedAll'), icon: Undo2, handler: handleUnstageAll },
        ], [
          { icon: Minus, handler: handleUnstage, title: t('sourceControlPanel.actions.unstage') },
          { icon: FileText, handler: handleOpenFileNormal, title: t('sourceControlPanel.actions.openFile') },
        ])}
        {renderSection(t('sourceControlPanel.sections.changes'), changesEntries, changesOpen, setChangesOpen, 'plus', [
          { label: t('sourceControlPanel.actions.stageAll'), icon: Plus, handler: handleStageAllChanges },
          { label: t('sourceControlPanel.actions.discardAllChanges'), icon: Undo2, handler: handleDiscardAllChanges },
        ], [
          { icon: Plus, handler: handleStage, title: t('sourceControlPanel.actions.stage') },
          { icon: Undo2, handler: handleDiscard, title: t('sourceControlPanel.actions.discard') },
          { icon: FileText, handler: handleOpenFileNormal, title: t('sourceControlPanel.actions.openFile') },
        ])}
        {renderSection(t('sourceControlPanel.sections.merge'), mergeEntries, mergeOpen, setMergeOpen, 'alert', [
          { label: t('sourceControlPanel.actions.discardAllMerge'), icon: Undo2, handler: handleDiscardAllMerge },
        ], [
          { icon: FileText, handler: handleOpenFileNormal, title: t('sourceControlPanel.actions.openFile') },
        ])}
        {renderSection(t('sourceControlPanel.sections.untracked'), untrackedEntries, untrackedOpen, setUntrackedOpen, 'plus', [
          { label: t('sourceControlPanel.actions.stageAll'), icon: Plus, handler: () => {
            const files = untrackedEntries.map(e => e.path);
            if (files.length) dispatch(stageFiles(files));
          }},
          { label: t('sourceControlPanel.actions.deleteAllUntracked'), icon: Undo2, handler: handleDeleteAllUntracked },
        ], [
          { icon: Plus, handler: handleStage, title: t('sourceControlPanel.actions.stage') },
          { icon: FileText, handler: handleOpenFileNormal, title: t('sourceControlPanel.actions.openFile') },
        ])}
        {stashes.length > 0 && (
          <div className="scm-section">
            <div className="scm-section__header" onClick={() => setStashOpen(!stashOpen)}>
              <ChevronRight size={12} strokeWidth={1.5} className={stashOpen ? 'scm-rotated' : ''} />
              <span className="scm-section__title">{t('sourceControlPanel.sections.stash')}</span>
              <span className="scm-section__badge">{stashes.length}</span>
            </div>
            {stashOpen && (
              <div className="scm-section__content">
                {stashes.map((s, i) => <div key={i} className="scm-item scm-item--stash">{s}</div>)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default SourceControlPanel;
