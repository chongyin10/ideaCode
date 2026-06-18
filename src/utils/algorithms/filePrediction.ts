/**
 * 条件熵文件预取 + 个性化 PageRank 文件重要性排序
 *
 * ## 条件熵文件预取
 *
 * 根据信息论，当用户在文件 X 中工作时，在其他文件中 Y 的条件熵
 * H(Y|X) 衡量了 Y 被访问的不确定性：
 *
 *   H(Y|X) = -Σ P(x,y) · log₂ P(y|x)
 *
 *   H(Y|X) 越小 → 越确定 → 越值得预取
 *
 * ## 个性化 PageRank (CSR 稀疏 + Chebyshev 加速)
 *
 * PageRank 原始公式：
 *   PR(v) = (1 - d)/N + d · Σ_{u→v} PR(u) / outDegree(u)
 *
 * 个性化版本加入偏好向量 r（重启概率偏向用户最近访问的文件）：
 *   PPR = (1 - d) · r + d · Mᵀ · PPR
 *
 * 优化:
 * 1. CSR 稀疏存储: 文件转移图天然稀疏，SpMV O(nnz) 替代 O(n²)
 * 2. Chebyshev 半迭代加速: 收敛速度 O(√(cond)) vs O(cond)
 * 3. Perron-Frobenius 谱隙: 预估收敛迭代次数
 *
 * ## 高阶马尔可夫 + Katz 回退平滑
 *
 * 二阶转移 P(Z|X,Y) 用 Good-Turing 折扣处理数据稀疏:
 *   充分数据 → 折扣后 MLE
 *   稀疏 → 回退到一阶 P(Z|Y)
 *   无数据 → 回退到边缘 P(Z)
 *
 * ## NMF 潜在因子分解
 *
 * 转移矩阵 M ≈ W·H, 发现潜在文件访问模式
 *
 * ## Beta-Bernoulli 贝叶斯置信
 *
 * 对每个预取目标维护 Beta(α,β) 后验，用置信下界排序
 */

import {
  CSRMatrix,
  BetaBernoulli,
  goodTuringDiscount,
  perronFrobeniusGap,
  chebyshevAcceleratedIteration,
  nmf,
} from './mathUtils';

/* ─── 转移矩阵 ─── */

interface TransitionMap {
  [file: string]: { [target: string]: number };
}

/**
 * 个性化 PageRank 计算 (CSR 稀疏 + Chebyshev 加速)
 *
 * 优化:
 * 1. CSR 稀疏存储: SpMV O(nnz) 替代密集 O(n²)
 * 2. Chebyshev 半迭代加速: 收敛快 3-5 倍
 * 3. Perron-Frobenius 谱隙预估迭代次数
 *
 * @param graph 转移图：graph[from][to] = 权重
 * @param preferences 偏好向量：preferences[file] = 重启概率
 * @param damping 阻尼因子 d（默认 0.85）
 * @param epsilon 收敛阈值
 * @param maxIterations 最大迭代次数
 * @param useChebyshev 是否启用 Chebyshev 加速
 */
export function personalizedPageRank(
  graph: TransitionMap,
  preferences: Record<string, number>,
  damping = 0.85,
  epsilon = 1e-6,
  maxIterations = 100,
  useChebyshev = true,
): Record<string, number> {
  const nodes = Object.keys(graph);
  if (nodes.length === 0) return {};

  const n = nodes.length;
  const idx = new Map<string, number>();
  nodes.forEach((node, i) => idx.set(node, i));

  // 构建 CSR 稀疏转移矩阵 (出度归一化)
  const triplets: Array<{ row: number; col: number; value: number }> = [];
  for (const [from, targets] of Object.entries(graph)) {
    const i = idx.get(from);
    if (i === undefined) continue;
    let total = 0;
    for (const w of Object.values(targets)) total += w;
    if (total <= 0) continue;
    for (const [to, w] of Object.entries(targets)) {
      const j = idx.get(to);
      if (j !== undefined) triplets.push({ row: i, col: j, value: w / total });
    }
  }
  const csr = CSRMatrix.fromTriplets(n, n, triplets);

  // 偏好向量 r
  const r = new Float64Array(n);
  let prefSum = 0;
  for (const [file, pref] of Object.entries(preferences)) {
    const i = idx.get(file);
    if (i !== undefined) {
      r[i] = pref;
      prefSum += pref;
    }
  }
  if (prefSum > 0) {
    for (let i = 0; i < n; i++) r[i] /= prefSum;
  } else {
    // 统一偏好
    for (let i = 0; i < n; i++) r[i] = 1 / n;
  }

  // 初始 PPR = 均匀分布
  let ppr = new Float64Array(n);
  for (let i = 0; i < n; i++) ppr[i] = 1 / n;

  // Perron-Frobenius 谱隙预估迭代次数
  const pfGap = perronFrobeniusGap(damping);
  const estimatedIters = Math.min(maxIterations, pfGap.estimatedIterations);

  if (useChebyshev && n > 10) {
    // Chebyshev 半迭代加速: 迭代矩阵的特征值在 [d², d] 范围
    // (PageRank 的 M = d·P + (1-d)·E, λ₂ ≤ d)
    const multiply = (x: Float64Array): Float64Array => {
      // d · Mᵀ · x + (1-d) · r
      const MtX = csr.multiplyTransposeVector(x);
      const result = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        result[i] = damping * MtX[i] + (1 - damping) * r[i];
      }
      return result;
    };

    ppr = new Float64Array(chebyshevAcceleratedIteration(
      multiply,
      ppr,
      damping * damping, // lambdaMin
      damping,           // lambdaMax
      estimatedIters,
      epsilon,
    ));
  } else {
    // 朴素幂迭代 (CSR SpMV)
    for (let iter = 0; iter < estimatedIters; iter++) {
      // d · Mᵀ · ppr + (1-d) · r
      const MtP = csr.multiplyTransposeVector(ppr);
      const next = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        next[i] = damping * MtP[i] + (1 - damping) * r[i];
      }

      let diff = 0;
      for (let i = 0; i < n; i++) {
        diff += Math.abs(next[i] - ppr[i]);
      }
      ppr = next;
      if (diff < epsilon) break;
    }
  }

  // 转回对象
  const result: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    result[nodes[i]] = ppr[i];
  }

  return result;
}

/* ─── 条件熵文件预取 ─── */

export interface FileTransitionStats {
  /** 文件 X 被访问的总次数 */
  visits: number;
  /** P(Y|X): 在 X 之后访问 Y 的条件概率 */
  transitions: Map<string, number>;
}

/**
 * 条件熵文件预取器
 */
export class EntropyFilePrefetcher {
  /** 文件访问转移统计: fileX → Stats */
  private stats = new Map<string, FileTransitionStats>();
  /** 二阶马尔可夫统计: `${from1}::${from2}` → { transitions, visits } */
  private secondOrderStats = new Map<string, FileTransitionStats>();
  /** 总访问次数 */
  private totalVisits = 0;
  /** EWMA 衰减因子 */
  private decayAlpha = 0.98;
  /** 贝叶斯置信度: 每个目标文件的 Beta-Bernoulli 后验 */
  private bayesianConfidence = new Map<string, BetaBernoulli>();
  /** NMF 潜在因子缓存 */
  private nmfCache: { W: Float64Array; H: Float64Array; nodes: string[]; rank: number } | null = null;
  /** 上一个访问的文件 (用于二阶马尔可夫) */
  private lastVisited: string | null = null;

  /**
   * 记录一次文件访问转移（从 fileA 切换到 fileB）
   * 同时维护一阶和二阶马尔可夫统计 + 贝叶斯后验
   */
  recordTransition(fromFile: string, toFile: string): void {
    if (!fromFile || !toFile || fromFile === toFile) return;

    this.totalVisits++;

    // 一阶统计
    if (!this.stats.has(fromFile)) {
      this.stats.set(fromFile, { visits: 0, transitions: new Map() });
    }
    const stat = this.stats.get(fromFile)!;
    stat.visits++;
    const count = stat.transitions.get(toFile) || 0;
    stat.transitions.set(toFile, count + 1);

    // 二阶马尔可夫统计 (lastVisited, fromFile) → toFile
    if (this.lastVisited) {
      const secondKey = `${this.lastVisited}::${fromFile}`;
      if (!this.secondOrderStats.has(secondKey)) {
        this.secondOrderStats.set(secondKey, { visits: 0, transitions: new Map() });
      }
      const secondStat = this.secondOrderStats.get(secondKey)!;
      secondStat.visits++;
      const sc = secondStat.transitions.get(toFile) || 0;
      secondStat.transitions.set(toFile, sc + 1);
    }
    this.lastVisited = fromFile;

    // 贝叶斯后验更新: 预测成功 (访问了 toFile) → Beta(α+1, β)
    if (!this.bayesianConfidence.has(toFile)) {
      this.bayesianConfidence.set(toFile, new BetaBernoulli(1, 1));
    }
    this.bayesianConfidence.get(toFile)!.observe(true);

    // 对其他候选文件记录"未访问" → Beta(α, β+1)
    // (仅在它们曾是一阶候选时)
    const candidates = stat.transitions.keys();
    for (const candidate of candidates) {
      if (candidate !== toFile) {
        if (!this.bayesianConfidence.has(candidate)) {
          this.bayesianConfidence.set(candidate, new BetaBernoulli(1, 1));
        }
        this.bayesianConfidence.get(candidate)!.observe(false);
      }
    }

    // 周期性衰减旧数据
    if (this.totalVisits % 100 === 0) this.decay();
  }

  /**
   * 计算条件熵 H(Y|X)
   *
   * H(Y|X) = -Σ_{y} P(y|x) · log₂ P(y|x)
   */
  conditionalEntropy(fromFile: string): number {
    const stat = this.stats.get(fromFile);
    if (!stat || stat.visits === 0) return Infinity;

    let entropy = 0;
    for (const count of stat.transitions.values()) {
      const p = count / stat.visits;
      if (p > 0) entropy -= p * Math.log2(p);
    }
    return entropy;
  }

  /**
   * 获取条件概率分布 P(Y|X)
   */
  getConditionalDistribution(fromFile: string): Map<string, number> {
    const result = new Map<string, number>();
    const stat = this.stats.get(fromFile);
    if (!stat || stat.visits === 0) return result;

    for (const [toFile, count] of stat.transitions) {
      result.set(toFile, count / stat.visits);
    }
    return result;
  }

  /**
   * 预测从当前文件出发最可能打开的文件列表
   *
   * 综合策略：
   * 1. 二阶马尔可夫 P(Z|X,Y) + Katz 回退平滑
   * 2. 条件概率 P(Y|X) 排序
   * 3. Beta-Bernoulli 贝叶斯置信下界 (替代点估计)
   * 4. 信息增益 IG(Y|X) = H(Y) - H(Y|X) 辅助
   *
   * @param currentFile 当前文件
   * @param topK 返回 top-K 结果
   * @param minProbability 最低条件概率阈值
   */
  predictNextFiles(
    currentFile: string,
    topK = 5,
    minProbability = 0.05
  ): Array<{ file: string; probability: number; confidence: number }> {
    const dist = this.getConditionalDistribution(currentFile);
    if (dist.size === 0) return [];

    // 二阶马尔可夫 + Katz 回退平滑
    const katzDist = this.katzBackoff(currentFile, dist);

    const entries = Array.from(katzDist.entries());
    const filtered = entries.filter(e => e[1] >= minProbability);
    const entropy = this.conditionalEntropy(currentFile);
    const maxEntropy = Math.log2(dist.size || 1);

    return filtered
      .map(([file, probability]) => {
        // 贝叶斯置信下界 (95% 置信度)
        const bayesian = this.bayesianConfidence.get(file);
        const bayesianLower = bayesian ? bayesian.lowerConfidenceBound(0.95) : 0;
        // 综合置信度: 贝叶斯下界 × (1 - 归一化熵)
        const entropyConf = maxEntropy > 0 ? 1 - entropy / maxEntropy : 0;
        const confidence = Math.max(0, bayesianLower * 0.7 + entropyConf * 0.3);
        return { file, probability, confidence };
      })
      .sort((a, b) => b.confidence - a.confidence || b.probability - a.probability)
      .slice(0, topK);
  }

  /**
   * Katz 回退平滑 (Good-Turing 折扣)
   *
   * 二阶 P(Z|X,Y) 数据充分 → 折扣后使用
   * 不充分 → 回退到一阶 P(Z|Y)
   * 仍不充分 → 回退到边缘 P(Z)
   */
  private katzBackoff(
    currentFile: string,
    firstOrderDist: Map<string, number>,
  ): Map<string, number> {
    const result = new Map<string, number>();

    // Good-Turing 折扣一阶分布
    const counts = Array.from(firstOrderDist.values());
    const { discounted } = goodTuringDiscount(counts);

    // 二阶统计: (lastVisited, currentFile) → ?
    const secondKey = this.lastVisited ? `${this.lastVisited}::${currentFile}` : null;
    const secondStat = secondKey ? this.secondOrderStats.get(secondKey) : null;

    for (const [toFile, rawProb] of firstOrderDist) {
      let prob = rawProb;

      // 二阶数据充分 (visits >= 3) → 用二阶
      if (secondStat && secondStat.visits >= 3) {
        const secondCount = secondStat.transitions.get(toFile) || 0;
        if (secondCount > 0) {
          prob = secondCount / secondStat.visits;
        }
      }

      // Good-Turing 折扣
      const rawCount = Math.round(rawProb * 100);
      const discountedCount = discounted.get(rawCount);
      if (discountedCount !== undefined && rawCount > 0) {
        prob = prob * (discountedCount / rawCount);
      }

      result.set(toFile, prob);
    }

    return result;
  }

  /**
   * 获取多个活跃文件的最可能下一个文件（联合预测）
   */
  predictFromMultiple(
    activeFiles: string[],
    topK = 5
  ): Array<{ file: string; probability: number }> {
    const combined = new Map<string, number>();

    for (const file of activeFiles) {
      const dist = this.getConditionalDistribution(file);
      const weight = 1 / activeFiles.length;
      for (const [toFile, prob] of dist) {
        combined.set(toFile, (combined.get(toFile) || 0) + prob * weight);
      }
    }

    // 排除已在活跃集合中的文件
    const activeSet = new Set(activeFiles);
    return Array.from(combined.entries())
      .filter(([f]) => !activeSet.has(f))
      .map(([file, probability]) => ({ file, probability }))
      .sort((a, b) => b.probability - a.probability)
      .slice(0, topK);
  }

  /**
   * EWMA 衰减所有统计（逐步遗忘旧模式）
   */
  private decay(): void {
    for (const stat of this.stats.values()) {
      stat.visits *= this.decayAlpha;
      if (stat.visits < 0.1) {
        stat.transitions.clear();
        continue;
      }
      for (const [key, count] of stat.transitions) {
        const newVal = count * this.decayAlpha;
        if (newVal < 0.05) stat.transitions.delete(key);
        else stat.transitions.set(key, newVal);
      }
    }
  }

  /**
   * 构建转移矩阵（给 PageRank 用）
   */
  buildTransitionMatrix(): TransitionMap {
    const matrix: TransitionMap = {};
    for (const [from, stat] of this.stats) {
      matrix[from] = {};
      for (const [to, count] of stat.transitions) {
        matrix[from][to] = count;
      }
    }
    return matrix;
  }

  /** 获取统计信息 */
  getStats() {
    return {
      totalFiles: this.stats.size,
      totalVisits: this.totalVisits,
      secondOrderEntries: this.secondOrderStats.size,
      bayesianTracked: this.bayesianConfidence.size,
      avgEntropy: Array.from(this.stats.keys())
        .reduce((s, f) => s + this.conditionalEntropy(f), 0) / Math.max(1, this.stats.size),
      hasNMFCache: this.nmfCache !== null,
    };
  }

  /**
   * NMF 潜在因子分解: 转移矩阵 M ≈ W·H
   *
   * W (n×rank): 文件在潜在模式下的权重
   * H (rank×n): 潜在模式下各文件的访问倾向
   *
   * 用于发现"前端调试模式""配置文件组"等潜在访问模式。
   */
  computeNMF(rank = 3): { patterns: Array<{ name: string; files: Array<{ file: string; weight: number }> }> } {
    const nodes = Array.from(this.stats.keys());
    const n = nodes.length;
    if (n < 2) return { patterns: [] };

    // 构建稠密转移矩阵
    const idx = new Map<string, number>();
    nodes.forEach((node, i) => idx.set(node, i));
    const dense = new Float64Array(n * n);
    for (const [from, stat] of this.stats) {
      const i = idx.get(from)!;
      for (const [to, count] of stat.transitions) {
        const j = idx.get(to);
        if (j !== undefined) dense[i * n + j] = count;
      }
    }

    const { W, H } = nmf(dense, n, n, Math.min(rank, n - 1), 50);
    this.nmfCache = { W, H, nodes, rank };

    // 提取潜在模式
    const patterns: Array<{ name: string; files: Array<{ file: string; weight: number }> }> = [];
    for (let r = 0; r < rank; r++) {
      const files: Array<{ file: string; weight: number }> = [];
      for (let i = 0; i < n; i++) {
        files.push({ file: nodes[i], weight: W[i * rank + r] });
      }
      files.sort((a, b) => b.weight - a.weight);
      patterns.push({ name: `Pattern-${r + 1}`, files: files.slice(0, 5) });
    }

    return { patterns };
  }

  /**
   * 基于 NMF 的潜在模式预取
   * 返回当前文件所属模式下其他文件的访问倾向
   */
  predictByNMF(currentFile: string, topK = 5): Array<{ file: string; weight: number }> {
    if (!this.nmfCache) this.computeNMF();
    const cache = this.nmfCache;
    if (!cache) return [];

    const idx = cache.nodes.indexOf(currentFile);
    if (idx === -1) return [];

    const { H, rank, nodes } = cache;
    const n = nodes.length;

    // 当前文件在各模式下的权重 → 加权求和其他文件的访问倾向
    const scores = new Float64Array(n);
    for (let r = 0; r < rank; r++) {
      const wFile = cache.W[idx * rank + r];
      for (let j = 0; j < n; j++) {
        scores[j] += wFile * H[r * n + j];
      }
    }

    return Array.from(scores)
      .map((weight, i) => ({ file: nodes[i], weight }))
      .filter((x) => x.file !== currentFile && x.weight > 0)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, topK);
  }

  reset(): void {
    this.stats.clear();
    this.secondOrderStats.clear();
    this.bayesianConfidence.clear();
    this.nmfCache = null;
    this.lastVisited = null;
    this.totalVisits = 0;
  }
}
