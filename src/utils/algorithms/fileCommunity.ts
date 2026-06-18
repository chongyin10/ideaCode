/**
 * 文件社群发现 (谱聚类 + CP 张量分解)
 * ============================================================================
 *
 * ## 理论基础
 *
 * 1. 谱聚类 (Ng-Jordan-Weiss 2002):
 *    构建文件共现图邻接矩阵 W
 *    归一化拉普拉斯 L = I - D^(-1/2)·W·D^(-1/2)
 *    取最小 k 个特征向量做 k-means
 *    等价于松弛后的图最小割问题
 *
 * 2. CP 张量分解:
 *    三阶张量 T[fileA, fileB, relation] ≈ Σ_r λ_r · a_r ∘ b_r ∘ c_r
 *    ALS (交替最小二乘) 求解
 *    发现"虽不直接共现但通过 import 间接相关"的文件对
 *
 * ## 用于
 *
 * - 文件树自动折叠分组 (前端组/配置组/测试组)
 * - 预取时整组预热
 * - 多关系文件推荐
 * ============================================================================
 */

import { spectralClustering, cpDecomposition } from './mathUtils';

export interface FileCommunity {
  id: number;
  files: string[];
  /** 社群中心文件 (度数最大的) */
  center: string | null;
  /** 社群内聚度 (平均边权重) */
  cohesion: number;
}

export interface FileRelationGraph {
  /** 节点列表 */
  nodes: string[];
  /** 关系切片: 每个关系一个邻接矩阵 (Float64Array, n×n) */
  relations: { name: string; matrix: Float64Array }[];
}

export class FileCommunityDetector {
  private adjacency: Map<string, Map<string, number>> = new Map();
  private relationMatrices: Map<string, Map<string, Map<string, number>>> = new Map();

  /** 添加共现关系 */
  addCoOccurrence(fileA: string, fileB: string, weight = 1, relation = 'cooccur'): void {
    if (fileA === fileB) return;

    // 主邻接矩阵
    if (!this.adjacency.has(fileA)) this.adjacency.set(fileA, new Map());
    if (!this.adjacency.has(fileB)) this.adjacency.set(fileB, new Map());
    this.adjacency.get(fileA)!.set(fileB, (this.adjacency.get(fileA)!.get(fileB) || 0) + weight);
    this.adjacency.get(fileB)!.set(fileA, (this.adjacency.get(fileB)!.get(fileA) || 0) + weight);

    // 关系矩阵
    if (!this.relationMatrices.has(relation)) {
      this.relationMatrices.set(relation, new Map());
    }
    const relMatrix = this.relationMatrices.get(relation)!;
    if (!relMatrix.has(fileA)) relMatrix.set(fileA, new Map());
    relMatrix.get(fileA)!.set(fileB, (relMatrix.get(fileA)!.get(fileB) || 0) + weight);
  }

  /**
   * 谱聚类发现文件社群
   *
   * 构建归一化拉普拉斯 L = I - D^(-1/2)·W·D^(-1/2)
   * 取最小 k 个特征向量做 k-means
   */
  detectCommunities(k = 3): FileCommunity[] {
    const nodes = Array.from(this.adjacency.keys());
    const n = nodes.length;
    if (n < k) {
      // 节点太少，每个文件自成一群
      return nodes.map((file, i) => ({
        id: i,
        files: [file],
        center: file,
        cohesion: 0,
      }));
    }

    const idx = new Map<string, number>();
    nodes.forEach((node, i) => idx.set(node, i));

    // 构建邻接矩阵
    const adjMatrix = new Float64Array(n * n);
    for (const [from, neighbors] of this.adjacency) {
      const i = idx.get(from)!;
      for (const [to, weight] of neighbors) {
        const j = idx.get(to);
        if (j !== undefined) {
          adjMatrix[i * n + j] = weight;
          adjMatrix[j * n + i] = weight;
        }
      }
    }

    // 谱聚类
    const labels = spectralClustering(adjMatrix, n, k);

    // 按标签分组
    const groups = new Map<number, string[]>();
    for (let i = 0; i < n; i++) {
      const label = labels[i];
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label)!.push(nodes[i]);
    }

    // 计算社群中心 + 内聚度
    return Array.from(groups.entries()).map(([id, files]) => {
      // 中心 = 度数最大的节点
      let center: string | null = null;
      let maxDegree = -1;
      for (const file of files) {
        const degree = this.adjacency.get(file)?.size ?? 0;
        if (degree > maxDegree) {
          maxDegree = degree;
          center = file;
        }
      }

      // 内聚度 = 社群内平均边权重
      let totalWeight = 0;
      let edgeCount = 0;
      for (const fileA of files) {
        for (const fileB of files) {
          if (fileA !== fileB) {
            const w = this.adjacency.get(fileA)?.get(fileB) || 0;
            if (w > 0) {
              totalWeight += w;
              edgeCount++;
            }
          }
        }
      }
      const cohesion = edgeCount > 0 ? totalWeight / edgeCount : 0;

      return { id, files, center, cohesion };
    }).sort((a, b) => b.cohesion - a.cohesion);
  }

  /**
   * CP 张量分解: 多关系文件推荐
   *
   * T[fileA, fileB, relation] ≈ Σ_r λ_r · a_r ∘ b_r ∘ c_r
   *
   * 发现跨关系的潜在因子 (如"通过 import 间接相关"的文件对)
   */
  computeTensorFactors(rank = 2): {
    factors: Float64Array[];
    weights: number[];
    nodes: string[];
    relations: string[];
  } {
    const nodes = Array.from(this.adjacency.keys());
    const n = nodes.length;
    const relations = Array.from(this.relationMatrices.keys());
    const numRelations = relations.length;

    if (n < 2 || numRelations < 1) {
      return { factors: [], weights: [], nodes, relations };
    }

    const idx = new Map<string, number>();
    nodes.forEach((node, i) => idx.set(node, i));

    // 构建关系切片
    const slices: Float64Array[] = [];
    for (const relName of relations) {
      const matrix = new Float64Array(n * n);
      const relMatrix = this.relationMatrices.get(relName)!;
      for (const [from, neighbors] of relMatrix) {
        const i = idx.get(from)!;
        for (const [to, weight] of neighbors) {
          const j = idx.get(to);
          if (j !== undefined) matrix[i * n + j] = weight;
        }
      }
      slices.push(matrix);
    }

    const result = cpDecomposition(slices, n, numRelations, rank);
    return { ...result, nodes, relations };
  }

  /**
   * 基于张量分解的跨关系推荐
   * 返回与指定文件潜在相关的文件 (含非直接共现)
   */
  recommendByTensor(file: string, topK = 5): Array<{ file: string; score: number }> {
    const { factors, nodes } = this.computeTensorFactors();
    if (factors.length === 0) return [];

    const idx = nodes.indexOf(file);
    if (idx === -1) return [];

    const n = nodes.length;
    const numFactors = factors.length;
    const rank = Math.floor(numFactors / 3); // A, B, C 三组因子

    // 当前文件在各因子下的权重 × B 因子 = 推荐分数
    const scores = new Float64Array(n);
    for (let r = 0; r < rank; r++) {
      const factorA = factors[r];           // A 因子
      const factorB = factors[rank + r];    // B 因子
      const factorC = factors[2 * rank + r]; // C 因子 (关系权重)

      const wa = factorA[idx];
      for (let j = 0; j < n; j++) {
        scores[j] += wa * factorB[j] * factorC[idx];
      }
    }

    return Array.from(scores)
      .map((score, i) => ({ file: nodes[i], score }))
      .filter((x) => x.file !== file && x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /** 获取统计 */
  getStats() {
    return {
      totalFiles: this.adjacency.size,
      totalEdges: Array.from(this.adjacency.values())
        .reduce((sum, neighbors) => sum + neighbors.size, 0) / 2,
      relationCount: this.relationMatrices.size,
      relations: Array.from(this.relationMatrices.keys()),
    };
  }

  clear(): void {
    this.adjacency.clear();
    this.relationMatrices.clear();
  }
}
