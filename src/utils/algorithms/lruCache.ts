/**
 * LRU 缓存算法 (Least Recently Used Cache)
 * ============================================================================
 * 
 * 应用场景：
 * 1. 最近打开文件缓存：避免重复从磁盘读取文件内容
 * 2. 目录结构缓存：文件树展开后缓存子目录，减少 IPC/fs 调用
 * 3. 编辑器状态缓存：滚动位置、光标位置、选区范围
 * 
 * 算法原理：
 * 使用哈希表 + 双向链表实现 O(1) 的读写和淘汰：
 * - 哈希表：key → 链表节点，实现 O(1) 查找
 * - 双向链表：按访问时间排序，头部为最近使用，尾部为最久未使用
 * - 容量满时淘汰尾部节点（LRU 策略）
 * 
 * 时间复杂度：
 * - get: O(1)
 * - set: O(1)
 * - delete: O(1)
 * - 空间: O(capacity)
 * 
 * 相比普通 Map 的优势：
 * - 自动控制容量上限，防止内存泄漏
 * - 按使用频率自动淘汰冷数据
 * ============================================================================
 */

interface CacheNode<K, V> {
  key: K;
  value: V;
  prev: CacheNode<K, V> | null;
  next: CacheNode<K, V> | null;
  /** 上次访问时间戳 */
  timestamp: number;
  /** 命中次数（替代独立的 hits Map，减少一个数据结构维护开销） */
  hitCount: number;
}

function createNode<K, V>(key: K, value: V): CacheNode<K, V> {
  return {
    key,
    value,
    prev: null,
    next: null,
    timestamp: Date.now(),
    hitCount: 0,
  };
}

export interface CacheEntry<V> {
  value: V;
  hit: boolean;
  /** 命中次数 */
  hits: number;
}

export class LRUCache<K, V> {
  private capacity: number;
  private cache: Map<K, CacheNode<K, V>>;
  private head: CacheNode<K, V>;
  private tail: CacheNode<K, V>;
  private missCount = 0;
  private hitCount = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
    this.cache = new Map();

    // 虚拟头尾节点，简化边界处理
    this.head = createNode<K, V>(null as unknown as K, null as unknown as V);
    this.tail = createNode<K, V>(null as unknown as K, null as unknown as V);
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  /**
   * 获取缓存值
   * @returns 命中时移动到链表头部（最近使用）
   */
  get(key: K): CacheEntry<V> | null {
    const node = this.cache.get(key);

    if (!node) {
      this.missCount++;
      return null;
    }

    // 命中：移动到头部
    this.moveToHead(node);
    node.timestamp = Date.now();
    node.hitCount++;
    this.hitCount++;

    return {
      value: node.value,
      hit: true,
      hits: node.hitCount,
    };
  }

  /**
   * 设置缓存值
   * @returns 是否发生了淘汰
   */
  set(key: K, value: V): { evicted: boolean; evictedKey?: K } {
    const node = this.cache.get(key);

    if (node) {
      // 更新现有节点
      node.value = value;
      node.timestamp = Date.now();
      this.moveToHead(node);
      return { evicted: false };
    }

    // 新节点
    const newNode = createNode(key, value);
    this.cache.set(key, newNode);
    this.addToHead(newNode);

    // 超出容量，淘汰尾部
    if (this.cache.size > this.capacity) {
      const evicted = this.removeTail();
      if (evicted) {
        this.cache.delete(evicted.key);
        return { evicted: true, evictedKey: evicted.key };
      }
    }

    return { evicted: false };
  }

  /**
   * 删除指定 key
   */
  delete(key: K): boolean {
    const node = this.cache.get(key);
    if (!node) return false;

    this.removeNode(node);
    this.cache.delete(key);
    return true;
  }

  /**
   * 检查 key 是否存在（不更新访问顺序）
   */
  has(key: K): boolean {
    return this.cache.has(key);
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear();
    this.head.next = this.tail;
    this.tail.prev = this.head;
    this.hitCount = 0;
    this.missCount = 0;
  }

  /**
   * 获取缓存统计信息
   */
  getStats() {
    return {
      size: this.cache.size,
      capacity: this.capacity,
      hitCount: this.hitCount,
      missCount: this.missCount,
      hitRate: this.hitCount + this.missCount > 0
        ? (this.hitCount / (this.hitCount + this.missCount)).toFixed(2)
        : '0.00',
    };
  }

  /**
   * 获取所有 key（按 LRU 顺序：最近使用在前）
   */
  keys(): K[] {
    const keys: K[] = [];
    let current = this.head.next;
    while (current && current !== this.tail) {
      keys.push(current.key);
      current = current.next;
    }
    return keys;
  }

  /**
   * 获取过期条目（超过指定毫秒未访问）
   */
  getExpired(maxAgeMs: number): K[] {
    const now = Date.now();
    const expired: K[] = [];
    let current = this.tail.prev;

    while (current && current !== this.head) {
      if (now - current.timestamp > maxAgeMs) {
        expired.push(current.key);
      } else {
        // 链表按时间排序，后面的不会过期
        break;
      }
      current = current.prev;
    }

    return expired;
  }

  /** 将节点添加到链表头部 */
  private addToHead(node: CacheNode<K, V>): void {
    node.prev = this.head;
    node.next = this.head.next;
    this.head.next!.prev = node;
    this.head.next = node;
  }

  /** 从链表中移除节点 */
  private removeNode(node: CacheNode<K, V>): void {
    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;
  }

  /** 将已有节点移动到头部 */
  private moveToHead(node: CacheNode<K, V>): void {
    this.removeNode(node);
    this.addToHead(node);
  }

  /** 移除尾部节点（最久未使用） */
  private removeTail(): CacheNode<K, V> | null {
    const node = this.tail.prev;
    if (node === this.head || !node) return null;
    this.removeNode(node);
    return node;
  }
}

/**
 * 文件内容专用缓存
 * 带文件修改时间验证，自动失效过期缓存
 */
export class FileContentCache extends LRUCache<string, { content: string; mtime: number }> {
  constructor(capacity = 20) {
    super(capacity);
  }

  /**
   * 获取文件内容，同时验证是否过期
   * @param path 文件路径
   * @param currentMtime 当前文件修改时间
   */
  getValid(path: string, currentMtime: number): { content: string; hit: boolean } | null {
    const entry = this.get(path);
    if (!entry) return null;
    
    const cached = entry.value;
    if (cached.mtime !== currentMtime) {
      // 文件已修改，缓存失效
      this.delete(path);
      return null;
    }
    
    return { content: cached.content, hit: true };
  }

  /**
   * 缓存文件内容
   */
  setContent(path: string, content: string, mtime: number): void {
    this.set(path, { content, mtime });
  }
}
