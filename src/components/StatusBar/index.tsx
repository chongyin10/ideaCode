import { useState, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { GitBranch, AlertCircle, XCircle, FileText, ChevronDown, Cpu, MemoryStick, Monitor } from 'lucide-react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { setFileLanguage } from '../../store/slices/workspaceSlice';
import { openBottomTab, switchPanel } from '../../store/slices/layoutSlice';
import { getExtensionBridge } from '../../plugin/extensionBridge';
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
  const { openedFiles, activeFileId, rootSource, rootName, gitBranch } = useAppSelector(
    (state) => state.workspace
  );
  const gitWebviewPanel = useAppSelector((state) =>
    state.extensionUI.webviewPanels.find((p) => p.viewType === 'git.changesView')
  );

  const [langOpen, setLangOpen] = useState(false);
  const [systemStats, setSystemStats] = useState<SystemStats | null>(null);

  const langRef = useRef<HTMLDivElement>(null);

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
        {/* Git 入口：显示当前分支名，点击打开源代码管理面板并展开分支选择器 */}
        <span
          className="status-bar__branch status-bar__item--clickable"
          onClick={() => {
            dispatch(switchPanel('workbench.scm'));
            if (gitWebviewPanel) {
              getExtensionBridge()?.postMessageToWebView(gitWebviewPanel.id, { type: 'showBranchPicker' });
            }
          }}
          title={gitBranch ? `当前分支: ${gitBranch}` : t('statusBar.sourceControl') || '源代码管理'}
        >
          <GitBranch size={12} strokeWidth={1.5} />
          <span>{gitBranch || t('statusBar.sourceControl') || '源代码管理'}</span>
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
