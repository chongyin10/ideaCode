/**
 * 内联建议服务
 *
 * 职责：
 * - 在 Monaco Editor 中显示 AI 建议的内联装饰
 * - 支持建议的接受/拒绝交互
 * - 只读展示，不修改编辑器内容
 *
 * 核心设计原则：
 * - 所有建议都以 decorations 形式展示，不修改 editor buffer
 * - 用户确认后才通过文件服务写入
 * - 与 Redux store 松耦合，通过回调通知
 */

import type * as Monaco from 'monaco-editor';

export interface InlineSuggestion {
  id: string;
  /** 起始行号（1-indexed） */
  startLine: number;
  /** 结束行号（1-indexed） */
  endLine: number;
  /** 原始文本 */
  originalText: string;
  /** 建议的修改文本 */
  modifiedText: string;
  /** 建议标题 */
  title: string;
  /** 建议类型 */
  type: 'refactor' | 'bugfix' | 'feature' | 'optimization';
}

export interface InlineSuggestionActions {
  onAccept: (suggestionId: string) => void;
  onReject: (suggestionId: string) => void;
}

const DECORATION_KEY = 'inline-suggestion';

/**
 * 内联建议管理器
 * 每个编辑器实例对应一个管理器
 */
export class InlineSuggestionManager {
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  private monaco: typeof Monaco | null = null;
  private suggestions: Map<string, InlineSuggestion> = new Map();
  private activeSuggestionId: string | null = null;
  private actions: InlineSuggestionActions | null = null;
  private decorations: string[] = [];

  /**
   * 绑定到 Monaco 编辑器
   */
  bind(editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) {
    this.editor = editor;
    this.monaco = monaco;
  }

  /**
   * 解绑
   */
  unbind() {
    this.clearAll();
    this.editor = null;
    this.monaco = null;
  }

  /**
   * 设置回调
   */
  setActions(actions: InlineSuggestionActions) {
    this.actions = actions;
  }

  /**
   * 添加内联建议
   */
  addSuggestion(suggestion: InlineSuggestion): boolean {
    if (!this.editor || !this.monaco) return false;

    this.suggestions.set(suggestion.id, suggestion);
    this.activeSuggestionId = suggestion.id;
    this._renderDecorations();
    return true;
  }

  /**
   * 批量添加建议
   */
  addSuggestions(suggestions: InlineSuggestion[]): void {
    for (const s of suggestions) {
      this.suggestions.set(s.id, s);
    }
    if (suggestions.length > 0) {
      this.activeSuggestionId = suggestions[0].id;
    }
    this._renderDecorations();
  }

  /**
   * 移除建议
   */
  removeSuggestion(id: string): void {
    this.suggestions.delete(id);
    if (this.activeSuggestionId === id) {
      this.activeSuggestionId = this.suggestions.keys().next().value || null;
    }
    this._renderDecorations();
  }

  /**
   * 清空所有建议
   */
  clearAll(): void {
    this.suggestions.clear();
    this.activeSuggestionId = null;
    if (this.editor) {
      this.editor.removeDecorations([DECORATION_KEY]);
    }
    this.decorations = [];
  }

  /**
   * 切换到下一个建议
   */
  nextSuggestion(): void {
    const ids = Array.from(this.suggestions.keys());
    if (ids.length === 0) return;
    const idx = ids.indexOf(this.activeSuggestionId || '');
    this.activeSuggestionId = ids[(idx + 1) % ids.length];
    this._renderDecorations();
  }

  /**
   * 切换到上一个建议
   */
  prevSuggestion(): void {
    const ids = Array.from(this.suggestions.keys());
    if (ids.length === 0) return;
    const idx = ids.indexOf(this.activeSuggestionId || '');
    this.activeSuggestionId = ids[(idx - 1 + ids.length) % ids.length];
    this._renderDecorations();
  }

  /**
   * 接受当前建议
   */
  acceptCurrent(): void {
    if (!this.activeSuggestionId) return;
    if (this.actions) {
      this.actions.onAccept(this.activeSuggestionId);
    }
    this.removeSuggestion(this.activeSuggestionId);
  }

  /**
   * 拒绝当前建议
   */
  rejectCurrent(): void {
    if (!this.activeSuggestionId) return;
    if (this.actions) {
      this.actions.onReject(this.activeSuggestionId);
    }
    this.removeSuggestion(this.activeSuggestionId);
  }

  /**
   * 渲染装饰
   */
  private _renderDecorations(): void {
    if (!this.editor || !this.monaco) return;

    const newDecorations: Monaco.editor.IModelDeltaDecoration[] = [];

    for (const [id, suggestion] of this.suggestions) {
      const isActive = id === this.activeSuggestionId;

      // 设置行号区域的高亮
      newDecorations.push({
        range: new this.monaco.Range(
          suggestion.startLine,
          1,
          suggestion.endLine,
          1
        ),
        options: {
          isWholeLine: true,
          className: isActive
            ? 'inline-suggestion-line inline-suggestion-line--active'
            : 'inline-suggestion-line',
          glyphMarginClassName: isActive
            ? 'inline-suggestion-glyph inline-suggestion-glyph--active'
            : 'inline-suggestion-glyph',
          stickiness: this.monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });

      // 如果是激活的建议，添加标题提示
      if (isActive) {
        newDecorations.push({
          range: new this.monaco.Range(
            suggestion.startLine,
            1,
            suggestion.startLine,
            1
          ),
          options: {
            isWholeLine: false,
            beforeContentClassName: 'inline-suggestion-before',
            before: {
              content: ` 💡 ${suggestion.title} (${suggestion.type}) `,
              inlineClassName: 'inline-suggestion-label',
            },
          },
        });
      }
    }

    this.decorations = this.editor.deltaDecorations(
      this.decorations.length > 0 ? this.decorations : [],
      newDecorations
    );
  }
}
