/**
 * useTerminalOutputFolding — 终端输出智能折叠
 * 
 * 检测长输出中的逻辑段落边界，提供折叠/展开功能。
 * 结合 Shell Integration 的命令边界标记进行分段。
 * 
 * 检测策略：
 * 1. OSC 633 序列标记的命令边界（精确）
 * 2. 启发式检测（分隔线、缩进变化）
 */

import { useMemo } from 'react';

export interface OutputSection {
  /** 起始行号 */
  startLine: number;
  /** 结束行号 */
  endLine: number;
  /** 段落标题（命令文本） */
  title?: string;
  /** 是否默认折叠 */
  defaultCollapsed?: boolean;
  /** 是否为错误/警告 */
  severity?: 'info' | 'warning' | 'error';
}

/**
 * 检测输出段落边界
 */
function detectSections(lines: string[]): OutputSection[] {
  const sections: OutputSection[] = [];
  if (lines.length === 0) return sections;

  let currentStart = 0;
  let currentTitle = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 检测 OSC 633 命令边界
    if (line.includes('\x1b]633;C')) {
      if (i > currentStart) {
        sections.push({
          startLine: currentStart,
          endLine: i,
          title: currentTitle || undefined,
        });
      }
      currentStart = i + 1;
      currentTitle = '';
      continue;
    }

    // 检测 OSC 633 命令开始
    if (line.includes('\x1b]633;B')) {
      currentStart = i;
      continue;
    }

    // 启发式：分隔线（如 =====, -----, *****）
    if (/^[=*-]{20,}/.test(line.trim())) {
      if (i > currentStart + 1) {
        sections.push({
          startLine: currentStart,
          endLine: i,
          title: currentTitle || undefined,
        });
      }
      currentStart = i;
      currentTitle = line.trim();
      continue;
    }

    // 启发式：命令提示符（如 $, #, >, ❯）
    if (/^[$#>❯]/.test(line.trim()) || /^\S+\s*[$#>❯]/.test(line.trim())) {
      if (currentStart > 0 && i > currentStart + 1) {
        sections.push({
          startLine: currentStart,
          endLine: i,
          title: currentTitle || undefined,
        });
      }
      currentStart = i;
      // 提取命令
      const cmdMatch = line.match(/[$#>❯]\s*(.+)/);
      currentTitle = cmdMatch ? cmdMatch[1] : line.trim();
      continue;
    }

    // 错误行
    if (line.includes('error') && line.length < 200) {
      sections.push({
        startLine: i,
        endLine: Math.min(i + 5, lines.length),
        title: '错误',
        severity: 'error',
        defaultCollapsed: false,
      });
      continue;
    }
  }

  // 最后一段
  if (currentStart < lines.length - 1) {
    sections.push({
      startLine: currentStart,
      endLine: lines.length,
      title: currentTitle || undefined,
    });
  }

  return sections;
}

/**
 * React Hook：终端输出智能折叠
 */
export function useTerminalOutputFolding(
  bufferLines: string[] | undefined,
  enabled: boolean = true
) {
  const sections = useMemo(() => {
    if (!enabled || !bufferLines || bufferLines.length === 0) {
      return [];
    }
    return detectSections(bufferLines);
  }, [bufferLines, enabled]);

  const getSectionForLine = (lineNumber: number): OutputSection | undefined => {
    return sections.find(s => s.startLine <= lineNumber && s.endLine >= lineNumber);
  };

  return { sections, getSectionForLine };
}
