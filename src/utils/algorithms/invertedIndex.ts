/**
 * 倒排索引 (Inverted Index) + BM25F 结构化评分 + BK-Tree 模糊匹配
 * + SPSA 在线梯度调参 + Thompson Sampling Bandit 排序
 *
 * 应用场景：全文搜索的 O(1) 词项查找 + 智能排序 + 拼写纠错
 *
 * ## BM25F 原理（多字段 BM25）：
 * 将文档分为标题(fileName)、路径(filePath)、内容(content)三个字段，
 * 每个字段独立计算词频和长度，加权组合：
 *   score(D, Q) = Σ IDF(qi) · Σ_f w_f · BM25_saturation(tf_f, |D|_f, avgdl_f)
 *
 * 其中 BM25_saturation = tf · (k1 + 1) / (tf + k1 · (1 - b + b · |D|/avgdl))
 *
 * ## Bandit 增强：
 * 在静态 BM25F 排序基础上，混入 Thompson Sampling 采样，
 * 使排序结果能根据用户点击反馈持续优化。
 */

import { levenshteinDistance } from './levenshtein';
import { SearchBanditRanker } from './searchBandit';
import type { BanditConfig } from './searchBandit';

/* ─── 类型定义 ─── */

export interface IndexEntry {
  filePath: string;
  fileName: string;
  line: number;
  column: number;
  context: string;
  term: string;
}

export interface SearchHit {
  filePath: string;
  fileName: string;
  entries: IndexEntry[];
  /** BM25F 静态得分 */
  score: number;
  /** 各字段分项得分（诊断用） */
  scoreBreakdown?: {
    fileName: number;
    filePath: number;
    content: number;
    entryBonus: number;
  };
}

interface DocStats {
  path: string;
  wordCount: number;
  /** 文件名词数 */
  fileNameWordCount: number;
  /** 路径词数 */
  pathWordCount: number;
  termFreqs: Map<string, number>;
  /** 文件名中的词频 */
  fileNameTermFreqs: Map<string, number>;
  /** 路径中的词频 */
  pathTermFreqs: Map<string, number>;
}

interface BKNode {
  term: string;
  children: Map<number, BKNode>;
}

/* ─── BM25F 字段权重 ─── */

interface BM25FFieldWeights {
  fileName: number;
  filePath: number;
  content: number;
}

const DEFAULT_FIELD_WEIGHTS: BM25FFieldWeights = {
  fileName: 3.0,
  filePath: 1.5,
  content: 1.0,
};

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
    if (dist === 0) return;
    if (node.children.has(dist)) {
      this._insert(node.children.get(dist)!, term);
    } else {
      node.children.set(dist, { term, children: new Map() });
    }
  }

  query(term: string, maxDist: number): string[] {
    if (!this.root) return [];
    const results: string[] = [];
    this._query(this.root, term, maxDist, results);
    return results;
  }

  private _query(node: BKNode, term: string, maxDist: number, results: string[]): void {
    if (results.length >= 15) return;
    const dist = levenshteinDistance(term, node.term, maxDist);
    if (dist <= maxDist) results.push(node.term);

    const minChild = Math.max(1, dist - maxDist);
    const maxChild = dist + maxDist;
    for (let d = minChild; d <= maxChild; d++) {
      const child = node.children.get(d);
      if (child) this._query(child, term, maxDist, results);
    }
  }
}

/* ─── SPSA 在线梯度调参 ─── */

interface FeedbackEntry {
  clickedFilePath: string | null;
  queryWords: string[];
  searchResults: SearchHit[];
}

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

  update(): { k1: number; b: number } {
    const fb = this.pendingFeedback;
    if (!fb) return { k1: this.k1, b: this.b };

    if (fb.clickedFilePath) {
      const idx = fb.searchResults.findIndex((r) => r.filePath === fb.clickedFilePath);
      if (idx >= 0) {
        const loss = idx / Math.max(fb.searchResults.length, 1);
        const sign = this.iteration % 2 === 0 ? 1 : -1;
        const deltaK1 = this.perturbationScale * (this.iteration % 3 === 0 ? -1 : 1);
        const deltaB  = this.perturbationScale * (this.iteration % 4 === 0 ? -1 : 1);

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
  private avgFileNameLen = 0;
  private avgPathLen = 0;

  private tombstonePaths = new Set<string>();
  private tombstoneRatio = 0;

  private bkTree = new BKTree();
  private bkTuned = false;

  private tuner = new BM25Tuner();

  /** BM25F 字段权重 */
  fieldWeights: BM25FFieldWeights = { ...DEFAULT_FIELD_WEIGHTS };

  /** Thompson Sampling 排序器 */
  bandit: SearchBanditRanker;

  /** 是否启用 Bandit 混合排序 */
  banditEnabled = false;

  /** Bandit 混合比例（0=纯静态BM25F, 1=纯Bandit） */
  banditMixRatio = 0.2;

  constructor(banditConfig?: BanditConfig) {
    this.bandit = new SearchBanditRanker(banditConfig);
  }

  get docCount(): number { return this.docs.size; }
  get termCount(): number { return this.index.size; }

  /* ─── 索引操作 ─── */

  indexFile(filePath: string, content: string): void {
    const lines = content.split('\n');
    const words: string[] = tokenize(content);
    const fileName = filePath.split('/').pop() || filePath;
    const pathParts = filePath.replace(/\/+/g, '/').split('/').slice(0, -1).join(' ');
    const fileNameWords = tokenize(fileName);
    const pathWords = tokenize(pathParts);

    const termFreqs = new Map<string, number>();
    const fileNameTermFreqs = new Map<string, number>();
    const pathTermFreqs = new Map<string, number>();

    for (const w of words) termFreqs.set(w, (termFreqs.get(w) || 0) + 1);
    for (const w of fileNameWords) fileNameTermFreqs.set(w, (fileNameTermFreqs.get(w) || 0) + 1);
    for (const w of pathWords) pathTermFreqs.set(w, (pathTermFreqs.get(w) || 0) + 1);

    this.docs.set(filePath, {
      path: filePath,
      wordCount: words.length,
      fileNameWordCount: fileNameWords.length,
      pathWordCount: pathWords.length,
      termFreqs,
      fileNameTermFreqs,
      pathTermFreqs,
    });

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
        if (!this.bkTuned) this.bkTree.insert(token);
      }
    }

    this.updateAvgDocLength();
  }

  private addEntry(token: string, entry: IndexEntry): void {
    if (!this.index.has(token)) this.index.set(token, []);
    this.index.get(token)!.push(entry);
  }

  indexFiles(files: { path: string; content: string }[]): void {
    for (const file of files) this.indexFile(file.path, file.content);
  }

  removeFile(filePath: string): void {
    this.docs.delete(filePath);
    this.tombstonePaths.add(filePath);
    this.tombstoneRatio = this.tombstonePaths.size / Math.max(this.docCount + this.tombstonePaths.size, 1);
    if (this.tombstoneRatio > 0.3) this.compact();
  }

  compact(): void {
    for (const entries of this.index.values()) {
      for (let i = entries.length - 1; i >= 0; i--) {
        if (this.tombstonePaths.has(entries[i].filePath)) entries.splice(i, 1);
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
    this.bandit.reset();
  }

  /* ─── 搜索 ─── */

  search(query: string): SearchHit[] {
    const words = tokenize(query);
    if (words.length === 0) return [];

    const fileHits = this.collectHits(words, words.length > 1);
    let results = this.bm25FRank(fileHits, words);

    // Bandit 混合排序
    if (this.banditEnabled && results.length > 1) {
      results = this.bandit.rerank(
        results,
        (hit) => hit.filePath,
        (hit) => hit.score,
        this.banditMixRatio
      );
    }

    // 记录展示
    if (this.banditEnabled) {
      for (const r of results) {
        this.bandit.recordImpression(r.filePath);
      }
    }

    return results;
  }

  fuzzySearch(query: string, similarityThreshold = 0.67): SearchHit[] {
    const queryWords = tokenize(query);
    if (queryWords.length === 0) return [];

    const expandedQueryWords = new Set<string>();

    for (const qw of queryWords) {
      if (this.index.has(qw)) {
        expandedQueryWords.add(qw);
        continue;
      }
      const maxDist = Math.max(1, Math.floor(qw.length * (1 - similarityThreshold)));
      const bkResults = this.bkTree.query(qw, maxDist);
      for (const term of bkResults) {
        if (expandedQueryWords.size >= 12) break;
        expandedQueryWords.add(term);
      }
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
    let results = this.bm25FRank(this.collectHits(arrayWords), arrayWords);

    // Bandit 混合排序
    if (this.banditEnabled && results.length > 1) {
      results = this.bandit.rerank(
        results,
        (hit) => hit.filePath,
        (hit) => hit.score,
        this.banditMixRatio
      );
    }

    return results;
  }

  /* ─── BM25 参数控制 ─── */

  getBM25Params(): { k1: number; b: number } {
    return { k1: this.tuner.k1, b: this.tuner.b };
  }

  setBM25Params(k1: number, b: number): void {
    this.tuner.k1 = k1;
    this.tuner.b = b;
  }

  /** 设置 BM25F 字段权重 */
  setFieldWeights(weights: Partial<BM25FFieldWeights>): void {
    this.fieldWeights = { ...this.fieldWeights, ...weights };
  }

  /** 启用/禁用 Bandit 排序 */
  setBanditEnabled(enabled: boolean): void {
    this.banditEnabled = enabled;
  }

  /** 设置 Bandit 混合比例 */
  setBanditMixRatio(ratio: number): void {
    this.banditMixRatio = Math.max(0, Math.min(1, ratio));
  }

  recordFeedback(
    clickedFilePath: string | null,
    queryWords: string[],
    searchResults: SearchHit[]
  ): void {
    this.tuner.recordFeedback({ clickedFilePath, queryWords, searchResults });
    this.tuner.update();

    // Bandit 反馈
    if (this.banditEnabled && clickedFilePath) {
      this.bandit.recordClick(clickedFilePath);
    }
  }

  /** 设置字段权重 */
  setBM25FWeights(weights: Partial<BM25FFieldWeights>): void {
    this.fieldWeights = { ...this.fieldWeights, ...weights };
  }

  /* ─── 内部方法 ─── */

  private collectHits(words: string[], requireAll = false): Map<string, IndexEntry[]> {
    const fileHits = new Map<string, IndexEntry[]>();
    const fileWords = new Map<string, Set<string>>();

    for (const word of words) {
      const entries = this.index.get(word);
      if (!entries) continue;

      for (const entry of entries) {
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
        if (!words.every((w) => matched.has(w))) fileHits.delete(filePath);
      }
    }

    return fileHits;
  }

  /** BM25F 三字段加权排序 */
  private bm25FRank(fileHits: Map<string, IndexEntry[]>, queryWords: string[]): SearchHit[] {
    const N = this.docs.size;
    if (N === 0) return [];

    const avgdl = this.avgDocLength;
    const avgFileNameLen = this.avgFileNameLen || Math.max(1, avgdl / 20);
    const avgPathLen = this.avgPathLen || Math.max(1, avgdl / 10);
    const k1 = this.tuner.k1;
    const b  = this.tuner.b;
    const fw = this.fieldWeights;

    const results: SearchHit[] = [];

    for (const [filePath, entries] of fileHits) {
      const doc = this.docs.get(filePath);
      if (!doc) continue;

      let scoreFileName = 0;
      let scoreFilePath = 0;
      let scoreContent = 0;

      const docLen = doc.wordCount;
      const fNameLen = doc.fileNameWordCount || 1;
      const pathLen = doc.pathWordCount || 1;

      for (const word of queryWords) {
        const wordEntries = this.index.get(word);
        if (!wordEntries || wordEntries.length === 0) continue;

        const filesWithTerm = new Set<string>();
        for (const we of wordEntries) filesWithTerm.add(we.filePath);
        const nDocsWithTerm = filesWithTerm.size;
        const idf = Math.log((N - nDocsWithTerm + 0.5) / (nDocsWithTerm + 0.5) + 1);

        // 文件名字段
        const tfName = doc.fileNameTermFreqs.get(word) || 0;
        if (tfName > 0) {
          scoreFileName += idf * fw.fileName * this.bm25Sat(tfName, fNameLen, avgFileNameLen, k1, b);
        }

        // 路径字段
        const tfPath = doc.pathTermFreqs.get(word) || 0;
        if (tfPath > 0) {
          scoreFilePath += idf * fw.filePath * this.bm25Sat(tfPath, pathLen, avgPathLen, k1, b);
        }

        // 内容字段
        const tfContent = doc.termFreqs.get(word) || 0;
        if (tfContent > 0) {
          scoreContent += idf * fw.content * this.bm25Sat(tfContent, docLen, avgdl, k1, b);
        }
      }

      const entryBonus = 0.1 * entries.length;
      const score = scoreFileName + scoreFilePath + scoreContent + entryBonus;

      results.push({
        filePath,
        fileName: filePath.split('/').pop() || filePath,
        entries,
        score,
        scoreBreakdown: {
          fileName: scoreFileName,
          filePath: scoreFilePath,
          content: scoreContent,
          entryBonus,
        },
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /** BM25 饱和度函数 */
  private bm25Sat(tf: number, docLen: number, avgdl: number, k1: number, b: number): number {
    const num = tf * (k1 + 1);
    const den = tf + k1 * (1 - b + b * (docLen / Math.max(1, avgdl)));
    return num / den;
  }

  private updateAvgDocLength(): void {
    if (this.docs.size === 0) {
      this.avgDocLength = 0;
      this.avgFileNameLen = 0;
      this.avgPathLen = 0;
      return;
    }
    let total = 0;
    let totalFName = 0;
    let totalPath = 0;
    for (const doc of this.docs.values()) {
      total += doc.wordCount;
      totalFName += doc.fileNameWordCount;
      totalPath += doc.pathWordCount;
    }
    this.avgDocLength = total / this.docs.size;
    this.avgFileNameLen = totalFName / this.docs.size;
    this.avgPathLen = totalPath / this.docs.size;
  }
}
