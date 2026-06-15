import { useState, useCallback, useRef, useEffect } from 'react';
import { readFile } from '../services/fileService';
import type { FileEntry, FileSource } from '../services/fileService';
import { InvertedIndex, PIDController, KalmanFilter } from '../utils/algorithms';
import {
  hasNonWordChars,
  matchGlob,
  hitsToResults,
  MAX_TOTAL_MATCHES,
  READ_BATCH_SIZE,
  type FileSearchResult,
} from '../utils/searchUtils';

/* ─── 搜索策略接口（Strategy Pattern）─── */

export interface SearchContext {
  files: { path: string; source: FileSource }[];
  searchQuery: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  fuzzyMode: boolean;
  currentSearchId: number;
}

interface SearchStrategy {
  /** 策略名称 */
  name: string;
  /** 是否匹配当前上下文 */
  canHandle(ctx: SearchContext): boolean;
  /** 执行搜索 */
  execute(
    ctx: SearchContext,
    services: SearchStrategyServices
  ): Promise<{ results: FileSearchResult[]; hits: number; truncated: boolean }>;
}

interface SearchStrategyServices {
  readBatch: (files: { path: string; source: FileSource }[]) => Promise<{ path: string; content: string }[]>;
  getWorker: () => Worker;
  setResults: (r: FileSearchResult[]) => void;
  setSearchedCount: (n: number) => void;
  setTotalFileCount: (n: number) => void;
  setIsTruncated: (b: boolean) => void;
  setIsSearching: (b: boolean) => void;
  setFuzzyMode: (b: boolean) => void;
  buildIndex: (files: { path: string; source: FileSource }[]) => Promise<InvertedIndex>;
  computeAdaptiveBatchSize: (prevSize: number, durationMs: number) => number;
}

/** 倒排索引搜索策略（简单词搜索） */
class IndexedSearchStrategy implements SearchStrategy {
  name = 'indexed';

  canHandle(ctx: SearchContext): boolean {
    return !ctx.useRegex && !ctx.caseSensitive && !ctx.wholeWord
      && !hasNonWordChars(ctx.searchQuery);
  }

  async execute(ctx: SearchContext, svc: SearchStrategyServices) {
    const index = await svc.buildIndex(ctx.files);
    let hits = ctx.fuzzyMode ? index.fuzzySearch(ctx.searchQuery) : index.search(ctx.searchQuery);

    if (hits.length === 0 && !ctx.fuzzyMode && ctx.searchQuery.length >= 2) {
      hits = index.fuzzySearch(ctx.searchQuery);
      if (hits.length > 0) svc.setFuzzyMode(true);
    }

    const fileResults = hitsToResults(hits, ctx.searchQuery);
    const totalMatches = fileResults.reduce((s, r) => s + r.matches.length, 0);
    const truncated = totalMatches >= MAX_TOTAL_MATCHES;

    svc.setResults(fileResults.slice(0, MAX_TOTAL_MATCHES));
    svc.setTotalFileCount(hits.length);
    svc.setSearchedCount(hits.length);

    return { results: fileResults, hits: hits.length, truncated };
  }
}

/** Worker 搜索策略（正则/大小写/全词匹配等） */
class WorkerSearchStrategy implements SearchStrategy {
  name = 'worker';

  canHandle(): boolean {
    return true; // 兜底策略
  }

  async execute(ctx: SearchContext, svc: SearchStrategyServices) {
    const worker = svc.getWorker();
    const mergedResults = new Map<string, FileSearchResult>();
    let processed = 0;
    let totalMatchesSoFar = 0;

    const workerPromise = new Promise<{ results: FileSearchResult[]; hits: number; truncated: boolean }>((resolve) => {
      const onMessage = (event: MessageEvent<{
        type: string;
        results: FileSearchResult[];
        totalMatches: number;
        isTruncated: boolean;
        searchId: number;
      }>) => {
        if (ctx.currentSearchId !== event.data.searchId) return;
        const { type, results: batchResults, totalMatches, isTruncated } = event.data;
        if (type === 'progress') {
          for (const r of batchResults) {
            const existing = mergedResults.get(r.filePath);
            if (existing) existing.matches.push(...r.matches);
            else mergedResults.set(r.filePath, { ...r });
          }
          totalMatchesSoFar = totalMatches;
          svc.setResults(Array.from(mergedResults.values()));
          svc.setSearchedCount(processed);
          if (isTruncated) svc.setIsTruncated(true);
        }
      };

      worker.addEventListener('message', onMessage);

      // 发送文件批次
      const sendBatches = async () => {
        let batchSize = READ_BATCH_SIZE;
        for (let i = 0; i < ctx.files.length; i += batchSize) {
          if (totalMatchesSoFar >= MAX_TOTAL_MATCHES) { svc.setIsTruncated(true); break; }
          const fileBatch = ctx.files.slice(i, i + batchSize);
          const batchStart = performance.now();
          const contents = await svc.readBatch(fileBatch);
          const batchEnd = performance.now();

          processed += fileBatch.length;
          if (contents.length > 0) {
            worker.postMessage({
              type: 'search',
              files: contents,
              query: ctx.searchQuery,
              options: { caseSensitive: ctx.caseSensitive, wholeWord: ctx.wholeWord, regex: ctx.useRegex },
              totalMatchesSoFar,
              maxTotalMatches: MAX_TOTAL_MATCHES,
              searchId: ctx.currentSearchId,
            });
          }

          batchSize = svc.computeAdaptiveBatchSize(batchSize, batchEnd - batchStart);
          await new Promise<void>(r => requestAnimationFrame(() => r()));
        }

        worker.removeEventListener('message', onMessage);
        const results = Array.from(mergedResults.values());
        resolve({ results, hits: results.length, truncated: totalMatchesSoFar >= MAX_TOTAL_MATCHES });
      };

      sendBatches().catch((err) => {
        worker.removeEventListener('message', onMessage);
        console.error('[WorkerSearch] 发送批次失败:', err);
        resolve({ results: [], hits: 0, truncated: false });
      });
    });

    return workerPromise;
  }
}

/** 搜索策略注册表 */
class SearchStrategyRegistry {
  private strategies: SearchStrategy[] = [];

  constructor() {
    this.register(new IndexedSearchStrategy());
    this.register(new WorkerSearchStrategy());
  }

  register(strategy: SearchStrategy): void {
    this.strategies.push(strategy);
  }

  select(ctx: SearchContext): SearchStrategy {
    for (const s of this.strategies) {
      if (s.canHandle(ctx)) return s;
    }
    return this.strategies[this.strategies.length - 1]; // 兜底
  }
}

const strategyRegistry = new SearchStrategyRegistry();

/* ─── Hook 接口 ─── */

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

/** 卡尔曼滤波器估计文件读取速度（用于自适应批量大小） */
function computeAdaptiveBatchSizeKalman(
  prevBatchSize: number,
  prevBatchDurationMs: number,
  kf: KalmanFilter
): number {
  const targetMs = 50;
  if (prevBatchDurationMs <= 0) return prevBatchSize;
  const ratio = targetMs / Math.max(prevBatchDurationMs, 1);
  // 卡尔曼滤波平滑处理 ratio
  const filteredRatio = kf.filter(ratio);
  const newSize = prevBatchSize * (0.7 + 0.3 * filteredRatio);
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
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fileCacheRef = useRef<{ entriesSrc: string; files: { path: string; source: FileSource }[] } | null>(null);
  const indexRef = useRef<{ entriesSrc: string; index: InvertedIndex } | null>(null);

  // PID 控制器：自适应防抖延迟
  const pidRef = useRef(new PIDController({
    Kp: 0.5, Ki: 0.05, Kd: 0.1,
    outMin: 80, outMax: 500,
    integralMax: 50,
  }));
  // 卡尔曼滤波器：文件读取速度估计
  const kfRef = useRef(new KalmanFilter({ Q: 0.05, R: 0.3, initialX: 1.0, initialP: 0.5 }));

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

    // PID 控制器计算防抖延迟
    const error = 0; // 目标误差为 0（即时响应）
    const measurement = query.length > 3 ? 0.5 : 1.0; // 查询越长越应降低延迟
    const delay = pidRef.current.update(error, measurement, 0.1);

    debounceRef.current = setTimeout(() => { void handleSearchInternal(query); }, Math.round(delay));
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

  const collectAllFilesIterative = useCallback(
    async (
      rootItems: FileEntry[],
      outFiles: { path: string; source: FileSource }[] = []
    ): Promise<void> => {
      const skipDirs = new Set([
        'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
        'out', '.vscode', '.idea', '__pycache__', 'vendor', '.yarn',
      ]);

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
      let currentBatchSize = batchSizeRef.current;

      for (let i = 0; i < files.length; i += currentBatchSize) {
        const batch = files.slice(i, i + currentBatchSize);
        const batchStart = performance.now();
        const contents = await readBatch(batch);
        const batchEnd = performance.now();

        index.indexFiles(contents);

        // 卡尔曼滤波自适应批量大小
        batchSizeRef.current = computeAdaptiveBatchSizeKalman(
          currentBatchSize,
          batchEnd - batchStart,
          kfRef.current
        );
        currentBatchSize = batchSizeRef.current;
      }
      return index;
    },
    [readBatch]
  );

  const handleSearchInternal = useCallback(async (searchQuery: string) => {
    if (!searchQuery.trim() || !entries.length) return;
    const currentSearchId = ++searchIdRef.current;

    setIsSearching(true);
    setResults([]);
    setSearchedCount(0);
    setTotalFileCount(0);
    setIsTruncated(false);

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

    const ctx: SearchContext = {
      files: allFiles,
      searchQuery,
      caseSensitive,
      wholeWord,
      useRegex,
      fuzzyMode,
      currentSearchId,
    };

    const services: SearchStrategyServices = {
      readBatch,
      getWorker,
      setResults,
      setSearchedCount,
      setTotalFileCount,
      setIsTruncated,
      setIsSearching,
      setFuzzyMode,
      buildIndex,
      computeAdaptiveBatchSize: (prevSize, durationMs) =>
        computeAdaptiveBatchSizeKalman(prevSize, durationMs, kfRef.current),
    };

    const strategy = strategyRegistry.select(ctx);

    try {
      await strategy.execute(ctx, services);
    } catch (err) {
      console.warn(`[SearchPanel] 搜索策略 ${strategy.name} 失败:`, err);
      // 降级到 Worker 策略
      const fallback = new WorkerSearchStrategy();
      setIsSearching(true);
      setResults([]);
      await fallback.execute(ctx, services);
    } finally {
      if (searchIdRef.current === currentSearchId) setIsSearching(false);
    }
  }, [entries, caseSensitive, wholeWord, useRegex, fuzzyMode, collectAllFilesIterative, readBatch, getWorker, buildIndex]);

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
