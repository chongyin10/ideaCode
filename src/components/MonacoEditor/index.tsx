import Editor from '@monaco-editor/react';
import { useRef, useEffect, useCallback } from 'react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { clearSearchHighlight } from '../../store/slices/workspaceSlice';
import type { SearchHighlight, EditorSnapshot } from '../../store/slices/workspaceSlice';
import { tsService } from '../../services/tsLanguageService';
import './MonacoEditor.css';

// ─── HTML5 原生标签集 ───
// 在 JSX 中，小写标签名被视为 HTML 原生元素，大写则为自定义组件。
// 装饰着色层对此处列出的原生标签使用 sem-variable 色，其余自定义组件交由 semantic tokens 层处理。
const NATIVE_HTML_TAGS = new Set([
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio',
  'b', 'base', 'bdi', 'bdo', 'blockquote', 'body', 'br', 'button',
  'canvas', 'caption', 'cite', 'code', 'col', 'colgroup',
  'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt',
  'em', 'embed',
  'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html',
  'i', 'iframe', 'img', 'input', 'ins',
  'kbd',
  'label', 'legend', 'li', 'link',
  'main', 'map', 'mark', 'menu', 'meta', 'meter',
  'nav', 'noscript',
  'object', 'ol', 'optgroup', 'option', 'output',
  'p', 'picture', 'pre', 'progress',
  'q',
  'rp', 'rt', 'ruby',
  's', 'samp', 'script', 'section', 'select', 'slot', 'small', 'source', 'span',
  'strong', 'style', 'sub', 'summary', 'sup', 'svg',
  'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead',
  'time', 'title', 'tr', 'track',
  'u', 'ul',
  'var', 'video',
  'wbr',
]);

// ─── 语义 token 装饰着色层 ───
// 绕过 Monaco 内部的 scope 转换（semantic token type → TextMate scope → theme rule 匹配），
// 直接在编辑器文本上以 CSS class decoration 方式着色，复刻 VS Code Dark+ 语义着色标准。

/** VS Code Dark+ 语义 token 类型 → CSS 颜色组 */
const TOKEN_COLOR_GROUP: Record<string, string> = {
  // 函数 / 方法 → 黄色
  function: 'sem-func',
  member:   'sem-func',
  // 类型 / 类 / 接口 / 枚举 → 绿色
  class:         'sem-type',
  enum:          'sem-type',
  interface:     'sem-type',
  namespace:     'sem-type',
  typeParameter: 'sem-type',
  type:          'sem-type',
  // 变量 / 属性 / 枚举成员 → 浅蓝色
  variable:   'sem-variable',
  enumMember: 'sem-variable',
  property:   'sem-variable',
  // 参数 → 淡蓝色
  parameter:  'sem-parameter',
};

/** 将 LSP semantic tokens 压缩数据还原为 Monaco decoration 数组 */
function buildSemanticDecorations(
  data: Uint32Array,
  legend: { tokenTypes: string[]; tokenModifiers: string[] },
  monaco: { Range: new (sl: number, sc: number, el: number, ec: number) => unknown },
): Array<{ range: unknown; options: { inlineClassName: string } }> {
  const decs: Array<{ range: unknown; options: { inlineClassName: string } }> = [];
  let line = 0;
  let col = 0;

  for (let i = 0; i < data.length; i += 5) {
    const dLine = data[i];
    const dCol = data[i + 1];
    const len = data[i + 2];
    const typeIdx = data[i + 3];
    const mods = data[i + 4];

    // 相对坐标解码
    if (dLine > 0) {
      line += dLine;
      col = dCol;
    } else {
      col += dCol;
    }

    const typeName = legend.tokenTypes[typeIdx];
    const baseClass = TOKEN_COLOR_GROUP[typeName];
    if (!baseClass) continue; // 跳过未知/未映射类型

    // 修饰符检测：declaration → 附加 italic 类
    const isDeclaration = !!(mods & 1); // legend.modifiers[0] === 'declaration'
    const className = isDeclaration ? `${baseClass} sem-italic` : baseClass;

    decs.push({
      range: new monaco.Range(line + 1, col + 1, line + 1, col + 1 + len),
      options: { inlineClassName: className },
    });
  }

  return decs;
}

/** 状态机逐行扫描：匹配 JSX/HTML 标签名 + 尖括号 <> </ /> + 片段 <> </>，生成 decoration 数组 */
function buildGrammarDecorations(
  model: { getLanguageId(): string; getLineContent(lineNumber: number): string; getLineCount(): number },
  monaco: { Range: new (sl: number, sc: number, el: number, ec: number) => unknown },
): Array<{ range: unknown; options: { inlineClassName: string } }> {
  const langId = model.getLanguageId();
  if (!/typescriptreact|javascriptreact|typescript|javascript|html|razor|handlebars/i.test(langId)) return [];

  const decs: Array<{ range: unknown; options: { inlineClassName: string } }> = [];
  const lineCount = model.getLineCount();

  for (let line = 1; line <= lineCount; line++) {
    const content = model.getLineContent(line);
    const len = content.length;
    let inTag = false;

    for (let j = 0; j < len; j++) {
      const ch = content[j];

      if (!inTag) {
        // ── 进入 JSX 标签 ──
        if (ch === '<' && j + 1 < len && /[a-zA-Z_$\/]/.test(content[j + 1])) {
          inTag = true;

          // 片段标签：<> / </>
          if (content[j + 1] === '>') {
            decs.push({ range: new monaco.Range(line, j + 1, line, j + 3), options: { inlineClassName: 'sem-fragment' } });
            j++; inTag = false; continue;
          }
          if (j + 2 < len && content[j + 1] === '/' && content[j + 2] === '>') {
            decs.push({ range: new monaco.Range(line, j + 1, line, j + 4), options: { inlineClassName: 'sem-fragment' } });
            j += 2; inTag = false; continue;
          }

          // 开尖括号 < → sem-bracket
          decs.push({ range: new monaco.Range(line, j + 1, line, j + 2), options: { inlineClassName: 'sem-bracket' } });

          // 闭标签斜杠 / → sem-bracket
          if (content[j + 1] === '/') {
            decs.push({ range: new monaco.Range(line, j + 2, line, j + 3), options: { inlineClassName: 'sem-bracket' } });
            j++; // skip '/'
          }
        }
      } else {
        // ── 在标签内部 ──
        if (ch === '>') {
          decs.push({ range: new monaco.Range(line, j + 1, line, j + 2), options: { inlineClassName: 'sem-bracket' } });
          inTag = false;
        } else if (ch === '/' && j + 1 < len && content[j + 1] === '>') {
          decs.push({ range: new monaco.Range(line, j + 1, line, j + 3), options: { inlineClassName: 'sem-bracket' } });
          j++; inTag = false;
        } else if (ch === '{') {
          // 跳过 JSX 表达式
          let depth = 1; j++;
          while (j < len && depth > 0) { if (content[j] === '{') depth++; else if (content[j] === '}') depth--; j++; }
          j--; // 回退到 }
        } else if (ch === '"' || ch === "'" || ch === '`') {
          // 跳过字符串字面量
          const q = ch; j++;
          while (j < len && content[j] !== q) { if (content[j] === '\\') j++; j++; }
        }
        // 标签名：由下方的 tagRegex 统一匹配，不在状态机中重复处理
      }
    }
  }

  // ── 标签名：仅原生 HTML 标签 → sem-variable，自定义组件交由 semantic tokens 层 ──
  for (let line = 1; line <= lineCount; line++) {
    const content = model.getLineContent(line);
    const tagRegex = /<\/?([a-zA-Z_$][\w$]*)/g;
    let match: RegExpExecArray | null;

    while ((match = tagRegex.exec(content)) !== null) {
      const raw = match[1]; // div for <div, /div for </div
      const isClose = raw.startsWith('/');
      const tagName = isClose ? raw.slice(1) : raw;
      if (!tagName) continue;
      // 仅对原生 HTML 标签着色
      if (!NATIVE_HTML_TAGS.has(tagName)) continue;

      const startCol = match.index + (isClose ? 3 : 2);
      const endCol = startCol + tagName.length;

      decs.push({
        range: new monaco.Range(line, startCol, line, endCol),
        options: { inlineClassName: 'sem-variable' },
      });
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

  // 拦截 Monaco 内置 TS/JS worker 的 hover provider，避免自定义 LSP hover 与内置 hover 重复显示
  if (!originalRegisterHoverProvider) {
    originalRegisterHoverProvider = monaco.languages.registerHoverProvider.bind(monaco.languages);
  }
  monaco.languages.registerHoverProvider = ((languageSelector: unknown, provider: unknown) => {
    const langs = Array.isArray(languageSelector) ? languageSelector : [languageSelector];
    if (langs.some((l) => TSJS_LANGS.has(l as string))) {
      return { dispose: () => {} };
    }
    return originalRegisterHoverProvider!(languageSelector, provider);
  }) as typeof monaco.languages.registerHoverProvider;
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

  const editorRef = useRef<Parameters<Parameters<typeof Editor>[0]['onMount']>[0] | null>(null);
  const monacoRef = useRef<Parameters<Parameters<typeof Editor>[0]['onMount']>[1] | null>(null);
  const decorationsRef = useRef<string[]>([]);
  const pendingRef = useRef<SearchHighlight | null>(null);
  const snapshotAppliedRef = useRef(false);
  const diagUnsubRef = useRef<(() => void) | null>(null);
  const changeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lspDisposablesRef = useRef<Array<{ dispose(): void }>>([]);
  const semTokenGenRef = useRef(0);
  const semDecoRef = useRef<string[]>([]);
  const tagDecoRef = useRef<string[]>([]);
  const tagTimerRef = useRef<ReturnType<typeof setTimeout>>();

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
      monacoRef.current.editor.setTheme(theme);
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
          tsService.close(currentPath).catch(() => {});
        } else {
          tsserverRefCounts.set(currentPath, count);
        }
      }
      diagUnsubRef.current?.();
      clearTimeout(tagTimerRef.current);
      // 清除语义 decorations
      if (editorRef.current && semDecoRef.current.length > 0) {
        try { editorRef.current.deltaDecorations(semDecoRef.current, []); } catch { /* 忽略 */ }
      }
      if (editorRef.current && tagDecoRef.current.length > 0) {
        try { editorRef.current.deltaDecorations(tagDecoRef.current, []); } catch { /* 忽略 */ }
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

  /** 将 JSX/HTML 标签名装饰着色为 sem-variable 蓝（同步正则扫描，无异步依赖） */
  const applyTagDecorations = useCallback(
    (editor: typeof editorRef.current, monaco: typeof monacoRef.current) => {
      if (!editor || !monaco) return;
      const model = editor.getModel();
      if (!model) return;
      clearTimeout(tagTimerRef.current);
      tagTimerRef.current = setTimeout(() => {
        try {
          const decs = buildGrammarDecorations(model, monaco);
          tagDecoRef.current = editor.deltaDecorations(tagDecoRef.current, decs);
        } catch { /* 忽略 */ }
      }, 200);
    },
    [],
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
        // 去抖通知 tsserver 文件变更
        if (!isBrowser && path) {
          if (changeTimerRef.current) clearTimeout(changeTimerRef.current);
          changeTimerRef.current = setTimeout(() => {
            tsService.change(path, v || '').catch(() => {});
          }, 500);
        }
      }}
      theme={theme}
      loading={<Loading />}
      onMount={async (editor, monaco) => {
        editorRef.current = editor;
        monacoRef.current = monaco;

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

          // 注册悬停 provider（使用原始函数，绕过上方拦截）
          const registerHover = originalRegisterHoverProvider || monaco.languages.registerHoverProvider;
          lspDisposablesRef.current.push(registerHover(language, {
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
            provideDocumentSemanticTokens: async (_model) => {
              const currentPath = pathRef.current;
              if (!currentPath) return null;
              const gen = ++semTokenGenRef.current;
              const tokens = await tsService.semanticTokens(currentPath);
              // 忽略 stale 响应（新的请求已发出，旧结果不再需要）
              if (gen !== semTokenGenRef.current) return null;
              if (!tokens) return null;

              // ── 语义 decoration 着色：用 CSS 直接覆盖颜色，绕过 Monaco 的 scope 转换 ──
              const editor = editorRef.current;
              const legend = semanticTokensLegend ?? defaultSemanticTokensLegend;
              if (editor && tokens.data.length > 0) {
                try {
                  const decs = buildSemanticDecorations(
                    new Uint32Array(tokens.data),
                    legend,
                    monaco,
                  );
                  semDecoRef.current = editor.deltaDecorations(semDecoRef.current, decs);
                } catch { /* decoration 更新失败不阻塞语义 tokens 返回 */ }
              }

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

        // ── TextMate grammar tag 装饰着色（JSX/HTML 标签名 → sem-variable 蓝） ──
        applyTagDecorations(editor, monaco);
        const tagModelDisposable = editor.getModel()?.onDidChangeContent(() => {
          applyTagDecorations(editorRef.current, monacoRef.current);
        });
        if (tagModelDisposable) lspDisposablesRef.current.push({ dispose: () => tagModelDisposable.dispose() });

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
