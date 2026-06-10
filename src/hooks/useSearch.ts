import { useState, useCallback, useRef, useEffect } from 'react';
import { readFile } from '../services/fileService';
import type { FileEntry, FileSource } from '../services/fileService';
import { InvertedIndex } from '../utils/algorithms';
import {
  hasNonWordChars,
  matchGlob,
  hitsToResults,
  MAX_TOTAL_MATCHES,
  READ_BATCH_SIZE,
  type FileSearchResult,
} from '../utils/searchUtils';

interface WorkerResult {
  type: 'progress' | 'done';
  results: FileSearchResult[];
  totalMatches: number;
  isTruncated: boolean;
  searchId: number;
}

export interface UseSearchReturn {
  query: string;
  setQuery: React.Dispatch<React.SetStateAction<string>>;
  replaceQuery: string;
  setReplaceQuery: React.Dispatch<React.SetStateAction<string>>;
  includePattern: string;
  setIncludePattern: React.Dispatch<React.SetStateAction<string>>;
  excludePattern: string;
  setExcludePattern: React.Dispatch<React.SetStateAction<string>>;
  caseSensitive: boolean;
  setCaseSensitive: React.Dispatch<React.SetStateAction<boolean>>;
  wholeWord: boolean;
  setWholeWord: React.Dispatch<React.SetStateAction<boolean>>;
  useRegex: boolean;
  setUseRegex: React.Dispatch<React.SetStateAction<boolean>>;
  fuzzyMode: boolean;
  setFuzzyMode: React.Dispatch<React.SetStateAction<boolean>>;
  showReplace: boolean;
  setShowReplace: React.Dispatch<React.SetStateAction<boolean>>;
  isSearching: boolean;
  results: FileSearchResult[];
  searchedCount: number;
  totalFileCount: number;
  isTruncated: boolean;
  triggerSearch: (q: string) => void;
  handleSearchInternal: (searchQuery: string) => Promise<void>;
  totalMatches: number;
  toggleExpanded: (index: number) => void;
}

/** 自适应防抖：基于键间间隔的指数滑动平均 */
function computeAdaptiveDebounce(keyGapHistory: number[]): number {
  if (keyGapHistory.length === 0) return 300;
  const avg = keyGapHistory.reduce((s, v) => s + v, 0) / keyGapHistory.length;
  // 快打字 → 短延迟 (min 80ms)，慢打字 → 长延迟 (max 500ms)
  const smoothed = 0.7 * 300 + 0.3 * (avg * 1.5);
  return Math.max(80, Math.min(500, Math.round(smoothed)));
}

/** 自适应批量大小：基于文件平均读取耗时 */
function computeAdaptiveBatchSize(
  prevBatchSize: number,
  prevBatchDurationMs: number
): number {
  const targetMs = 50;
  if (prevBatchDurationMs <= 0) return prevBatchSize;
  const ratio = targetMs / Math.max(prevBatchDurationMs, 1);
  const newSize = prevBatchSize * (0.7 + 0.3 * ratio);
  return Math.max(2, Math.min(50, Math.round(newSize)));
}

export function useSearch(entries: FileEntry[], pendingQuery: string | null, onPendingConsumed: () => void): UseSearchReturn {
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

  // 自适应防抖的历史键间间隔
  const lastKeyTimeRef = useRef<number>(0);
  const keyGapHistoryRef = useRef<number[]>([]);

  // 自适应批量大小状态
  const batchSizeRef = useRef(READ_BATCH_SIZE);

  useEffect(() => {
    if (pendingQuery) {
      setQuery(pendingQuery);
      onPendingConsumed();
      setTimeout(() => { void handleSearchInternal(pendingQuery); }, 80);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingQuery]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      setIsSearching(false);
      return;
    }

    // 自适应防抖
    const now = Date.now();
    if (lastKeyTimeRef.current > 0) {
      const gap = now - lastKeyTimeRef.current;
      keyGapHistoryRef.current.push(gap);
      if (keyGapHistoryRef.current.length > 10) {
        keyGapHistoryRef.current.shift();
      }
    }
    lastKeyTimeRef.current = now;
    const delay = computeAdaptiveDebounce(keyGapHistoryRef.current);

    debounceRef.current = setTimeout(() => { void handleSearchInternal(query); }, delay);
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
        new URL('../workers/search.worker.ts', import.meta.url),
        { type: 'module' }
      );
    }
    return workerRef.current;
  }, []);

  /** 迭代式 DFS 收集文件路径（消除递归栈溢出风险） */
  const collectAllFilesIterative = useCallback(
    async (
      rootItems: FileEntry[],
      outFiles: { path: string; source: FileSource }[] = []
    ): Promise<void> => {
      const skipDirs = new Set([
        'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
        'out', '.vscode', '.idea', '__pycache__', 'vendor', '.yarn',
      ]);

      // 栈：{ items, prefix }
      const stack: { items: FileEntry[]; prefix: string }[] = [
        { items: rootItems, prefix: '' },
      ];

      while (stack.length > 0) {
        const { items, prefix } = stack.pop()!;

        for (let idx = items.length - 1; idx >= 0; idx--) {
          const item = items[idx];
          const fullPath = prefix ? `${prefix}/${item.name}` : item.name;

          if (item.kind === 'file') {
            if (includePattern && !matchGlob(fullPath, includePattern)) continue;
            if (excludePattern && matchGlob(fullPath, excludePattern)) continue;
            outFiles.push({ path: fullPath, source: item.source });
          } else {
            if (skipDirs.has(item.name)) continue;
            try {
              const { readDirectory } = await import('../services/fileService');
              const children = await readDirectory(item.source);
              stack.push({ items: children, prefix: fullPath });
            } catch { /* skip */ }
          }
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
      return settled
        .filter((r): r is PromiseFulfilledResult<{ path: string; content: string }> => r.status === 'fulfilled')
        .map((r) => r.value);
    },
    []
  );

  const buildIndex = useCallback(
    async (files: { path: string; source: FileSource }[]): Promise<InvertedIndex> => {
      const index = new InvertedIndex();
      const currentBatchSize = batchSizeRef.current;

      for (let i = 0; i < files.length; i += currentBatchSize) {
        const batch = files.slice(i, i + currentBatchSize);
        const batchStart = performance.now();
        const contents = await readBatch(batch);
        const batchEnd = performance.now();

        index.indexFiles(contents);

        // 自适应批量大小：根据本批次的性能调整
        batchSizeRef.current = computeAdaptiveBatchSize(
          currentBatchSize,
          batchEnd - batchStart
        );
      }
      return index;
    },
    [readBatch]
  );

  const doIndexedSearch = useCallback((searchQuery: string, index: InvertedIndex) => {
    let hits = fuzzyMode ? index.fuzzySearch(searchQuery) : index.search(searchQuery);

    if (hits.length === 0 && !fuzzyMode && searchQuery.length >= 2) {
      hits = index.fuzzySearch(searchQuery);
      if (hits.length > 0) {
        setFuzzyMode(true);
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

  const doWorkerSearch = useCallback(async (
    searchQuery: string,
    allFiles: { path: string; source: FileSource }[],
    currentSearchId: number,
  ) => {
    const worker = getWorker();
    const mergedResults = new Map<string, FileSearchResult>();
    let processed = 0;

    const onMessage = (event: MessageEvent<WorkerResult>) => {
      if (searchIdRef.current !== currentSearchId) return;
      const { type, results: batchResults, totalMatches, isTruncated: truncated } = event.data;
      if (type === 'progress') {
        for (const r of batchResults) {
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
      const currentBatchSize = batchSizeRef.current;

      for (let i = 0; i < allFiles.length; i += currentBatchSize) {
        if (searchIdRef.current !== currentSearchId) break;
        if (totalMatchesRef.current >= MAX_TOTAL_MATCHES) { setIsTruncated(true); break; }

        const fileBatch = allFiles.slice(i, i + currentBatchSize);
        const batchStart = performance.now();
        const contents = await readBatch(fileBatch);
        const batchEnd = performance.now();

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

        // 自适应批量大小
        batchSizeRef.current = computeAdaptiveBatchSize(
          currentBatchSize,
          batchEnd - batchStart
        );

        // 使用 requestAnimationFrame 替代 setTimeout(10) yield
        await new Promise<void>((r) => {
          requestAnimationFrame(() => r());
        });
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

    const cached = fileCacheRef.current;
    let allFiles: { path: string; source: FileSource }[];
    if (cached && cached.entriesSrc === entriesKey) {
      allFiles = cached.files.slice();
    } else {
      const collected: { path: string; source: FileSource }[] = [];
      await collectAllFilesIterative(entries, collected);
      allFiles = collected;
      fileCacheRef.current = { entriesSrc: entriesKey, files: allFiles.slice() };
      indexRef.current = null;
    }
    if (searchIdRef.current !== currentSearchId) { setIsSearching(false); return; }
    setTotalFileCount(allFiles.length);

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

    await doWorkerSearch(searchQuery, allFiles, currentSearchId);
  }, [entries, useRegex, caseSensitive, wholeWord, collectAllFilesIterative, buildIndex, doIndexedSearch, doWorkerSearch]);

  const triggerSearch = useCallback((q: string) => {
    setQuery(q);
    setTimeout(() => { void handleSearchInternal(q); }, 0);
  }, [handleSearchInternal]);

  const toggleExpanded = useCallback((index: number) => {
    setResults((prev) => prev.map((r, i) => (i === index ? { ...r, expanded: !r.expanded } : r)));
  }, []);

  const totalMatches = results.reduce((sum, r) => sum + r.matches.length, 0);

  return {
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
  };
}
