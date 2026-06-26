/**
 * 快速 Walsh-Hadamard 变换 (FWHT) — Diff 加速
 * ============================================================================
 *
 * 数学原理:
 *   沃尔什函数系 {wal(n, t)} 构成 L²[0,1] 的完备正交基。
 *   离散 Walsh-Hadamard 变换矩阵 H_N 满足:
 *     H_{2N} = [H_N  H_N ; H_N  -H_N]
 *     H_2 = [1   1 ; 1  -1]
 *
 *   由于 H_N 是正交对称矩阵，FWHT 可在 O(N log N) 内完成。
 *   对于 diff 加速: 两行代码的 FWHT 变换后向量的内积
 *   等价于原向量的相似度度量，但计算复杂度从 O(L²) 降到 O(L log L)。
 *
 *   行签名 = FWHT(line_vector)[压缩系数]，取 top-K 个最大系数作为签名。
 *   两行的签名内积近似其相似度。
 *
 * 应用场景:
 *   - 大文件 diff 预聚类: 快速识别"高度相似"的行对
 *   - Patience Diff 锚点发现: 加速唯一行匹配
 * ============================================================================
 */

/**
 * 就地快速 Walsh-Hadamard 变换 (FWHT)
 *
 * @param data 输入向量 (必须是 2 的幂次长度的 Float64Array)
 * @param normalized 是否归一化 (除以 √N)
 *
 * 时间复杂度: O(N log N)
 * 空间复杂度: O(1) (就地变换)
 */
export function fwht(data: Float64Array, normalized: boolean = true): void {
  const N = data.length;

  // 验证 N 是 2 的幂
  if ((N & (N - 1)) !== 0) {
    throw new Error(`FWHT requires power-of-2 length, got ${N}`);
  }

  // 蝶形变换
  for (let step = 1; step < N; step <<= 1) {
    for (let i = 0; i < N; i += step << 1) {
      for (let j = 0; j < step; j++) {
        const u = data[i + j];
        const v = data[i + j + step];
        data[i + j] = u + v;
        data[i + j + step] = u - v;
      }
    }
  }

  // 归一化
  if (normalized) {
    const invSqrtN = 1 / Math.sqrt(N);
    for (let i = 0; i < N; i++) {
      data[i] *= invSqrtN;
    }
  }
}

/**
 * 将任意长度字符串映射为 2 的幂次长度的特征向量
 *
 * 方法: 用字符滚动哈希为特征，填充到最近 2^K 长度
 */
function stringToFeatureVector(str: string, targetPow2: number): Float64Array {
  const vec = new Float64Array(targetPow2);
  const len = str.length;

  for (let i = 0; i < Math.min(len, targetPow2); i++) {
    // 字符编码 + 位置敏感哈希
    vec[i] = (str.charCodeAt(i) * 31 + i * 7) % 1021 / 1021;
  }

  return vec;
}

/**
 * 计算字符串的 Walsh-Hadamard 签名 (top-K 系数)
 *
 * @param text 输入字符串
 * @param topK 保留的最大系数数量
 * @returns [系数值, 系数索引] 数组，按系数绝对值降序
 */
export function computeWalshSignature(
  text: string,
  topK: number = 8
): Array<{ value: number; index: number }> {
  // 选择最近的 2 的幂长度
  const len = Math.max(16, text.length);
  const pow2 = 1 << Math.ceil(Math.log2(len));
  const vec = stringToFeatureVector(text, pow2);

  // FWHT 变换
  fwht(vec, true);

  // 提取 top-K 最大绝对值系数及其索引
  const indexed: Array<{ value: number; index: number }> = [];
  for (let i = 0; i < pow2; i++) {
    indexed.push({ value: Math.abs(vec[i]), index: i });
  }

  indexed.sort((a, b) => b.value - a.value);

  return indexed.slice(0, topK);
}

/**
 * 计算两个 Walsh 签名的相似度
 *
 * 公式: sim = Σ_i |v1_i ∩ v2_i| / √(Σ|v1| · Σ|v2|)
 *
 * 其中 ∩ 表示同索引系数的 min(|val1|, |val2|)
 */
export function walshSignatureSimilarity(
  sig1: Array<{ value: number; index: number }>,
  sig2: Array<{ value: number; index: number }>,
): number {
  // 构建 sig2 的索引查找表
  const sig2Map = new Map<number, number>();
  for (const s of sig2) {
    sig2Map.set(s.index, s.value);
  }

  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;

  for (const s1 of sig1) {
    norm1 += s1.value * s1.value;
    const v2 = sig2Map.get(s1.index);
    if (v2 !== undefined) {
      dotProduct += s1.value * v2;
    }
  }

  for (const s2 of sig2) {
    norm2 += s2.value * s2.value;
  }

  const denom = Math.sqrt(Math.max(norm1, 1e-10) * Math.max(norm2, 1e-10));
  return denom > 0 ? dotProduct / denom : 0;
}

/**
 * 行聚类加速器
 *
 * 用于大文件 diff：先计算所有行的 Walsh 签名，
 * 将签名相似度高的行对聚集，只在聚类内部做精确 Myers/LCS diff。
 *
 * 效果: 将 O(N²) 的行比较降为 O(N log N + K·C²)，
 * 其中 K 为聚类数，C 为每簇平均行数。
 */
export class WalshLineClusterer {
  private signatures: Map<number, Array<{ value: number; index: number }>> = new Map();
  private topK: number;

  constructor(topK: number = 8) {
    this.topK = topK;
  }

  /** 为行集合计算签名 */
  indexLines(lines: string[]): void {
    this.signatures.clear();
    for (let i = 0; i < lines.length; i++) {
      this.signatures.set(i, computeWalshSignature(lines[i], this.topK));
    }
  }

  /** 查找与目标行最相似的 top-N 个行索引 */
  findSimilar(targetIdx: number, N: number = 10): number[] {
    const targetSig = this.signatures.get(targetIdx);
    if (!targetSig) return [];

    const scored: Array<{ idx: number; score: number }> = [];
    for (const [idx, sig] of this.signatures) {
      if (idx === targetIdx) continue;
      const score = walshSignatureSimilarity(targetSig, sig);
      if (score > 0.3) {
        scored.push({ idx, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, N).map((s) => s.idx);
  }

  /** 查找两行集合之间的高相似度行对 (用于 diff 锚点发现) */
  findAnchorCandidates(
    oldIndices: number[],
    newIndices: number[],
    minSimilarity: number = 0.7
  ): Array<{ oldIdx: number; newIdx: number; similarity: number }> {
    const candidates: Array<{ oldIdx: number; newIdx: number; similarity: number }> = [];

    // 限制对比数量：如果两边都很大，做 top-100 采样
    const maxCompare = 100;
    const sampledOld = oldIndices.length > maxCompare
      ? oldIndices.slice(0, maxCompare)
      : oldIndices;
    const sampledNew = newIndices.length > maxCompare
      ? newIndices.slice(0, maxCompare)
      : newIndices;

    for (const oi of sampledOld) {
      const oldSig = this.signatures.get(oi);
      if (!oldSig) continue;

      for (const ni of sampledNew) {
        const newSig = this.signatures.get(ni);
        if (!newSig) continue;

        const sim = walshSignatureSimilarity(oldSig, newSig);
        if (sim >= minSimilarity) {
          candidates.push({ oldIdx: oi, newIdx: ni, similarity: sim });
        }
      }
    }

    candidates.sort((a, b) => b.similarity - a.similarity);
    return candidates;
  }

  clear(): void {
    this.signatures.clear();
  }
}
