/**
 * 模糊搜索算法 (Fuzzy Search) — 注意力加权 + 归一化评分
 * ============================================================================
 *
 * 应用场景：命令面板 (Cmd+P) 快速定位文件
 * 例如输入 "apptsx" → 匹配 "src/App.tsx"
 *
 * ## 算法原理：
 * 基于动态规划计算「最优匹配得分」，综合考虑以下因素：
 * 1. 字符匹配：query 中每个字符在 target 中的位置
 * 2. 连续匹配奖励：连续匹配的字符给予更高权重
 * 3. 首字母匹配奖励：路径分隔符后的首字母匹配加分
 * 4. 注意力加权：首尾字符权重高，中间字符权重衰减（系列位置效应）
 * 5. 长度归一化：得分除以 sqrt(queryLen × targetLen) 使跨查询可比
 *
 * 时间复杂度：O(m × n)，m=query长度, n=target长度
 * 空间复杂度：O(n)
 * ============================================================================
 */

import { LRUCache } from './lruCache';

export interface FuzzyResult {
  target: string;
  score: number;
  matches: boolean[];
  isExact: boolean;
}

/* ─── 得分常数（归一化后权重） ─── */

const BONUS_PREFIX = 4.0;
const BONUS_WORD_START = 3.0;
const BONUS_CONSECUTIVE = 2.5;
const BONUS_CAMEL_CASE = 2.0;
const PENALTY_LEADING = -1.2;
const PENALTY_MAX_LEADING = -6;
const PENALTY_UNMATCHED = -0.5;

/* ─── 注意力权重（系列位置效应） ─── */

/**
 * 计算 query 字符位置的注意力权重
 * 首字符权重最高，末尾次之，中间较低（U 型分布）
 * 使用对称 sigmoid 衰减：w_i = 1 + α × (1 - abs(i/mid - 1))
 */
function attentionWeights(queryLen: number): Float64Array {
  const weights = new Float64Array(queryLen);
  if (queryLen <= 1) {
    weights[0] = 1;
    return weights;
  }
  const mid = (queryLen - 1) / 2;
  let sum = 0;
  for (let i = 0; i < queryLen; i++) {
    weights[i] = 1 + 0.6 * (1 - Math.abs(i / mid - 1));
    sum += weights[i];
  }
  // 归一化到总和为 queryLen（保持基础分不变）
  const scale = queryLen / sum;
  for (let i = 0; i < queryLen; i++) {
    weights[i] *= scale;
  }
  return weights;
}

/* ─── 辅助函数 ─── */

function isSeparator(ch: string): boolean {
  return ch === '/' || ch === '\\' || ch === '_' || ch === '-' || ch === '.' || ch === ' ';
}

function isUpper(ch: string): boolean {
  return ch >= 'A' && ch <= 'Z';
}

/* ─── 核心评分算法 ─── */

function computeScoreMatrix(query: string, target: string, attnWeights: Float64Array): number[][] {
  const m = query.length;
  const n = target.length;

  const prev = new Array(n).fill(Number.NEGATIVE_INFINITY);
  const curr = new Array(n).fill(Number.NEGATIVE_INFINITY);

  const matchMatrix: number[][] = [];

  for (let i = 0; i < m; i++) {
    const qch = query[i].toLowerCase();
    let maxPrev = Number.NEGATIVE_INFINITY;

    for (let j = i; j < n; j++) {
      if (i > 0 && j > 0) {
        maxPrev = Math.max(maxPrev, prev[j - 1]);
      }

      const tch = target[j].toLowerCase();

      if (qch === tch) {
        let score = 0;

        // 基础匹配分 × 注意力权重
        score += 1 * attnWeights[i];

        // 前缀奖励
        if (i === 0 && j === 0) {
          score += BONUS_PREFIX;
        }

        // 单词首字母奖励
        if (j === 0 || isSeparator(target[j - 1])) {
          score += BONUS_WORD_START;
        }

        // 驼峰奖励
        if (j > 0 && isUpper(target[j]) && !isUpper(target[j - 1])) {
          score += BONUS_CAMEL_CASE;
        }

        // 连续匹配奖励
        if (i > 0 && j > 0 && prev[j - 1] > Number.NEGATIVE_INFINITY) {
          score += BONUS_CONSECUTIVE;
        }

        if (i === 0) {
          const leadingPenalty = Math.max(j * PENALTY_LEADING, PENALTY_MAX_LEADING);
          curr[j] = score + leadingPenalty;
        } else if (maxPrev > Number.NEGATIVE_INFINITY) {
          curr[j] = score + maxPrev;
        } else {
          curr[j] = Number.NEGATIVE_INFINITY;
        }

        if (!matchMatrix[i]) matchMatrix[i] = [];
        matchMatrix[i][j] = curr[j];
      } else {
        curr[j] = Number.NEGATIVE_INFINITY;
      }
    }

    for (let j = 0; j < n; j++) {
      prev[j] = curr[j];
      curr[j] = Number.NEGATIVE_INFINITY;
    }
  }

  return matchMatrix;
}

function backtrackMatches(
  query: string,
  target: string,
  matchMatrix: number[][]
): boolean[] {
  const m = query.length;
  const n = target.length;
  const matches = new Array(n).fill(false);

  if (m === 0 || matchMatrix.length === 0) return matches;

  let bestJ = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let j = 0; j < n; j++) {
    if (matchMatrix[m - 1][j] > bestScore) {
      bestScore = matchMatrix[m - 1][j];
      bestJ = j;
    }
  }

  if (bestJ < 0) return matches;

  let j = bestJ;
  for (let i = m - 1; i >= 0; i--) {
    matches[j] = true;
    if (i > 0) {
      let bestPrevJ = -1;
      let bestPrevScore = Number.NEGATIVE_INFINITY;
      for (let k = 0; k < j; k++) {
        if (matchMatrix[i - 1][k] > bestPrevScore) {
          bestPrevScore = matchMatrix[i - 1][k];
          bestPrevJ = k;
        }
      }
      if (bestPrevJ >= 0) {
        j = bestPrevJ;
      }
    }
  }

  return matches;
}

/**
 * 归一化原始得分为跨查询可比值
 * 使用公式：normalized = raw / sqrt(queryLen × targetLen)
 * 使得得分在相似条件下不随字符串长度增长而膨胀
 */
function normalizeScore(rawScore: number, queryLen: number, targetLen: number): number {
  if (rawScore <= Number.NEGATIVE_INFINITY + 100) return Number.NEGATIVE_INFINITY;
  const divisor = Math.sqrt(queryLen * Math.max(targetLen, 1));
  return rawScore / divisor;
}

export function fuzzyScore(query: string, target: string): FuzzyResult | null {
  if (!query) {
    return {
      target,
      score: 0,
      matches: new Array(target.length).fill(false),
      isExact: false,
    };
  }

  if (!target) return null;

  if (query.length > target.length) return null;

  if (query.toLowerCase() === target.toLowerCase()) {
    return {
      target,
      score: Infinity,
      matches: new Array(target.length).fill(true),
      isExact: true,
    };
  }

  const attnWeights = attentionWeights(query.length);
  const matchMatrix = computeScoreMatrix(query, target, attnWeights);

  if (matchMatrix.length === 0 || !matchMatrix[query.length - 1]) {
    return null;
  }

  const lastRow = matchMatrix[query.length - 1];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let j = 0; j < target.length; j++) {
    if (lastRow[j] > bestScore) {
      bestScore = lastRow[j];
    }
  }

  if (bestScore === Number.NEGATIVE_INFINITY) return null;

  const unmatchedCount = target.length - query.length;
  bestScore += unmatchedCount * PENALTY_UNMATCHED;

  const normalized = normalizeScore(bestScore, query.length, target.length);
  const matches = backtrackMatches(query, target, matchMatrix);

  return {
    target,
    score: normalized,
    matches,
    isExact: false,
  };
}

export function fuzzySearch(query: string, targets: string[]): FuzzyResult[] {
  if (!query) {
    return targets.map((t) => ({
      target: t,
      score: 0,
      matches: new Array(t.length).fill(false),
      isExact: false,
    }));
  }

  const results: FuzzyResult[] = [];

  for (const target of targets) {
    const result = fuzzyScore(query, target);
    if (result) {
      results.push(result);
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

/* ─── 带 LRU 缓存的模糊搜索引擎 ─── */

export class FuzzySearchEngine {
  private cache: LRUCache<string, FuzzyResult[]>;

  constructor(cacheSize = 100) {
    this.cache = new LRUCache<string, FuzzyResult[]>(cacheSize);
  }

  private makeKey(query: string, targets: string[]): string {
    const preview = targets.slice(0, 20).join('\0');
    return `${query}::${targets.length}::${preview.length}::${preview.slice(0, 200)}`;
  }

  search(query: string, targets: string[]): FuzzyResult[] {
    const key = this.makeKey(query, targets);

    const cached = this.cache.get(key);
    if (cached) {
      return cached.value;
    }

    const results = fuzzySearch(query, targets);
    this.cache.set(key, results);

    return results;
  }

  clearCache() {
    this.cache.clear();
  }

  getStats() {
    return this.cache.getStats();
  }
}
