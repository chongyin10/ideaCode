import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Copy, Check } from 'lucide-react';

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

const REGISTERED_LANGUAGES = new Set([
  'tsx', 'typescript', 'ts', 'javascript', 'js', 'jsx', 'json',
  'css', 'scss', 'html', 'bash', 'shell', 'sh',
  'python', 'py', 'rust', 'rs', 'go', 'golang',
  'java', 'c', 'cpp', 'c++', 'csharp', 'cs',
  'markdown', 'md', 'yaml', 'yml', 'sql',
  'kotlin', 'kt', 'swift', 'php', 'ruby', 'rb',
  'clike',
]);

const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
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

/* ─────────────────────────────────────────────────────────────────── */
/*  Language detection fallback                                       */
/* ─────────────────────────────────────────────────────────────────── */

function detectCodeLanguage(code: string): string | undefined {
  const trimmed = code.trim();
  if (!trimmed || !trimmed.includes('\n')) return undefined;

  // TypeScript type annotations / interfaces / type aliases
  if (/:\s*(string|number|boolean|any|unknown|never|void|Record<|Promise<|Array<|Map<|Set<|React\.|FC<|JSX\.Element|HTML\w+)/.test(trimmed)) {
    return 'typescript';
  }
  if (/interface\s+\w+\s*\{/.test(trimmed) || /type\s+\w+\s*=\s*(\{|\(|\w+|<)/.test(trimmed)) {
    return 'typescript';
  }
  // React imports
  if (/import\s+.*from\s+['"]react['"]/.test(trimmed)) {
    return /[<>]/.test(trimmed) ? 'tsx' : 'typescript';
  }
  // Generic JS/TS
  if (/import\s+.*from\s+['"]/.test(trimmed) && /(const|let|var|function|=>)/.test(trimmed)) {
    return /:\s*\w+/.test(trimmed) ? 'typescript' : 'javascript';
  }
  // Python
  if (/^\s*(def |class |import |from )\w+/m.test(trimmed)) {
    return 'python';
  }
  // JSON
  if (/^\s*[\{\[]/.test(trimmed) && /"[\w-]+"\s*:/.test(trimmed)) {
    return 'json';
  }
  // HTML
  if (/^\s*<(!DOCTYPE|html|[a-zA-Z][\w-]*)/i.test(trimmed)) {
    return 'html';
  }
  // CSS
  if (/^\s*[\.\#@]\w+[\s,\{]/.test(trimmed) || /[\w-]+\s*:\s*[^;]+;/.test(trimmed)) {
    return 'css';
  }
  // Bash / Shell
  if (/^(npm|yarn|pnpm|git|curl|wget|cd|ls|cat|echo|mkdir|touch|rm|cp|mv|sudo)\s/m.test(trimmed)) {
    return 'bash';
  }
  // Java
  if (/\b(public\s+class|private\s+|protected\s+|System\.out|import\s+java)/.test(trimmed)) {
    return 'java';
  }
  // Rust
  if (/\bfn\s+main\(\)|\blet\s+mut\s+|impl\s+|pub\s+fn\s+/.test(trimmed)) {
    return 'rust';
  }
  // Go
  if (/\bpackage\s+\w+|\bfunc\s+\w+\(/.test(trimmed)) {
    return 'go';
  }
  // Generic code-like fallback
  if (/[{};=<>()]/.test(trimmed)) {
    return 'clike';
  }

  return undefined;
}

/* ─────────────────────────────────────────────────────────────────── */
/*  CodeBlock                                                         */
/* ─────────────────────────────────────────────────────────────────── */

interface CodeBlockProps {
  language: string;
  children: React.ReactNode;
  onExecuteShell?: (id: string, command: string) => void;
  shellOutputs?: Record<string, { output: string; status: 'running' | 'success' | 'error' }>;
}

const SHELL_LANGUAGES = new Set(['bash', 'shell', 'sh', 'zsh', 'fish']);

/** 提取代码块中要执行的命令（去掉 $ 前缀、合并多行） */
function extractShellCommand(code: string): string | null {
  const lines = code.split('\n');
  const commands: string[] = [];
  let current = '';
  let multiLine = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      if (current) { commands.push(current.trim()); current = ''; }
      continue;
    }
    // 去前缀
    let cmd = line.replace(/^\$\s*/, '').replace(/^>\s*/, '');
    // 续行符
    if (cmd.endsWith('\\') || cmd.endsWith('&&') || cmd.endsWith('||') || cmd.endsWith('|')) {
      current += (current ? ' ' : '') + cmd.replace(/[\\&&||]+$/, '');
      multiLine = true;
      continue;
    }
    current += (current ? ' ' : '') + cmd;
    commands.push(current.trim());
    current = '';
    multiLine = false;
  }
  if (current) commands.push(current.trim());

  if (commands.length === 0) return null;
  // 取第一个非空命令（也支持多行复合命令的拼接）
  return commands.join('\n');
}

function CodeBlock({ language, children, onExecuteShell, shellOutputs }: CodeBlockProps) {
  const code = String(children).replace(/\n$/, '');
  const [copied, setCopied] = useState(false);
  const [execId, setExecId] = useState<string | null>(null);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* ignore */ }
  };

  const isKnownLang = language && REGISTERED_LANGUAGES.has(language);
  const lang = isKnownLang ? language : 'text';
  const displayLang = isKnownLang ? (LANGUAGE_DISPLAY_NAMES[language] || language) : '';

  const isShell = SHELL_LANGUAGES.has(language);
  const canRun = isShell && !!onExecuteShell;
  let shellCmd: string | null = null;
  if (canRun) {
    try {
      shellCmd = extractShellCommand(code);
    } catch (err) {
      console.error('[CodeBlock] extractShellCommand failed:', err);
      shellCmd = null;
    }
  }
  const shellResult = execId && shellOutputs ? shellOutputs[execId] : null;

  const handleRun = () => {
    if (!canRun || !shellCmd) return;
    const id = `bash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setExecId(id);
    onExecuteShell!(id, shellCmd);
  };

  return (
    <div className="codeblock" data-lang={lang}>
      {displayLang && (
        <div className="codeblock-header">
          <div className="codeblock-dots">
            <span className="codeblock-dots__dot codeblock-dots__dot--red" />
            <span className="codeblock-dots__dot codeblock-dots__dot--yellow" />
            <span className="codeblock-dots__dot codeblock-dots__dot--green" />
          </div>
          <span className="codeblock-lang">{displayLang}</span>
          <div className="codeblock-header-actions">
            {canRun && shellCmd && (
              <button
                className={`codeblock-run-btn ${shellResult ? `codeblock-run-btn--${shellResult.status}` : ''}`}
                onClick={handleRun}
                title="在聊天窗口内执行（不弹出 IDE 终端）"
                disabled={shellResult?.status === 'running'}
              >
                {shellResult?.status === 'running' ? '执行中…' :
                 shellResult?.status === 'success' ? '✓ 已完成' :
                 shellResult?.status === 'error' ? '✕ 失败' : '▶ 执行'}
              </button>
            )}
            <button
              className={`codeblock-copy ${copied ? 'codeblock-copy--copied' : ''}`}
              onClick={handleCopy}
              title={copied ? '已复制' : '复制代码'}
            >
              {copied ? <Check size={11} strokeWidth={2.5} /> : <Copy size={11} strokeWidth={1.8} />}
              {copied ? '已复制' : '复制'}
            </button>
          </div>
        </div>
      )}
      <div className="codeblock-body">
        {lang === 'text' ? (
          <pre className="codeblock-plain">{code}</pre>
        ) : (
          <SyntaxHighlighter
            language={lang}
            style={oneDark}
            PreTag="div"
            customStyle={{
              margin: 0,
              background: 'transparent',
              padding: '10px 16px',
              fontSize: '11px',
              lineHeight: '1.55',
            }}
            codeTagProps={{
              style: {
                fontFamily: 'var(--font-mono)',
                fontSize: '11px',
              }
            }}
          >
            {code}
          </SyntaxHighlighter>
        )}
      </div>

      {/* 执行结果 */}
      {shellResult && (
        <div className={`codeblock-shell-output codeblock-shell-output--${shellResult.status}`}>
          <div className="codeblock-shell-output__header">
            <span className="codeblock-shell-output__prompt">$</span>
            <span className="codeblock-shell-output__label">终端输出</span>
          </div>
          {shellResult.output && (
            <pre className="codeblock-shell-output__body">{shellResult.output}</pre>
          )}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────── */
/*  MarkdownContent                                                   */
/* ─────────────────────────────────────────────────────────────────── */

interface MarkdownContentProps {
  content: string;
  onOptionClick?: (text: string) => void;
  enableOptions?: boolean;
  onExecuteShell?: (id: string, command: string) => void;
  shellOutputs?: Record<string, { output: string; status: 'running' | 'success' | 'error' }>;
}

export function MarkdownContent({
  content, onOptionClick, enableOptions = true,
  onExecuteShell, shellOutputs,
}: MarkdownContentProps) {
  // 防御性处理：preprocessMarkdown 抛错时回退到原始内容，避免整面板黑屏
  const { processed, incomplete, reasons } = useMemo(() => {
    try {
      return preprocessMarkdown(content);
    } catch (err) {
      console.error('[MarkdownContent] preprocess failed:', err);
      return { processed: content, incomplete: false, reasons: [] as string[] };
    }
  }, [content]);

  const optionList = useMemo(() => {
    if (!enableOptions || !onOptionClick) return null;
    try {
      return parseOptionList(processed);
    } catch (err) {
      console.error('[MarkdownContent] parseOptionList failed:', err);
      return null;
    }
  }, [enableOptions, processed, onOptionClick]);

  // 注意：这里不使用 useMemo，因为 ReactMarkdown 在 markdown 文本不变时
  // 会跳过子组件的重新渲染。如果把 shellOutputs 放在 useMemo 的 deps 里，
  // useMemo 确实会重算 components 对象，但 ReactMarkdown 不会重新调用子渲染器，
  // 导致 shellOutputs 的更新无法传递到 CodeBlock。
  // 这里直接定义对象（每次 MarkdownContent 渲染时重建），ReactMarkdown 会
  // 因为 components 引用变化而触发子组件重新渲染，shellOutputs 变更能正确传递。
  const markdownComponents: any = {
    code({ node, inline, className, children, ...props }: any) {
      const match = /language-(\w+)/.exec(className || '');
      const language = match ? match[1] : undefined;
      if (inline || !language) {
        return (
          <code className={className} {...props}>
            {children}
          </code>
        );
      }
      return (
        <CodeBlock
          language={language}
          onExecuteShell={onExecuteShell}
          shellOutputs={shellOutputs}
        >
          {children}
        </CodeBlock>
      );
    },
    a({ node, ...props }: any) {
      return <a target="_blank" rel="noopener noreferrer" {...props} />;
    },
    ul({ node, className, children, ...props }: any) {
      return <ul className={className} {...props}>{children}</ul>;
    },
    ol({ node, className, children, ...props }: any) {
      return <ol className={className} {...props}>{children}</ol>;
    },
    li({ node, className, children, ...props }: any) {
      return <li className={className} {...props}>{children}</li>;
    },
    h1({ node, ...props }: any) { return <h1 {...props} />; },
    h2({ node, ...props }: any) { return <h2 {...props} />; },
    h3({ node, ...props }: any) { return <h3 {...props} />; },
    h4({ node, ...props }: any) { return <h4 {...props} />; },
    h5({ node, ...props }: any) { return <h5 {...props} />; },
    h6({ node, ...props }: any) { return <h6 {...props} />; },
    p({ node, ...props }: any) { return <p {...props} />; },
    blockquote({ node, ...props }: any) { return <blockquote {...props} />; },
    table({ node, ...props }: any) { return <table {...props} />; },
    thead({ node, ...props }: any) { return <thead {...props} />; },
    tbody({ node, ...props }: any) { return <tbody {...props} />; },
    tr({ node, ...props }: any) { return <tr {...props} />; },
    th({ node, ...props }: any) { return <th {...props} />; },
    td({ node, ...props }: any) { return <td {...props} />; },
    pre({ node, ...props }: any) { return <pre {...props} />; },
    hr({ node, ...props }: any) { return <hr {...props} />; },
    img({ node, ...props }: any) { return <img {...props} />; },
    strong({ node, ...props }: any) { return <strong {...props} />; },
    em({ node, ...props }: any) { return <em {...props} />; },
    del({ node, ...props }: any) { return <del {...props} />; },
  };

  const finalText = optionList ? optionList.preText : processed;

  return (
    <div className="md-content">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownComponents}>
        {finalText}
      </ReactMarkdown>

      {optionList && (
        <div className="option-list">
          {optionList.options.map((opt, idx) => (
            <button
              key={idx}
              className="option-btn"
              onClick={() => onOptionClick?.(opt)}
              title={opt}
            >
              {opt}
            </button>
          ))}
        </div>
      )}

      {incomplete && (
        <div className="md-incomplete-banner" title={reasons.join('、')}>
          <span className="md-incomplete-banner__icon">⚠</span>
          <span className="md-incomplete-banner__text">
            回答可能不完整（检测到 {reasons.join('、')}，已自动补齐）
          </span>
        </div>
      )}
    </div>
  );
}

function parseOptionList(content: string): { preText: string; options: string[] } | null {
  const trimmed = content.trimEnd();
  const listMatch = trimmed.match(/(?:\n|^)((?:[-*]|\d+\.)\s+.*(?:\n|$)(?:(?:[-*]|\d+\.)\s+.*(?:\n|$))+)\s*$/);
  if (!listMatch) return null;

  const listText = listMatch[1];
  const preText = trimmed.slice(0, trimmed.length - listText.length).trimEnd();
  const lines = listText.split('\n').filter((line) => line.trim() !== '');
  const options = lines.map((line) => line.replace(/^(?:[-*]|\d+\.)\s+/, '').trim());

  if (options.length < 2) return null;
  if (options.some((o) => o.length > 90)) return null;

  const promptLower = preText.toLowerCase();
  const looksLikeQuestion = /[?？]/.test(preText) ||
    /(?:选择|哪|请提供|请从|请问|如何|什么|哪些|是不是|可以吗)/.test(promptLower);
  if (!looksLikeQuestion) return null;

  return { preText, options };
}

/**
 * 检测并补齐未闭合的 markdown 结构
 * 解决 LLM streaming 被截断时留下未闭合代码块/表格导致 UI 崩坏
 */
function preprocessMarkdown(content: string): { processed: string; incomplete: boolean; reasons: string[] } {
  let result = content;
  const reasons: string[] = [];

  // 1. 未闭合的代码块 fence（``` 数量为奇数）
  const fenceMatches = content.match(/```/g);
  if (fenceMatches && fenceMatches.length % 2 !== 0) {
    result += '\n\n```';
    reasons.push('代码块未闭合');
  }

  // 2. 未闭合的表格（最后一行是表头分隔符或单行 |...|）
  const lines = result.split('\n');
  const lastLine = lines[lines.length - 1] || '';
  // 检测最后是否有未结束的表格行
  let inUnclosedTable = false;
  let tableOpenLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^\|.*\|$/.test(line) || /^\|.*\|?\s*$/.test(line)) {
      if (tableOpenLine === -1) tableOpenLine = i;
      // 继续累加
    } else if (tableOpenLine !== -1) {
      // 表结束
      tableOpenLine = -1;
    }
  }
  if (tableOpenLine !== -1) {
    // 表格未关闭，补一行
    result += '\n|  |  |\n| --- | --- |';
    reasons.push('表格未闭合');
  }

  // 3. 未闭合的 HTML 标签（粗略处理）
  const openTags: Record<string, number> = {};
  const tagRegex = /<\/?(code|strong|em|del|a|b|i|u|sub|sup|span)\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRegex.exec(result)) !== null) {
    const full = m[0];
    const isClose = full.startsWith('</');
    const tag = m[1].toLowerCase();
    if (isClose) {
      if ((openTags[tag] || 0) > 0) openTags[tag]--;
    } else if (!full.endsWith('/>')) {
      openTags[tag] = (openTags[tag] || 0) + 1;
    }
  }
  let suffix = '';
  for (const [tag, count] of Object.entries(openTags)) {
    if (count > 0) {
      suffix += `</${tag}>`.repeat(count);
      reasons.push(`${tag} 标签未闭合`);
    }
  }
  if (suffix) result += suffix;

  return {
    processed: result.trimEnd(),
    incomplete: reasons.length > 0,
    reasons,
  };
}

