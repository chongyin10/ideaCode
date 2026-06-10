/**
 * 差异对比算法 (Diff Algorithm) — Myers O(ND) 实现
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
 * 参考：Eugene W. Myers, "An O(ND) Difference Algorithm and Its Variations"
 * ============================================================================
 */

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
