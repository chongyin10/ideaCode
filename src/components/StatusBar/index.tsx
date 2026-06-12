import { useState, useMemo } from 'react';
import { GitBranch, AlertCircle, XCircle, FileText, ChevronDown } from 'lucide-react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { setFileLanguage } from '../../store/slices/workspaceSlice';
import { isPath } from '../../services/fileService';
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
  // 兼容旧版遗留的 typescriptreact / javascriptreact 语言 ID
  if (lang === 'typescript' && activeLanguage === 'typescriptreact') return true;
  if (lang === 'javascript' && activeLanguage === 'javascriptreact') return true;
  return false;
};

const StatusBar = () => {
  const dispatch = useAppDispatch();
  const [pathMode, setPathMode] = useState<'relative' | 'absolute'>('relative');
  const { openedFiles, activeFileId, rootSource, rootName } = useAppSelector(
    (state) => state.workspace
  );
  const gitBranch = useAppSelector((state) => state.git.branch);
  const stagedCount = Object.keys(useAppSelector((state) => state.git.staged)).length;
  const changesCount = Object.keys(useAppSelector((state) => state.git.changes)).length;
  const mergeCount = Object.keys(useAppSelector((state) => state.git.merge)).length;
  const untrackedCount = Object.keys(useAppSelector((state) => state.git.untracked)).length;
  const totalChanges = stagedCount + changesCount + mergeCount + untrackedCount;

  const [langOpen, setLangOpen] = useState(false);

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

  return (
    <div className="status-bar">
      <div className="status-bar__left">
        <span className="status-bar__branch">
          <GitBranch size={12} strokeWidth={1.5} />
          {gitBranch || 'master'}
          {totalChanges > 0 ? '*' : ''}
        </span>
        <span className="status-bar__item">
          <AlertCircle size={12} strokeWidth={1.5} />
          0
        </span>
        <span className="status-bar__item">
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
              title={pathMode === 'relative' ? '切换为绝对路径' : '切换为相对路径'}
              onClick={() => setPathMode((m) => (m === 'relative' ? 'absolute' : 'relative'))}
            >
              <FileText size={11} strokeWidth={1.5} />
            </button>
          </>
        )}
      </div>

      <div className="status-bar__right">
        <span>Ln 12, Col 34</span>
        <span>UTF-8</span>
        {activeFile && (
          <div className="status-bar__lang">
            <button className="status-bar__lang-btn" onClick={() => setLangOpen(!langOpen)} title="选择语言模式">
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
        <span>Prettier</span>
      </div>
    </div>
  );
};

export default StatusBar;
