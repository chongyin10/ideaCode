/**
 * FM-index 全文索引 (Ferragina-Manzini Index)
 * ============================================================================
 *
 * ## 理论基础
 *
 * FM-index 基于 Burrows-Wheeler Transform (BWT) + 游程编码，
 * 在压缩态下支持 O(m) 模式搜索，无需解压。
 *
 * 空间: ~原文本 × H_k (k阶熵)，对高重复文本压缩率极高。
 *
 * ## 核心操作
 *
 * 1. BWT: 对文本所有循环移位排序，取最后一列
 * 2. LF-mapping: LF(i) = C[c] + Occ(c, i)
 *    - C[c] = 字典序中小于 c 的字符数
 *    - Occ(c, i) = BWT[0..i-1] 中 c 出现次数
 * 3. 反向搜索 (backward search):
 *    从模式末尾开始，用 LF-mapping 逐步缩小匹配区间 [sp, ep]
 *
 * ## 用于
 *
 * 终端输出滚动缓冲区的流式文本搜索。终端文本含大量 ANSI 转义序列，
 * 重复度高，BWT 压缩率极高。
 * ============================================================================
 */

export class FMIndex {
  private bwt: string;
  private cTable: Map<string, number>;
  private occTable: Map<string, Int32Array>; // Occ(c, i): 前 i 个位置中 c 的出现次数
  private textLength: number;

  constructor(text: string) {
    // 添加哨兵字符 (确保 BWT 可逆)
    const s = text + '\x00';
    this.textLength = s.length;

    // 构建 BWT
    const { bwt } = this.buildBWT(s);
    this.bwt = bwt;

    // 构建 C 表 (count table)
    this.cTable = this.buildCTable(bwt);

    // 构建 Occ 表 (rank table)
    this.occTable = this.buildOccTable(bwt);
  }

  /**
   * 反向搜索: 在 BWT 中查找模式 pattern
   * 返回匹配区间 [sp, ep]，匹配数 = ep - sp + 1
   */
  search(pattern: string): { count: number; sp: number; ep: number } {
    if (!pattern) return { count: this.textLength, sp: 0, ep: this.textLength - 1 };

    let sp = 0;
    let ep = this.textLength - 1;

    // 从模式末尾向前搜索
    for (let i = pattern.length - 1; i >= 0; i--) {
      const c = pattern[i];
      const cVal = this.cTable.get(c);

      if (cVal === undefined) {
        return { count: 0, sp: 0, ep: -1 };
      }

      // Occ(c, sp) 和 Occ(c, ep+1)
      const occSp = this.rank(c, sp);
      const occEp = this.rank(c, ep + 1);

      sp = cVal + occSp;
      ep = cVal + occEp - 1;

      if (sp > ep) {
        return { count: 0, sp: 0, ep: -1 };
      }
    }

    return { count: ep - sp + 1, sp, ep };
  }

  /** 判断是否包含模式 */
  contains(pattern: string): boolean {
    return this.search(pattern).count > 0;
  }

  /** 获取 BWT 字符串 (调试用) */
  getBWT(): string {
    return this.bwt;
  }

  // ── 私有方法 ──

  /** 构建 BWT: 对所有循环移位排序 */
  private buildBWT(s: string): { bwt: string; sentinelPos: number } {
    const n = s.length;
    // 构建后缀数组 (简化: 直接排序循环移位)
    const sa = new Array(n);
    for (let i = 0; i < n; i++) sa[i] = i;

    // 对小文本直接排序; 大文本应使用 SA-IS 算法
    sa.sort((a, b) => {
      for (let k = 0; k < n; k++) {
        const ca = s[(a + k) % n];
        const cb = s[(b + k) % n];
        if (ca < cb) return -1;
        if (ca > cb) return 1;
      }
      return 0;
    });

    // BWT[i] = s[(sa[i] - 1 + n) % n]
    const bwtChars: string[] = new Array(n);
    let sentinelPos = 0;
    for (let i = 0; i < n; i++) {
      const idx = (sa[i] - 1 + n) % n;
      bwtChars[i] = s[idx];
      if (sa[i] === 0) sentinelPos = i;
    }

    return { bwt: bwtChars.join(''), sentinelPos };
  }

  /** 构建 C 表: C[c] = 字典序中小于 c 的字符总数 */
  private buildCTable(bwt: string): Map<string, number> {
    const counts = new Map<string, number>();
    for (const ch of bwt) {
      counts.set(ch, (counts.get(ch) || 0) + 1);
    }

    // 排序字符
    const sorted = Array.from(counts.keys()).sort();
    const cTable = new Map<string, number>();
    let cumulative = 0;
    for (const ch of sorted) {
      cTable.set(ch, cumulative);
      cumulative += counts.get(ch)!;
    }
    return cTable;
  }

  /** 构建 Occ 表: Occ(c, i) = BWT[0..i-1] 中 c 的累计出现次数 */
  private buildOccTable(bwt: string): Map<string, Int32Array> {
    const chars = new Set(bwt);
    const occTable = new Map<string, Int32Array>();

    for (const c of chars) {
      const occ = new Int32Array(bwt.length + 1);
      let count = 0;
      occ[0] = 0;
      for (let i = 0; i < bwt.length; i++) {
        if (bwt[i] === c) count++;
        occ[i + 1] = count;
      }
      occTable.set(c, occ);
    }
    return occTable;
  }

  /** Rank 操作: BWT[0..pos-1] 中 c 的出现次数 */
  private rank(c: string, pos: number): number {
    const occ = this.occTable.get(c);
    if (!occ) return 0;
    if (pos < 0) return 0;
    if (pos >= occ.length) return occ[occ.length - 1];
    return occ[pos];
  }
}
