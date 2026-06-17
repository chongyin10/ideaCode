import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X, FileText } from 'lucide-react';
import type { FileSearchResult, FindResult } from '../../services/searchService';
import { FileIcon } from '../SidePanel/FileTree.icons';
import './FileReferencesModal.css';

interface FileReferencesModalProps {
  results: FileSearchResult[];
  onClose: () => void;
  onOpenResult: (relativePath: string) => void;
}

const FileReferencesModal = ({ results, onClose, onOpenResult }: FileReferencesModalProps) => {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className="file-references-overlay" onClick={onClose}>
      <div className="file-references-panel" ref={panelRef} onClick={(e) => e.stopPropagation()}>
        <div className="file-references-header">
          <span className="file-references-title">{t('tabBar.referencesModal.title')}</span>
          <button className="file-references-close" onClick={onClose} title={t('close')}>
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>

        <div className="file-references-list">
          {results.length === 0 ? (
            <div className="file-references-empty">{t('tabBar.referencesModal.noResults')}</div>
          ) : (
            results.map((result) => (
              <div
                key={result.filePath}
                className="file-references-item"
                onClick={() => onOpenResult(result.filePath)}
              >
                <div className="file-references-item__file">
                  <span className="file-references-item__icon">
                    <FileIcon name={result.fileName} kind="file" />
                  </span>
                  <span className="file-references-item__path">{result.filePath}</span>
                  <span className="file-references-item__count">
                    {result.matchCount}
                  </span>
                </div>
                <div className="file-references-item__matches">
                  {result.matches.slice(0, 3).map((match, idx) => (
                    <MatchLine key={`${match.line}-${idx}`} match={match} />
                  ))}
                  {result.matches.length > 3 && (
                    <div className="file-references-item__more">
                      +{result.matches.length - 3}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

const MatchLine = ({ match }: { match: FindResult }) => {
  return (
    <div className="file-references-match">
      <span className="file-references-match__line">{match.line}</span>
      <span className="file-references-match__icon">
        <FileText size={12} strokeWidth={1.5} />
      </span>
      <span className="file-references-match__text" title={match.text}>
        {match.text}
      </span>
    </div>
  );
};

export default FileReferencesModal;
