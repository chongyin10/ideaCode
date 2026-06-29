/* ─────────────────────────────────────────────────────────────────── */
/*  MarkdownContent：自定义 Markdown 渲染入口                          */
/* ─────────────────────────────────────────────────────────────────── */
/*  职责：
 *  1. preprocessMarkdown：补齐 LLM streaming 截断的未闭合结构
 *  2. parseOptionList：识别末尾选项列表，渲染为按钮
 *  3. 用 unified + remark + remark-rehype 把 markdown 解析成 hast 树，
 *     再用 hast-util-to-jsx-runtime + 自定义 components 渲染为 JSX。
 *
 *  **本轮重构**：移除 ReactMarkdown。原因：
 *  - ReactMarkdown 强制把代码块渲染成 <pre><code> 外层结构，无法精细
 *    控制 DOM（用户反馈"ReactMarkdown 过度添加了 pre 等其他标签"）。
 *  - 自己用 hast-util-to-jsx-runtime 渲染时，代码块直接生成
 *    <div class="codeblock">，行内 code 仍是 <code>，其他标签完全透传。
 *  - 既然 hast 树由我们自行生成，DOM 修复、嵌套未对齐等问题都由 hast
 *    渲染器消化，不再需要 safeMarkdownParse 的预解析闸门。
 *
 *  CodeBlock 和 ShellContext 已迁移到 ./codeblock/，通过 Skill 模式
 *  扩展代码块行为。新增 shell 之外的语言行为不改动此文件。        */

import React, { useMemo, useState } from 'react';
import { Fragment, jsx as jsxFn, jsxs as jsxsFn } from 'react/jsx-runtime';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import type { Element, Nodes } from 'hast';

import { CodeBlock, ShellContext } from './codeblock';
import { detectCodeLanguage } from './codeblock/languages';
import { isShellCommand } from './codeblock/shellDetect';
import type { ShellOutputsMap } from './codeblock';
import { escapeForPreCodeBlock } from '../utils/safeMarkdownParse';

interface MarkdownContentProps {
  content: string;
  onOptionClick?: (text: string) => void;
  enableOptions?: boolean;
  onExecuteShell?: (id: string, command: string) => void;
  onKillShell?: (id: string) => void;
  shellOutputs?: ShellOutputsMap;
  /**
   * §需求：AI 修改文件的文件路径 hint（用于推断裸代码块的语言）。
   * 比如 description 中 LLM 输出大量裸代码（未加 ``` 围栏）时，
   * 渲染端优先用 fileHint 后缀推断语言，从而拿到正确的高亮。
   */
  fileHint?: string;
}

export function MarkdownContent({
  content, onOptionClick, enableOptions = true,
  onExecuteShell, onKillShell, shellOutputs,
  fileHint,
}: MarkdownContentProps) {
  // 防御性处理：preprocessMarkdown 抛错时回退到原始内容，避免整面板黑屏
  const { processed, incomplete, reasons } = useMemo(() => {
    try {
      return preprocessMarkdown(content, fileHint);
    } catch (err) {
      console.error('[MarkdownContent] preprocess failed:', err);
      return { processed: content, incomplete: false, reasons: [] as string[] };
    }
  }, [content, fileHint]);

  const optionList = useMemo(() => {
    if (!enableOptions || !onOptionClick) return null;
    try {
      return parseOptionList(processed);
    } catch (err) {
      console.error('[MarkdownContent] parseOptionList failed:', err);
      return null;
    }
  }, [enableOptions, processed, onOptionClick]);

  const finalText = optionList ? optionList.preText : processed;

  // 自定义 hast → JSX 渲染。
  // 用 react/jsx-runtime 提供的 jsx/jsxs/Fragment 作为 backend，
  // components 完全我们自己定义，绕开 ReactMarkdown 的"代码块统一包
  // <pre><code>"行为。code 块直接生成 <CodeBlock>，行内 code 仍是 <code>。
  const rendered = useMemo(() => {
    try {
      const processor = unified()
        .use(remarkParse)
        .use(remarkGfm)
        // §安全选项：markdown 里的 raw HTML（<script> 等）不直接渲染为
        // hast element，避免 XSS。LLM 输出合法 HTML 也按文本展示。
        .use(remarkRehype, { allowDangerousHtml: false });
      const mdast = processor.parse(finalText);
      // processor.runSync 返回 hast 树（Root 节点），但 @types/hast 把
      // Nodes 定义成 Root | RootContent 递归 union，直接 narrow 会与
      // 类型系统冲突——按 hast-util-to-jsx-runtime 的预期输入是 Nodes，
      // 这里统一断言为 Nodes 类型传出去。
      const hast = processor.runSync(mdast) as unknown as Nodes;
      return {
        ok: true as const,
        element: toJsxRuntime(hast, {
          Fragment,
          jsx: jsxFn,
          jsxs: jsxsFn,
          passNode: true,
          // 覆盖默认映射；未在 components 中列出的 hast 标签，工具会用
          // 原始 tagName 渲染（如 'span'、'text-align' 等保留语义）。
          components: renderComponents,
        }),
      };
    } catch (err) {
      console.error('[MarkdownContent] hast render failed:', err);
      return { ok: false as const, element: null };
    }
  }, [finalText]);

  // ShellContext.Provider 包裹 JSX 树：shellOutputs/onExecuteShell 变化时
  // 直接通知所有 CodeBlock 重渲染，不受 hast 重渲染影响。
  const ctxValue = useMemo(() => ({
    shellOutputs: shellOutputs || {},
    onExecuteShell,
    onKillShell,
  }), [shellOutputs, onExecuteShell, onKillShell]);

  // ── 渲染失败兜底：把原文 escape 后塞进 <pre><code> ──
  // 自定义渲染理论上不会失败（我们自己控制组件映射），但 hast 解析层
  // 仍可能因 LLM 输出极端内容抛错——此时降级为纯文本展示。
  const fallbackElement = useMemo(() => {
    if (rendered.ok) return null;
    const escaped = escapeForPreCodeBlock(processed);
    return {
      ok: false as const,
      element: (
        <div className="md-fallback" role="region" aria-label="原始回复文本">
          <div className="md-fallback__notice">
            <span className="md-fallback__icon" aria-hidden="true">⚠</span>
            <span className="md-fallback__text">渲染异常，已切换为纯文本展示</span>
          </div>
          <pre className="md-fallback__pre">
            <code className="md-fallback__code">{escaped}</code>
          </pre>
        </div>
      ),
    };
  }, [rendered, processed]);

  return (
    <div className="md-content">
      {rendered.ok ? (
        <ShellContext.Provider value={ctxValue}>
          {/* hast-util-to-jsx-runtime 返回的是 React 元素（Root 级别），
              它的 children 是根节点的子节点（h1/p/codeblock/table 等）。
              用 Fragment 包裹，避免 React 顶层节点限制。              */}
          {rendered.element}
        </ShellContext.Provider>
      ) : (
        fallbackElement?.element
      )}

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
/*  hast 渲染组件映射                                                  */
/* ─────────────────────────────────────────────────────────────────── */

/**
 * 把 hast 节点的 children 拼成纯文本（仅用于 pre > code 这种"代码原样
 * 输出"的场景）。保留原始换行、缩进——这正是去掉 ReactMarkdown 之后
 * 用户期望的"不破坏格式化"。
 */
function collectText(node: Nodes | undefined): string {
  if (!node) return '';
  if (node.type === 'text') {
    return (node as { value: string }).value ?? '';
  }
  const children = (node as { children?: Nodes[] }).children;
  if (!Array.isArray(children)) return '';
  let out = '';
  for (const child of children) {
    if (child.type === 'element' && (child as Element).tagName === 'br') {
      out += '\n';
      continue;
    }
    out += collectText(child);
  }
  return out;
}

/**
 * 从 code 元素的 className 中提取语言（language-xxx 形式）。
 * remark-rehype 会把 ```tsx 围栏里的语言注入到 className 数组。
 */
function extractLangFromCodeClass(codeEl: Element): string | undefined {
  const cls = codeEl.properties?.className as unknown;
  let names: string[];
  if (Array.isArray(cls)) names = cls.filter((n): n is string => typeof n === 'string');
  else if (typeof cls === 'string') names = cls.split(/\s+/);
  else names = [];
  for (const n of names) {
    const m = /^language-(.+)$/.exec(n);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * 自定义 renderer：从 hast 树节点 + react props 渲染 JSX。
 * 注：hast-util-to-jsx-runtime 在 passNode=true 模式下会把整个 hast 节点
 * 注入到组件 props 的 `node` 字段——这让我们能区分 inline code 与 block
 * code（block code 总是 pre > code 结构）。
 */
const renderComponents: Record<string, (props: any) => any> = {
  // 代码块：hast 形如 element[pre] > element[code]
  // 直接生成 <CodeBlock>，外层不再有 <pre><code> 包装。
  pre(props: any) {
    const { node, children } = props;
    if (node && node.type === 'element') {
      const preEl = node as Element;
      // 找唯一的 code 子节点
      const codeChild = preEl.children.find(
        (c): c is Element =>
          c.type === 'element' && (c as Element).tagName === 'code',
      );
      if (codeChild) {
        const language = extractLangFromCodeClass(codeChild);
        const codeText = collectText(codeChild);
        return (
          <CodeBlock language={language || 'text'}>{codeText}</CodeBlock>
        );
      }
    }
    // 非典型 pre（罕见）；保留 pre 标签兜底。
    return <pre>{children}</pre>;
  },

  // 行内 code：pre 已经被父级处理掉，这里只剩 inline code。
  code(props: any) {
    const { node, children, className, ...rest } = props;
    if (node && node.type === 'element') {
      const codeEl = node as Element;
      const cls = codeEl.properties?.className;
      const classNameStr = Array.isArray(cls)
        ? cls.filter((n: unknown): n is string => typeof n === 'string').join(' ')
        : typeof cls === 'string'
          ? cls
          : undefined;
      // 行内 code：如果有 language-xxx 则说明是 "围栏代码块内"但误判，
      // 这种情况极少（pre 已处理），仍作为 code 标签渲染。
      return (
        <code className={classNameStr ?? className} {...rest}>
          {children}
        </code>
      );
    }
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  },

  // 链接默认开新标签
  a(props: any) {
    const { children, ...rest } = props;
    delete (rest as Record<string, unknown>).node;
    return (
      <a target="_blank" rel="noopener noreferrer" {...(rest as Record<string, unknown>)}>
        {children}
      </a>
    );
  },

  // 基础标签透传——hast-util-to-jsx-runtime 默认就会用 tagName 渲染，
  // 这里显式列出来只是为了（a）确保语义明确（b）未来需要时方便扩展。
  h1: passThrough('h1'),
  h2: passThrough('h2'),
  h3: passThrough('h3'),
  h4: passThrough('h4'),
  h5: passThrough('h5'),
  h6: passThrough('h6'),
  p: passThrough('p'),
  ul: passThrough('ul'),
  ol: passThrough('ol'),
  li: passThrough('li'),
  blockquote: passThrough('blockquote'),
  hr: passThrough('hr'),
  table: passThrough('table'),
  thead: passThrough('thead'),
  tbody: passThrough('tbody'),
  tr: passThrough('tr'),
  th: passThrough('th'),
  td: passThrough('td'),
  strong: passThrough('strong'),
  em: passThrough('em'),
  del: passThrough('del'),
};

/**
 * 生成一个简单的透传组件：把 children + 其他 props 原样传给指定标签。
 * 过滤掉 `node` 字段（hast-util-to-jsx-runtime 注入，仅 JS 内部使用）。
 */
function passThrough(tag: string) {
  const Cmp = (props: any) => {
    const { children, ...rest } = props;
    delete (rest as Record<string, unknown>).node;
    return React.createElement(tag, rest, children);
  };
  Cmp.displayName = `Md${tag}`;
  return Cmp;
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
 * §需求：还原 LLM 输出的"伪 markdown 代码"片段。
 *
 * 场景：某些 LLM（特别是生成 JSON 响应后被转成文本的场景）会把代码逐行
 * 用字面双引号包裹，并用 HTML 换行 <br> 拼接：
 *   "const x = 1;"<br>"function foo() {"<br>"  return x;"<br>"}"
 *
 * 自定义渲染会保留 <br> 渲染为换行，外观就是"被双引号逐行包裹的代码"——
 * 缩进丢失、引号噪点、没有高亮。
 *
 * 本函数识别这种模式并还原为多行代码，再交给 wrapUnwrappedCode 加 ``` 围栏。
 *
 * 识别策略：
 * - 在同一个段落（连续非空行）中找到连续多行符合 "^[\s]*"..."$" 的模式，
 *   且行间分隔用 <br> 或换行；
 * - 至少 3 行连续才认为是代码（避免误伤普通引语）；
 * - 还原后丢掉每行的双引号，<br> 替换为换行；
 * - 候选行里首尾出现 "{" "}" ";" 等代码特征才认为是代码。
 */
function unwrapMisformattedCode(content: string): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    // 尝试从 i 开始向后识别"逐行双引号 + <br>"模式
    const collected: string[] = [];
    let j = i;
    while (j < lines.length) {
      const line = lines[j];
      // 同时识别 "<br>" 作为行内分隔（跨行）与换行作为分隔（同行内嵌 <br> 也支持）
      // 单行拆分：依据 <br> / <br/> / <br />
      const parts = line.split(/<br\s*\/?>/i);
      let allWrapped = true;
      const unwrappedParts: string[] = [];
      for (const part of parts) {
        const t = part.trim();
        if (!t) continue;
        // 以双引号包裹（含中文引号 ""）
        const m = t.match(/^["“](.*)["”]$/s);
        if (!m) { allWrapped = false; break; }
        unwrappedParts.push(m[1]);
      }
      if (!allWrapped) break;
      collected.push(unwrappedParts.join('\n'));
      j++;
      // 只收集一行后检查是否是"连续段落"——如果下一行不是双引号包裹的续行就停止
      if (j < lines.length) {
        const next = lines[j].trim();
        if (!/^["“]/.test(next)) break;
      }
    }
    if (collected.length >= 3) {
      const code = collected.join('\n');
      // 只有当代码里有 { } ; = => 等代码特征时才认为是代码，避免误伤
      if (/[{;}]|=>/.test(code)) {
        // 加 ``` 围栏，语言随后由 wrapUnwrappedCode 检测补充
        // 用 typescript 作为默认后缀语言（实际 wrapUnwrappedCode 会覆盖）
        out.push('```typescript');
        out.push(code);
        out.push('```');
        i = j;
        continue;
      }
    }
    out.push(lines[i]);
    i++;
  }
  return out.join('\n');
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
    // §需求：识别裸 shell 命令起始行（LLM 输出包管理器/git/curl 等命令时常常遗漏 ``` 围栏）
    /^\s*(?:npm|pnpm|yarn|bun|npx|yarnpnp)\s+(?:install|i|add|remove|rm|run|exec|create|init|update|test|build|dev|start|ci|publish|pack|uninstall|ls|list|outdated|audit|fund|version)\b/,
    /^\s*git\s+(?:clone|pull|push|fetch|checkout|branch|status|add|commit|log|diff|merge|rebase|reset|stash|tag|init|remote|config|rm|mv|restore|switch)\b/,
    /^\s*(?:curl|wget|fetch|http|https)\s+\S/,
    /^\s*(?:cd|ls|cat|head|tail|less|more|file|mkdir|touch|rm|cp|mv|chmod|chown|ln|pwd|echo|printf|basename|dirname|realpath|stat|find|grep|egrep|fgrep|rg|fd|ag)\s+\S/,
    /^\s*(?:sudo|apt|apt-get|brew|dnf|yum|pacman|zypper|apk|systemctl|service|journalctl|export|source|eval|exec|env|set|unset|alias)\s+\S/,
    /^\s*(?:node|deno|bun|tsx|ts-node|tsc|eslint|prettier|jest|vitest|mocha|webpack|vite|rollup|parcel|esbuild|swc|babel)\s+\S/,
    /^\s*(?:python|python3|py|pip|pip3|conda|poetry|uv|ruby|rbenv|gem|rails|php|composer|go|rustc|cargo|java|javac|mvn|gradle|scala|perl|lua|swift)\s+\S/,
    /^\s*(?:docker|docker-compose|podman|kubectl|helm|terraform|ansible|vagrant)\s+\S/,
    /^\s*(?:tar|zip|unzip|gzip|gunzip|bzip2|xz|7z|rar)\s+\S/,
    /^\s*(?:ps|kill|killall|pkill|top|htop|jobs|nohup|watch|crontab)\s+\S/,
    /^\s*\$\s+\S/,
    /^\s*>\s+\S/,
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
    // §shell 延续识别
    /^\s*(?:npm|pnpm|yarn|bun|npx|git|curl|wget|cd|ls|cat|head|tail|less|more|file|mkdir|touch|rm|cp|mv|chmod|chown|ln|pwd|echo|printf|find|grep|egrep|fgrep|rg|fd|ag|node|deno|tsx|ts-node|tsc|docker|kubectl|helm|terraform|tar|zip|unzip|sudo|apt|apt-get|brew|python|python3|pip|pip3|ps|kill|killall|export|source|env)\b/,
    /^\s*[>$]\s+\S/,
    /^(.+\s)?(?:&&|\|\||;|\\\s*)$/,
    /^\s*#\s*\S/,
  ];
  return patterns.some(re => re.test(trimmed));
}

/**
 * 根据文件路径后缀推断语言（用于"裸露"代码块的围栏标记）。
 */
function inferLanguageFromPath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const base = filePath.split(/[\\/]/).pop() || filePath;
  const match = base.match(/\.([\w+]+)(?:\s|$|[?#])/);
  if (!match) return undefined;
  const ext = match[1].toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    json: 'json', css: 'css', scss: 'scss', less: 'css',
    html: 'html', htm: 'html', xml: 'xml',
    md: 'markdown', mdx: 'markdown',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
    java: 'java', kt: 'kotlin', swift: 'swift',
    c: 'c', h: 'c', cpp: 'cpp', cxx: 'cpp', cc: 'cpp', hpp: 'cpp',
    cs: 'csharp', php: 'php', sh: 'bash', bash: 'bash',
    sql: 'sql', yaml: 'yaml', yml: 'yaml',
    vue: 'javascript', svelte: 'javascript',
  };
  return map[ext];
}

/**
 * 在单个文本段中包裹裸代码
 */
function wrapCodeInSegment(text: string, fileHint?: string): string {
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
      if (codeLines.length >= 2) {
        if (output.length > 0 && output[output.length - 1].trim() !== '') {
          output.push('');
        }
        const code = codeLines.join('\n');
        let lang: string;
        const hintLang = inferLanguageFromPath(fileHint);
        if (hintLang) {
          lang = hintLang;
        } else if (isShellCommand(code)) {
          lang = 'bash';
        } else {
          const detected = detectCodeLanguage(code);
          lang = detected && detected !== 'bash' && detected !== 'shell' && detected !== 'sh'
            ? detected
            : 'typescript';
        }
        output.push('```' + lang);
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
 */
function wrapUnwrappedCode(content: string, fileHint?: string): string {
  const segments = content.split(/(```[\s\S]*?```)/g);
  let result = '';
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (i % 2 === 1) {
      result += seg;
      continue;
    }
    result += wrapCodeInSegment(seg, fileHint);
  }
  return result;
}

function parseOptionList(content: string): { preText: string; options: string[] } | null {
  const trimmed = content.trimEnd();

  const htmlMatch = trimmed.match(/<div\s+class=["']option-list["']\s*>([\s\S]*?)<\/div>\s*$/i);
  if (!htmlMatch) {
    return null;
  }

  const buttonRegex = /<button\s+[^>]*class=["']option-btn["'][^>]*>([\s\S]*?)<\/button>/gi;
  const options: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = buttonRegex.exec(htmlMatch[1])) !== null) {
    const text = m[1].replace(/<[^>]+>/g, '').trim();
    if (text) options.push(text);
  }

  if (options.length < 2) {
    return null;
  }

  const preText = trimmed.slice(0, trimmed.length - htmlMatch[0].length).trimEnd();
  return { preText, options };
}

/**
 * 检测并补齐未闭合的 markdown 结构
 * 解决 LLM streaming 被截断时留下未闭合代码块/表格导致 UI 崩坏
 */
function preprocessMarkdown(
  content: string,
  fileHint?: string,
): { processed: string; incomplete: boolean; reasons: string[] } {
  let result = content;
  const reasons: string[] = [];

  result = stripRedundantPreCodeWrapper(result);
  result = unwrapMisformattedCode(result);
  result = wrapUnwrappedCode(result, fileHint);

  // 1. 未闭合的代码块 fence（``` 数量为奇数）
  const fenceMatches = result.match(/```/g);
  if (fenceMatches && fenceMatches.length % 2 !== 0) {
    result += '\n\n```';
    reasons.push('代码块未闭合');
  }

  // 2. 未闭合的表格
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
/*  OptionList：单选选项列表 + 边框渲染动画                            */
/* ─────────────────────────────────────────────────────────────────── */

function OptionTooltip({ text }: { text: string }) {
  if (!text) return null;
  return (
    <span className="option-tooltip" role="tooltip">
      <span className="option-tooltip__inner">{text}</span>
    </span>
  );
}

function OptionList({ options, onSelect }: { options: string[]; onSelect: (text: string) => void }) {
  const [selected, setSelected] = useState<number | null>(null);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  return (
    <div className="option-list">
      {options.map((opt, idx) => (
        <div
          key={idx}
          className="option-btn-wrap"
          onMouseEnter={() => setHoveredIdx(idx)}
          onMouseLeave={() => setHoveredIdx((cur) => (cur === idx ? null : cur))}
          onFocus={() => setHoveredIdx(idx)}
          onBlur={() => setHoveredIdx((cur) => (cur === idx ? null : cur))}
        >
          <button
            className={`option-btn ${selected === idx ? 'option-btn--selected' : ''}`}
            style={{ animationDelay: `${idx * 80}ms` }}
            onClick={() => {
              setSelected(idx);
              onSelect(opt);
            }}
            title={opt}
            aria-label={opt}
          >
            <span className="option-btn__radio" />
            <span className="option-btn__text">{opt}</span>
          </button>
          {hoveredIdx === idx && <OptionTooltip text={opt} />}
        </div>
      ))}
    </div>
  );
}
