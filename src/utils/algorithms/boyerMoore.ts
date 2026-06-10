/**
 * Boyer-Moore-Horspool 字符串匹配算法 + Aho-Corasick 多模式匹配
 * ============================================================================
 *
 * 应用场景：
 * - Horspool：编辑器单关键词查找功能 (Ctrl+F)
 * - Aho-Corasick：多关键词同时匹配（代码高亮、批量搜索、关键词过滤）
 *
 * ## Horspool 算法原理：
 * 1. 坏字符规则（Bad Character Rule）：
 *    从右向左比较模式串和文本。当不匹配时，根据文本中"坏字符"在模式串中的
 *    最右出现位置，决定模式串向右滑动的距离。
 * 2. Horspool 简化：
 *    只使用坏字符规则的最后一位比较结果来决定偏移量，跳过好后缀规则，
 *    在字母表较大时（如 Unicode）实现更简单，实际性能接近完整 BM。
 *
 * 时间复杂度：
 * - 最坏：O(m × n)  当文本和模式串都是重复字符时
 * - 平均：O(n/m)    模式串越长，跳得越远，效率越高
 * - 预处理：O(m + Σ)
 * 空间复杂度：O(Σ)
 *
 * ## Aho-Corasick 算法原理：
 * 在 Trie 树的每个节点上增加「失败指针（failure link）」，匹配失败时不从根
 * 重新开始，而是跳转到最长后缀的节点继续匹配。一次文本扫描即可找到所有模式串
 * 的所有出现位置。
 *
 * 时间复杂度：O(n + k × m + z)，n=文本长度, k=模式数, m=模式平均长度, z=匹配数
 * 空间复杂度：O(k × m × Σ)
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

/* ─── Horspool 单模式搜索 ─── */

function buildShiftTable(pattern: string): (char: string) => number {
  const m = pattern.length;
  const table = new Map<string, number>();

  for (let i = 0; i < m - 1; i++) {
    table.set(pattern[i], m - 1 - i);
  }

  return (char: string) => {
    return table.has(char) ? table.get(char)! : m;
  };
}

export function horspoolSearch(text: string, pattern: string): MatchResult[] {
  if (!pattern || !text || pattern.length > text.length) {
    return [];
  }

  const n = text.length;
  const m = pattern.length;
  const results: MatchResult[] = [];
  const getShift = buildShiftTable(pattern);

  let i = 0;

  while (i <= n - m) {
    let j = m - 1;

    while (j >= 0 && pattern[j] === text[i + j]) {
      j--;
    }

    if (j < 0) {
      results.push({
        index: i,
        length: m,
        matched: text.substring(i, i + m),
      });
      i += 1;
    } else {
      const badChar = text[i + m - 1];
      i += getShift(badChar);
    }
  }

  return results;
}

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

    while (j >= 0 && lowerPattern[j] === text[i + j].toLowerCase()) {
      j--;
    }

    if (j < 0) {
      results.push({
        index: i,
        length: m,
        matched: text.substring(i, i + m),
      });
      i += 1;
    } else {
      const badChar = text[i + m - 1].toLowerCase();
      i += getShift(badChar);
    }
  }

  return results;
}

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

    const isWordChar = (ch: string) => /[a-zA-Z0-9_]/.test(ch);

    if (!isWordChar(before) && !isWordChar(after)) {
      results.push(match);
    }
  }

  return results;
}

export function searchInText(
  text: string,
  pattern: string,
  options: SearchOptions = {}
): MatchResult[] {
  const { caseSensitive = true, wholeWord = false, regex = false } = options;

  if (regex) {
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

export function multiPatternSearch(
  text: string,
  patterns: string[]
): Map<string, MatchResult[]> {
  if (!text || patterns.length === 0) return new Map();

  const searcher = new AhoCorasick(patterns);
  return searcher.search(text);
}

/* ─── Aho-Corasick 多模式匹配 ─── */

interface ACNode {
  children: Map<number, ACNode>;
  fail: ACNode | null;
  output: { pattern: string; length: number }[];
  depth: number;
}

class AhoCorasick {
  private root: ACNode;
  private patterns: string[];

  constructor(patterns: string[]) {
    this.root = this.createNode(0);
    this.patterns = patterns;
    this.buildTrie();
    this.buildFailureLinks();
  }

  private createNode(depth: number): ACNode {
    return {
      children: new Map(),
      fail: null,
      output: [],
      depth,
    };
  }

  /** 构建 Trie 树 */
  private buildTrie(): void {
    for (const pattern of this.patterns) {
      let node = this.root;
      for (let i = 0; i < pattern.length; i++) {
        const ch = pattern.charCodeAt(i);
        if (!node.children.has(ch)) {
          node.children.set(ch, this.createNode(node.depth + 1));
        }
        node = node.children.get(ch)!;
      }
      node.output.push({ pattern, length: pattern.length });
    }
  }

  /** BFS 构建失败指针 */
  private buildFailureLinks(): void {
    const queue: ACNode[] = [];

    // 第一层节点的失败指针指向根
    for (const child of this.root.children.values()) {
      child.fail = this.root;
      queue.push(child);
    }

    while (queue.length > 0) {
      const current = queue.shift()!;

      for (const [ch, child] of current.children) {
        queue.push(child);

        // 沿失败链回溯找到匹配的转移
        let failNode = current.fail!;
        while (failNode !== this.root && !failNode.children.has(ch)) {
          failNode = failNode.fail!;
        }

        if (failNode.children.has(ch) && failNode.children.get(ch) !== child) {
          child.fail = failNode.children.get(ch)!;
        } else {
          child.fail = this.root;
        }

        // 继承失败节点的输出
        if (child.fail) {
          child.output.push(...child.fail.output);
        }
      }
    }
  }

  /** 在文本中搜索所有模式 */
  search(text: string): Map<string, MatchResult[]> {
    const results = new Map<string, MatchResult[]>();
    let node = this.root;

    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);

      // 跟随失败指针直到找到匹配的转移
      while (node !== this.root && !node.children.has(ch)) {
        node = node.fail!;
      }

      if (node.children.has(ch)) {
        node = node.children.get(ch)!;
      }

      // 检查当前节点的输出
      if (node.output.length > 0) {
        for (const out of node.output) {
          const matchIndex = i - out.length + 1;
          if (!results.has(out.pattern)) {
            results.set(out.pattern, []);
          }
          results.get(out.pattern)!.push({
            index: matchIndex,
            length: out.length,
            matched: out.pattern,
          });
        }
      }
    }

    return results;
  }
}

export { AhoCorasick };

/* ─── 搜索高亮工具 ─── */

export function highlightMatches(
  text: string,
  matches: MatchResult[]
): { text: string; isMatch: boolean }[] {
  if (matches.length === 0) {
    return [{ text, isMatch: false }];
  }

  const sorted = [...matches].sort((a, b) => a.index - b.index);
  const merged: MatchResult[] = [];

  for (const match of sorted) {
    const last = merged[merged.length - 1];
    if (last && match.index <= last.index + last.length) {
      last.length = Math.max(last.index + last.length, match.index + match.length) - last.index;
    } else {
      merged.push({ ...match });
    }
  }

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
