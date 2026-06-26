/**
 * 算法工具库
 *
 * 为 IDE 各功能模块提供底层算法支持：
 * - 模糊搜索：文件快速定位（注意力加权 + 归一化评分 + LRU 缓存）
 * - Trie 树：命令补全、前缀搜索
 * - LRU 缓存：文件内容缓存
 * - W-TinyLFU：高级缓存替换策略（Count-Min Sketch）
 * - Aho-Corasick：多模式文本搜索（代码高亮、批量搜索）
 * - Boyer-Moore-Horspool：单模式文本查找
 * - Myers Diff：O(ND) 文件版本对比
 * - Damerau-Levenshtein + Jaro-Winkler：拼写纠错
 * - Inverted Index + BM25 + BK-Tree + SPSA 调参：全文搜索
 * - PID Controller：自适应防抖/参数调优
 * - Kalman Filter：信号滤波/速度估计
 * - BCM Neural Tab Manager：神经启发 Tab 管理
 * - Node2Vec：图嵌入文件推荐
 * - Personalized PageRank：文件重要性排序
 * - Entropy File Prefetch：条件熵文件预取
 * - Thompson Sampling Bandit：多臂老虎机搜索排序
 * - Lyapunov Scheduler：Lyapunov 稳定性引导的自适应帧预算调度 (Θ-Algorithm)
 * - SimHash：局部敏感哈希预过滤 (LSH)
 * - Count-Min Sketch：概率计数搜索过滤
 * - Walsh-Hadamard Transform：快速正交变换 Diff 加速
 * - Incremental Entropy：递推 Shannon 熵增量更新
 */

export { fuzzySearch, fuzzyScore, FuzzySearchEngine } from './fuzzySearch';
export type { FuzzyResult } from './fuzzySearch';

export { Trie, PathTrie } from './trie';

export { LRUCache, FileContentCache } from './lruCache';
export type { CacheEntry } from './lruCache';

export { WTinyLFU } from './wTinyLFU';
export type { WTinyLFUConfig } from './wTinyLFU';

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
  computeDiffFast,
  computePatienceDiff,
  formatUnifiedDiff,
  inlineDiff,
  diffToHtml,
  grammarAwareDiff,
  semanticDiff,
} from './diff';
export type { DiffType, DiffChunk, DiffResult, GrammarDiffLine, SemanticDiffChunk } from './diff';

export { InvertedIndex } from './invertedIndex';
export type { IndexEntry, SearchHit } from './invertedIndex';

export {
  levenshteinDistance,
  levenshteinSimilarity,
  jaroWinkler,
  fuzzyMatch,
} from './levenshtein';
export type { FuzzyMatchResult } from './levenshtein';

export { PIDController } from './pidController';
export type { PIDConfig } from './pidController';

export { KalmanFilter, VectorKalmanFilter } from './kalmanFilter';
export type { KalmanConfig } from './kalmanFilter';

export { BCMTabManager } from './neuralTabManager';
export type { BCMTabState, BCMConfig } from './neuralTabManager';

export { Node2VecRecommender } from './node2vec';
export type { FileGraph, Node2VecConfig } from './node2vec';

export {
  personalizedPageRank,
  EntropyFilePrefetcher,
} from './filePrediction';
export type { FileTransitionStats } from './filePrediction';

export { SearchBanditRanker } from './searchBandit';
export type { BanditArm, BanditConfig, BanditStrategy } from './searchBandit';

// ── 数学优化模块 ──
export {
  GaussianKDE,
  goodTuringDiscount,
  BetaBernoulli,
  chebyshevAcceleratedIteration,
  lyapunovStabilityCheck,
  perronFrobeniusGap,
  CSRMatrix,
  nmf,
  spectralClustering,
  cpDecomposition,
  TFIDFCalculator,
} from './mathUtils';

export { ARCCache } from './arcCache';

export { FMIndex } from './fmIndex';

export { FileCommunityDetector } from './fileCommunity';
export type { FileCommunity, FileRelationGraph } from './fileCommunity';

// ── 高等数学 + 创新算法优化模块 ──
export {
  LyapunovScheduler,
  getGlobalScheduler,
  stopGlobalScheduler,
} from './lyapunovScheduler';
export type { SchedulerTask, LyapunovSchedulerConfig } from './lyapunovScheduler';

export {
  SimHashFilter,
  computeSimHash,
  hammingDistance,
  hammingDistanceFast,
} from './simHash';
export type { SimHashValue } from './simHash';

export {
  CountMinSketch,
  FileSearchPreFilter,
} from './countMinSketch';
export type { CountMinSketchConfig } from './countMinSketch';

export {
  fwht,
  WalshLineClusterer,
  computeWalshSignature,
  walshSignatureSimilarity,
} from './walshHadamard';

export {
  IncrementalEntropy,
  SlidingWindowEntropy,
} from './incrementalEntropy';
