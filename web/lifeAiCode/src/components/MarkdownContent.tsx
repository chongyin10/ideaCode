/* ─────────────────────────────────────────────────────────────────── */
/*  MarkdownContent：Markdown 渲染入口                                  */
/* ─────────────────────────────────────────────────────────────────── */
/*  职责：
 *  1. preprocessMarkdown：补齐 LLM streaming 截断的未闭合结构
 *  2. parseOptionList：识别末尾选项列表，渲染为按钮
 *  3. ReactMarkdown 渲染，code 渲染器委托给 CodeBlock
 *
 *  CodeBlock 和 ShellContext 已迁移到 ./codeblock/，通过 Skill 模式
 *  扩展代码块行为。新增 shell 之外的语言行为不改动此文件。       */

import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { CodeBlock, ShellContext } from './codeblock';
import type { ShellOutputsMap } from './codeblock';

interface MarkdownContentProps {
  content: string;
  onOptionClick?: (text: string) => void;
  enableOptions?: boolean;
  onExecuteShell?: (id: string, command: string) => void;
  onKillShell?: (id: string) => void;
  shellOutputs?: ShellOutputsMap;
}

export function MarkdownContent({
  content, onOptionClick, enableOptions = true,
  onExecuteShell, onKillShell, shellOutputs,
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

  // ⚠️ 关键：components 必须用 useMemo 稳定引用，且依赖为空数组。
  // 原因：CodeBlock 通过 useContext(ShellContext) 订阅 shellOutputs，
  // 不再需要 components 变化来传递数据。若 components 每次渲染都新建，
  // shellOutputs 更新 → MarkdownContent 重渲染 → components 引用变化 →
  // ReactMarkdown 重渲染整个 markdown 树 → CodeBlock 被卸载重建 →
  // execId state 丢失 → 占位区域"瞬间出现又消失"。
  // 用空依赖 useMemo 后，components 引用恒定，ReactMarkdown 不再因 components
  // 变化重渲染，CodeBlock 实例和 execId state 得以保留；shellOutputs 更新
  // 仅通过 Context 通道触发 CodeBlock 重渲染。
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
      // shellOutputs 和 onExecuteShell 通过 ShellContext 传递，不作为 props
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

  const finalText = optionList ? optionList.preText : processed;

  // ShellContext.Provider 包裹 ReactMarkdown：shellOutputs/onExecuteShell 变化时
  // 直接通知所有 CodeBlock 重渲染，不受 ReactMarkdown 是否重渲染影响。
  const ctxValue = useMemo(() => ({
    shellOutputs: shellOutputs || {},
    onExecuteShell,
    onKillShell,
  }), [shellOutputs, onExecuteShell, onKillShell]);

  return (
    <div className="md-content">
      <ShellContext.Provider value={ctxValue}>
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownComponents}>
          {finalText}
        </ReactMarkdown>
      </ShellContext.Provider>

      {optionList && (
        <OptionList
          options={optionList.options}
          onSelect={(opt) => onOptionClick?.(opt)}
        />
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

/* ─────────────────────────────────────────────────────────────────── */
/*  辅助函数（Markdown 预处理）                                        */
/* ─────────────────────────────────────────────────────────────────── */

/**
 * 剥离 LLM 误用的 <pre><code>...</code></pre> 外层包裹。
 *
 * 触发条件（同时满足）：
 * 1. 内容整体被 <pre><code>...</code></pre> 包裹（允许首尾空白、标签属性）
 * 2. 内部确实包含 ``` 围栏（说明是 markdown 内容被误包，而非纯代码展示）
 *
 * 处理：剥离外层标签 + 反转义 HTML 实体（&gt; → > 等），让内部 markdown 正常渲染。
 * 保守策略：不满足条件时原样返回，避免破坏合法的 HTML 代码块。
 */
function stripRedundantPreCodeWrapper(content: string): string {
  const trimmed = content.trim();
  // 匹配 <pre...><code...>...</code></pre>（整体包裹）
  const match = trimmed.match(/^<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>\s*$/i);
  if (!match) return content;
  const inner = match[1];
  // 内部必须包含 ``` 围栏才剥离（否则可能是合法的纯代码展示）
  if (!/```/.test(inner)) return content;
  // 反转义 HTML 实体（LLM 在 <pre><code> 内常把 > < & 转义）
  const unescaped = inner
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
  return unescaped.trim();
}

function parseOptionList(content: string): { preText: string; options: string[] } | null {
  const trimmed = content.trimEnd();

  // 1. 优先匹配 HTML 格式：<div class="option-list"><button class="option-btn" title="...">...</button>...</div>
  const htmlMatch = trimmed.match(/<div\s+class=["']option-list["']\s*>([\s\S]*?)<\/div>\s*$/i);
  if (htmlMatch) {
    const preText = trimmed.slice(0, trimmed.length - htmlMatch[0].length).trimEnd();
    const buttonRegex = /<button\s+[^>]*class=["']option-btn["'][^>]*>([^<]*)<\/button>/gi;
    const options: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = buttonRegex.exec(htmlMatch[1])) !== null) {
      options.push(m[1].trim());
    }
    if (options.length >= 2) {
      return { preText, options };
    }
  }

  // 2. 回退到 markdown 列表格式
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

  // 0. 剥离 LLM 误用的 <pre><code>...</code></pre> 外层包裹
  // 某些 LLM 把整个 markdown 回复用 <pre><code> 包裹，导致内部 ``` 围栏失效、
  // 代码被当作纯文本渲染（换行变 <br>，=> 被转义为 &gt;）。
  // 仅当内部确实包含 ``` 围栏时才剥离，避免破坏合法的 <pre><code> 代码展示。
  result = stripRedundantPreCodeWrapper(result);

  // 1. 未闭合的代码块 fence（``` 数量为奇数）
  const fenceMatches = result.match(/```/g);
  if (fenceMatches && fenceMatches.length % 2 !== 0) {
    result += '\n\n```';
    reasons.push('代码块未闭合');
  }

  // 2. 未闭合的表格（最后一行是表头分隔符或单行 |...|）
  const lines = result.split('\n');
  let tableOpenLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^\|.*\|$/.test(line) || /^\|.*\|?\s*$/.test(line)) {
      if (tableOpenLine === -1) tableOpenLine = i;
    } else if (tableOpenLine !== -1) {
      tableOpenLine = -1;
    }
  }
  if (tableOpenLine !== -1) {
    result += '\n|  |  |\n| --- | --- |';
    reasons.push('表格未闭合');
  }

  // 3. 未闭合的 HTML 标签
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

/* ─────────────────────────────────────────────────────────────────── */
/*  OptionList：单选选项列表 + 边框渲染动画                              */
/* ─────────────────────────────────────────────────────────────────── */

function OptionList({ options, onSelect }: { options: string[]; onSelect: (text: string) => void }) {
  const [selected, setSelected] = useState<number | null>(null);

  return (
    <div className="option-list">
      {options.map((opt, idx) => (
        <button
          key={idx}
          className={`option-btn ${selected === idx ? 'option-btn--selected' : ''}`}
          style={{ animationDelay: `${idx * 80}ms` }}
          onClick={() => {
            setSelected(idx);
            onSelect(opt);
          }}
          title={opt}
        >
          <span className="option-btn__radio" />
          <span className="option-btn__text">{opt}</span>
        </button>
      ))}
    </div>
  );
}
