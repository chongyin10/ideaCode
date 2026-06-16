/**
 * terminalStats.ts — 统计算法模块
 *
 * 包含:
 * 1. Zipf 分布活跃预测 — 频率直方图 + 衰减权重
 * 2. Markov 链预测 — 下一个活跃 tab 预测
 * 3. n-gram 命令预测 — trigram + 时间衰减
 * 4. 线性回归校准 — 字体度量（已移至 terminalMath.ts）
 */

/* ===========================================================
   1. Zipf 分布活跃预测
   =========================================================== */

interface TabActivityRecord {
  /** 切换次数 */
  switchCount: number;
  /** 最近活跃时间戳 */
  lastActiveTime: number;
  /** 累计活跃时长 (ms) */
  totalActiveDuration: number;
}

export class TabActivityTracker {
  private records = new Map<string, TabActivityRecord>();
  private decayLambda = 0.001; // 指数衰减因子 (每 ms)

  /** 记录一次切换 */
  recordSwitch(tabId: string) {
    const now = Date.now();
    const rec = this.ensureRecord(tabId);
    rec.switchCount++;
    rec.lastActiveTime = now;
    this._applyDecay();
  }

  /** 记录活跃时长增量 */
  recordDuration(tabId: string, durationMs: number) {
    const rec = this.ensureRecord(tabId);
    rec.totalActiveDuration += durationMs;
  }

  /** 获取加权活跃分数 (衰减) */
  getScore(tabId: string): number {
    const rec = this.records.get(tabId);
    if (!rec) return 0;
    const now = Date.now();
    const elapsed = now - rec.lastActiveTime;
    const decay = Math.exp(-this.decayLambda * elapsed);
    // 综合: 切换频率 × 使用时长 × 时间衰减
    return rec.switchCount * Math.log(1 + rec.totalActiveDuration / 1000) * decay;
  }

  /** 从一组候选 tab 中选择最可能活跃的 (top-K) */
  predictActive(candidates: string[], topK: number = 1): string[] {
    return candidates
      .map(id => ({ id, score: this.getScore(id) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(x => x.id);
  }

  /** 清理长期未活跃的记录 */
  cleanup(maxAge = 7 * 24 * 3600 * 1000) {
    const now = Date.now();
    for (const [id, rec] of this.records) {
      if (now - rec.lastActiveTime > maxAge) {
        this.records.delete(id);
      }
    }
  }

  private ensureRecord(tabId: string): TabActivityRecord {
    let rec = this.records.get(tabId);
    if (!rec) {
      rec = { switchCount: 0, lastActiveTime: 0, totalActiveDuration: 0 };
      this.records.set(tabId, rec);
    }
    return rec;
  }

  private _applyDecay() {
    // 每记录 100 次切换进行一次衰减
    if (this.records.size > 100) {
      this.cleanup(3600 * 1000); // 清理 1 小时未活跃的记录
    }
  }
}

/* ===========================================================
   2. Markov 链预测
   =========================================================== */

export class MarkovPredictor {
  /** 转移矩阵: from → Map<to, count> */
  private transitions = new Map<string, Map<string, number>>();
  /** 从各状态出发的总次数 */
  private fromCounts = new Map<string, number>();

  /** 记录状态转移 */
  recordTransition(from: string | null, to: string) {
    if (!from || from === to) return;

    if (!this.transitions.has(from)) {
      this.transitions.set(from, new Map());
    }
    const toMap = this.transitions.get(from)!;
    toMap.set(to, (toMap.get(to) || 0) + 1);
    this.fromCounts.set(from, (this.fromCounts.get(from) || 0) + 1);

  }

  /** 预测下一个最可能的 tab */
  predict(currentTab: string): string | null {
    const toMap = this.transitions.get(currentTab);
    if (!toMap || toMap.size === 0) return null;

    let bestTo: string | null = null;
    let bestCount = 0;
    toMap.forEach((count, to) => {
      if (count > bestCount) { bestCount = count; bestTo = to; }
    });
    return bestTo;
  }

  /** 获取从 from 到 to 的概率 */
  getProbability(from: string, to: string): number {
    const total = this.fromCounts.get(from) || 0;
    if (total === 0) return 0;
    const toMap = this.transitions.get(from);
    return (toMap?.get(to) || 0) / total;
  }

  /** 获取 top-K 预测 */
  predictTopK(currentTab: string, k: number = 3): string[] {
    const toMap = this.transitions.get(currentTab);
    if (!toMap) return [];
    return Array.from(toMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(x => x[0]);
  }

  reset() {
    this.transitions.clear();
    this.fromCounts.clear();
  }
}

/* ===========================================================
   3. n-gram 命令预测器
   =========================================================== */

interface NGramEntry {
  /** 加权计数（带时间衰减） */
  count: number;
  /** 最后使用时间 */
  lastUsed: number;
}

export class NGramPredictor {
  private bigrams = new Map<string, Map<string, NGramEntry>>();
  private trigrams = new Map<string, Map<string, NGramEntry>>();
  private prevTokens: string[] = []; // 前两个 token
  private decayLambda = 0.00001; // 每 ms 衰减

  /**
   * 记录一个命令（空格分词）
   */
  recordCommand(commandLine: string) {
    const tokens = commandLine.trim().split(/\s+/);
    if (tokens.length === 0) return;

    const now = Date.now();

    // 更新 bigram
    if (this.prevTokens.length >= 1) {
      const bigramKey = this.prevTokens[this.prevTokens.length - 1];
      const first = tokens[0];
      if (!this.bigrams.has(bigramKey)) this.bigrams.set(bigramKey, new Map());
      const m = this.bigrams.get(bigramKey)!;
      const entry = m.get(first);
      if (entry) {
        entry.count += Math.exp(-this.decayLambda * (now - entry.lastUsed));
        entry.lastUsed = now;
      } else {
        m.set(first, { count: 1, lastUsed: now });
      }
    }

    // 更新 trigram
    if (this.prevTokens.length >= 2) {
      const triKey = this.prevTokens.slice(-2).join(' ');
      const first = tokens[0];
      if (!this.trigrams.has(triKey)) this.trigrams.set(triKey, new Map());
      const m = this.trigrams.get(triKey)!;
      const entry = m.get(first);
      if (entry) {
        entry.count += Math.exp(-this.decayLambda * (now - entry.lastUsed));
        entry.lastUsed = now;
      } else {
        m.set(first, { count: 1, lastUsed: now });
      }
    }

    // 更新历史
    this.prevTokens = tokens.slice(-2);
  }

  /**
   * 预测下一个 token
   * @param prefix 当前输入前缀
   * @param topK 返回 top-K 建议
   */
  predict(prefix: string, topK: number = 3): string[] {
    const context = this.prevTokens;
    const candidates = new Map<string, number>();

    // 先从 trigram 查找
    if (context.length >= 2) {
      const triKey = context.slice(-2).join(' ');
      const m = this.trigrams.get(triKey);
      if (m) {
        m.forEach((entry, token) => {
          if (token.startsWith(prefix)) {
            candidates.set(token, entry.count * 2); // trigram 权重更高
          }
        });
      }
    }

    // 再从 bigram 查找
    if (context.length >= 1) {
      const biKey = context[context.length - 1];
      const m = this.bigrams.get(biKey);
      if (m) {
        m.forEach((entry, token) => {
          if (token.startsWith(prefix)) {
            candidates.set(token, (candidates.get(token) || 0) + entry.count);
          }
        });
      }
    }

    return Array.from(candidates.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(x => x[0]);
  }

  /** 获取常用命令列表（fallback） */
  getTopCommands(limit: number = 10): string[] {
    const all = new Map<string, number>();
    this.bigrams.forEach(m => m.forEach((entry, token) => {
      all.set(token, (all.get(token) || 0) + entry.count);
    }));
    return Array.from(all.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(x => x[0]);
  }

  reset() {
    this.bigrams.clear();
    this.trigrams.clear();
    this.prevTokens = [];
  }
}
