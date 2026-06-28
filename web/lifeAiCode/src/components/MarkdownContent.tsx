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

/**
 * 智能检测代码片段的语言类型
 * 通过特征匹配得分，返回最接近的语言
 */
function detectLanguage(code: string): string {
  const scores: Record<string, number> = {};
  const add = (lang: string, n: number) => { scores[lang] = (scores[lang] || 0) + n; };

  // shebang 强信号
  const shebang = code.match(/^#!.*?\n/)?.[0] || '';
  if (shebang) {
    if (/bash|\/sh\b|zsh/.test(shebang)) add('bash', 10);
    if (/python/.test(shebang)) add('python', 10);
    if (/node/.test(shebang)) add('javascript', 10);
  }

  // Python
  if (/^\s*def\s+\w+\s*\(/m.test(code)) add('python', 3);
  if (/^\s*from\s+\w+\s+import\s+/m.test(code)) add('python', 4);
  if (/^\s*elif\s+/m.test(code)) add('python', 5);
  if (/^\s*if\s+__name__\s*==/m.test(code)) add('python', 5);
  if (/^\s*class\s+\w+.*:\s*$/m.test(code)) add('python', 2);

  // Go
  if (/^func\s+\w+/m.test(code)) add('go', 5);
  if (/^package\s+\w+/m.test(code)) add('go', 5);
  if (/:?=\s*make\(/.test(code)) add('go', 2);

  // Rust
  if (/^fn\s+\w+/m.test(code)) add('rust', 5);
  if (/\blet\s+mut\s+/.test(code)) add('rust', 5);
  if (/^use\s+\w+::/m.test(code)) add('rust', 3);
  if (/\bimpl\s+\w+/.test(code)) add('rust', 3);

  // C/C++
  if (/#include\s*[<"]/.test(code)) add('cpp', 5);
  if (/std::/.test(code)) add('cpp', 3);

  // C#
  if (/using\s+System/.test(code)) add('csharp', 5);
  if (/Console\.WriteLine/.test(code)) add('csharp', 3);

  // Java
  if (/System\.out\.print/.test(code)) add('java', 5);
  if (/public\s+(static\s+)?class\s+\w+/.test(code)) add('java', 2);

  // SQL
  if (/\b(SELECT\s+.+\s+FROM|INSERT\s+INTO|UPDATE\s+.+\s+SET|DELETE\s+FROM|CREATE\s+TABLE)\b/i.test(code)) add('sql', 5);

  // HTML
  if (/<\/?\w+[\s>]/.test(code) && /<\/\w+>/.test(code) && !/\b(function|const|let|var)\b/.test(code)) add('html', 3);

  // CSS
  if (/[#.\w-]+\s*\{[^}]*:[^}]*;[^}]*\}/.test(code)) add('css', 3);
  if (/^\s*@media/m.test(code)) add('css', 5);

  // TypeScript
  if (/interface\s+\w+\s*\{/.test(code)) add('typescript', 4);
  if (/:\s*(string|number|boolean|void|any|never|unknown)\b/.test(code)) add('typescript', 3);
  if (/<[A-Z]\w*>/.test(code)) add('typescript', 1);
  if (/\bas\s+const\b/.test(code)) add('typescript', 2);

  // JavaScript
  if (/(?:const|let|var)\s+\w+\s*=/.test(code)) add('javascript', 1);
  if (/function\s+\w+\s*\(/.test(code)) add('javascript', 1);
  if (/=>/.test(code)) add('javascript', 1);

  // 找最高分
  let bestLang = 'typescript';
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

  return bestLang;
}

/**
 * 把 LLM 直接输出的 <code>...</code> 标签转成 markdown 代码
 * - 多行 <code>：转成带语言标识的代码块
 * - 单行 <code>：转成 inline code（`code`）
 * 会反转义 HTML 实体（&lt; → < 等）
 * 注意：在 stripRedundantPreCodeWrapper 之后执行，避免误处理整体包裹
 */
function stripCodeTags(content: string): string {
  return content.replace(/<code(?:\s[^>]*)?>([\s\S]*?)<\/code>/gi, (_match, inner) => {
    const unescaped = inner
      .replace(/&gt;/g, '>')
      .replace(/&lt;/g, '<')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');
    const trimmed = unescaped.trim();
    if (!trimmed) return '';
    // 多行：转成代码块
    if (trimmed.includes('\n')) {
      const lang = detectLanguage(trimmed);
      return '\n\n```' + lang + '\n' + trimmed + '\n```\n\n';
    }
    // 单行：inline code
    return '`' + trimmed + '`';
  });
}

/**
 * 检测一行是否是代码块的强起始特征
 * 用于识别"代码块从这里开始"（保守策略，避免误判普通文本）
 */
function isCodeBlockStart(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  const patterns = [
    /^\s*(export\s+)?(default\s+)?(async\s+)?function\s+\w+\s*[({<]/,
    /^\s*export\s+(default\s+)?(const|let|var|class|interface|type|enum)\s+/,
    /^\s*import\s+[\s\S]*from\s+['"]/,
    /^\s*import\s+['"]/,
    /^\s*(const|let|var)\s+\w+\s*[:=]/,
    /^\s*(const|let|var)\s*\{[^}]*\}\s*[:=]/,
    /^\s*(const|let|var)\s*\[[^\]]*\]\s*[:=]/,
    /^\s*class\s+\w+/,
    /^\s*interface\s+\w+/,
    /^\s*type\s+\w+\s*=/,
    /^\s*enum\s+\w+/,
  ];
  return patterns.some(re => re.test(trimmed));
}

/**
 * 检测一行是否具有代码特征（用于代码块延续判断）
 * 仅在已进入代码收集模式后使用，配合 isCodeBlockStart 起始
 */
function looksLikeCodeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  const patterns = [
    /^\s*(export\s+)?(default\s+)?(async\s+)?function\b/,
    /^\s*export\s+/,
    /^\s*import\s+/,
    /^\s*(const|let|var)\s+/,
    /^\s*return\s+[({\w\[]/,
    /^\s*(if|else|for|while|switch|case|try|catch|finally)\s*[({]/,
    /^\s*}\s*(else|catch|finally|while)\b/,
    /=>/,
    /^\s*await\s+/,
    /^\s*new\s+\w+/,
    /^\s*throw\s+/,
    /^\s*console\./,
    /^\s*set[A-Z]\w*\s*\(/,
    /^\s*}\s*[,;)]?\s*$/,
    /^\s*[{[]\s*$/,
    /^\s*[}\]]\s*[,;]?\s*$/,
    /^\s*\/\/.*/,
    /^\s*\/\*[\s\S]*\*\//,
    /^\s*\*\s/,
    /^\s*\/\*/,
    /^\s*case\s+.+:/,
    /^\s*default:/,
    /^\s*(break|continue)\s*;/,
    /^\s*@\w+/,                            // 装饰器
    /^\s*\w[\w.]*\s*\(.*\)\s*[,;]?\s*$/,   // 函数调用
  ];
  return patterns.some(re => re.test(trimmed));
}

/**
 * 在单个文本段中包裹裸代码
 */
function wrapCodeInSegment(text: string): string {
  const lines = text.split('\n');
  const output: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isCodeBlockStart(line)) {
      const codeLines: string[] = [line];
      let j = i + 1;
      while (j < lines.length) {
        const nextLine = lines[j];
        if (nextLine.trim() === '') {
          // 空行：看下下一行是否还是代码
          if (j + 1 < lines.length && looksLikeCodeLine(lines[j + 1])) {
            codeLines.push(nextLine);
            j++;
            continue;
          } else {
            break;
          }
        }
        if (!looksLikeCodeLine(nextLine)) break;
        codeLines.push(nextLine);
        j++;
      }
      // 连续 2+ 行才包裹（避免单行误判）
      if (codeLines.length >= 2) {
        // 代码块前确保有空行（markdown 规范要求）
        if (output.length > 0 && output[output.length - 1].trim() !== '') {
          output.push('');
        }
        output.push('```' + detectLanguage(codeLines.join('\n')));
        output.push(...codeLines);
        output.push('```');
        i = j;
        continue;
      }
    }
    output.push(line);
    i++;
  }
  return output.join('\n');
}

/**
 * 自动包裹未用 ``` 围栏的裸代码块
 *
 * 某些 LLM 输出代码时不加 ``` 围栏，导致代码被当作普通段落渲染
 * （换行变 <br>，< > 被转义为 &lt; &gt;，缩进丢失）。
 *
 * 策略：
 * 1. 按 ``` 分割内容，跳过已有代码块（奇数索引段）
 * 2. 在普通文本段中按行扫描，找到强代码起始行（isCodeBlockStart）
 * 3. 向后收集连续代码行（looksLikeCodeLine），直到遇到非代码行
 * 4. 连续 2+ 行代码用 ```typescript 包裹
 *
 * 保守策略：不满足条件时原样返回，避免破坏正常文本。
 */
function wrapUnwrappedCode(content: string): string {
  // 按 ``` 分割：偶数索引是普通文本，奇数索引是已有代码块
  const segments = content.split(/(```[\s\S]*?```)/g);
  let result = '';
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (i % 2 === 1) {
      // 已有代码块，原样保留
      result += seg;
      continue;
    }
    result += wrapCodeInSegment(seg);
  }
  return result;
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
  result = stripRedundantPreCodeWrapper(result);

  // 0.3. 把 LLM 直接输出的 <code>...</code> 标签转成 markdown 代码
  result = stripCodeTags(result);

  // 0.5. 自动包裹未用 ``` 围栏的裸代码块
  // 某些 LLM 输出代码时不加 ``` 围栏，导致代码被当作普通段落渲染
  // （换行变 <br>，< > 被转义为 &lt; &gt;，缩进丢失）
  result = wrapUnwrappedCode(result);

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
