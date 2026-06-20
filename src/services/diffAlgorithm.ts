/**
 * 行级 Diff 算法模块
 *
 * 基于 Myers 最短编辑脚本（SES）算法，计算两个文本行序列的最优差异。
 * 时间复杂度 O((N+M)D)，其中 D 为差异度。
 *
 * 参考: Eugene W. Myers, "An O(ND) Difference Algorithm and Its Variations"
 */

export interface DiffLine {
  /** 行内容 */
  content: string;
  /** 原始行号（1-based），删除行无此值 */
  oldLine?: number;
  /** 新行号（1-based），新增行无此值 */
  newLine?: number;
  /** 差异类型 */
  type: 'equal' | 'insert' | 'delete';
  /** 是否为空白行差异（仅空格/制表符变化） */
  isWhitespaceOnly?: boolean;
}


/**
 * 计算 Myers 差分路径
 * @param oldLines 原始行数组
 * @param newLines 新行数组
 * @returns 编辑操作序列
 */
function myersDiff(oldLines: string[], newLines: string[]): Array<{ type: 'equal' | 'insert' | 'delete'; oldIndex: number; newIndex: number; count: number }> {
  const n = oldLines.length;
  const m = newLines.length;

  // 边界情况：空文件
  if (n === 0 && m === 0) return [];
  if (n === 0) return [{ type: 'insert', oldIndex: 0, newIndex: 0, count: m }];
  if (m === 0) return [{ type: 'delete', oldIndex: 0, newIndex: 0, count: n }];

  const maxD = n + m;
  const size = 2 * maxD + 1;
  const v = new Int32Array(size);
  const trace: Int32Array[] = [];

  // 使用哈希比较行，避免长字符串重复比较
  const oldHashes = oldLines.map((line) => hashLine(line));
  const newHashes = newLines.map((line) => hashLine(line));

  for (let d = 0; d <= maxD; d++) {
    trace.push(new Int32Array(v));

    for (let k = -d; k <= d; k += 2) {
      let x: number;
      const idx = k + maxD;

      if (k === -d || (k !== d && v[idx - 1] < v[idx + 1])) {
        x = v[idx + 1];
      } else {
        x = v[idx - 1] + 1;
      }

      let y = x - k;

      // 沿对角线移动（匹配相同行）
      while (x < n && y < m && oldHashes[x] === newHashes[y]) {
        x++;
        y++;
      }

      v[idx] = x;

      if (x >= n && y >= m) {
        return backtrack(trace, d, k, maxD, n, m);
      }
    }
  }

  return [{ type: 'equal', oldIndex: 0, newIndex: 0, count: Math.min(n, m) }];
}

/**
 * 从追踪数组回溯生成编辑脚本
 */
function backtrack(
  trace: Int32Array[],
  d: number,
  k: number,
  maxD: number,
  n: number,
  m: number,
): Array<{ type: 'equal' | 'insert' | 'delete'; oldIndex: number; newIndex: number; count: number }> {
  const result: Array<{ type: 'equal' | 'insert' | 'delete'; oldIndex: number; newIndex: number; count: number }> = [];
  let x = n;
  let y = m;

  for (let i = d; i > 0; i--) {
    const v = trace[i];
    const idx = k + maxD;

    let prevK: number;
    if (k === -i || (k !== i && v[idx - 1] < v[idx + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }

    const prevX = trace[i - 1][prevK + maxD];
    const prevY = prevX - prevK;

    // 记录从 (prevX, prevY) 到 (x, y) 的操作
    const moveX = x - prevX;
    const moveY = y - prevY;

    if (moveX > 0 && moveY > 0) {
      // 对角线移动 = 相等行
      const equalCount = Math.min(moveX, moveY);
      result.push({ type: 'equal', oldIndex: prevX, newIndex: prevY, count: equalCount });
    }

    if (moveX > moveY) {
      // 水平移动 = 删除
      result.push({ type: 'delete', oldIndex: prevX + Math.min(moveX, moveY), newIndex: prevY + Math.min(moveX, moveY), count: moveX - moveY });
    } else if (moveY > moveX) {
      // 垂直移动 = 插入
      result.push({ type: 'insert', oldIndex: prevX + Math.min(moveX, moveY), newIndex: prevY + Math.min(moveX, moveY), count: moveY - moveX });
    }

    x = prevX;
    y = prevY;
    k = prevK;
  }

  // 处理 d=0 时的对角线
  if (x > 0 && y > 0) {
    const equalCount = Math.min(x, y);
    result.push({ type: 'equal', oldIndex: 0, newIndex: 0, count: equalCount });
  }

  result.reverse();
  return mergeOperations(result);
}

/**
 * 合并连续的相同类型操作
 */
function mergeOperations(
  ops: Array<{ type: 'equal' | 'insert' | 'delete'; oldIndex: number; newIndex: number; count: number }>,
): Array<{ type: 'equal' | 'insert' | 'delete'; oldIndex: number; newIndex: number; count: number }> {
  if (ops.length <= 1) return ops;

  const merged: typeof ops = [];
  let current = ops[0];

  for (let i = 1; i < ops.length; i++) {
    const next = ops[i];
    if (next.type === current.type) {
      current = {
        ...current,
        count: current.count + next.count,
      };
    } else {
      merged.push(current);
      current = next;
    }
  }
  merged.push(current);

  return merged;
}

/**
 * 计算行的哈希值，用于快速比较
 */
function hashLine(line: string): number {
  let hash = 0;
  for (let i = 0; i < line.length; i++) {
    hash = ((hash << 5) - hash + line.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * 计算两个文本的完整行级差异
 * @param original 原始文本
 * @param modified 修改后文本
 * @returns 差异行数组
 */
export function computeLineDiff(original: string, modified: string): DiffLine[] {
  const oldLines = original.split('\n');
  const newLines = modified.split('\n');

  // 处理末尾空行
  if (oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines[newLines.length - 1] === '') newLines.pop();

  const ops = myersDiff(oldLines, newLines);
  const result: DiffLine[] = [];

  let oldLineNum = 1;
  let newLineNum = 1;

  for (const op of ops) {
    switch (op.type) {
      case 'equal': {
        for (let i = 0; i < op.count; i++) {
          const oldIdx = op.oldIndex + i;
          result.push({
            content: oldLines[oldIdx],
            oldLine: oldLineNum++,
            newLine: newLineNum++,
            type: 'equal',
          });
        }
        break;
      }
      case 'delete': {
        for (let i = 0; i < op.count; i++) {
          const oldIdx = op.oldIndex + i;
          result.push({
            content: oldLines[oldIdx],
            oldLine: oldLineNum++,
            type: 'delete',
          });
        }
        break;
      }
      case 'insert': {
        for (let i = 0; i < op.count; i++) {
          const newIdx = op.newIndex + i;
          result.push({
            content: newLines[newIdx],
            newLine: newLineNum++,
            type: 'insert',
          });
        }
        break;
      }
    }
  }

  return result;
}

/**
 * 计算字符级差异（用于行内高亮）
 * 使用简化的 LCS 算法
 */
export interface CharDiff {
  type: 'equal' | 'insert' | 'delete';
  text: string;
}

export function computeCharDiff(oldText: string, newText: string): CharDiff[] {
  if (oldText === newText) return [{ type: 'equal', text: oldText }];

  const m = oldText.length;
  const n = newText.length;

  // 小文本使用动态规划，大文本使用简化算法
  if (m * n > 10000) {
    return computeCharDiffSimple(oldText, newText);
  }

  // 动态规划计算 LCS
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldText[i - 1] === newText[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // 回溯生成差异
  const result: CharDiff[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldText[i - 1] === newText[j - 1]) {
      result.push({ type: 'equal', text: oldText[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: 'insert', text: newText[j - 1] });
      j--;
    } else {
      result.push({ type: 'delete', text: oldText[i - 1] });
      i--;
    }
  }

  result.reverse();
  return mergeCharDiff(result);
}

/**
 * 简化字符差异（用于大文本）
 */
function computeCharDiffSimple(oldText: string, newText: string): CharDiff[] {
  // 找到最长公共前缀
  let prefixLen = 0;
  const minLen = Math.min(oldText.length, newText.length);
  while (prefixLen < minLen && oldText[prefixLen] === newText[prefixLen]) {
    prefixLen++;
  }

  // 找到最长公共后缀
  let suffixLen = 0;
  while (
    suffixLen < minLen - prefixLen &&
    oldText[oldText.length - 1 - suffixLen] === newText[newText.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const result: CharDiff[] = [];

  if (prefixLen > 0) {
    result.push({ type: 'equal', text: oldText.slice(0, prefixLen) });
  }

  const oldMiddle = oldText.slice(prefixLen, oldText.length - suffixLen);
  const newMiddle = newText.slice(prefixLen, newText.length - suffixLen);

  if (oldMiddle) {
    result.push({ type: 'delete', text: oldMiddle });
  }
  if (newMiddle) {
    result.push({ type: 'insert', text: newMiddle });
  }

  if (suffixLen > 0) {
    result.push({ type: 'equal', text: oldText.slice(oldText.length - suffixLen) });
  }

  return result;
}

/**
 * 合并连续的字符差异
 */
function mergeCharDiff(diffs: CharDiff[]): CharDiff[] {
  if (diffs.length <= 1) return diffs;

  const merged: CharDiff[] = [];
  let current = diffs[0];

  for (let i = 1; i < diffs.length; i++) {
    if (diffs[i].type === current.type) {
      current = { ...current, text: current.text + diffs[i].text };
    } else {
      merged.push(current);
      current = diffs[i];
    }
  }
  merged.push(current);

  return merged;
}

/**
 * 统计差异摘要
 */
export interface DiffStats {
  added: number;
  deleted: number;
  modified: number;
  unchanged: number;
}

export function computeDiffStats(diffLines: DiffLine[]): DiffStats {
  let added = 0;
  let deleted = 0;
  let unchanged = 0;

  for (const line of diffLines) {
    switch (line.type) {
      case 'insert':
        added++;
        break;
      case 'delete':
        deleted++;
        break;
      case 'equal':
        unchanged++;
        break;
    }
  }

  return {
    added,
    deleted,
    modified: 0, // 行级 diff 没有 modified 概念，只有 insert/delete/equal
    unchanged,
  };
}
