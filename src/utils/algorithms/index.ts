/**
 * 算法工具库
 *
 * 为 IDE 各功能模块提供底层算法支持：
 * - 模糊搜索：文件快速定位（注意力加权 + 归一化评分 + LRU 缓存）
 * - Trie 树：命令补全、前缀搜索
 * - LRU 缓存：文件内容缓存
 * - Aho-Corasick：多模式文本搜索（代码高亮、批量搜索）
 * - Boyer-Moore-Horspool：单模式文本查找
 * - Myers Diff：O(ND) 文件版本对比
 * - Damerau-Levenshtein + Jaro-Winkler：拼写纠错
 * - Inverted Index + BM25 + BK-Tree + SPSA 调参：全文搜索
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
  AhoCorasick,
} from './boyerMoore';
export type { MatchResult, SearchOptions } from './boyerMoore';

export {
  computeDiff,
  formatUnifiedDiff,
  inlineDiff,
  diffToHtml,
} from './diff';
export type { DiffType, DiffChunk, DiffResult } from './diff';

export { InvertedIndex } from './invertedIndex';
export type { IndexEntry, SearchHit } from './invertedIndex';

export {
  levenshteinDistance,
  levenshteinSimilarity,
  jaroWinkler,
  fuzzyMatch,
} from './levenshtein';
export type { FuzzyMatchResult } from './levenshtein';
