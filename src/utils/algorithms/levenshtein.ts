/**
 * Levenshtein 编辑距离 + 模糊匹配
 *
 * 应用场景：搜索时对用户输入进行拼写纠错（typo-tolerant search）
 * 例如输入 "serach" → 仍然能匹配 "search"
 *
 * 算法原理：
 * 基于 Wagner-Fischer 动态规划，使用双行滚动数组将空间优化至 O(min(m,n))
 * 通过阈值参数实现提前终止，避免不必要的计算。
 *
 * 时间复杂度：O(m × n)，m=query长度, n=target长度
 * 空间复杂度：O(min(m,n))
 */

/**
 * 计算两个字符串的 Levenshtein 编辑距离
 * 使用双行滚动数组，支持提前终止阈值
 *
 * @returns 编辑距离，若超过 maxDistance 则返回 maxDistance + 1
 */
export function levenshteinDistance(
  a: string,
  b: string,
  maxDistance = Infinity
): number {
  const m = a.length;
  const n = b.length;

  // 快速路径
  if (Math.abs(m - n) > maxDistance) return maxDistance + 1;
  if (m === 0) return n <= maxDistance ? n : maxDistance + 1;
  if (n === 0) return m <= maxDistance ? m : maxDistance + 1;

  // 确保 a 是较短的字符串（空间优化）
  const short = m <= n ? a : b;
  const long  = m <= n ? b : a;
  const slen = short.length;
  const llen = long.length;

  // 双行滚动数组
  let prev = new Uint16Array(slen + 1);
  let curr = new Uint16Array(slen + 1);

  for (let j = 0; j <= slen; j++) {
    prev[j] = j;
  }

  for (let i = 1; i <= llen; i++) {
    curr[0] = i;
    let rowMin = i;

    const start = Math.max(1, i - maxDistance);
    const end   = Math.min(slen, i + maxDistance);

    for (let j = start; j <= end; j++) {
      const cost = long[i - 1] === short[j - 1] ? 0 : 1;
      const sub  = prev[j - 1] + cost;      // substitution
      const ins  = curr[j - 1] + 1;          // insertion
      const del  = prev[j] + 1;              // deletion
      curr[j] = Math.min(sub, ins, del);
      if (curr[j] < rowMin) rowMin = curr[j];
    }

    if (rowMin > maxDistance) return maxDistance + 1;

    // 交换滚动数组
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  return prev[slen] <= maxDistance ? prev[slen] : maxDistance + 1;
}

/**
 * 计算归一化相似度（0-1），1 表示完全相同
 */
export function levenshteinSimilarity(a: string, b: string): number {
  const dist = levenshteinDistance(a.toLowerCase(), b.toLowerCase());
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - dist / maxLen;
}

export interface FuzzyMatchResult {
  /** 目标字符串 */
  target: string;
  /** 归一化相似度 (0-1) */
  similarity: number;
  /** 编辑距离 */
  distance: number;
}

/**
 * 在候选项中执行模糊匹配，返回按相似度降序的结果
 *
 * @param query    用户输入
 * @param targets  候选项列表
 * @param threshold 最低相似度阈值 (0-1)，默认 0.5
 * @param maxResults 最大返回数量
 */
export function fuzzyMatch(
  query: string,
  targets: string[],
  threshold = 0.5,
  maxResults = 20
): FuzzyMatchResult[] {
  if (!query) return [];

  const lowerQuery = query.toLowerCase();
  const results: FuzzyMatchResult[] = [];

  // 子串匹配优先（快速的提前筛选）
  const substringMatches: FuzzyMatchResult[] = [];
  const fuzzyMatches: FuzzyMatchResult[] = [];

  for (const target of targets) {
    const lowerTarget = target.toLowerCase();

    // 精确匹配：最高优先级
    if (lowerTarget === lowerQuery) {
      results.push({ target, similarity: 1, distance: 0 });
      continue;
    }

    // 子串包含：高优先级
    if (lowerTarget.includes(lowerQuery)) {
      substringMatches.push({
        target,
        similarity: lowerQuery.length / lowerTarget.length,
        distance: lowerTarget.length - lowerQuery.length,
      });
      continue;
    }

    // 编辑距离计算
    const dist = levenshteinDistance(
      lowerQuery,
      lowerTarget,
      Math.floor(Math.min(lowerQuery.length, lowerTarget.length) * (1 - threshold))
    );

    const sim = 1 - dist / Math.max(lowerQuery.length, lowerTarget.length);
    if (sim >= threshold) {
      fuzzyMatches.push({ target, similarity: sim, distance: dist });
    }
  }

  // 合并排序：精确匹配 > 子串匹配 > 编辑距离匹配
  const merged = [...results, ...substringMatches, ...fuzzyMatches];
  merged.sort((a, b) => b.similarity - a.similarity);

  return merged.slice(0, maxResults);
}
