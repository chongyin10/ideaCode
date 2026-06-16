/**
 * terminalIndexes.ts — 高效索引数据结构和搜索算法
 *
 * 包含:
 * 1. 跳表 (Skip List) — 书签按行号排序, O(log n) 查找
 * 2. 区间树 (Interval Tree) — 终端输出段折叠, O(log n) 定位
 * 3. Aho-Corasick 自动机 — 多模式匹配 (命令纠错)
 * 4. Bloom Filter — 正则匹配预筛选
 * 5. Boyer-Moore — 快速字符串搜索
 */

/* ===========================================================
   1. 跳表 — 书签索引
   =========================================================== */

const SKIP_MAX_LEVEL = 16;
const SKIP_P = 0.5;

interface SkipNode<T> {
  key: number;      // 行号
  value: T;         // 书签数据
  forward: Array<SkipNode<T> | null>;
}

export class SkipList<T> {
  private head: SkipNode<T>;
  private level = 0;
  private _size = 0;

  constructor() {
    this.head = { key: -Infinity, value: null as unknown as T, forward: new Array(SKIP_MAX_LEVEL).fill(null) };
  }

  get size(): number { return this._size; }

  /** 插入 */
  insert(key: number, value: T) {
    const update: Array<SkipNode<T>> = new Array(SKIP_MAX_LEVEL);
    let x = this.head;
    for (let i = this.level; i >= 0; i--) {
      while (x.forward[i] && x.forward[i]!.key < key) x = x.forward[i]!;
      update[i] = x;
    }

    const newLevel = this.randomLevel();
    if (newLevel > this.level) {
      for (let i = this.level + 1; i <= newLevel; i++) update[i] = this.head;
      this.level = newLevel;
    }

    const node: SkipNode<T> = { key, value, forward: new Array(newLevel + 1).fill(null) };
    for (let i = 0; i <= newLevel; i++) {
      node.forward[i] = update[i].forward[i];
      update[i].forward[i] = node;
    }
    this._size++;
  }

  /** 查找 key */
  find(key: number): T | null {
    let x = this.head;
    for (let i = this.level; i >= 0; i--) {
      while (x.forward[i] && x.forward[i]!.key < key) x = x.forward[i]!;
    }
    x = x.forward[0]!;
    if (x && x.key === key) return x.value;
    return null;
  }

  /** 找到 key 的前驱 */
  findPredecessor(key: number): T | null {
    let x = this.head;
    for (let i = this.level; i >= 0; i--) {
      while (x.forward[i] && x.forward[i]!.key < key) x = x.forward[i]!;
    }
    if (x !== this.head) return x.value;
    return null;
  }

  /** 删除 */
  delete(key: number): boolean {
    const update: Array<SkipNode<T>> = new Array(SKIP_MAX_LEVEL);
    let x = this.head;
    for (let i = this.level; i >= 0; i--) {
      while (x.forward[i] && x.forward[i]!.key < key) x = x.forward[i]!;
      update[i] = x;
    }
    x = x.forward[0]!;
    if (!x || x.key !== key) return false;

    for (let i = 0; i <= this.level; i++) {
      if (update[i].forward[i] !== x) break;
      update[i].forward[i] = x.forward[i];
    }
    while (this.level > 0 && this.head.forward[this.level] === null) this.level--;
    this._size--;
    return true;
  }

  /** 获取所有 key（有序） */
  keys(): number[] {
    const result: number[] = [];
    let x = this.head.forward[0];
    while (x) { result.push(x.key); x = x.forward[0]; }
    return result;
  }

  /** 获取所有 value（有序） */
  values(): T[] {
    const result: T[] = [];
    let x = this.head.forward[0];
    while (x) { result.push(x.value); x = x.forward[0]; }
    return result;
  }

  clear() {
    this.head = { key: -Infinity, value: null as unknown as T, forward: new Array(SKIP_MAX_LEVEL).fill(null) };
    this.level = 0;
    this._size = 0;
  }

  private randomLevel(): number {
    let lvl = 0;
    while (Math.random() < SKIP_P && lvl < SKIP_MAX_LEVEL - 1) lvl++;
    return lvl;
  }
}

/* ===========================================================
   2. 区间树 — 终端输出段折叠
   =========================================================== */

interface IntervalNode<T> {
  interval: [number, number]; // [start, end]
  maxEnd: number;
  data: T;
  height: number;
  left: IntervalNode<T> | null;
  right: IntervalNode<T> | null;
}

export class IntervalTree<T = unknown> {
  private root: IntervalNode<T> | null = null;

  /** 插入区间 */
  insert(start: number, end: number, data: T) {
    this.root = this._insert(this.root, start, end, data);
  }

  /** 查找包含 point 的区间 */
  findContaining(point: number): T | null {
    return this._findContaining(this.root, point);
  }

  /** 查找与 [start, end] 重叠的所有区间 */
  findOverlapping(start: number, end: number): T[] {
    const result: T[] = [];
    this._findOverlapping(this.root, start, end, result);
    return result;
  }

  clear() { this.root = null; }

  private _height(node: IntervalNode<T> | null): number { return node ? node.height : 0; }

  private _rotateRight(y: IntervalNode<T>): IntervalNode<T> {
    const x = y.left!;
    y.left = x.right;
    x.right = y;
    y.height = Math.max(this._height(y.left), this._height(y.right)) + 1;
    x.height = Math.max(this._height(x.left), this._height(x.right)) + 1;
    y.maxEnd = Math.max(y.interval[1], Math.max(this._maxEnd(y.left), this._maxEnd(y.right)));
    x.maxEnd = Math.max(x.interval[1], Math.max(this._maxEnd(x.left), this._maxEnd(x.right)));
    return x;
  }

  private _rotateLeft(x: IntervalNode<T>): IntervalNode<T> {
    const y = x.right!;
    x.right = y.left;
    y.left = x;
    x.height = Math.max(this._height(x.left), this._height(x.right)) + 1;
    y.height = Math.max(this._height(y.left), this._height(y.right)) + 1;
    x.maxEnd = Math.max(x.interval[1], Math.max(this._maxEnd(x.left), this._maxEnd(x.right)));
    y.maxEnd = Math.max(y.interval[1], Math.max(this._maxEnd(y.left), this._maxEnd(y.right)));
    return y;
  }

  private _maxEnd(node: IntervalNode<T> | null): number { return node ? node.maxEnd : -Infinity; }

  private _insert(node: IntervalNode<T> | null, start: number, end: number, data: T): IntervalNode<T> {
    if (!node) {
      return { interval: [start, end], maxEnd: end, data, height: 1, left: null, right: null };
    }
    if (start < node.interval[0]) {
      node.left = this._insert(node.left, start, end, data);
    } else {
      node.right = this._insert(node.right, start, end, data);
    }
    node.height = Math.max(this._height(node.left), this._height(node.right)) + 1;
    node.maxEnd = Math.max(node.interval[1], Math.max(this._maxEnd(node.left), this._maxEnd(node.right)));

    const balance = this._height(node.left) - this._height(node.right);
    if (balance > 1 && start < node.left!.interval[0]) return this._rotateRight(node);
    if (balance < -1 && start > node.right!.interval[0]) return this._rotateLeft(node);
    if (balance > 1 && start > node.left!.interval[0]) { node.left = this._rotateLeft(node.left!); return this._rotateRight(node); }
    if (balance < -1 && start < node.right!.interval[0]) { node.right = this._rotateRight(node.right!); return this._rotateLeft(node); }
    return node;
  }

  private _findContaining(node: IntervalNode<T> | null, point: number): T | null {
    if (!node) return null;
    if (point >= node.interval[0] && point <= node.interval[1]) return node.data;
    if (node.left && node.left.maxEnd >= point) return this._findContaining(node.left, point);
    return this._findContaining(node.right, point);
  }

  private _findOverlapping(node: IntervalNode<T> | null, start: number, end: number, result: T[]) {
    if (!node) return;
    if (start <= node.interval[1] && end >= node.interval[0]) result.push(node.data);
    if (node.left && node.left.maxEnd >= start) this._findOverlapping(node.left, start, end, result);
    if (end >= node.interval[0]) this._findOverlapping(node.right, start, end, result);
  }
}

/* ===========================================================
   3. Aho-Corasick 多模式匹配自动机
   =========================================================== */

interface ACNode {
  children: Map<string, ACNode>;
  fail: ACNode | null;
  outputs: string[]; // 匹配到的模式
  depth: number;
}

export class AhoCorasick {
  private root: ACNode;

  constructor(patterns: string[]) {
    this.root = { children: new Map(), fail: null, outputs: [], depth: 0 };
    this._buildTrie(patterns);
    this._buildFailLinks();
  }

  /** 在 text 中查找所有匹配 */
  search(text: string): Array<{ pattern: string; index: number }> {
    const results: Array<{ pattern: string; index: number }> = [];
    let node = this.root;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      while (node !== this.root && !node.children.has(ch)) {
        node = node.fail!;
      }
      const next = node.children.get(ch);
      if (next) {
        node = next;
        for (const pattern of node.outputs) {
          results.push({ pattern, index: i - pattern.length + 1 });
        }
      }
    }
    return results;
  }

  /** 查找第一个匹配 */
  findFirst(text: string): { pattern: string; index: number } | null {
    let node = this.root;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      while (node !== this.root && !node.children.has(ch)) {
        node = node.fail!;
      }
      const next = node.children.get(ch);
      if (next) {
        node = next;
        if (node.outputs.length > 0) {
          return { pattern: node.outputs[0], index: i - node.outputs[0].length + 1 };
        }
      }
    }
    return null;
  }

  private _buildTrie(patterns: string[]) {
    for (const pattern of patterns) {
      let node = this.root;
      for (const ch of pattern) {
        if (!node.children.has(ch)) {
          node.children.set(ch, { children: new Map(), fail: null, outputs: [], depth: node.depth + 1 });
        }
        node = node.children.get(ch)!;
      }
      node.outputs.push(pattern);
    }
  }

  private _buildFailLinks() {
    const queue: ACNode[] = [];
    // 第 1 层直接链接到 root
    this.root.children.forEach((child) => {
      child.fail = this.root;
      queue.push(child);
    });
    // BFS
    while (queue.length > 0) {
      const node = queue.shift()!;
      node.children.forEach((child, ch) => {
        queue.push(child);
        let fail = node.fail;
        while (fail !== null && !fail.children.has(ch)) {
          fail = fail.fail;
        }
        child.fail = fail ? fail.children.get(ch)! : this.root;
        child.outputs.push(...(child.fail.outputs || []));
      });
    }
  }
}

/* ===========================================================
   4. Bloom Filter — 预筛选
   =========================================================== */

export class BloomFilter {
  private bits: Uint8Array;
  private hashCount: number;

  constructor(private size: number = 1024, hashCount: number = 3) {
    this.bits = new Uint8Array(Math.ceil(size / 8));
    this.hashCount = hashCount;
  }

  /** 添加元素 */
  add(item: string) {
    for (let i = 0; i < this.hashCount; i++) {
      const hash = this._hash(item, i) % this.size;
      this.bits[Math.floor(hash / 8)] |= 1 << (hash % 8);
    }
  }

  /** 检查可能存在 */
  mightContain(item: string): boolean {
    for (let i = 0; i < this.hashCount; i++) {
      const hash = this._hash(item, i) % this.size;
      if (!(this.bits[Math.floor(hash / 8)] & (1 << (hash % 8)))) return false;
    }
    return true;
  }

  /** 检查字符串中是否包含任意 filter 中的子串 */
  mightContainSubstring(text: string): boolean {
    // 滑动窗口, 检查文本片段
    for (let i = 0; i < text.length - 3; i++) {
      if (this.mightContain(text.substring(i, i + 4))) return true;
    }
    return false;
  }

  clear() { this.bits.fill(0); }

  private _hash(str: string, seed: number): number {
    let h = seed * 0x5bd1e995;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 0x5bd1e995);
      h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
    }
    return h >>> 0;
  }
}

/* ===========================================================
   5. Boyer-Moore 字符串搜索
   =========================================================== */

export class BoyerMoore {
  private pattern: string;
  private badChar: Map<string, number>; // 坏字符表 (简化版)

  constructor(pattern: string) {
    this.pattern = pattern;
    this.badChar = new Map();
    for (let i = 0; i < pattern.length; i++) {
      this.badChar.set(pattern[i], i);
    }
  }

  /**
   * 在 text 中搜索 pattern, 返回首次出现的索引, 否则 -1
   */
  search(text: string): number {
    const n = text.length;
    const m = this.pattern.length;
    if (m === 0) return 0;
    if (m > n) return -1;

    let skip = 0;
    while (skip <= n - m) {
      let j = m - 1;
      while (j >= 0 && this.pattern[j] === text[skip + j]) j--;
      if (j < 0) return skip;
      const bc = this.badChar.get(text[skip + j]) ?? -1;
      skip += Math.max(1, j - bc);
    }
    return -1;
  }

  /** 搜索所有匹配 */
  searchAll(text: string): number[] {
    const results: number[] = [];
    const n = text.length;
    const m = this.pattern.length;
    if (m === 0 || m > n) return results;

    let skip = 0;
    while (skip <= n - m) {
      let j = m - 1;
      while (j >= 0 && this.pattern[j] === text[skip + j]) j--;
      if (j < 0) {
        results.push(skip);
        skip++;
      } else {
        const bc = this.badChar.get(text[skip + j]) ?? -1;
        skip += Math.max(1, j - bc);
      }
    }
    return results;
  }
}
