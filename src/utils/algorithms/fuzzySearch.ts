/**
 * 模糊搜索算法 (Fuzzy Search)
 * ============================================================================
 * 
 * 应用场景：命令面板 (Cmd+P) 快速定位文件
 * 例如输入 "apptsx" → 匹配 "src/App.tsx"
 * 
 * 算法原理：
 * 基于动态规划计算「最优匹配得分」，综合考虑以下因素：
 * 1. 字符匹配：query 中每个字符在 target 中的位置
 * 2. 连续匹配奖励：连续匹配的字符给予更高权重
 * 3. 首字母匹配奖励：路径分隔符后的首字母匹配加分
 * 4. 位置惩罚：匹配位置越靠前得分越高
 * 
 * 时间复杂度：O(m × n)，m=query长度, n=target长度
 * 空间复杂度：O(n)
 * 
 * 参考：VS Code 的 fuzzy scoring 算法实现
 * ============================================================================
 */

export interface FuzzyResult {
  target: string;
  score: number;
  /** 匹配位置的布尔数组，用于高亮显示 */
  matches: boolean[];
  /** 是否完全匹配 */
  isExact: boolean;
}

const BONUS_PREFIX = 10;        // 前缀匹配奖励
const BONUS_WORD_START = 8;     // 单词首字母匹配（如 / 后的字符）
const BONUS_CONSECUTIVE = 6;    // 连续匹配奖励
const BONUS_CAMEL_CASE = 4;     // 驼峰命名匹配
const PENALTY_LEADING = -3;     // 前导未匹配字符惩罚（逐字符递减）
const PENALTY_MAX_LEADING = -9; // 最大前导惩罚
const PENALTY_UNMATCHED = -1;   // 未匹配字符惩罚

/**
 * 判断字符是否为单词分隔符
 */
function isSeparator(ch: string): boolean {
  return ch === '/' || ch === '\\' || ch === '_' || ch === '-' || ch === '.' || ch === ' ';
}

/**
 * 判断字符是否为大写字母
 */
function isUpper(ch: string): boolean {
  return ch >= 'A' && ch <= 'Z';
}

/**
 * 计算匹配得分矩阵
 * 
 * 使用动态规划，dp[i][j] 表示 query[0..i] 匹配到 target[0..j] 的最高得分
 * 为优化空间，只保留前一行的状态（滚动数组）
 */
function computeScoreMatrix(query: string, target: string): number[][] {
  const m = query.length;
  const n = target.length;
  
  // prev[j] = 上一行（i-1）在位置 j 的最优得分
  // curr[j] = 当前行（i）在位置 j 的最优得分
  const prev = new Array(n).fill(0);
  const curr = new Array(n).fill(0);
  
  // 记录每个位置的匹配决策，用于回溯高亮
  const matchMatrix: number[][] = [];

  for (let i = 0; i < m; i++) {
    const qch = query[i].toLowerCase();
    let maxPrev = -Infinity;
    
    for (let j = i; j < n; j++) {
      const tch = target[j].toLowerCase();
      
      if (qch === tch) {
        // 字符匹配：计算得分
        let score = 0;
        
        // 基础匹配分
        score += 1;
        
        // 前缀奖励：query 首字符匹配 target 首字符
        if (i === 0 && j === 0) {
          score += BONUS_PREFIX;
        }
        
        // 单词首字母奖励
        if (j === 0 || isSeparator(target[j - 1])) {
          score += BONUS_WORD_START;
        }
        
        // 驼峰奖励：小写后大写（如 appTsx 中的 T）
        if (j > 0 && isUpper(target[j]) && !isUpper(target[j - 1])) {
          score += BONUS_CAMEL_CASE;
        }
        
        // 连续匹配奖励
        if (i > 0 && j > 0 && prev[j - 1] > 0) {
          score += BONUS_CONSECUTIVE;
        }
        
        // 继承之前的最优路径
        if (i === 0) {
          // 第一个字符：考虑前导惩罚
          const leadingPenalty = Math.max(j * PENALTY_LEADING, PENALTY_MAX_LEADING);
          curr[j] = score + leadingPenalty;
        } else if (maxPrev > -Infinity) {
          curr[j] = score + maxPrev;
        }
        
        // 记录匹配位置得分
        if (!matchMatrix[i]) matchMatrix[i] = [];
        matchMatrix[i][j] = curr[j];
      } else {
        curr[j] = -Infinity; // 不匹配
      }
      
      // 更新 maxPrev 为下一列做准备
      if (i > 0 && j > 0) {
        maxPrev = Math.max(maxPrev, prev[j - 1]);
      }
    }
    
    // 交换数组
    for (let j = 0; j < n; j++) {
      prev[j] = curr[j];
      curr[j] = -Infinity;
    }
  }
  
  return matchMatrix;
}

/**
 * 回溯匹配路径，生成高亮数组
 */
function backtrackMatches(
  query: string,
  target: string,
  matchMatrix: number[][]
): boolean[] {
  const m = query.length;
  const n = target.length;
  const matches = new Array(n).fill(false);
  
  if (m === 0 || matchMatrix.length === 0) return matches;
  
  // 从最后一行找最优匹配位置
  let bestJ = -1;
  let bestScore = -Infinity;
  for (let j = 0; j < n; j++) {
    if (matchMatrix[m - 1][j] > bestScore) {
      bestScore = matchMatrix[m - 1][j];
      bestJ = j;
    }
  }
  
  if (bestJ < 0) return matches;
  
  // 回溯
  let j = bestJ;
  for (let i = m - 1; i >= 0; i--) {
    matches[j] = true;
    if (i > 0) {
      // 找上一行在 j 之前的最优匹配
      let bestPrevJ = -1;
      let bestPrevScore = -Infinity;
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
 * 对单个目标进行模糊匹配评分
 */
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
  
  // 快速路径：query 长度大于 target，不可能匹配
  if (query.length > target.length) return null;
  
  // 快速路径：精确匹配
  if (query.toLowerCase() === target.toLowerCase()) {
    return {
      target,
      score: Infinity,
      matches: new Array(target.length).fill(true),
      isExact: true,
    };
  }
  
  const matchMatrix = computeScoreMatrix(query, target);
  
  if (matchMatrix.length === 0 || !matchMatrix[query.length - 1]) {
    return null;
  }
  
  // 计算最终得分（考虑未匹配字符惩罚）
  const lastRow = matchMatrix[query.length - 1];
  let bestScore = -Infinity;
  for (let j = 0; j < target.length; j++) {
    if (lastRow[j] > bestScore) {
      bestScore = lastRow[j];
    }
  }
  
  if (bestScore === -Infinity) return null;
  
  // 未匹配字符惩罚
  const unmatchedCount = target.length - query.length;
  bestScore += unmatchedCount * PENALTY_UNMATCHED;
  
  const matches = backtrackMatches(query, target, matchMatrix);
  
  return {
    target,
    score: bestScore,
    matches,
    isExact: false,
  };
}

/**
 * 在多个目标中执行模糊搜索，返回排序后的结果
 * 
 * 使用示例：
 * const results = fuzzySearch('app', [
 *   'src/App.tsx',
 *   'src/api/user.ts',
 *   'src/components/Button.tsx'
 * ]);
 */
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
  
  // 按得分降序排列
  return results.sort((a, b) => b.score - a.score);
}

/**
 * 带缓存的模糊搜索（避免重复计算）
 *
 * 缓存 key 设计：query + targets 前 20 项的预览 hash + targets 总数。
 * 避免大数组完全 join 的开销，同时能区分不同内容。
 */
export class FuzzySearchEngine {
  private cache = new Map<string, FuzzyResult[]>();
  private cacheSize = 50;

  private makeKey(query: string, targets: string[]): string {
    const preview = targets.slice(0, 20).join('\0');
    // 用长度 + 前 200 字符作为内容指纹，避免大字符串完全哈希
    return `${query}::${targets.length}::${preview.length}::${preview.slice(0, 200)}`;
  }

  search(query: string, targets: string[]): FuzzyResult[] {
    const key = this.makeKey(query, targets);

    if (this.cache.has(key)) {
      return this.cache.get(key)!;
    }

    const results = fuzzySearch(query, targets);

    // LRU 缓存淘汰
    if (this.cache.size >= this.cacheSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, results);
    return results;
  }

  clearCache() {
    this.cache.clear();
  }
}
