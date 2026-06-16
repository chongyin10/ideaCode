/**
 * TerminalInlineEditor — 终端内联 Monaco 编辑器
 * 
 * 在终端中按特定快捷键 (Ctrl+Shift+E) 弹出内联 Monaco 编辑框，
 * 用于编辑多行命令、粘贴并编辑长脚本。
 * 
 * 功能：
 * 1. 弹出半透明覆盖层，包含 Monaco 编辑器
 * 2. Ctrl+Enter 执行编辑器中的命令并关闭
 * 3. Esc 取消
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';

interface TerminalInlineEditorProps {
  visible: boolean;
  onExecute: (command: string) => void;
  onClose: () => void;
  /** 初始内容 */
  initialValue?: string;
}

const TerminalInlineEditor: React.FC<TerminalInlineEditorProps> = ({
  visible,
  onExecute,
  onClose,
  initialValue = '',
}) => {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (visible) {
      setValue(initialValue);
      setTimeout(() => editorRef.current?.focus(), 100);
    }
  }, [visible, initialValue]);

  const handleMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
    editor.focus();

    // Ctrl+Enter 执行
    editor.addAction({
      id: 'execute-command',
      label: '执行命令',
      keybindings: [2048 | 3], // Ctrl+Enter on all platforms
      run: () => {
        const cmd = editor.getValue().trim();
        if (cmd) {
          onExecute(cmd);
          onClose();
        }
      },
    });

    // Esc 关闭
    editor.addAction({
      id: 'close-inline-editor',
      label: '关闭',
      keybindings: [9], // Escape
      run: () => onClose(),
    });
  }, [onExecute, onClose]);

  if (!visible) return null;

  return (
    <div
      style={{
        position: 'absolute',
        top: 0, left: 0, right: 0, bottom: 0,
        zIndex: 100,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backdropFilter: 'blur(2px)',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: '80%',
          maxWidth: 800,
          height: '60%',
          maxHeight: 400,
          background: '#1e1e1e',
          borderRadius: 6,
          overflow: 'hidden',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* 标题栏 */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '4px 8px', background: '#252526',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          fontSize: 11, color: '#858585',
        }}>
          <span>命令编辑器 (Ctrl+Enter 执行, Esc 取消)</span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              onClick={() => {
                const cmd = editorRef.current?.getValue()?.trim();
                if (cmd) { onExecute(cmd); onClose(); }
              }}
              style={{
                padding: '2px 8px', fontSize: 11, border: 'none',
                background: '#0e639c', color: '#fff', borderRadius: 3, cursor: 'pointer',
              }}
            >
              执行
            </button>
            <button
              onClick={onClose}
              style={{
                padding: '2px 8px', fontSize: 11, border: 'none',
                background: 'transparent', color: '#858585', borderRadius: 3, cursor: 'pointer',
              }}
            >
              取消
            </button>
          </div>
        </div>

        {/* Monaco 编辑器 */}
        <div style={{ flex: 1, minHeight: 0 }}>
          <Editor
            height="100%"
            language="shell"
            theme="vs-dark"
            value={value}
            onChange={(v) => setValue(v || '')}
            onMount={handleMount}
            options={{
              fontSize: 13,
              lineNumbers: 'on',
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              padding: { top: 8 },
              suggest: { showWords: true },
              renderWhitespace: 'none',
            }}
          />
        </div>
      </div>
    </div>
  );
};

export default TerminalInlineEditor;
