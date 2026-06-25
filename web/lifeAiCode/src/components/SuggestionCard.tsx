import { useState, useMemo, type ReactNode } from 'react';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import {
  Check, X, GitMerge, FileText,
  Wrench, Bug, Sparkles, Zap, HelpCircle,
} from 'lucide-react';
import type { Suggestion, SuggestionChange } from '../types';
import { MarkdownContent } from './MarkdownContent';

import clike from 'react-syntax-highlighter/dist/esm/languages/prism/clike';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import scss from 'react-syntax-highlighter/dist/esm/languages/prism/scss';
import html from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c';
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp';
import csharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import kotlin from 'react-syntax-highlighter/dist/esm/languages/prism/kotlin';
import swift from 'react-syntax-highlighter/dist/esm/languages/prism/swift';
import php from 'react-syntax-highlighter/dist/esm/languages/prism/php';
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby';

[
  ['tsx', tsx], ['typescript', typescript], ['ts', typescript],
  ['javascript', javascript], ['js', javascript], ['jsx', tsx],
  ['json', json], ['css', css], ['scss', scss], ['html', html],
  ['bash', bash], ['shell', bash], ['sh', bash],
  ['python', python], ['py', python],
  ['rust', rust], ['rs', rust],
  ['go', go], ['golang', go],
  ['java', java], ['c', c], ['cpp', cpp], ['c++', cpp],
  ['csharp', csharp], ['cs', csharp],
  ['markdown', markdown], ['md', markdown],
  ['yaml', yaml], ['yml', yaml],
  ['sql', sql], ['kotlin', kotlin], ['kt', kotlin],
  ['swift', swift], ['php', php], ['ruby', ruby], ['rb', ruby],
  ['clike', clike],
].forEach(([name, lang]) => SyntaxHighlighter.registerLanguage(name as string, lang));

interface SuggestionCardProps {
  suggestion: Suggestion;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onPreviewDiff: (id: string) => void;
  loading?: boolean;
}

const TYPE_META: Record<string, { label: string; icon: ReactNode }> = {
  refactor:      { label: '重构', icon: <Wrench size={10} strokeWidth={2.2} /> },
  bugfix:        { label: '修复', icon: <Bug size={10} strokeWidth={2.2} /> },
  feature:       { label: '功能', icon: <Sparkles size={10} strokeWidth={2.2} /> },
  optimization:  { label: '优化', icon: <Zap size={10} strokeWidth={2.2} /> },
  explanation:   { label: '解释', icon: <HelpCircle size={10} strokeWidth={2.2} /> },
};

const FALLBACK_TYPE_META = TYPE_META.refactor;

/** 防御：未知 type 一律回退，避免 LLM 自由发挥污染 UI */
function getTypeMeta(type: string) {
  return TYPE_META[type] || FALLBACK_TYPE_META;
}

/** 根据文件路径推断语言（兼容 vite.config.ts 添加别名 这类带说明的标题） */
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

/** 计算行级 diff：返回每行（original 行号、modified 行号、类型、内容） */
interface DiffLine {
  oldLine: number | null;
  newLine: number | null;
  type: 'added' | 'removed' | 'context';
  oldText: string | null;
  newText: string | null;
}

function computeLineDiff(original: string, modified: string): DiffLine[] {
  const oldLines = original.split('\n');
  const newLines = modified.split('\n');

  // LCS-based diff，行级
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

export function SuggestionCard({ suggestion, onAccept, onReject, onPreviewDiff, loading }: SuggestionCardProps) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className={`suggestion-card ${suggestion.status !== 'pending' ? 'suggestion-card--resolved' : ''}`}>
      <div
        className="suggestion-card__header"
        onClick={() => setExpanded(!expanded)}
        style={{ cursor: 'pointer' }}
      >
        <span className={`suggestion-card__dot suggestion-card__dot--${getTypeMeta(suggestion.type) === getTypeMeta(suggestion.type) ? suggestion.type : 'refactor'} ${loading ? 'suggestion-card__dot--loading' : ''}`} />
        <span className={`suggestion-card__type suggestion-card__type--${TYPE_META[suggestion.type] ? suggestion.type : 'refactor'}`}>
          <span className="suggestion-card__type-icon">
            {getTypeMeta(suggestion.type).icon}
          </span>
          <span>{getTypeMeta(suggestion.type).label}</span>
        </span>
        <span className="suggestion-card__title">{suggestion.title}</span>
        <span className={`suggestion-card__status suggestion-card__status--${suggestion.status}`}>
          {suggestion.status === 'pending' ? '待处理' :
           suggestion.status === 'accepted' ? '已接受' :
           suggestion.status === 'rejected' ? '已拒绝' :
           suggestion.status === 'applied' ? '已应用' : '未知'}
        </span>
      </div>

      {expanded && (
        <div className="suggestion-card__body">
          {suggestion.description && (
            <div className="suggestion-card__description">
              <MarkdownContent content={suggestion.description} enableOptions={false} />
            </div>
          )}

          {suggestion.changes.map((change, idx) => (
            <DiffView key={idx} change={change} />
          ))}

          {suggestion.status === 'pending' && (
            <div className="suggestion-card__actions">
              <button className="action-btn action-btn--accept" onClick={() => onAccept(suggestion.id)}>
                <Check size={13} strokeWidth={2.5} /> 接受
              </button>
              <button className="action-btn action-btn--reject" onClick={() => onReject(suggestion.id)}>
                <X size={13} strokeWidth={2.5} /> 拒绝
              </button>
              {suggestion.changes.length > 0 && (
                <button className="action-btn action-btn--preview" onClick={() => onPreviewDiff(suggestion.id)}>
                  <GitMerge size={13} strokeWidth={2} /> 预览差异
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────── */
/*  Diff View — 双栏 diff，带行号、语法高亮                            */
/* ─────────────────────────────────────────────────────────────────── */

function DiffView({ change }: { change: SuggestionChange }) {
  const [collapsed, setCollapsed] = useState(false);
  const language = useMemo(() => inferLanguage(change.filePath), [change.filePath]);
  const diffLines = useMemo(
    () => computeLineDiff(change.original, change.modified),
    [change.original, change.modified]
  );

  const addedCount = diffLines.filter((l) => l.type === 'added').length;
  const removedCount = diffLines.filter((l) => l.type === 'removed').length;

  return (
    <div className="diff-view">
      {/* 文件头 */}
      <div className="diff-view__file-header">
        <div className="diff-view__file-info">
          <FileText size={12} strokeWidth={1.8} />
          <span className="diff-view__file-path">{change.filePath}</span>
          <span className="diff-view__lang-badge">{language}</span>
        </div>
        <div className="diff-view__stats">
          {removedCount > 0 && <span className="diff-view__stat diff-view__stat--removed">−{removedCount}</span>}
          {addedCount > 0 && <span className="diff-view__stat diff-view__stat--added">+{addedCount}</span>}
          <button
            className="diff-view__toggle"
            onClick={() => setCollapsed(!collapsed)}
            title={collapsed ? '展开差异' : '折叠差异'}
          >
            {collapsed ? '展开' : '折叠'}
          </button>
        </div>
      </div>

      {change.explanation && (
        <div className="diff-view__explanation">
          <MarkdownContent content={change.explanation} enableOptions={false} />
        </div>
      )}

      {!collapsed && (
        <div className="diff-view__body">
          {/* macOS 风格头 */}
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

          {/* 双栏 diff 内容 */}
          <div className="diff-view__split">
            <div className="diff-view__pane diff-view__pane--old">
              {diffLines.map((line, idx) => {
                const isRemoved = line.type === 'removed';
                const isContext = line.type === 'context';
                return (
                  <DiffRow
                    key={`old-${idx}`}
                    line={line}
                    side="old"
                    isHighlight={isRemoved}
                    isMuted={isContext}
                    language={language}
                  />
                );
              })}
            </div>
            <div className="diff-view__divider" />
            <div className="diff-view__pane diff-view__pane--new">
              {diffLines.map((line, idx) => {
                const isAdded = line.type === 'added';
                const isContext = line.type === 'context';
                return (
                  <DiffRow
                    key={`new-${idx}`}
                    line={line}
                    side="new"
                    isHighlight={isAdded}
                    isMuted={isContext}
                    language={language}
                  />
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
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

  // 只在有内容的行渲染高亮，避免空行占太多视觉空间
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
              margin: 0,
              padding: 0,
              background: 'transparent',
              display: 'inline',
              fontSize: '11.5px',
              lineHeight: '1.55',
            }}
            codeTagProps={{
              style: {
                fontFamily: 'var(--font-mono)',
                fontSize: '11.5px',
                background: 'transparent',
                padding: 0,
              }
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
