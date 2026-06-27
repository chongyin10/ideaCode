/**
 * Planner
 *
 * 简单任务规划器：
 * - 对于简单查询（如"解释这段代码"），直接返回空计划，让 LLM 自行决定。
 * - 对于明确的多步任务（"重构 + 跑测试 + 检查"），让 LLM 先输出计划步骤。
 * - 不再因为 "run / execute / build / search" 等高频词触发 planning（之前会误判几乎所有任务）
 */

class Planner {
  /**
   * 判断用户输入是否需要多步骤规划
   * 收紧到真正的"多步 + 范围"信号
   */
  needsPlanning(userInput) {
    if (!userInput) return false;
    const lower = userInput.toLowerCase();
    // 真正的多步/批量信号
    // Bug 18: 原来的 /所有/ /全部/ 是裸子串匹配，会把"显示所有文件""列出全部用户"
    // 这类简单查询误判为需要多步规划，触发不必要的 LLM 计划生成。
    // 收紧为"动作动词 + 所有/全部"的组合，确保是真正的批量操作信号。
    const complexPatterns = [
      /重构.*并.*测试/,
      /批量/,
      /(修改|替换|删除|重命名|更新|检查|审查|处理|遍历).*(所有|全部)/,
      /(所有|全部).*(文件|函数|类|变量|引用|用法)/,
      /refactor.*and/,
      /migrate/,
      /迁移/,
      /替换.*为/,
      /从\s*\d+.*升级/,
      /\d+\s*步/,
    ];
    if (complexPatterns.some((p) => p.test(userInput))) return true;

    // 中文多动词链："并"、"然后"、"接着"、"先...再..." 暗示多步
    if (/(然后|接着|再|并[且且]?)/.test(userInput) && /(查找|读取|执行|搜索|修改|重构|build|run|test)/.test(lower)) {
      return true;
    }
    return false;
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
   * 解析 LLM 返回的计划 JSON（鲁棒版）
   * - 优先尝试整体 JSON.parse
   * - 回退：找第一个 [ 到最后一个 ] 之间的内容
   * - 再回退：Markdown code block
   */
  parsePlan(content) {
    if (!content || typeof content !== 'string') return [];

    // 1) 整体 JSON
    try {
      const plan = JSON.parse(content);
      if (Array.isArray(plan)) return this._validatePlan(plan);
    } catch { /* ignore */ }

    // 2) Markdown ```json ... ```
    const mdMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (mdMatch) {
      try {
        const plan = JSON.parse(mdMatch[1]);
        if (Array.isArray(plan)) return this._validatePlan(plan);
      } catch { /* ignore */ }
    }

    // 3) 找第一个 [ 到最后一个 ] 之间的内容
    const firstBracket = content.indexOf('[');
    const lastBracket = content.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
      const slice = content.slice(firstBracket, lastBracket + 1);
      try {
        const plan = JSON.parse(slice);
        if (Array.isArray(plan)) return this._validatePlan(plan);
      } catch { /* ignore */ }
    }

    return [];
  }

  /**
   * 校验每个 step 的最小结构，丢弃异常项
   */
  _validatePlan(plan) {
    return plan.filter((step) => {
      return step && typeof step === 'object' && typeof step.tool === 'string';
    }).map((step) => ({
      step: Number(step.step) || 0,
      tool: step.tool,
      args: step.args && typeof step.args === 'object' ? step.args : {},
      reason: step.reason || '',
    }));
  }
}

module.exports = { Planner };
