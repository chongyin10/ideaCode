import Editor from '@monaco-editor/react';
import { useRef, useEffect, useCallback } from 'react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { clearSearchHighlight } from '../../store/slices/workspaceSlice';
import type { SearchHighlight, EditorSnapshot } from '../../store/slices/workspaceSlice';
import './MonacoEditor.css';

const Loading = () => (
  <div className="monaco-loading">
    <div className="monaco-loading__spinner" />
    <span className="monaco-loading__text">正在加载编辑器...</span>
  </div>
);

interface MonacoEditorProps {
  value: string;
  language: string;
  onChange?: (value: string) => void;
  /** 恢复光标/滚动位快照 */
  snapshot?: EditorSnapshot;
  /** 保存光标/滚动位快照 */
  onSnapshot?: (snapshot: EditorSnapshot) => void;
  /** 面板是否聚焦，非聚焦时降低渲染开销 */
  focused?: boolean;
}

const MonacoEditor = ({ value, language, onChange, snapshot, onSnapshot, focused = true }: MonacoEditorProps) => {
  const dispatch = useAppDispatch();
  const searchHighlight = useAppSelector((state) => state.workspace.searchHighlight);

  const editorRef = useRef<Parameters<Parameters<typeof Editor>[0]['onMount']>[0] | null>(null);
  const monacoRef = useRef<Parameters<Parameters<typeof Editor>[0]['onMount']>[1] | null>(null);
  const decorationsRef = useRef<string[]>([]);
  const pendingRef = useRef<SearchHighlight | null>(null);
  const snapshotAppliedRef = useRef(false);

  // 用 ref 存 onSnapshot，避免 effect deps 中函数引用变化导致无限循环
  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;

  // 当 value 或 snapshot 变化时重置标记（处理不 remount 的 prop 更新）
  useEffect(() => {
    snapshotAppliedRef.current = false;
  }, [value, snapshot]);

  // 组件卸载时保存编辑器状态快照（仅真正卸载时触发）
  useEffect(() => {
    return () => {
      const snap = onSnapshotRef.current;
      if (editorRef.current && snap) {
        try {
          const pos = editorRef.current.getPosition();
          const scroll = editorRef.current.getScrollTop();
          if (pos) {
            snap({ cursor: { line: pos.lineNumber, column: pos.column }, scrollTop: scroll });
          }
        } catch { /* 忽略 */ }
      }
    };
  }, []);

  const applyHighlight = useCallback(
    (editor: typeof editorRef.current, monaco: typeof monacoRef.current, hl: SearchHighlight) => {
      if (!editor || !monaco) return;
      const { keyword, line, column } = hl;

      if (line > 0) {
        editor.setPosition({ lineNumber: line, column: Math.max(1, column) });
        editor.revealLineInCenter(line);
      }

      const model = editor.getModel();
      if (model && keyword) {
        if (decorationsRef.current.length > 0) {
          editor.deltaDecorations(decorationsRef.current, []);
        }

        const matches = model.findMatches(keyword, false, false, false, null, true);

        const newDecorations = matches.map((m) => ({
          range: m.range,
          options: {
            inlineClassName: 'search-highlight-match',
            overviewRuler: {
              color: '#ea5c1b',
              position: monaco.editor.OverviewRulerLane.Center,
            },
            minimap: {
              color: '#ea5c1b',
              position: monaco.editor.MinimapPosition.Inline,
            },
          },
        }));

        decorationsRef.current = editor.deltaDecorations([], newDecorations);
      }

      dispatch(clearSearchHighlight());
    },
    [dispatch]
  );

  useEffect(() => {
    if (!searchHighlight) return;
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) {
      pendingRef.current = searchHighlight;
      return;
    }
    applyHighlight(editor, monaco, searchHighlight);
  }, [searchHighlight, applyHighlight]);

  return (
    <Editor
      height="100%"
      width="100%"
      language={language}
      value={value}
      onChange={(v) => onChange?.(v || '')}
      theme="vs-dark"
      loading={<Loading />}
      onMount={(editor, monaco) => {
        editorRef.current = editor;
        monacoRef.current = monaco;
        requestAnimationFrame(() => editor.layout());

        // 恢复光标/滚动位快照
        if (snapshot && !snapshotAppliedRef.current) {
          snapshotAppliedRef.current = true;
          requestAnimationFrame(() => {
            try {
              editor.setPosition({
                lineNumber: snapshot.cursor.line,
                column: snapshot.cursor.column,
              });
              editor.setScrollTop(snapshot.scrollTop);
            } catch { /* 忽略位置越界 */ }
          });
        }

        const pending = pendingRef.current;
        if (pending) {
          pendingRef.current = null;
          applyHighlight(editor, monaco, pending);
        }
      }}
      options={{
        minimap: { enabled: focused, showSlider: 'always' },
        fontSize: 14,
        wordWrap: 'on',
        automaticLayout: true,
        scrollBeyondLastLine: false,
        smoothScrolling: focused,
        renderWhitespace: focused ? 'selection' : 'none',
        renderLineHighlight: focused ? 'all' : 'none',
        matchBrackets: focused ? 'always' : 'never',
        occurrencesHighlight: focused ? 'singleFile' : 'off',
      }}
    />
  );
};

export default MonacoEditor;
