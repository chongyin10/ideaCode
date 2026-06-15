/**
 * 多臂老虎机搜索排序 (Thompson Sampling)
 *
 * 将搜索结果的排序视为 Explore-Exploit 博弈问题：
 *   每个搜索结果是一个"臂"
 *   用户点击 = 奖励 1
 *   用户未点击 = 奖励 0
 *   目标：最大化累积点击率
 *
 * ## Thompson Sampling 原理
 *
 * 对每个臂 i 维护 Beta(α_i, β_i) 先验分布：
 *   α_i = 历史点击数 + prior
 *   β_i = 历史展示未点击数 + prior
 *
 * 每次排序时，从 Beta(α_i, β_i) 采样得分 s_i，
 * 按 s_i 降序排列结果。这自然实现了：
 *   - Explore: 低 α_i, β_i 的臂有更大的采样方差，偶尔会被排到前面
 *   - Exploit: 高 α_i, β_i 的臂采样集中在均值附近，确定性排序
 *
 * ## Upper Confidence Bound (UCB) 备选
 *
 * UCB 是另一种常用的 Bandit 策略：
 *   score_i = μ̂_i + c · √(ln(t) / n_i)
 *
 * 其中 μ̂_i 是经验均值，n_i 是展示次数，t 是总展示次数，
 * c 是探索系数。UCB 给出的置信区间上界保证了次线性后悔。
 *
 * 本实现同时提供 Thompson Sampling 和 UCB 两种策略。
 */

export type BanditStrategy = 'thompson' | 'ucb';

export interface BanditArm {
  /** 臂的标识符（文件路径） */
  id: string;
  /** 点击数（奖励=1） */
  clicks: number;
  /** 展示未点击数（奖励=0） */
  impressions: number;
  /** 最后点击时间戳 */
  lastClickTime: number;
}

export interface BanditConfig {
  /** 策略 */
  strategy?: BanditStrategy;
  /** 先验伪计数（Beta先验） */
  prior?: number;
  /** UCB 探索系数 c */
  ucbC?: number;
  /** 时间衰减因子（旧数据权重降低） */
  timeDecay?: number;
}

const DEFAULT_BANDIT_CONFIG: Required<BanditConfig> = {
  strategy: 'thompson',
  prior: 1,
  ucbC: 1.5,
  timeDecay: 0.99,
};

export class SearchBanditRanker {
  private arms = new Map<string, BanditArm>();
  private config: Required<BanditConfig>;
  private totalImpressions = 0;

  constructor(config: BanditConfig = {}) {
    this.config = { ...DEFAULT_BANDIT_CONFIG, ...config };
  }

  /**
   * 注册一个搜索结果（臂）
   */
  registerArm(id: string): BanditArm {
    if (!this.arms.has(id)) {
      this.arms.set(id, { id, clicks: 0, impressions: 0, lastClickTime: 0 });
    }
    return this.arms.get(id)!;
  }

  /**
   * 记录展示（未点击）
   */
  recordImpression(id: string): void {
    const arm = this.registerArm(id);
    arm.impressions++;
    this.totalImpressions++;
  }

  /**
   * 记录点击（正向反馈）
   */
  recordClick(id: string): void {
    const arm = this.registerArm(id);
    arm.clicks++;
    arm.impressions++;
    arm.lastClickTime = Date.now();
    this.totalImpressions++;
  }

  /**
   * 获取 Thompson Sampling 采样得分
   *
   * Beta(α, β) 分布的采样：
   * 使用 Gamma 分布的方法：Beta(α,β) = Gamma(α,1) / (Gamma(α,1) + Gamma(β,1))
   * 简化为 Box-Muller 变换生成正态分布 → 近似 Beta
   *
   * 由于 JS 没有原生 Beta 采样，这里使用近似：
   * mean = α/(α+β), std = sqrt(αβ / ((α+β)²(α+β+1)))
   * 用截断正态近似采样
   */
  private thompsonSample(arm: BanditArm): number {
    const { prior, timeDecay } = this.config;

    // 时间衰减加权
    const age = (Date.now() - arm.lastClickTime) / (1000 * 3600 * 24); // 天数
    const timeWeight = Math.pow(timeDecay, age);

    const alpha = arm.clicks * timeWeight + prior;
    const beta = Math.max(0, arm.impressions - arm.clicks) * timeWeight + prior;

    // Box-Muller 近似 Beta 采样
    const mean = alpha / (alpha + beta);
    const variance = (alpha * beta) / ((alpha + beta) * (alpha + beta) * (alpha + beta + 1));
    const std = Math.sqrt(Math.max(variance, 1e-6));

    // 截断正态采样
    let sample: number;
    do {
      const u1 = Math.random();
      const u2 = Math.random();
      sample = mean + std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    } while (sample < 0 || sample > 1);

    return sample;
  }

  /**
   * UCB 得分计算
   */
  private ucbScore(arm: BanditArm): number {
    const { prior, ucbC } = this.config;
    const n = arm.impressions;

    if (n === 0) return Infinity; // 从未展示过的臂优先 Explore

    const meanReward = (arm.clicks + prior) / (n + 2 * prior);
    const explorationBonus = ucbC * Math.sqrt(Math.log(this.totalImpressions + 1) / n);

    return meanReward + explorationBonus;
  }

  /**
   * 对搜索结果重新排序
   *
   * @param items 原始排序结果（按静态得分降序）
   * @param idFn 从 item 提取 id 的函数
   * @param scoreFn 原始得分的函数
   * @param mixRatio 原始得分和 Bandit 得分的混合比例（0 = 纯 Bandit, 1 = 纯原始）
   * @returns 重新排序的结果
   */
  rerank<T>(
    items: T[],
    idFn: (item: T) => string,
    scoreFn: (item: T) => number,
    mixRatio = 0.3
  ): T[] {
    if (items.length === 0) return [];

    const { strategy } = this.config;

    // 提取静态得分范围
    const staticScores = items.map(scoreFn);
    const maxStatic = Math.max(...staticScores);
    const minStatic = Math.min(...staticScores);
    const range = maxStatic - minStatic || 1;

    // 计算每个 item 的混合得分
    const scored = items.map((item, idx) => {
      const id = idFn(item);
      const arm = this.arms.get(id);
      const staticScore = staticScores[idx];

      let banditScore = 0.5; // 默认：未见过的臂给中性得分
      if (arm) {
        banditScore = strategy === 'thompson'
          ? this.thompsonSample(arm)
          : this.ucbScore(arm);

        // UCB 得分可能 > 1，做归一化
        if (strategy === 'ucb') {
          banditScore = Math.min(1, banditScore / 3);
        }
      }

      // 静态得分归一化到 [0, 1]
      const normStatic = (staticScore - minStatic) / range;

      // 混合
      const mixedScore = mixRatio * normStatic + (1 - mixRatio) * banditScore;

      return { item, score: mixedScore, id };
    });

    // 按混合得分降序
    scored.sort((a, b) => b.score - a.score);
    return scored.map(s => s.item);
  }

  /**
   * 获取臂的统计信息
   */
  getArmStats(id: string): BanditArm | undefined {
    return this.arms.get(id);
  }

  /**
   * 获取所有臂的统计信息
   */
  getAllArms(): BanditArm[] {
    return Array.from(this.arms.values());
  }

  /**
   * 获取每种策略的预期后悔上界估计
   */
  getStats() {
    const arms = this.getAllArms();
    const avgCTR = arms.length > 0
      ? arms.reduce((s, a) => s + (a.impressions > 0 ? a.clicks / a.impressions : 0), 0) / arms.length
      : 0;
    return {
      totalArms: arms.length,
      totalImpressions: this.totalImpressions,
      avgCTR,
      strategy: this.config.strategy,
    };
  }

  reset(): void {
    this.arms.clear();
    this.totalImpressions = 0;
  }
}
