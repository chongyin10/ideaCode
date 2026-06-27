import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { GitBranch, AlertCircle, XCircle, FileText, ChevronDown, Cpu, MemoryStick, Monitor, Plus, Check, Search } from 'lucide-react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { setFileLanguage } from '../../store/slices/workspaceSlice';
import { openBottomTab } from '../../store/slices/layoutSlice';
import { getExtensionBridge } from '../../plugin/extensionBridge';
import { isPath } from '../../services/fileService';
import type { SystemStats } from '../../types/electron';
import './StatusBar.css';

interface GitBranchInfo {
  name: string;
  current: boolean;
  isRemote: boolean;
  ahead: number;
  behind: number;
  lastCommit?: {
    shortHash: string;
    subject: string;
    authorName: string;
    timestamp: number;
  };
}

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
  const { openedFiles, activeFileId, rootSource, rootName, gitBranch } = useAppSelector(
    (state) => state.workspace
  );

  const [langOpen, setLangOpen] = useState(false);
  const [systemStats, setSystemStats] = useState<SystemStats | null>(null);

  const langRef = useRef<HTMLDivElement>(null);

  // 分支选择器本地状态：不切换面板，直接在状态栏上方渲染 popover
  const [branchOpen, setBranchOpen] = useState(false);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [branchLoading, setBranchLoading] = useState(false);
  const [branchSearch, setBranchSearch] = useState('');
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const branchRef = useRef<HTMLDivElement>(null);
  const branchSearchRef = useRef<HTMLInputElement>(null);

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

  // 点击外部关闭语言选择器
  useEffect(() => {
    if (!langOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (langRef.current && !langRef.current.contains(e.target as Node)) {
        setLangOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [langOpen]);

  // 加载分支列表（通过 ext.invoke 直接调用 git 扩展方法，不依赖 webview）
  const loadBranches = useCallback(async () => {
    setBranchLoading(true);
    try {
      const result = (await getExtensionBridge()?.invokeExtension('ideacode-git', 'getBranches', [])) as GitBranchInfo[] | undefined;
      setBranches(result || []);
    } catch (err) {
      console.error('[StatusBar] 加载分支列表失败:', err);
      setBranches([]);
    } finally {
      setBranchLoading(false);
    }
  }, []);

  // 打开分支 popover 时加载分支列表
  useEffect(() => {
    if (!branchOpen) return;
    loadBranches();
  }, [branchOpen, loadBranches]);

  // 打开搜索框聚焦
  useEffect(() => {
    if (branchOpen) {
      requestAnimationFrame(() => branchSearchRef.current?.focus());
    } else {
      setBranchSearch('');
      setCreatingBranch(false);
      setNewBranchName('');
    }
  }, [branchOpen]);

  // 点击外部关闭分支 popover
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

  // 切换分支
  const handleCheckout = useCallback(async (name: string) => {
    try {
      await getExtensionBridge()?.invokeExtension('ideacode-git', 'checkoutBranch', [{ name }]);
      // 切换成功后关闭 popover（git.statusChanged 会通过 Redux 自动更新 gitBranch）
      setBranchOpen(false);
    } catch (err) {
      console.error('[StatusBar] 切换分支失败:', err);
      alert(`切换分支失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  // 创建新分支
  const handleCreateBranch = useCallback(async () => {
    const name = newBranchName.trim();
    if (!name) return;
    try {
      await getExtensionBridge()?.invokeExtension('ideacode-git', 'createBranch', [{ name }]);
      setNewBranchName('');
      setCreatingBranch(false);
      await loadBranches();
    } catch (err) {
      console.error('[StatusBar] 创建分支失败:', err);
      alert(`创建分支失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [newBranchName, loadBranches]);

  // 过滤分支列表（按搜索词）
  const filteredBranches = useMemo(() => {
    if (!branchSearch) return branches;
    const q = branchSearch.toLowerCase();
    return branches.filter((b) => b.name.toLowerCase().includes(q));
  }, [branches, branchSearch]);
  const localBranches = useMemo(() => filteredBranches.filter((b) => !b.isRemote), [filteredBranches]);
  const remoteBranches = useMemo(() => filteredBranches.filter((b) => b.isRemote), [filteredBranches]);

  // 订阅主进程广播的系统资源监控数据
  useEffect(() => {
    const unsubscribe = window.electronAPI?.system?.onStats((data) => {
      setSystemStats(data);
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  return (
    <div className="status-bar">
      <div className="status-bar__left">
        {/* Git 入口：显示当前分支名，点击在状态栏上方展开分支选择器（不切换面板） */}
        <div className="status-bar__branch-wrapper" ref={branchRef}>
          <span
            className="status-bar__branch status-bar__item--clickable"
            onClick={() => setBranchOpen((v) => !v)}
            title={gitBranch ? `当前分支: ${gitBranch}` : t('statusBar.sourceControl') || '源代码管理'}
          >
            <GitBranch size={12} strokeWidth={1.5} />
            <span>{gitBranch || t('statusBar.sourceControl') || '源代码管理'}</span>
            <ChevronDown size={10} strokeWidth={1.5} style={{ opacity: 0.6 }} />
          </span>

          {branchOpen && (
            <div className="status-bar__branch-dropdown">
              {/* 搜索框 */}
              <div className="status-bar__branch-search">
                <Search size={12} strokeWidth={1.5} />
                <input
                  ref={branchSearchRef}
                  placeholder="搜索分支..."
                  value={branchSearch}
                  onChange={(e) => setBranchSearch(e.target.value)}
                />
              </div>

              {/* 新建分支入口 */}
              {!creatingBranch ? (
                <button
                  className="status-bar__branch-create"
                  onClick={() => setCreatingBranch(true)}
                >
                  <Plus size={12} strokeWidth={1.5} />
                  <span>新建分支</span>
                </button>
              ) : (
                <div className="status-bar__branch-create-input">
                  <input
                    autoFocus
                    placeholder="新分支名"
                    value={newBranchName}
                    onChange={(e) => setNewBranchName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleCreateBranch();
                      if (e.key === 'Escape') {
                        setCreatingBranch(false);
                        setNewBranchName('');
                      }
                    }}
                  />
                  <button onClick={handleCreateBranch}>创建</button>
                </div>
              )}

              {/* 本地分支 */}
              <div className="status-bar__branch-section">本地分支</div>
              <div className="status-bar__branch-list">
                {branchLoading ? (
                  <div className="status-bar__branch-empty">加载中...</div>
                ) : localBranches.length === 0 ? (
                  <div className="status-bar__branch-empty">暂无分支</div>
                ) : (
                  localBranches.map((b) => (
                    <button
                      key={b.name}
                      className={`status-bar__branch-item ${b.current ? 'current' : ''}`}
                      onClick={() => !b.current && handleCheckout(b.name)}
                      title={b.lastCommit ? `${b.lastCommit.authorName} • ${b.lastCommit.subject}` : b.name}
                    >
                      <span className="status-bar__branch-check">
                        {b.current && <Check size={12} strokeWidth={2} />}
                      </span>
                      <GitBranch size={12} strokeWidth={1.5} />
                      <span className="status-bar__branch-name">{b.name}</span>
                      {(b.ahead > 0 || b.behind > 0) && (
                        <span className="status-bar__branch-ab">
                          {b.ahead > 0 && <span className="ahead">↑{b.ahead}</span>}
                          {b.behind > 0 && <span className="behind">↓{b.behind}</span>}
                        </span>
                      )}
                    </button>
                  ))
                )}
              </div>

              {/* 远程分支 */}
              {remoteBranches.length > 0 && (
                <>
                  <div className="status-bar__branch-section">远程分支</div>
                  <div className="status-bar__branch-list">
                    {remoteBranches.map((b) => (
                      <button
                        key={b.name}
                        className="status-bar__branch-item"
                        onClick={() => handleCheckout(b.name)}
                        title={b.lastCommit ? `${b.lastCommit.authorName} • ${b.lastCommit.subject}` : b.name}
                      >
                        <span className="status-bar__branch-check" />
                        <GitBranch size={12} strokeWidth={1.5} />
                        <span className="status-bar__branch-name">{b.name}</span>
                      </button>
                    ))}
                  </div>
                </>
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
          <div className="status-bar__lang" ref={langRef}>
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
