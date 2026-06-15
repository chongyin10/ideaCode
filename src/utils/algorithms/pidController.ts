/**
 * PID 控制器 — 比例积分微分控制器
 *
 * 应用场景：自适应防抖延迟调参、搜索响应调度、动画平滑控制
 *
 * ## 数学原理
 *   u(t) = Kp·e(t) + Ki·∫₀ᵗe(τ)dτ + Kd·(de/dt)
 *
 * 三项作用：
 *   P (Proportional): 对当前误差的比例响应，快速响应但有余差
 *   I (Integral):     累积历史误差，消除稳态误差
 *   D (Derivative):   预测误差变化趋势，抑制超调
 *
 * 离散化（增量式）：
 *   Δu = Kp·(eₖ - eₖ₋₁) + Ki·eₖ·Δt + Kd·(eₖ - 2eₖ₋₁ + eₖ₋₂)/Δt
 *
 * 防积分饱和 (Anti-windup)：限制积分项范围
 * 输出限幅 (Clamping)：保证输出在 [outMin, outMax]
 */

export interface PIDConfig {
  /** 比例增益 */
  Kp: number;
  /** 积分增益 */
  Ki: number;
  /** 微分增益 */
  Kd: number;
  /** 输出下限 */
  outMin?: number;
  /** 输出上限 */
  outMax?: number;
  /** 积分项上限（防饱和） */
  integralMax?: number;
}

export class PIDController {
  readonly Kp: number;
  readonly Ki: number;
  readonly Kd: number;
  private integral = 0;
  private prevError: number | null = null;
  private prevPrevError: number | null = null;
  private output = 0;
  private readonly outMin: number;
  private readonly outMax: number;
  private readonly integralMax: number;
  private lastTime: number | null = null;

  constructor(config: PIDConfig) {
    this.Kp = config.Kp;
    this.Ki = config.Ki;
    this.Kd = config.Kd;
    this.outMin = config.outMin ?? -Infinity;
    this.outMax = config.outMax ?? Infinity;
    this.integralMax = config.integralMax ?? 100;
  }

  /**
   * 计算 PID 输出
   * @param setpoint  目标值
   * @param measurement 当前测量值
   * @param dt   时间步长（秒），不传则自动计算
   * @returns 控制信号输出
   */
  update(setpoint: number, measurement: number, dt?: number): number {
    const error = setpoint - measurement;
    const now = performance.now() / 1000;

    if (dt === undefined) {
      dt = this.lastTime !== null ? now - this.lastTime : 0.1;
    }
    this.lastTime = now;

    if (dt <= 0) dt = 0.001;

    // P 项
    const pTerm = this.Kp * error;

    // I 项（带积分饱和保护）
    this.integral += error * dt;
    if (this.integral > this.integralMax) this.integral = this.integralMax;
    if (this.integral < -this.integralMax) this.integral = -this.integralMax;
    const iTerm = this.Ki * this.integral;

    // D 项（带低通效果防止噪声放大）
    let dTerm = 0;
    if (this.prevError !== null && this.prevPrevError !== null) {
      // 增量式微分
      dTerm = this.Kd * (error - 2 * this.prevError + this.prevPrevError) / dt;
      // 低通衰减微分项
      dTerm = 0.7 * dTerm;
    }

    this.prevPrevError = this.prevError;
    this.prevError = error;

    let output = pTerm + iTerm + dTerm;

    // 输出限幅
    if (output > this.outMax) output = this.outMax;
    if (output < this.outMin) output = this.outMin;

    this.output = output;
    return output;
  }

  /** 获取当前输出值 */
  getOutput(): number {
    return this.output;
  }

  /** 重置控制器状态 */
  reset(): void {
    this.integral = 0;
    this.prevError = null;
    this.prevPrevError = null;
    this.output = 0;
    this.lastTime = null;
  }

  /** 获取当前积分项（用于调试） */
  getIntegral(): number {
    return this.integral;
  }
}
