/* ─────────────────────────────────────────────────────────────────── */
/*  SuggestionCard：建议卡片主组件                                      */
/* ─────────────────────────────────────────────────────────────────── */
/*  渲染建议卡片骨架（header: 文件信息 + stats + 状态；body: 描述 +
 *  diff 对比 + 操作按钮）。
 *
 *  §头部格式：按用户期望布局（左→右）：
 *    [文件类型 badge] [相对路径] [变更] [-N 红色] [+N 绿色] [展开] [已应用]
 *    例子：JS  /src/Test.tsx  变更  [-1]  [+1]  展开  已应用
 *    - 去掉 FileText icon，不再区分类型
 *    - "变更" 多文件时可点击弹出 dropdown 列出所有变更
 *    - "展开" 是 DiffView 自己的「展开/折叠」按钮——切换所有 diff body
 *
 *  DiffView 已拆为独立组件，可复用。                              */

import { useState, useMemo, useRef, useEffect } from 'react';
import { Check, X, ChevronDown, FileText, GitCompare } from 'lucide-react';
import type { Suggestion, SuggestionChange } from '../../types';
import { MarkdownContent } from '../MarkdownContent';
import { DiffView } from './DiffView';

/** 根据文件路径推断语言（与 DiffView.inferLanguage 保持一致） */
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
 * - 其他语言直接返回原名（已足够紧凑，不需进一步缩写）
 *
 * 重要：只用于 badge 文本展示，syntax highlighter 仍需调用 inferLanguage
 * 拿全名做高亮映射。
 */
function formatLangBadge(language: string): string {
  const lower = (language || '').toLowerCase();
  if (lower === 'javascript') return 'JS';
  if (lower === 'typescript') return 'TS';
  return language;
}

/**
 * 估算 change 的 added/removed 行数（粗略估算，用于头部 stats 展示）。
 * 与 DiffView 内部的 computeLineDiff 算法不同，这里走"行集差集"近似：
 * 出现在 modified 但不在 original 的视为新增，反之视为删除。
 * 头部只展示大致数字，精确 diff 等用户展开后由 DiffView 展示。
 */
function estimateChangeStats(change: SuggestionChange): { added: number; removed: number } {
  const oldText = change.original || '';
  const newText = change.modified || '';
  if (!oldText && !newText) return { added: 0, removed: 0 };
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const added = newLines.filter((l) => !oldSet.has(l)).length;
  const removed = oldLines.filter((l) => !newSet.has(l)).length;
  return { added, removed };
}

interface SuggestionCardProps {
  suggestion: Suggestion;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onOpenDiffInEditor: (change: SuggestionChange) => void;
  loading?: boolean;
}

export function SuggestionCard({ suggestion, onAccept, onReject, onOpenDiffInEditor, loading }: SuggestionCardProps) {
  // §需求3：所有 DiffView 共享的 collapsed 状态——header 的「展开」按钮与
  // 每个 DiffView 自己的「展开」按钮做同一件事，任意一个被点都同步切换。
  const [diffExpanded, setDiffExpanded] = useState(false);
  // §需求2：多文件时「变更」按钮触发 dropdown
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const changeLabelRef = useRef<HTMLDivElement | null>(null);
  const firstChange = suggestion.changes[0];
  const language = useMemo(
    () => (firstChange ? inferLanguage(firstChange.filePath) : ''),
    [firstChange],
  );
  // §stats：累加所有 changes 的行数差，多文件建议也能汇总展示
  const stats = useMemo(() => {
    return suggestion.changes.reduce(
      (acc, c) => {
        const s = estimateChangeStats(c);
        acc.added += s.added;
        acc.removed += s.removed;
        return acc;
      },
      { added: 0, removed: 0 },
    );
  }, [suggestion.changes]);

  const hasMultipleChanges = suggestion.changes.length > 1;

  // §需求2：点击 dropdown 外部关闭 dropdown
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (changeLabelRef.current && !changeLabelRef.current.contains(target)) {
        setDropdownOpen(false);
      }
    };
    // §使用 mousedown 比 click 早触发，避免 dropdown item 点击逻辑被吞
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  // §需求2：点击 dropdown item 时滚动到对应 DiffView，并展开所有 diff
  const handleDropdownItemClick = (idx: number) => {
    setDiffExpanded(true);
    setDropdownOpen(false);
    // §滚动到对应的 DiffView（用 rAF 等 DOM 更新完成）
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-diff-index="${CSS.escape(suggestion.id)}-${idx}"]`);
      if (el && 'scrollIntoView' in el) {
        (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  };

  return (
    <div className={`suggestion-card ${suggestion.status !== 'pending' ? 'suggestion-card--resolved' : ''}`}>
      <div
        className="suggestion-card__header"
        style={{ cursor: 'pointer' }}
        title={firstChange?.filePath || suggestion.title}
      >
        {/* §需求4：头部格式
            [lang badge] [filePath] ...spacer... [变更] [-N] [+N] [展开按钮] [状态]
            例子：JS /src/Test.tsx 变更 [-1] [+1] 展开 已应用
            §需求3：调整后顺序为 [变更] [-N] [+N] [展开] [已应用]，
            stats 从"变更"前面移到后面，与「变更」紧贴在「展开」左侧
            §需求2：多文件时「变更」变成可点击 button，点击弹出 dropdown 列出所有变更
            §本轮调整：把「变更 + stats + 展开」包进 .suggestion-card__cluster 容器
            ，组内使用更小的 gap（4px）让三者看起来是一个紧凑 cluster，与左侧文件信息
            之间通过 spacer + 父级 gap(8px) 隔开。
        */}
        {firstChange ? (
          <>
            <span className="suggestion-card__lang-badge">{formatLangBadge(language)}</span>
            <span className="suggestion-card__file-path">{firstChange.filePath}</span>
          </>
        ) : (
          <span className="suggestion-card__file-path suggestion-card__file-path--empty">
            {suggestion.title}
          </span>
        )}
        {/* §占位元素：把后续 cluster 推到右侧（变更+stats+展开 紧贴成一组） */}
        <span className="suggestion-card__spacer" />
        {/* §本轮调整：把「变更」「stats」「展开」三个元素包成一个 cluster，
            组内 gap 4px，让它们视觉上是一个紧凑的功能组，紧贴「展开」左侧。 */}
        <div className="suggestion-card__cluster">
        {/* §需求2：「变更」标签
            - 单文件：保持 span（无意义）
            - 多文件：button + 下拉箭头，弹出 dropdown 列出所有变更
        */}
        <div className="suggestion-card__change-wrapper" ref={changeLabelRef}>
          {hasMultipleChanges ? (
            <button
              type="button"
              className={`suggestion-card__change-trigger ${dropdownOpen ? 'suggestion-card__change-trigger--open' : ''}`}
              onClick={(e) => { e.stopPropagation(); setDropdownOpen(!dropdownOpen); }}
              title={`查看 ${suggestion.changes.length} 个文件变更`}
            >
              <span className="suggestion-card__change-trigger-text">变更</span>
              <span className="suggestion-card__change-trigger-count">{suggestion.changes.length}</span>
              <ChevronDown size={11} strokeWidth={2} className="suggestion-card__change-trigger-icon" />
            </button>
          ) : (
            <span className="suggestion-card__change-label">变更</span>
          )}
          {/* §需求2：dropdown 列表，格式同底部 DiffView 的 file-header */}
          {hasMultipleChanges && dropdownOpen && (
            <div className="suggestion-card__dropdown" role="menu">
              {suggestion.changes.map((change, idx) => {
                const s = estimateChangeStats(change);
                const lang = inferLanguage(change.filePath);
                return (
                  <button
                    key={idx}
                    type="button"
                    className="suggestion-card__dropdown-item"
                    role="menuitem"
                    onClick={(e) => { e.stopPropagation(); handleDropdownItemClick(idx); }}
                  >
                    <FileText size={12} strokeWidth={1.8} className="suggestion-card__dropdown-icon" />
                    <span className="diff-view__file-path">{change.filePath}</span>
                    <span className="diff-view__lang-badge">{formatLangBadge(lang)}</span>
                    <span className="suggestion-card__dropdown-stats">
                      {s.removed > 0 && <span className="diff-view__stat diff-view__stat--removed">−{s.removed}</span>}
                      {s.added > 0 && <span className="diff-view__stat diff-view__stat--added">+{s.added}</span>}
                    </span>
                    <GitCompare size={12} strokeWidth={1.8} className="suggestion-card__dropdown-compare" />
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {/* §stats：-N/+N 红绿 badge 紧贴在「变更」后面、「展开」前面 */}
        {(stats.removed > 0 || stats.added > 0) && (
          <span className="suggestion-card__stats">
            {stats.removed > 0 && <span className="suggestion-card__stat suggestion-card__stat--removed">−{stats.removed}</span>}
            {stats.added > 0 && <span className="suggestion-card__stat suggestion-card__stat--added">+{stats.added}</span>}
          </span>
        )}
        {/* §需求3：展开/收起按钮——切换所有 DiffView 的 collapsed 状态。
            与 DiffView 自身的「展开/折叠」按钮做同一件事。 */}
        <button
          type="button"
          className={`suggestion-card__toggle ${diffExpanded ? 'suggestion-card__toggle--expanded' : ''}`}
          onClick={(e) => { e.stopPropagation(); setDiffExpanded(!diffExpanded); }}
          aria-label={diffExpanded ? '折叠所有差异' : '展开所有差异'}
          title={diffExpanded ? '折叠所有差异' : '展开所有差异'}
        >
          <span className="suggestion-card__toggle-text">{diffExpanded ? '折叠' : '展开'}</span>
          <ChevronDown size={12} strokeWidth={2} className="suggestion-card__toggle-icon" />
        </button>
        </div>
        {suggestion.status === 'pending' ? (
          <div className="suggestion-card__actions" onClick={(e) => e.stopPropagation()}>
            <button
              className="action-btn action-btn--accept"
              title="接受"
              onClick={() => onAccept(suggestion.id)}
            >
              <Check size={14} strokeWidth={2.5} />
            </button>
            <button
              className="action-btn action-btn--reject"
              title="拒绝"
              onClick={() => onReject(suggestion.id)}
            >
              <X size={14} strokeWidth={2.5} />
            </button>
          </div>
        ) : (
          <span className={`suggestion-card__status suggestion-card__status--${suggestion.status}`}>
            {suggestion.status === 'accepted' ? '已接受' :
             suggestion.status === 'rejected' ? '已拒绝' :
             suggestion.status === 'applied' ? '已应用' : '未知'}
          </span>
        )}
      </div>

      {/* §需求3：body 始终渲染（含 description + 所有 DiffView）。
          各 DiffView 的可见性由受控 collapsed prop 决定。 */}
      <div className="suggestion-card__body">
        {suggestion.description && (
          <div className="suggestion-card__description">
            {/* §需求：传入 firstChange.filePath 作为 fileHint，让 description
                里 LLM 输出的裸代码（未加 ``` 围栏 / 被双引号+<br> 包裹）
                能优先用文件后缀推断语言而不是靠 detectCodeLanguage 猜测。 */}
            <MarkdownContent
              content={suggestion.description}
              enableOptions={false}
              fileHint={firstChange?.filePath}
            />
          </div>
        )}

        {suggestion.changes.map((change, idx) => (
          <div
            key={idx}
            data-diff-index={`${suggestion.id}-${idx}`}
            className="suggestion-card__diff-wrapper"
          >
            <DiffView
              change={change}
              onOpenDiffInEditor={onOpenDiffInEditor}
              collapsed={!diffExpanded}
              onToggleCollapsed={() => setDiffExpanded(!diffExpanded)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}