/**
 * ARC 自适应替换缓存 (Adaptive Replacement Cache)
 * ============================================================================
 *
 * ## 理论基础
 *
 * ARC (Megiddo & Modha, 2003) 自适应平衡 "最近性"(recency) 与 "频率"(frequency)，
 * 维护四个链表：
 *   T1: 最近访问一次的数据 (LRU)
 *   T2: 最近访问多次的数据 (LRU)
 *   B1: 从 T1 淘汰的幽灵记录 (只存 key)
 *   B2: 从 T2 淘汰的幽灵记录 (只存 key)
 *
 * 自适应参数 p ∈ [0, c]：
 *   - B1 命中 → p 增大 → 倾向 T1 (最近性更重要)
 *   - B2 命中 → p 减小 → 倾向 T2 (频率更重要)
 *
 * ## 竞争比保证
 *
 * ARC 对任意访问序列的竞争比 ≤ 2 (相比离线最优 LFD)，
 * 而 LRU 无此保证。对扫描型访问 (一次性遍历大量数据) 抵抗力强。
 *
 * ## 自适应规则
 *
 *   Case 1 (B1 命中): p = min(p + max(|B2|/|B1|, 1), c)
 *   Case 2 (B2 命中): p = max(p - max(|B1|/|B2|, 1), 0)
 *
 * ## 复杂度
 *   get: O(1), set: O(1), 空间: O(c)
 * ============================================================================
 */

interface ARCNode<K, V> {
  key: K;
  value: V | null;  // 幽灵节点 value = null
  prev: ARCNode<K, V> | null;
  next: ARCNode<K, V> | null;
}

type ListId = 'T1' | 'T2' | 'B1' | 'B2';

export class ARCCache<K, V> {
  private capacity: number;
  private p = 0; // 自适应参数
  private t1 = new Set<K>();
  private t2 = new Set<K>();
  private b1 = new Set<K>();
  private b2 = new Set<K>();
  private nodes = new Map<K, ARCNode<K, V>>();
  private heads: Record<ListId, ARCNode<K, V>>;
  private tails: Record<ListId, ARCNode<K, V>>;
  private hitCount = 0;
  private missCount = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
    this.heads = {} as Record<ListId, ARCNode<K, V>>;
    this.tails = {} as Record<ListId, ARCNode<K, V>>;
    for (const id of ['T1', 'T2', 'B1', 'B2'] as ListId[]) {
      const head: ARCNode<K, V> = { key: null as unknown as K, value: null, prev: null, next: null };
      const tail: ARCNode<K, V> = { key: null as unknown as K, value: null, prev: null, next: null };
      head.next = tail;
      tail.prev = head;
      this.heads[id] = head;
      this.tails[id] = tail;
    }
  }

  get(key: K): V | null {
    const node = this.nodes.get(key);
    if (!node) {
      this.missCount++;
      return null;
    }
    // 命中 T1 → 提升到 T2 MRU
    if (this.t1.has(key)) {
      this.t1.delete(key);
      this.t2.add(key);
      this.moveToMRU(node, 'T2');
      this.hitCount++;
      return node.value;
    }
    // 命中 T2 → 移到 T2 MRU
    if (this.t2.has(key)) {
      this.moveToMRU(node, 'T2');
      this.hitCount++;
      return node.value;
    }
    // 幽灵命中不算 hit
    this.missCount++;
    return null;
  }

  set(key: K, value: V): void {
    const existing = this.nodes.get(key);
    if (existing && existing.value !== null) {
      existing.value = value;
      if (this.t1.has(key)) {
        this.t1.delete(key);
        this.t2.add(key);
        this.moveToMRU(existing, 'T2');
      } else if (this.t2.has(key)) {
        this.moveToMRU(existing, 'T2');
      }
      return;
    }

    // Case 1: B1 幽灵命中 → 增大 p
    if (this.b1.has(key)) {
      const delta = Math.max(Math.floor(this.b2.size / Math.max(this.b1.size, 1)), 1);
      this.p = Math.min(this.p + delta, this.capacity);
      this.replace(key, true);
      this.b1.delete(key);
      // 移除幽灵节点，创建新数据节点
      const ghost = this.nodes.get(key);
      if (ghost) this.removeNode(ghost);
      const node = this.createNode(key, value);
      this.nodes.set(key, node);
      this.addToMRU(node, 'T2');
      this.t2.add(key);
      return;
    }

    // Case 2: B2 幽灵命中 → 减小 p
    if (this.b2.has(key)) {
      const delta = Math.max(Math.floor(this.b1.size / Math.max(this.b2.size, 1)), 1);
      this.p = Math.max(this.p - delta, 0);
      this.replace(key, false);
      this.b2.delete(key);
      const ghost = this.nodes.get(key);
      if (ghost) this.removeNode(ghost);
      const node = this.createNode(key, value);
      this.nodes.set(key, node);
      this.addToMRU(node, 'T2');
      this.t2.add(key);
      return;
    }

    // 新 key
    const totalSize = this.t1.size + this.t2.size;
    if (totalSize >= this.capacity) {
      this.replace(key, false);
    }

    const node = this.createNode(key, value);
    this.nodes.set(key, node);
    this.addToMRU(node, 'T1');
    this.t1.add(key);
  }

  has(key: K): boolean {
    return this.t1.has(key) || this.t2.has(key);
  }

  delete(key: K): boolean {
    const node = this.nodes.get(key);
    if (!node) return false;
    this.removeNode(node);
    this.nodes.delete(key);
    this.t1.delete(key);
    this.t2.delete(key);
    this.b1.delete(key);
    this.b2.delete(key);
    return true;
  }

  clear(): void {
    this.t1.clear(); this.t2.clear(); this.b1.clear(); this.b2.clear();
    this.nodes.clear();
    this.p = 0;
    this.hitCount = 0;
    this.missCount = 0;
    for (const id of ['T1', 'T2', 'B1', 'B2'] as ListId[]) {
      this.heads[id].next = this.tails[id];
      this.tails[id].prev = this.heads[id];
    }
  }

  getStats() {
    const total = this.hitCount + this.missCount;
    return {
      size: this.t1.size + this.t2.size,
      capacity: this.capacity,
      t1Size: this.t1.size,
      t2Size: this.t2.size,
      b1Size: this.b1.size,
      b2Size: this.b2.size,
      adaptiveP: this.p,
      hitCount: this.hitCount,
      missCount: this.missCount,
      hitRate: total > 0 ? (this.hitCount / total).toFixed(2) : '0.00',
    };
  }

  /** ARC REPLACE: 核心替换逻辑 */
  private replace(_key: K, inB1: boolean): void {
    if (this.t1.size === 0 && this.t2.size === 0) return;

    if (this.t1.size > 0 && (this.t1.size > this.p || (inB1 && this.t1.size === this.p))) {
      // 从 T1 LRU 淘汰到 B1
      const lruKey = this.getLRUKey('T1');
      if (lruKey !== null) {
        const lruNode = this.nodes.get(lruKey);
        if (lruNode) {
          this.removeNode(lruNode);
          lruNode.value = null; // 变幽灵
          this.t1.delete(lruKey);
          this.b1.add(lruKey);
          this.addToMRU(lruNode, 'B1');
        }
      }
    } else {
      // 从 T2 LRU 淘汰到 B2
      const lruKey = this.getLRUKey('T2');
      if (lruKey !== null) {
        const lruNode = this.nodes.get(lruKey);
        if (lruNode) {
          this.removeNode(lruNode);
          lruNode.value = null;
          this.t2.delete(lruKey);
          this.b2.add(lruKey);
          this.addToMRU(lruNode, 'B2');
        }
      }
    }
  }

  private createNode(key: K, value: V | null): ARCNode<K, V> {
    return { key, value, prev: null, next: null };
  }

  private addToMRU(node: ARCNode<K, V>, list: ListId): void {
    const head = this.heads[list];
    node.prev = head;
    node.next = head.next;
    head.next!.prev = node;
    head.next = node;
  }

  private removeNode(node: ARCNode<K, V>): void {
    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;
  }

  private moveToMRU(node: ARCNode<K, V>, list: ListId): void {
    this.removeNode(node);
    this.addToMRU(node, list);
  }

  private getLRUKey(list: ListId): K | null {
    const tail = this.tails[list];
    const lru = tail.prev;
    if (lru === this.heads[list] || !lru) return null;
    return lru.key;
  }
}
