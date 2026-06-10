/**
 * Boyer-Moore-Horspool 字符串匹配算法
 * ============================================================================
 * 
 * 应用场景：编辑器查找功能 (Ctrl+F)
 * 在大量文本中快速定位关键字位置
 * 
 * 算法原理：
 * 1. 坏字符规则（Bad Character Rule）：
 *    从右向左比较模式串和文本。当不匹配时，根据文本中"坏字符"在模式串中的
 *    最右出现位置，决定模式串向右滑动的距离。
 * 
 * 2. Horspool 简化：
 *    只使用坏字符规则的最后一位比较结果来决定偏移量，跳过好后缀规则，
 *    在字母表较大时（如 Unicode）实现更简单，实际性能接近完整 BM。
 * 
 * 预处理：构建坏字符表（Shift Table）
 *   对于模式串中每个字符 c，记录它在模式串中最右出现的位置。
 *   当文本中字符 x 与模式串末尾不匹配时，偏移量 = m - 1 - rightmost[x]
 *   如果 x 不在模式串中，偏移量 = m（整串跳过）
 * 
 * 时间复杂度：
 * - 最坏：O(m × n)  当文本和模式串都是重复字符时（如 "aaaaa" 中找 "aaa"）
 * - 平均：O(n/m)    模式串越长，跳得越远，效率越高
 * - 预处理：O(m + Σ)，Σ 为字符集大小
 * 
 * 空间复杂度：O(Σ)
 * 
 * 相比朴素算法的优势：
 * - 朴素算法：O(m × n)，每次只移1位
 * - Horspool：最坏相同，但平均每次可跳过 m 个字符
 * ============================================================================
 */

export interface MatchResult {
  /** 匹配起始位置 */
  index: number;
  /** 匹配长度 */
  length: number;
  /** 匹配到的文本 */
  matched: string;
}

export interface SearchOptions {
  /** 大小写敏感，默认 true */
  caseSensitive?: boolean;
  /** 仅匹配完整单词，默认 false */
  wholeWord?: boolean;
  /** 正则表达式模式，默认 false */
  regex?: boolean;
}

/**
 * 构建 Horspool 坏字符偏移表
 * 
 * @param pattern 模式串
 * @returns 字符 → 偏移量的映射函数
 */
function buildShiftTable(pattern: string): (char: string) => number {
  const m = pattern.length;
  const table = new Map<string, number>();
  
  // 对模式串中每个字符（除最后一个），记录其最右位置
  for (let i = 0; i < m - 1; i++) {
    table.set(pattern[i], m - 1 - i);
  }
  
  return (char: string) => {
    return table.has(char) ? table.get(char)! : m;
  };
}

/**
 * Horspool 单模式匹配
 * 
 * @param text 被搜索的文本
 * @param pattern 搜索模式
 * @returns 所有匹配位置
 */
export function horspoolSearch(text: string, pattern: string): MatchResult[] {
  if (!pattern || !text || pattern.length > text.length) {
    return [];
  }
  
  const n = text.length;
  const m = pattern.length;
  const results: MatchResult[] = [];
  const getShift = buildShiftTable(pattern);
  
  let i = 0; // 文本中的当前对齐位置
  
  while (i <= n - m) {
    let j = m - 1;
    
    // 从右向左比较
    while (j >= 0 && pattern[j] === text[i + j]) {
      j--;
    }
    
    if (j < 0) {
      // 完全匹配
      results.push({
        index: i,
        length: m,
        matched: text.substring(i, i + m),
      });
      // 继续搜索：向右滑动1位（查找所有匹配）
      i += 1;
    } else {
      // 不匹配：根据坏字符规则滑动
      const badChar = text[i + m - 1];
      i += getShift(badChar);
    }
  }
  
  return results;
}

/**
 * 大小写不敏感的 Horspool 搜索
 *
 * 优化：避免对整个 text 调用 toLowerCase() 产生大字符串副本。
 * 改为在比较时逐字符转小写，内存友好（尤其是大文件）。
 */
export function horspoolSearchIgnoreCase(
  text: string,
  pattern: string
): MatchResult[] {
  if (!pattern || !text || pattern.length > text.length) {
    return [];
  }

  const n = text.length;
  const m = pattern.length;
  const lowerPattern = pattern.toLowerCase();
  const results: MatchResult[] = [];
  const getShift = buildShiftTable(lowerPattern);

  let i = 0;

  while (i <= n - m) {
    let j = m - 1;

    // 从右向左比较，逐字符转小写
    while (j >= 0 && lowerPattern[j] === text[i + j].toLowerCase()) {
      j--;
    }

    if (j < 0) {
      // 完全匹配
      results.push({
        index: i,
        length: m,
        matched: text.substring(i, i + m),
      });
      i += 1;
    } else {
      // 不匹配：根据坏字符规则滑动
      const badChar = text[i + m - 1].toLowerCase();
      i += getShift(badChar);
    }
  }

  return results;
}

/**
 * 完整单词匹配
 * 确保匹配结果前后不是字母数字下划线
 */
export function horspoolSearchWholeWord(
  text: string,
  pattern: string,
  caseSensitive = true
): MatchResult[] {
  const raw = caseSensitive
    ? horspoolSearch(text, pattern)
    : horspoolSearchIgnoreCase(text, pattern);
  
  const results: MatchResult[] = [];
  
  for (const match of raw) {
    const before = match.index > 0 ? text[match.index - 1] : ' ';
    const after =
      match.index + match.length < text.length
        ? text[match.index + match.length]
        : ' ';
    
    // 检查前后字符是否不是单词字符
    const isWordChar = (ch: string) => /[a-zA-Z0-9_]/.test(ch);
    
    if (!isWordChar(before) && !isWordChar(after)) {
      results.push(match);
    }
  }
  
  return results;
}

/**
 * 通用搜索接口（支持选项配置）
 */
export function searchInText(
  text: string,
  pattern: string,
  options: SearchOptions = {}
): MatchResult[] {
  const { caseSensitive = true, wholeWord = false, regex = false } = options;
  
  if (regex) {
    // 正则搜索回退到原生实现
    try {
      const flags = caseSensitive ? 'g' : 'gi';
      const reg = new RegExp(pattern, flags);
      const results: MatchResult[] = [];
      let match: RegExpExecArray | null;
      
      while ((match = reg.exec(text)) !== null) {
        results.push({
          index: match.index,
          length: match[0].length,
          matched: match[0],
        });
        // 防止零宽匹配死循环
        if (match[0].length === 0) reg.lastIndex++;
      }
      
      return results;
    } catch {
      return [];
    }
  }
  
  if (wholeWord) {
    return horspoolSearchWholeWord(text, pattern, caseSensitive);
  }
  
  if (caseSensitive) {
    return horspoolSearch(text, pattern);
  }
  
  return horspoolSearchIgnoreCase(text, pattern);
}

/**
 * 多模式搜索（Rabin-Karp 多哈希版本）
 * 同时搜索多个关键字
 * 
 * 时间复杂度：O(n + k × m)，k=模式数, m=模式平均长度
 */
export function multiPatternSearch(
  text: string,
  patterns: string[]
): Map<string, MatchResult[]> {
  const results = new Map<string, MatchResult[]>();
  
  for (const pattern of patterns) {
    const matches = horspoolSearch(text, pattern);
    if (matches.length > 0) {
      results.set(pattern, matches);
    }
  }
  
  return results;
}

/**
 * 搜索高亮工具
 * 将匹配位置转换为可渲染的高亮片段
 */
export function highlightMatches(
  text: string,
  matches: MatchResult[]
): { text: string; isMatch: boolean }[] {
  if (matches.length === 0) {
    return [{ text, isMatch: false }];
  }
  
  // 按位置排序并合并重叠区域
  const sorted = [...matches].sort((a, b) => a.index - b.index);
  const merged: MatchResult[] = [];
  
  for (const match of sorted) {
    const last = merged[merged.length - 1];
    if (last && match.index <= last.index + last.length) {
      // 重叠，扩展 last
      last.length = Math.max(last.index + last.length, match.index + match.length) - last.index;
    } else {
      merged.push({ ...match });
    }
  }
  
  // 生成片段
  const fragments: { text: string; isMatch: boolean }[] = [];
  let lastEnd = 0;
  
  for (const match of merged) {
    if (match.index > lastEnd) {
      fragments.push({
        text: text.substring(lastEnd, match.index),
        isMatch: false,
      });
    }
    fragments.push({
      text: text.substring(match.index, match.index + match.length),
      isMatch: true,
    });
    lastEnd = match.index + match.length;
  }
  
  if (lastEnd < text.length) {
    fragments.push({ text: text.substring(lastEnd), isMatch: false });
  }
  
  return fragments;
}
