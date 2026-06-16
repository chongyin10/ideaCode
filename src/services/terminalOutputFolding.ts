/**
 * useTerminalOutputFolding — 终端输出智能折叠
 * 
 * 数学优化:
 * - Shannon 熵分类 (#13): 自动跳过二进制/结构化块
 * - 区间树 (#18): O(log n) 定位行所属段落
 */

import { useMemo } from 'react';
import { shannonEntropy, classifyBlock } from './terminalMath';
import { IntervalTree } from './terminalIndexes';

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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Shannon 熵分类 — 跳过二进制块 (优化 #13)
    const entropy = shannonEntropy(line);
    const category = classifyBlock(entropy);
    if (category === 'binary' && line.length > 100) {
      if (i > currentStart) {
        sections.push({ startLine: currentStart, endLine: i, title: currentTitle || undefined });
      }
      currentStart = i + 1;
      currentTitle = '';
      sections.push({ startLine: i, endLine: i + 1, title: '[二进制数据]', defaultCollapsed: true, severity: 'info' });
      continue;
    }

    // OSC 633 命令边界
    if (line.includes('\x1b]633;C')) {
      if (i > currentStart) {
        sections.push({ startLine: currentStart, endLine: i, title: currentTitle || undefined });
      }
      currentStart = i + 1;
      currentTitle = '';
      continue;
    }
    if (line.includes('\x1b]633;B')) { currentStart = i; continue; }

    // 分隔线
    if (/^[=*-]{20,}/.test(line.trim())) {
      if (i > currentStart + 1) {
        sections.push({ startLine: currentStart, endLine: i, title: currentTitle || undefined });
      }
      currentStart = i;
      currentTitle = line.trim();
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
