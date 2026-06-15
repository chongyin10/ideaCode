/**
 * Node2Vec 图嵌入文件推荐系统
 *
 * 基于 Node2Vec 算法的简化实现，用于在项目文件图中学习
 * 文件的低维向量表示（嵌入），然后基于余弦相似度推荐相关文件。
 *
 * ## 理论基础
 *
 * Node2Vec (Grover & Leskovec, 2016) 融合了 DFS 和 BFS 的图遍历策略：
 *
 * 转移概率（二阶随机游走）:
 *   π_{vx} = α_{pq}(t,x) · w_{vx}
 *   
 *   其中 α_{pq}(t,x) =
 *     1/p   如果 d_{tx} = 0  (回退到上一个节点)
 *     1     如果 d_{tx} = 1  (BFS 偏好)
 *     1/q   如果 d_{tx} = 2  (DFS 偏好)
 *
 *   p (return): 控制回访概率。p 大 → 较少回访（探索性）
 *   q (in-out): 控制 BFS vs DFS。q > 1 → BFS 倾向（局部），q < 1 → DFS 倾向（全局）
 *
 * 优化目标（Skip-Gram with Negative Sampling）:
 *   max Σ log σ(v_j · v_i) + Σ_{k=1}^K E_{n~P_n}[log σ(-v_n · v_i)]
 *
 * ## 对 IDE 文件推荐的映射
 *
 * 图构建：
 *   - 节点 = 文件
 *   - 边 = 共现关系（Hebbian 矩阵中的权重）
 *   - 边的存在 = weight > 阈值
 *
 * 使用：
 *   1. 随机游走生成训练序列
 *   2. Skip-Gram 学习嵌入
 *   3. 余弦相似度推荐
 */

/* ─── 数学工具 ─── */

function dot(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function norm(a: Float64Array): number {
  return Math.sqrt(dot(a, a));
}

function cosineSimilarity(a: Float64Array, b: Float64Array): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

function normalize(a: Float64Array): void {
  const n = norm(a);
  if (n > 0) { for (let i = 0; i < a.length; i++) a[i] /= n; }
}

/* ─── 类型 ─── */

export interface FileGraph {
  /** 文件名列表（节点 ID 列表） */
  nodes: string[];
  /** 邻接表：nodeName → [{neighbor, weight}] */
  adjacency: Map<string, Array<{ neighbor: string; weight: number }>>;
  /** 节点 ID 映射 */
  nodeToIdx: Map<string, number>;
}

export interface Node2VecConfig {
  /** 嵌入维度 */
  dimensions?: number;
  /** 每个节点的游走次数 */
  walksPerNode?: number;
  /** 每次游走的步数 */
  walkLength?: number;
  /** 回退参数 p（大=p少回退） */
  p?: number;
  /** 出入参数 q（q>1=BFS, q<1=DFS） */
  q?: number;
  /** 训练轮数 */
  epochs?: number;
  /** 学习率 */
  learningRate?: number;
  /** 负采样数量 */
  negativeSamples?: number;
}

const DEFAULT_CONFIG: Required<Node2VecConfig> = {
  dimensions: 32,
  walksPerNode: 10,
  walkLength: 8,
  p: 1.0,
  q: 1.0,
  epochs: 20,
  learningRate: 0.01,
  negativeSamples: 5,
};

export class Node2VecRecommender {
  private config: Required<Node2VecConfig>;
  private graph: FileGraph | null = null;
  /** 节点嵌入：nodeName → Float64Array(dim) */
  private embeddings: Map<string, Float64Array> | null = null;
  private trained = false;

  constructor(config: Node2VecConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 从 Hebbian 共现矩阵构建图
   * @param coocMatrix 键格式: 'fileA::fileB' → weight
   * @param weightThreshold 边权重阈值
   */
  buildGraphFromCooccurrence(
    coocMatrix: Record<string, number>,
    weightThreshold = 0.1
  ): FileGraph {
    const nodeSet = new Set<string>();
    const adjacency = new Map<string, Array<{ neighbor: string; weight: number }>>();

    for (const [key, weight] of Object.entries(coocMatrix)) {
      if (weight < weightThreshold) continue;
      const [a, b] = key.split('::');
      if (!a || !b) continue;

      nodeSet.add(a);
      nodeSet.add(b);

      if (!adjacency.has(a)) adjacency.set(a, []);
      if (!adjacency.has(b)) adjacency.set(b, []);

      adjacency.get(a)!.push({ neighbor: b, weight });
      adjacency.get(b)!.push({ neighbor: a, weight });
    }

    const nodes = Array.from(nodeSet);
    const nodeToIdx = new Map<string, number>();
    nodes.forEach((n, i) => nodeToIdx.set(n, i));

    this.graph = { nodes, adjacency, nodeToIdx };
    return this.graph;
  }

  /**
   * 从显式图结构构建
   */
  buildGraph(
    edges: Array<{ source: string; target: string; weight: number }>,
    weightThreshold = 0.1
  ): FileGraph {
    const cooc: Record<string, number> = {};
    for (const e of edges) {
      if (e.weight < weightThreshold) continue;
      const key = [e.source, e.target].sort().join('::');
      cooc[key] = Math.max(cooc[key] || 0, e.weight);
    }
    return this.buildGraphFromCooccurrence(cooc, weightThreshold);
  }

  /**
   * Node2Vec 随机游走序列生成
   */
  private randomWalk(
    startNode: string,
    walkLength: number,
    p: number,
    q: number
  ): string[] {
    const walk: string[] = [startNode];
    if (!this.graph) return walk;

    for (let step = 1; step < walkLength; step++) {
      const current = walk[walk.length - 1];
      const prev = walk.length >= 2 ? walk[walk.length - 2] : null;
      const neighbors = this.graph.adjacency.get(current);

      if (!neighbors || neighbors.length === 0) break;

      // 计算转移概率
      const probs: number[] = [];
      let totalProb = 0;

      for (const { neighbor, weight } of neighbors) {
        let alpha = 1;
        if (prev !== null) {
          const prevNeighbors = this.graph.adjacency.get(prev);
          const d_tx = prevNeighbors?.some(n => n.neighbor === neighbor) ? 1
            : neighbor === prev ? 0
            : 2;
          if (d_tx === 0) alpha = 1 / p;
          else if (d_tx === 2) alpha = 1 / q;
        }
        const prob = weight * alpha;
        probs.push(prob);
        totalProb += prob;
      }

      // 采样
      if (totalProb <= 0) {
        // 等概率随机选
        const pick = neighbors[Math.floor(Math.random() * neighbors.length)];
        walk.push(pick.neighbor);
      } else {
        let r = Math.random() * totalProb;
        for (let i = 0; i < neighbors.length; i++) {
          r -= probs[i];
          if (r <= 0) {
            walk.push(neighbors[i].neighbor);
            break;
          }
        }
      }
    }

    return walk;
  }

  /**
   * 生成所有随机游走
   */
  private generateWalks(): string[][] {
    if (!this.graph) return [];
    const { walksPerNode, walkLength, p, q } = this.config;
    const allWalks: string[][] = [];

    for (const node of this.graph.nodes) {
      for (let i = 0; i < walksPerNode; i++) {
        const walk = this.randomWalk(node, walkLength, p, q);
        if (walk.length >= 2) allWalks.push(walk);
      }
    }

    // 随机打乱
    for (let i = allWalks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allWalks[i], allWalks[j]] = [allWalks[j], allWalks[i]];
    }

    return allWalks;
  }

  /**
   * 训练 Skip-Gram 嵌入（负采样）
   */
  train(): void {
    if (!this.graph || this.graph.nodes.length === 0) return;

    const { dimensions, epochs, learningRate, negativeSamples } = this.config;
    const nodes = this.graph.nodes;
    const n = nodes.length;

    // Xavier 初始化嵌入
    const embeddings = new Map<string, Float64Array>();
    const contextEmbeddings = new Map<string, Float64Array>();
    const scale = Math.sqrt(2.0 / dimensions);

    for (const node of nodes) {
      const emb = new Float64Array(dimensions);
      const ctx = new Float64Array(dimensions);
      for (let i = 0; i < dimensions; i++) {
        emb[i] = (Math.random() * 2 - 1) * scale;
        ctx[i] = (Math.random() * 2 - 1) * scale;
      }
      embeddings.set(node, emb);
      contextEmbeddings.set(node, ctx);
    }

    const walks = this.generateWalks();
    const windowSize = 3;

    for (let epoch = 0; epoch < epochs; epoch++) {
      let totalLoss = 0;

      for (const walk of walks) {
        for (let pos = 0; pos < walk.length; pos++) {
          const target = walk[pos];
          const embTarget = embeddings.get(target)!;

          const windowStart = Math.max(0, pos - windowSize);
          const windowEnd = Math.min(walk.length, pos + windowSize + 1);

          for (let ctxPos = windowStart; ctxPos < windowEnd; ctxPos++) {
            if (ctxPos === pos) continue;
            const context = walk[ctxPos];
            const ctxEmb = contextEmbeddings.get(context)!;

            // 正样本梯度
            const posScore = dot(embTarget, ctxEmb);
            const posGrad = sigmoid(posScore);
            totalLoss -= Math.log(Math.max(1e-10, posGrad));

            // 更新 context embedding
            const lr = learningRate * (1 - epoch / epochs);
            for (let d = 0; d < dimensions; d++) {
              const grad = (posGrad - 1) * embTarget[d];
              ctxEmb[d] -= lr * grad;
            }
            for (let d = 0; d < dimensions; d++) {
              embTarget[d] -= lr * (posGrad - 1) * ctxEmb[d];
            }

            // 负采样
            for (let neg = 0; neg < negativeSamples; neg++) {
              const negIdx = Math.floor(Math.random() * n);
              const negNode = nodes[negIdx];
              if (negNode === context) continue;
              const negEmb = contextEmbeddings.get(negNode)!;

              const negScore = dot(embTarget, negEmb);
              const negGrad = sigmoid(-negScore);
              totalLoss -= Math.log(Math.max(1e-10, negGrad));

              for (let d = 0; d < dimensions; d++) {
                const grad = (1 - negGrad) * embTarget[d];
                negEmb[d] -= lr * grad;
              }
              for (let d = 0; d < dimensions; d++) {
                embTarget[d] -= lr * (1 - negGrad) * negEmb[d];
              }
            }
          }
        }
      }

      // 提前终止
      if (totalLoss < 1e-6) break;
    }

    // 归一化嵌入
    for (const emb of embeddings.values()) normalize(emb);

    this.embeddings = embeddings;
    this.trained = true;
  }

  /**
   * 推荐与给定文件最相似的文件
   * @param fileNode 文件节点名
   * @param topK 返回 top-K 结果
   * @param exclude 排除的文件集合
   */
  recommend(fileNode: string, topK = 5, exclude: Set<string> = new Set()): Array<{ node: string; similarity: number }> {
    if (!this.embeddings || !this.trained) return [];

    const queryEmb = this.embeddings.get(fileNode);
    if (!queryEmb) return [];

    const results: Array<{ node: string; similarity: number }> = [];

    for (const [node, emb] of this.embeddings) {
      if (node === fileNode || exclude.has(node)) continue;
      const sim = cosineSimilarity(queryEmb, emb);
      results.push({ node, similarity: sim });
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
  }

  /**
   * 获取文件的嵌入向量
   */
  getEmbedding(fileNode: string): Float64Array | undefined {
    return this.embeddings?.get(fileNode);
  }

  /**
   * 获取所有嵌入
   */
  getAllEmbeddings(): Map<string, Float64Array> | null {
    return this.embeddings;
  }

  /**
   * 是否已训练
   */
  isTrained(): boolean {
    return this.trained;
  }

  /** 重置 */
  reset(): void {
    this.graph = null;
    this.embeddings = null;
    this.trained = false;
  }
}

function sigmoid(x: number): number {
  if (x > 10) return 1;
  if (x < -10) return 0;
  return 1 / (1 + Math.exp(-x));
}
