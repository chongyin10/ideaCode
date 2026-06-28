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

/**
 * 智能检测代码片段的语言类型（统一智能检测工具）
 *
 * 采用特征评分机制：每种语言有一组特征正则，匹配越多分越高。
 * 最终返回得分最高的语言。若多语言并列，则按优先级 shebang > markdown > 其他。
 *
 * 覆盖语言：typescript / tsx / javascript / python / go / rust / java / cpp /
 * csharp / sql / html / css / bash / json / yaml / markdown / kotlin / swift /
 * php / ruby / clike
 */
export function detectCodeLanguage(code: string): string | undefined {
  const trimmed = code.trim();
  if (!trimmed) return undefined;

  // 单行代码难以可靠识别语言，返回 undefined 走纯文本展示
  if (!trimmed.includes('\n')) return undefined;

  const scores: Record<string, number> = {};
  const add = (lang: string, n: number) => { scores[lang] = (scores[lang] || 0) + n; };

  // 1. shebang 是最强信号
  const shebang = code.match(/^#!.*?\n/)?.[0] || '';
  if (shebang) {
    if (/bash|\/sh\b|zsh/.test(shebang)) add('bash', 10);
    if (/python/.test(shebang)) add('python', 10);
    if (/node/.test(shebang)) add('javascript', 10);
    if (/ruby/.test(shebang)) add('ruby', 10);
    if (/perl/.test(shebang)) add('perl', 10);
  }

  // 2. Markdown 特征
  if (/^#{1,6}\s+\S/m.test(trimmed)) add('markdown', 4);
  if (/^\s*[-*+]\s+\S/m.test(trimmed)) add('markdown', 2);
  if (/^\s*\d+\.\s+\S/m.test(trimmed)) add('markdown', 1);
  if (/\[.+?\]\(\S+?\)/.test(trimmed)) add('markdown', 3);
  if (/^>\s+\S/m.test(trimmed)) add('markdown', 2);
  if (/^\s*[-*_]{3,}\s*$/m.test(trimmed)) add('markdown', 3);
  // 表格特征：两行连续的 |...| 格式
  if (/^\|.+\|$/m.test(trimmed) && /^\|[\s:|-]+\|$/m.test(trimmed)) add('markdown', 4);
  // Markdown 代码块内联标记
  if (/`[^`\n]+`/.test(trimmed) && !/[{};]/.test(trimmed)) add('markdown', 1);

  // 3. JSON 特征
  if (/^\s*\{[\s\S]*\}\s*$/.test(trimmed) && /"[\w$-]+"\s*:/.test(trimmed)) add('json', 6);
  if (/^\s*\[[\s\S]*\]\s*$/.test(trimmed) && /"[\w$-]+"\s*:/.test(trimmed)) add('json', 5);

  // 4. YAML 特征（缩进敏感 key: value 结构，无 {} []）
  if (/^\w[\w-]*:\s+\S/m.test(trimmed) && !/[{}]/.test(trimmed) && !/;$/.test(trimmed)) add('yaml', 3);
  if (/^\s*-\s+\w+:/m.test(trimmed)) add('yaml', 3);
  if (/^\s*---\s*$/m.test(trimmed)) add('yaml', 5);

  // 5. Python
  if (/^\s*def\s+\w+\s*\(/m.test(code)) add('python', 3);
  if (/^\s*from\s+\w+\s+import\s+/m.test(code)) add('python', 4);
  if (/^\s*elif\s+/m.test(code)) add('python', 5);
  if (/^\s*if\s+__name__\s*==/.test(code)) add('python', 5);
  if (/^\s*class\s+\w+.*:\s*$/m.test(code)) add('python', 2);
  if (/\bself\b/.test(code) && /\.\w+\s*\(/.test(code)) add('python', 1);
  if (/\bprint\s*\(/.test(code)) add('python', 1);

  // 6. Go
  if (/^func\s+\w+/m.test(code)) add('go', 5);
  if (/^package\s+\w+/m.test(code)) add('go', 5);
  if (/:?=\s*make\(/.test(code)) add('go', 2);
  if (/^\s*import\s+\(/m.test(code)) add('go', 3);
  if (/\bdefer\s+\w+\(/.test(code)) add('go', 2);

  // 7. Rust
  if (/^fn\s+\w+/m.test(code)) add('rust', 5);
  if (/\blet\s+mut\s+/.test(code)) add('rust', 5);
  if (/^use\s+\w+::/m.test(code)) add('rust', 3);
  if (/\bimpl\s+\w+/.test(code)) add('rust', 3);
  if (/\bSome\s*\(|None\s*[);,]/.test(code)) add('rust', 1);

  // 8. C/C++
  if (/#include\s*[<"]/.test(code)) add('cpp', 5);
  if (/std::/.test(code)) add('cpp', 3);
  if (/\bint\s+main\s*\(/.test(code)) add('cpp', 2);

  // 9. C#
  if (/using\s+System/.test(code)) add('csharp', 5);
  if (/Console\.WriteLine/.test(code)) add('csharp', 3);
  if (/^\s*namespace\s+\w+/m.test(code)) add('csharp', 3);

  // 10. Java
  if (/System\.out\.print/.test(code)) add('java', 5);
  if (/public\s+(static\s+)?class\s+\w+/.test(code)) add('java', 2);
  if (/@Override/.test(code)) add('java', 1);

  // 11. SQL
  if (/\b(SELECT\s+.+\s+FROM|INSERT\s+INTO|UPDATE\s+.+\s+SET|DELETE\s+FROM|CREATE\s+TABLE)\b/i.test(code)) add('sql', 6);
  if (/\b(VARCHAR|INTEGER|TEXT|DATETIME|BOOLEAN)\b/i.test(code)) add('sql', 2);

  // 12. HTML
  if (/<\/?\w+[\s>]/.test(code) && /<\/\w+>/.test(code) && !/\b(function|const|let|var)\b/.test(code)) add('html', 3);
  if (/<!DOCTYPE/i.test(code)) add('html', 5);
  if (/<\w+[^>]*>/.test(code) && /=("|')[^"']*\1/.test(code)) add('html', 1);

  // 13. CSS
  if (/[#.\w-]+\s*\{[^}]*:[^}]*;[^}]*\}/.test(code)) add('css', 3);
  if (/^\s*@media/m.test(code)) add('css', 5);
  if (/^\s*\.\w[\w-]*\s*\{/m.test(code)) add('css', 2);
  if (/^\s*#\w[\w-]*\s*\{/m.test(code)) add('css', 2);
  if (/:\s*(flex|grid|block|none|inline|absolute|relative)\s*[;}]/.test(code)) add('css', 1);

  // 14. Shell/Bash
  if (/^(npm|yarn|pnpm|git|curl|wget|cd|ls|cat|echo|mkdir|touch|rm|cp|mv|sudo|apt|brew|export)\s/m.test(code)) add('bash', 3);
  if (/^\s*\$\s+/m.test(code)) add('bash', 2);
  if (/^\s*#!.+\b(bash|sh|zsh)/m.test(code)) add('bash', 3);

  // 15. TypeScript / TSX
  if (/interface\s+\w+\s*\{/.test(code)) add('typescript', 4);
  if (/:\s*(string|number|boolean|void|any|never|unknown)\b/.test(code)) add('typescript', 3);
  if (/<[A-Z]\w*[\s,>]/.test(code)) add('typescript', 1);
  if (/\bas\s+const\b/.test(code)) add('typescript', 2);
  if (/^\s*import\s+.*from\s+['"]react['"]/m.test(code)) add('tsx', 5);
  if (/^\s*import\s+.*from\s+['"]/m.test(code) && /[<>]/.test(code)) add('tsx', 3);
  if (/^\s*type\s+\w+\s*=/m.test(code)) add('typescript', 3);
  if (/^\s*enum\s+\w+/m.test(code)) add('typescript', 2);

  // 16. JavaScript
  if (/(?:const|let|var)\s+\w+\s*=/.test(code)) add('javascript', 1);
  if (/function\s+\w+\s*\(/.test(code)) add('javascript', 1);
  if (/=>/.test(code)) add('javascript', 1);
  if (/\brequire\s*\(\s*['"]/.test(code)) add('javascript', 2);

  // 17. Kotlin
  if (/\bfun\s+\w+\s*\(/.test(code)) add('kotlin', 3);
  if (/\bval\s+\w+\s*=/.test(code)) add('kotlin', 2);
  if (/\bvar\s+\w+\s*:/.test(code)) add('kotlin', 2);

  // 18. Swift
  if (/\bfunc\s+\w+\s*\(/.test(code) && /->/.test(code)) add('swift', 2);
  if (/\bvar\s+\w+\s*:\s*\w+/.test(code) && /@/.test(code)) add('swift', 1);

  // 19. PHP
  if (/<\?php/.test(code)) add('php', 6);
  if (/\$\w+\s*=/.test(code) && /->/.test(code)) add('php', 2);

  // 20. Ruby
  if (/^\s*def\s+\w+/m.test(code) && /\bend\s*$/m.test(code)) add('ruby', 3);
  if (/\bputs\s+/.test(code)) add('ruby', 2);
  if (/@\w+\s*=/.test(code)) add('ruby', 1);

  // 找最高分
  let bestLang: string | undefined;
  let bestScore = 0;
  for (const [lang, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestLang = lang;
    }
  }

  // JS/TS 精细化区分：有 TS 特征则 typescript，纯 JS 特征则 javascript
  if (bestLang === 'javascript' && (scores.typescript || 0) > 0) {
    bestLang = 'typescript';
  }
  if (bestLang === 'typescript' && (scores.typescript || 0) === 0) {
    if (/(?:const|let|var)\s+\w+\s*=/.test(code) || /function\s+\w+\s*\(/.test(code)) {
      bestLang = 'javascript';
    }
  }

  // 低于阈值则认为无法可靠识别
  if (bestScore < 2) return undefined;

  return bestLang;
}
