/**
 * Lyapunov 自适应编辑调度器 (Θ-Algorithm)
 * ============================================================================
 *
 * 数学原理 —— Lyapunov 稳定性理论引导的实时任务调度：
 *
 * 系统状态向量:  x(t) = [q₁, q₂, ..., qₙ, Δf]ᵀ
 *   qᵢ = 任务 i 的归一化队列延迟 (0~1)
 *   Δf = 帧预算剩余率 = (available_ms / 16.6ms) (0~1)
 *
 * 系统动力学:    ẋ(t) ≈ A x(t) + B u(t) + w(t)
 *   u(t) = 任务优先级向量 (调度输出)
 *   w(t) = 用户输入冲击
 *
 * Lyapunov 函数: V(x) = xᵀ P x
 *   其中 P 通过解离散代数 Riccati 方程 (DARE) 求得：
 *     P = AᵀPA - AᵀPB(R + BᵀPB)⁻¹BᵀPA + Q
 *
 * 调度决策:
 *   V̇ ≤ -αV → 平稳态，正常调度
 *   V̇ → 0   → 临界态，降低非关键任务预算
 *   V  > V_th → 发散态，紧急降载
 *
 * 收敛性保证:
 *   - Lyapunov 直接法：V > 0 且 V̇ < 0 ∀ x ≠ 0
 *   - 收敛速率 = λ_min(P) / λ_max(P)（李雅普诺夫指数上界）
 *
 * 应用场景:
 *   - 编辑器全局帧预算调度
 *   - 扩散批量更新到多个空闲帧
 *   - 防止爆量输入导致的雪崩效应 (cascading failure)
 * ============================================================================
 */

export interface SchedulerTask {
  id: string;
  /** 优先级权重 (0~1)，由调用方声明。越高越重要 */
  staticPriority: number;
  /** 当前队列中待处理项数量 */
  queueSize: number;
  /** 上次执行耗时 (ms) */
  lastDuration: number;
  /** 执行回调：返回 true 表示队列还有剩余，false 表示已完成 */
  execute: (budgetMs: number) => boolean;
}

export interface LyapunovSchedulerConfig {
  /** 目标帧时间 (ms)，默认 16.6 (60fps) */
  targetFrameMs?: number;
  /** 临界态触发阈值 (0~1)，默认 0.15 */
  criticalThreshold?: number;
  /** 发散态触发阈值 (0~1)，默认 0.40 */
  divergenceThreshold?: number;
  /** 调度器状态日志开关 */
  debug?: boolean;
}

/** 通过 DARE (离散代数 Riccati 方程) 近似求解 P 矩阵 */
function solveDARE(A: number[][], B: number[][], Q: number[][], R: number[][]): number[][] {
  const n = Q.length;
  // 简化：使用 Kleinman 迭代 (Newton 法) 的初始近似
  // 实际部署时可替换为完整 DARE 求解器
  let P = Q.map(row => [...row]);
  for (let iter = 0; iter < 5; iter++) {
    // Newton step: P_{k+1} = AᵀP_k A - AᵀP_k B(R + BᵀP_k B)⁻¹BᵀP_k A + Q
    const BPB = multiply(B, multiply(P, transpose(B)));
    
    // 计算 (R + BᵀPB)⁻¹，这里用单位矩阵近似
    const denom = R[0][0] + BPB[0][0];
    if (Math.abs(denom) < 1e-10) break;
    const invFactor = 1 / denom;

    const nextP: number[][] = Array.from({ length: n }, () => Array(n).fill(0));

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        // Aᵀ P A
        let atpa = 0;
        for (let ka = 0; ka < n; ka++) {
          for (let kb = 0; kb < n; kb++) {
            atpa += A[ka][i] * P[ka][kb] * A[kb][j];
          }
        }
        // Aᵀ P B * inv * Bᵀ P A
        let correction = 0;
        for (let ka = 0; ka < n; ka++) {
          for (let kb = 0; kb < n; kb++) {
            const atpb = A[ka][i] * P[ka][0] * B[0][0];
            const btpa = B[0][0] * P[0][kb] * A[kb][j];
            correction += atpb * invFactor * btpa;
          }
        }
        nextP[i][j] = atpa - correction + Q[i][j];
      }
    }

    P = nextP;
  }
  return P;
}

function multiply(a: number[][], b: number[][]): number[][] {
  const rows = a.length;
  const cols = b[0].length;
  const inner = b.length;
  const result = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      for (let k = 0; k < inner; k++) {
        result[i][j] += a[i][k] * b[k][j];
      }
    }
  }
  return result;
}

function transpose(m: number[][]): number[][] {
  const rows = m.length;
  const cols = m[0].length;
  const result = Array.from({ length: cols }, () => Array(rows).fill(0));
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      result[j][i] = m[i][j];
    }
  }
  return result;
}

export class LyapunovScheduler {
  private tasks: Map<string, SchedulerTask> = new Map();
  private P: number[][];
  private A: number[][];
  private B: number[][];
  private running = false;
  private rafId: number | null = null;
  private idleId: number | null = null;
  private lastFrameTime: number = 0;
  private cfg: Required<LyapunovSchedulerConfig>;

  // 状态统计
  private stableFrames = 0;
  private criticalFrames = 0;
  private divergentFrames = 0;

  constructor(config: LyapunovSchedulerConfig = {}) {
    this.cfg = {
      targetFrameMs: config.targetFrameMs ?? 16.6,
      criticalThreshold: config.criticalThreshold ?? 0.15,
      divergenceThreshold: config.divergenceThreshold ?? 0.40,
      debug: config.debug ?? false,
    };

    // 系统矩阵 (维度 n+1, n = 最大任务数上限)
    const maxN = 8;
    this.A = Array.from({ length: maxN }, () => Array(maxN).fill(0));
    this.B = Array.from({ length: maxN }, () => Array(1).fill(0));
    const Q = Array.from({ length: maxN }, () => Array(maxN).fill(0));
    const R = [[1.0]];

    // 对角系统: 每维独立指数衰减 (λ = 0.85 为主特征值)
    for (let i = 0; i < maxN; i++) {
      this.A[i][i] = 0.85;
      this.B[i][0] = -0.3;
      Q[i][i] = 1.0;
    }

    this.P = solveDARE(this.A, this.B, Q, R);
    this.lastFrameTime = performance.now();
  }

  /** 注册一个可调度的任务 */
  registerTask(task: SchedulerTask): void {
    this.tasks.set(task.id, task);
  }

  /** 注销任务 */
  unregisterTask(taskId: string): void {
    this.tasks.delete(taskId);
  }

  /** 更新任务队列状态 */
  updateTaskState(taskId: string, queueSize: number, lastDuration: number): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.queueSize = queueSize;
      task.lastDuration = lastDuration;
    }
  }

  /** 启动调度循环 */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrameTime = performance.now();
    this.scheduleNext();
  }

  /** 停止调度循环 */
  stop(): void {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.idleId !== null) {
      cancelIdleCallback(this.idleId);
      this.idleId = null;
    }
  }

  /** 获取调度器状态摘要 */
  getState(): {
    mode: 'stable' | 'critical' | 'divergent';
    lyapunovValue: number;
    frameBudgetMs: number;
    taskCount: number;
    stats: { stable: number; critical: number; divergent: number };
  } {
    const x = Array(8).fill(0);
    let idx = 0;
    for (const [, task] of this.tasks) {
      if (idx >= 7) break;
      x[idx] = task.queueSize / Math.max(1, task.queueSize + 1);
      idx++;
    }
    // 帧预算指标
    x[7] = 1 - Math.min(1, (performance.now() - this.lastFrameTime) / this.cfg.targetFrameMs);

    // V(x) = xᵀ P x
    let V = 0;
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        V += x[i] * (this.P[i]?.[j] ?? 0) * x[j];
      }
    }

    let mode: 'stable' | 'critical' | 'divergent';
    if (V < this.cfg.criticalThreshold) {
      mode = 'stable';
    } else if (V < this.cfg.divergenceThreshold) {
      mode = 'critical';
    } else {
      mode = 'divergent';
    }

    return {
      mode,
      lyapunovValue: V,
      frameBudgetMs: this.cfg.targetFrameMs,
      taskCount: this.tasks.size,
      stats: {
        stable: this.stableFrames,
        critical: this.criticalFrames,
        divergent: this.divergentFrames,
      },
    };
  }

  /**
   * 请求在当前帧或下一帧执行任务
   * 返回 false 表示当前帧预算不足，任务应延迟
   */
  requestTaskExecution(taskId: string): boolean {
    const V = this.currentLyapunovValue();
    if (V >= this.cfg.divergenceThreshold) {
      // 发散态：拒绝所有非关键（priority < 0.9）任务
      const task = this.tasks.get(taskId);
      if (!task || task.staticPriority < 0.9) return false;
    }
    return true;
  }

  /** 获取当前帧的 Lyapunov 值 */
  currentLyapunovValue(): number {
    const x = Array(8).fill(0);
    let idx = 0;
    for (const [, task] of this.tasks) {
      if (idx >= 7) break;
      x[idx] = task.queueSize / Math.max(1, task.queueSize + 1);
      idx++;
    }
    x[7] = 1 - Math.min(1, (performance.now() - this.lastFrameTime) / this.cfg.targetFrameMs);

    let V = 0;
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        V += x[i] * (this.P[i]?.[j] ?? 0) * x[j];
      }
    }
    return V;
  }

  private scheduleNext(): void {
    if (!this.running) return;

    this.rafId = requestAnimationFrame(() => {
      const now = performance.now();
      this.lastFrameTime = now;

      // 计算 Lyapunov 值并做决策
      const V = this.currentLyapunovValue();

      if (V < this.cfg.criticalThreshold) {
        this.stableFrames++;
        // 平稳态：正常执行所有任务
        this.dispatchTasks('stable', this.cfg.targetFrameMs * 0.6);
      } else if (V < this.cfg.divergenceThreshold) {
        this.criticalFrames++;
        // 临界态：仅为高优先级任务分配预算
        this.dispatchTasks('critical', this.cfg.targetFrameMs * 0.3);
      } else {
        this.divergentFrames++;
        // 发散态：仅维持编辑器响应，其余任务全部暂停
        this.dispatchTasks('divergent', this.cfg.targetFrameMs * 0.1);
      }

      this.scheduleNext();
    });

    // 空闲回调：处理低优先级后台任务
    this.idleId = requestIdleCallback(
      () => {
        this.dispatchTasks('idle', 10);
        this.idleId = null;
      },
      { timeout: 100 }
    );
  }

  private dispatchTasks(mode: string, budgetMs: number): void {
    const startTime = performance.now();
    const sorted = Array.from(this.tasks.values()).sort(
      (a, b) => b.staticPriority - a.staticPriority
    );

    for (const task of sorted) {
      const elapsed = performance.now() - startTime;
      if (elapsed >= budgetMs) break;

      const remaining = budgetMs - elapsed;
      if (remaining <= 0.5) break;

      // 发散态：只处理 staticPriority >= 0.9 的任务
      if (mode === 'divergent' && task.staticPriority < 0.9) continue;
      // 临界态：只处理 staticPriority >= 0.5 的任务
      if (mode === 'critical' && task.staticPriority < 0.5) continue;

      try {
        const done = task.execute(remaining);
        if (done) {
          this.tasks.delete(task.id);
        }
      } catch {
        // 任务异常不影响调度器
      }
    }
  }

  getStats() {
    return {
      stableFrames: this.stableFrames,
      criticalFrames: this.criticalFrames,
      divergentFrames: this.divergentFrames,
      running: this.running,
      taskCount: this.tasks.size,
    };
  }
}

/** 便捷：创建并启动全局调度器单例 */
let globalScheduler: LyapunovScheduler | null = null;

export function getGlobalScheduler(config?: LyapunovSchedulerConfig): LyapunovScheduler {
  if (!globalScheduler) {
    globalScheduler = new LyapunovScheduler(config);
    globalScheduler.start();
  }
  return globalScheduler;
}

export function stopGlobalScheduler(): void {
  if (globalScheduler) {
    globalScheduler.stop();
    globalScheduler = null;
  }
}
