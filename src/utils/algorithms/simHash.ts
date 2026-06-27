/**
 * SimHash 局部敏感哈希 (LSH) 快速预过滤
 * ============================================================================
 *
 * 数学原理:
 *   1. 对字符串做 n-gram 特征提取 (n=2,3)
 *   2. 每个特征用 MurmurHash3 生成 64-bit 哈希
 *   3. 聚合：每位按 weight × (+1 或 -1) 累加
 *   4. 最终 SimHash：累加和 > 0 → 1，否则 → 0
 *
 * 汉明距离相似性:
 *   P[Hamming(simhash(a), simhash(b)) ≤ k] ≈ 1 - (1 - pᵏ)^d
 *   其中 p = P[bit matches] = 1 - θ/π（余弦相似度的线性函数）
 *
 * 应用场景:
 *   - 模糊搜索预过滤：淘汰汉明距离 > 阈值的候选
 *   - 大文件列表快速去重
 * ============================================================================
 */

import { ARCCache } from './arcCache';

/** 64-bit SimHash 类型 */
export type SimHashValue = bigint;

/** FNV-1a 64-bit 哈希 (快速替代 MurmurHash3) */
function fnv1a64(str: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash;
}

/** 计算汉明距离 (两个 bigint 间不同位数) */
export function hammingDistance(a: bigint, b: bigint): number {
  let diff = a ^ b;
  let count = 0;
  while (diff > 0n) {
    count++;
    diff &= diff - 1n; // Brian Kernighan 算法: O(bits_set)
  }
  return count;
}

/** 汉明距离查表 (每字节查一次，加速) */
const BYTE_POPCOUNT: number[] = (() => {
  const table = new Array(256);
  for (let i = 0; i < 256; i++) {
    let c = 0;
    let v = i;
    while (v) { c++; v &= v - 1; }
    table[i] = c;
  }
  return table;
})();

export function hammingDistanceFast(a: bigint, b: bigint): number {
  let diff = a ^ b;
  let count = 0;
  // 8 字节 → 逐字节查表
  for (let i = 0; i < 8; i++) {
    count += BYTE_POPCOUNT[Number(diff & 0xffn)];
    diff >>= 8n;
  }
  return count;
}

/**
 * 计算字符串的 SimHash 指纹
 * @param text 输入字符串
 * @returns 64-bit SimHash
 */
export function computeSimHash(text: string): bigint {
  const len = text.length;
  if (len === 0) return 0n;

  const vector = new Float64Array(64);

  // 提取 2-gram 和 3-gram 特征
  for (let i = 0; i <= len - 2; i++) {
    const biGram = text.substring(i, i + 2);
    const hash = fnv1a64(biGram);
    // 每位累加权重
    for (let b = 0; b < 64; b++) {
      const bit = (hash >> BigInt(b)) & 1n;
      vector[b] += bit === 1n ? 1 : -1;
    }
  }

  // 3-gram 权重减半（减少噪音）
  if (len >= 3) {
    for (let i = 0; i <= len - 3; i++) {
      const triGram = text.substring(i, i + 3);
      const hash = fnv1a64(triGram);
      for (let b = 0; b < 64; b++) {
        const bit = (hash >> BigInt(b)) & 1n;
        vector[b] += (bit === 1n ? 1 : -1) * 0.5;
      }
    }
  }

  // 生成最终 SimHash
  let result = 0n;
  for (let b = 0; b < 64; b++) {
    if (vector[b] > 0) {
      result |= (1n << BigInt(b));
    }
  }

  return result;
}

/**
 * SimHash 预过滤搜索引擎
 *
 * 使用 SimHash + 汉明距离分桶预过滤，
 * 在精确 DP 模糊搜索之前快速淘汰不相关候选。
 * 配合 ARC 缓存避免重复计算 SimHash。
 */
export class SimHashFilter {
  private simhashCache: ARCCache<string, bigint>;

  constructor(cacheSize = 2000) {
    this.simhashCache = new ARCCache<string, bigint>(cacheSize);
  }

  /** 获取字符串的 SimHash (带缓存) */
  getSimHash(text: string): bigint {
    const cached = this.simhashCache.get(text);
    if (cached !== null) return cached;
    const hash = computeSimHash(text);
    this.simhashCache.set(text, hash);
    return hash;
  }

  /**
   * 预过滤候选集
   *
   * 仅保留与 query 的 SimHash 汉明距离在阈值内的候选。
   * 阈值根据 query 长度自适应：
   *   |Query| ≤ 3  → maxDist = 12
   *   |Query| ≤ 6  → maxDist = 10
   *   |Query| ≤ 10 → maxDist = 8
   *   |Query| > 10 → maxDist = 6
   *
   * @returns 通过过滤的候选索引数组
   */
  filter(
    query: string,
    candidates: string[],
  ): number[] {
    if (query.length === 0) return candidates.map((_, i) => i);

    const queryHash = this.getSimHash(query);

    // 自适应汉明距离阈值
    const maxDist = query.length <= 3 ? 12
      : query.length <= 6 ? 10
      : query.length <= 10 ? 8
      : 6;

    const passed: number[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const candHash = this.getSimHash(candidates[i]);
      if (hammingDistanceFast(queryHash, candHash) <= maxDist) {
        passed.push(i);
      }
    }

    return passed;
  }

  clearCache(): void {
    this.simhashCache.clear();
  }

  getStats() {
    return this.simhashCache.getStats();
  }
}
