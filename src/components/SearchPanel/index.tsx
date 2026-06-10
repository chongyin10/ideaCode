import { useState, useCallback, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
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
import { readFile, isElectron } from '../../services/fileService';
import type { FileEntry, FileSource } from '../../services/fileService';
import type { MatchResult } from '../../utils/algorithms';
import { InvertedIndex } from '../../utils/algorithms';
import type { SearchHit } from '../../utils/algorithms';
import './SearchPanel.css';

interface SearchMatch {
  line: number;
  column: number;
  text: string;
  match: MatchResult;
}

interface FileSearchResult {
  filePath: string;
  fileName: string;
  matches: SearchMatch[];
  expanded: boolean;
}

const MAX_TOTAL_MATCHES = 500;
const READ_BATCH_SIZE = 8;

/** 非词字符正则：匹配字母/数字/下划线之外的字符 */
const NON_WORD_RE = /[^\p{L}\p{N}_]/u;

/** 查询是否含有非词字符（如 . - / 等），含有时应作为整体子串搜索 */
function hasNonWordChars(query: string): boolean {
  return NON_WORD_RE.test(query);
}

const globRegexCache = new Map<string, RegExp>();
const MAX_GLOB_CACHE_SIZE = 100;

function getGlobRegex(pattern: string): RegExp {
  let regex = globRegexCache.get(pattern);
  if (!regex) {
    regex = new RegExp(
      '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
    );
    if (globRegexCache.size >= MAX_GLOB_CACHE_SIZE) {
      const firstKey = globRegexCache.keys().next().value;
      if (firstKey !== undefined) globRegexCache.delete(firstKey);
    }
    globRegexCache.set(pattern, regex);
  }
  return regex;
}

function matchGlob(filePath: string, pattern: string): boolean {
  const patterns = pattern.split(',').map((p) => p.trim());
  return patterns.some((p) => {
    if (!p) return false;
    const regex = getGlobRegex(p);
    const fileName = filePath.slice(filePath.lastIndexOf('/') + 1);
    return regex.test(filePath) || regex.test(fileName);
  });
}

function hitsToResults(hits: SearchHit[], query: string): FileSearchResult[] {
  const lowerQuery = query.toLowerCase();
  return hits.map((hit) => ({
    filePath: hit.filePath,
    fileName: hit.fileName,
    matches: hit.entries.map((e) => {
      const lowerContext = e.context.toLowerCase();
      const idx = lowerContext.indexOf(lowerQuery);
      return {
        line: e.line,
        column: e.column,
        text: e.context,
        match: {
          index: idx >= 0 ? idx : Math.max(0, e.column - 1),
          length: idx >= 0 ? query.length : 0,
          matched: idx >= 0 ? e.context.substring(idx, idx + query.length) : '',
        },
      };
    }),
    expanded: true,
  }));
}

export interface SearchPanelRef {
  triggerSearch: (query: string) => void;
}

const SearchPanel = forwardRef<SearchPanelRef>((_props, ref) => {
  const dispatch = useAppDispatch();

  const entries = useAppSelector((state) => state.workspace.entries);
  const rootSource = useAppSelector((state) => state.workspace.rootSource);
  const pendingSearchQuery = useAppSelector((state) => state.workspace.pendingSearchQuery);

  const [query, setQuery] = useState('');
  const [replaceQuery, setReplaceQuery] = useState('');
  const [includePattern, setIncludePattern] = useState('');
  const [excludePattern, setExcludePattern] = useState('node_modules, .git, dist, build');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [fuzzyMode, setFuzzyMode] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [searchedCount, setSearchedCount] = useState(0);
  const [totalFileCount, setTotalFileCount] = useState(0);
  const [results, setResults] = useState<FileSearchResult[]>([]);
  const [isTruncated, setIsTruncated] = useState(false);

  const workerRef = useRef<Worker | null>(null);
  const searchIdRef = useRef(0);
  const totalMatchesRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fileCacheRef = useRef<{ entriesSrc: string; files: { path: string; source: FileSource }[] } | null>(null);
  const indexRef = useRef<{ entriesSrc: string; index: InvertedIndex } | null>(null);

  useImperativeHandle(ref, () => ({
    triggerSearch: (q: string) => {
      setQuery(q);
      setTimeout(() => { void handleSearchInternal(q); }, 0);
    },
  }));

  useEffect(() => {
    if (pendingSearchQuery) {
      setQuery(pendingSearchQuery);
      dispatch(setPendingSearchQuery(null));
      setTimeout(() => { void handleSearchInternal(pendingSearchQuery); }, 80);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSearchQuery]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      setIsSearching(false);
      return;
    }
    debounceRef.current = setTimeout(() => { void handleSearchInternal(query); }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, wholeWord, useRegex, fuzzyMode]);

  useEffect(() => {
    fileCacheRef.current = null;
    indexRef.current = null;
    if (!query.trim()) return;
    void handleSearchInternal(query);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includePattern, excludePattern]);

  const getWorker = useCallback((): Worker => {
    if (!workerRef.current) {
      workerRef.current = new Worker(
        new URL('../../workers/search.worker.ts', import.meta.url),
        { type: 'module' }
      );
    }
    return workerRef.current;
  }, []);

  const collectAllFiles = useCallback(
    async (
      items: FileEntry[],
      prefix = '',
      outFiles: { path: string; source: FileSource }[] = []
    ): Promise<void> => {
      for (const item of items) {
        const fullPath = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.kind === 'file') {
          if (includePattern && !matchGlob(fullPath, includePattern)) continue;
          if (excludePattern && matchGlob(fullPath, excludePattern)) continue;
          outFiles.push({ path: fullPath, source: item.source });
        } else {
          const skipDirs = new Set([
            'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
            'out', '.vscode', '.idea', '__pycache__', 'vendor', '.yarn',
          ]);
          if (skipDirs.has(item.name)) continue;
          try {
            const { readDirectory } = await import('../../services/fileService');
            const children = await readDirectory(item.source);
            await collectAllFiles(children, fullPath, outFiles);
          } catch { /* skip */ }
        }
      }
    },
    [includePattern, excludePattern]
  );

  const readBatch = useCallback(
    async (batch: { path: string; source: FileSource }[]) => {
      const settled = await Promise.allSettled(
        batch.map(async (file) => {
          const content = await readFile(file.source);
          return { path: file.path, content };
        })
      );
      return settled.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<{ path: string; content: string }>).value);
    },
    []
  );

  const buildIndex = useCallback(
    async (files: { path: string; source: FileSource }[]): Promise<InvertedIndex> => {
      const index = new InvertedIndex();
      for (let i = 0; i < files.length; i += READ_BATCH_SIZE) {
        const batch = files.slice(i, i + READ_BATCH_SIZE);
        const contents = await readBatch(batch);
        index.indexFiles(contents);
      }
      return index;
    },
    [readBatch]
  );

  /** 使用倒排索引搜索（O(1) 查表） */
  const doIndexedSearch = useCallback((searchQuery: string, index: InvertedIndex) => {
    let hits = fuzzyMode ? index.fuzzySearch(searchQuery) : index.search(searchQuery);

    // 精确搜索无结果时自动尝试模糊搜索
    if (hits.length === 0 && !fuzzyMode && searchQuery.length >= 2) {
      hits = index.fuzzySearch(searchQuery);
      if (hits.length > 0) {
        setFuzzyMode(true); // 自动开启模糊模式以给用户视觉反馈
      }
    }

    const fileResults = hitsToResults(hits, searchQuery);
    const totalMatches = fileResults.reduce((s, r) => s + r.matches.length, 0);
    setIsTruncated(totalMatches >= MAX_TOTAL_MATCHES);

    setResults(fileResults.slice(0, MAX_TOTAL_MATCHES));
    setTotalFileCount(hits.length);
    setSearchedCount(hits.length);
    setIsSearching(false);
  }, [fuzzyMode]);

  /** 使用 Worker + Boyer-Moore 搜索（正则/大小写敏感/全词匹配回退） */
  const doWorkerSearch = useCallback(async (
    searchQuery: string,
    allFiles: { path: string; source: FileSource }[],
    currentSearchId: number,
  ) => {
    const worker = getWorker();
    const mergedResults = new Map<string, FileSearchResult>();
    let processed = 0;

    const onMessage = (event: MessageEvent) => {
      if (searchIdRef.current !== currentSearchId) return;
      const { type, results: batchResults, totalMatches, isTruncated: truncated } = event.data;
      if (type === 'progress') {
        for (const r of batchResults as FileSearchResult[]) {
          const existing = mergedResults.get(r.filePath);
          if (existing) { existing.matches.push(...r.matches); }
          else { mergedResults.set(r.filePath, { ...r }); }
        }
        totalMatchesRef.current = totalMatches;
        if (truncated) setIsTruncated(true);
        setResults(Array.from(mergedResults.values()));
        setSearchedCount(processed);
      }
    };

    worker.addEventListener('message', onMessage);

    try {
      for (let i = 0; i < allFiles.length; i += READ_BATCH_SIZE) {
        if (searchIdRef.current !== currentSearchId) break;
        if (totalMatchesRef.current >= MAX_TOTAL_MATCHES) { setIsTruncated(true); break; }

        const fileBatch = allFiles.slice(i, i + READ_BATCH_SIZE);
        const contents = await readBatch(fileBatch);
        processed += fileBatch.length;
        if (contents.length === 0) continue;
        if (searchIdRef.current !== currentSearchId) break;

        worker.postMessage({
          type: 'search',
          files: contents,
          query: searchQuery,
          options: { caseSensitive, wholeWord, regex: useRegex },
          totalMatchesSoFar: totalMatchesRef.current,
          maxTotalMatches: MAX_TOTAL_MATCHES,
          searchId: currentSearchId,
        });
        await new Promise((r) => setTimeout(r, 10));
      }

      if (searchIdRef.current === currentSearchId) {
        setResults(Array.from(mergedResults.values()));
        setSearchedCount(processed);
      }
    } finally {
      worker.removeEventListener('message', onMessage);
      allFiles.length = 0;
      mergedResults.clear();
      if (searchIdRef.current === currentSearchId) setIsSearching(false);
    }
  }, [caseSensitive, wholeWord, useRegex, readBatch, getWorker]);

  const handleSearchInternal = useCallback(async (searchQuery: string) => {
    if (!searchQuery.trim() || !entries.length) return;
    const currentSearchId = ++searchIdRef.current;

    setIsSearching(true);
    setResults([]);
    setSearchedCount(0);
    setTotalFileCount(0);
    setIsTruncated(false);
    totalMatchesRef.current = 0;

    const needsWorker = useRegex || caseSensitive || wholeWord || hasNonWordChars(searchQuery);
    const entriesKey = JSON.stringify(entries.map((e) => `${e.name}:${e.kind}`));

    // 阶段 1: 收集文件路径
    const cached = fileCacheRef.current;
    let allFiles: { path: string; source: FileSource }[];
    if (cached && cached.entriesSrc === entriesKey) {
      allFiles = cached.files.slice();
    } else {
      const collected: { path: string; source: FileSource }[] = [];
      await collectAllFiles(entries, '', collected);
      allFiles = collected;
      fileCacheRef.current = { entriesSrc: entriesKey, files: allFiles.slice() };
      indexRef.current = null; // 目录结构变了，索引失效
    }
    if (searchIdRef.current !== currentSearchId) { setIsSearching(false); return; }
    setTotalFileCount(allFiles.length);

    // 阶段 2: 尝试倒排索引搜索（不需要 Worker 时）
    if (!needsWorker) {
      try {
        const indexCached = indexRef.current;
        let index: InvertedIndex;
        if (indexCached && indexCached.entriesSrc === entriesKey) {
          index = indexCached.index;
        } else {
          setIsSearching(true);
          index = await buildIndex(allFiles);
          indexRef.current = { entriesSrc: entriesKey, index };
        }
        if (searchIdRef.current !== currentSearchId) { setIsSearching(false); return; }
        doIndexedSearch(searchQuery, index);
        return;
      } catch (err) {
        console.warn('[SearchPanel] 倒排索引搜索失败，回退到 Worker 搜索:', err);
        setIsSearching(true);
        setResults([]);
      }
    }

    // 阶段 3: Worker + Boyer-Moore 回退
    await doWorkerSearch(searchQuery, allFiles, currentSearchId);
  }, [entries, useRegex, caseSensitive, wholeWord, collectAllFiles, buildIndex, doIndexedSearch, doWorkerSearch]);

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

  const toggleFileExpanded = useCallback((index: number) => {
    setResults((prev) => prev.map((r, i) => (i === index ? { ...r, expanded: !r.expanded } : r)));
  }, []);

  const totalMatches = results.reduce((sum, r) => sum + r.matches.length, 0);
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
                      ? Math.min(match.match.index, 40)   // Worker: file index → text index
                      : match.match.index;                  // Inverted index: already text index
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
