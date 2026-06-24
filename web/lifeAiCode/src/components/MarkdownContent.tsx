import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Copy, Check } from 'lucide-react';

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
].forEach(([name, lang]) => SyntaxHighlighter.registerLanguage(name as string, lang));

const REGISTERED_LANGUAGES = new Set([
  'tsx', 'typescript', 'ts', 'javascript', 'js', 'jsx', 'json',
  'css', 'scss', 'html', 'bash', 'shell', 'sh',
  'python', 'py', 'rust', 'rs', 'go', 'golang',
  'java', 'c', 'cpp', 'c++', 'csharp', 'cs',
  'markdown', 'md', 'yaml', 'yml', 'sql',
  'kotlin', 'kt', 'swift', 'php', 'ruby', 'rb',
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
/*  CodeBlock                                                         */
/* ─────────────────────────────────────────────────────────────────── */

interface CodeBlockProps {
  language: string;
  children: React.ReactNode;
}

function CodeBlock({ language, children }: CodeBlockProps) {
  const code = String(children).replace(/\n$/, '');
  const [copied, setCopied] = useState(false);

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
          <button
            className={`codeblock-copy ${copied ? 'codeblock-copy--copied' : ''}`}
            onClick={handleCopy}
            title={copied ? '已复制' : '复制代码'}
          >
            {copied ? <Check size={11} strokeWidth={2.5} /> : <Copy size={11} strokeWidth={1.8} />}
            {copied ? '已复制' : '复制'}
          </button>
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

export function MarkdownContent({ content, onOptionClick, enableOptions = true }: MarkdownContentProps) {
  const optionList = useMemo(
    () => (enableOptions && onOptionClick ? parseOptionList(content) : null),
    [enableOptions, content, onOptionClick]
  );

  const markdownComponents = useMemo(() => ({
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
      return <CodeBlock language={language}>{children}</CodeBlock>;
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
  }), []);

  if (optionList) {
    return (
      <div className="md-content">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownComponents}>
          {optionList.preText}
        </ReactMarkdown>
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
      </div>
    );
  }

  return (
    <div className="md-content">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
