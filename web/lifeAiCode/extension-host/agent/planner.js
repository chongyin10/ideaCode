/**
 * Planner
 *
 * 简单任务规划器：
 * - 对于简单查询（如"解释这段代码"），直接返回空计划，让 LLM 自行决定。
 * - 对于复杂任务（如"重构项目"），让 LLM 先输出计划步骤。
 */

class Planner {
  /**
   * 判断用户输入是否需要多步骤规划
   */
  needsPlanning(userInput) {
    if (!userInput) return false;
    const planningKeywords = [
      '重构', '修改', '批量', '所有', '全部', '查找', '搜索', '替换',
      'refactor', 'modify', 'change all', 'replace', 'find all', 'search',
      'build', 'test', 'run', 'execute',
    ];
    const lower = userInput.toLowerCase();
    return planningKeywords.some((kw) => lower.includes(kw.toLowerCase()));
  }

  /**
   * 生成规划 prompt
   */
  buildPlanningPrompt(userInput, toolSchemas) {
    return `请为以下任务制定一个执行计划。任务："""${userInput}"""

可用工具：
${toolSchemas}

请输出 JSON 数组格式，每个元素包含 step、tool、args、reason 字段：
[
  { "step": 1, "tool": "search_files", "args": { "pattern": "..." }, "reason": "..." },
  { "step": 2, "tool": "read_file", "args": { "path": "..." }, "reason": "..." }
]

只输出 JSON 数组，不要输出其他内容。`;
  }

  /**
   * 解析 LLM 返回的计划 JSON
   */
  parsePlan(content) {
    if (!content) return [];
    try {
      // 尝试直接解析
      const plan = JSON.parse(content);
      if (Array.isArray(plan)) return plan;
    } catch {
      // 尝试从 Markdown 代码块中提取
      const match = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (match) {
        try {
          const plan = JSON.parse(match[1]);
          if (Array.isArray(plan)) return plan;
        } catch { /* ignore */ }
      }
    }
    return [];
  }
}

module.exports = { Planner };
