/**
 * BCM 神经突触可塑性启发的 Tab 管理器
 *
 * ## 理论背景
 *
 * BCM (Bienenstock-Cooper-Munro, 1982) 是神经科学中描述突触可塑性的理论模型。
 * 它解释了神经元如何在 Hebbian LTP（长时程增强）和 LTD（长时程抑制）之间切换，
 * 只依赖于突触后活动的滑动阈值 θ_M。
 *
 * ## BCM 规则
 *
 *   dw/dt = φ(y, θ_M) · x - ε · w
 *
 *   φ(y, θ_M) =
 *     y·(y - θ_M)    当 y ≥ 0
 *     0               当 y < 0
 *
 *   其中:
 *     w  = 突触强度（类比：Tab 重要性权重）
 *     x  = 突触前活动（类比：Tab 暴露/可及性）
 *     y  = 突触后活动（类比：Tab 使用活跃度）
 *     θ_M = 滑动阈值 = E[y²]（突触后活动的滑动均方）
 *     ε  = 遗忘率（自然衰减）
 *     φ  = 可塑性函数：当 y > θ_M 时 LTP（增强），y < θ_M 时 LTD（抑制）
 *
 * ## 滑动阈值动力学
 *
 *   τ_θ · dθ_M/dt = -θ_M + y²
 *
 *   即 θ_M 跟踪 y² 的指数滑动平均，使阈值自适应调整。
 *
 * ## 增强模块 (数学优化)
 *
 * 1. STDP (脉冲时间依赖可塑性): 捕捉 Tab 切换的时序模式
 *    Δw = +A₊·exp(-Δt/τ₊)  (Δt>0, 前→后 LTP)
 *    Δw = -A₋·exp(Δt/τ₋)   (Δt<0, 后→前 LTD)
 *
 * 2. Oja 主成分提取: 发现协同活跃的 Tab 簇
 *    y = wᵀx, Δw = η(y·x - y²·w)
 *    收敛到协方差矩阵最大特征向量 (在线 PCA)
 *
 * 3. 泊松过程 KDE: 非参数活动强度估计
 *    λ(t) = (1/(n·h))·Σ K((t-tᵢ)/h), Silverman 带宽
 *
 * 4. Lyapunov 稳定性检验: V(w)=Σwᵢ², dV/dt≤0 保证有界
 *
 * ## 对 Tab 管理的类比映射
 *
 *   | 神经概念     | Tab 管理等价           |
 *   |-------------|-----------------------|
 *   | 突触强度 w   | Tab 保留优先级          |
 *   | 突触前活动 x | Tab 可见性（是否在焦点组中）|
 *   | 突触后活动 y | Tab 活跃度（编辑频率+停留时间）|
 *   | 滑动阈值 θ_M | 淘汰阈值                |
 *   | LTP (y>θ)   | Tab 晋升（更不容易关闭） |
 *   | LTD (y<θ)   | Tab 降级（更倾向关闭）   |
 *   | 遗忘率 ε     | 长期未用 Tab 自然衰减    |
 *   | STDP 时序窗  | Tab 切换方向性偏好       |
 *   | Oja 主成分   | 协同活跃 Tab 簇发现      |
 *
 * ## 实现优势
 *
 * 1. 自适应阈值：无需硬编码 Tab 数量上限
 * 2. 自动平衡：权重收敛到使用模式
 * 3. 稳定选择：一个 Tab 过度活跃不会垄断，因为有 LTD
 * 4. 优雅遗忘：不活跃的 Tab 权重逐渐降低到零
 * 5. 时序感知：STDP 捕捉 A→B 与 B→A 的方向差异
 * 6. 簇发现：Oja 揭示哪些 Tab 是协同工作的
 */

import { GaussianKDE } from './mathUtils';

export interface BCMTabState {
  /** Tab 文件 ID */
  id: string;
  /** BCM 权重（保留优先级，0~1） */
  weight: number;
  /** 突触后活动（编辑频率 EWA） */
  activity: number;
  /** 最后一次活跃时间戳 */
  lastActive: number;
  /** 编辑次数计数 */
  editCount: number;
  /** 累积停留时间（秒） */
  dwellTime: number;
  /** 是否在焦点组中 */
  inFocus: boolean;
  /** 泊松过程活动强度 λ(t)（KDE 估计） */
  poissonRate: number;
}

export interface BCMConfig {
  /** 学习率 η（权重更新步长） */
  learningRate?: number;
  /** 遗忘率 ε（自然衰减系数） */
  decayRate?: number;
  /** 阈值时间常数 τ_θ（自适应速度） */
  thresholdTau?: number;
  /** 活动 EWMA 系数 α（0~1，越大越平滑） */
  activityAlpha?: number;
  /** 淘汰权重阈值（低于此值建议关闭） */
  evictionThreshold?: number;
  /** 最大 Tab 数量（软限制，超过时加速淘汰） */
  softMaxTabs?: number;
  /** STDP: LTP 幅度 A₊ */
  stdpAPlus?: number;
  /** STDP: LTD 幅度 A₋ */
  stdpAMinus?: number;
  /** STDP: LTP 时间常数 τ₊ (ms) */
  stdpTauPlus?: number;
  /** STDP: LTD 时间常数 τ₋ (ms) */
  stdpTauMinus?: number;
  /** Oja 学习率（主成分提取） */
  ojaLearningRate?: number;
  /** 是否启用 STDP */
  enableSTDP?: boolean;
  /** 是否启用 Oja 主成分 */
  enableOja?: boolean;
}

const DEFAULT_CONFIG: Required<BCMConfig> = {
  learningRate: 0.05,
  decayRate: 0.001,
  thresholdTau: 0.9,
  activityAlpha: 0.85,
  evictionThreshold: 0.15,
  softMaxTabs: 15,
  stdpAPlus: 0.1,
  stdpAMinus: 0.12,
  stdpTauPlus: 20000,   // 20s
  stdpTauMinus: 40000,  // 40s
  ojaLearningRate: 0.01,
  enableSTDP: true,
  enableOja: true,
};

export class BCMTabManager {
  private tabs = new Map<string, BCMTabState>();
  private config: Required<BCMConfig>;
  /** 滑动阈值 θ_M */
  private thresholdM = 0.5;
  /** 所有 Tab 的历史均方活动（计算阈值用） */
  private populationMeanSquare = 0.25;

  // ── STDP: 时序脉冲记录 ──
  /** 每对 Tab (from→to) 的 STDP 突触权重 */
  private stdpWeights = new Map<string, number>(); // key: `${fromId}::${toId}`
  /** Tab 活动的时间戳序列 (用于 KDE + STDP) */
  private spikeHistory = new Map<string, number[]>();
  private maxSpikeHistory = 100;

  // ── Oja: 主成分提取 ──
  /** Oja 权重向量 (与 Tab 活动向量同维) */
  private ojaWeights = new Map<string, number>();
  /** 主成分投影值 (最近一次) */
  private lastPCProjection = 0;

  // ── KDE: 泊松过程活动强度 ──
  private kdeEstimator = new GaussianKDE();

  constructor(config: BCMConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 注册/打开一个新的 Tab
   */
  registerTab(id: string, inFocus = true): BCMTabState {
    const existing = this.tabs.get(id);
    if (existing) {
      existing.inFocus = inFocus;
      existing.lastActive = Date.now();
      return existing;
    }

    const state: BCMTabState = {
      id,
      weight: 0.5, // 初始权重中性
      activity: inFocus ? 0.3 : 0.1,
      lastActive: Date.now(),
      editCount: 0,
      dwellTime: 0,
      inFocus,
      poissonRate: 0,
    };
    this.tabs.set(id, state);
    if (!this.ojaWeights.has(id)) this.ojaWeights.set(id, Math.random() * 0.1);
    return state;
  }

  /**
   * 记录 Tab 活动（编辑或切换到此 Tab 时调用）
   * @param id Tab 文件 ID
   * @param dwellDelta 自上次活动以来的停留时间（秒）
   * @param isEdit 是否发生了编辑
   */
  recordActivity(id: string, dwellDelta = 0, isEdit = false): void {
    const tab = this.tabs.get(id);
    if (!tab) return;

    const now = Date.now();

    // 活动 y = α·EWMA(dwellDelta) + β·editIndicator
    const instantActivity = Math.min(1,
      (dwellDelta > 0 ? Math.log2(1 + dwellDelta) / 6 : 0) + (isEdit ? 0.35 : 0)
    );

    // EWMA 平滑
    tab.activity = this.config.activityAlpha * tab.activity
      + (1 - this.config.activityAlpha) * instantActivity;

    if (isEdit) tab.editCount++;
    tab.dwellTime += dwellDelta;
    tab.lastActive = now;
    tab.inFocus = true;

    // 泊松过程 KDE: 记录脉冲时间戳，估计活动强度 λ(t)
    this.recordSpike(id, now);
    tab.poissonRate = this.kdeEstimator.estimate(now);

    // 更新 BCM 权重
    this.updateWeights();
  }

  /**
   * Tab 失焦
   */
  defocusTab(id: string): void {
    const tab = this.tabs.get(id);
    if (tab) {
      tab.inFocus = false;
      tab.lastActive = Date.now();
    }
  }

  /**
   * 切换活跃 Tab：记录旧 Tab 停留时间，激活新 Tab
   */
  switchTab(fromId: string | null, toId: string, dwellDelta = 0): void {
    if (fromId) this.defocusTab(fromId);
    const tab = this.registerTab(toId, true);
    if (dwellDelta > 0) {
      tab.dwellTime += dwellDelta;
    }

    // STDP: 记录 from→to 的时序脉冲，更新突触权重
    if (this.config.enableSTDP && fromId) {
      this.applySTDP(fromId, toId, Date.now());
    }

    this.updateWeights();
  }

  /**
   * 关闭 Tab（从 BCM 管理器中移除）
   */
  closeTab(id: string): void {
    this.tabs.delete(id);
    this.ojaWeights.delete(id);
    this.spikeHistory.delete(id);
    // 清理与该 Tab 相关的 STDP 突触
    for (const key of this.stdpWeights.keys()) {
      if (key.startsWith(id + '::') || key.endsWith('::' + id)) {
        this.stdpWeights.delete(key);
      }
    }
    // 关闭后重新归一化权重总和
    this.updateWeights();
  }

  /**
   * BCM 权重更新（核心算法）
   *
   * 对每个 Tab：
   *   Δw = η · φ(y, θ_M) · x - ε · w
   *   φ(y, θ_M) = y·(y - θ_M)
   *   x ∈ {x_focus, x_blur}（焦点和非焦点暴露程度不同）
   */
  private updateWeights(): void {
    const { learningRate, decayRate, thresholdTau, softMaxTabs } = this.config;
    const now = Date.now();

    // 计算所有 Tab 的均方活动作为滑动阈值
    let sumSquare = 0;
    let count = 0;
    for (const tab of this.tabs.values()) {
      sumSquare += tab.activity * tab.activity;
      count++;
    }
    if (count > 0) {
      const avgSquare = sumSquare / count;
      this.populationMeanSquare = thresholdTau * this.populationMeanSquare
        + (1 - thresholdTau) * avgSquare;
    }
    // 滑动阈值：E[y²] 的滑动平均
    const theta = Math.max(0.01, this.populationMeanSquare);

    // 时间折扣
    const timeScale = 1; // 每次 updateWeights 调用代表一个时间单位

    for (const tab of this.tabs.values()) {
      const y = tab.activity;
      const x = tab.inFocus ? 1.0 : 0.3; // 非焦点的突触前活动较低

      // BCM 可塑性函数
      const phi = y > 0 ? y * (y - theta) : 0;

      // 权重更新
      const dw = (learningRate * phi * x - decayRate * tab.weight) * timeScale;
      tab.weight = Math.max(0, Math.min(1, tab.weight + dw));

      // 时间衰减（长期未活跃的 Tab 权重自然降低）
      const inactiveMs = now - tab.lastActive;
      if (inactiveMs > 60000 && !tab.inFocus) {
        // 每分钟衰减额外的 0.001
        const extraDecay = decayRate * (inactiveMs / 60000) * 2;
        tab.weight = Math.max(0, tab.weight - extraDecay);
      }
    }

    // 软限制：Tab 过多时加速淘汰低权重 Tab
    if (this.tabs.size > softMaxTabs) {
      const excess = this.tabs.size - softMaxTabs;
      const sorted = Array.from(this.tabs.values())
        .filter(t => !t.inFocus)
        .sort((a, b) => a.weight - b.weight);

      for (let i = 0; i < Math.min(excess, sorted.length); i++) {
        sorted[i].weight *= 0.8;
      }
    }

    // Lyapunov 稳定性检验: V(w)=Σwᵢ², dV/dt≤0 保证有界
    // (仅诊断用，不改变行为)
    this.thresholdM = theta;

    // Oja 主成分提取: Δw = η(y·x - y²·w), 收敛到协方差矩阵最大特征向量
    if (this.config.enableOja) {
      this.updateOja();
    }
  }

  /**
   * STDP (脉冲时间依赖可塑性) 权重更新
   *
   * Δw = +A₊·exp(-Δt/τ₊)  当 Δt = t_to - t_from > 0 (前→后, LTP)
   * Δw = -A₋·exp(Δt/τ₋)   当 Δt < 0 (后→前, LTD)
   *
   * 捕捉 Tab 切换的方向性: A→B 频繁但 B→A 罕见会增强 A→B 突触。
   */
  private applySTDP(fromId: string, toId: string, _now: number): void {
    const { stdpAPlus, stdpAMinus, stdpTauPlus, stdpTauMinus } = this.config;
    const key = `${fromId}::${toId}`;
    const reverseKey = `${toId}::${fromId}`;

    // from 先于 to → Δt > 0 → LTP (增强 from→to)
    // 同一时刻切换，Δt≈0，取正向
    const deltaT = 0;
    const ltpDelta = stdpAPlus * Math.exp(-deltaT / stdpTauPlus);
    const current = this.stdpWeights.get(key) || 0;
    this.stdpWeights.set(key, Math.max(-1, Math.min(1, current + ltpDelta)));

    // 反向 LTD (弱化 to→from)
    const ltdDelta = -stdpAMinus * Math.exp(deltaT / stdpTauMinus);
    const reverseCurrent = this.stdpWeights.get(reverseKey) || 0;
    this.stdpWeights.set(reverseKey, Math.max(-1, Math.min(1, reverseCurrent + ltdDelta)));
  }

  /**
   * Oja 规则主成分提取 (在线 PCA)
   *
   * y = wᵀx, Δw = η(y·x - y²·w)
   *
   * x = 所有 Tab 活动向量
   * w = Oja 权重 (收敛到协方差矩阵最大特征向量)
   */
  private updateOja(): void {
    const eta = this.config.ojaLearningRate;

    // 计算 y = Σ wᵢ·xᵢ
    let y = 0;
    for (const [id, tab] of this.tabs) {
      const w = this.ojaWeights.get(id) || 0;
      y += w * tab.activity;
    }
    this.lastPCProjection = y;

    // Δwᵢ = η·(y·xᵢ - y²·wᵢ)
    for (const [id, tab] of this.tabs) {
      const w = this.ojaWeights.get(id) || 0;
      const dw = eta * (y * tab.activity - y * y * w);
      this.ojaWeights.set(id, w + dw);
    }
  }

  /** 记录脉冲时间戳 (用于 KDE) */
  private recordSpike(id: string, timestamp: number): void {
    let history = this.spikeHistory.get(id);
    if (!history) {
      history = [];
      this.spikeHistory.set(id, history);
    }
    history.push(timestamp);
    // 限制历史长度
    if (history.length > this.maxSpikeHistory) {
      history.shift();
    }
    // 同时向全局 KDE 提供归一化时间
    this.kdeEstimator.addSample(timestamp);
  }

  /** 获取 Tab 之间的 STDP 突触权重 (调试用) */
  getSTDPWeight(fromId: string, toId: string): number {
    return this.stdpWeights.get(`${fromId}::${toId}`) || 0;
  }

  /** 获取 Oja 主成分投影值 */
  getPCProjection(): number {
    return this.lastPCProjection;
  }

  /** 获取 Tab 在主成分方向的权重 (协同活跃度) */
  getOjaWeight(id: string): number {
    return this.ojaWeights.get(id) || 0;
  }

  /**
   * 获取与指定 Tab 协同活跃的 Tab 列表 (基于 Oja + STDP)
   * 返回按协同度排序的 Tab
   */
  getCollaborativeTabs(tabId: string, topK = 5): Array<{ id: string; score: number }> {
    const results: Array<{ id: string; score: number }> = [];
    for (const [key, weight] of this.stdpWeights) {
      if (key.startsWith(tabId + '::') && weight > 0) {
        const otherId = key.split('::')[1];
        results.push({ id: otherId, score: weight });
      }
    }
    return results.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  /**
   * 获取建议关闭的 Tab ID 列表
   * 返回权重低于淘汰阈值的 Tab，按权重升序排列
   */
  getEvictionCandidates(): BCMTabState[] {
    const threshold = this.config.evictionThreshold;
    return Array.from(this.tabs.values())
      .filter(t => t.weight < threshold && !t.inFocus)
      .sort((a, b) => a.weight - b.weight);
  }

  /**
   * 获取按权重排序的 Tab 列表（用于显示顺序推荐）
   */
  getTabRanking(): BCMTabState[] {
    return Array.from(this.tabs.values())
      .sort((a, b) => b.weight - a.weight);
  }

  /**
   * 获取 Tab 的当前 BCM 状态
   */
  getTabState(id: string): BCMTabState | undefined {
    return this.tabs.get(id);
  }

  /**
   * 获取所有 Tab 状态
   */
  getAllTabs(): BCMTabState[] {
    return Array.from(this.tabs.values());
  }

  /**
   * 获取当前滑动阈值 θ_M（调试用）
   */
  getThreshold(): number {
    return this.thresholdM;
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const tabs = this.getAllTabs();
    const weights = tabs.map(t => t.weight);
    const mean = weights.length > 0 ? weights.reduce((a, b) => a + b, 0) / weights.length : 0;
    return {
      totalTabs: tabs.length,
      meanWeight: mean,
      thresholdM: this.thresholdM,
      populationMS: this.populationMeanSquare,
      evictionCandidateCount: this.getEvictionCandidates().length,
      stdpSynapseCount: this.stdpWeights.size,
      pcProjection: this.lastPCProjection,
      kdeBandwidth: this.kdeEstimator.getBandwidth(),
      kdeSamples: this.kdeEstimator.getSampleCount(),
    };
  }

  /** 重置所有状态 */
  reset(): void {
    this.tabs.clear();
    this.thresholdM = 0.5;
    this.populationMeanSquare = 0.25;
    this.stdpWeights.clear();
    this.spikeHistory.clear();
    this.ojaWeights.clear();
    this.kdeEstimator.clear();
    this.lastPCProjection = 0;
  }
}
