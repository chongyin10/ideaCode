import Editor, { type OnMount } from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import { useRef, useEffect, useCallback } from 'react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { clearSearchHighlight } from '../../store/slices/workspaceSlice';
import type { SearchHighlight, EditorSnapshot } from '../../store/slices/workspaceSlice';
import { tsService } from '../../services/tsLanguageService';
import { ensureLanguage } from '../../services/languageLoader';
import { eventBus } from '../../utils/eventBus';
import './MonacoEditor.css';

// JSX/HTML/TS 语法高亮 + tsserver 语义高亮统一由 Monaco 内置 tokenizer / semantic tokens
// 配合 ideacode-dark 主题规则着色。
// 例外：Monaco 的 TS worker 不会把 JSX tag/bracket 识别为 token，因此用状态机补 CSS 类。

/** 判断 JSX 标签名类型：小写开头为 HTML 原生标签，大写开头为自定义组件 */
function getJsxTagClass(tagName: string): string {
  if (!tagName) return 'jsx-tag-name-native';
  return /^[a-z]/.test(tagName) ? 'jsx-tag-name-native' : 'jsx-tag-name-component';
}

/** 解析当前位置的 JSX 标签名（支持 Foo.Bar），返回标签名和长度 */
function readJsxTagName(content: string, start: number): { name: string; length: number } {
  const match = content.slice(start).match(/^[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*/);
  return match ? { name: match[0], length: match[0].length } : { name: '', length: 0 };
}

/** < 前面允许出现 JSX 的字符：空白、(、{、=、>、;、:、?、,、) 或行首 */
function isJsxBracketContext(prevChar: string | undefined): boolean {
  if (!prevChar) return true;
  return /[\s=({>;,?:)\]]/.test(prevChar);
}

/** 为 TSX/JSX 生成 decoration：标签名（原生/组件区分）+ 尖括号 <> </ > /> */
function buildJsxDecorations(
  model: monaco.editor.ITextModel,
  monacoInstance: typeof monaco,
): Array<{ range: monaco.Range; options: { inlineClassName: string } }> {
  const langId = model.getLanguageId();
  if (!/typescriptreact|javascriptreact|typescript|javascript/i.test(langId)) return [];

  const decs: Array<{ range: monaco.Range; options: { inlineClassName: string } }> = [];
  const lineCount = model.getLineCount();

  for (let line = 1; line <= lineCount; line++) {
    const content = model.getLineContent(line);
    const len = content.length;
    // 上下文栈：'tag' 表示在 <...> 或 </...> 内，'expression' 表示在 {...} 内
    const stack: Array<'tag' | 'expression'> = [];
    let j = 0;

    while (j < len) {
      const ch = content[j];
      const inTag = stack.length > 0 && stack[stack.length - 1] === 'tag';

      // ── 字符串字面量：在任何上下文中都直接跳过 ──
      if (ch === '"' || ch === "'" || ch === '`') {
        const q = ch;
        j++;
        while (j < len && content[j] !== q) {
          if (content[j] === '\\') j++;
          j++;
        }
        j++;
        continue;
      }

      if (inTag) {
        // 标签结束
        if (ch === '>') {
          decs.push({
            range: new monacoInstance.Range(line, j + 1, line, j + 2),
            options: { inlineClassName: 'jsx-bracket' },
          });
          stack.pop();
          j++; continue;
        }
        // 自闭合
        if (ch === '/' && j + 1 < len && content[j + 1] === '>') {
          decs.push({
            range: new monacoInstance.Range(line, j + 1, line, j + 3),
            options: { inlineClassName: 'jsx-bracket' },
          });
          stack.pop();
          j += 2; continue;
        }
        // JSX 表达式属性
        if (ch === '{') {
          stack.push('expression');
          j++; continue;
        }
        j++; continue;
      }

      // 不在 tag 内：处理表达式结束 / 嵌套表达式 / JSX 标签开始
      if (ch === '}') {
        if (stack.length > 0 && stack[stack.length - 1] === 'expression') {
          stack.pop();
        }
        j++; continue;
      }

      if (ch === '{') {
        stack.push('expression');
        j++; continue;
      }

      if (ch === '<') {
        // 过滤 TypeScript 泛型 / 比较表达式
        if (!isJsxBracketContext(content[j - 1])) {
          j++; continue;
        }

        // 片段：<> / </>
        if (j + 1 < len && content[j + 1] === '>') {
          decs.push({
            range: new monacoInstance.Range(line, j + 1, line, j + 3),
            options: { inlineClassName: 'jsx-bracket' },
          });
          j += 2; continue;
        }
        if (j + 2 < len && content[j + 1] === '/' && content[j + 2] === '>') {
          decs.push({
            range: new monacoInstance.Range(line, j + 1, line, j + 4),
            options: { inlineClassName: 'jsx-bracket' },
          });
          j += 3; continue;
        }

        // 闭标签 </name
        if (j + 1 < len && content[j + 1] === '/') {
          decs.push({
            range: new monacoInstance.Range(line, j + 1, line, j + 3),
            options: { inlineClassName: 'jsx-bracket' },
          });
          j += 2; // 指向标签名第一个字符
          const { name, length } = readJsxTagName(content, j);
          if (length > 0) {
            decs.push({
              range: new monacoInstance.Range(line, j + 1, line, j + 1 + length),
              options: { inlineClassName: getJsxTagClass(name) },
            });
            j += length;
          }
          stack.push('tag');
          continue;
        }

        // 开标签 <name
        if (j + 1 < len && /[a-zA-Z_$]/.test(content[j + 1])) {
          decs.push({
            range: new monacoInstance.Range(line, j + 1, line, j + 2),
            options: { inlineClassName: 'jsx-bracket' },
          });
          j++; // 指向标签名第一个字符
          const { name, length } = readJsxTagName(content, j);
          if (length > 0) {
            decs.push({
              range: new monacoInstance.Range(line, j + 1, line, j + 1 + length),
              options: { inlineClassName: getJsxTagClass(name) },
            });
            j += length;
          }
          stack.push('tag');
          continue;
        }
      }

      j++;
    }
  }

  return decs;
}

const Loading = () => (
  <div className="monaco-loading">
    <div className="monaco-loading__spinner" />
    <span className="monaco-loading__text">正在加载编辑器...</span>
  </div>
);

// 保存 Monaco 原始的 registerHoverProvider，用于在拦截后仍能注册自定义 hover provider
let originalRegisterHoverProvider: ((languageSelector: unknown, provider: unknown) => { dispose(): void }) | null = null;

/** tsserver 文件引用计数：同一文件在多个分屏中打开时，仅当最后一个编辑器卸载时才 close */
const tsserverRefCounts = new Map<string, number>();
const TSJS_LANGS = new Set(['typescript', 'javascript', 'typescriptreact', 'javascriptreact']);

// ── 屏蔽 Monaco TS worker 虚拟文件系统中的 "Could not find source file" 噪音错误 ──
// 该错误来自 typescriptServices.js 中的 getValidSourceFile()，当虚拟 file:// 路径
// 无法被 TS program 解析到（如 node_modules 依赖链、lib 文件懒加载）时会抛出。
// 错误被 Monaco 内部捕获并正常降级，不影响功能，但会污染控制台。
(function setupErrorSuppression() {
  if (typeof window === 'undefined') return;
  if ((window as unknown as { __ideacodeErrorSuppressed?: boolean }).__ideacodeErrorSuppressed) return;
  (window as unknown as { __ideacodeErrorSuppressed?: boolean }).__ideacodeErrorSuppressed = true;

  const SUPPRESS_PATTERN = /Could not find source file|ModelService: Cannot add model/;

  // 拦截 console.error（worker 错误会以 Error 对象 + console.error 的方式输出）
  const origConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    const first = args[0];
    if (first instanceof Error && SUPPRESS_PATTERN.test(first.message)) return;
    if (typeof first === 'string' && SUPPRESS_PATTERN.test(first)) return;
    origConsoleError(...args);
  };

  // 拦截全局未捕获错误（某些路径下 error 会冒泡到 window）
  window.addEventListener('error', (event) => {
    if (event.error instanceof Error && SUPPRESS_PATTERN.test(event.error.message)) {
      event.preventDefault();
      event.stopPropagation();
    }
  });

  // 拦截 Promise 未捕获 rejection
  window.addEventListener('unhandledrejection', (event) => {
    if (event.reason instanceof Error && SUPPRESS_PATTERN.test(event.reason.message)) {
      event.preventDefault();
    }
  });
})();

/** 在 model 创建前配置 Monaco TypeScript/JavaScript 默认选项 */
const beforeMount: Parameters<typeof Editor>[0]['beforeMount'] = (monaco) => {
  const hasTsServer = typeof window !== 'undefined' && !!(window as unknown as { electronAPI?: { tsserver?: unknown } }).electronAPI?.tsserver;

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
    lib: ['esnext', 'dom'],
  });
  // Eager sync：model 内容立即推送到 TS worker，避免懒同步导致的源文件查找竞态
  tsDefaults.setEagerModelSync(true);
  // 诊断策略：Electron 下由 tsserver LSP 全权接管诊断，浏览器下保留内置语法检查
  tsDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: hasTsServer,
  });

  monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
    allowNonTsExtensions: true,
    allowSyntheticDefaultImports: true,
    target: monaco.languages.typescript.ScriptTarget.Latest,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    esModuleInterop: true,
    lib: ['esnext', 'dom'],
  });
  monaco.languages.typescript.javascriptDefaults.setEagerModelSync(true);
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: hasTsServer,
  });

  // 浏览器模式：注入通配模块声明，让 TS worker 将所有第三方模块（node_modules）统一视为 any 类型。
  // 避免因模块在虚拟文件系统中不存在而抛出 "Could not find source file" 错误。
  // Electron 模式下 tsserver LSP 已接管类型解析，无需此补丁。
  if (!hasTsServer) {
    const ambientModules = 'declare module "*" {}\n';
    tsDefaults.addExtraLib(ambientModules, 'ideacode://ambient-modules.d.ts');
    monaco.languages.typescript.javascriptDefaults.addExtraLib(ambientModules, 'ideacode://ambient-modules.d.ts');
  }

  // 仅在 Electron 环境（有 tsserver）时拦截内置 hover provider，
  // 由自定义 LSP hover 接管，避免两者重复显示。
  // 浏览器模式下保留 Monaco 内置 hover 作为兜底。
  if (!originalRegisterHoverProvider) {
    originalRegisterHoverProvider = monaco.languages.registerHoverProvider.bind(monaco.languages);
  }
  if (hasTsServer) {
    monaco.languages.registerHoverProvider = ((languageSelector: unknown, provider: unknown) => {
      const langs = Array.isArray(languageSelector) ? languageSelector : [languageSelector];
      if (langs.some((l) => TSJS_LANGS.has(l as string))) {
        return { dispose: () => {} };
      }
      return originalRegisterHoverProvider!(languageSelector, provider);
    }) as typeof monaco.languages.registerHoverProvider;
  }

  // 注册 ideacode-dark 主题：继承 vs-dark，用 Monaco 标准 token 规则
  // 统一 JSX/HTML/TS 语法高亮，避免自定义正则/inlineClassName 与内置样式冲突。
  monaco.editor.defineTheme('ideacode-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      // JSX / HTML 标签与属性
      { token: 'tag', foreground: '569CD6' },
      { token: 'tag.css', foreground: '569CD6' },
      { token: 'attribute.name', foreground: '9CDCFE' },
      { token: 'attribute.value', foreground: 'CE9178' },
      { token: 'attribute.value.number', foreground: 'B5CEA8' },
      // 通用 TS/JS token
      { token: 'string', foreground: 'CE9178' },
      { token: 'string.key', foreground: 'CE9178' },
      { token: 'keyword', foreground: '569CD6' },
      { token: 'keyword.flow', foreground: 'C586C0' },
      { token: 'identifier', foreground: 'D4D4D4' },
      { token: 'number', foreground: 'B5CEA8' },
      { token: 'comment', foreground: '6A9955' },
      { token: 'operator', foreground: 'D4D4D4' },
      // tsserver semantic tokens（标准 token 类型，与 legend 顺序无关）
      { token: 'function', foreground: 'DCDCAA' },
      { token: 'function.declaration', foreground: 'DCDCAA', fontStyle: 'italic' },
      { token: 'member', foreground: 'DCDCAA' },
      { token: 'member.declaration', foreground: 'DCDCAA', fontStyle: 'italic' },
      { token: 'class', foreground: '4EC9B0' },
      { token: 'class.declaration', foreground: '4EC9B0', fontStyle: 'italic' },
      { token: 'interface', foreground: '4EC9B0' },
      { token: 'interface.declaration', foreground: '4EC9B0', fontStyle: 'italic' },
      { token: 'enum', foreground: '4EC9B0' },
      { token: 'enum.declaration', foreground: '4EC9B0', fontStyle: 'italic' },
      { token: 'namespace', foreground: '4EC9B0' },
      { token: 'namespace.declaration', foreground: '4EC9B0', fontStyle: 'italic' },
      { token: 'type', foreground: '4EC9B0' },
      { token: 'type.declaration', foreground: '4EC9B0', fontStyle: 'italic' },
      { token: 'typeParameter', foreground: '4EC9B0' },
      { token: 'typeParameter.declaration', foreground: '4EC9B0', fontStyle: 'italic' },
      { token: 'variable', foreground: '50C8FF' },
      { token: 'variable.declaration', foreground: '50C8FF', fontStyle: 'italic' },
      { token: 'enumMember', foreground: '50C8FF' },
      { token: 'enumMember.declaration', foreground: '50C8FF', fontStyle: 'italic' },
      { token: 'property', foreground: '89CFF0' },
      { token: 'property.declaration', foreground: '89CFF0', fontStyle: 'italic' },
      { token: 'parameter', foreground: 'A6D6F5' },
      { token: 'parameter.declaration', foreground: 'A6D6F5', fontStyle: 'italic' },
    ],
    colors: {
      'editor.background': '#1e1e1e',
      'editor.foreground': '#d4d4d4',
      'editorLineNumber.foreground': '#858585',
      'editor.selectionBackground': '#264f78',
      'editor.inactiveSelectionBackground': '#3a3d41',
    },
  });
};

/** 将 settings 主题名映射到 Monaco 主题 id */
function toMonacoTheme(theme: string): string {
  return theme === 'vs-dark' ? 'ideacode-dark' : theme;
}

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

/** 判断指定 token 是否位于对象字面量键位置（如 { jsx: ... } 中的 jsx） */
interface MonacoEditorProps {
  value: string;
  language: string;
  onChange?: (value: string) => void;
  snapshot?: EditorSnapshot;
  onSnapshot?: (snapshot: EditorSnapshot) => void;
  focused?: boolean;
  path?: string;
  /** 独占的 Monaco model URI；同一文件在不同分屏中应使用不同 model，避免关闭一个分屏时 dispose 共享 model 导致其他分屏白屏 */
  modelPath?: string;
  onOpenFileByPath?: (path: string) => void;
  /** 编辑器（含 tsserver）就绪时回调 */
  onReady?: () => void;
}

const MonacoEditor = ({ value, language, onChange, snapshot, onSnapshot, focused = true, path, modelPath, onOpenFileByPath, onReady }: MonacoEditorProps) => {
  const dispatch = useAppDispatch();
  const searchHighlight = useAppSelector((state) => state.workspace.searchHighlight);
  const { theme, fontSize, semanticHighlightingEnabled, wordWrap, minimapEnabled } = useAppSelector((state) => state.settings);

  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const decorationsRef = useRef<string[]>([]);
  const pendingRef = useRef<SearchHighlight | null>(null);
  const snapshotAppliedRef = useRef(false);
  const diagUnsubRef = useRef<(() => void) | null>(null);
  const changeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lspDisposablesRef = useRef<Array<{ dispose(): void }>>([]);
  const semTokenGenRef = useRef(0);
  const jsxTagDecoRef = useRef<string[]>([]);
  const jsxTagTimerRef = useRef<ReturnType<typeof setTimeout>>();

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
  useEffect(() => {
    if (monacoRef.current) {
      monacoRef.current.editor.setTheme(toMonacoTheme(theme));
    }
  }, [theme]);

  // 卸载时保存快照 + 关闭 tsserver 文件 + 释放独占 model
  useEffect(() => {
    const currentPath = path;
    const currentModelPath = modelPath;
    // 同一文件在多个分屏中打开时，tsserver 只需打开一次；通过引用计数管理 close 时机。
    if (currentPath && !isBrowser) {
      tsserverRefCounts.set(currentPath, (tsserverRefCounts.get(currentPath) || 0) + 1);
    }
    return () => {
      const snap = onSnapshotRef.current;
      if (editorRef.current && snap) {
        try {
          const pos = editorRef.current.getPosition();
          const scroll = editorRef.current.getScrollTop();
          if (pos) snap({ cursor: { line: pos.lineNumber, column: pos.column }, scrollTop: scroll });
        } catch { /* 忽略 */ }
      }
      // 关闭 tsserver 文件：引用计数归零时才真正 close，避免多开同一文件时
      // 关闭一个分屏影响其他分屏的 LSP。
      if (currentPath && !isBrowser) {
        const count = (tsserverRefCounts.get(currentPath) || 1) - 1;
        if (count <= 0) {
          tsserverRefCounts.delete(currentPath);
          tsService.close(currentPath)?.catch(() => {});
        } else {
          tsserverRefCounts.set(currentPath, count);
        }
      }
      diagUnsubRef.current?.();
      clearTimeout(jsxTagTimerRef.current);
      if (editorRef.current && jsxTagDecoRef.current.length > 0) {
        try { editorRef.current.deltaDecorations(jsxTagDecoRef.current, []); } catch { /* 忽略 */ }
      }
      lspDisposablesRef.current.forEach((d) => d.dispose());
      lspDisposablesRef.current = [];
      // 释放当前分屏独占的 Monaco model，避免泄漏
      if (currentModelPath && monacoRef.current) {
        try {
          const uri = monacoRef.current.Uri.parse(currentModelPath);
          const model = monacoRef.current.editor.getModel(uri);
          model?.dispose();
        } catch { /* 忽略 */ }
      }
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

  /** JSX 标签名 + 尖括号着色：同步生成 decoration */
  const applyJsxDecorationsNow = useCallback(
    (editor: typeof editorRef.current, monaco: typeof monacoRef.current) => {
      if (!editor || !monaco) return;
      const model = editor.getModel();
      if (!model) return;
      try {
        const decs = buildJsxDecorations(model, monaco);
        jsxTagDecoRef.current = editor.deltaDecorations(jsxTagDecoRef.current, decs);
      } catch { /* 忽略 */ }
    },
    [],
  );

  /** JSX 标签名 + 尖括号着色：debounced，输入时降低频率 */
  const applyJsxDecorations = useCallback(
    (editor: typeof editorRef.current, monaco: typeof monacoRef.current) => {
      if (!editor || !monaco) return;
      clearTimeout(jsxTagTimerRef.current);
      jsxTagTimerRef.current = setTimeout(() => applyJsxDecorationsNow(editor, monaco), 200);
    },
    [applyJsxDecorationsNow],
  );

  return (
    <Editor
      height="100%"
      width="100%"
      language={language}
      value={value}
      path={modelPath || path}
      beforeMount={beforeMount}
      onChange={(v) => {
        onChange?.(v || '');
        // 发布编辑器变更事件
        if (path) {
          eventBus.emit('editor:changed', { fileId: path, groupIndex: 0 });
        }
        // 去抖通知 tsserver 文件变更
        if (!isBrowser && path) {
          if (changeTimerRef.current) clearTimeout(changeTimerRef.current);
          changeTimerRef.current = setTimeout(() => {
            tsService.change(path, v || '')?.catch(() => {});
          }, 500);
        }
      }}
      theme={toMonacoTheme(theme)}
      loading={<Loading />}
      onMount={async (editor, monaco) => {
        editorRef.current = editor;
        monacoRef.current = monaco;

        // ── 按需加载语言语法（减少首屏体积）──
        if (language) {
          ensureLanguage(language).catch(() => {});
        }

        // ── 快照恢复（layout 先行，消除抖动 + 保证位置正确）──
        // 1. 先同步执行 layout，确保 Monaco 已完成内容测量（scrollHeight 已知），
        //    否则 setScrollTop 会因为可滚动区域尚未计算而被忽略。
        // 2. 再设置快照位置。
        // 3. requestAnimationFrame 补一次 layout，处理容器最终尺寸就绪。
        editor.layout();
        if (snapshot && !snapshotAppliedRef.current) {
          snapshotAppliedRef.current = true;
          try {
            editor.setScrollTop(snapshot.scrollTop);
            editor.setPosition({ lineNumber: snapshot.cursor.line, column: snapshot.cursor.column });
          } catch { /* 忽略 */ }
        }
        requestAnimationFrame(() => editor.layout());

        // 去掉 definition link hover 上的 "Click to show N definitions." 提示
        const gotoDefContribution = editor.getContribution('editor.contrib.gotodefinitionatposition') as unknown as { linkDecorations?: { set: (v: unknown[]) => void } } | null;
        if (gotoDefContribution?.linkDecorations) {
          const linkDecorations = gotoDefContribution.linkDecorations;
          (gotoDefContribution as { addDecoration?: (range: unknown, hoverMessage: unknown) => void }).addDecoration = (range) => {
            linkDecorations.set([{
              range,
              options: {
                description: 'goto-definition-link',
                inlineClassName: 'goto-definition-link',
              },
            }]);
          };
        }

        // 确保 model 语言与 prop 一致，并强制刷新一次 tokenization；
        // 解决首次打开 tsx/jsx 时 Monaco worker 尚未就绪导致无高亮的问题。
        const model = editor.getModel();
        if (model) {
          if (model.getLanguageId() !== language) {
            monaco.editor.setModelLanguage(model, language);
          }
          // 立即尝试 + 推迟重试：resetTokenization 是内部 API，初次调用可能因 worker 未就绪而失效
          const forceTokenization = () => {
            try {
              (model as unknown as { tokenization: { resetTokenization(): void } }).tokenization.resetTokenization();
            } catch { /* 忽略 */ }
          };
          forceTokenization();
          // 200ms 后重试，确保 worker 已就绪
          setTimeout(forceTokenization, 200);
        }

        // ── JSX 标签名 + 尖括号着色兜底（Monaco TS worker 不识别这些 token） ──
        applyJsxDecorations(editor, monaco);
        const jsxContentDisposable = editor.getModel()?.onDidChangeContent(() => {
          applyJsxDecorations(editorRef.current, monacoRef.current);
        });
        if (jsxContentDisposable) {
          lspDisposablesRef.current.push({ dispose: () => jsxContentDisposable.dispose() });
        }

        // ── 拦截 definition / link 跳转，转到应用内文件打开 ──
        // Monaco standalone 模式下，如果目标 model 不存在会抛 "Model not found"，
        // 因此必须全部接管，自己处理滚动或文件打开。
        const openerDisposable = monaco.editor.registerEditorOpener({
          openCodeEditor(
            source: monaco.editor.ICodeEditor,
            resource: monaco.Uri,
            selectionOrPosition?: monaco.IRange | { lineNumber: number; column: number },
          ) {
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
            provideCompletionItems: async (_model: monaco.editor.ITextModel, position: monaco.Position) => {
              if (!path) return { suggestions: [] };
              const results = await tsService.completions(path, position.lineNumber - 1, position.column - 1);
              if (!results || !results.length) return { suggestions: [] };
              return {
                suggestions: results.map((entry) => ({
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

          // 注册悬停 provider（使用原始函数，绕过上方拦截）
          const registerHover = originalRegisterHoverProvider || monaco.languages.registerHoverProvider;
          lspDisposablesRef.current.push(registerHover(language, {
            provideHover: async (_model: monaco.editor.ITextModel, position: monaco.Position) => {
              if (!path) return null;
              const info = await tsService.quickInfo(path, position.lineNumber - 1, position.column - 1);
              if (!info) return null;

              const display = info.displayString || info.kind || 'TypeScript';
              // 类型签名 → 以 LSP MarkedString 代码块形式渲染，带语法高亮
              const contents: Array<{ language: string; value: string } | monaco.IMarkdownString> = [
                { language, value: display },
              ];
              // 文档注释 → 启用 markdown 渲染（Monaco 自动做 XSS 过滤）
              if (info.documentation) {
                contents.push({ value: info.documentation, supportHtml: true });
              }

              return {
                contents,
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
            provideDefinition: async (_model: monaco.editor.ITextModel, position: monaco.Position) => {
              const currentPath = pathRef.current;
              if (!currentPath) return null;
              const defs = await tsService.definition(currentPath, position.lineNumber - 1, position.column - 1);
              if (!defs || !defs.length) return null;

              // 预创建目标 model，避免 Monaco 在 hover/click 阶段报 "Model not found"
              for (const d of defs) {
                const uri = monaco.Uri.file(d.file);
                if (monaco.editor.getModel(uri)) continue;

                try {
                  const content = await window.electronAPI?.fs?.readFile(d.file);
                  // 二次检查：await 期间可能已有其他提供器调用创建了同一 model
                  if (monaco.editor.getModel(uri)) continue;
                  monaco.editor.createModel(content ?? '', undefined, uri);
                } catch (err) {
                  // "already exists" → 竞态下已创建，忽略
                  if (err instanceof Error && /already exists/.test(err.message)) continue;
                  // 文件不可读（如 node_modules 中的 .d.ts），创建占位 model 防止后续报错
                  try {
                    if (!monaco.editor.getModel(uri)) {
                      monaco.editor.createModel('', undefined, uri);
                    }
                  } catch { /* 占位 model 创建失败也忽略 */ }
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

        // 非 Electron 环境或无 tsserver 时直接标记就绪
        if (isBrowser) {
          setTimeout(() => {
            readyRef.current = true;
            onReadyRef.current?.();
          }, 100);
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
