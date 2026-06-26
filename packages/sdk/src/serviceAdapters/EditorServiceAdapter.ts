/**
 * 编辑器服务适配器
 *
 * 处理扩展对编辑器状态的访问（激活文件、编辑器内容等）。
 * 替代原 ExtensionBridge 中的 editor.* RPC handlers。
 */

import type { IServiceBus } from '@ideacode/kernel';
import type { ServiceAdapter } from './ServiceAdapter.js';

export interface EditorStateProvider {
  getActiveFileSource(): string | null;
  getOpenedFiles(): Array<{
    id: string; name: string; source: string | { toString(): string };
    language?: string; isDirty?: boolean; content?: string;
  }>;
  getActiveFileId(): string | null;
  getRootSource(): string | null;
}

export interface MonacoActions {
  setValue(text: string): void;
  insertText(text: string): void;
  replaceRange(sl: number, sc: number, el: number, ec: number, text: string): void;
  getEditor(): unknown;
}

export class EditorServiceAdapter implements ServiceAdapter {
  readonly id = 'editorService';

  private editorState: EditorStateProvider | null = null;
  private aiEditMode = false;
  private setAiEditModeFn: ((enabled: boolean) => void) | null = null;
  private monacoActions: MonacoActions | null = null;

  setEditorState(state: EditorStateProvider): void {
    this.editorState = state;
  }

  setMonacoActions(actions: MonacoActions): void {
    this.monacoActions = actions;
  }

  setAiEditMode(mode: boolean, setter?: (enabled: boolean) => void): void {
    this.aiEditMode = mode;
    if (setter) this.setAiEditModeFn = setter;
  }

  register(bus: IServiceBus): void {
    // 获取激活编辑器
    bus.handle('editor.getActive', () => {
      const state = this.editorState;
      if (!state) return null;

      const files = state.getOpenedFiles();
      const activeId = state.getActiveFileId();
      const file = files.find((f) => f.id === activeId);
      if (!file) return null;

      const source = typeof file.source === 'string' ? file.source : String(file.source);
      return {
        document: {
          uri: { fsPath: source, scheme: 'file' },
          fileName: file.name,
          languageId: file.language || 'plaintext',
          version: 1,
          isDirty: file.isDirty || false,
          isUntitled: false,
          content: file.content || '',
        },
        selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      };
    });

    // 获取所有可见编辑器
    bus.handle('editor.getVisible', () => {
      const state = this.editorState;
      if (!state) return [];
      return state.getOpenedFiles().map((file) => {
        const source = typeof file.source === 'string' ? file.source : String(file.source);
        return {
          document: {
            uri: { fsPath: source, scheme: 'file' },
            fileName: file.name,
            languageId: file.language || 'plaintext',
            version: 1,
            isDirty: file.isDirty || false,
            isUntitled: false,
            content: file.content || '',
          },
          selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        };
      });
    });

    // AI 编辑：直接编辑代码
    bus.handle('lifeAiCode.editCode', async (params) => {
      const { action, text, startLine, startCol, endLine, endCol } = params as {
        action: 'setValue' | 'insertText' | 'replaceRange';
        text: string;
        startLine?: number;
        startCol?: number;
        endLine?: number;
        endCol?: number;
      };

      if (!this.aiEditMode) {
        return { success: false, error: 'AI 编辑模式未开启' };
      }

      const actions = this.monacoActions;
      if (!actions) {
        return { success: false, error: '没有活动的编辑器实例' };
      }

      try {
        switch (action) {
          case 'setValue':
            actions.setValue(text);
            break;
          case 'insertText':
            actions.insertText(text);
            break;
          case 'replaceRange':
            if (startLine == null || endLine == null) {
              return { success: false, error: 'replaceRange 需要 startLine/endLine' };
            }
            actions.replaceRange(startLine, startCol || 1, endLine, endCol || 1, text);
            break;
          default:
            return { success: false, error: `未知操作: ${action}` };
        }
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    });

    // AI 编辑模式切换
    bus.handle('lifeAiCode.toggleEditMode', async () => {
      const newMode = !this.aiEditMode;
      this.aiEditMode = newMode;
      this.setAiEditModeFn?.(newMode);
      return { enabled: newMode };
    });

    console.log('[EditorServiceAdapter] 已注册处理器');
  }
}
