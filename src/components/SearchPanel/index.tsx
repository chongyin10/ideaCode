import { useState, useCallback, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import {
  Search,
  ChevronRight,
  CaseSensitive,
  WholeWord,
  Regex,
  Replace,
  ReplaceAll,
  X,
} from 'lucide-react';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { openFile, setSearchHighlight, setPendingSearchQuery } from '../../store/slices/workspaceSlice';
import { readFile, isElectron } from '../../services/fileService';
import type { FileEntry, FileSource } from '../../services/fileService';
import type { MatchResult } from '../../utils/algorithms';
import './SearchPanel.css';

interface SearchMatch {
  line: number;
  column: number;
  text: string;
  match: MatchResult;
  isFileNameMatch?: boolean;
}

interface FileSearchResult {
  filePath: string;
  fileName: string;
  matches: SearchMatch[];
  expanded: boolean;
}

const MAX_TOTAL_MATCHES = 500;
const READ_BATCH_SIZE = 8;          // 每批并行读取的文件数

/**
 * Glob 模式匹配（带 RegExp 缓存）
 *
 * 优化点：避免每次调用都重新编译正则表达式，对于批量文件搜索能显著降低 GC 压力。
 */
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
      if (firstKey !== undefined) {
        globRegexCache.delete(firstKey);
      }
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

/**
 * 搜索面板 - Worker 线程版
 *
 * 架构：
 * 1. 主线程（UI）负责：收集文件路径 → 读取文件内容 → 发送给 Worker
 * 2. Worker 线程负责：在字符串内容中执行 Boyer-Moore 搜索
 * 3. Worker 返回增量结果，主线程实时合并更新 UI
 * 4. 搜索完成后 Worker 自动闲置，不占用资源
 */
export interface SearchPanelRef {
  triggerSearch: (query: string) => void;
}

const SearchPanel = forwardRef<SearchPanelRef>((_props, ref) => {
  const dispatch = useAppDispatch();

  // 选择性订阅 Redux：避免整个 workspace 变化触发 SearchPanel 重渲染
  const entries = useAppSelector((state) => state.workspace.entries);
  const pendingSearchQuery = useAppSelector((state) => state.workspace.pendingSearchQuery);

  const [query, setQuery] = useState('');
  const [replaceQuery, setReplaceQuery] = useState('');
  const [includePattern, setIncludePattern] = useState('');
  const [excludePattern, setExcludePattern] = useState('node_modules, .git, dist, build');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [searchedCount, setSearchedCount] = useState(0);
  const [totalFileCount, setTotalFileCount] = useState(0);
  const [results, setResults] = useState<FileSearchResult[]>([]);
  const [isTruncated, setIsTruncated] = useState(false);

  // Worker 引用
  const workerRef = useRef<Worker | null>(null);
  const abortRef = useRef(false);
  const totalMatchesRef = useRef(0);

  // 暴露给父组件的方法
  useImperativeHandle(ref, () => ({
    triggerSearch: (q: string) => {
      setQuery(q);
      setTimeout(() => {
        handleSearchRef.current?.();
      }, 0);
    },
  }));

  const handleSearchRef = useRef<(() => void) | null>(null);

  // 监听外部触发的搜索请求
  useEffect(() => {
    if (pendingSearchQuery) {
      setQuery(pendingSearchQuery);
      dispatch(setPendingSearchQuery(null));
      setTimeout(() => {
        handleSearchRef.current?.();
      }, 80);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSearchQuery]);

  // 初始化 Worker（懒加载，首次搜索时才创建）
  const getWorker = useCallback((): Worker => {
    if (!workerRef.current) {
      workerRef.current = new Worker(
        new URL('../../workers/search.worker.ts', import.meta.url),
        { type: 'module' }
      );
    }
    return workerRef.current;
  }, []);

  // 组件卸载时终止 Worker
  useEffect(() => {
    return () => {
      abortRef.current = true;
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  /**
   * 收集所有文件路径（递归遍历目录树）
   */
  const collectAllFiles = useCallback(
    async (
      items: FileEntry[],
      prefix = '',
      outFiles: { path: string; source: FileSource }[] = []
    ): Promise<void> => {
      for (const item of items) {
        if (abortRef.current) return;

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
          } catch {
            // 跳过
          }
        }
      }
    },
    [includePattern, excludePattern]
  );

  /**
   * 并行读取一批文件内容
   */
  const readBatch = useCallback(
    async (
      batch: { path: string; source: FileSource }[]
    ): Promise<{ path: string; content: string }[]> => {
      const settled = await Promise.allSettled(
        batch.map(async (file) => {
          const content = await readFile(file.source);
          return { path: file.path, content };
        })
      );
      const out: { path: string; content: string }[] = [];
      for (const r of settled) {
        if (r.status === 'fulfilled') out.push(r.value);
      }
      return out;
    },
    []
  );

  /**
   * 执行搜索
   */
  const handleSearch = useCallback(async () => {
    if (!query.trim() || !entries.length) return;

    // 取消之前的搜索
    abortRef.current = true;
    // 短暂延迟确保上一轮的 Worker 消息处理完毕
    await new Promise((r) => setTimeout(r, 50));
    abortRef.current = false;

    setIsSearching(true);
    setResults([]);
    setSearchedCount(0);
    setTotalFileCount(0);
    setIsTruncated(false);
    totalMatchesRef.current = 0;

    const worker = getWorker();

    // 阶段 1: 收集文件路径
    const allFiles: { path: string; source: FileSource }[] = [];
    await collectAllFiles(entries, '', allFiles);

    if (abortRef.current) {
      allFiles.length = 0;
      setIsSearching(false);
      return;
    }

    setTotalFileCount(allFiles.length);

    // 阶段 2: 分批读取 → 发送 Worker → 接收结果
    const mergedResults = new Map<string, FileSearchResult>();
    let processed = 0;

    // 设置 Worker 消息监听（单次搜索周期内复用）
    const onMessage = (event: MessageEvent) => {
      const { type, results: batchResults, totalMatches, isTruncated } = event.data;

      if (type === 'progress') {
        // 合并增量结果
        for (const r of batchResults as FileSearchResult[]) {
          const existing = mergedResults.get(r.filePath);
          if (existing) {
            existing.matches.push(...r.matches);
          } else {
            mergedResults.set(r.filePath, { ...r });
          }
        }

        totalMatchesRef.current = totalMatches;
        if (isTruncated) setIsTruncated(true);

        // 实时更新 UI（快照）
        setResults(Array.from(mergedResults.values()));
        setSearchedCount(processed);
      }
    };

    worker.addEventListener('message', onMessage);

    try {
      for (let i = 0; i < allFiles.length; i += READ_BATCH_SIZE) {
        if (abortRef.current) break;
        if (totalMatchesRef.current >= MAX_TOTAL_MATCHES) {
          setIsTruncated(true);
          break;
        }

        // 读取一批文件
        const fileBatch = allFiles.slice(i, i + READ_BATCH_SIZE);
        const contents = await readBatch(fileBatch);
        processed += fileBatch.length;

        // 释放已处理文件的源路径引用，减少搜索期间的内存峰值
        for (let k = 0; k < fileBatch.length; k++) {
          fileBatch[k] = { path: '', source: '' as FileSource };
        }

        if (contents.length === 0) continue;
        if (abortRef.current) break;

        // 发送给 Worker 搜索
        worker.postMessage({
          type: 'search',
          files: contents,
          query,
          options: { caseSensitive, wholeWord, regex: useRegex },
          totalMatchesSoFar: totalMatchesRef.current,
          maxTotalMatches: MAX_TOTAL_MATCHES,
        });

        // 等待 Worker 处理完这一批再继续读取下一批
        await new Promise((r) => setTimeout(r, 10));
      }

      // 最终快照
      if (!abortRef.current) {
        setResults(Array.from(mergedResults.values()));
        setSearchedCount(processed);
      }
    } finally {
      worker.removeEventListener('message', onMessage);
      // 主动释放搜索期间的临时数据结构，帮助 GC
      allFiles.length = 0;
      mergedResults.clear();
      if (!abortRef.current) {
        setIsSearching(false);
      }
    }
  }, [query, entries, caseSensitive, wholeWord, useRegex, collectAllFiles, readBatch, getWorker]);

  handleSearchRef.current = handleSearch;

  /**
   * 取消搜索
   */
  const handleCancel = useCallback(() => {
    abortRef.current = true;
    setIsSearching(false);
  }, []);

  /**
   * 点击搜索结果跳转到对应文件位置
   */
  const handleMatchClick = useCallback(
    (filePath: string, match: SearchMatch) => {
      const fileSource = isElectron() ? filePath : null;
      if (!fileSource) return;

      // 设置搜索高亮状态（MonacoEditor 会读取并应用）
      dispatch(
        setSearchHighlight({
          keyword: query,
          line: match.line,
          column: match.column,
        })
      );

      const entry: FileEntry = {
        name: filePath.slice(filePath.lastIndexOf('/') + 1),
        kind: 'file',
        source: fileSource,
      };
      dispatch(openFile(entry));
    },
    [dispatch, query]
  );

  const toggleFileExpanded = useCallback((index: number) => {
    setResults((prev) =>
      prev.map((r, i) => (i === index ? { ...r, expanded: !r.expanded } : r))
    );
  }, []);

  const totalMatches = results.reduce((sum, r) => sum + r.matches.length, 0);
  const totalFiles = results.length;

  return (
    <div className="search-panel">
      {/* 搜索输入 */}
      <div className="search-panel__inputs">
        <div className="search-input-wrap">
          <input
            type="text"
            placeholder="搜索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
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
          </div>
        </div>

        {showReplace && (
          <div className="search-panel__replace">
            <input
              type="text"
              placeholder="替换"
              value={replaceQuery}
              onChange={(e) => setReplaceQuery(e.target.value)}
            />
            <div className="replace-actions">
              <button title="替换">
                <Replace size={14} strokeWidth={1.5} />
              </button>
              <button title="全部替换">
                <ReplaceAll size={14} strokeWidth={1.5} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 包含/排除过滤 */}
      <div className="search-panel__filters">
        <div className="filter-row">
          <label>包含</label>
          <input
            type="text"
            placeholder="例如: *.ts, *.tsx"
            value={includePattern}
            onChange={(e) => setIncludePattern(e.target.value)}
          />
        </div>
        <div className="filter-row">
          <label>排除</label>
          <input
            type="text"
            placeholder="例如: node_modules, dist"
            value={excludePattern}
            onChange={(e) => setExcludePattern(e.target.value)}
          />
        </div>
      </div>

      {/* 搜索按钮 */}
      <div className="search-panel__action-bar">
        <button
          className="search-btn"
          onClick={isSearching ? handleCancel : handleSearch}
          disabled={!query.trim()}
        >
          {isSearching ? (
            <>
              <X size={14} strokeWidth={1.5} />
              取消
            </>
          ) : (
            <>
              <Search size={14} strokeWidth={1.5} />
              搜索
            </>
          )}
        </button>
        <button
          className="search-btn"
          style={{ background: '#3c3c3c', flex: '0 0 auto' }}
          onClick={() => setShowReplace((v) => !v)}
        >
          {showReplace ? '隐藏替换' : '替换'}
        </button>
      </div>

      {/* 结果统计 */}
      {(results.length > 0 || isSearching) && (
        <div className="search-panel__stats">
          {isSearching
            ? `正在搜索... ${searchedCount}/${totalFileCount} 文件`
            : `${totalFiles} 文件中有 ${totalMatches} 个结果${
                isTruncated ? '（已截断，最多 500 个）' : ''
              }`}
        </div>
      )}

      {/* 结果列表 */}
      <div className="search-panel__results">
        {results.length === 0 && !isSearching && query && (
          <div className="search-panel__empty">
            {isTruncated ? '结果过多，已截断显示' : '未找到匹配结果'}
          </div>
        )}

        {results.map((fileResult, fileIndex) => (
          <div key={fileResult.filePath} className="search-result-file">
            <div
              className={`search-result-file__header ${fileResult.expanded ? 'expanded' : ''}`}
              onClick={() => toggleFileExpanded(fileIndex)}
            >
              <ChevronRight size={14} strokeWidth={1.5} />
              <span className="search-result-file__name">{fileResult.fileName}</span>
              <span className="search-result-file__count">
                {fileResult.matches.length}
              </span>
            </div>

            {fileResult.expanded && (
              <div className="search-result-matches">
                {fileResult.matches.map((match, matchIndex) => (
                  <div
                    key={matchIndex}
                    className={`search-result-match ${match.isFileNameMatch ? 'search-result-match--filename' : ''}`}
                    onClick={() => handleMatchClick(fileResult.filePath, match)}
                  >
                    <span className="search-result-match__line-num">
                      {match.isFileNameMatch ? '📄' : match.line}
                    </span>
                    <span className="search-result-match__text">
                      <HighlightText
                        text={match.text}
                        matchIndex={match.isFileNameMatch ? match.match.index : match.match.index - Math.max(0, match.match.index - 40)}
                        matchLength={match.match.length}
                      />
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
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

  return (
    <>
      {before}
      <mark>{matched}</mark>
      {after}
    </>
  );
};

export default SearchPanel;
