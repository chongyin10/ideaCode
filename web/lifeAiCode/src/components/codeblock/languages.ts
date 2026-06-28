/* ─────────────────────────────────────────────────────────────────── */
/*  代码块语言注册与检测                                               */
/* ─────────────────────────────────────────────────────────────────── */
/*  SyntaxHighlighter 语言注册、显示名映射、语言自动检测。
 *  从 MarkdownContent.tsx 迁移，供 CodeBlock 主组件使用。            */

import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';

import clike from 'react-syntax-highlighter/dist/esm/languages/prism/clike';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import scss from 'react-syntax-highlighter/dist/esm/languages/prism/scss';
import html from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c';
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp';
import csharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import kotlin from 'react-syntax-highlighter/dist/esm/languages/prism/kotlin';
import swift from 'react-syntax-highlighter/dist/esm/languages/prism/swift';
import php from 'react-syntax-highlighter/dist/esm/languages/prism/php';
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby';

[
  ['tsx', tsx],
  ['typescript', typescript],
  ['ts', typescript],
  ['javascript', javascript],
  ['js', javascript],
  ['jsx', tsx],
  ['json', json],
  ['css', css],
  ['scss', scss],
  ['html', html],
  ['bash', bash],
  ['shell', bash],
  ['sh', bash],
  ['python', python],
  ['py', python],
  ['rust', rust],
  ['rs', rust],
  ['go', go],
  ['golang', go],
  ['java', java],
  ['c', c],
  ['cpp', cpp],
  ['c++', cpp],
  ['csharp', csharp],
  ['cs', csharp],
  ['markdown', markdown],
  ['md', markdown],
  ['yaml', yaml],
  ['yml', yaml],
  ['sql', sql],
  ['kotlin', kotlin],
  ['kt', kotlin],
  ['swift', swift],
  ['php', php],
  ['ruby', ruby],
  ['rb', ruby],
  ['clike', clike],
].forEach(([name, lang]) => SyntaxHighlighter.registerLanguage(name as string, lang));

export const REGISTERED_LANGUAGES = new Set([
  'tsx', 'typescript', 'ts', 'javascript', 'js', 'jsx', 'json',
  'css', 'scss', 'html', 'bash', 'shell', 'sh',
  'python', 'py', 'rust', 'rs', 'go', 'golang',
  'java', 'c', 'cpp', 'c++', 'csharp', 'cs',
  'markdown', 'md', 'yaml', 'yml', 'sql',
  'kotlin', 'kt', 'swift', 'php', 'ruby', 'rb',
  'clike',
]);

export const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
  tsx: 'tsx', typescript: 'typescript', ts: 'typescript',
  javascript: 'javascript', js: 'javascript', jsx: 'jsx',
  json: 'json', css: 'css', scss: 'scss', html: 'html', xml: 'xml',
  bash: 'bash', shell: 'shell', sh: 'shell',
  python: 'python', py: 'python',
  rust: 'rust', rs: 'rust',
  go: 'go', golang: 'go',
  java: 'java', c: 'c', cpp: 'cpp', 'c++': 'cpp',
  csharp: 'c#', cs: 'c#',
  markdown: 'markdown', md: 'markdown',
  yaml: 'yaml', yml: 'yaml',
  sql: 'sql', kotlin: 'kotlin', kt: 'kotlin',
  swift: 'swift', php: 'php', ruby: 'ruby', rb: 'ruby',
};

/** 自动检测代码语言（当 markdown 未标注 language-xxx 时） */
export function detectCodeLanguage(code: string): string | undefined {
  const trimmed = code.trim();
  if (!trimmed || !trimmed.includes('\n')) return undefined;

  if (/:\s*(string|number|boolean|any|unknown|never|void|Record<|Promise<|Array<|Map<|Set<|React\.|FC<|JSX\.Element|HTML\w+)/.test(trimmed)) {
    return 'typescript';
  }
  if (/interface\s+\w+\s*\{/.test(trimmed) || /type\s+\w+\s*=\s*(\{|\(|\w+|<)/.test(trimmed)) {
    return 'typescript';
  }
  if (/import\s+.*from\s+['"]react['"]/.test(trimmed)) {
    return /[<>]/.test(trimmed) ? 'tsx' : 'typescript';
  }
  if (/import\s+.*from\s+['"]/.test(trimmed) && /(const|let|var|function|=>)/.test(trimmed)) {
    return /:\s*\w+/.test(trimmed) ? 'typescript' : 'javascript';
  }
  if (/^\s*(def |class |import |from )\w+/m.test(trimmed)) {
    return 'python';
  }
  if (/^\s*[\{\[]/.test(trimmed) && /"[\w-]+"\s*:/.test(trimmed)) {
    return 'json';
  }
  if (/^\s*<(!DOCTYPE|html|[a-zA-Z][\w-]*)/i.test(trimmed)) {
    return 'html';
  }
  if (/^\s*[\.\#@]\w+[\s,\{]/.test(trimmed) || /[\w-]+\s*:\s*[^;]+;/.test(trimmed)) {
    return 'css';
  }
  if (/^(npm|yarn|pnpm|git|curl|wget|cd|ls|cat|echo|mkdir|touch|rm|cp|mv|sudo)\s/m.test(trimmed)) {
    return 'bash';
  }
  if (/\b(public\s+class|private\s+|protected\s+|System\.out|import\s+java)/.test(trimmed)) {
    return 'java';
  }
  if (/\bfn\s+main\(\)|\blet\s+mut\s+|impl\s+|pub\s+fn\s+/.test(trimmed)) {
    return 'rust';
  }
  if (/\bpackage\s+\w+|\bfunc\s+\w+\(/.test(trimmed)) {
    return 'go';
  }
  if (/[{};=<>()]/.test(trimmed)) {
    return 'clike';
  }
  return undefined;
}
