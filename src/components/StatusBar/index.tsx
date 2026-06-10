import { useState, useMemo } from 'react';
import { GitBranch, AlertCircle, XCircle, FileText } from 'lucide-react';
import { useAppSelector } from '../../store/hooks';
import { isPath } from '../../services/fileService';
import './StatusBar.css';

const StatusBar = () => {
  const [pathMode, setPathMode] = useState<'relative' | 'absolute'>('relative');
  const { openedFiles, activeFileId, rootSource, rootName } = useAppSelector(
    (state) => state.workspace
  );

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
          master*
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
        <span>TypeScript</span>
        <span>Prettier</span>
      </div>
    </div>
  );
};

export default StatusBar;
