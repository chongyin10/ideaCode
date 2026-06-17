import { useState, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { GitBranch, AlertCircle, XCircle, FileText, ChevronDown, Check, Plus, Search, Cpu, MemoryStick, Monitor } from 'lucide-react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { setFileLanguage } from '../../store/slices/workspaceSlice';
import { openBottomTab, setStatusBarOverlayHeight } from '../../store/slices/layoutSlice';
import { checkoutBranch, createBranch, refreshBranches } from '../../store/slices/gitSlice';
import { isPath } from '../../services/fileService';
import type { SystemStats } from '../../types/electron';
import './StatusBar.css';

const LANGUAGES = [
  'typescript',
  'javascript',
  'css', 'html', 'json',
  'markdown', 'python', 'java',
  'xml', 'yaml', 'sql', 'shell',
  'plaintext',
];

const LANG_DISPLAY: Record<string, string> = {
  typescript: 'TypeScript',
  typescriptreact: 'TypeScript',
  javascript: 'JavaScript',
  javascriptreact: 'JavaScript',
  css: 'CSS',
  html: 'HTML',
  json: 'JSON',
  markdown: 'Markdown',
  python: 'Python',
  java: 'Java',
  xml: 'XML',
  yaml: 'YAML',
  sql: 'SQL',
  shell: 'Shell',
  plaintext: 'Plain Text',
};

const isActiveLanguage = (lang: string, activeLanguage: string) => {
  if (lang === activeLanguage) return true;
  if (lang === 'typescript' && activeLanguage === 'typescriptreact') return true;
  if (lang === 'javascript' && activeLanguage === 'javascriptreact') return true;
  return false;
};

const StatusBar = () => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const [pathMode, setPathMode] = useState<'relative' | 'absolute'>('relative');
  const { openedFiles, activeFileId, rootSource, rootName } = useAppSelector(
    (state) => state.workspace
  );
  const gitBranch = useAppSelector((state) => state.git.branch);
  const branches = useAppSelector((state) => state.git.branches);
  const stagedCount = Object.keys(useAppSelector((state) => state.git.staged)).length;
  const changesCount = Object.keys(useAppSelector((state) => state.git.changes)).length;
  const mergeCount = Object.keys(useAppSelector((state) => state.git.merge)).length;
  const untrackedCount = Object.keys(useAppSelector((state) => state.git.untracked)).length;
  const totalChanges = stagedCount + changesCount + mergeCount + untrackedCount;

  const [langOpen, setLangOpen] = useState(false);
  const [systemStats, setSystemStats] = useState<SystemStats | null>(null);
  const [branchOpen, setBranchOpen] = useState(false);
  const DROPDOWN_HEIGHT_LANG = 200;
  const DROPDOWN_HEIGHT_BRANCH = 320;
  const [branchVisible, setBranchVisible] = useState(false);
  const [branchPhase, setBranchPhase] = useState<'entering' | 'stable' | 'exiting'>('entering');
  const [branchQuery, setBranchQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [newBranchStartPoint, setNewBranchStartPoint] = useState<string | undefined>(undefined);
  const branchRef = useRef<HTMLDivElement>(null);

  const activeFile = useMemo(
    () => openedFiles.find((f) => f.id === activeFileId),
    [openedFiles, activeFileId]
  );

  const filePathText = useMemo(() => {
    if (!activeFile) return '';
    if (!isPath(activeFile.source)) return activeFile.name;

    const absPath = activeFile.source;
    if (pathMode === 'absolute') {
      return absPath;
    }

    if (rootSource && isPath(rootSource)) {
      let rel = absPath.replace(rootSource, '');
      if (rel.startsWith('/')) rel = rel.slice(1);
      return rel ? `${rel} - ${rootName || ''}` : activeFile.name;
    }

    return activeFile.name;
  }, [activeFile, rootSource, rootName, pathMode]);

  // 分支选择器进入/退出动画：branchOpen 控制状态，branchVisible 控制 DOM 渲染
  useEffect(() => {
    if (branchOpen) {
      setBranchVisible(true);
      setBranchPhase('entering');
      const t = setTimeout(() => setBranchPhase('stable'), 150);
      return () => clearTimeout(t);
    } else if (branchVisible) {
      setBranchPhase('exiting');
      const t = setTimeout(() => {
        setBranchVisible(false);
        setBranchQuery('');
        setCreating(false);
        setNewBranchName('');
        setNewBranchStartPoint(undefined);
      }, 150);
      return () => clearTimeout(t);
    }
  }, [branchOpen, branchVisible]);

  // 点击外部关闭分支选择器
  useEffect(() => {
    if (!branchOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (branchRef.current && !branchRef.current.contains(e.target as Node)) {
        setBranchOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [branchOpen]);

  // 打开分支选择器时刷新分支列表
  useEffect(() => {
    if (branchOpen) {
      dispatch(refreshBranches());
    }
  }, [branchOpen, dispatch]);

  // 状态栏下拉展开时通知底部面板预留空间，避免被终端 BrowserView 遮挡
  useEffect(() => {
    const overlayHeight = Math.max(branchVisible ? DROPDOWN_HEIGHT_BRANCH : 0, langOpen ? DROPDOWN_HEIGHT_LANG : 0);
    dispatch(setStatusBarOverlayHeight(overlayHeight));
  }, [branchVisible, langOpen, dispatch]);

  // 订阅主进程广播的系统资源监控数据
  useEffect(() => {
    const unsubscribe = window.electronAPI?.system?.onStats((data) => {
      setSystemStats(data);
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  const { localBranches, remoteBranches } = useMemo(() => {
    const q = branchQuery.trim().toLowerCase();
    const local = branches.filter((b) => !b.name.includes('/'));
    const remote = branches.filter((b) => b.name.includes('/'));
    if (!q) return { localBranches: local, remoteBranches: remote };
    return {
      localBranches: local.filter((b) => b.name.toLowerCase().includes(q)),
      remoteBranches: remote.filter((b) => b.name.toLowerCase().includes(q)),
    };
  }, [branches, branchQuery]);

  const handleCheckout = async (branchName: string) => {
    try {
      await dispatch(checkoutBranch(branchName)).unwrap();
      setBranchOpen(false);
      setBranchQuery('');
    } catch {
      // 错误已由 gitSlice 处理
    }
  };

  const handleCreateBranch = async () => {
    const name = newBranchName.trim();
    if (!name) return;
    try {
      await dispatch(createBranch({ branch: name, startPoint: newBranchStartPoint })).unwrap();
      setCreating(false);
      setNewBranchName('');
      setNewBranchStartPoint(undefined);
      setBranchOpen(false);
      setBranchQuery('');
    } catch {
      // 错误已由 gitSlice 处理
    }
  };

  const startCreateFromRemote = (remoteName: string) => {
    const defaultName = remoteName.replace(/^origin\//, '');
    setNewBranchName(defaultName);
    setNewBranchStartPoint(remoteName);
    setCreating(true);
  };

  return (
    <div className="status-bar">
      <div className="status-bar__left">
        <div className="status-bar__branch-wrapper" ref={branchRef}>
          <span
            className="status-bar__branch"
            onClick={() => setBranchOpen(!branchOpen)}
            title={t('statusBar.branch')}
          >
            <GitBranch size={12} strokeWidth={1.5} />
            {gitBranch || 'master'}
            {totalChanges > 0 ? '*' : ''}
            <ChevronDown size={10} strokeWidth={1.5} />
          </span>

          {branchVisible && (
            <div className={`status-bar__branch-dropdown status-bar__branch-dropdown--${branchPhase}`}>
              <div className="status-bar__branch-search">
                <Search size={12} strokeWidth={1.5} />
                <input
                  type="text"
                  placeholder={t('statusBar.branchSearchPlaceholder')}
                  value={branchQuery}
                  onChange={(e) => setBranchQuery(e.target.value)}
                  autoFocus
                />
              </div>

              {!creating && (
                <button
                  className="status-bar__branch-create"
                  onClick={() => setCreating(true)}
                >
                  <Plus size={12} strokeWidth={1.5} />
                  {t('statusBar.createNewBranch')}
                </button>
              )}

              {creating && (
                <div className="status-bar__branch-create-input">
                  <input
                    type="text"
                    placeholder={newBranchStartPoint ? t('statusBar.branchBasedOnPlaceholder', { branch: newBranchStartPoint }) : t('statusBar.newBranchNamePlaceholder')}
                    value={newBranchName}
                    onChange={(e) => setNewBranchName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleCreateBranch();
                      if (e.key === 'Escape') {
                        setCreating(false);
                        setNewBranchName('');
                        setNewBranchStartPoint(undefined);
                      }
                    }}
                    autoFocus
                  />
                  <button onClick={handleCreateBranch}>{t('create')}</button>
                </div>
              )}

              {localBranches.length > 0 && (
                <div className="status-bar__branch-section">{t('statusBar.localBranches')}</div>
              )}
              {localBranches.map((branch) => (
                <button
                  key={branch.name}
                  className={`status-bar__branch-item ${branch.current ? 'current' : ''}`}
                  onClick={() => {
                    if (!branch.current) handleCheckout(branch.name);
                  }}
                >
                  <span className="status-bar__branch-check">
                    {branch.current ? <Check size={12} strokeWidth={1.5} /> : null}
                  </span>
                  <span className="status-bar__branch-name">{branch.name}</span>
                </button>
              ))}

              {remoteBranches.length > 0 && (
                <div className="status-bar__branch-section">{t('statusBar.remoteBranches')}</div>
              )}
              {remoteBranches.map((branch) => (
                <button
                  key={branch.name}
                  className="status-bar__branch-item"
                  onClick={() => startCreateFromRemote(branch.name)}
                >
                  <span className="status-bar__branch-check" />
                  <span className="status-bar__branch-name">{branch.name}</span>
                </button>
              ))}

              {localBranches.length === 0 && remoteBranches.length === 0 && (
                <div className="status-bar__branch-empty">{t('statusBar.noBranchesFound')}</div>
              )}
            </div>
          )}
        </div>

        <span
          className="status-bar__item status-bar__item--clickable"
          onClick={() => dispatch(openBottomTab('problems'))}
          title={t('statusBar.problems')}
        >
          <AlertCircle size={12} strokeWidth={1.5} />
          0
        </span>
        <span
          className="status-bar__item status-bar__item--clickable"
          onClick={() => dispatch(openBottomTab('problems'))}
          title={t('statusBar.errors')}
        >
          <XCircle size={12} strokeWidth={1.5} />
          0
        </span>
        {activeFile && (
          <>
            <span className="status-bar__sep" />
            <span className="status-bar__path" title={filePathText}>
              {filePathText}
            </span>
            <button
              className="status-bar__path-toggle"
              title={pathMode === 'relative' ? t('statusBar.absolutePath') : t('statusBar.relativePath')}
              onClick={() => setPathMode((m) => (m === 'relative' ? 'absolute' : 'relative'))}
            >
              <FileText size={11} strokeWidth={1.5} />
            </button>
          </>
        )}
      </div>

      <div className="status-bar__right">
        {systemStats && (
          <div className="status-bar__system">
            <span className="status-bar__system-item" title={`${t('statusBar.system.cpu')} ${systemStats.cpu.toFixed(0)}%`}>
              <Cpu size={12} strokeWidth={1.5} />
              <span>{systemStats.cpu.toFixed(0)}%</span>
            </span>
            <span className="status-bar__system-item" title={`${t('statusBar.system.memory')} ${systemStats.memory.toFixed(0)}%`}>
              <MemoryStick size={12} strokeWidth={1.5} />
              <span>{systemStats.memory.toFixed(0)}%</span>
            </span>
            {systemStats.gpu !== null && (
              <span className="status-bar__system-item" title={`${t('statusBar.system.gpu')} ${systemStats.gpu.toFixed(0)}%`}>
                <Monitor size={12} strokeWidth={1.5} />
                <span>{systemStats.gpu.toFixed(0)}%</span>
              </span>
            )}
          </div>
        )}
        <span>{t('statusBar.lineColumn', { line: 12, column: 34 })}</span>
        <span>{t('statusBar.encoding')}</span>
        {activeFile && (
          <div className="status-bar__lang">
            <button className="status-bar__lang-btn" onClick={() => setLangOpen(!langOpen)} title={t('statusBar.language')}>
              {LANG_DISPLAY[activeFile.language] || activeFile.language}
              <ChevronDown size={10} strokeWidth={1.5} />
            </button>
            {langOpen && (
              <div className="status-bar__lang-dropdown">
                {LANGUAGES.map((lang) => (
                    <button
                    key={lang}
                    className={`status-bar__lang-opt ${isActiveLanguage(lang, activeFile.language) ? 'active' : ''}`}
                    onClick={() => {
                      dispatch(setFileLanguage({ id: activeFile.id, language: lang }));
                      setLangOpen(false);
                    }}
                  >
                    {LANG_DISPLAY[lang] || lang}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <span>{t('statusBar.formatter')}</span>
      </div>
    </div>
  );
};

export default StatusBar;
