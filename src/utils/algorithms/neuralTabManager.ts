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
 *
 * ## 实现优势
 *
 * 1. 自适应阈值：无需硬编码 Tab 数量上限
 * 2. 自动平衡：权重收敛到使用模式
 * 3. 稳定选择：一个 Tab 过度活跃不会垄断，因为有 LTD
 * 4. 优雅遗忘：不活跃的 Tab 权重逐渐降低到零
 */

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
}

const DEFAULT_CONFIG: Required<BCMConfig> = {
  learningRate: 0.05,
  decayRate: 0.001,
  thresholdTau: 0.9,
  activityAlpha: 0.85,
  evictionThreshold: 0.15,
  softMaxTabs: 15,
};

export class BCMTabManager {
  private tabs = new Map<string, BCMTabState>();
  private config: Required<BCMConfig>;
  /** 滑动阈值 θ_M */
  private thresholdM = 0.5;
  /** 所有 Tab 的历史均方活动（计算阈值用） */
  private populationMeanSquare = 0.25;

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
    };
    this.tabs.set(id, state);
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
    this.updateWeights();
  }

  /**
   * 关闭 Tab（从 BCM 管理器中移除）
   */
  closeTab(id: string): void {
    this.tabs.delete(id);
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
      // 给最低权重的 Tab 额外衰减
      const sorted = Array.from(this.tabs.values())
        .filter(t => !t.inFocus)
        .sort((a, b) => a.weight - b.weight);

      for (let i = 0; i < Math.min(excess, sorted.length); i++) {
        sorted[i].weight *= 0.8;
      }
    }

    this.thresholdM = theta;
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
    };
  }

  /** 重置所有状态 */
  reset(): void {
    this.tabs.clear();
    this.thresholdM = 0.5;
    this.populationMeanSquare = 0.25;
  }
}
