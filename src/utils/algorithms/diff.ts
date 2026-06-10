/**
 * 差异对比算法 (Diff Algorithm)
 * ============================================================================
 * 
 * 应用场景：
 * 1. 文件版本对比：显示两个版本文件的增删改
 * 2. Git 差异展示：行级别的增删标记
 * 3. 编辑器撤销栈：记录文本变更以便撤销/重做
 * 
 * 算法原理：
 * 基于「最长公共子序列」(LCS, Longest Common Subsequence) 的动态规划实现。
 * 
 * LCS 定义：给定两个序列 A 和 B，LCS 是同时是 A 和 B 子序列的最长序列。
 * 例如：A="ABCBDAB", B="BDCABA" → LCS="BCBA"（长度4）
 * 
 * 动态规划递推公式：
 *   dp[i][j] = 0                          如果 i=0 或 j=0
 *   dp[i][j] = dp[i-1][j-1] + 1           如果 A[i-1] = B[j-1]
 *   dp[i][j] = max(dp[i-1][j], dp[i][j-1]) 否则
 * 
 * 时间复杂度：O(m × n)，m=旧文本行数, n=新文本行数
 * 空间复杂度：O(m × n)，可优化至 O(min(m,n))
 * 
 * Myers 算法（VS Code 使用）：
 * 在字符级别使用更高效的 O(ND) 算法，N=文本长度, D=编辑距离。
 * 本实现采用行级别的 LCS，适合文件差异展示场景。
 * ============================================================================
 */

export type DiffType = 'equal' | 'insert' | 'delete';

export interface DiffChunk {
  type: DiffType;
  /** 旧文本中的行号（1-based，insert 时为 null） */
  oldLine: number | null;
  /** 新文本中的行号（1-based，delete 时为 null） */
  newLine: number | null;
  /** 行内容 */
  content: string;
}

export interface DiffResult {
  chunks: DiffChunk[];
  /** 统计信息 */
  stats: {
    insertions: number;
    deletions: number;
    unchanged: number;
  };
}

/**
 * 计算 LCS 长度矩阵
 * 使用滚动数组优化空间至 O(min(m,n))
 */
function computeLCSMatrix(oldLines: string[], newLines: string[]): number[][] {
  const m = oldLines.length;
  const n = newLines.length;
  
  // dp[j] = 当前行（i）在列 j 的 LCS 长度
  // prev[j] = 上一行（i-1）在列 j 的 LCS 长度
  const dp = new Array(n + 1).fill(0);
  const prev = new Array(n + 1).fill(0);
  
  // 需要回溯矩阵来重建路径，因此保留完整矩阵
  // 对于大文件可使用 Hirschberg 算法将空间降至 O(n)
  const matrix: number[][] = [];
  
  for (let i = 1; i <= m; i++) {
    const row = new Array(n + 1).fill(0);
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[j] = prev[j - 1] + 1;
      } else {
        dp[j] = Math.max(prev[j], dp[j - 1]);
      }
      row[j] = dp[j];
    }
    matrix.push([...dp]);
    // 交换数组
    for (let j = 0; j <= n; j++) {
      prev[j] = dp[j];
    }
  }
  
  return matrix;
}

/**
 * 回溯 LCS 矩阵，生成差异结果
 */
function backtrackDiff(
  oldLines: string[],
  newLines: string[],
  matrix: number[][]
): DiffChunk[] {
  const chunks: DiffChunk[] = [];
  let i = oldLines.length;
  let j = newLines.length;
  
  // 从右下角回溯到左上角
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      // 相等：来自左上角
      chunks.unshift({
        type: 'equal',
        oldLine: i,
        newLine: j,
        content: oldLines[i - 1],
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || (i > 0 && j > 0 && matrix[i - 1]?.[j] <= matrix[i]?.[j - 1]))) {
      // 新增：来自左边（新文本多出的行）
      // 注意：matrix 的索引需要调整，因为 matrix[i-1] 对应 oldLines[i-1]
      chunks.unshift({
        type: 'insert',
        oldLine: null,
        newLine: j,
        content: newLines[j - 1],
      });
      j--;
    } else {
      // 删除：来自上方（旧文本被删除的行）
      chunks.unshift({
        type: 'delete',
        oldLine: i,
        newLine: null,
        content: oldLines[i - 1],
      });
      i--;
    }
  }
  
  return chunks;
}

/**
 * 计算两个文本的差异
 * @param oldText 旧文本
 * @param newText 新文本
 * @returns 差异块数组
 */
export function computeDiff(oldText: string, newText: string): DiffResult {
  // 按行分割（保留换行符处理的一致性）
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  
  // 处理末尾空行
  if (oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines[newLines.length - 1] === '') newLines.pop();
  
  const matrix = computeLCSMatrix(oldLines, newLines);
  const chunks = backtrackDiff(oldLines, newLines, matrix);
  
  // 合并连续的相同类型块（压缩输出）
  const compressed = compressChunks(chunks);
  
  // 统计
  const stats = {
    insertions: chunks.filter((c) => c.type === 'insert').length,
    deletions: chunks.filter((c) => c.type === 'delete').length,
    unchanged: chunks.filter((c) => c.type === 'equal').length,
  };
  
  return { chunks: compressed, stats };
}

/**
 * 压缩连续的相同类型差异块
 * 将连续的多行 equal 合并为一个块，减少渲染开销
 */
function compressChunks(chunks: DiffChunk[]): DiffChunk[] {
  if (chunks.length === 0) return [];
  
  const result: DiffChunk[] = [];
  let current = chunks[0];
  let currentCount = 1;
  
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i];
    
    if (chunk.type === current.type && chunk.type === 'equal') {
      // 合并连续 equal
      currentCount++;
      // 只保留首尾信息用于显示
      if (currentCount <= 3) {
        result.push(current);
        current = chunk;
      }
      // 超过3行连续相等，用省略号代替中间行
    } else {
      if (currentCount > 3) {
        // 添加省略标记
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
  
  // 处理最后一个块
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

/**
 * 生成统一的 diff 格式输出（类 Unix diff -u 格式）
 */
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
  
  let oldLine = 1;
  let newLine = 1;
  
  for (const chunk of chunks) {
    if (chunk.type === 'equal') {
      lines.push(` ${chunk.content}`);
      oldLine++;
      newLine++;
    } else if (chunk.type === 'insert') {
      lines.push(`+${chunk.content}`);
      newLine++;
    } else if (chunk.type === 'delete') {
      lines.push(`-${chunk.content}`);
      oldLine++;
    }
  }
  
  return lines.join('\n');
}

/**
 * 行内差异（字符级别）
 * 对修改的行进行更细粒度的字符对比
 */
export function inlineDiff(oldLine: string, newLine: string): {
  type: DiffType;
  text: string;
}[] {
  // 使用简化的字符级 LCS
  const oldChars = Array.from(oldLine);
  const newChars = Array.from(newLine);
  const m = oldChars.length;
  const n = newChars.length;
  
  const dp = new Array(n + 1).fill(0);
  const prev = new Array(n + 1).fill(0);
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldChars[i - 1] === newChars[j - 1]) {
        dp[j] = prev[j - 1] + 1;
      } else {
        dp[j] = Math.max(prev[j], dp[j - 1]);
      }
    }
    for (let j = 0; j <= n; j++) prev[j] = dp[j];
  }
  
  // 简化回溯：标记修改区域
  // 对于行内差异，使用更简单的方法：逐字符比较
  const result: { type: DiffType; text: string }[] = [];
  const maxLen = Math.max(oldChars.length, newChars.length);
  
  let i = 0;
  while (i < maxLen) {
    if (i < oldChars.length && i < newChars.length && oldChars[i] === newChars[i]) {
      // 相等字符
      let equalText = '';
      while (i < maxLen && i < oldChars.length && i < newChars.length && oldChars[i] === newChars[i]) {
        equalText += oldChars[i];
        i++;
      }
      result.push({ type: 'equal', text: equalText });
    } else {
      // 找下一个相等位置
      let delText = '';
      let insText = '';
      
      while (i < oldChars.length && (i >= newChars.length || oldChars[i] !== newChars[i])) {
        delText += oldChars[i];
        i++;
      }
      
      // 重新对齐
      const rollback = i;
      i = rollback - delText.length;
      while (i < newChars.length && (i >= oldChars.length || oldChars[i] !== newChars[i])) {
        insText += newChars[i];
        i++;
      }
      
      if (delText) result.push({ type: 'delete', text: delText });
      if (insText) result.push({ type: 'insert', text: insText });
    }
  }
  
  return result;
}

/**
 * Diff 结果渲染辅助：生成带样式的 HTML
 */
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
