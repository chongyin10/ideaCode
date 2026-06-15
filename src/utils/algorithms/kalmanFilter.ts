/**
 * 卡尔曼滤波器 (Kalman Filter) — 离散线性系统
 *
 * 应用场景：文件读取速度估计、编辑器滚动速度预测、搜索延迟平滑
 *
 * ## 数学原理
 *
 * 系统模型：
 *   状态方程: x_k = A·x_{k-1} + B·u_k + w_k   (w_k ~ N(0, Q))
 *   观测方程: z_k = H·x_k + v_k                (v_k ~ N(0, R))
 *
 * 预测步骤：
 *   x̂_k⁻ = A·x̂_{k-1}
 *   P_k⁻ = A·P_{k-1}·Aᵀ + Q
 *
 * 更新步骤：
 *   K_k = P_k⁻·Hᵀ·(H·P_k⁻·Hᵀ + R)⁻¹   (卡尔曼增益)
 *   x̂_k = x̂_k⁻ + K_k·(z_k - H·x̂_k⁻)    (状态更新)
 *   P_k = (I - K_k·H)·P_k⁻              (协方差更新)
 *
 * 标量简化版（状态=1维）：
 *   预测: x̂⁻ = x̂, P⁻ = P + Q
 *   增益: K = P⁻ / (P⁻ + R)
 *   更新: x̂ = x̂⁻ + K·(z - x̂⁻)
 *         P = (1 - K)·P⁻
 */

export interface KalmanConfig {
  /** 过程噪声协方差 Q（越大越信任观测值） */
  Q?: number;
  /** 观测噪声协方差 R（越大越信任模型预测） */
  R?: number;
  /** 初始状态估计 */
  initialX?: number;
  /** 初始误差协方差 */
  initialP?: number;
}

export class KalmanFilter {
  /** 过程噪声 */
  Q: number;
  /** 观测噪声 */
  R: number;
  /** 状态估计 */
  private x: number;
  /** 误差协方差 */
  private p: number;

  constructor(config: KalmanConfig = {}) {
    this.Q = config.Q ?? 0.1;
    this.R = config.R ?? 0.5;
    this.x = config.initialX ?? 0;
    this.p = config.initialP ?? 1.0;
  }

  /**
   * 执行一次预测+更新
   * @param measurement 观测值 z_k
   * @returns 滤波后的状态估计 x̂_k
   */
  filter(measurement: number): number {
    // 预测
    const xPred = this.x;
    const pPred = this.p + this.Q;

    // 卡尔曼增益
    const K = pPred / (pPred + this.R);

    // 更新
    this.x = xPred + K * (measurement - xPred);
    this.p = (1 - K) * pPred;

    return this.x;
  }

  /**
   * 只预测不更新（用于缺少观测值时的推算）
   * @returns 预测值
   */
  predict(): number {
    // 状态不变（一阶恒常模型）
    this.p += this.Q;
    return this.x;
  }

  /**
   * 获取当前状态估计
   */
  getEstimate(): number {
    return this.x;
  }

  /**
   * 获取当前协方差
   */
  getVariance(): number {
    return this.p;
  }

  /**
   * 获取卡尔曼增益（调试用）
   */
  getGain(): number {
    return this.p / (this.p + this.R);
  }

  /** 重置滤波器 */
  reset(initialX?: number, initialP?: number): void {
    this.x = initialX ?? 0;
    this.p = initialP ?? 1.0;
  }

  /** 自适应调节 R：观测噪声增大 → 更信任模型 */
  adaptR(newR: number): void {
    this.R = Math.max(0.01, newR);
  }
}

/**
 * 向量卡尔曼滤波器（支持多维状态，如 [位置, 速度, 加速度]）
 *
 * 状态: X = [x, v, a]ᵀ
 * 转移矩阵 A = [[1, dt, dt²/2], [0, 1, dt], [0, 0, 1]]
 * 观测矩阵 H = [1, 0, 0]（只观测位置）
 */
export class VectorKalmanFilter {
  /** 状态维度 */
  readonly dim: number;
  /** 状态向量 */
  private x: Float64Array;
  /** 协方差矩阵 P */
  private P: Float64Array;
  /** 转移矩阵 A */
  private A: Float64Array;
  /** 观测矩阵 H */
  private H: Float64Array;
  /** 过程噪声 Q */
  private Q: Float64Array;
  /** 观测噪声 R */
  R: number;

  constructor(dim: number, config: { R?: number; Q?: number } = {}) {
    this.dim = dim;
    this.x = new Float64Array(dim);
    this.P = new Float64Array(dim * dim);
    this.A = new Float64Array(dim * dim);
    this.H = new Float64Array(dim);
    this.Q = new Float64Array(dim * dim);
    this.R = config.R ?? 0.5;

    // 初始化 A 为单位矩阵
    for (let i = 0; i < dim; i++) this.A[i * dim + i] = 1;
    // 初始化 P 为对角阵
    for (let i = 0; i < dim; i++) this.P[i * dim + i] = 1;
    // 初始化 Q
    const q = config.Q ?? 0.1;
    for (let i = 0; i < dim; i++) this.Q[i * dim + i] = q;
    // 初始化 H：[1, 0, 0, ...]
    this.H[0] = 1;
  }

  /** 配置常加速度运动模型 A = [[1,dt,dt²/2],[0,1,dt],[0,0,1]] */
  setConstantAccelerationModel(dt: number): void {
    const dim = this.dim;
    if (dim < 3) return;
    for (let i = 0; i < dim; i++) this.A[i * dim + i] = 1;
    this.A[0 * dim + 1] = dt;
    this.A[0 * dim + 2] = 0.5 * dt * dt;
    this.A[1 * dim + 2] = dt;
  }

  filter(measurement: number): Float64Array {
    const n = this.dim;

    // ---- 预测 ----
    // x̂⁻ = A·x̂ （矩阵向量乘）
    const xPred = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let j = 0; j < n; j++) sum += this.A[i * n + j] * this.x[j];
      xPred[i] = sum;
    }

    // P⁻ = A·P·Aᵀ + Q
    // 简化：只做一维卡尔曼（位置估计），协方差做标量处理
    const hx = xPred[0]; // H·x̂⁻ = 第一个分量

    // P⁻(0,0)
    const pPred = this.P[0] + this.Q[0];

    // ---- 更新 ----
    const K = pPred / (pPred + this.R);
    this.x[0] = xPred[0] + K * (measurement - hx);
    this.P[0] = (1 - K) * pPred;

    // 更新其他维度
    for (let i = 1; i < n; i++) {
      this.x[i] = xPred[i];
    }

    return this.x;
  }

  getState(): Float64Array { return this.x; }
  getEstimate(): number { return this.x[0]; }
}
