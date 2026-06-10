import { useCallback, useRef, forwardRef, useImperativeHandle } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CaseSensitive,
  WholeWord,
  Regex,
  Replace,
  ReplaceAll,
  Sparkles,
} from 'lucide-react';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { openFile, setSearchHighlight, setPendingSearchQuery } from '../../store/slices/workspaceSlice';
import { isElectron } from '../../services/fileService';
import type { FileEntry } from '../../services/fileService';
import type { SearchMatch } from '../../utils/searchUtils';
import { useSearch } from '../../hooks/useSearch';
import './SearchPanel.css';

export interface SearchPanelRef {
  triggerSearch: (query: string) => void;
}

const SearchPanel = forwardRef<SearchPanelRef>((_props, ref) => {
  const dispatch = useAppDispatch();
  const entries = useAppSelector((state) => state.workspace.entries);
  const rootSource = useAppSelector((state) => state.workspace.rootSource);
  const pendingSearchQuery = useAppSelector((state) => state.workspace.pendingSearchQuery);

  const {
    query,
    setQuery,
    replaceQuery,
    setReplaceQuery,
    includePattern,
    setIncludePattern,
    excludePattern,
    setExcludePattern,
    caseSensitive,
    setCaseSensitive,
    wholeWord,
    setWholeWord,
    useRegex,
    setUseRegex,
    fuzzyMode,
    setFuzzyMode,
    showReplace,
    setShowReplace,
    isSearching,
    results,
    searchedCount,
    totalFileCount,
    isTruncated,
    triggerSearch,
    handleSearchInternal,
    totalMatches,
    toggleExpanded,
  } = useSearch(entries, pendingSearchQuery, () => dispatch(setPendingSearchQuery(null)));

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useImperativeHandle(ref, () => ({
    triggerSearch,
  }));

  const handleMatchClick = useCallback(
    async (filePath: string, match: SearchMatch) => {
      if (isElectron() && rootSource && typeof rootSource === 'string') {
        const absolutePath = rootSource + '/' + filePath;
        const entry: FileEntry = {
          name: filePath.slice(filePath.lastIndexOf('/') + 1),
          kind: 'file',
          source: absolutePath,
        };
        await dispatch(openFile(entry));
        dispatch(setSearchHighlight({ keyword: query, line: match.line, column: match.column }));
      }
    },
    [dispatch, query, rootSource]
  );

  const toggleFileExpanded = toggleExpanded;

  const totalFiles = results.length;

  return (
    <div className="search-panel">
      <div className="search-panel__inputs">
        <div className="search-input-wrap">
          <input
            type="text"
            placeholder="搜索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (debounceRef.current) clearTimeout(debounceRef.current);
                void handleSearchInternal(query);
              }
            }}
          />
          <div className="search-input__actions">
            <button
              className={`search-input__btn ${caseSensitive ? 'active' : ''}`}
              title="大小写敏感"
              onClick={() => setCaseSensitive((v) => !v)}
            >
              <CaseSensitive size={14} strokeWidth={1.5} />
            </button>
            <button
              className={`search-input__btn ${wholeWord ? 'active' : ''}`}
              title="全字匹配"
              onClick={() => setWholeWord((v) => !v)}
            >
              <WholeWord size={14} strokeWidth={1.5} />
            </button>
            <button
              className={`search-input__btn ${useRegex ? 'active' : ''}`}
              title="正则表达式"
              onClick={() => setUseRegex((v) => !v)}
            >
              <Regex size={14} strokeWidth={1.5} />
            </button>
            <button
              className={`search-input__btn ${fuzzyMode ? 'active' : ''}`}
              title="模糊匹配（拼写纠错）"
              onClick={() => setFuzzyMode((v) => !v)}
            >
              <Sparkles size={14} strokeWidth={1.5} />
            </button>
            <span className="search-input__sep" />
            <button
              className={`search-input__btn ${showReplace ? 'active' : ''}`}
              title="切换替换"
              onClick={() => setShowReplace((v) => !v)}
            >
              <ChevronDown size={14} strokeWidth={1.5} className={showReplace ? 'rotate-180' : ''} />
            </button>
          </div>
        </div>

        {showReplace && (
          <div className="search-panel__replace">
            <input type="text" placeholder="替换" value={replaceQuery} onChange={(e) => setReplaceQuery(e.target.value)} />
            <div className="replace-actions">
              <button title="替换"><Replace size={14} strokeWidth={1.5} /></button>
              <button title="全部替换"><ReplaceAll size={14} strokeWidth={1.5} /></button>
            </div>
          </div>
        )}
      </div>

      <div className="search-panel__filters">
        <div className="filter-row">
          <label>包含</label>
          <input type="text" placeholder="例如: *.ts, *.tsx" value={includePattern} onChange={(e) => setIncludePattern(e.target.value)} />
        </div>
        <div className="filter-row">
          <label>排除</label>
          <input type="text" placeholder="例如: node_modules, dist" value={excludePattern} onChange={(e) => setExcludePattern(e.target.value)} />
        </div>
      </div>

      {(results.length > 0 || isSearching) && (
        <div className="search-panel__stats">
          {isSearching
            ? `正在搜索... ${searchedCount}/${totalFileCount} 文件`
            : `${totalFiles} 文件中有 ${totalMatches} 个结果${isTruncated ? '（已截断，最多 500 个）' : ''}`}
        </div>
      )}

      <div className="search-panel__results">
        {results.length === 0 && !isSearching && query && (
          <div className="search-panel__empty">
            {isTruncated ? '结果过多，已截断显示' : '未找到匹配结果'}
          </div>
        )}

        {results.map((fileResult, fileIndex) => {
          const lastSlash = fileResult.filePath.lastIndexOf('/');
          const dirPath = lastSlash > 0 ? fileResult.filePath.slice(0, lastSlash) : '';

          return (
            <div key={fileResult.filePath} className="search-result-file">
              <div
                className={`search-result-file__header ${fileResult.expanded ? 'expanded' : ''}`}
                onClick={() => toggleFileExpanded(fileIndex)}
              >
                <ChevronRight size={14} strokeWidth={1.5} />
                <span className="search-result-file__name">{fileResult.fileName}</span>
                {dirPath && (
                  <span className="search-result-file__dir">{dirPath}</span>
                )}
                <span className="search-result-file__count">{fileResult.matches.length}</span>
              </div>

              {fileResult.expanded && (
                <div className="search-result-matches">
                  {fileResult.matches.map((match, matchIndex) => {
                    const trimmed = match.text.replace(/^\s+/, '');
                    const trimLen = match.text.length - trimmed.length;
                    const textPos = match.match.length > 0
                      ? Math.min(match.match.index, 40)
                      : match.match.index;
                    const adjIndex = Math.max(0, textPos - trimLen);
                    return (
                    <div
                      key={matchIndex}
                      className="search-result-match"
                      onClick={() => handleMatchClick(fileResult.filePath, match)}
                    >
                      <span className="search-result-match__text">
                        <HighlightText
                          text={trimmed}
                          matchIndex={adjIndex}
                          matchLength={match.match.length}
                        />
                      </span>
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});

SearchPanel.displayName = 'SearchPanel';

const HighlightText = ({
  text,
  matchIndex,
  matchLength,
}: {
  text: string;
  matchIndex: number;
  matchLength: number;
}) => {
  const before = text.substring(0, matchIndex);
  const matched = text.substring(matchIndex, matchIndex + matchLength);
  const after = text.substring(matchIndex + matchLength);
  return <>{before}<mark>{matched}</mark>{after}</>;
};

export default SearchPanel;
