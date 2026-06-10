/**
 * 算法工具库
 * 
 * 为 IDE 各功能模块提供底层算法支持：
 * - 模糊搜索：文件快速定位
 * - Trie 树：命令补全、前缀搜索
 * - LRU 缓存：文件内容缓存
 * - Boyer-Moore：文本查找
 * - Diff：文件版本对比
 */

export { fuzzySearch, fuzzyScore, FuzzySearchEngine } from './fuzzySearch';
export type { FuzzyResult } from './fuzzySearch';

export { Trie, PathTrie } from './trie';

export { LRUCache, FileContentCache } from './lruCache';
export type { CacheEntry } from './lruCache';

export {
  horspoolSearch,
  horspoolSearchIgnoreCase,
  horspoolSearchWholeWord,
  searchInText,
  multiPatternSearch,
  highlightMatches,
} from './boyerMoore';
export type { MatchResult, SearchOptions } from './boyerMoore';

export {
  computeDiff,
  formatUnifiedDiff,
  inlineDiff,
  diffToHtml,
} from './diff';
export type { DiffType, DiffChunk, DiffResult } from './diff';
