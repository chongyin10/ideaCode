/**
 * 倒排索引 (Inverted Index) + BM25 相关性评分
 *
 * 应用场景：全文搜索的 O(1) 词项查找 + 智能排序
 *
 * 倒排索引原理：
 * 将文档内容按词拆分，建立「词项 → 文档位置列表」的映射。
 * 查询时直接查表，时间复杂度 O(log |V| + |R|)，V=词汇量, R=结果数。
 * 相比逐文件扫描 (O(n×m))，在大项目中提速可达 10-100 倍。
 *
 * BM25 公式（Okapi BM25）：
 *   score(D, Q) = Σ IDF(qi) · (f(qi, D) · (k1 + 1))
 *                       ÷ (f(qi, D) + k1 · (1 - b + b · |D|/avgdl))
 * 其中：
 *   IDF(qi) = ln((N - n(qi) + 0.5) / (n(qi) + 0.5) + 1)
 *   N = 文档总数, n(qi) = 包含 qi 的文档数
 *   |D| = 文档长度, avgdl = 平均文档长度
 *   k1 = 1.5, b = 0.75
 *
 * 相比 TF-IDF，BM25 引入了文档长度归一化与词频饱和，
 * 避免长文档垄断高分，同时防止词频过高项无限加分。
 */

import { levenshteinDistance } from './levenshtein';

/* ─── 类型定义 ─── */

export interface IndexEntry {
  filePath: string;
  fileName: string;
  line: number;
  column: number;
  /** 上下文（匹配行内容） */
  context: string;
}

export interface SearchHit {
  filePath: string;
  fileName: string;
  entries: IndexEntry[];
  /** BM25 相关性评分 */
  score: number;
}

/** 文档统计（用于 BM25） */
interface DocStats {
  path: string;
  wordCount: number;
  termFreqs: Map<string, number>;
}

/* ─── 常量 ─── */

const BM25_K1 = 1.5;
const BM25_B  = 0.75;

/** 拆分词项的正则：Unicode 字母数字 + 下划线 */
const WORD_RE = /[\p{L}\p{N}_]+/gu;

/** 常见停用词（排除以提高索引质量和速度） */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
  'in', 'on', 'at', 'to', 'for', 'of', 'by', 'with', 'from',
  'and', 'or', 'not', 'but', 'if', 'else', 'then', 'that',
  'this', 'it', 'its', 'as', 'has', 'have', 'had', 'do', 'does',
  'will', 'would', 'can', 'could', 'should', 'may', 'might',
]);

/** 默认最小词长度 */
const MIN_WORD_LEN = 2;

/* ─── 词项提取 ─── */

function tokenize(text: string, minLen = MIN_WORD_LEN): string[] {
  const words: string[] = [];
  let match: RegExpExecArray | null;
  WORD_RE.lastIndex = 0;
  while ((match = WORD_RE.exec(text)) !== null) {
    const word = match[0].toLowerCase();
    if (word.length >= minLen && !STOP_WORDS.has(word)) {
      words.push(word);
    }
  }
  return words;
}

/* ─── 倒排索引 ─── */

export class InvertedIndex {
  /** 词项 → 位置列表 */
  private index = new Map<string, IndexEntry[]>();

  /** 文档统计 */
  private docs = new Map<string, DocStats>();

  /** 平均文档长度（BM25 用） */
  private avgDocLength = 0;

  /** 文档总数 */
  get docCount(): number { return this.docs.size; }

  /** 索引中的词项数 */
  get termCount(): number { return this.index.size; }

  /** 总位置数 */
  get totalEntries(): number {
    let count = 0;
    for (const entries of this.index.values()) count += entries.length;
    return count;
  }

  /**
   * 索引一个文件
   */
  indexFile(filePath: string, content: string): void {
    const lines = content.split('\n');
    const words: string[] = tokenize(content);
    const fileName = filePath.split('/').pop() || filePath;

    const termFreqs = new Map<string, number>();
    for (const w of words) {
      termFreqs.set(w, (termFreqs.get(w) || 0) + 1);
    }

    this.docs.set(filePath, { path: filePath, wordCount: words.length, termFreqs });

    // 按行建索引（每行去重，避免重复行导致索引膨胀）
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const lineTokens = tokenize(lines[lineIdx]);
      if (lineTokens.length === 0) continue;
      const uniqueTokens = new Set(lineTokens);
      for (const token of uniqueTokens) {
        this.addEntry(token, {
          filePath,
          fileName,
          line: lineIdx + 1,
          column: lines[lineIdx].toLowerCase().indexOf(token) + 1,
          context: lines[lineIdx],
        });
      }
    }

    this.updateAvgDocLength();
  }

  private addEntry(token: string, entry: IndexEntry): void {
    if (!this.index.has(token)) {
      this.index.set(token, []);
    }
    this.index.get(token)!.push(entry);
  }

  /**
   * 批量索引多个文件
   */
  indexFiles(files: { path: string; content: string }[]): void {
    for (const file of files) {
      this.indexFile(file.path, file.content);
    }
  }

  /**
   * 从索引中移除文件
   */
  removeFile(filePath: string): void {
    this.docs.delete(filePath);
    for (const entries of this.index.values()) {
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].filePath === filePath) {
          entries.splice(i, 1);
        }
      }
    }
    // 清理空列表
    for (const [word, entries] of this.index) {
      if (entries.length === 0) this.index.delete(word);
    }
    this.updateAvgDocLength();
  }

  /**
   * 清空索引
   */
  clear(): void {
    this.index.clear();
    this.docs.clear();
    this.avgDocLength = 0;
  }

  /**
   * 精确词搜索（O(1) 查表 + BM25 排序）
   *
   * 多词查询使用 AND 语义：文件必须匹配所有词项才被召回
   * 如 "index.html" → 只返回同时含有 "index" 和 "html" 的文件
   */
  search(query: string): SearchHit[] {
    const words = tokenize(query);
    if (words.length === 0) return [];

    const fileHits = this.collectHits(words, words.length > 1);
    return this.bm25Rank(fileHits);
  }

  /**
   * 模糊搜索（带编辑距离容忍）
   */
  fuzzySearch(query: string, similarityThreshold = 0.67): SearchHit[] {
    const queryWords = tokenize(query);
    if (queryWords.length === 0) return [];

    const expandedQueryWords = new Set<string>();
    const allTerms = Array.from(this.index.keys());

    for (const qw of queryWords) {
      // 精确匹配优先
      if (this.index.has(qw)) {
        expandedQueryWords.add(qw);
        continue;
      }

      // 子串匹配
      let found = false;
      for (const term of allTerms) {
        if (term.includes(qw)) {
          expandedQueryWords.add(term);
          found = true;
        }
      }
      if (found) continue;

      // 编辑距离模糊匹配
      // 短词放宽阈值（3 字符以下允许 1 个编辑距离，即使比例上偏高）
      const effectiveThreshold = qw.length <= 3 ? 0.5 : similarityThreshold;
      const maxDist = Math.max(1, Math.floor(qw.length * (1 - effectiveThreshold)));

      for (const term of allTerms) {
        if (expandedQueryWords.size >= 12) break;

        const lenDiff = Math.abs(term.length - qw.length);
        if (lenDiff > maxDist) continue;

        // 快速预筛：检查公共前缀字符数
        let commonPrefix = 0;
        const minLen = Math.min(term.length, qw.length);
        for (let i = 0; i < minLen; i++) {
          if (term[i] === qw[i]) commonPrefix++;
          else break; // 一旦前缀不匹配就停止（前缀匹配加速）
        }

        // 首字母匹配或足够多公共前缀
        if (term[0] === qw[0] || commonPrefix >= 2) {
          const dist = levenshteinDistance(qw, term, maxDist);
          if (dist <= maxDist) {
            expandedQueryWords.add(term);
            if (expandedQueryWords.size >= 12) break;
          }
        }
      }
    }

    if (expandedQueryWords.size === 0) return [];

    return this.bm25Rank(this.collectHits(Array.from(expandedQueryWords)));
  }

  /* ─── 内部方法 ─── */

  private collectHits(words: string[], requireAll = false): Map<string, IndexEntry[]> {
    const fileHits = new Map<string, IndexEntry[]>();
    const fileWords = new Map<string, Set<string>>();

    for (const word of words) {
      const entries = this.index.get(word);
      if (!entries) continue;

      for (const entry of entries) {
        if (!fileHits.has(entry.filePath)) {
          fileHits.set(entry.filePath, []);
          fileWords.set(entry.filePath, new Set());
        }
        fileHits.get(entry.filePath)!.push(entry);
        fileWords.get(entry.filePath)!.add(word);
      }
    }

    // AND 语义：过滤掉未包含所有词项的文件
    if (requireAll && words.length > 1) {
      for (const [filePath, matched] of fileWords) {
        const coversAll = words.every((w) => matched.has(w));
        if (!coversAll) {
          fileHits.delete(filePath);
        }
      }
    }

    return fileHits;
  }

  /** BM25 排序 */
  private bm25Rank(fileHits: Map<string, IndexEntry[]>): SearchHit[] {
    const N = this.docs.size;
    if (N === 0) return [];

    const avgdl = this.avgDocLength;
    const results: SearchHit[] = [];

    for (const [filePath, entries] of fileHits) {
      const doc = this.docs.get(filePath);
      if (!doc) continue;

      // 计算该文档下每个唯一词项的 BM25 贡献
      const uniqueWords = new Set(entries.map((e) =>
        e.context.substring(e.column - 1).split(/\s|$/)[0].toLowerCase()
      ));

      let score = 0;
      const docLen = doc.wordCount;

      for (const word of uniqueWords) {
        const tf = doc.termFreqs.get(word) || 0;
        if (tf === 0) continue;

        const nDocsWithTerm = this.index.get(word)?.length || 0;
        if (nDocsWithTerm === 0) continue;

        const idf = Math.log((N - nDocsWithTerm + 0.5) / (nDocsWithTerm + 0.5) + 1);

        const numerator   = tf * (BM25_K1 + 1);
        const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / avgdl));
        score += idf * (numerator / denominator);
      }

      // 文件名匹配加分
      const fileName = filePath.split('/').pop() || filePath;
      score += 0.1 * entries.length;

      results.push({ filePath, fileName, entries, score });
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  private updateAvgDocLength(): void {
    if (this.docs.size === 0) {
      this.avgDocLength = 0;
      return;
    }
    let total = 0;
    for (const doc of this.docs.values()) {
      total += doc.wordCount;
    }
    this.avgDocLength = total / this.docs.size;
  }
}
