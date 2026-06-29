/**
 * 建议生成器
 *
 * 职责：
 * - 将 LLM 响应解析为结构化建议
 * - 管理建议的生命周期（生成 → 预览 → 接受 → 拒绝）
 * - 生成 diff 格式的变更描述，供 DiffEditor 展示
 *
 * 原则：
 * - 所有建议在被用户确认前，绝不写入文件
 * - 建议以 diff / 代码片段形式存在，用户确认后才执行写操作
 */

class SuggestionGenerator {
  constructor() {
    this.suggestions = new Map();
  }

  /**
   * 解析 LLM 响应，提取代码建议
   */
  parseSuggestions(llmResponse, context) {
    const suggestions = [];
    // 只识别明确的 ```suggestion 代码块，普通解释性回复不再包装成建议
    const blocks = this._extractSuggestionBlocks(llmResponse);

    for (const block of blocks) {
      const suggestion = this._buildSuggestion(block, context);
      if (suggestion) {
        suggestions.push(suggestion);
      }
    }

    return suggestions;
  }

  /**
   * §需求：上下文中的「最近读取文件」列表，用于在 LLM 输出的 suggestion 块
   * 缺少 `// 文件名:` 时自动推断 filePath，避免出现无法定位文件的卡片。
   *
   * 来源优先级（从高到低）：
   * 1. context.recentReadFiles —— toolExecutor 跟踪的 Agent 读取类工具历史（最近 10 个）
   * 2. context.activeFile.filePath —— IDE 当前打开的文件（普通 LLM 模式下的 fallback）
   * 3. context.relatedFiles[*].filePath —— IDE 上下文中的相关文件
   *
   * 语义：返回数组第一个元素 = 最近一次读取的文件路径。
   */
  _getRecentReadFiles(context) {
    if (!context) return [];
    const seen = new Set();
    const out = [];
    const push = (p) => {
      if (typeof p !== 'string' || !p) return;
      if (seen.has(p)) return;
      seen.add(p);
      out.push(p);
    };
    if (Array.isArray(context.recentReadFiles)) {
      for (const p of context.recentReadFiles) push(p);
    }
    if (context.activeFile && context.activeFile.filePath) push(context.activeFile.filePath);
    if (Array.isArray(context.relatedFiles)) {
      for (const f of context.relatedFiles) {
        if (f && f.filePath) push(f.filePath);
      }
    }
    return out;
  }

  /**
   * 创建新的建议
   */
  createSuggestion(params) {
    const id = `suggestion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const suggestion = {
      id,
      type: params.type || 'refactor',
      title: params.title || '代码建议',
      description: params.description || '',
      changes: params.changes || [],
      status: 'pending',
      createdAt: Date.now(),
    };
    this.suggestions.set(id, suggestion);
    return suggestion;
  }

  getSuggestion(id) {
    return this.suggestions.get(id) || null;
  }

  getPendingSuggestions() {
    return Array.from(this.suggestions.values()).filter((s) => s.status === 'pending');
  }

  acceptSuggestion(id) {
    const suggestion = this.suggestions.get(id);
    if (suggestion && suggestion.status === 'pending') {
      suggestion.status = 'accepted';
      return suggestion;
    }
    return null;
  }

  rejectSuggestion(id) {
    const suggestion = this.suggestions.get(id);
    if (suggestion && suggestion.status === 'pending') {
      suggestion.status = 'rejected';
      return suggestion;
    }
    return null;
  }

  markApplied(id) {
    const suggestion = this.suggestions.get(id);
    if (suggestion) {
      suggestion.status = 'applied';
    }
  }

  /**
   * 从 LLM 响应中提取 suggestion 代码块
   */
  _extractSuggestionBlocks(text) {
    const blocks = [];
    const regex = /```suggestion\s*\n([\s\S]*?)```/g;
    let match;

    while ((match = regex.exec(text)) !== null) {
      blocks.push(match[1].trim());
    }

    return blocks;
  }

  /**
   * LLM 自由发挥的 type 字符串 → 合法枚举的归一化映射
   */
  _normalizeType(rawType) {
    const t = String(rawType || '').toLowerCase().trim();
    // 直接命中 5 个合法值之一
    if (['refactor', 'bugfix', 'feature', 'optimization', 'explanation'].includes(t)) {
      return t;
    }
    // 关键字匹配（兼容中英文）
    const map = [
      { keys: ['refactor', '重构', 'cleanup', 'clean', 'tidy', '清理', '整理', 'clean up', 'clean-up'], value: 'refactor' },
      { keys: ['bugfix', 'bug', 'fix', 'repair', 'patch', '修复', '改正', '修 bug', '修bug'], value: 'bugfix' },
      { keys: ['feature', 'feat', 'add', 'new', 'implement', '功能', '新增', '实现', '添加'], value: 'feature' },
      { keys: ['optimization', 'optimize', 'perf', 'performance', 'speed', 'fast', '优化', '性能', '提速', '加速'], value: 'optimization' },
      { keys: ['explanation', 'explain', 'doc', 'comment', 'describe', '解释', '说明', '文档', '注释', '备注'], value: 'explanation' },
    ];
    for (const { keys, value } of map) {
      if (keys.some((k) => t.includes(k))) return value;
    }
    return 'refactor'; // 默认回退
  }

  /**
   * 从代码块构建结构化建议
   */
  _buildSuggestion(block, context) {
    const lines = block.split('\n');
    const changes = [];
    let title = '代码建议';
    let rawType = '';
    let type = 'refactor';
    let description = '';
    let currentFile = context?.activeFile?.filePath || '';
    let currentExplanation = '';
    let originalLines = [];
    let modifiedLines = [];
    let inDiff = false;

    for (const line of lines) {
      const fileMatch = line.match(/\/\/\s*文件(?:名)?:\s*(.+)/);
      if (fileMatch) {
        currentFile = fileMatch[1].trim();
        continue;
      }

      const typeMatch = line.match(/\/\/\s*类型:\s*(.+)/);
      if (typeMatch) {
        rawType = typeMatch[1].trim();
        type = this._normalizeType(rawType);
        continue;
      }

      if (line.startsWith('// ')) {
        const text = line.slice(3).trim();
        currentExplanation += text + '\n';
        if (title === '代码建议') title = text;
        continue;
      }

      if (line.startsWith('- ') && !line.startsWith('---')) {
        if (!inDiff) { inDiff = true; originalLines = []; modifiedLines = []; }
        originalLines.push(line.slice(2));
      } else if (line.startsWith('+ ') && !line.startsWith('+++')) {
        if (!inDiff) { inDiff = true; originalLines = []; modifiedLines = []; }
        modifiedLines.push(line.slice(2));
      } else if (line.trim() && !line.startsWith('```')) {
        description += line + '\n';
        if (inDiff && originalLines.length + modifiedLines.length > 0) {
          changes.push({
            filePath: currentFile,
            original: originalLines.join('\n'),
            modified: modifiedLines.length > 0 ? modifiedLines.join('\n') : originalLines.join('\n'),
            explanation: currentExplanation.trim(),
            startLine: 0,
            endLine: 0,
          });
          originalLines = [];
          modifiedLines = [];
          inDiff = false;
          currentExplanation = '';
        }
      }
    }

    if (inDiff && (originalLines.length > 0 || modifiedLines.length > 0)) {
      changes.push({
        filePath: currentFile,
        original: originalLines.join('\n'),
        modified: modifiedLines.length > 0 ? modifiedLines.join('\n') : originalLines.join('\n'),
        explanation: currentExplanation.trim(),
        startLine: 0,
        endLine: 0,
      });
    }

    // §需求：当 LLM 经历了「读取文件 -> 变更文件」的流程，但 suggestion 块
    // 没有明确指定 `// 文件名:` 或未生成 diff 行时，自动从上下文推断 filePath，
    // 避免出现无法定位到具体文件的 SuggestionCard。
    const recentReadFiles = this._getRecentReadFiles(context);
    const fallbackFile = recentReadFiles[0] || '';
    if (fallbackFile) {
      for (const c of changes) {
        if (!c.filePath) c.filePath = fallbackFile;
      }
    }

    // §需求：description-only 场景——LLM 输出里只有说明性文本（包含 JSON 代码片段），
    // 未生成任何 diff 变更行。自动拼接一个 change，让前端可以渲染出定位到
    // 最近读取文件的 SuggestionCard。original=空 + modified=description，
    // DiffView 会按全新增处理，用户在卡片中能看到对应的文件路径。
    if (changes.length === 0 && description.trim() && fallbackFile) {
      const descText = description.trim();
      changes.push({
        filePath: fallbackFile,
        original: '',
        modified: descText,
        explanation: (title && title !== '代码建议') ? title : descText.slice(0, 80),
        startLine: 0,
        endLine: 0,
      });
      // 已合并到 change，避免重复展示
      description = '';
    }

    if (changes.length === 0 && !description) return null;

    return this.createSuggestion({ type, title, description: description.trim(), changes });
  }

  _createExplanationSuggestion(text, context) {
    return this.createSuggestion({
      type: 'explanation',
      title: 'AI 分析结果',
      description: text.trim(),
      changes: [],
    });
  }

  getDiffData(suggestion) {
    return suggestion.changes.map((change) => ({
      filePath: change.filePath,
      original: change.original,
      modified: change.modified,
    }));
  }
}

module.exports = { SuggestionGenerator };
