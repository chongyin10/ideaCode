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
 * ## 个性化 PageRank
 *
 * PageRank 原始公式：
 *   PR(v) = (1 - d)/N + d · Σ_{u→v} PR(u) / outDegree(u)
 *
 * 个性化版本加入偏好向量 r（重启概率偏向用户最近访问的文件）：
 *   PPR = (1 - d) · r + d · Mᵀ · PPR
 *
 * 使用幂迭代法求解。
 */

/* ─── 转移矩阵 ─── */

interface TransitionMap {
  [file: string]: { [target: string]: number };
}

/**
 * 个性化 PageRank 计算
 *
 * @param graph 转移图：graph[from][to] = 权重
 * @param preferences 偏好向量：preferences[file] = 重启概率
 * @param damping 阻尼因子 d（默认 0.85）
 * @param epsilon 收敛阈值
 * @param maxIterations 最大迭代次数
 */
export function personalizedPageRank(
  graph: TransitionMap,
  preferences: Record<string, number>,
  damping = 0.85,
  epsilon = 1e-6,
  maxIterations = 100
): Record<string, number> {
  const nodes = Object.keys(graph);
  if (nodes.length === 0) return {};

  const n = nodes.length;
  const idx = new Map<string, number>();
  nodes.forEach((node, i) => idx.set(node, i));

  // 构建转移矩阵的出度归一化
  const transition = new Float64Array(n * n);
  const outDegree = new Float64Array(n);

  for (const [from, targets] of Object.entries(graph)) {
    const i = idx.get(from);
    if (i === undefined) continue;
    let total = 0;
    for (const w of Object.values(targets)) total += w;
    if (total <= 0) continue;
    outDegree[i] = total;
    for (const [to, w] of Object.entries(targets)) {
      const j = idx.get(to);
      if (j !== undefined) transition[i * n + j] = w / total;
    }
  }

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

  // 幂迭代
  let ppr = new Float64Array(n);
  for (let i = 0; i < n; i++) ppr[i] = 1 / n;

  for (let iter = 0; iter < maxIterations; iter++) {
    const next = new Float64Array(n);

    // 转移项：d · Mᵀ · ppr
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let j = 0; j < n; j++) {
        sum += transition[j * n + i] * ppr[j]; // Mᵀ 列累加
      }
      next[i] = damping * sum + (1 - damping) * r[i];
    }

    // 收敛检查
    let diff = 0;
    for (let i = 0; i < n; i++) {
      diff += Math.abs(next[i] - ppr[i]);
    }
    ppr = next;
    if (diff < epsilon) break;
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
  /** 总访问次数 */
  private totalVisits = 0;
  /** EWMA 衰减因子 */
  private decayAlpha = 0.98;

  /**
   * 记录一次文件访问转移（从 fileA 切换到 fileB）
   */
  recordTransition(fromFile: string, toFile: string): void {
    if (!fromFile || !toFile || fromFile === toFile) return;

    this.totalVisits++;

    if (!this.stats.has(fromFile)) {
      this.stats.set(fromFile, { visits: 0, transitions: new Map() });
    }
    const stat = this.stats.get(fromFile)!;
    stat.visits++;

    const count = stat.transitions.get(toFile) || 0;
    stat.transitions.set(toFile, count + 1);

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
   * 1. 条件概率 P(Y|X) 排序
   * 2. 信息增益 IG(Y|X) = H(Y) - H(Y|X) 作为置信度
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

    const entries = Array.from(dist.entries());
    const filtered = entries.filter(e => e[1] >= minProbability);
    const entropy = this.conditionalEntropy(currentFile);
    const maxEntropy = Math.log2(dist.size || 1);
    // 置信度：1 - 归一化熵（熵越低越有信心）
    const confidence = maxEntropy > 0 ? 1 - entropy / maxEntropy : 0;

    return filtered
      .map(([file, probability]) => ({
        file,
        probability,
        confidence,
      }))
      .sort((a, b) => b.probability - a.probability)
      .slice(0, topK);
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
      avgEntropy: Array.from(this.stats.keys())
        .reduce((s, f) => s + this.conditionalEntropy(f), 0) / Math.max(1, this.stats.size),
    };
  }

  reset(): void {
    this.stats.clear();
    this.totalVisits = 0;
  }
}
