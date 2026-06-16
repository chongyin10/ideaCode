/**
 * terminalMath.ts — 终端数学优化基础模块
 *
 * 包含 8 项优化：
 * 1. PID 控制器 — 流控动态阈值
 * 2. 指数加权移动平均 (EWMA) — 自适应 ACK 批量
 * 3. Bresenham 补偿 — cols 精度
 * 4. 线性回归 — 字体度量校准
 * 5. 指数退避调度 — resize 去抖
 * 6. Kalman 滤波器 — 容器尺寸平滑
 * 7. Shannon 熵 — 输出分类
 * 8. CIELAB ΔE* + HSL 插值 — 色彩优化
 * 9. 黄金比例 — 分屏默认比例
 */

/* ===========================================================
   1. PID 控制器 — 流控动态阈值
   =========================================================== */

export class PIDController {
  private integral = 0;
  private prevError = 0;
  private derivative = 0;

  constructor(
    private kp: number,  // 比例系数
    private ki: number,  // 积分系数
    private kd: number,  // 微分系数
    private setpoint: number, // 目标值（期望的缓冲区大小）
    private outputMin = 0,
    private outputMax = 1,
  ) {}

  /**
   * @param measurement 当前测量值 (unackedChars)
   * @param dt 时间间隔 (ms)
   * @returns 控制输出 [0, 1], 1=全速, 0=暂停
   */
  compute(measurement: number, dtMs: number): number {
    // dtMs 标准化为秒，避免千倍数量级偏差
    const dt = dtMs / 1000;
    const error = this.setpoint - measurement;

    // 积分项 — 抗饱和 (anti-windup)
    this.integral += error * dt;
    const integralMax = Math.abs(50 / Math.max(0.001, this.ki));
    this.integral = this.clamp(this.integral, -integralMax, integralMax);

    // 微分项
    if (dt > 0) {
      this.derivative = (error - this.prevError) / dt;
    }
    this.prevError = error;

    // PID 输出: kp 控制归一化输出范围
    const kpNorm = this.kp / Math.max(1, this.setpoint * 0.01);
    let output = kpNorm * error + this.ki * this.integral + this.kd * this.derivative;

    // 归一化到 [0, 1]: 0.5 是零误差的基准输出
    output = this.clamp(output + 0.5, this.outputMin, this.outputMax);

    return output;
  }

  reset() {
    this.integral = 0;
    this.prevError = 0;
    this.derivative = 0;
  }

  private clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
  }
}

/* ===========================================================
   2. EWMA — 指数加权移动平均
   =========================================================== */

export class EWMA {
  private estimate: number;

  constructor(
    initialValue: number,
    private alpha: number = 0.2, // 平滑因子 (0,1]
  ) {
    this.estimate = initialValue;
  }

  /** 添加新测量值, 返回更新后的估计值 */
  add(value: number): number {
    this.estimate = this.alpha * value + (1 - this.alpha) * this.estimate;
    return this.estimate;
  }

  get value(): number { return this.estimate; }

  reset(value: number) { this.estimate = value; }
}

/**
 * 自调节 EWMA — alpha 根据偏差自动调整
 */
export class AdaptiveEWMA {
  private estimate: number;
  private variance: number;

  constructor(initialValue: number) {
    this.estimate = initialValue;
    this.variance = 1;
  }

  add(value: number): number {
    const error = value - this.estimate;
    this.variance = 0.9 * this.variance + 0.1 * error * error;
    // 偏差大 → alpha 大 (响应快); 偏差小 → alpha 小 (平滑)
    const alpha = Math.min(0.5, 0.05 + this.variance / (1 + this.variance));
    this.estimate = alpha * value + (1 - alpha) * this.estimate;
    return this.estimate;
  }

  get value(): number { return this.estimate; }
}

/* ===========================================================
   3. Bresenham 补偿 — 浮点 cols 精度
   =========================================================== */

export class BresenhamColsTracker {
  private remainder = 0;

  /**
   * 根据容器宽度和字符宽度计算最优列数
   * @param containerWidth 容器像素宽度
   * @param charWidth 单字符像素宽度
   * @returns 最优整数列数
   */
  compute(containerWidth: number, charWidth: number): number {
    if (charWidth <= 0) return 80;
    const exact = containerWidth / charWidth;
    const rounded = Math.round(exact + this.remainder);
    this.remainder = exact + this.remainder - rounded;
    // 防数值漂移: |remainder| 始终 ≤ 0.5, 超过表示浮点累积异常
    if (Math.abs(this.remainder) > 0.5) this.remainder = 0;
    return Math.max(1, rounded);
  }

  reset() { this.remainder = 0; }
}

/* ===========================================================
   4. 线性回归 — 字体度量校准
   =========================================================== */

export class LinearRegression {
  private sumX = 0;
  private sumY = 0;
  private sumXY = 0;
  private sumX2 = 0;
  private n = 0;

  /** 添加样本点 (cols, pixels) */
  addSample(cols: number, pixels: number) {
    this.sumX += cols;
    this.sumY += pixels;
    this.sumXY += cols * pixels;
    this.sumX2 += cols * cols;
    this.n++;
  }

  /** 计算校准后的字符宽度 β̂ */
  calibrate(): number {
    if (this.n < 2) return 0;
    const denominator = this.n * this.sumX2 - this.sumX * this.sumX;
    if (Math.abs(denominator) < 1e-10) return this.sumY / Math.max(1, this.sumX);
    // β̂ = (n·Σxy - Σx·Σy) / (n·Σx² - (Σx)²)
    const slope = (this.n * this.sumXY - this.sumX * this.sumY) / denominator;
    return slope;
  }

  /** 校准后的列数 */
  calibratedCols(containerWidth: number): number {
    const slope = this.calibrate();
    if (slope <= 0) return 80;
    return Math.max(1, Math.round(containerWidth / slope));
  }

  reset() {
    this.sumX = this.sumY = this.sumXY = this.sumX2 = 0;
    this.n = 0;
  }
}

/* ===========================================================
   5. 指数退避调度 — resize 去抖
   =========================================================== */

export class ExponentialBackoff {
  private consecutiveCount = 0;
  private lastTime = 0;
  private baseDelay = 16; // ms (1 frame)
  private maxDelay = 256;  // ms

  /** 返回本次应等待的延迟 (ms), 0 表示立即执行 */
  nextDelay(now: number = Date.now()): number {
    const elapsed = now - this.lastTime;
    if (elapsed > this.maxDelay) {
      this.consecutiveCount = 0;
    }
    this.consecutiveCount++;
    this.lastTime = now;
    const delay = Math.min(this.baseDelay * Math.pow(2, this.consecutiveCount - 1), this.maxDelay);
    return delay;
  }

  reset() { this.consecutiveCount = 0; }
}

/* ===========================================================
   6. Kalman 滤波器 — 容器尺寸平滑
   =========================================================== */

/**
 * 简单一维 Kalman 滤波器 (用于 cols 估算)
 * 状态: x = [width, velocity]ᵀ
 * 观测: z = measuredWidth
 */
export class KalmanFilter1D {
  private x: [number, number]; // [position, velocity]
  private p: [[number, number], [number, number]]; // 协方差矩阵

  constructor(
    initialPosition: number,
    private processNoise = 0.1,   // Q
    private measurementNoise = 5, // R
  ) {
    this.x = [initialPosition, 0];
    this.p = [[1, 0], [0, 1]];
  }

  /**
   * @param measurement 测量值
   * @param dt 时间间隔 (ms), 默认 16ms (1 帧)
   * @returns 平滑后的位置估计值
   */
  filter(measurement: number, dt: number = 16): number {
    const t = dt / 1000; // 转换为秒

    // 预测步骤
    const F11 = 1, F12 = t, F21 = 0, F22 = 1;
    const x_pred: [number, number] = [
      F11 * this.x[0] + F12 * this.x[1],
      F21 * this.x[0] + F22 * this.x[1],
    ];
    const p_pred: [[number, number], [number, number]] = [
      [
        F11 * (F11 * this.p[0][0] + F12 * this.p[1][0]) + F12 * (F11 * this.p[0][1] + F12 * this.p[1][1]) + this.processNoise,
        F21 * (F11 * this.p[0][0] + F12 * this.p[1][0]) + F22 * (F11 * this.p[0][1] + F12 * this.p[1][1]),
      ],
      [
        F11 * (F21 * this.p[0][0] + F22 * this.p[1][0]) + F12 * (F21 * this.p[0][1] + F22 * this.p[1][1]),
        F21 * (F21 * this.p[0][0] + F22 * this.p[1][0]) + F22 * (F21 * this.p[0][1] + F22 * this.p[1][1]) + this.processNoise,
      ],
    ];

    // 更新步骤 (H = [1, 0])
    const y = measurement - x_pred[0]; // 观测残差
    const S = p_pred[0][0] + this.measurementNoise;
    const K0 = p_pred[0][0] / S;
    const K1 = p_pred[1][0] / S;

    this.x = [x_pred[0] + K0 * y, x_pred[1] + K1 * y];
    this.p = [
      [p_pred[0][0] - K0 * p_pred[0][0], p_pred[0][1] - K0 * p_pred[0][1]],
      [p_pred[1][0] - K1 * p_pred[0][0], p_pred[1][1] - K1 * p_pred[0][1]],
    ];

    return this.x[0];
  }

  get position(): number { return this.x[0]; }
  get velocity(): number { return this.x[1]; }
}

/* ===========================================================
   7. Shannon 熵 — 输出分类
   =========================================================== */

/**
 * 计算字节块的 Shannon 熵
 * @param data 字符串数据
 * @returns 熵值 [0, 8], 低=结构化, 高=随机
 */
export function shannonEntropy(data: string): number {
  if (!data) return 0;
  const freq = new Map<number, number>();
  const len = data.length;
  for (let i = 0; i < len; i++) {
    const code = data.charCodeAt(i) & 0xFF;
    freq.set(code, (freq.get(code) || 0) + 1);
  }
  let entropy = 0;
  freq.forEach((count) => {
    const p = count / len;
    entropy -= p * Math.log2(p);
  });
  return entropy;
}

/** 块分类 */
export type BlockCategory = 'text' | 'structured' | 'binary';

export function classifyBlock(entropy: number): BlockCategory {
  if (entropy < 4) return 'structured';
  if (entropy < 6.5) return 'text';
  return 'binary';
}

/* ===========================================================
   8. CIELAB 色彩 + HSL 插值
   =========================================================== */

export interface RGB { r: number; g: number; b: number; }
export interface HSL { h: number; s: number; l: number; }

/** RGB (0-255) → CIELAB */
export function rgbToLab(rgb: RGB): { L: number; a: number; b: number } {
  let r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
  // sRGB → linear
  r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
  g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
  b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;
  // Linear RGB → XYZ
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = (r * 0.2126 + g * 0.7152 + b * 0.0722);
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  // XYZ → L*a*b*
  const fx = x > 0.008856 ? Math.cbrt(x) : 7.787 * x + 16 / 116;
  const fy = y > 0.008856 ? Math.cbrt(y) : 7.787 * y + 16 / 116;
  const fz = z > 0.008856 ? Math.cbrt(z) : 7.787 * z + 16 / 116;
  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

/** CIELAB ΔE* (CIE76) */
export function deltaE(lab1: ReturnType<typeof rgbToLab>, lab2: ReturnType<typeof rgbToLab>): number {
  return Math.sqrt(
    (lab1.L - lab2.L) ** 2 +
    (lab1.a - lab2.a) ** 2 +
    (lab1.b - lab2.b) ** 2,
  );
}

/** 将 hex 颜色字符串转为 RGB */
export function hexToRgb(hex: string): RGB {
  const v = parseInt(hex.replace('#', ''), 16);
  return { r: (v >> 16) & 0xFF, g: (v >> 8) & 0xFF, b: v & 0xFF };
}

/** RGB 转 hex */
export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(c => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('');
}

/** RGB → HSL */
export function rgbToHsl(rgb: RGB): HSL {
  const r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
}

/** HSL → RGB */
export function hslToRgb(hsl: HSL): RGB {
  const h = hsl.h / 360, s = hsl.s / 100, l = hsl.l / 100;
  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

/** HSL 插值 — 用于主题渐变 */
export function lerpHSL(a: HSL, b: HSL, t: number): HSL {
  // 色调走最短路径
  let dh = b.h - a.h;
  if (Math.abs(dh) > 180) { dh = dh > 0 ? dh - 360 : dh + 360; }
  return {
    h: ((a.h + t * dh) % 360 + 360) % 360,
    s: a.s + t * (b.s - a.s),
    l: a.l + t * (b.l - a.l),
  };
}

/** 计算两个 RGB 颜色的感知对比度 */
export function perceptualContrast(rgb1: RGB, rgb2: RGB): number {
  return deltaE(rgbToLab(rgb1), rgbToLab(rgb2));
}

/* ===========================================================
   9. 黄金比例
   =========================================================== */

export const GOLDEN_RATIO = 1.618033988749895;

/** 二分屏默认比例: 主窗 φ/(1+φ) ≈ 0.618, 副窗 1/(1+φ) ≈ 0.382 */
export function goldenSplit(): [number, number] {
  const main = GOLDEN_RATIO / (1 + GOLDEN_RATIO);
  return [main, 1 - main];
}
