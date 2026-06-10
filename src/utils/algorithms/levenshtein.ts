/**
 * Damerau-Levenshtein 编辑距离 + Jaro-Winkler 相似度 + 模糊匹配
 *
 * 应用场景：搜索时对用户输入进行拼写纠错（typo-tolerant search）
 * 例如输入 "serach" → 仍然能匹配 "search"
 *
 * ## Damerau-Levenshtein 算法原理：
 * 在标准 Levenshtein（插入/删除/替换）基础上增加「相邻字符交换」操作。
 * 这对于捕捉键盘打字时的键位交换错误（transposition）至关重要。
 *
 * 使用 Wagner-Fischer 动态规划矩阵，行滚动数组优化空间。
 * 增设提前终止阈值，超限即停止计算。
 *
 * 时间复杂度：O(m × n)，m=query长度, n=target长度
 * 空间复杂度：O(min(m,n))
 *
 * ## Jaro-Winkler 相似度：
 * 基于公共字符和交换次数计算相似度，对短字符串（文件名/标识符）特别有效。
 * Jaro: 0.33 × (m/|s1| + m/|s2| + (m-t)/m), m=匹配字符数, t=交换次数
 * Winkler 增强：前缀匹配加分（适合短字符串场景）
 */

/**
 * 计算两个字符串的 Damerau-Levenshtein 编辑距离
 * 使用双行滚动数组，支持提前终止阈值
 */
export function levenshteinDistance(
  a: string,
  b: string,
  maxDistance = Infinity
): number {
  const m = a.length;
  const n = b.length;

  if (Math.abs(m - n) > maxDistance) return maxDistance + 1;
  if (m === 0) return n <= maxDistance ? n : maxDistance + 1;
  if (n === 0) return m <= maxDistance ? m : maxDistance + 1;

  const short = m <= n ? a : b;
  const long  = m <= n ? b : a;
  const slen = short.length;
  const llen = long.length;

  // 三行滚动数组（Damerau-Levenshtein 需要记录前两行以检测交换）
  let prevPrev = new Uint16Array(slen + 1);
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

      // 三种标准操作
      const sub = prev[j - 1] + cost;
      const ins = curr[j - 1] + 1;
      const del = prev[j] + 1;
      let val = Math.min(sub, ins, del);

      // Damerau 交换操作
      if (
        i > 1 &&
        j > 1 &&
        long[i - 1] === short[j - 2] &&
        long[i - 2] === short[j - 1]
      ) {
        val = Math.min(val, prevPrev[j - 2] + cost);
      }

      curr[j] = val;
      if (val < rowMin) rowMin = val;
    }

    if (rowMin > maxDistance) return maxDistance + 1;

    // 滚动三行
    const tmp = prevPrev;
    prevPrev = prev;
    prev = curr;
    curr = tmp;
  }

  return prev[slen] <= maxDistance ? prev[slen] : maxDistance + 1;
}

export function levenshteinSimilarity(a: string, b: string): number {
  const dist = levenshteinDistance(a.toLowerCase(), b.toLowerCase());
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - dist / maxLen;
}

/* ─── Jaro-Winkler 相似度 ─── */

export function jaroWinkler(a: string, b: string, prefixScale = 0.1): number {
  const aLen = a.length;
  const bLen = b.length;
  if (aLen === 0 && bLen === 0) return 1;
  if (aLen === 0 || bLen === 0) return 0;

  const matchDist = Math.floor(Math.max(aLen, bLen) / 2) - 1;
  const aMatches = new Array(aLen).fill(false);
  const bMatches = new Array(bLen).fill(false);

  let matches = 0;

  for (let i = 0; i < aLen; i++) {
    const start = Math.max(0, i - matchDist);
    const end = Math.min(bLen, i + matchDist + 1);

    for (let j = start; j < end; j++) {
      if (!bMatches[j] && a[i] === b[j]) {
        aMatches[i] = true;
        bMatches[j] = true;
        matches++;
        break;
      }
    }
  }

  if (matches === 0) return 0;

  // 计算交换次数（transpositions）
  let k = 0;
  let trans = 0;
  for (let i = 0; i < aLen; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) trans++;
    k++;
  }
  trans = Math.floor(trans / 2);

  const jaro =
    (matches / aLen + matches / bLen + (matches - trans) / matches) / 3;

  // Winkler 增强：前缀匹配加分
  let prefix = 0;
  const maxPrefix = 4;
  for (let i = 0; i < Math.min(aLen, bLen, maxPrefix); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }

  return jaro + prefix * prefixScale * (1 - jaro);
}

export interface FuzzyMatchResult {
  target: string;
  similarity: number;
  distance: number;
  algorithm: 'damerau' | 'jaro-winkler';
}

/**
 * 在候选项中执行模糊匹配，返回按相似度降序的结果
 *
 * 对短字符串（≤6 字符，如文件名片段）使用 Jaro-Winkler，
 * 对长字符串使用 Damerau-Levenshtein 编辑距离。
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
  const substringMatches: FuzzyMatchResult[] = [];
  const fuzzyMatches: FuzzyMatchResult[] = [];

  const useJaro = lowerQuery.length <= 6;

  for (const target of targets) {
    const lowerTarget = target.toLowerCase();

    if (lowerTarget === lowerQuery) {
      results.push({ target, similarity: 1, distance: 0, algorithm: 'damerau' });
      continue;
    }

    if (lowerTarget.includes(lowerQuery)) {
      substringMatches.push({
        target,
        similarity: lowerQuery.length / lowerTarget.length,
        distance: lowerTarget.length - lowerQuery.length,
        algorithm: 'damerau' as const,
      });
      continue;
    }

    if (useJaro) {
      const sim = jaroWinkler(lowerQuery, lowerTarget);
      if (sim >= threshold) {
        fuzzyMatches.push({
          target,
          similarity: sim,
          distance: Math.round((1 - sim) * Math.max(lowerQuery.length, lowerTarget.length)),
          algorithm: 'jaro-winkler' as const,
        });
      }
    } else {
      const dist = levenshteinDistance(
        lowerQuery,
        lowerTarget,
        Math.floor(Math.min(lowerQuery.length, lowerTarget.length) * (1 - threshold))
      );
      const sim = 1 - dist / Math.max(lowerQuery.length, lowerTarget.length);
      if (sim >= threshold) {
        fuzzyMatches.push({ target, similarity: sim, distance: dist, algorithm: 'damerau' as const });
      }
    }
  }

  const merged = [...results, ...substringMatches, ...fuzzyMatches];
  merged.sort((a, b) => b.similarity - a.similarity);

  return merged.slice(0, maxResults);
}
