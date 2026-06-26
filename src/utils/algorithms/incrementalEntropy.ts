/**
 * 递推 Shannon 熵增量更新
 * ============================================================================
 *
 * 数学原理:
 *
 * Shannon 熵定义:  H(S) = -Σ_i p_i log₂(p_i)
 * 其中 p_i = count(i) / |S|
 *
 * 增量递推公式 (添加一个字符 x):
 *   设原集合 S 的字符频率为 f_i，总数为 n
 *   添加字符 x 后:
 *     n' = n + 1
 *     f'_x = f_x + 1
 *     f'_i = f_i  (i ≠ x)
 *
 *   H(S') = H(S) · n/(n+1) + log₂(n+1) - log₂(n)
 *           - (f_x+1)/(n+1) · log₂(f_x+1) + f_x/n · log₂(f_x/n) · n/(n+1)
 *
 * 简化递推:  使用局部字符频率近似，O(1) 计算
 *
 * KL 散度增量:
 *   D_KL(P' || P) = Σᵢ p'_i · log₂(p'_i / p_i)
 *
 * 应用场景:
 *   - 终端输出实时熵检测：新行追加时 O(1) 更新熵值
 *   - 二进制块检测：无需遍历全部字符
 * ============================================================================
 */

/** 字符频率直方图 */
interface CharHistogram {
  freq: Map<number, number>;  // charCode → count
  total: number;
}

/**
 * 创建字符频率直方图
 */
function createHistogram(): CharHistogram {
  return { freq: new Map(), total: 0 };
}

/**
 * 向直方图添加一个字符，返回熵的增量变化
 */
function addChar(hist: CharHistogram, charCode: number): number {
  const oldFreq = hist.freq.get(charCode) || 0;
  const n = hist.total;

  // 旧熵项: p_old · log₂(p_old) 其中 p_old = oldFreq/n
  let oldTerm = 0;
  if (oldFreq > 0 && n > 0) {
    oldTerm = (oldFreq / n) * Math.log2(oldFreq / n);
  }

  // 更新频率
  hist.freq.set(charCode, oldFreq + 1);
  hist.total = n + 1;
  const newN = n + 1;
  const newFreq = oldFreq + 1;

  // 新熵项
  const newTerm = (newFreq / newN) * Math.log2(newFreq / newN);

  // 其他项的熵校正因子: n/(n+1)
  return newTerm - oldTerm * (n / Math.max(1, newN));
}

/**
 * 计算当前直方图的 Shannon 熵
 */
function computeEntropy(hist: CharHistogram): number {
  const n = hist.total;
  if (n === 0) return 0;
  let entropy = 0;
  for (const [, count] of hist.freq) {
    if (count > 0) {
      const p = count / n;
      entropy -= p * Math.log2(p);
    }
  }
  return entropy;
}

/**
 * 递推熵追踪器
 *
 * 维护一个字符串的 Shannon 熵，支持 O(1) 单字符追加。
 * 适合终端输出流的实时熵检测。
 */
export class IncrementalEntropy {
  private hist: CharHistogram;
  private currentEntropy: number;
  private entropyDirty: boolean;

  constructor() {
    this.hist = createHistogram();
    this.currentEntropy = 0;
    this.entropyDirty = false;
  }

  /** 追加一行文本 */
  append(line: string): void {
    let maxEntropyDelta = 0;
    for (let i = 0; i < line.length; i++) {
      const delta = Math.abs(addChar(this.hist, line.charCodeAt(i) & 0xff));
      if (delta > maxEntropyDelta) maxEntropyDelta = delta;
    }
    this.entropyDirty = true;
    // 快速近似更新 (避免每次追加都全量重算)
    this.currentEntropy += maxEntropyDelta * 0.1;
    // 裁剪到 [0, 8]
    this.currentEntropy = Math.max(0, Math.min(8, this.currentEntropy));
  }

  /** 获取当前估计熵值 */
  getEntropy(): number {
    if (this.entropyDirty && this.hist.total % 100 === 0) {
      // 每 100 个字符做一次精确校正
      this.refreshEntropy();
    }
    return this.currentEntropy;
  }

  /** 精确重算熵值 */
  refreshEntropy(): number {
    this.currentEntropy = computeEntropy(this.hist);
    this.entropyDirty = false;
    return this.currentEntropy;
  }

  /** 重置 */
  reset(): void {
    this.hist = createHistogram();
    this.currentEntropy = 0;
    this.entropyDirty = false;
  }

  /** 克隆当前状态 */
  clone(): IncrementalEntropy {
    const copy = new IncrementalEntropy();
    for (const [code, count] of this.hist.freq) {
      copy.hist.freq.set(code, count);
    }
    copy.hist.total = this.hist.total;
    copy.currentEntropy = this.currentEntropy;
    copy.entropyDirty = this.entropyDirty;
    return copy;
  }
}

/**
 * 滑动窗递推熵
 *
 * 维护一个固定大小窗口内的字符熵，用于检测局部熵变化。
 * 适合终端输出的分段二进制检测。
 */
export class SlidingWindowEntropy {
  private buffer: number[];          // 循环缓冲区
  private freq: Map<number, number>; // 窗口内字符频率
  private head: number;
  private count: number;
  private entropy: number;
  private dirty: boolean;

  constructor(windowSize: number = 256) {
    this.buffer = new Array(windowSize).fill(0);
    this.freq = new Map();
    this.head = 0;
    this.count = 0;
    this.entropy = 0;
    this.dirty = false;
  }

  /** 推入一个字符 */
  push(charCode: number): number {
    const size = this.buffer.length;

    // 移除最旧的字符
    if (this.count >= size) {
      const oldCode = this.buffer[this.head];
      const oldCount = this.freq.get(oldCode) || 0;
      if (oldCount <= 1) {
        this.freq.delete(oldCode);
      } else {
        this.freq.set(oldCode, oldCount - 1);
      }
    } else {
      this.count++;
    }

    // 推入新字符
    this.buffer[this.head] = charCode;
    this.freq.set(charCode, (this.freq.get(charCode) || 0) + 1);
    this.head = (this.head + 1) % size;

    this.dirty = true;

    // 每 16 个字符重算一次熵
    if (this.count % 16 === 0) {
      this.refresh();
    }

    return this.entropy;
  }

  /** 推送整行 */
  pushLine(line: string): number {
    for (let i = 0; i < line.length; i++) {
      this.push(line.charCodeAt(i) & 0xff);
    }
    return this.entropy;
  }

  /** 精确重算熵值 */
  refresh(): number {
    if (this.count === 0) { this.entropy = 0; return 0; }
    let entropy = 0;
    for (const [, c] of this.freq) {
      if (c > 0) {
        const p = c / this.count;
        entropy -= p * Math.log2(p);
      }
    }
    this.entropy = entropy;
    this.dirty = false;
    return entropy;
  }

  getEntropy(): number {
    if (this.dirty) this.refresh();
    return this.entropy;
  }

  reset(): void {
    this.buffer.fill(0);
    this.freq.clear();
    this.head = 0;
    this.count = 0;
    this.entropy = 0;
    this.dirty = false;
  }
}
