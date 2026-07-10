/**
 * LLM Provider 标签识别器
 *
 * 目的：不同 LLM Provider 输出的"思考/上下文/工具调用"标签格式不一致
 * - DeepSeek / Kimi / MiniMax / Doubao：<think>...</think>
 * - Qwen / GLM：<think>...</think> + <environment_details>...</environment_details>
 * - Anthropic (extended thinking)：<thinking>...</thinking>
 * - OpenAI / Ollama / Custom：不原生输出 thinking，但使用我们的公共 canonical 标签
 *
 * 公共 canonical 标签（全 provider 一致）：
 *   <reasoning>...</reasoning>, <step .../>, <shell .../>, <edit .../>...</edit>, <fileStatus .../></parameter>
 *
 * 该模块将所有 Provider 特定标签归一化为内部表示，由 ContentBlocks 渲染为统一 UI。
 */

export type ProviderId =
  | 'openai' | 'anthropic' | 'deepseek' | 'kimi' | 'MiniMax'
  | 'doubao' | 'qwen' | 'glm' | 'ollama' | 'custom';

/** 归一化后的内部标签名（与 types.ts / ContentBlocks 对应） */
export type CanonicalTagName =
  | 'reasoning' | 'edit' | 'shell' | 'fileStatus' | 'step';

/** 提取出的标签类别 */
export type ExtractedTagKind = 'thinking' | 'environment' | 'canonical';

export interface ExtractedTag {
  kind: ExtractedTagKind;
  /** 内部标签名（仅 canonical 标签有） */
  tagName?: CanonicalTagName;
  /** 标签属性字符串（例：type="read" target="..."），保留原始大小写 */
  attrs?: string;
  /** 标签内文（thinking 内容 / canonical 内容） */
  content: string;
  /** 原始匹配文本（用于调试） */
  raw: string;
  /** 在源文本中的位置 [start, end) */
  start: number;
  end: number;
}

export interface TagParseResult {
  /** 移除所有已知 provider 标签 + canonical 标签后的纯文本（用于 markdown 渲染） */
  cleanedText: string;
  /** 按位置升序排列的标签列表 */
  tags: ExtractedTag[];
  /** 未闭合的 canonical 标签（用于自动补齐，避免 markdown 解析错乱） */
  incomplete: CanonicalTagName[];
}

/* ─────────────────────────────────────────────────────────────────── */
/*  Provider 规则：每个 Provider 自己的标签格式                              */
/* ─────────────────────────────────────────────────────────────────── */

interface ProviderTagRules {
  /** 思考/推理内容（归一化为 thinking 块） */
  thinking?: RegExp;
  /** 上下文/系统信息（Qwen 风格，归一化为 environment 块） */
  environment?: RegExp;
  /** 是否输出 <step ... /> <fileStatus ... /> 公共标签 */
  supportsCanonical: boolean;
}

const PROVIDER_RULES: Record<ProviderId, ProviderTagRules> = {
  // DeepSeek：<think>...</think>
  deepseek: {
    thinking: /<think>([\s\S]*?)<\/think>/gi,
    supportsCanonical: true,
  },
  // Kimi：<think>...</think>
  kimi: {
    thinking: /<think>([\s\S]*?)<\/think>/gi,
    supportsCanonical: true,
  },
  // MiniMax：<think>...</think>
  MiniMax: {
    thinking: /<think>([\s\S]*?)<\/think>/gi,
    supportsCanonical: true,
  },
  // Doubao：<think>...</think>
  doubao: {
    thinking: /<think>([\s\S]*?)<\/think>/gi,
    supportsCanonical: true,
  },
  // Qwen：<think> + <environment_details>
  qwen: {
    thinking: /<think>([\s\S]*?)<\/think>/gi,
    environment: /<environment_details>([\s\S]*?)<\/environment_details>/gi,
    supportsCanonical: true,
  },
  // GLM：<think> + <environment_details>
  glm: {
    thinking: /<think>([\s\S]*?)<\/think>/gi,
    environment: /<environment_details>([\s\S]*?)<\/environment_details>/gi,
    supportsCanonical: true,
  },
  // Anthropic：<thinking>...</thinking>（extended thinking 模式）
  anthropic: {
    thinking: /<thinking>([\s\S]*?)<\/thinking>/gi,
    supportsCanonical: true,
  },
  // OpenAI / Ollama / Custom：不原生输出 thinking（除非 prompt 显式要求）
  openai: { supportsCanonical: true },
  ollama: { supportsCanonical: true },
  custom: { supportsCanonical: true },
};

/* ─────────────────────────────────────────────────────────────────── */
/*  公共 canonical 标签正则（全 provider 通用）                              */
/* ─────────────────────────────────────────────────────────────────── */

// 同时匹配：<reasoning>...</reasoning>、<step type="...">...</step>、<fileStatus .../>、<edit file="...">...</edit>、<shell command="...">...</shell>
const CANONICAL_PATTERN =
  /<(reasoning|edit|shell|fileStatus|step)\b([^>]*?)\/?>(?:([\s\S]*?)<\/\1>)?/gi;

/* ─────────────────────────────────────────────────────────────────── */
/*  代码块区间检测：避免误提取代码块内的 canonical 标签                      */
/* ─────────────────────────────────────────────────────────────────── */

/**
 * 提取 markdown 围栏代码块（``` 或 ~~~）的区间列表。
 * 返回的区间为 [start, end) 形式，供 isInsideCodeBlock 检测使用。
 *
 * 注意：canonical 标签如果出现在代码块内部（如 AI 回复的 JSX/HTML 代码中
 * 恰好有 <step>、<edit> 等同名标签），不应被提取——否则 removeIntervals
 * 会删除这些区间，把代码块拆碎，导致 ReactMarkdown 无法识别为代码块，
 * 代码内容被当作普通段落渲染（换行变 <br>，丢失语法高亮）。
 */
function extractCodeBlockIntervals(text: string): Array<{ start: number; end: number }> {
  const intervals: Array<{ start: number; end: number }> = [];
  // 匹配 ``` 或 ~~~ 围栏代码块（支持开头指定语言）
  const fenceRegex = /(```|~~~)([\s\S]*?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRegex.exec(text)) !== null) {
    intervals.push({ start: m.index, end: m.index + m[0].length });
  }
  // 匹配缩进式代码块（行首 4+ 空格，后跟非空内容行）——简化处理，跳过
  return intervals;
}

/** 检查位置 pos 是否位于任何代码块区间内 */
function isInsideCodeBlock(pos: number, codeBlocks: ReadonlyArray<{ start: number; end: number }>): boolean {
  for (const cb of codeBlocks) {
    if (pos >= cb.start && pos < cb.end) return true;
  }
  return false;
}

/* ─────────────────────────────────────────────────────────────────── */
/*  区间补集工具：从源串中删除一组标签区间                                   */
/* ─────────────────────────────────────────────────────────────────── */

/**
 * 从字符串中删除一组半开区间 [start, end) 并拼接剩余文本（区间补集）。
 *
 * 数学/算法说明
 * ──────────────
 *   设源串 S 长度为 n，待删除标签区间集合 R = { [sᵢ, eᵢ) }（共 k 个）。
 *
 *   · 朴素法（旧实现）：对每个区间各做一次 `slice` 拼接。每次都整串重建，
 *     单次 Θ(n)，k 个区间合计 Θ(k·n)；在流式渲染下每个 token 触发一次解析，
 *     长回复会退化成平方甚至立方级开销。更关键的是它倒序删除、用的是固定
 *     绝对索引——一旦区间重叠/嵌套（如 <think> 内嵌 <step/>），前一次删除
 *     就会让后续区间的绝对位置失效，导致 cleanedText 错位甚至越界。
 *
 *   · 线性法（本实现）：两步经典算法在同一遍扫描内完成
 *       ① 区间合并 (Merge Intervals)：输入已按 start 升序，用单调右边界
 *         pos 把重叠/嵌套区间归并为互不相交的极大删除区间，O(k)。
 *       ② 区间补集 (Complement Scan)：顺序收集相邻删除区间之间的「保留段」，
 *         最后一次性 join，单遍 O(n)。
 *     合计 Θ(n + k)，无平方级串重建，且对任意重叠/嵌套天然正确。
 *
 * @param source     源字符串 S
 * @param intervals  已按 start 升序排列的标签区间（含 start / end 字段）
 */
function removeIntervals(
  source: string,
  intervals: ReadonlyArray<{ start: number; end: number }>,
): string {
  if (intervals.length === 0) return source;

  const kept: string[] = [];
  // pos = 已删除前缀的右边界，也是下一段「保留文本」的起点。
  // 它单调不减，等价于「当前合并删除区间」的右端点。
  let pos = 0;

  for (let i = 0; i < intervals.length; i++) {
    const s = intervals[i].start;
    const e = intervals[i].end;
    if (s > pos) {
      // 与已删除前缀不相交：先收集中间的保留段 [pos, s)，再开启新删除区间。
      kept.push(source.slice(pos, s));
      pos = e;
    } else if (e > pos) {
      // 与已删除前缀重叠/嵌套/紧邻：仅向右扩展删除边界（合并），无保留段。
      pos = e;
    }
    // e <= pos：完全被已删除区间覆盖，直接跳过。
  }

  if (pos < source.length) kept.push(source.slice(pos));
  return kept.join('');
}

/* ─────────────────────────────────────────────────────────────────── */
/*  核心解析函数                                                         */
/* ─────────────────────────────────────────────────────────────────── */

/**
 * 解析文本中的所有标签，提取并归一化。
 * - provider 特定标签（thinking / environment）抽取为对应 kind
 * - canonical 标签（reasoning / step / shell / edit / fileStatus）抽取为 canonical kind
 * - cleanedText 不含任何已知标签（让 markdown 渲染更干净）
 */
export function parseProviderTags(text: string, provider: ProviderId): TagParseResult {
  if (!text) return { cleanedText: '', tags: [], incomplete: [] };

  const rules = PROVIDER_RULES[provider] || PROVIDER_RULES.custom;
  const tags: ExtractedTag[] = [];

  // 0. 提取 markdown 代码块区间，避免误提取代码块内的标签
  //    （如 JSX/HTML 代码中的 <step>、<edit> 等同名标签）
  const codeBlocks = extractCodeBlockIntervals(text);

  // 1. 提取 thinking 标签
  if (rules.thinking) {
    for (const m of text.matchAll(rules.thinking)) {
      const start = m.index!;
      // 跳过位于代码块内的匹配
      if (isInsideCodeBlock(start, codeBlocks)) continue;
      const end = start + m[0].length;
      tags.push({
        kind: 'thinking',
        content: m[1].trim(),
        raw: m[0],
        start,
        end,
      });
    }
  }

  // 1b. 通用未闭合 <think>/<thinking> 处理器（流式安全）：
  // 流式输出时 </think> 可能尚未发出，provider 正则（要求闭合标签）匹配不到，
  // 导致 <think> 内容残留在 cleanedText 中，被 extractTitle 当作标题显示。
  // 也覆盖 custom/openai/ollama 等没有 thinking 正则的 provider。
  // 模式同时匹配闭合 <think>...</think> 和未闭合 <think>...（到文本末尾）。
  // (?![\s\S]) 匹配绝对文本末尾（比 $ 更精确，不受 trailing \n 影响）。
  const universalThinkRegex = /<(think|thinking)>([\s\S]*?)(?:<\/\1>|(?![\s\S]))/gi;
  for (const m of text.matchAll(universalThinkRegex)) {
    const start = m.index!;
    if (isInsideCodeBlock(start, codeBlocks)) continue;
    const end = start + m[0].length;
    // 跳过已被 provider 正则捕获的区间（避免重复）
    const alreadyCaptured = tags.some((t) => t.start === start && t.end === end);
    if (alreadyCaptured) continue;
    tags.push({
      kind: 'thinking',
      content: m[2].trim(),
      raw: m[0],
      start,
      end,
    });
  }

  // 2. 提取 environment 标签
  if (rules.environment) {
    for (const m of text.matchAll(rules.environment)) {
      const start = m.index!;
      // 跳过位于代码块内的匹配
      if (isInsideCodeBlock(start, codeBlocks)) continue;
      const end = start + m[0].length;
      tags.push({
        kind: 'environment',
        content: m[1].trim(),
        raw: m[0],
        start,
        end,
      });
    }
  }

  // 3. 提取 canonical 标签（公共，全 provider 一致）
  if (rules.supportsCanonical) {
    // 重新创建一个 regex 实例（必须，不然 /g 状态会污染）
    const re = new RegExp(CANONICAL_PATTERN.source, 'gi');
    for (const m of text.matchAll(re)) {
      const start = m.index!;
      // 跳过位于代码块内的匹配：代码块内的 <step>、<edit> 等是代码内容，
      // 不是 AI 的步骤可视化标签，不能提取——否则会拆碎代码块
      if (isInsideCodeBlock(start, codeBlocks)) continue;
      const tagName = m[1].toLowerCase() as CanonicalTagName;
      const attrs = m[2] || '';
      const innerContent = m[3] || '';
      const end = start + m[0].length;
      tags.push({
        kind: 'canonical',
        tagName,
        attrs,
        content: innerContent,
        raw: m[0],
        start,
        end,
      });
    }
  }

  // 4. 按位置排序（便于后续按序渲染）
  tags.sort((a, b) => a.start - b.start);

  // 5. 检测未闭合的 canonical 标签（自动补齐）
  const incomplete: CanonicalTagName[] = [];
  for (const tag of tags) {
    if (tag.kind === 'canonical' && tag.end === tag.start) {
      // 自闭合标签不算未闭合
      continue;
    }
    if (tag.kind === 'canonical' && !tag.raw.endsWith(`</${tag.tagName}>`) && !tag.raw.endsWith('/>')) {
      incomplete.push(tag.tagName!);
    }
  }

  // 6. 构造 cleanedText：删除所有已知标签占据的区间（区间补集）。
  //    tags 已在第 4 步按 start 升序排列，removeIntervals 在单遍 Θ(n+k) 内
  //    完成「区间合并 + 补集拼接」，对重叠/嵌套标签天然正确——
  //    取代旧的倒序 slice（Θ(k·n) 串重建 + 重叠时索引错位）。
  const cleaned = removeIntervals(text, tags);

  return {
    cleanedText: cleaned,
    tags,
    incomplete,
  };
}

/**
 * 便捷：判断一段文本是否包含可识别的标签
 */
export function hasAnyTag(text: string, provider: ProviderId): boolean {
  if (!text) return false;
  const result = parseProviderTags(text, provider);
  return result.tags.length > 0;
}

/**
 * 调试用：返回原始匹配位置（用于日志/调试面板）
 */
export function debugDumpTags(text: string, provider: ProviderId): string {
  const result = parseProviderTags(text, provider);
  const lines: string[] = [
    `=== Tag parse dump for provider=${provider} ===`,
    `cleanedText length: ${result.cleanedText.length}, tags: ${result.tags.length}, incomplete: ${result.incomplete.length}`,
  ];
  for (const tag of result.tags) {
    lines.push(
      `  [${tag.kind}${tag.tagName ? '/' + tag.tagName : ''}] ` +
      `start=${tag.start} end=${tag.end} content_len=${tag.content.length}`
    );
  }
  return lines.join('\n');
}
