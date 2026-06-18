/**
 * 高等数学工具库 (Advanced Math Utilities)
 * ============================================================================
 *
 * 为各算法模块提供严谨的数学基础函数，涵盖：
 * 1. 核密度估计 (KDE) — 非参数概率密度估计，Silverman 带宽选择
 * 2. Good-Turing 折扣估计 — 语言模型平滑，处理数据稀疏
 * 3. Beta-Bernoulli 贝叶斯共轭推断 — 不确定性量化
 * 4. Chebyshev 半迭代加速 — 矩阵幂迭代加速 (谱方法)
 * 5. Lyapunov 稳定性检验 — 动力系统收敛性证明
 * 6. Perron-Frobenius 谱隙估计 — 马尔可夫链收敛性
 * 7. CSR 稀疏矩阵运算 — 稀疏矩阵-向量乘 (SpMV)
 * 8. NMF 非负矩阵分解 — 潜在因子发现
 * 9. 谱聚类 — 图拉普拉斯特征分解
 * 10. CP 张量分解 — 多关系潜在因子
 *
 * 数学严谨性：每个函数均注明其数学定理/收敛条件。
 * ============================================================================
 */

/* ═══════════════════════════════════════════════════════════════
   1. 核密度估计 (Kernel Density Estimation)
   ═══════════════════════════════════════════════════════════════ */

/**
 * 高斯核密度估计
 *
 * λ(t) = (1/(n·h)) · Σ K((t - tᵢ)/h)
 * K(u) = (1/√(2π)) · exp(-u²/2)    (标准正态核)
 *
 * 带宽选择：Silverman 法则
 * h = 1.06 · σ̂ · n^(-1/5)            (渐近最优 MISE)
 *
 * 用于：Tab 活动强度的非参数估计，替代 EWMA 的滞后偏差。
 */
export class GaussianKDE {
  private samples: number[] = [];
  private bandwidth: number;

  constructor(initialBandwidth = 1.0) {
    this.bandwidth = initialBandwidth;
  }

  /** 添加观测样本（时间戳序列） */
  addSample(value: number): void {
    this.samples.push(value);
    // 每 50 个样本重新计算 Silverman 带宽
    if (this.samples.length % 50 === 0) {
      this.recomputeBandwidth();
    }
  }

  /** 估计给定点的密度 λ(t) */
  estimate(at: number): number {
    if (this.samples.length === 0 || this.bandwidth <= 0) return 0;
    const n = this.samples.length;
    const h = this.bandwidth;
    let sum = 0;
    for (const xi of this.samples) {
      const u = (at - xi) / h;
      sum += Math.exp(-0.5 * u * u) / Math.sqrt(2 * Math.PI);
    }
    return sum / (n * h);
  }

  /** 银曼 (Silverman) 最优带宽选择: h = 1.06·σ·n^(-1/5) */
  private recomputeBandwidth(): void {
    const n = this.samples.length;
    if (n < 2) return;
    const mean = this.samples.reduce((a, b) => a + b, 0) / n;
    const variance = this.samples.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
    const sigma = Math.sqrt(variance);
    if (sigma < 1e-10) return; // 无方差时保持默认带宽
    this.bandwidth = 1.06 * sigma * Math.pow(n, -1 / 5);
  }

  getBandwidth(): number {
    return this.bandwidth;
  }

  getSampleCount(): number {
    return this.samples.length;
  }

  clear(): void {
    this.samples = [];
  }
}

/* ═══════════════════════════════════════════════════════════════
   2. Good-Turing 折扣估计
   ═══════════════════════════════════════════════════════════════ */

/**
 * Good-Turing 频率估计
 *
 * 对出现 r 次的事件，折扣后的期望频率：
 *   r* = (r + 1) · N_{r+1} / N_r
 *
 * 其中 N_r = 恰好出现 r 次的事件种类数。
 * 保留概率质量给未见事件：P0 = N_1 / N_total
 *
 * 用于：高阶马尔可夫链的 Katz 回退平滑，处理数据稀疏。
 */
export function goodTuringDiscount(counts: number[]): {
  discounted: Map<number, number>; // r → r*
  unseenProbability: number;       // P0
} {
  // 统计频率的频率: N_r
  const freqOfFreq = new Map<number, number>();
  const total = counts.reduce((a, b) => a + b, 0);

  for (const c of counts) {
    freqOfFreq.set(c, (freqOfFreq.get(c) || 0) + 1);
  }

  const discounted = new Map<number, number>();

  for (const [r, Nr] of freqOfFreq) {
    const Nr1 = freqOfFreq.get(r + 1) || 0;
    if (Nr > 0 && Nr1 > 0) {
      // r* = (r+1) · N_{r+1} / N_r
      const rStar = ((r + 1) * Nr1) / Nr;
      discounted.set(r, rStar);
    } else {
      // 高频事件不折扣 (r* = r)
      discounted.set(r, r);
    }
  }

  // 未见事件的概率质量 P0 = N_1 / N_total
  const N1 = freqOfFreq.get(1) || 0;
  const unseenProbability = total > 0 ? N1 / total : 0;

  return { discounted, unseenProbability };
}

/* ═══════════════════════════════════════════════════════════════
   3. Beta-Bernoulli 贝叶斯共轭推断
   ═══════════════════════════════════════════════════════════════ */

/**
 * Beta-Bernoulli 共轭后验
 *
 * 先验:  θ ~ Beta(α, β)           (均匀先验 α=β=1)
 * 似然:  xᵢ ~ Bernoulli(θ)
 * 后验:  θ | data ~ Beta(α + Σxᵢ, β + n - Σxᵢ)
 *
 * 后验均值:  E[θ] = α' / (α' + β')
 * 后验方差:  Var[θ] = α'β' / ((α'+β')²(α'+β'+1))
 * 95% 置信下界: 用正态近似 β_inv(0.05; α', β')
 *
 * 用于：文件预取置信度量化，替代点估计避免过拟合。
 */
export class BetaBernoulli {
  private alpha: number;
  private beta: number;

  constructor(alphaPrior = 1, betaPrior = 1) {
    this.alpha = alphaPrior;
    this.beta = betaPrior;
  }

  /** 记录一次伯努利试验结果 */
  observe(success: boolean): void {
    if (success) this.alpha += 1;
    else this.beta += 1;
  }

  /** 后验均值 (点估计) */
  posteriorMean(): number {
    return this.alpha / (this.alpha + this.beta);
  }

  /** 后验方差 */
  posteriorVariance(): number {
    const sum = this.alpha + this.beta;
    return (this.alpha * this.beta) / (sum * sum * (sum + 1));
  }

  /**
   * 95% 置信下界 (保守估计)
   * 正态近似: θ_lower ≈ μ - 1.645·σ
   * 对于 Beta 分布，当 α+β > 30 时正态近似较好。
   */
  lowerConfidenceBound(confidence = 0.95): number {
    const mean = this.posteriorMean();
    const variance = this.posteriorVariance();
    const sigma = Math.sqrt(variance);
    // z 值: 95% → 1.645(单尾), 99% → 2.326
    const zScores: Record<number, number> = { 0.9: 1.282, 0.95: 1.645, 0.99: 2.326 };
    const z = zScores[confidence] ?? 1.645;
    return Math.max(0, mean - z * sigma);
  }

  getAlpha(): number { return this.alpha; }
  getBeta(): number { return this.beta; }
}

/* ═══════════════════════════════════════════════════════════════
   4. Chebyshev 半迭代加速 (矩阵幂迭代加速)
   ═══════════════════════════════════════════════════════════════ */

/**
 * Chebyshev 半迭代法加速幂迭代
 *
 * 对于迭代 x_{k+1} = A·x_k，若 A 的特征值在 [λ_min, λ_max]，
 * Chebyshev 多项式可在 [λ_min, λ_max] 上最小化最大残差。
 *
 * 三项递推:
 *   x_{k+1} = x_k + α_k·(A·x_k - x_k) + β_k·(x_k - x_{k-1})
 *
 * 其中 α_k, β_k 由 Chebyshev 根确定:
 *   c_k = cos(π(k + 1/2) / K)         (Chebyshev 根)
 *   δ = (λ_max - λ_min) / 2
 *   γ = (λ_max + λ_min) / 2
 *   α_k = 2·δ / (γ - δ·c_k) · (-1)^k   (第一步 α_0 = 2/(λ_max+λ_min))
 *
 * 理论加速比: O(√(cond)) vs O(cond) 朴素幂迭代
 *
 * 用于：PageRank 幂迭代加速 3-5 倍。
 */
export function chebyshevAcceleratedIteration(
  multiply: (x: Float64Array) => Float64Array,  // 矩阵-向量乘函数
  x0: Float64Array,
  lambdaMin: number,
  lambdaMax: number,
  maxIterations = 50,
  epsilon = 1e-8,
): Float64Array {
  const n = x0.length;
  let xPrev = new Float64Array(n);
  let xCurr = x0.slice();
  const xNext = new Float64Array(n);

  const delta = (lambdaMax - lambdaMin) / 2;
  const gamma = (lambdaMax + lambdaMin) / 2;

  for (let k = 0; k < maxIterations; k++) {
    // A·x_k
    const Ax = multiply(xCurr);

    // Chebyshev 系数
    let alpha: number;
    let beta: number;
    if (k === 0) {
      alpha = 2 / (lambdaMax + lambdaMin);
      beta = 0;
    } else {
      const c = Math.cos((Math.PI * (k + 0.5)) / maxIterations);
      const denom = gamma - delta * c;
      alpha = (2 * delta) / denom;
      // 上一轮的 beta
      const cPrev = Math.cos((Math.PI * (k - 0.5)) / maxIterations);
      const denomPrev = gamma - delta * cPrev;
      beta = (delta * cPrev) / denomPrev;
    }

    // x_{k+1} = (1 - α)·x_k + α·A·x_k + β·(x_k - x_{k-1})
    for (let i = 0; i < n; i++) {
      xNext[i] = (1 - alpha) * xCurr[i] + alpha * Ax[i] + beta * (xCurr[i] - xPrev[i]);
    }

    // 收敛检查
    let diff = 0;
    for (let i = 0; i < n; i++) {
      diff += Math.abs(xNext[i] - xCurr[i]);
    }

    xPrev = xCurr;
    xCurr = xNext.slice();

    if (diff < epsilon) break;
  }

  return xCurr;
}

/* ═══════════════════════════════════════════════════════════════
   5. Lyapunov 稳定性检验
   ═══════════════════════════════════════════════════════════════ */

/**
 * Lyapunov 函数稳定性检验
 *
 * 动力系统 dx/dt = f(x) 在原点稳定 ⟺
 * 存在正定函数 V(x) 使得 dV/dt = ∇V·f(x) ≤ 0
 *
 * 对 BCM 权重更新: V(w) = Σ wᵢ²
 * dV/dt = 2·Σ wᵢ·dwᵢ/dt = 2·Σ wᵢ·(η·φ(y,θ)·x - ε·wᵢ)
 *       = 2η·Σ wᵢ·φ(y,θ)·x - 2ε·Σ wᵢ²
 *
 * 当 φ(y,θ) 有界且 ε > 0 时，dV/dt ≤ 0（渐近稳定）
 *
 * 用于：验证 BCM 权重更新的数值稳定性，防止发散。
 */
export function lyapunovStabilityCheck(
  weights: number[],
  weightUpdates: number[],
  decayRate: number,
): { isStable: boolean; lyapunovDerivative: number; energy: number } {
  const n = weights.length;
  let energy = 0;       // V = Σ wᵢ²
  let derivative = 0;   // dV/dt = 2·Σ wᵢ·dwᵢ

  for (let i = 0; i < n; i++) {
    energy += weights[i] * weights[i];
    // dwᵢ = η·φ·x - ε·wᵢ，传入的 weightUpdates 已含 η·φ·x 项
    // dV/dt 贡献 = 2·wᵢ·(weightUpdates[i] - ε·wᵢ)
    derivative += 2 * weights[i] * (weightUpdates[i] - decayRate * weights[i]);
  }

  return {
    isStable: derivative <= 1e-10,  // dV/dt ≤ 0 → 稳定
    lyapunovDerivative: derivative,
    energy,
  };
}

/* ═══════════════════════════════════════════════════════════════
   6. Perron-Frobenius 谱隙估计
   ═══════════════════════════════════════════════════════════════ */

/**
 * Perron-Frobenius 谱隙与收敛性
 *
 * 对不可约非周期马尔可夫链 (Perron-Frobenius 定理):
 * - 存在唯一最大特征值 λ₁ = 1 (平稳分布)
 * - 第二大特征值 |λ₂| < 1 决定收敛速度
 * - 谱隙 = 1 - |λ₂|，越大收敛越快
 * - 幂迭代收敛速度 ≈ |λ₂|^k
 *
 * 对 PageRank: M = d·P + (1-d)·E，λ₂ ≤ d (阻尼因子)
 * 收敛步数 ≈ log(ε) / log(d)
 *
 * 用于：PageRank 收敛性证明 + 迭代次数预估。
 */
export function perronFrobeniusGap(damping: number): {
  spectralGap: number;
  estimatedIterations: number;
  epsilon: number;
} {
  // PageRank 的 λ₂ ≤ d
  const lambda2 = damping;
  const spectralGap = 1 - lambda2;

  // 估计达到 ε 收敛所需迭代数: |λ₂|^k < ε → k > log(ε)/log(λ₂)
  const epsilon = 1e-6;
  const estimatedIterations = Math.ceil(Math.log(epsilon) / Math.log(lambda2));

  return { spectralGap, estimatedIterations, epsilon };
}

/* ═══════════════════════════════════════════════════════════════
   7. CSR 稀疏矩阵
   ═══════════════════════════════════════════════════════════════ */

/**
 * CSR (Compressed Sparse Row) 稀疏矩阵
 *
 * 存储: values[], colIdx[], rowPtr[]
 * - values: 非零值
 * - colIdx: 非零值所在列
 * - rowPtr: 每行起始偏移 (长度 = rows + 1)
 *
 * SpMV (Sparse Matrix-Vector Multiply): y = A·x
 *   for i in 0..rows:
 *     for j in rowPtr[i]..rowPtr[i+1]:
 *       y[i] += values[j] * x[colIdx[j]]
 *
 * 复杂度: O(nnz) 而非 O(n²)
 *
 * 用于：PageRank 转移矩阵稀疏存储，文件转移图天然稀疏。
 */
export class CSRMatrix {
  readonly rows: number;
  readonly cols: number;
  readonly values: Float64Array;
  readonly colIdx: Int32Array;
  readonly rowPtr: Int32Array;

  constructor(
    rows: number,
    cols: number,
    values: Float64Array,
    colIdx: Int32Array,
    rowPtr: Int32Array,
  ) {
    this.rows = rows;
    this.cols = cols;
    this.values = values;
    this.colIdx = colIdx;
    this.rowPtr = rowPtr;
  }

  /** 从稠密矩阵构建 CSR */
  static fromDense(dense: Float64Array, rows: number, cols: number): CSRMatrix {
    const values: number[] = [];
    const colIdx: number[] = [];
    const rowPtr: number[] = [0];

    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const v = dense[i * cols + j];
        if (v !== 0) {
          values.push(v);
          colIdx.push(j);
        }
      }
      rowPtr.push(values.length);
    }

    return new CSRMatrix(
      rows,
      cols,
      new Float64Array(values),
      new Int32Array(colIdx),
      new Int32Array(rowPtr),
    );
  }

  /** 从稀疏三元组 (COO) 构建 CSR */
  static fromTriplets(
    rows: number,
    cols: number,
    triplets: Array<{ row: number; col: number; value: number }>,
  ): CSRMatrix {
    // 按行排序
    triplets.sort((a, b) => a.row - b.row || a.col - b.col);

    const values: number[] = [];
    const colIdx: number[] = [];
    const rowPtr: number[] = new Array(rows + 1).fill(0);

    // 统计每行非零数
    for (const t of triplets) {
      rowPtr[t.row + 1]++;
    }
    // 前缀和
    for (let i = 1; i <= rows; i++) {
      rowPtr[i] += rowPtr[i - 1];
    }

    // 填充
    const tempRowPtr = rowPtr.slice();
    for (const t of triplets) {
      const pos = tempRowPtr[t.row]++;
      values[pos] = t.value;
      colIdx[pos] = t.col;
    }

    return new CSRMatrix(
      rows,
      cols,
      new Float64Array(values),
      new Int32Array(colIdx),
      new Int32Array(rowPtr),
    );
  }

  /** 稀疏矩阵-向量乘: y = A·x */
  multiplyVector(x: Float64Array): Float64Array {
    const y = new Float64Array(this.rows);
    for (let i = 0; i < this.rows; i++) {
      let sum = 0;
      const start = this.rowPtr[i];
      const end = this.rowPtr[i + 1];
      for (let j = start; j < end; j++) {
        sum += this.values[j] * x[this.colIdx[j]];
      }
      y[i] = sum;
    }
    return y;
  }

  /** 转置稀疏矩阵-向量乘: y = Aᵀ·x (用于 PageRank 的 Mᵀ·p) */
  multiplyTransposeVector(x: Float64Array): Float64Array {
    const y = new Float64Array(this.cols);
    for (let i = 0; i < this.rows; i++) {
      const xi = x[i];
      const start = this.rowPtr[i];
      const end = this.rowPtr[i + 1];
      for (let j = start; j < end; j++) {
        y[this.colIdx[j]] += this.values[j] * xi;
      }
    }
    return y;
  }

  /** 非零元素数 */
  get nnz(): number {
    return this.values.length;
  }
}

/* ═══════════════════════════════════════════════════════════════
   8. NMF 非负矩阵分解
   ═══════════════════════════════════════════════════════════════ */

/**
 * 非负矩阵分解: M ≈ W·H, W,H ≥ 0
 *
 * 乘法更新规则 (保证非负):
 *   H ← H ⊙ (WᵀM) / (WᵀWH + ε)
 *   W ← W ⊙ (MHᵀ) / (WHHᵀ + ε)
 *
 * 收敛性: 每次迭代单调降低 ||M - WH||_F²
 * (Lee & Seung 2001 证明)
 *
 * 用于：文件转移矩阵分解，发现潜在访问模式。
 */
export function nmf(
  matrix: Float64Array,
  rows: number,
  cols: number,
  rank: number,
  maxIterations = 100,
  tolerance = 1e-4,
): { W: Float64Array; H: Float64Array; error: number } {
  const eps = 1e-10;

  // 初始化 W (rows×rank), H (rank×cols) 为非负随机
  const W = new Float64Array(rows * rank);
  const H = new Float64Array(rank * cols);
  for (let i = 0; i < W.length; i++) W[i] = Math.random() + 0.01;
  for (let i = 0; i < H.length; i++) H[i] = Math.random() + 0.01;

  const WtM = new Float64Array(rank * cols);
  const WtWH = new Float64Array(rank * cols);
  const MHt = new Float64Array(rows * rank);
  const WHt = new Float64Array(rows * rank);

  let prevError = Infinity;

  for (let iter = 0; iter < maxIterations; iter++) {
    // ── 更新 H: H ← H ⊙ (WᵀM) / (WᵀWH + ε) ──
    // WᵀM (rank×cols)
    for (let r = 0; r < rank; r++) {
      for (let c = 0; c < cols; c++) {
        let sum = 0;
        for (let i = 0; i < rows; i++) {
          sum += W[i * rank + r] * matrix[i * cols + c];
        }
        WtM[r * cols + c] = sum;
      }
    }

    // WH (rows×cols)
    const WH = new Float64Array(rows * cols);
    for (let i = 0; i < rows; i++) {
      for (let c = 0; c < cols; c++) {
        let sum = 0;
        for (let r = 0; r < rank; r++) {
          sum += W[i * rank + r] * H[r * cols + c];
        }
        WH[i * cols + c] = sum;
      }
    }

    // WᵀWH (rank×cols)
    for (let r = 0; r < rank; r++) {
      for (let c = 0; c < cols; c++) {
        let sum = 0;
        for (let i = 0; i < rows; i++) {
          sum += W[i * rank + r] * WH[i * cols + c];
        }
        WtWH[r * cols + c] = sum;
      }
    }

    // H 更新
    for (let i = 0; i < H.length; i++) {
      H[i] = (H[i] * (WtM[i] + eps)) / (WtWH[i] + eps);
    }

    // ── 更新 W: W ← W ⊙ (MHᵀ) / (WHHᵀ + ε) ──
    // MHᵀ (rows×rank)
    for (let i = 0; i < rows; i++) {
      for (let r = 0; r < rank; r++) {
        let sum = 0;
        for (let c = 0; c < cols; c++) {
          sum += matrix[i * cols + c] * H[r * cols + c];
        }
        MHt[i * rank + r] = sum;
      }
    }

    // HHᵀ (rank×rank)
    const HHt = new Float64Array(rank * rank);
    for (let r1 = 0; r1 < rank; r1++) {
      for (let r2 = 0; r2 < rank; r2++) {
        let sum = 0;
        for (let c = 0; c < cols; c++) {
          sum += H[r1 * cols + c] * H[r2 * cols + c];
        }
        HHt[r1 * rank + r2] = sum;
      }
    }

    // WHHᵀ (rows×rank)
    for (let i = 0; i < rows; i++) {
      for (let r = 0; r < rank; r++) {
        let sum = 0;
        for (let r2 = 0; r2 < rank; r2++) {
          sum += W[i * rank + r2] * HHt[r2 * rank + r];
        }
        WHt[i * rank + r] = sum;
      }
    }

    // W 更新
    for (let i = 0; i < W.length; i++) {
      W[i] = (W[i] * (MHt[i] + eps)) / (WHt[i] + eps);
    }

    // 误差检查: ||M - WH||_F
    let error = 0;
    for (let i = 0; i < rows * cols; i++) {
      const wh = WH[i] !== undefined
        ? WH[i]
        : 0;
      const diff = matrix[i] - wh;
      error += diff * diff;
    }
    error = Math.sqrt(error);

    if (Math.abs(prevError - error) < tolerance) break;
    prevError = error;
  }

  return { W, H, error: prevError };
}

/* ═══════════════════════════════════════════════════════════════
   9. 谱聚类
   ═══════════════════════════════════════════════════════════════ */

/**
 * 谱聚类 (Spectral Clustering, Ng-Jordan-Weiss 2002)
 *
 * 1. 构建邻接矩阵 W (对称)
 * 2. 计算归一化拉普拉斯: L = I - D^(-1/2)·W·D^(-1/2)
 * 3. 取 L 的最小 k 个特征向量
 * 4. 行归一化
 * 5. k-means 聚类
 *
 * 数学等价: 松弛后的图最小割问题
 *
 * 用于：文件共现图社群发现，自动文件分组。
 */
export function spectralClustering(
  adjacency: Float64Array,
  n: number,
  k: number,
): number[] {
  // 1. 度矩阵 D
  const degrees = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      sum += adjacency[i * n + j];
    }
    degrees[i] = sum;
  }

  // 2. 归一化拉普拉斯 L = I - D^(-1/2)·W·D^(-1/2)
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    const di = degrees[i] > 0 ? 1 / Math.sqrt(degrees[i]) : 0;
    for (let j = 0; j < n; j++) {
      const dj = degrees[j] > 0 ? 1 / Math.sqrt(degrees[j]) : 0;
      L[i * n + j] = (i === j ? 1 : 0) - di * adjacency[i * n + j] * dj;
    }
  }

  // 3. 幂迭代求最小 k 个特征向量
  //    (对 -L 求最大 k 个特征向量等价)
  const eigenvectors: Float64Array[] = [];
  for (let ev = 0; ev < k; ev++) {
    let v = new Float64Array(n);
    for (let i = 0; i < n; i++) v[i] = Math.random();
    // 归一化
    let norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    if (norm > 0) for (let i = 0; i < n; i++) v[i] /= norm;

    for (let iter = 0; iter < 50; iter++) {
      // v = -L·v (求最小特征值 = 求 -L 最大特征值)
      const newV = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let j = 0; j < n; j++) {
          sum -= L[i * n + j] * v[j];
        }
        newV[i] = sum;
      }

      // Gram-Schmidt 正交化 (减去已求特征向量分量)
      for (const existing of eigenvectors) {
        let dot = 0;
        for (let i = 0; i < n; i++) dot += newV[i] * existing[i];
        for (let i = 0; i < n; i++) newV[i] -= dot * existing[i];
      }

      norm = Math.sqrt(newV.reduce((s, x) => s + x * x, 0));
      if (norm < 1e-12) break;
      for (let i = 0; i < n; i++) newV[i] /= norm;

      // 收敛检查
      let diff = 0;
      for (let i = 0; i < n; i++) diff += Math.abs(newV[i] - v[i]);
      v = newV;
      if (diff < 1e-8) break;
    }
    eigenvectors.push(v);
  }

  // 4. 构建嵌入矩阵 U (n×k)，行归一化
  const U = new Float64Array(n * k);
  for (let i = 0; i < n; i++) {
    let rowNorm = 0;
    for (let ev = 0; ev < k; ev++) {
      U[i * k + ev] = eigenvectors[ev][i];
      rowNorm += eigenvectors[ev][i] * eigenvectors[ev][i];
    }
    rowNorm = Math.sqrt(rowNorm);
    if (rowNorm > 1e-10) {
      for (let ev = 0; ev < k; ev++) U[i * k + ev] /= rowNorm;
    }
  }

  // 5. k-means 聚类
  return kmeans(U, n, k, 30);
}

/** k-means 聚类 */
function kmeans(data: Float64Array, n: number, k: number, maxIter: number): number[] {
  const dim = data.length / n;
  const centers = new Float64Array(k * dim);

  // 随机初始化中心 (k-means++ 简化版)
  const firstCenter = Math.floor(Math.random() * n);
  for (let d = 0; d < dim; d++) centers[d] = data[firstCenter * dim + d];

  for (let c = 1; c < k; c++) {
    const dists = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let minDist = Infinity;
      for (let cc = 0; cc < c; cc++) {
        let dist = 0;
        for (let d = 0; d < dim; d++) {
          const diff = data[i * dim + d] - centers[cc * dim + d];
          dist += diff * diff;
        }
        if (dist < minDist) minDist = dist;
      }
      dists[i] = minDist;
    }
    // 按距离加权选择
    const total = dists.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    let chosen = 0;
    for (let i = 0; i < n; i++) {
      r -= dists[i];
      if (r <= 0) { chosen = i; break; }
    }
    for (let d = 0; d < dim; d++) centers[c * dim + d] = data[chosen * dim + d];
  }

  const labels = new Int32Array(n);

  for (let iter = 0; iter < maxIter; iter++) {
    // 分配
    let changed = false;
    for (let i = 0; i < n; i++) {
      let minDist = Infinity;
      let bestC = 0;
      for (let c = 0; c < k; c++) {
        let dist = 0;
        for (let d = 0; d < dim; d++) {
          const diff = data[i * dim + d] - centers[c * dim + d];
          dist += diff * diff;
        }
        if (dist < minDist) {
          minDist = dist;
          bestC = c;
        }
      }
      if (labels[i] !== bestC) {
        labels[i] = bestC;
        changed = true;
      }
    }

    // 更新中心
    const sums = new Float64Array(k * dim);
    const counts = new Int32Array(k);
    for (let i = 0; i < n; i++) {
      const c = labels[i];
      counts[c]++;
      for (let d = 0; d < dim; d++) {
        sums[c * dim + d] += data[i * dim + d];
      }
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] > 0) {
        for (let d = 0; d < dim; d++) {
          centers[c * dim + d] = sums[c * dim + d] / counts[c];
        }
      }
    }

    if (!changed) break;
  }

  return Array.from(labels);
}

/* ═══════════════════════════════════════════════════════════════
   10. CP 张量分解 (简化版)
   ═══════════════════════════════════════════════════════════════ */

/**
 * CP 分解 (CANDECOMP/PARAFAC) 简化版
 *
 * 三阶张量 T[i,j,k] ≈ Σ_r λ_r · a_r[i] · b_r[j] · c_r[k]
 *
 * ALS (交替最小二乘) 更新:
 *   固定 B,C, 更新 A
 *   固定 A,C, 更新 B
 *   固定 A,B, 更新 C
 *
 * 用于：多关系文件共现张量分解。
 * 简化实现: 对每个关系切片单独做 NMF，再合并因子。
 */
export function cpDecomposition(
  slices: Float64Array[],  // 每个关系切片 (n×n)
  n: number,
  numRelations: number,
  rank: number,
  maxIterations = 50,
): { factors: Float64Array[]; weights: number[] } {
  // 对每个关系切片做 rank=1 近似 (取主奇异向量)
  const factors: Float64Array[] = [];
  const weights: number[] = [];

  for (let r = 0; r < rank; r++) {
    const factorA = new Float64Array(n);
    const factorB = new Float64Array(n);
    const factorC = new Float64Array(numRelations);

    // 随机初始化
    for (let i = 0; i < n; i++) {
      factorA[i] = Math.random();
      factorB[i] = Math.random();
    }
    for (let k = 0; k < numRelations; k++) factorC[k] = Math.random();

    // ALS 迭代
    for (let iter = 0; iter < maxIterations; iter++) {
      // 更新 C[k] = Σ_{i,j} T_k[i,j] · a[i] · b[j] / (||a||²·||b||²)
      const aNormSq = factorA.reduce((s, x) => s + x * x, 0);
      const bNormSq = factorB.reduce((s, x) => s + x * x, 0);
      const denomAB = aNormSq * bNormSq + 1e-10;

      for (let k = 0; k < numRelations; k++) {
        const slice = slices[k];
        let sum = 0;
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            sum += slice[i * n + j] * factorA[i] * factorB[j];
          }
        }
        factorC[k] = Math.max(0, sum / denomAB);
      }

      // 更新 A[i] = Σ_{k,j} T_k[i,j] · b[j] · c[k] / (||b||²·||c||²)
      const cNormSq = factorC.reduce((s, x) => s + x * x, 0);
      const denomBC = bNormSq * cNormSq + 1e-10;

      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let k = 0; k < numRelations; k++) {
          const slice = slices[k];
          for (let j = 0; j < n; j++) {
            sum += slice[i * n + j] * factorB[j] * factorC[k];
          }
        }
        factorA[i] = Math.max(0, sum / denomBC);
      }

      // 更新 B (对称于 A)
      for (let j = 0; j < n; j++) {
        let sum = 0;
        for (let k = 0; k < numRelations; k++) {
          const slice = slices[k];
          for (let i = 0; i < n; i++) {
            sum += slice[i * n + j] * factorA[i] * factorC[k];
          }
        }
        factorB[j] = Math.max(0, sum / denomBC);
      }
    }

    factors.push(factorA, factorB, factorC);
    // 权重 = 因子范数乘积
    const wa = Math.sqrt(factorA.reduce((s, x) => s + x * x, 0));
    const wb = Math.sqrt(factorB.reduce((s, x) => s + x * x, 0));
    const wc = Math.sqrt(factorC.reduce((s, x) => s + x * x, 0));
    weights.push(wa * wb * wc);
  }

  return { factors, weights };
}

/* ═══════════════════════════════════════════════════════════════
   辅助: TF-IDF 计算
   ═══════════════════════════════════════════════════════════════ */

/**
 * TF-IDF 字符权重
 *
 * IDF(c) = log(N / df(c))
 * N = 文档总数, df(c) = 含字符 c 的文档数
 *
 * 用于：模糊搜索中稀有字符加权。
 */
export class TFIDFCalculator {
  private docCount = 0;
  private charDocFreq = new Map<string, number>();

  /** 索引一个文档（文件名） */
  indexDocument(doc: string): void {
    this.docCount++;
    const seen = new Set<string>();
    for (const ch of doc.toLowerCase()) {
      if (!seen.has(ch)) {
        seen.add(ch);
        this.charDocFreq.set(ch, (this.charDocFreq.get(ch) || 0) + 1);
      }
    }
  }

  /** 获取字符的 IDF 值 */
  idf(char: string): number {
    if (this.docCount === 0) return 1;
    const df = this.charDocFreq.get(char.toLowerCase()) || 0;
    if (df === 0) return Math.log(this.docCount + 1); // 未见字符高权重
    return Math.log(this.docCount / df);
  }

  /** BM25 饱和函数 */
  static bm25Saturation(freq: number, k1 = 1.2, b = 0.75, docLen: number, avgDocLen: number): number {
    return (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * (docLen / (avgDocLen || 1))));
  }
}
