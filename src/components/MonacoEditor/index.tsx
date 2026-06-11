import Editor from '@monaco-editor/react';
import { useRef, useEffect, useCallback } from 'react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { clearSearchHighlight } from '../../store/slices/workspaceSlice';
import type { SearchHighlight, EditorSnapshot } from '../../store/slices/workspaceSlice';
import { tsService } from '../../services/tsLanguageService';
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
  snapshot?: EditorSnapshot;
  onSnapshot?: (snapshot: EditorSnapshot) => void;
  focused?: boolean;
  path?: string;
}

const MonacoEditor = ({ value, language, onChange, snapshot, onSnapshot, focused = true, path }: MonacoEditorProps) => {
  const dispatch = useAppDispatch();
  const searchHighlight = useAppSelector((state) => state.workspace.searchHighlight);

  const editorRef = useRef<Parameters<Parameters<typeof Editor>[0]['onMount']>[0] | null>(null);
  const monacoRef = useRef<Parameters<Parameters<typeof Editor>[0]['onMount']>[1] | null>(null);
  const decorationsRef = useRef<string[]>([]);
  const pendingRef = useRef<SearchHighlight | null>(null);
  const snapshotAppliedRef = useRef(false);
  const diagUnsubRef = useRef<(() => void) | null>(null);
  const changeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lspDisposablesRef = useRef<Array<{ dispose(): void }>>([]);

  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;

  useEffect(() => {
    snapshotAppliedRef.current = false;
  }, [value, snapshot]);

  // 卸载时保存快照 + 关闭 tsserver 文件
  useEffect(() => {
    return () => {
      const snap = onSnapshotRef.current;
      if (editorRef.current && snap) {
        try {
          const pos = editorRef.current.getPosition();
          const scroll = editorRef.current.getScrollTop();
          if (pos) snap({ cursor: { line: pos.lineNumber, column: pos.column }, scrollTop: scroll });
        } catch { /* 忽略 */ }
      }
      // 关闭 tsserver 文件 + 清理 LSP providers
      if (path && !isBrowser) tsService.close(path).catch(() => {});
      diagUnsubRef.current?.();
      lspDisposablesRef.current.forEach((d) => d.dispose());
      lspDisposablesRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isBrowser = !window.electronAPI?.tsserver;

  const applyDiagnostics = useCallback(
    (editor: typeof editorRef.current, monaco: typeof monacoRef.current, diags: Array<{ start: { line: number; column: number }; end: { line: number; column: number }; message: string; category: number; code?: number }>) => {
      if (!editor || !monaco) return;
      const model = editor.getModel();
      if (!model) return;

      const markers = diags.map((d) => {
        const startLine = Math.max(1, Math.min(model.getLineCount(), (d.start?.line ?? 0) + 1));
        const startCol = Math.max(1, (d.start?.column ?? 0) + 1);
        const endLine = Math.max(1, Math.min(model.getLineCount(), (d.end?.line ?? 0) + 1));
        const endCol = Math.max(1, (d.end?.column ?? 0) + 1);
        return {
          severity: d.category === 8 ? monaco.MarkerSeverity.Error
            : d.category === 4 ? monaco.MarkerSeverity.Warning
            : monaco.MarkerSeverity.Info,
          message: d.message,
          startLineNumber: startLine,
          startColumn: startCol,
          endLineNumber: endLine,
          endColumn: endCol,
          source: d.code ? `ts(${d.code})` : 'ts',
        };
      });

      monaco.editor.setModelMarkers(model, 'typescript', markers);
    },
    []
  );

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
        if (decorationsRef.current.length > 0) editor.deltaDecorations(decorationsRef.current, []);
        const matches = model.findMatches(keyword, false, false, false, null, true);
        const newDecorations = matches.map((m) => ({
          range: m.range,
          options: {
            inlineClassName: 'search-highlight-match',
            overviewRuler: { color: '#ea5c1b', position: monaco.editor.OverviewRulerLane.Center },
            minimap: { color: '#ea5c1b', position: monaco.editor.MinimapPosition.Inline },
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
    if (!editorRef.current || !monacoRef.current) {
      pendingRef.current = searchHighlight;
      return;
    }
    applyHighlight(editorRef.current, monacoRef.current, searchHighlight);
  }, [searchHighlight, applyHighlight]);

  return (
    <Editor
      height="100%"
      width="100%"
      language={language}
      value={value}
      path={path}
      onChange={(v) => {
        onChange?.(v || '');
        // 去抖通知 tsserver 文件变更
        if (!isBrowser && path) {
          if (changeTimerRef.current) clearTimeout(changeTimerRef.current);
          changeTimerRef.current = setTimeout(() => {
            tsService.change(path, v || '').catch(() => {});
          }, 500);
        }
      }}
      theme="vs-dark"
      loading={<Loading />}
      onMount={async (editor, monaco) => {
        editorRef.current = editor;
        monacoRef.current = monaco;
        requestAnimationFrame(() => editor.layout());

        // ── TS/TSX 编译选项 ──
        const tsDefaults = monaco.languages.typescript.typescriptDefaults;
        tsDefaults.setCompilerOptions({
          jsx: monaco.languages.typescript.JsxEmit.React,
          jsxFactory: 'React.createElement',
          jsxFragmentFactory: 'React.Fragment',
          reactNamespace: 'React',
          allowNonTsExtensions: true,
          allowSyntheticDefaultImports: true,
          target: monaco.languages.typescript.ScriptTarget.Latest,
          moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
          module: monaco.languages.typescript.ModuleKind.ESNext,
          esModuleInterop: true,
          strict: true,
          noEmit: true,
        });
        // 关闭 Monaco 内置 TS worker 的语义验证，避免与 tsserver LSP 重复报错
        // 语义诊断由 tsserver 通过 applyDiagnostics/setModelMarkers 注入
        tsDefaults.setDiagnosticsOptions({
          noSemanticValidation: true,
          noSyntaxValidation: false,
        });

        monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
          allowNonTsExtensions: true,
          allowSyntheticDefaultImports: true,
          target: monaco.languages.typescript.ScriptTarget.Latest,
          moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
          esModuleInterop: true,
        });

        // ── tsserver LSP 集成 ──
        if (!isBrowser && path) {
          // 监听诊断推送
          diagUnsubRef.current = tsService.onDiagnostics((data) => {
            if ('error' in data) return;
            if (data.file === path && editorRef.current && monacoRef.current) {
              applyDiagnostics(editorRef.current, monacoRef.current, data.diagnostics);
            }
          });

          // 打开文件到 tsserver
          tsService.open(path, value).catch(() => {});

          // 注册补全 provider
          lspDisposablesRef.current.push(monaco.languages.registerCompletionItemProvider(language, {
            provideCompletionItems: async (model, position) => {
              if (!path) return { suggestions: [] };
              const results = await tsService.completions(path, position.lineNumber - 1, position.column - 1);
              if (!results || !results.length) return { suggestions: [] };
              return {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                suggestions: results.map((entry: any) => ({
                  label: entry.name,
                  kind: entry.kind === 'function' ? monaco.languages.CompletionItemKind.Function
                    : entry.kind === 'class' ? monaco.languages.CompletionItemKind.Class
                    : entry.kind === 'interface' ? monaco.languages.CompletionItemKind.Interface
                    : entry.kind === 'method' ? monaco.languages.CompletionItemKind.Method
                    : entry.kind === 'property' ? monaco.languages.CompletionItemKind.Property
                    : entry.kind === 'variable' ? monaco.languages.CompletionItemKind.Variable
                    : entry.kind === 'keyword' ? monaco.languages.CompletionItemKind.Keyword
                    : monaco.languages.CompletionItemKind.Text,
                  insertText: entry.name,
                  detail: entry.kind,
                  sortText: entry.sortText || entry.name,
                })),
              };
            },
          }));

          // 注册悬停 provider
          lspDisposablesRef.current.push(monaco.languages.registerHoverProvider(language, {
            provideHover: async (_model, position) => {
              if (!path) return null;
              const info = await tsService.quickInfo(path, position.lineNumber - 1, position.column - 1);
              if (!info) return null;
              return {
                contents: [
                  { value: info.displayString || info.kind || 'TypeScript' },
                  ...(info.documentation ? [{ value: info.documentation }] : []),
                ],
                range: {
                  startLineNumber: (info.start?.line ?? info.startLineNumber ?? 0) + 1,
                  startColumn: (info.start?.offset ?? info.startColumn ?? 0) + 1,
                  endLineNumber: (info.end?.line ?? info.endLineNumber ?? 0) + 1,
                  endColumn: (info.end?.offset ?? info.endColumn ?? 0) + 1,
                },
              };
            },
          }));

          // 注册定义跳转 provider
          lspDisposablesRef.current.push(monaco.languages.registerDefinitionProvider(language, {
            provideDefinition: async (_model, position) => {
              if (!path) return null;
              const defs = await tsService.definition(path, position.lineNumber - 1, position.column - 1);
              if (!defs || !defs.length) return null;
              return defs.map((d: { file: string; start: { line: number; offset: number }; end: { line: number; offset: number } }) => ({
                uri: monaco.Uri.file(d.file),
                range: {
                  startLineNumber: (d.start?.line ?? 0) + 1,
                  startColumn: (d.start?.offset ?? 0) + 1,
                  endLineNumber: (d.end?.line ?? 0) + 1,
                  endColumn: (d.end?.offset ?? 0) + 1,
                },
              }));
            },
          }));
        }

        // ── 快照恢复 ──
        if (snapshot && !snapshotAppliedRef.current) {
          snapshotAppliedRef.current = true;
          requestAnimationFrame(() => {
            try {
              editor.setPosition({ lineNumber: snapshot.cursor.line, column: snapshot.cursor.column });
              editor.setScrollTop(snapshot.scrollTop);
            } catch { /* 忽略 */ }
          });
        }

        const pending = pendingRef.current;
        if (pending) { pendingRef.current = null; applyHighlight(editor, monaco, pending); }
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
