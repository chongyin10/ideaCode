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
   * 从代码块构建结构化建议
   */
  _buildSuggestion(block, context) {
    const lines = block.split('\n');
    const changes = [];
    let title = '代码建议';
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
        type = typeMatch[1].trim().toLowerCase();
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
