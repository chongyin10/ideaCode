/**
 * TokenBudget — Token 预算估算与管理
 *
 * 防止单次工具返回内容过大导致 LLM context window 溢出。
 * 估算为粗略值（不依赖 tokenizer 库），用于快速判断是否需要截断。
 *
 * 估算规则：
 * - 中文字符（含全角标点）：约 1 token/字
 * - 英文/ASCII：约 0.25 token/字符（4 字符 ≈ 1 token）
 * - 混合内容取加权平均
 */

const TokenBudget = {
  /**
   * 粗略估算字符串的 token 数
   * @param {string} text
   * @returns {number}
   */
  estimateTokens(text) {
    if (!text) return 0;
    let cjk = 0;
    let ascii = 0;
    let other = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0x4e00 && code <= 0x9fff) {
        cjk++;
      } else if (code >= 0x3000 && code <= 0x30ff) {
        cjk++; // 日文假名/中文标点
      } else if (code < 128) {
        ascii++;
      } else {
        other++;
      }
    }
    // CJK 约 1 token/字，ASCII 约 0.25 token/字符，其他约 0.5 token/字符
    return Math.ceil(cjk + ascii * 0.25 + other * 0.5);
  },

  /**
   * 检查内容是否超出 token 预算，如超出则截断
   * @param {string} content - 原始内容
   * @param {number} maxTokens - 最大允许 token 数
   * @returns {{content: string, truncated: boolean, estimatedTokens: number}}
   */
  checkAndTruncate(content, maxTokens) {
    const estimated = this.estimateTokens(content);
    if (estimated <= maxTokens) {
      return { content, truncated: false, estimatedTokens: estimated };
    }

    // 按比例截断（粗略）
    const ratio = maxTokens / estimated;
    const cutChars = Math.floor(content.length * ratio * 0.95); // 留 5% 余量
    const truncated = content.substring(0, cutChars);

    // 尽量在行尾截断，避免半行
    const lastNewline = truncated.lastIndexOf('\n');
    const safeContent = lastNewline > cutChars * 0.8
      ? truncated.substring(0, lastNewline)
      : truncated;

    return {
      content: safeContent + '\n\n…（内容超出 token 预算，已截断）…',
      truncated: true,
      estimatedTokens: this.estimateTokens(safeContent),
    };
  },

  /**
   * 获取当前 context window 下的安全工具返回 token 上限
   * 预留空间给系统提示 + 对话历史 + LLM 响应
   * @param {object} context - Agent context（含 getContextWindow 方法）
   * @returns {number}
   */
  getSafeReturnLimit(context) {
    let contextWindow = 32000; // 默认假设 32K
    try {
      if (context && typeof context.getContextWindow === 'function') {
        contextWindow = context.getContextWindow() || contextWindow;
      }
    } catch { /* 使用默认值 */ }
    // 预留 60% 给历史 + 系统提示 + 响应，工具返回最多占 40%
    // 但不超过 30K tokens（防止极端大 context 模型）
    return Math.min(30000, Math.floor(contextWindow * 0.4));
  },
};

module.exports = TokenBudget;
