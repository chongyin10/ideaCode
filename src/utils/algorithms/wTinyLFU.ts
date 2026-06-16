/**
 * W-TinyLFU 缓存替换策略
 *
 * 是 Caffeine 缓存库（Java）的核心算法，在 LRU 和 LFU 之间
 * 取得最佳平衡。解决了传统 LRU 的"缓存污染"问题（一次扫描
 * 冲刷全部有效缓存）和 LFU 的"缓存固化"问题（旧高频项永不淘汰）。
 *
 * ## 架构
 *
 *   ┌─────────────┐   晋级    ┌─────────────────┐
 *   │ Window LRU  │ ───────→ │   Main (SLRU)   │
 *   │ (准入窗口)   │          │  ┌───Probation──┐│
 *   │  1% 容量    │          │  │  (缓刑区)     ││
 *   └─────────────┘          │  ├───Protected──┤│
 *                            │  │  (保护区)     ││
 *                            │  └──────────────┘│
 *                            └─────────────────┘
 *
 * ## 流程
 *
 * 1. 新条目进入 Window LRU
 * 2. Window 满 → 受害者移入 Main Probation
 * 3. Main Probation 满 → 与 Window 受害者比较频率
 *    - 使用 TinyLFU (Count-Min Sketch) 估算频率
 *    - 如果新条目的频率 > 受害者频率 → 淘汰受害者
 *    - 否则淘汰新条目
 * 4. Probation 中高频条目 → 晋升到 Protected
 * 5. Protected 满 → 最旧的降级到 Probation
 *
 * ## TinyLFU（Count-Min Sketch）
 *
 * Count-Min Sketch 是概率数据结构，用 O(ε⁻¹·log(1/δ)) 空间
 * 近似频率估计。通过 d 个独立哈希函数映射到 w 个计数器数组。
 *
 * 增量计数:   ∀j∈[1,d]: sketch[j][hash_j(key)]++
 * 频率估计:   min_{j∈[1,d]} sketch[j][hash_j(key)]
 *
 * 使用"周期重置"（reset multiplier）防止历史数据固化：
 * 每 W 次访问，所有计数器乘以衰减因子 r (如 0.5)。
 */

export interface TinyLFUConfig {
  /** 计数器数组宽度（越大越精确） */
  width?: number;
  /** 哈希函数数量 */
  depth?: number;
  /** 重置窗口大小（多少次访问后衰减） */
  resetInterval?: number;
  /** 衰减因子 */
  decayFactor?: number;
}

class TinyLFU {
  private sketch: Uint32Array[];
  private readonly width: number;
  private readonly depth: number;
  private readonly resetInterval: number;
  private readonly decayFactor: number;
  private accessCount = 0;

  constructor(config: TinyLFUConfig = {}) {
    this.width = config.width ?? 64;
    this.depth = config.depth ?? 4;
    this.resetInterval = config.resetInterval ?? 100;
    this.decayFactor = config.decayFactor ?? 0.5;
    this.sketch = Array.from({ length: this.depth }, () => new Uint32Array(this.width));
  }

  /** FNV-1a 哈希（种子版） */
  private hash(key: string, seed: number): number {
    let h = 2166136261 ^ (seed * 16777619);
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /** 增加频率 */
  increment(key: string): void {
    this.accessCount++;
    if (this.accessCount >= this.resetInterval) this.reset();

    for (let i = 0; i < this.depth; i++) {
      const idx = this.hash(key, i) % this.width;
      const val = this.sketch[i][idx];
      if (val < 0xFFFFFFFF) this.sketch[i][idx] = val + 1;
    }
  }

  /** 估算频率 */
  estimate(key: string): number {
    let min = Infinity;
    for (let i = 0; i < this.depth; i++) {
      const idx = this.hash(key, i) % this.width;
      const val = this.sketch[i][idx];
      if (val < min) min = val;
    }
    return min;
  }

  /** 周期重置（衰减） */
  private reset(): void {
    const factor = this.decayFactor;
    for (const row of this.sketch) {
      for (let i = 0; i < this.width; i++) {
        row[i] = Math.floor(row[i] * factor);
      }
    }
    this.accessCount = 0;
  }
}

/** 链表节点 */
interface WTinyLFUNode<K, V> {
  key: K;
  value: V;
  prev: WTinyLFUNode<K, V> | null;
  next: WTinyLFUNode<K, V> | null;
}

/**
 * 简单的双链表实现
 */
class LinkedList<K, V> {
  private head: WTinyLFUNode<K, V>;
  private tail: WTinyLFUNode<K, V>;
  private _size = 0;

  constructor() {
    this.head = { key: null as unknown as K, value: null as unknown as V, prev: null, next: null };
    this.tail = { key: null as unknown as K, value: null as unknown as V, prev: null, next: null };
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  get size(): number { return this._size; }

  addToHead(node: WTinyLFUNode<K, V>): void {
    node.prev = this.head;
    node.next = this.head.next;
    this.head.next!.prev = node;
    this.head.next = node;
    this._size++;
  }

  remove(node: WTinyLFUNode<K, V>): boolean {
    if (!node.prev || !node.next) return false;
    node.prev.next = node.next;
    node.next.prev = node.prev;
    node.prev = null;
    node.next = null;
    this._size--;
    return true;
  }

  removeTail(): WTinyLFUNode<K, V> | null {
    const node = this.tail.prev;
    if (node === this.head || !node) return null;
    this.remove(node);
    return node;
  }

  moveToHead(node: WTinyLFUNode<K, V>): void {
    this.remove(node);
    this.addToHead(node);
  }

  getTail(): WTinyLFUNode<K, V> | null {
    const node = this.tail.prev;
    return node === this.head ? null : node;
  }
}

export interface WTinyLFUConfig {
  /** 最大容量 */
  maxSize: number;
  /** TinyLFU 配置 */
  tinyLFU?: TinyLFUConfig;
}

export class WTinyLFU<K extends string, V> {
  private readonly maxSize: number;
  private readonly windowMax: number;
  private readonly mainMax: number;
  private readonly probationMax: number;
  private readonly protectedMax: number;

  private readonly data = new Map<K, WTinyLFUNode<K, V>>();

  // Window LRU
  private readonly windowList = new LinkedList<K, V>();
  // Main Probation SLRU
  private readonly probationList = new LinkedList<K, V>();
  // Main Protected SLRU
  private readonly protectedList = new LinkedList<K, V>();

  // TinyLFU 频率估计器
  private readonly tinyLFU: TinyLFU;

  private hitCount = 0;
  private missCount = 0;

  constructor(config: WTinyLFUConfig) {
    this.maxSize = Math.max(1, config.maxSize);
    // Window = 1%, Main = 99%
    this.windowMax = Math.max(1, Math.ceil(this.maxSize * 0.01));
    this.mainMax = this.maxSize - this.windowMax;
    // Probation = 20% of Main, Protected = 80% of Main
    this.probationMax = Math.max(1, Math.ceil(this.mainMax * 0.2));
    this.protectedMax = Math.max(1, this.mainMax - this.probationMax);
    this.tinyLFU = new TinyLFU(config.tinyLFU);
  }

  get size(): number { return this.data.size; }

  get(key: K): V | null {
    const node = this.data.get(key);
    if (!node) {
      this.missCount++;
      return null;
    }

    this.tinyLFU.increment(key as string);

    // 确定节点在哪个段并重新放置
    const segment = this.reList(node);
    if (segment === 'window') {
      // 在 Window → 移到 Window 头部
      this.windowList.addToHead(node);
    } else if (segment === 'protected') {
      // 在 Protected → 移到 Protected 头部
      this.protectedList.addToHead(node);
    } else if (segment === 'probation') {
      // 在 Probation → 如果频率够高，晋升到 Protected
      const freqEstimate = this.tinyLFU.estimate(key as string);
      if (freqEstimate > 3) {
        // 晋升到 Protected
        if (this.protectedList.size >= this.protectedMax) {
          // Protected 满 → 降级最旧的到 Probation
          const demoted = this.protectedList.removeTail();
          if (demoted) this.probationList.addToHead(demoted);
        }
        this.protectedList.addToHead(node);
      } else {
        this.probationList.addToHead(node);
      }
    }

    this.hitCount++;
    return node.value;
  }

  /** 尝试从所在链表移除节点，返回所在段 */
  private reList(node: WTinyLFUNode<K, V>): 'window' | 'probation' | 'protected' | null {
    if (this.windowList.remove(node)) return 'window';
    if (this.probationList.remove(node)) return 'probation';
    if (this.protectedList.remove(node)) return 'protected';
    return null;
  }

  set(key: K, value: V): void {
    const existing = this.data.get(key);
    if (existing) {
      existing.value = value;
      this.get(key); // 触发访问更新
      return;
    }

    // 频率记录
    this.tinyLFU.increment(key as string);

    const node: WTinyLFUNode<K, V> = { key, value, prev: null, next: null };
    this.data.set(key, node);

    // 有空位 → 直接放入 Window
    if (this.data.size <= this.maxSize) {
      this.windowList.addToHead(node);
      return;
    }

    // 缓存满了 → 需要淘汰
    this.evict(key, node);
  }

  /** 淘汰策略 */
  private evict(newKey: K, newNode: WTinyLFUNode<K, V>): void {
    // Window 未满 → 淘汰到 Main
    if (this.windowList.size < this.windowMax) {
      this.windowList.addToHead(newNode);
      return;
    }

    // Window 受害者
    const windowVictim = this.windowList.removeTail();
    if (!windowVictim) {
      this.data.delete(newKey);
      return;
    }

    // Main (Probation) 受害者
    const probationVictim = this.probationList.getTail();

    if (probationVictim && this.probationList.size >= this.probationMax) {
      // 对比频率
      const newFreq = this.tinyLFU.estimate(newKey as string);
      const victimFreq = this.tinyLFU.estimate(windowVictim.key as string);

      if (newFreq > victimFreq) {
        // 淘汰 Window 受害者
        this.data.delete(windowVictim.key);
        // 新条目进入 Window
        this.windowList.addToHead(newNode);
      } else {
        // 淘汰新条目
        this.data.delete(newKey);
        // Window 受害者放回（保持 Window）
        this.windowList.addToHead(windowVictim);
      }
    } else {
      // Probation 还有空间 → Window 受害者移入 Probation
      this.probationList.addToHead(windowVictim);
      this.windowList.addToHead(newNode);

      // 如果总容量超标
      if (this.data.size > this.maxSize) {
        const tail = this.probationList.removeTail();
        if (tail) this.data.delete(tail.key);
      }
    }
  }

  has(key: K): boolean {
    return this.data.has(key);
  }

  delete(key: K): boolean {
    const node = this.data.get(key);
    if (!node) return false;
    this.reList(node);
    this.data.delete(key);
    return true;
  }

  clear(): void {
    this.data.clear();
    // 清空所有链表
    while (this.windowList.removeTail()) { /* drain */ }
    while (this.probationList.removeTail()) { /* drain */ }
    while (this.protectedList.removeTail()) { /* drain */ }
    this.hitCount = 0;
    this.missCount = 0;
  }

  getStats() {
    return {
      size: this.data.size,
      maxSize: this.maxSize,
      windowSize: this.windowList.size,
      probationSize: this.probationList.size,
      protectedSize: this.protectedList.size,
      hitCount: this.hitCount,
      missCount: this.missCount,
      hitRate: this.hitCount + this.missCount > 0
        ? (this.hitCount / (this.hitCount + this.missCount)).toFixed(4)
        : '0.0000',
    };
  }
}
