import Editor from '@monaco-editor/react';
import { useRef, useEffect, useCallback } from 'react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { clearSearchHighlight } from '../../store/slices/workspaceSlice';
import type { SearchHighlight } from '../../store/slices/workspaceSlice';
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
}

const MonacoEditor = ({ value, language, onChange }: MonacoEditorProps) => {
  const dispatch = useAppDispatch();
  const searchHighlight = useAppSelector((state) => state.workspace.searchHighlight);

  const editorRef = useRef<Parameters<Parameters<typeof Editor>[0]['onMount']>[0] | null>(null);
  const monacoRef = useRef<Parameters<Parameters<typeof Editor>[0]['onMount']>[1] | null>(null);
  const decorationsRef = useRef<string[]>([]);
  const pendingRef = useRef<SearchHighlight | null>(null);

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

  // 编辑器已就绪时响应 searchHighlight 变化（后续点击触发）
  useEffect(() => {
    if (!searchHighlight) return;
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) {
      // 编辑器尚未就绪，暂存待 onMount 后应用
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

        // onMount 时如有待处理的高亮，立即应用
        const pending = pendingRef.current;
        if (pending) {
          pendingRef.current = null;
          applyHighlight(editor, monaco, pending);
        }
      }}
      options={{
        minimap: { enabled: true, showSlider: 'always' },
        fontSize: 14,
        wordWrap: 'on',
        automaticLayout: true,
        scrollBeyondLastLine: false,
        smoothScrolling: true,
      }}
    />
  );
};

export default MonacoEditor;
