/**
 * 差异对比算法 (Diff Algorithm) — Myers O(ND) 实现 + Walsh-Hadamard 加速
 * ============================================================================
 *
 * 应用场景：
 * 1. 文件版本对比：显示两个版本文件的增删改
 * 2. Git 差异展示：行级别的增删标记
 * 3. 编辑器撤销栈：记录文本变更以便撤销/重做
 *
 * ## Myers 算法原理：
 * 编辑图 (Edit Graph)：以旧文本索引为 x 轴，新文本索引为 y 轴。
 * 横向移动 = 删除，纵向移动 = 插入，对角线移动 = 相等。
 * 最短编辑脚本对应从 (0,0) 到 (m,n) 的最短路径，其编辑次数 D 满足：
 *   D = (m + n - 2·LCS) 条非对角线边
 *
 * 核心思想：遍历编辑深度 k（-D..D 的蛇形线），找出到达每个 k 的最远位置，
 * 首次到达右下角时即为最短编辑脚本。
 *
 * 时间复杂度：O((m+n)×D)，D = 编辑距离（通常远小于 m+n）
 * 空间复杂度：O(m+n)（只保留前后两条蛇形线状态）
 *
 * ## Walsh-Hadamard 加速：
 * 对超过阈值的文本，先计算每行的 FWHT 签名，按签名相似度预聚类。
 * 在聚类内部做精确 Myers/LCS diff，将 O(L²) 降为 O(L log L + K·C²)。
 *
 * 参考：Eugene W. Myers, "An O(ND) Difference Algorithm and Its Variations"
 * ============================================================================
 */

import { WalshLineClusterer } from './walshHadamard';

export type DiffType = 'equal' | 'insert' | 'delete';

export interface DiffChunk {
  type: DiffType;
  oldLine: number | null;
  newLine: number | null;
  content: string;
}

export interface DiffResult {
  chunks: DiffChunk[];
  stats: {
    insertions: number;
    deletions: number;
    unchanged: number;
  };
}

/** 蛇形线的最远距离数组：V[k] = 到达中心对角线偏移 k 的最远 x 坐标 */
function myersDiff(oldLines: string[], newLines: string[]): DiffChunk[] {
  const m = oldLines.length;
  const n = newLines.length;
  const max = m + n;

  // V 数组存储到达每条蛇形线的最远 x 坐标
  // 使用两个数组交替（prev/curr）实现 O(max) 空间
  let prevV = new Int32Array(2 * max + 1);
  let currV = new Int32Array(2 * max + 1);
  // trace[k] = 记录每步的 V 快照，用于回溯
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    trace.push(new Int32Array(2 * max + 1));

    for (let k = -d; k <= d; k += 2) {
      const kIdx = k + max;

      // 选择起点：优先向右（delete），除非向下（insert）能到达更远
      let x: number;
      if (k === -d || (k !== d && prevV[k - 1 + max] < prevV[k + 1 + max])) {
        x = prevV[k + 1 + max]; // 来自下方 → 删除
      } else {
        x = prevV[k - 1 + max] + 1; // 来自右方 → 插入
      }
      let y = x - k;

      // 沿对角线尽可能延伸（匹配行）
      while (x < m && y < n && oldLines[x] === newLines[y]) {
        x++;
        y++;
      }

      currV[kIdx] = x;

      if (x >= m && y >= n) {
        trace[d] = currV;
        return backtrackMyers(oldLines, newLines, trace, d, k);
      }
    }

    // 交换滚动数组
    const tmp = prevV;
    prevV = currV;
    currV = tmp;
  }

  return [];
}

/** 回溯 Myers 路径，生成 DiffChunk */
function backtrackMyers(
  oldLines: string[],
  newLines: string[],
  trace: Int32Array[],
  d: number,
  k: number
): DiffChunk[] {
  const max = oldLines.length + newLines.length;
  let x = oldLines.length;
  let y = newLines.length;
  const path: { type: DiffType; oldIdx: number; newIdx: number }[] = [];

  for (let dd = d; dd >= 0; dd--) {
    const V = trace[dd];

    const prevK: number =
      k === -dd || (k !== dd && V[k - 1 + max] < V[k + 1 + max])
        ? k + 1
        : k - 1;

    const prevX = V[prevK + max];
    const prevY = prevX - prevK;

    // 对角线匹配
    while (x > prevX && y > prevY) {
      x--;
      y--;
      path.unshift({ type: 'equal', oldIdx: x, newIdx: y });
    }

    if (dd > 0) {
      if (prevK === k + 1) {
        // 来自下方 → 删除
        x--;
        path.unshift({ type: 'delete', oldIdx: x, newIdx: -1 });
      } else {
        // 来自右方 → 插入
        y--;
        path.unshift({ type: 'insert', oldIdx: -1, newIdx: y });
      }
    }

    k = prevK;
  }

  return path.map((p) => ({
    type: p.type,
    oldLine: p.type !== 'insert' ? p.oldIdx + 1 : null,
    newLine: p.type !== 'delete' ? p.newIdx + 1 : null,
    content:
      p.type === 'delete'
        ? oldLines[p.oldIdx]
        : p.type === 'insert'
        ? newLines[p.newIdx]
        : oldLines[p.oldIdx],
  }));
}

/* ─── Patience Diff (锚点算法) ─── */

/**
 * Patience Diff
 *
 * 核心思想: 找出两边都唯一出现的行作为"锚点"（数学不动点），
 * 在锚点之间递归做 Myers。对代码移动场景鲁棒性远好于纯 Myers。
 *
 * 锚点条件: hash(line) 在两边各出现恰好 1 次
 *
 * 时间复杂度: 平均 O(n log n)，最坏 O(n²) (退化为 Myers)
 */
export function patienceDiff(oldLines: string[], newLines: string[]): DiffChunk[] {
  // 找出两边的唯一行作为锚点
  const oldCounts = new Map<string, number>();
  const newCounts = new Map<string, number>();

  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) || 0) + 1);
  for (const line of newLines) newCounts.set(line, (newCounts.get(line) || 0) + 1);

  // 锚点: 两边都唯一出现
  const anchors: Array<{ oldIdx: number; newIdx: number; content: string }> = [];
  for (let oi = 0, ni = 0; oi < oldLines.length && ni < newLines.length; ) {
    const oldLine = oldLines[oi];
    if (oldCounts.get(oldLine) === 1 && newCounts.get(oldLine) === 1) {
      // 找到 newLines 中对应位置
      let foundNi = -1;
      for (let j = ni; j < newLines.length; j++) {
        if (newLines[j] === oldLine) { foundNi = j; break; }
      }
      if (foundNi >= 0) {
        anchors.push({ oldIdx: oi, newIdx: foundNi, content: oldLine });
        oi = foundNi < oi ? oi + 1 : oi; // 确保 oi 前进
      }
    }
    oi++;
  }

  // 重新计算锚点: 使用更精确的 LCS 方式找共同唯一行
  const preciseAnchors: Array<{ oldIdx: number; newIdx: number }> = [];
  {
    const oldUnique = new Map<string, number>();
    const newUnique = new Map<string, number>();
    for (let i = 0; i < oldLines.length; i++) {
      if (oldCounts.get(oldLines[i]) === 1) oldUnique.set(oldLines[i], i);
    }
    for (let i = 0; i < newLines.length; i++) {
      if (newCounts.get(newLines[i]) === 1) newUnique.set(newLines[i], i);
    }
    // 共同唯一行，按 oldIdx 排序
    const common = Array.from(oldUnique.entries())
      .filter(([line]) => newUnique.has(line))
      .map(([line, oldIdx]) => ({ oldIdx, newIdx: newUnique.get(line)!, content: line }))
      .sort((a, b) => a.oldIdx - b.oldIdx);

    // 筛选 newIdx 也递增的锚点 (LIS)
    for (const anchor of common) {
      const last = preciseAnchors[preciseAnchors.length - 1];
      if (!last || anchor.newIdx > last.newIdx) {
        preciseAnchors.push({ oldIdx: anchor.oldIdx, newIdx: anchor.newIdx });
      }
    }
  }

  // 在锚点之间递归做 Myers
  const result: DiffChunk[] = [];
  let prevOldEnd = -1;
  let prevNewEnd = -1;

  for (const anchor of preciseAnchors) {
    // 锚点之间的区间做 Myers
    const oldSlice = oldLines.slice(prevOldEnd + 1, anchor.oldIdx);
    const newSlice = newLines.slice(prevNewEnd + 1, anchor.newIdx);
    if (oldSlice.length > 0 || newSlice.length > 0) {
      const subChunks = myersDiff(oldSlice, newSlice);
      // 调整行号
      for (const chunk of subChunks) {
        result.push({
          ...chunk,
          oldLine: chunk.oldLine !== null ? chunk.oldLine + prevOldEnd + 1 : null,
          newLine: chunk.newLine !== null ? chunk.newLine + prevNewEnd + 1 : null,
        });
      }
    }

    // 锚点本身
    result.push({
      type: 'equal',
      oldLine: anchor.oldIdx + 1,
      newLine: anchor.newIdx + 1,
      content: oldLines[anchor.oldIdx],
    });

    prevOldEnd = anchor.oldIdx;
    prevNewEnd = anchor.newIdx;
  }

  // 最后一个锚点之后的尾部
  const oldTail = oldLines.slice(prevOldEnd + 1);
  const newTail = newLines.slice(prevNewEnd + 1);
  if (oldTail.length > 0 || newTail.length > 0) {
    const subChunks = myersDiff(oldTail, newTail);
    for (const chunk of subChunks) {
      result.push({
        ...chunk,
        oldLine: chunk.oldLine !== null ? chunk.oldLine + prevOldEnd + 1 : null,
        newLine: chunk.newLine !== null ? chunk.newLine + prevNewEnd + 1 : null,
      });
    }
  }

  return result;
}

/**
 * Patience Diff 主入口
 */
export function computePatienceDiff(oldText: string, newText: string): DiffResult {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  if (oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines[newLines.length - 1] === '') newLines.pop();

  const chunks = patienceDiff(oldLines, newLines);
  const compressed = compressChunks(chunks);

  const stats = {
    insertions: chunks.filter((c) => c.type === 'insert').length,
    deletions: chunks.filter((c) => c.type === 'delete').length,
    unchanged: chunks.filter((c) => c.type === 'equal').length,
  };

  return { chunks: compressed, stats };
}

/* ─── GumTree 风格 AST 语义差异 (基于 token 结构) ─── */

/**
 * 结构化差异 (GumTree 启发)
 *
 * 由于无法直接获取 AST (需要 tsserver)，使用 token 结构近似:
 * 1. 对每行代码做结构化分词 (标识符/关键字/标点/字符串/数字)
 * 2. 计算行的结构指纹 (token 类型序列的哈希)
 * 3. 结构指纹相同的行视为"移动"而非"增删"
 *
 * 输出 Move/Update/Insert/Delete 四类操作
 */
export interface SemanticDiffChunk {
  type: 'equal' | 'insert' | 'delete' | 'move' | 'update';
  oldLine: number | null;
  newLine: number | null;
  content: string;
  /** 结构指纹 (用于 move 检测) */
  structuralHash?: number;
}

/**
 * 计算行的结构指纹
 * 将 token 替换为类型代号后哈希，忽略变量名差异
 */
function structuralHash(line: string): number {
  const tokens = tokenizeLine(line);
  let hash = 0;
  for (const token of tokens) {
    let typeCode = 0;
    if (/^\s+$/.test(token)) typeCode = 1;        // 空白
    else if (/^[a-zA-Z_$]/.test(token)) {          // 标识符/关键字
      // 关键字保持，变量名统一为 ID
      typeCode = KEYWORDS.has(token) ? 2 : 3;
    }
    else if (/^[0-9]/.test(token)) typeCode = 4;   // 数字
    else if (token.startsWith('"') || token.startsWith("'") || token.startsWith('`')) typeCode = 5; // 字符串
    else typeCode = 6;                              // 标点

    hash = Math.imul(hash * 31 + typeCode, 0x9e3779b9) >>> 0;
  }
  return hash;
}

const KEYWORDS = new Set([
  'function', 'const', 'let', 'var', 'if', 'else', 'for', 'while', 'return',
  'class', 'extends', 'import', 'export', 'from', 'default', 'async', 'await',
  'try', 'catch', 'finally', 'throw', 'new', 'typeof', 'instanceof', 'in', 'of',
  'this', 'super', 'static', 'get', 'set', 'public', 'private', 'protected',
  'interface', 'type', 'enum', 'namespace', 'declare', 'abstract', 'readonly',
  'def', 'elif', 'pass', 'lambda', 'with', 'as', 'yield', 'raise', 'None', 'True', 'False',
]);

/**
 * 语义差异比较
 *
 * 1. 先用 Patience Diff 做行级匹配
 * 2. 对 delete+insert 对检测结构指纹，相同则为 move
 * 3. 对 update 行做 token 级差异
 */
export function semanticDiff(oldText: string, newText: string): SemanticDiffChunk[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  if (oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines[newLines.length - 1] === '') newLines.pop();

  const baseChunks = patienceDiff(oldLines, newLines);
  const result: SemanticDiffChunk[] = [];

  // 计算所有行的结构指纹
  const oldHashes = oldLines.map(structuralHash);
  const newHashes = newLines.map(structuralHash);

  // 已删除行的指纹集合 (用于 move 检测)
  const deletedByHash = new Map<number, DiffChunk[]>();
  const insertedByHash = new Map<number, DiffChunk[]>();

  for (const chunk of baseChunks) {
    if (chunk.type === 'delete') {
      const hash = chunk.oldLine !== null ? oldHashes[chunk.oldLine - 1] : 0;
      if (!deletedByHash.has(hash)) deletedByHash.set(hash, []);
      deletedByHash.get(hash)!.push(chunk);
    } else if (chunk.type === 'insert') {
      const hash = chunk.newLine !== null ? newHashes[chunk.newLine - 1] : 0;
      if (!insertedByHash.has(hash)) insertedByHash.set(hash, []);
      insertedByHash.get(hash)!.push(chunk);
    }
  }

  // 合并: delete+insert 同指纹 → move
  const usedDeletes = new Set<DiffChunk>();
  const usedInserts = new Set<DiffChunk>();

  for (const chunk of baseChunks) {
    if (chunk.type === 'delete') {
      const hash = chunk.oldLine !== null ? oldHashes[chunk.oldLine - 1] : 0;
      const matchingInserts = insertedByHash.get(hash);
      if (matchingInserts && matchingInserts.length > 0 && !usedDeletes.has(chunk)) {
        const ins = matchingInserts.find((i) => !usedInserts.has(i));
        if (ins) {
          usedDeletes.add(chunk);
          usedInserts.add(ins);
          result.push({
            type: 'move',
            oldLine: chunk.oldLine,
            newLine: ins.newLine,
            content: ins.content,
            structuralHash: hash,
          });
          continue;
        }
      }
    }
    if (chunk.type === 'insert' && usedInserts.has(chunk)) continue;
    if (chunk.type === 'delete' && usedDeletes.has(chunk)) continue;

    result.push({ ...chunk, structuralHash: undefined });
  }

  return result;
}

export function computeDiff(oldText: string, newText: string): DiffResult {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  if (oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines[newLines.length - 1] === '') newLines.pop();

  const chunks = myersDiff(oldLines, newLines);
  const compressed = compressChunks(chunks);

  const stats = {
    insertions: chunks.filter((c) => c.type === 'insert').length,
    deletions: chunks.filter((c) => c.type === 'delete').length,
    unchanged: chunks.filter((c) => c.type === 'equal').length,
  };

  return { chunks: compressed, stats };
}

function compressChunks(chunks: DiffChunk[]): DiffChunk[] {
  if (chunks.length === 0) return [];

  const result: DiffChunk[] = [];
  let current = chunks[0];
  let currentCount = 1;

  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i];

    if (chunk.type === current.type && chunk.type === 'equal') {
      currentCount++;
      if (currentCount <= 3) {
        result.push(current);
        current = chunk;
      }
    } else {
      if (currentCount > 3) {
        result.push({
          type: 'equal',
          oldLine: null,
          newLine: null,
          content: `... (${currentCount - 3} 行相同内容) ...`,
        });
      } else if (current.type !== 'equal' || currentCount <= 3) {
        result.push(current);
      }
      current = chunk;
      currentCount = 1;
    }
  }

  if (currentCount > 3 && current.type === 'equal') {
    result.push({
      type: 'equal',
      oldLine: null,
      newLine: null,
      content: `... (${currentCount - 3} 行相同内容) ...`,
    });
  } else {
    result.push(current);
  }

  return result;
}

export function formatUnifiedDiff(
  oldText: string,
  newText: string,
  oldFileName = 'a/file',
  newFileName = 'b/file'
): string {
  const { chunks } = computeDiff(oldText, newText);
  const lines: string[] = [];

  lines.push(`--- ${oldFileName}`);
  lines.push(`+++ ${newFileName}`);

  for (const chunk of chunks) {
    if (chunk.type === 'equal') {
      lines.push(` ${chunk.content}`);
    } else if (chunk.type === 'insert') {
      lines.push(`+${chunk.content}`);
    } else if (chunk.type === 'delete') {
      lines.push(`-${chunk.content}`);
    }
  }

  return lines.join('\n');
}

export function inlineDiff(oldLine: string, newLine: string): {
  type: DiffType;
  text: string;
}[] {
  const oldChars = Array.from(oldLine);
  const newChars = Array.from(newLine);

  // 使用 LCS 找公共部分
  const m = oldChars.length;
  const n = newChars.length;
  const dp = new Array(n + 1).fill(0);
  const prevArr = new Array(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldChars[i - 1] === newChars[j - 1]) {
        dp[j] = prevArr[j - 1] + 1;
      } else {
        dp[j] = Math.max(prevArr[j], dp[j - 1]);
      }
    }
    for (let j = 0; j <= n; j++) prevArr[j] = dp[j];
  }

  const result: { type: DiffType; text: string }[] = [];
  let i = m;
  let j = n;

  // 回溯构建差异
  const segments: { type: DiffType; text: string }[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldChars[i - 1] === newChars[j - 1]) {
      segments.unshift({ type: 'equal', text: oldChars[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[j] === dp[j - 1])) {
      segments.unshift({ type: 'insert', text: newChars[j - 1] });
      j--;
    } else if (i > 0) {
      segments.unshift({ type: 'delete', text: oldChars[i - 1] });
      i--;
    }
  }

  // 合并连续同类型段
  for (const seg of segments) {
    const last = result[result.length - 1];
    if (last && last.type === seg.type) {
      last.text += seg.text;
    } else {
      result.push({ ...seg });
    }
  }

  return result;
}

export function diffToHtml(result: DiffResult): string {
  const lines: string[] = [];

  for (const chunk of result.chunks) {
    const lineNum =
      chunk.oldLine !== null && chunk.newLine !== null
        ? `${chunk.oldLine.toString().padStart(4, ' ')} ${chunk.newLine.toString().padStart(4, ' ')}`
        : chunk.oldLine !== null
        ? `${chunk.oldLine.toString().padStart(4, ' ')}     `
        : `     ${chunk.newLine!.toString().padStart(4, ' ')}`;

    const prefix =
      chunk.type === 'equal' ? ' ' : chunk.type === 'insert' ? '+' : '-';

    const className =
      chunk.type === 'equal'
        ? 'diff-equal'
        : chunk.type === 'insert'
        ? 'diff-insert'
        : 'diff-delete';

    lines.push(
      `<div class="${className}"><span class="diff-linenum">${lineNum}</span> ${prefix}${escapeHtml(chunk.content)}</div>`
    );
  }

  return lines.join('\n');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ─── 语法感知差异比较 ─── */

/**
 * 计算行级 Hash（用于 Myers 快速匹配）
 */
function lineHash(line: string): number {
  let hash = 0;
  for (let i = 0; i < line.length; i++) {
    hash = ((hash << 5) - hash + line.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * Walsh-Hadamard 加速版 Diff (大文本优化)
 *
 * 当文本行数 ≥ 200 行时自动启用：
 *  1. 计算所有行的 Walsh-Hadamard 签名
 *  2. 在新旧文本间找高相似度行对作为锚点
 *  3. 在锚点间用 Myers Diff
 *
 * 复杂度：O(L log L + K·D²)，其中 K ≤ L/ancHorCount
 */
export function computeDiffFast(oldText: string, newText: string): DiffResult {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  if (oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines[newLines.length - 1] === '') newLines.pop();

  // 小文本直接使用标准 Myers
  if (oldLines.length < 200 && newLines.length < 200) {
    return computeDiff(oldText, newText);
  }

  // Walsh-Hadamard 预聚类
  const clusterer = new WalshLineClusterer(8);
  clusterer.indexLines([...oldLines, ...newLines]);

  // 寻找锚点行对
  const anchorCandidates = clusterer.findAnchorCandidates(
    oldLines.map((_, i) => i),
    oldLines.map((_, i) => i + oldLines.length),
    0.75,
  );

  // 筛选有效锚点（newIdx = original - oldLines.length）
  const anchors: Array<{ oldIdx: number; newIdx: number }> = [];
  for (const cand of anchorCandidates) {
    const newIdx = cand.newIdx - oldLines.length;
    if (newIdx >= 0 && newIdx < newLines.length) {
      // 验证内容一致
      if (oldLines[cand.oldIdx] === newLines[newIdx]) {
        anchors.push({ oldIdx: cand.oldIdx, newIdx });
      }
    }
  }

  // 按 oldIdx 排序并去除重复 newIdx
  anchors.sort((a, b) => a.oldIdx - b.oldIdx);
  const filtered: typeof anchors = [];
  let lastNew = -1;
  for (const a of anchors) {
    if (a.newIdx > lastNew) {
      filtered.push(a);
      lastNew = a.newIdx;
    }
  }

  // 在锚点间用 Myers diff
  const result: DiffChunk[] = [];
  let prevOld = -1;
  let prevNew = -1;

  for (const anchor of filtered) {
    const oldSlice = oldLines.slice(prevOld + 1, anchor.oldIdx);
    const newSlice = newLines.slice(prevNew + 1, anchor.newIdx);
    if (oldSlice.length > 0 || newSlice.length > 0) {
      const subChunks = myersDiff(oldSlice, newSlice);
      for (const chunk of subChunks) {
        result.push({
          ...chunk,
          oldLine: chunk.oldLine !== null ? chunk.oldLine + prevOld + 1 : null,
          newLine: chunk.newLine !== null ? chunk.newLine + prevNew + 1 : null,
        });
      }
    }
    result.push({
      type: 'equal',
      oldLine: anchor.oldIdx + 1,
      newLine: anchor.newIdx + 1,
      content: oldLines[anchor.oldIdx],
    });
    prevOld = anchor.oldIdx;
    prevNew = anchor.newIdx;
  }

  // 尾部
  const oldTail = oldLines.slice(prevOld + 1);
  const newTail = newLines.slice(prevNew + 1);
  if (oldTail.length > 0 || newTail.length > 0) {
    const subChunks = myersDiff(oldTail, newTail);
    for (const chunk of subChunks) {
      result.push({
        ...chunk,
        oldLine: chunk.oldLine !== null ? chunk.oldLine + prevOld + 1 : null,
        newLine: chunk.newLine !== null ? chunk.newLine + prevNew + 1 : null,
      });
    }
  }

  const compressed = compressChunks(result);
  const stats = {
    insertions: result.filter((c) => c.type === 'insert').length,
    deletions: result.filter((c) => c.type === 'delete').length,
    unchanged: result.filter((c) => c.type === 'equal').length,
  };

  clusterer.clear();
  return { chunks: compressed, stats };
}

/**
 * 基于词法分析的分词差异
 *
 * 将代码行拆分为 token（标识符、关键字、标点、空白等），
 * 然后对 token 序列做 LCS/Meyers 差异比较。
 * 相比逐字符比较，语法感知的差异能正确识别重命名/格式化等无心之变。
 *
 * 简化实现：将每行按 camelCase、标点、空白分词
 */
function tokenizeLine(line: string): string[] {
  if (!line) return [''];
  // 按标识符边界、标点、空白分词
  const tokens: string[] = [];
  let current = '';
  for (const ch of line) {
    if (/\s/.test(ch)) {
      if (current) { tokens.push(current); current = ''; }
      tokens.push(ch);
    } else if (/[^a-zA-Z0-9_]/.test(ch)) {
      if (current) { tokens.push(current); current = ''; }
      tokens.push(ch);
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * 语法感知的行级差异
 *
 * 对两行代码做 token 级别的差异比较，区分：
 * - 标识符重命名（token 不同但语法角色相同）
 * - 字面量变化（数字/字符串不同）
 * - 格式变化（仅空白变化）
 *
 * @returns 带 token 差异信息的行对比结果
 */
export interface GrammarDiffLine {
  oldLine: number | null;
  newLine: number | null;
  oldContent: string;
  newContent: string;
  type: 'equal' | 'modified' | 'inserted' | 'deleted';
  /** token 级别的精细差异 */
  tokenDiff?: Array<{
    type: 'equal' | 'changed' | 'inserted' | 'deleted';
    oldText: string;
    newText: string;
  }>;
  /** 是否为仅格式变化（只有空白不同） */
  isFormatOnly?: boolean;
}

function computeTokenDiff(oldLine: string, newLine: string): {
  tokenDiff: GrammarDiffLine['tokenDiff'];
  isFormatOnly: boolean;
} {
  const oldTokens = tokenizeLine(oldLine);
  const newTokens = tokenizeLine(newLine);

  // 简化的 LCS token diff
  const m = oldTokens.length;
  const n = newTokens.length;
  const dp = new Int32Array((m + 1) * (n + 1));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldTokens[i - 1] === newTokens[j - 1]) {
        dp[i * (n + 1) + j] = dp[(i - 1) * (n + 1) + (j - 1)] + 1;
      } else {
        dp[i * (n + 1) + j] = Math.max(
          dp[(i - 1) * (n + 1) + j],
          dp[i * (n + 1) + (j - 1)]
        );
      }
    }
  }

  // 回溯构建 token diff
  type TokenDiffItem = NonNullable<GrammarDiffLine['tokenDiff']>[number];
  const tokenDiff: TokenDiffItem[] = [];
  let i = m, j = n;

  const backtrack: TokenDiffItem[] = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldTokens[i - 1] === newTokens[j - 1]) {
      backtrack.unshift({ type: 'equal', oldText: oldTokens[i - 1], newText: newTokens[j - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i * (n + 1) + (j - 1)] >= dp[(i - 1) * (n + 1) + j])) {
      backtrack.unshift({ type: 'inserted', oldText: '', newText: newTokens[j - 1] });
      j--;
    } else if (i > 0) {
      backtrack.unshift({ type: 'deleted', oldText: oldTokens[i - 1], newText: '' });
      i--;
    }
  }

  // 合并相邻相同类型项 + 检测纯格式变化
  let isFormatOnly = true;
  for (const item of backtrack) {
    const last = tokenDiff[tokenDiff.length - 1];
    if (last && last.type === item.type) {
      last.oldText += item.oldText;
      last.newText += item.newText;
    } else {
      tokenDiff.push({ ...item });
    }

    // 检查是否只有空白差异
    if (item.type !== 'equal') {
      const combinedOld = item.oldText.replace(/\s/g, '');
      const combinedNew = item.newText.replace(/\s/g, '');
      if (combinedOld !== combinedNew && item.oldText.trim() !== item.newText.trim()) {
        isFormatOnly = false;
      }
    }
  }

  return { tokenDiff, isFormatOnly };
}

/**
 * 语法感知差异比较（主函数）
 *
 * 先做行级 Myers Diff，对每对 modified 行再做 token 级精细 diff
 */
export function grammarAwareDiff(
  oldText: string,
  newText: string
): GrammarDiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  if (oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines[newLines.length - 1] === '') newLines.pop();

  const lineChunks = computeDiff(oldText, newText).chunks;
  const result: GrammarDiffLine[] = [];

  let oldLineIdx = 0;
  let newLineIdx = 0;

  for (const chunk of lineChunks) {
    if (chunk.type === 'equal') {
      for (const line of oldLines.slice(oldLineIdx, oldLineIdx + 1)) {
        // 找到对应行的内容
        const oldContent = line || '';
        const newContent = newLines[newLineIdx] || '';
        result.push({
          oldLine: chunk.oldLine !== null ? oldLineIdx + 1 : null,
          newLine: chunk.newLine !== null ? newLineIdx + 1 : null,
          oldContent,
          newContent,
          type: 'equal',
          tokenDiff: [{ type: 'equal', oldText: oldContent, newText: newContent }],
          isFormatOnly: false,
        });
        oldLineIdx++;
        newLineIdx++;
        if (oldLineIdx >= oldLines.length || newLineIdx >= newLines.length) break;
      }
    } else if (chunk.type === 'delete') {
      result.push({
        oldLine: oldLineIdx + 1,
        newLine: null,
        oldContent: chunk.content,
        newContent: '',
        type: 'deleted',
      });
      oldLineIdx++;
    } else if (chunk.type === 'insert') {
      result.push({
        oldLine: null,
        newLine: newLineIdx + 1,
        oldContent: '',
        newContent: chunk.content,
        type: 'inserted',
      });
      newLineIdx++;
    }
  }

  // 第二遍：合并相邻的 delete + insert 为 modified，并做 token diff
  const merged: GrammarDiffLine[] = [];
  let i = 0;
  while (i < result.length) {
    if (
      result[i]?.type === 'deleted' &&
      i + 1 < result.length &&
      result[i + 1]?.type === 'inserted'
    ) {
      const delLine = result[i];
      const insLine = result[i + 1];
      const { tokenDiff: td, isFormatOnly } = computeTokenDiff(
        delLine.oldContent,
        insLine.newContent
      );
      merged.push({
        oldLine: delLine.oldLine,
        newLine: insLine.newLine,
        oldContent: delLine.oldContent,
        newContent: insLine.newContent,
        type: 'modified',
        tokenDiff: td,
        isFormatOnly,
      });
      i += 2;
    } else {
      merged.push(result[i]);
      i++;
    }
  }

  return merged;
}
