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

import { useMemo } from 'react';
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

/* ─────────────────────────────────────────────────────────────────── */
/*  辅助函数（Markdown 预处理）                                        */
/* ─────────────────────────────────────────────────────────────────── */

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
