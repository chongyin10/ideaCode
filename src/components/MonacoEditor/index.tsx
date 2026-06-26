import Editor, { type OnMount } from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import { useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { clearSearchHighlight } from '../../store/slices/workspaceSlice';
import type { SearchHighlight, EditorSnapshot } from '../../store/slices/workspaceSlice';
import { tsService } from '../../services/tsLanguageService';
import type { TsSemanticTokens } from '../../services/tsLanguageService';
import { ensureLanguage } from '../../services/languageLoader';
import { eventBus } from '../../utils/eventBus';
import { registerMonacoEditor, unregisterMonacoEditor } from '../../services/monacoEditorBridge';
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

/** 选中文本大小写转换 */
type CaseTransform = 'camel' | 'upper' | 'lower' | 'title';

function toCamelCase(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, ch) => ch.toUpperCase())
    .replace(/^[A-Z]/, (ch) => ch.toLowerCase());
}

function toTitleCase(str: string): string {
  return str.replace(/\w\S*/g, (txt) =>
    txt.charAt(0).toUpperCase() + txt.slice(1).toLowerCase(),
  );
}

function transformSelection(editor: monaco.editor.ICodeEditor, mode: CaseTransform): void {
  const selection = editor.getSelection();
  if (!selection || selection.isEmpty()) return;
  const model = editor.getModel();
  if (!model) return;

  const text = model.getValueInRange(selection);
  let transformed: string;
  switch (mode) {
    case 'camel': transformed = toCamelCase(text); break;
    case 'upper': transformed = text.toUpperCase(); break;
    case 'lower': transformed = text.toLowerCase(); break;
    case 'title': transformed = toTitleCase(text); break;
    default: return;
  }

  editor.executeEdits('case-transform', [{
    range: selection,
    text: transformed,
    forceMoveMarkers: true,
  }]);
}

const Loading = () => {
  const { t } = useTranslation();
  return (
    <div className="monaco-loading">
      <div className="monaco-loading__spinner" />
      <span className="monaco-loading__text">{t('monacoEditor.loading')}</span>
    </div>
  );
};

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
export const beforeMount: Parameters<typeof Editor>[0]['beforeMount'] = (monaco) => {
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
export function toMonacoTheme(theme: string): string {
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

/* ─── 语义 token 位置重映射（消除编辑时高亮跳动）───
 * LSP semantic tokens 使用 delta 编码的 Uint32Array（每 5 个值一组）。
 * 编辑后旧 token 的行/列位置不再正确，但 token 类型（function/class/variable）通常不变。
 * 通过 onDidChangeContent 的变更信息，对缓存的 token 做位置平移，
 * 使 provider 能在 Monaco 调用时瞬间返回位置正确的 tokens，消除 IPC 延迟期间的跳动。
 */

interface DecodedToken {
  line: number;      // 0-based
  startChar: number; // 0-based
  length: number;
  type: number;
  modifiers: number;
  invalid?: boolean;
}

/** 将 LSP delta-encoded Uint32Array 解码为绝对位置数组 */
function decodeSemTokens(data: Uint32Array): DecodedToken[] {
  const tokens: DecodedToken[] = [];
  let prevLine = 0, prevChar = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const deltaLine = data[i];
    const deltaStartChar = data[i + 1];
    const line = prevLine + deltaLine;
    const startChar = deltaLine === 0 ? prevChar + deltaStartChar : deltaStartChar;
    tokens.push({ line, startChar, length: data[i + 2], type: data[i + 3], modifiers: data[i + 4] });
    prevLine = line;
    prevChar = startChar;
  }
  return tokens;
}

/** 将绝对位置数组重新编码为 LSP delta-encoded Uint32Array */
function encodeSemTokens(tokens: DecodedToken[]): Uint32Array {
  const data = new Uint32Array(tokens.length * 5);
  let prevLine = 0, prevChar = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    data[i * 5] = t.line - prevLine;
    data[i * 5 + 1] = t.line === prevLine ? t.startChar - prevChar : t.startChar;
    data[i * 5 + 2] = t.length;
    data[i * 5 + 3] = t.type;
    data[i * 5 + 4] = t.modifiers;
    prevLine = t.line;
    prevChar = t.startChar;
  }
  return data;
}

/**
 * 根据内容变更对 decoded tokens 做位置重映射。
 * 处理行增删和同行字符增删，与编辑重叠的 token 标记为 invalid（等 LSP 刷新）。
 */
function remapDecodedTokens(
  tokens: DecodedToken[],
  changes: ReadonlyArray<{ range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }; text: string }>,
): DecodedToken[] {
  // 从后向前处理变更，保证位置一致性
  for (let c = changes.length - 1; c >= 0; c--) {
    const ch = changes[c];
    const startLine = ch.range.startLineNumber - 1;  // 0-based
    const endLine = ch.range.endLineNumber - 1;
    const startCol = ch.range.startColumn - 1;
    const endCol = ch.range.endColumn - 1;

    const newParts = ch.text.split('\n');
    const newLineCount = newParts.length - 1;       // 插入的换行数
    const oldLineSpan = endLine - startLine;         // 被替换区域的换行数
    const lineDelta = newLineCount - oldLineSpan;

    // 同行字符变化量（仅当单行替换时有意义）
    const oldCharSpan = (oldLineSpan === 0) ? (endCol - startCol) : 0;
    const newCharOnStartLine = newParts[0].length;
    const charDelta = newCharOnStartLine - oldCharSpan;

    for (const tk of tokens) {
      if (tk.invalid) continue;
      if (tk.line < startLine) continue;                    // 变更前：不受影响
      if (tk.line > endLine) { tk.line += lineDelta; continue; } // 变更后：平移行号

      if (oldLineSpan === 0 && tk.line === startLine) {
        // 单行变更
        if (tk.startChar >= endCol) {
          // token 在变更点之后 → 平移字符
          tk.startChar += charDelta;
        } else if (tk.startChar + tk.length > startCol) {
          // token 与变更重叠 → 标记失效，等 LSP 刷新
          tk.invalid = true;
        }
        // token 在变更点之前 → 不受影响
      } else {
        // 多行变更：startLine 和 endLine 之间的 token 全部标记失效
        tk.invalid = true;
      }
    }
  }
  return tokens.filter((t) => !t.invalid);
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
  /** 是否只读 */
  readOnly?: boolean;
}

const MonacoEditor = ({ value, language, onChange, snapshot, onSnapshot, focused = true, path, modelPath, onOpenFileByPath, onReady, readOnly }: MonacoEditorProps) => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const searchHighlight = useAppSelector((state) => state.workspace.searchHighlight);
  const { theme, fontSize, semanticHighlightingEnabled, wordWrap, minimapEnabled } = useAppSelector((state) => state.settings);

  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const decorationsRef = useRef<string[]>([]);
  const pendingRef = useRef<SearchHighlight | null>(null);
  const snapshotAppliedRef = useRef(false);
  const diagUnsubRef = useRef<(() => void) | null>(null);
  const lspDisposablesRef = useRef<Array<{ dispose(): void }>>([]);
  const jsxTagDecoRef = useRef<string[]>([]);
  const jsxTagTimerRef = useRef<ReturnType<typeof setTimeout>>();
  /** 缓存解码后的语义 tokens（绝对位置），用于编辑时即时位置重映射 */
  const decodedTokensRef = useRef<DecodedToken[] | null>(null);
  /** 预取：onChange 时立即发起 semanticTokens 请求，Monaco 调用 provider 时直接取结果，消除 IPC 延迟 */
  const semTokensPrefetchRef = useRef<Promise<{ resultId?: string; data: Uint32Array } | null> | null>(null);

  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;
  const readyRef = useRef(false);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const pathRef = useRef(path);
  pathRef.current = path;

  // 切换文件时清空语义 token 缓存和预取，避免旧文件的 tokens 被应用到新文件
  useEffect(() => {
    decodedTokensRef.current = null;
    semTokensPrefetchRef.current = null;
  }, [path]);

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
      // 注销全局编辑器桥接
      unregisterMonacoEditor();
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
        // 立即通知 tsserver + 预取 semanticTokens，消除编辑后高亮延迟/跳动
        if (!isBrowser && path) {
          tsService.change(path, v || '')?.catch(() => {});
          // 预取：didChange 发出后立即请求 tokens，Monaco 调用 provider 时直接取结果
          semTokensPrefetchRef.current = tsService.semanticTokens(path).then((tokens) => {
            if (tokens && tokens.data && tokens.data.length > 0) {
              const data = new Uint32Array(tokens.data);
              decodedTokensRef.current = decodeSemTokens(data); // 缓存解码后的 tokens
              return { resultId: tokens.resultId, data };
            }
            return null;
          }).catch(() => null);
        }
      }}
      theme={toMonacoTheme(theme)}
      loading={<Loading />}
      onMount={(editor, monaco) => {
        editorRef.current = editor;
        monacoRef.current = monaco;

        // ── 按需加载语言语法（减少首屏体积）──
        if (language) {
          ensureLanguage(language).catch(() => {});
        }

        // ── 预加载 tsserver + 预取 semantic tokens（与后续逻辑并行，消除高亮延迟）──
        // 在 provider 注册前即发起请求，当 Monaco 首次调用 provideDocumentSemanticTokens 时缓存已就绪
        let semTokensPrefetch: Promise<{ resultId?: string; data: Uint32Array } | null> | null = null;
        if (!isBrowser && path) {
          tsService.open(path, value).catch(() => {});

          // 预取语义 tokens。如果 tsserver 还在 handshake（用户极快地"开文件夹→点文件"
          // 时可能出现），首次请求会立即返回 null；这里做一次短延迟重试兜底，
          // 让高频场景下也能在几百毫秒内拿到正确结果，避免回退到 Monaco 内置 TS worker。
          const fetchSemTokens = (): Promise<TsSemanticTokens | null> =>
            tsService.semanticTokens(path).then(
              (tokens) => (tokens && tokens.data && tokens.data.length > 0 ? tokens : null),
              () => null,
            );
          semTokensPrefetch = fetchSemTokens().then((first) => {
            if (first) {
              const data = new Uint32Array(first.data);
              decodedTokensRef.current = decodeSemTokens(data);
              return { resultId: first.resultId, data };
            }
            // 首次为空 → 等一个 tsserver initialize 窗口（约 600ms）后重试一次
            return new Promise<{ resultId?: string; data: Uint32Array } | null>((resolve) => {
              setTimeout(() => {
                fetchSemTokens().then((retry) => {
                  if (retry) {
                    const data = new Uint32Array(retry.data);
                    decodedTokensRef.current = decodeSemTokens(data);
                    resolve({ resultId: retry.resultId, data });
                  } else {
                    resolve(null);
                  }
                }).catch(() => resolve(null));
              }, 600);
            });
          }).catch(() => null);
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

        // 确保 model 语言与 prop 一致，并强制刷新 tokenization；
        // 解决首次打开 tsx/jsx 时 Monaco worker 尚未就绪导致无高亮的问题。
        const model = editor.getModel();
        if (model) {
          if (model.getLanguageId() !== language) {
            monaco.editor.setModelLanguage(model, language);
          }
          // 仅重置一次 tokenization：触发 Monaco 重新从 worker 请求基础语法高亮。
          // 注意：语义高亮（semantic tokens）由 Monaco 内部自动调度，provider 注册后
          // 会在后台异步请求，无需手动 resetTokenization，否则会导致高亮闪动。
          try {
            (model as unknown as { tokenization: { resetTokenization(): void } }).tokenization.resetTokenization();
          } catch { /* 忽略 */ }
        }

        // ── JSX 标签名 + 尖括号着色兜底（Monaco TS worker 不识别这些 token） ──
        applyJsxDecorations(editor, monaco);

        // ── 语义 token 位置重映射：编辑时即时平移缓存 token 的行/列，消除高亮跳动 ──
        const semRemapDisposable = editor.getModel()?.onDidChangeContent((e) => {
          // 1. JSX decorations（debounced）
          applyJsxDecorations(editorRef.current, monacoRef.current);
          // 2. 语义 token 位置重映射（同步，即时）
          if (decodedTokensRef.current && e.changes.length > 0) {
            decodedTokensRef.current = remapDecodedTokens(decodedTokensRef.current, e.changes);
          }
        });
        if (semRemapDisposable) {
          lspDisposablesRef.current.push({ dispose: () => semRemapDisposable.dispose() });
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

          // 注意：tsService.open 已在 onMount 开头并行发起，此处不再重复调用

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
          // 使用 onMount 开头预取的 semTokensPrefetch 结果，消除首次高亮延迟
          // 注意：不 await 预取结果，避免阻塞 onMount。provider 回调中自行 await。
          let semanticTokensLegend: { tokenTypes: string[]; tokenModifiers: string[] } | null = null;
          // 尝试从预取结果获取 legend（非阻塞）
          semTokensPrefetch?.then((firstTokens) => {
            if (firstTokens?.resultId) {
              // legend 需要单独请求（预取时未保存），但用默认 legend 即可工作
              tsService.semanticTokens(path).then((legendTokens) => {
                if (legendTokens?.legend) {
                  semanticTokensLegend = legendTokens.legend;
                }
              }).catch(() => {});
            }
          }).catch(() => {});

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

              // 1. 优先使用 onMount 预取结果（首次加载，大概率已缓存）
              if (semTokensPrefetch) {
                const result = await semTokensPrefetch;
                semTokensPrefetch = null;
                if (result) return result;
              }

              // 2. 其次使用 onChange 预取结果（编辑后预取）
              const changePrefetch = semTokensPrefetchRef.current;
              semTokensPrefetchRef.current = null;
              if (changePrefetch) {
                const result = await changePrefetch;
                if (result) return result;
              }

              // 3. 无预取但 LSP 可达 → 发起新请求并更新缓存
              if (currentPath) {
                try {
                  const tokens = await tsService.semanticTokens(currentPath);
                  if (tokens && tokens.data && tokens.data.length > 0) {
                    const data = new Uint32Array(tokens.data);
                    decodedTokensRef.current = decodeSemTokens(data);
                    return { resultId: tokens.resultId, data };
                  }
                } catch { /* fall through to remapped cache */ }
              }

              // 4. LSP 请求失败或返回空 → 返回位置重映射后的缓存 tokens（同步，零延迟）
              const cached = decodedTokensRef.current;
              if (cached && cached.length > 0) {
                return { data: encodeSemTokens(cached) };
              }

              return null;
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

        // ── 右键菜单自定义功能 ──
        // 注意：转到定义/类型定义/实现/引用、重命名、格式化、剪切/复制/粘贴等
        // 均为 Monaco 内置动作，已通过 NLS 本地化为中文，无需重复注册。
        const contextMenuDisposables: Array<{ dispose(): void }> = [];

        // 转换大小写（无内置等价项，自定义实现）
        const caseGroupId = '10_caseConversion';
        // 驼峰命名
        contextMenuDisposables.push(editor.addAction({
          id: 'ideacode-to-camel-case',
          label: t('editor.contextMenu.toCamelCase'),
          contextMenuGroupId: caseGroupId,
          contextMenuOrder: 1,
          run: (ed) => transformSelection(ed, 'camel'),
        }));
        // 全部转大写
        contextMenuDisposables.push(editor.addAction({
          id: 'ideacode-to-upper-case',
          label: t('editor.contextMenu.toUpperCase'),
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyU],
          contextMenuGroupId: caseGroupId,
          contextMenuOrder: 2,
          run: (ed) => transformSelection(ed, 'upper'),
        }));
        // 全部转小写
        contextMenuDisposables.push(editor.addAction({
          id: 'ideacode-to-lower-case',
          label: t('editor.contextMenu.toLowerCase'),
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyL],
          contextMenuGroupId: caseGroupId,
          contextMenuOrder: 3,
          run: (ed) => transformSelection(ed, 'lower'),
        }));
        // 首字母大写
        contextMenuDisposables.push(editor.addAction({
          id: 'ideacode-to-title-case',
          label: t('editor.contextMenu.toTitleCase'),
          contextMenuGroupId: caseGroupId,
          contextMenuOrder: 4,
          run: (ed) => transformSelection(ed, 'title'),
        }));

        contextMenuDisposables.forEach((d) => lspDisposablesRef.current.push(d));

        // ── 注册到全局桥接层（供 Plugin/AI 访问）──
        registerMonacoEditor(editor, monaco);
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
        readOnly: !!readOnly,
      }}
    />
  );
};

export default MonacoEditor;
