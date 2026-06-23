/**
 * Monaco Editor 桥接层
 *
 * 职责：
 * - 提供全局的 Monaco Editor 实例引用，供 PluginSystem 和 AI 扩展访问
 * - 封装编辑器操作（setValue、insertText、gotoLine）
 * - 与 Redux 状态同步写入
 *
 * 设计原则：
 * - 只暴露有限的、安全的 API 给插件和 AI
 * - 所有写入操作同时更新 Redux store 和 Monaco buffer
 * - AI 编辑模式时，编辑器 readOnly 自动解除
 */

import type * as Monaco from 'monaco-editor';

export interface MonacoEditorActions {
  /** 获取编辑器实例 */
  getEditor: () => Monaco.editor.IStandaloneCodeEditor | null;
  /** 获取当前编辑器内容 */
  getValue: () => string;
  /** 设置编辑器全部内容 */
  setValue: (value: string) => void;
  /** 在光标位置插入文本 */
  insertText: (text: string) => void;
  /** 跳转到指定行 */
  gotoLine: (line: number, column?: number) => void;
  /** 替换范围文本 */
  replaceRange: (startLine: number, startCol: number, endLine: number, endCol: number, text: string) => void;
}

let instance: MonacoEditorActions | null = null;

/**
 * 注册编辑器实例到桥接层
 */
export function registerMonacoEditor(
  editor: Monaco.editor.IStandaloneCodeEditor,
  monaco: typeof Monaco
): MonacoEditorActions {
  const actions: MonacoEditorActions = {
    getEditor: () => editor,
    getValue: () => editor.getValue(),
    setValue: (value: string) => {
      editor.setValue(value);
      // 触发 onChange 使 Redux 同步
      const model = editor.getModel();
      if (model) {
        model.pushStackElement();
        // Monaco 的 onDidChangeModelContent 会自动触发
      }
    },
    insertText: (text: string) => {
      const model = editor.getModel();
      if (!model) return;

      const selections = editor.getSelections() || [];
      if (selections.length > 0) {
        editor.executeEdits('ai-insert', selections.map((sel) => ({
          range: sel,
          text,
          forceMoveMarkers: true,
        })));
        // 移动光标到插入文本末尾
        const pos = selections[0].getEndPosition();
        editor.setPosition(pos);
        editor.revealPositionInCenter(pos);
      } else {
        // 无选中时在当前光标位置插入
        const pos = editor.getPosition();
        if (pos) {
          const range = new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column);
          editor.executeEdits('ai-insert', [{ range, text, forceMoveMarkers: true }]);
          const lines = text.split('\n');
          const newLineNumber = pos.lineNumber + lines.length - 1;
          const newColumn = lines.length === 1
            ? pos.column + text.length
            : lines[lines.length - 1].length + 1;
          const newPos = new monaco.Position(newLineNumber, newColumn);
          editor.setPosition(newPos);
          editor.revealPositionInCenter(newPos);
        }
      }
    },
    gotoLine: (line: number, column: number = 1) => {
      const pos = { lineNumber: line, column };
      editor.setPosition(pos);
      editor.revealPositionInCenter(pos);
      editor.focus();
    },
    replaceRange: (startLine: number, startCol: number, endLine: number, endCol: number, text: string) => {
      const model = editor.getModel();
      if (!model) return;

      const range = new monaco.Range(startLine, startCol, endLine, endCol);
      editor.executeEdits('ai-replace', [{ range, text, forceMoveMarkers: true }]);
    },
  };

  instance = actions;
  return actions;
}

/**
 * 注销编辑器实例
 */
export function unregisterMonacoEditor() {
  instance = null;
}

/**
 * 获取编辑器操作接口
 */
export function getMonacoEditorActions(): MonacoEditorActions | null {
  return instance;
}
