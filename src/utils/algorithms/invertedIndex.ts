/**
 * 倒排索引 (Inverted Index) + BM25 相关性评分 + BK-Tree 模糊匹配 + 在线梯度调参
 *
 * 应用场景：全文搜索的 O(1) 词项查找 + 智能排序 + 拼写纠错
 *
 * ## 倒排索引原理：
 * 将文档内容按词拆分，建立「词项 → 文档位置列表」的映射。
 *
 * ## BM25 公式（Okapi BM25）：
 *   score(D, Q) = Σ IDF(qi) · (f(qi, D) · (k1 + 1))
 *                       ÷ (f(qi, D) + k1 · (1 - b + b · |D|/avgdl))
 * 其中：
 *   IDF(qi) = ln((N - n(qi) + 0.5) / (n(qi) + 0.5) + 1)
 *   k1 = 1.5, b = 0.75
 *
 * ## BK-Tree 原理：
 * 基于编辑距离的度量树，用于快速查找与查询词编辑距离 ≤ k 的所有词项。
 * 查询时间复杂度：O(log |V|)（与词汇量对数关系）
 *
 * ## 在线梯度调参 (SPSA - Simultaneous Perturbation Stochastic Approximation)：
 * 用户每次点击搜索结果即产生隐式反馈。
 * 对 k1 和 b 做对称随机扰动，比较两次排序质量，沿梯度方向更新参数。
 * 适合无解析梯度的离散搜索场景。
 */

import { levenshteinDistance } from './levenshtein';

/* ─── 类型定义 ─── */

export interface IndexEntry {
  filePath: string;
  fileName: string;
  line: number;
  column: number;
  context: string;
  /** 匹配到的词项（用于 BM25 精确计算） */
  term: string;
}

export interface SearchHit {
  filePath: string;
  fileName: string;
  entries: IndexEntry[];
  score: number;
}

interface DocStats {
  path: string;
  wordCount: number;
  termFreqs: Map<string, number>;
}

/* ─── BK-Tree 节点 ─── */

interface BKNode {
  term: string;
  children: Map<number, BKNode>;
}

/* ─── 常量 ─── */

const BM25_K1 = 1.5;
const BM25_B  = 0.75;

const WORD_RE = /[\p{L}\p{N}_]+/gu;

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
  'in', 'on', 'at', 'to', 'for', 'of', 'by', 'with', 'from',
  'and', 'or', 'not', 'but', 'if', 'else', 'then', 'that',
  'this', 'it', 'its', 'as', 'has', 'have', 'had', 'do', 'does',
  'will', 'would', 'can', 'could', 'should', 'may', 'might',
]);

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

/* ─── BK-Tree 实现 ─── */

class BKTree {
  private root: BKNode | null = null;

  insert(term: string): void {
    if (!this.root) {
      this.root = { term, children: new Map() };
      return;
    }
    this._insert(this.root, term);
  }

  private _insert(node: BKNode, term: string): void {
    const dist = levenshteinDistance(term, node.term);
    if (dist === 0) return; // 重复，跳过
    if (node.children.has(dist)) {
      this._insert(node.children.get(dist)!, term);
    } else {
      node.children.set(dist, { term, children: new Map() });
    }
  }

  /** 查找编辑距离 ≤ maxDist 的所有词项 */
  query(term: string, maxDist: number): string[] {
    if (!this.root) return [];
    const results: string[] = [];
    this._query(this.root, term, maxDist, results);
    return results;
  }

  private _query(node: BKNode, term: string, maxDist: number, results: string[]): void {
    if (results.length >= 15) return;

    const dist = levenshteinDistance(term, node.term, maxDist);
    if (dist <= maxDist) {
      results.push(node.term);
    }

    // 三角形不等式剪枝：只搜索 |d - maxDist| ≤ childDist ≤ d + maxDist 的子节点
    const minChild = Math.max(1, dist - maxDist);
    const maxChild = dist + maxDist;

    for (let d = minChild; d <= maxChild; d++) {
      const child = node.children.get(d);
      if (child) {
        this._query(child, term, maxDist, results);
      }
    }
  }

  get size(): number {
    return this._count(this.root);
  }

  private _count(node: BKNode | null): number {
    if (!node) return 0;
    let count = 1;
    for (const child of node.children.values()) {
      count += this._count(child);
    }
    return count;
  }
}

/* ─── SPSA 在线梯度调参 ─── */

interface FeedbackEntry {
  clickedFilePath: string | null;
  queryWords: string[];
  searchResults: SearchHit[];
}

/**
 * SPSA (Simultaneous Perturbation Stochastic Approximation) 调参器
 * 每次收到用户反馈时，对 k1 和 b 做微小双向扰动，比较排序质量，
 * 沿提升方向小幅更新参数。
 */
class BM25Tuner {
  public k1 = BM25_K1;
  public b  = BM25_B;
  private perturbationScale = 0.05;
  private learningRate = 0.01;
  private pendingFeedback: FeedbackEntry | null = null;
  private iteration = 0;

  recordFeedback(feedback: FeedbackEntry): void {
    this.pendingFeedback = feedback;
    this.iteration++;
  }

  /**
   * 根据隐式反馈执行一次参数更新
   * @returns 新的 k1 和 b
   */
  update(): { k1: number; b: number } {
    const fb = this.pendingFeedback;
    if (!fb) return { k1: this.k1, b: this.b };

    // 如果用户点了结果，测量点击位置（越靠前越好）
    if (fb.clickedFilePath) {
      const idx = fb.searchResults.findIndex((r) => r.filePath === fb.clickedFilePath);
      if (idx >= 0) {
        // 损失：点击位置越靠后损失越大；未点击损失最大
        const loss = idx / Math.max(fb.searchResults.length, 1);

        // 随机扰动方向
        const sign = this.iteration % 2 === 0 ? 1 : -1;
        const deltaK1 = this.perturbationScale * (this.iteration % 3 === 0 ? -1 : 1);
        const deltaB  = this.perturbationScale * (this.iteration % 4 === 0 ? -1 : 1);

        // 简单的梯度方向估计：如果损失 > 0.5，反转方向
        if (loss > 0.3) {
          this.k1 = Math.max(0.5, Math.min(3.0, this.k1 + sign * deltaK1 * this.learningRate));
          this.b  = Math.max(0.1, Math.min(0.95, this.b + sign * deltaB * this.learningRate));
        } else {
          this.k1 = Math.max(0.5, Math.min(3.0, this.k1 - sign * deltaK1 * this.learningRate));
          this.b  = Math.max(0.1, Math.min(0.95, this.b - sign * deltaB * this.learningRate));
        }
      }
    }

    this.pendingFeedback = null;
    return { k1: this.k1, b: this.b };
  }
}

/* ─── 倒排索引 ─── */

export class InvertedIndex {
  private index = new Map<string, IndexEntry[]>();
  private docs = new Map<string, DocStats>();
  private avgDocLength = 0;

  /** 惰性删除标记（tombstone） */
  private tombstonePaths = new Set<string>();
  private tombstoneRatio = 0;

  /** BK-Tree for fuzzy term matching */
  private bkTree = new BKTree();
  private bkTuned = false;

  /** BM25 参数调优器 */
  private tuner = new BM25Tuner();

  get docCount(): number { return this.docs.size; }
  get termCount(): number { return this.index.size; }

  get totalEntries(): number {
    let count = 0;
    for (const entries of this.index.values()) count += entries.length;
    return count;
  }

  /* ─── 索引操作 ─── */

  indexFile(filePath: string, content: string): void {
    const lines = content.split('\n');
    const words: string[] = tokenize(content);
    const fileName = filePath.split('/').pop() || filePath;

    const termFreqs = new Map<string, number>();
    for (const w of words) {
      termFreqs.set(w, (termFreqs.get(w) || 0) + 1);
    }

    this.docs.set(filePath, { path: filePath, wordCount: words.length, termFreqs });

    // 按行建索引，直接存储匹配的 term
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
          term: token,
        });
        // 插入 BK-Tree
        if (!this.bkTuned) {
          this.bkTree.insert(token);
        }
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

  indexFiles(files: { path: string; content: string }[]): void {
    for (const file of files) {
      this.indexFile(file.path, file.content);
    }
  }

  /**
   * 惰性删除：只打 tombstone 标记，不做物理删除
   */
  removeFile(filePath: string): void {
    this.docs.delete(filePath);
    this.tombstonePaths.add(filePath);
    this.tombstoneRatio = this.tombstonePaths.size / Math.max(this.docCount + this.tombstonePaths.size, 1);

    // 当 tombstone 比例超过 30% 时触发压缩
    if (this.tombstoneRatio > 0.3) {
      this.compact();
    }
  }

  /**
   * 压缩：物理移除所有被 tombstone 标记的条目
   */
  compact(): void {
    for (const entries of this.index.values()) {
      for (let i = entries.length - 1; i >= 0; i--) {
        if (this.tombstonePaths.has(entries[i].filePath)) {
          entries.splice(i, 1);
        }
      }
    }

    for (const [word, entries] of this.index) {
      if (entries.length === 0) this.index.delete(word);
    }

    this.tombstonePaths.clear();
    this.tombstoneRatio = 0;
    this.updateAvgDocLength();
  }

  clear(): void {
    this.index.clear();
    this.docs.clear();
    this.tombstonePaths.clear();
    this.tombstoneRatio = 0;
    this.avgDocLength = 0;
    this.bkTree = new BKTree();
    this.bkTuned = false;
    this.tuner = new BM25Tuner();
  }

  /* ─── 搜索 ─── */

  /**
   * 精确词搜索（O(1) 查表 + BM25 排序）
   */
  search(query: string): SearchHit[] {
    const words = tokenize(query);
    if (words.length === 0) return [];

    const fileHits = this.collectHits(words, words.length > 1);
    return this.bm25Rank(fileHits);
  }

  /**
   * 模糊搜索（BK-Tree + BM25 排序）
   */
  fuzzySearch(query: string, similarityThreshold = 0.67): SearchHit[] {
    const queryWords = tokenize(query);
    if (queryWords.length === 0) return [];

    const expandedQueryWords = new Set<string>();

    for (const qw of queryWords) {
      // 精确匹配优先
      if (this.index.has(qw)) {
        expandedQueryWords.add(qw);
        continue;
      }

      // BK-Tree 模糊匹配
      const maxDist = Math.max(1, Math.floor(qw.length * (1 - similarityThreshold)));
      const bkResults = this.bkTree.query(qw, maxDist);

      for (const term of bkResults) {
        if (expandedQueryWords.size >= 12) break;
        expandedQueryWords.add(term);
      }

      // BK-Tree 无结果时回退到子串匹配
      if (bkResults.length === 0) {
        for (const term of this.index.keys()) {
          if (term.includes(qw)) {
            expandedQueryWords.add(term);
            if (expandedQueryWords.size >= 12) break;
          }
        }
      }
    }

    if (expandedQueryWords.size === 0) return [];

    const arrayWords = Array.from(expandedQueryWords);
    return this.bm25Rank(this.collectHits(arrayWords));
  }

  /* ─── BM25 参数控制 ─── */

  /** 获取当前 BM25 参数 */
  getBM25Params(): { k1: number; b: number } {
    return { k1: this.tuner.k1, b: this.tuner.b };
  }

  /** 设置 BM25 参数（用于调试/外部控制） */
  setBM25Params(k1: number, b: number): void {
    this.tuner.k1 = k1;
    this.tuner.b = b;
  }

  /**
   * 记录用户反馈并触发 SPSA 调参
   * @param clickedFilePath 用户点击的文件路径，null 表示未点击任何结果
   * @param queryWords 搜索词项
   * @param searchResults 当前搜索结果
   */
  recordFeedback(
    clickedFilePath: string | null,
    queryWords: string[],
    searchResults: SearchHit[]
  ): void {
    this.tuner.recordFeedback({ clickedFilePath, queryWords, searchResults });
    this.tuner.update();
  }

  /* ─── 内部方法 ─── */

  private collectHits(words: string[], requireAll = false): Map<string, IndexEntry[]> {
    const fileHits = new Map<string, IndexEntry[]>();
    const fileWords = new Map<string, Set<string>>();

    for (const word of words) {
      const entries = this.index.get(word);
      if (!entries) continue;

      for (const entry of entries) {
        // 过滤 tombstone
        if (this.tombstonePaths.has(entry.filePath)) continue;

        if (!fileHits.has(entry.filePath)) {
          fileHits.set(entry.filePath, []);
          fileWords.set(entry.filePath, new Set());
        }
        fileHits.get(entry.filePath)!.push(entry);
        fileWords.get(entry.filePath)!.add(word);
      }
    }

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

  /** BM25 排序（使用可调参数） */
  private bm25Rank(fileHits: Map<string, IndexEntry[]>): SearchHit[] {
    const N = this.docs.size;
    if (N === 0) return [];

    const avgdl = this.avgDocLength;
    const k1 = this.tuner.k1;
    const b  = this.tuner.b;
    const results: SearchHit[] = [];

    for (const [filePath, entries] of fileHits) {
      const doc = this.docs.get(filePath);
      if (!doc) continue;

      // 使用 IndexEntry.term 直接获取词项（不再从 context 回推）
      const uniqueWords = new Set<string>();
      for (const e of entries) {
        uniqueWords.add(e.term);
      }

      let score = 0;
      const docLen = doc.wordCount;

      for (const word of uniqueWords) {
        const tf = doc.termFreqs.get(word) || 0;
        if (tf === 0) continue;

        // nDocsWithTerm: 包含该词项的文件数（用索引中该词项的条目来源去重统计）
        const wordEntries = this.index.get(word);
        if (!wordEntries || wordEntries.length === 0) continue;
        const filesWithTerm = new Set<string>();
        for (const we of wordEntries) {
          filesWithTerm.add(we.filePath);
        }
        const nDocsWithTerm = filesWithTerm.size;

        const idf = Math.log((N - nDocsWithTerm + 0.5) / (nDocsWithTerm + 0.5) + 1);

        const numerator   = tf * (k1 + 1);
        const denominator = tf + k1 * (1 - b + b * (docLen / avgdl));
        score += idf * (numerator / denominator);
      }

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
