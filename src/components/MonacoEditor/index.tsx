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

/** 在 model 创建前配置 Monaco TypeScript/JavaScript 默认选项 */
const beforeMount: Parameters<typeof Editor>[0]['beforeMount'] = (monaco) => {
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
};

/** 计算光标所在字符串字面量的范围（不含引号），用于让下划线覆盖整个 import 路径 */
function getStringLiteralRange(
  model: { getLineContent(lineNumber: number): string },
  position: { lineNumber: number; column: number }
) {
  const lineContent = model.getLineContent(position.lineNumber);
  const col = position.column - 1; // 0-based

  // 找到光标左侧最近的未转义引号
  let quoteIndex = col;
  let quote = '';
  while (quoteIndex >= 0) {
    const ch = lineContent[quoteIndex];
    if (ch === '"' || ch === "'" || ch === '`') {
      let escapes = 0;
      let i = quoteIndex - 1;
      while (i >= 0 && lineContent[i] === '\\') {
        escapes++;
        i--;
      }
      if (escapes % 2 === 0) {
        quote = ch;
        break;
      }
    }
    quoteIndex--;
  }
  if (!quote) return null;

  // 判断该引号是开始引号还是结束引号：向左统计同类型未转义引号数量
  let quoteCount = 1;
  for (let i = quoteIndex - 1; i >= 0; i--) {
    if (lineContent[i] === quote) {
      let escapes = 0;
      let j = i - 1;
      while (j >= 0 && lineContent[j] === '\\') {
        escapes++;
        j--;
      }
      if (escapes % 2 === 0) quoteCount++;
    }
  }
  // 奇数说明是结束引号，光标在字符串之外
  if (quoteCount % 2 === 0) return null;

  // quoteIndex 是开始引号，寻找配对结束引号
  let end = quoteIndex + 1;
  while (end < lineContent.length) {
    const ch = lineContent[end];
    if (ch === quote) {
      let escapes = 0;
      let i = end - 1;
      while (i >= 0 && lineContent[i] === '\\') {
        escapes++;
        i--;
      }
      if (escapes % 2 === 0) break;
    }
    end++;
  }
  if (end >= lineContent.length) return null;

  // 光标必须在字符串内部
  if (col < quoteIndex + 1 || col > end) return null;

  return {
    startLineNumber: position.lineNumber,
    startColumn: quoteIndex + 2,
    endLineNumber: position.lineNumber,
    endColumn: end + 1,
  };
}

interface MonacoEditorProps {
  value: string;
  language: string;
  onChange?: (value: string) => void;
  snapshot?: EditorSnapshot;
  onSnapshot?: (snapshot: EditorSnapshot) => void;
  focused?: boolean;
  path?: string;
  onOpenFileByPath?: (path: string) => void;
  /** 编辑器（含 tsserver）就绪时回调 */
  onReady?: () => void;
}

const MonacoEditor = ({ value, language, onChange, snapshot, onSnapshot, focused = true, path, onOpenFileByPath, onReady }: MonacoEditorProps) => {
  const dispatch = useAppDispatch();
  const searchHighlight = useAppSelector((state) => state.workspace.searchHighlight);
  const { theme, fontSize, semanticHighlightingEnabled, wordWrap, minimapEnabled } = useAppSelector((state) => state.settings);

  // vs-dark 映射为 ideacode-dark（含语义 token 颜色覆盖：方法橘色、标签变量色）
  const effectiveTheme = theme === 'vs-dark' ? 'ideacode-dark' : theme;

  const editorRef = useRef<Parameters<Parameters<typeof Editor>[0]['onMount']>[0] | null>(null);
  const monacoRef = useRef<Parameters<Parameters<typeof Editor>[0]['onMount']>[1] | null>(null);
  const decorationsRef = useRef<string[]>([]);
  const pendingRef = useRef<SearchHighlight | null>(null);
  const snapshotAppliedRef = useRef(false);
  const diagUnsubRef = useRef<(() => void) | null>(null);
  const changeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lspDisposablesRef = useRef<Array<{ dispose(): void }>>([]);
  const semTokenGenRef = useRef(0);
  const jsxDecorationsRef = useRef<string[]>([]);
  const jsxTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;
  const readyRef = useRef(false);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const pathRef = useRef(path);
  pathRef.current = path;

  const onOpenFileByPathRef = useRef(onOpenFileByPath);
  onOpenFileByPathRef.current = onOpenFileByPath;

  useEffect(() => {
    snapshotAppliedRef.current = false;
  }, [value, snapshot]);

  // settings 中 theme 变化时同步 Monaco 主题
  // vs-dark 映射为 ideacode-dark（包含语义 token 颜色覆盖）
  useEffect(() => {
    if (monacoRef.current) {
      monacoRef.current.editor.setTheme(effectiveTheme);
    }
  }, [effectiveTheme]);

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
      if (path && !isBrowser) {
        tsService.close(path).catch(() => {});
      }
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
      beforeMount={beforeMount}
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
      theme={effectiveTheme}
      loading={<Loading />}
      onMount={async (editor, monaco) => {
        editorRef.current = editor;
        monacoRef.current = monaco;
        requestAnimationFrame(() => editor.layout());

        // 确保 model 语言与 prop 一致，并强制刷新一次 tokenization；
        // 解决首次打开 tsx/jsx 时 Monaco worker 尚未就绪导致无高亮的问题。
        const model = editor.getModel();
        if (model) {
          if (model.getLanguageId() !== language) {
            monaco.editor.setModelLanguage(model, language);
          }
          try {
            (model as unknown as { tokenization: { resetTokenization(): void } }).tokenization.resetTokenization();
          } catch { /* Monaco 内部 API 可能变化，忽略 */ }
        }

        // ── 拦截 definition / link 跳转，转到应用内文件打开 ──
        // Monaco standalone 模式下，如果目标 model 不存在会抛 "Model not found"，
        // 因此必须全部接管，自己处理滚动或文件打开。
        const openerDisposable = monaco.editor.registerEditorOpener({
          openCodeEditor(source, resource, selectionOrPosition) {
            if (!resource) return false;
            const targetPath = resource.path;
            const currentPath = pathRef.current;
            const openFile = onOpenFileByPathRef.current;
            if (!targetPath || !openFile) return false;

            // 同一文件 → 手动滚动到定义位置
            if (targetPath === currentPath && source) {
              const range = selectionOrPosition as {
                lineNumber?: number; column?: number;
                startLineNumber?: number; startColumn?: number;
              } | undefined;
              const line = range?.lineNumber ?? range?.startLineNumber;
              const col = range?.column ?? range?.startColumn;
              if (line) {
                source.setPosition({ lineNumber: line, column: col ?? 1 });
                source.revealPositionInCenter({ lineNumber: line, column: col ?? 1 });
              }
              return true;
            }

            // 不同文件 → 应用内打开
            openFile(targetPath);
            return true;
          },
        });
        lspDisposablesRef.current.push(openerDisposable);

        // ── tsserver LSP 集成 ──
        if (!isBrowser && path) {
          // 2 秒保底超时：即使 tsserver 未返回诊断也标记就绪
          const readyTimer = setTimeout(() => {
            if (!readyRef.current) {
              readyRef.current = true;
              onReadyRef.current?.();
            }
          }, 2000);

          // 监听诊断推送（首次收到即表示 tsserver 已加载完成）
          diagUnsubRef.current = tsService.onDiagnostics((data) => {
            if (!readyRef.current) {
              readyRef.current = true;
              clearTimeout(readyTimer);
              onReadyRef.current?.();
            }
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
              const currentPath = pathRef.current;
              if (!currentPath) return null;
              const defs = await tsService.definition(currentPath, position.lineNumber - 1, position.column - 1);
              if (!defs || !defs.length) return null;

              // 预创建目标 model，避免 Monaco 在 hover/click 阶段报 "Model not found"
              for (const d of defs) {
                const uri = monaco.Uri.file(d.file);
                if (!monaco.editor.getModel(uri)) {
                  try {
                    const content = await window.electronAPI?.fs?.readFile(d.file);
                    monaco.editor.createModel(content ?? '', undefined, uri);
                  } catch {
                    // 文件不可读（如 node_modules 中的 .d.ts），
                    // 仍创建占位 model 防止 "Model not found" 错误
                    monaco.editor.createModel('', undefined, uri);
                  }
                }
              }

              // 对于字符串字面量中的符号（如 import 'xxx' 的路径），LSP 返回的 originSelectionRange
              // 往往只覆盖当前单词（如 electron），导致下划线不连续。这里主动计算出整段字符串范围。
              const stringRange = getStringLiteralRange(_model, position);

              // LSP 未返回 originSelectionRange 时的兜底：以光标所在单词为准
              const wordAtPos = _model.getWordAtPosition(position);
              const fallbackOrigin = wordAtPos
                ? {
                    startLineNumber: position.lineNumber,
                    startColumn: wordAtPos.startColumn,
                    endLineNumber: position.lineNumber,
                    endColumn: wordAtPos.endColumn,
                  }
                : undefined;

              return defs.map((d: {
                file: string;
                start: { line: number; offset: number };
                end: { line: number; offset: number };
              }) => ({
                uri: monaco.Uri.file(d.file),
                range: {
                  startLineNumber: (d.start?.line ?? 0) + 1,
                  startColumn: (d.start?.offset ?? 0) + 1,
                  endLineNumber: (d.end?.line ?? 0) + 1,
                  endColumn: (d.end?.offset ?? 0) + 1,
                },
                originSelectionRange: stringRange ?? fallbackOrigin,
              }));
            },
          }));

          // 注册语义高亮 provider（semantic tokens），让方法/变量/类型等按语义着色
          // 先向 tsserver 索要一次 legend，确保 Monaco 解析 tokens 时与 server 一致
          let semanticTokensLegend = null;
          try {
            const firstTokens = await tsService.semanticTokens(path);
            if (firstTokens?.legend) semanticTokensLegend = firstTokens.legend;
          } catch { /* legend 获取失败时使用默认 legend */ }

          // 与 electron/shared/semanticTokensLegend.cjs 保持同步的默认 legend
          const defaultSemanticTokensLegend = {
            tokenTypes: [
              'class', 'enum', 'interface', 'namespace', 'typeParameter', 'type',
              'parameter', 'variable', 'enumMember', 'property', 'function', 'member',
            ],
            tokenModifiers: ['declaration', 'static', 'async', 'readonly', 'defaultLibrary', 'local'],
          };

          lspDisposablesRef.current.push(monaco.languages.registerDocumentSemanticTokensProvider(language, {
            getLegend: () => semanticTokensLegend ?? defaultSemanticTokensLegend,
            provideDocumentSemanticTokens: async () => {
              const currentPath = pathRef.current;
              if (!currentPath) return null;
              const gen = ++semTokenGenRef.current;
              const tokens = await tsService.semanticTokens(currentPath);
              // 忽略 stale 响应（新的请求已发出，旧结果不再需要）
              if (gen !== semTokenGenRef.current) return null;
              if (!tokens) return null;
              return { resultId: tokens.resultId, data: new Uint32Array(tokens.data) };
            },
            releaseDocumentSemanticTokens: () => {},
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

        // 非 Electron 环境或无 tsserver 时直接标记就绪
        if (isBrowser) {
          setTimeout(() => {
            readyRef.current = true;
            onReadyRef.current?.();
          }, 100);
        }

        // ── JSX 属性名着色（Monarch 语法无法区分标签名与属性名，使用装饰覆盖） ──
        {
          const updateJsxAttrDecorations = () => {
            const model = editor.getModel();
            if (!model) return;
            const lineCount = model.getLineCount();
            const decs: Array<{ range: unknown; options: { inlineClassName: string } }> = [];
            let inTag = false;

            for (let i = 1; i <= lineCount; i++) {
              const line = model.getLineContent(i);
              const len = line.length;
              let j = 0;
              while (j < len) {
                if (!inTag) {
                  // 进入 JSX 标签：< 后跟字母（排除 </ 闭合标签）
                  if (line[j] === '<' && j + 1 < len && /[a-zA-Z]/.test(line[j + 1])) {
                    inTag = true;
                    j += 2;
                  } else {
                    j++;
                  }
                } else {
                  // 跳过空白
                  while (j < len && /\s/.test(line[j])) j++;
                  if (j >= len) break;

                  // 标签结束：> 或 />
                  if (line[j] === '>' || (line[j] === '/' && j + 1 < len && line[j + 1] === '>')) {
                    inTag = false;
                    j += line[j] === '/' ? 2 : 1;
                    continue;
                  }
                  // 跳过 JSX 表达式 {}
                  if (line[j] === '{') {
                    let depth = 1; j++;
                    while (j < len && depth > 0) { if (line[j] === '{') depth++; if (line[j] === '}') depth--; j++; }
                    continue;
                  }
                  // 属性名（identifier）
                  const attrStart = j;
                  while (j < len && /[\w-]/.test(line[j])) j++;
                  const wordLen = j - attrStart;
                  if (wordLen > 0) {
                    // 跳过属性名后的空白
                    while (j < len && /\s/.test(line[j])) j++;
                    // 后跟 = 则为属性名 → 装饰
                    if (j < len && line[j] === '=') {
                      decs.push({
                        range: new monaco.Range(i, attrStart + 1, i, attrStart + 1 + wordLen),
                        options: { inlineClassName: 'jsx-attribute-name' },
                      });
                      // 跳过属性值
                      j++; while (j < len && /\s/.test(line[j])) j++;
                      if (j < len && (line[j] === '"' || line[j] === "'")) { const q = line[j]; j++; while (j < len && line[j] !== q) { if (line[j] === '\\') j++; j++; } j++; }
                      else if (j < len && line[j] === '{') { let d = 1; j++; while (j < len && d > 0) { if (line[j] === '{') d++; if (line[j] === '}') d--; j++; } }
                    }
                    // 否则为布尔属性或标签名 → 不装饰
                  } else {
                    j++; // 非单词字符（如 . < { 等），跳过避免死循环
                  }
                }
              }
            }
            jsxDecorationsRef.current = editor.deltaDecorations(jsxDecorationsRef.current, decs);
          };

          const runJsxDeco = () => {
            clearTimeout(jsxTimerRef.current);
            jsxTimerRef.current = setTimeout(updateJsxAttrDecorations, 300);
          };
          const modelDisposable = editor.getModel()?.onDidChangeContent(runJsxDeco);
          if (modelDisposable) lspDisposablesRef.current.push({ dispose: () => modelDisposable.dispose() });
          runJsxDeco();
        }

        const pending = pendingRef.current;
        if (pending) { pendingRef.current = null; applyHighlight(editor, monaco, pending); }
      }}
      options={{
        minimap: { enabled: focused && minimapEnabled, showSlider: 'always' },
        fontSize,
        wordWrap,
        automaticLayout: true,
        scrollBeyondLastLine: false,
        smoothScrolling: focused,
        renderWhitespace: focused ? 'selection' : 'none',
        renderLineHighlight: focused ? 'all' : 'none',
        matchBrackets: focused ? 'always' : 'never',
        occurrencesHighlight: focused ? 'singleFile' : 'off',
        gotoLocation: { multipleDefinitions: 'goto', multipleDeclarations: 'goto', multipleReferences: 'peek' },
        // hover 优先显示在光标下方，避免靠近编辑器顶部时被 tab-bar/容器裁切
        hover: { above: false },
        'semanticHighlighting.enabled': semanticHighlightingEnabled,
      }}
    />
  );
};

export default MonacoEditor;
