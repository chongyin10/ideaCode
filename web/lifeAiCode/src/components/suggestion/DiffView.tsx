/* ─────────────────────────────────────────────────────────────────── */
/*  DiffView：双栏 diff 对比（git diff 风格）                          */
/* ─────────────────────────────────────────────────────────────────── */
/*  从 SuggestionCard.tsx 拆出，可独立复用。
 *  包含：行级 diff 计算、语言推断、双栏渲染、行号、语法高亮。       */

import { useState, useMemo } from 'react';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { GitCompare, FileText } from 'lucide-react';
import type { SuggestionChange } from '../../types';
import { MarkdownContent } from '../MarkdownContent';

/** 根据文件路径推断语言 */
function inferLanguage(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() || filePath;
  const match = base.match(/\.([\w+]+)(?:\s|$|[?#])/);
  const ext = match ? match[1].toLowerCase() : '';
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
  return map[ext] || 'clike';
}

/**
 * 需求1：把 inferLanguage 返回的全名压缩为 badge 用的缩写。
 * - javascript → JS
 * - typescript → TS
 *
 * 重要：只用于 badge 文本展示，syntax highlighter 仍需调用 inferLanguage
 * 拿全名做高亮映射（react-syntax-highlighter 不支持 JS/TS 缩写）。
 */
function formatLangBadge(language: string): string {
  const lower = (language || '').toLowerCase();
  if (lower === 'javascript') return 'JS';
  if (lower === 'typescript') return 'TS';
  return language;
}

interface DiffLine {
  oldLine: number | null;
  newLine: number | null;
  type: 'added' | 'removed' | 'context';
  oldText: string | null;
  newText: string | null;
}

/** LCS 行级 diff */
function computeLineDiff(original: string, modified: string): DiffLine[] {
  const oldLines = original.split('\n');
  const newLines = modified.split('\n');
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const result: DiffLine[] = [];
  let i = 0, j = 0;
  let oldLineNum = 1, newLineNum = 1;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      result.push({ oldLine: oldLineNum++, newLine: newLineNum++, type: 'context', oldText: oldLines[i], newText: newLines[j] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ oldLine: oldLineNum++, newLine: null, type: 'removed', oldText: oldLines[i], newText: null });
      i++;
    } else {
      result.push({ oldLine: null, newLine: newLineNum++, type: 'added', oldText: null, newText: newLines[j] });
      j++;
    }
  }
  while (i < m) {
    result.push({ oldLine: oldLineNum++, newLine: null, type: 'removed', oldText: oldLines[i], newText: null });
    i++;
  }
  while (j < n) {
    result.push({ oldLine: null, newLine: newLineNum++, type: 'added', oldText: null, newText: newLines[j] });
    j++;
  }
  return result;
}

function DiffRow({ line, side, isHighlight, isMuted, language }: {
  line: DiffLine;
  side: 'old' | 'new';
  isHighlight: boolean;
  isMuted: boolean;
  language: string;
}) {
  const lineNum = side === 'old' ? line.oldLine : line.newLine;
  const text = side === 'old' ? (line.oldText ?? '') : (line.newText ?? '');
  const showContent = text.length > 0;

  const rowClass = [
    'diff-row',
    side === 'old' ? 'diff-row--old' : 'diff-row--new',
    isHighlight ? 'diff-row--highlight' : '',
    isMuted ? 'diff-row--muted' : '',
    !showContent ? 'diff-row--empty' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={rowClass}>
      <span className="diff-row__gutter">
        {isHighlight ? (side === 'old' ? '−' : '+') : ' '}
      </span>
      <span className="diff-row__line-no">{lineNum ?? ''}</span>
      <span className="diff-row__content">
        {showContent ? (
          <SyntaxHighlighter
            language={language}
            style={oneDark}
            PreTag="span"
            customStyle={{
              margin: 0, padding: 0, background: 'transparent',
              display: 'inline', fontSize: '11.5px', lineHeight: '1.55',
            }}
            codeTagProps={{
              style: { fontFamily: 'var(--font-mono)', fontSize: '11.5px', background: 'transparent', padding: 0 }
            }}
            wrapLines={false}
            wrapLongLines={false}
          >
            {text}
          </SyntaxHighlighter>
        ) : (
          <span>&nbsp;</span>
        )}
      </span>
    </div>
  );
}

export function DiffView({ change, onOpenDiffInEditor, collapsed: collapsedProp, onToggleCollapsed }: {
  change: SuggestionChange;
  onOpenDiffInEditor: (change: SuggestionChange) => void;
  /**
   * §需求3：受控模式——父组件（SuggestionCard）传入折叠状态。
   * - 传 undefined 时使用组件内部状态（保持 DiffView 独立可用）
   * - 传 boolean 时使用外部状态（让 SuggestionCard header「展开」按钮
   *   与每个 DiffView 自己的「展开」按钮做同一件事）
   */
  collapsed?: boolean;
  /** §需求3：用户点击 DiffView 自身的「展开」按钮时通知父组件 */
  onToggleCollapsed?: () => void;
}) {
  // §需求3：独立使用时（无受控 prop）保留默认折叠
  const [internalCollapsed, setInternalCollapsed] = useState(true);
  const collapsed = collapsedProp ?? internalCollapsed;
  const handleToggle = () => {
    if (onToggleCollapsed) onToggleCollapsed();
    else setInternalCollapsed(!internalCollapsed);
  };
  const language = useMemo(() => inferLanguage(change.filePath), [change.filePath]);
  const diffLines = useMemo(
    () => computeLineDiff(change.original, change.modified),
    [change.original, change.modified]
  );

  const addedCount = diffLines.filter((l) => l.type === 'added').length;
  const removedCount = diffLines.filter((l) => l.type === 'removed').length;

  return (
    <div className="diff-view">
      <div className="diff-view__file-header">
        <div className="diff-view__file-info">
          <FileText size={12} strokeWidth={1.8} />
          <span className="diff-view__file-path">{change.filePath}</span>
          <span className="diff-view__lang-badge">{formatLangBadge(language)}</span>
        </div>
        <div className="diff-view__stats">
          {removedCount > 0 && <span className="diff-view__stat diff-view__stat--removed">−{removedCount}</span>}
          {addedCount > 0 && <span className="diff-view__stat diff-view__stat--added">+{addedCount}</span>}
          <button
            className="diff-view__compare-btn"
            onClick={() => onOpenDiffInEditor(change)}
            title="在编辑器中对比"
          >
            <GitCompare size={12} strokeWidth={1.8} />
            <span>对比</span>
          </button>
          <button
            className="diff-view__toggle"
            onClick={handleToggle}
            title={collapsed ? '展开差异' : '折叠差异'}
          >
            {collapsed ? '展开' : '折叠'}
          </button>
        </div>
      </div>

      {change.explanation && (
        <div className="diff-view__explanation">
          {/* §需求：传入 change.filePath 作为 fileHint，让每个 diff 的解释文本里
              LLM 输出的裸代码能优先用文件后缀推断语言。 */}
          <MarkdownContent
            content={change.explanation}
            enableOptions={false}
            fileHint={change.filePath}
          />
        </div>
      )}

      {!collapsed && (
        <div className="diff-view__body">
          <div className="diff-view__code-header">
            <div className="diff-view__dots">
              <span className="diff-view__dot diff-view__dot--red" />
              <span className="diff-view__dot diff-view__dot--yellow" />
              <span className="diff-view__dot diff-view__dot--green" />
            </div>
            <div className="diff-view__code-title">
              <span className="diff-view__code-label diff-view__code-label--old">变更前</span>
              <span className="diff-view__code-divider" />
              <span className="diff-view__code-label diff-view__code-label--new">变更后</span>
            </div>
            <span className="diff-view__code-meta">{diffLines.length} 行</span>
          </div>

          <div className="diff-view__split">
            <div className="diff-view__pane diff-view__pane--old">
              {diffLines.map((line, idx) => (
                <DiffRow
                  key={`old-${idx}`}
                  line={line}
                  side="old"
                  isHighlight={line.type === 'removed'}
                  isMuted={line.type === 'context'}
                  language={language}
                />
              ))}
            </div>
            <div className="diff-view__divider" />
            <div className="diff-view__pane diff-view__pane--new">
              {diffLines.map((line, idx) => (
                <DiffRow
                  key={`new-${idx}`}
                  line={line}
                  side="new"
                  isHighlight={line.type === 'added'}
                  isMuted={line.type === 'context'}
                  language={language}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
