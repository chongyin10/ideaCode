/**
 * useTerminalOutputFolding — 终端输出智能折叠
 *
 * 数学优化:
 * - 递推 Shannon 熵增量更新: 新行追加时 O(1) 更新熵值
 * - 滑动窗熵: 局部二进制块检测，无需遍历全量历史
 * - 区间树 (#18): O(log n) 定位行所属段落
 */

import { useMemo } from 'react';
import { shannonEntropy } from './terminalMath';
import { IntervalTree } from './terminalIndexes';
import { SlidingWindowEntropy } from '../utils/algorithms';

export interface OutputSection {
  startLine: number;
  endLine: number;
  title?: string;
  defaultCollapsed?: boolean;
  severity?: 'info' | 'warning' | 'error';
}

function detectSections(lines: string[]): OutputSection[] {
  const sections: OutputSection[] = [];
  if (lines.length === 0) return sections;

  let currentStart = 0;
  let currentTitle = '';
  // 使用滑动窗递推熵加速二进制块检测 (优化 #22)
  const entropyWindow = new SlidingWindowEntropy(512);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 递推熵检测：推送当前行到滑动窗，O(1) 更新
    const windowEntropy = entropyWindow.pushLine(line);

    // 二进制块检测：滑动窗熵 ≥ 6.5 或 通过 shannonEntropy 确认
    const isBinary =
      (windowEntropy >= 6.5 && line.length > 50) ||
      (line.length > 100 && shannonEntropy(line) > 6.5);

    if (isBinary) {
      if (i > currentStart) {
        sections.push({ startLine: currentStart, endLine: i, title: currentTitle || undefined });
      }
      currentStart = i + 1;
      currentTitle = '';
      sections.push({ startLine: i, endLine: i + 1, title: '[二进制数据]', defaultCollapsed: true, severity: 'info' });
      entropyWindow.reset(); // 重置滑动窗
      continue;
    }

    // OSC 633 命令边界
    if (line.includes('\x1b]633;C')) {
      if (i > currentStart) {
        sections.push({ startLine: currentStart, endLine: i, title: currentTitle || undefined });
      }
      currentStart = i + 1;
      currentTitle = '';
      entropyWindow.reset();
      continue;
    }
    if (line.includes('\x1b]633;B')) { currentStart = i; entropyWindow.reset(); continue; }

    // 分隔线
    if (/^[=*-]{20,}/.test(line.trim())) {
      if (i > currentStart + 1) {
        sections.push({ startLine: currentStart, endLine: i, title: currentTitle || undefined });
      }
      currentStart = i;
      currentTitle = line.trim();
      entropyWindow.reset();
      continue;
    }

    // 命令提示符
    if (/^[$#>❯]/.test(line.trim()) || /^\S+\s*[$#>❯]/.test(line.trim())) {
      if (currentStart > 0 && i > currentStart + 1) {
        sections.push({ startLine: currentStart, endLine: i, title: currentTitle || undefined });
      }
      currentStart = i;
      const cmdMatch = line.match(/[$#>❯]\s*(.+)/);
      currentTitle = cmdMatch ? cmdMatch[1] : line.trim();
      entropyWindow.reset();
      continue;
    }

    // 错误行
    if (line.includes('error') && line.length < 200) {
      sections.push({ startLine: i, endLine: Math.min(i + 5, lines.length), title: '错误', severity: 'error', defaultCollapsed: false });
      continue;
    }
  }

  if (currentStart < lines.length - 1) {
    sections.push({ startLine: currentStart, endLine: lines.length, title: currentTitle || undefined });
  }

  return sections;
}

/**
 * React Hook：终端输出智能折叠 (interval tree 优化 #18)
 */
export function useTerminalOutputFolding(
  bufferLines: string[] | undefined,
  enabled: boolean = true
) {
  const { sections, intervalTree } = useMemo(() => {
    if (!enabled || !bufferLines || bufferLines.length === 0) {
      return { sections: [] as OutputSection[], intervalTree: new IntervalTree<OutputSection>() };
    }
    const sects = detectSections(bufferLines);
    const tree = new IntervalTree<OutputSection>();
    for (const s of sects) tree.insert(s.startLine, s.endLine, s);
    return { sections: sects, intervalTree: tree };
  }, [bufferLines, enabled]);

  /** O(log n) 查找行所在段落 (优化) */
  const getSectionForLine = (lineNumber: number): OutputSection | null => {
    return intervalTree.findContaining(lineNumber);
  };

  return { sections, getSectionForLine, intervalTree };
}
