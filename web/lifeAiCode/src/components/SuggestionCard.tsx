import { useState } from 'react';
import type { Suggestion, SuggestionChange } from '../types';
import { MarkdownContent } from './MarkdownContent';

interface SuggestionCardProps {
  suggestion: Suggestion;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onPreviewDiff: (id: string) => void;
  loading?: boolean;
}

const TYPE_LABELS: Record<string, string> = {
  refactor: '重构',
  bugfix: '修复',
  feature: '功能',
  optimization: '优化',
  explanation: '解释',
};

export function SuggestionCard({ suggestion, onAccept, onReject, onPreviewDiff, loading }: SuggestionCardProps) {
  const [expanded, setExpanded] = useState(true);

  const renderDiff = (change: SuggestionChange) => {
    const origLines = change.original.split('\n');
    const modLines = change.modified.split('\n');
    const maxLines = Math.max(origLines.length, modLines.length);
    const lines: Array<{ type: 'added' | 'removed' | 'neutral'; text: string }> = [];

    for (let i = 0; i < maxLines; i++) {
      if (i < origLines.length && i < modLines.length) {
        if (origLines[i] === modLines[i]) {
          lines.push({ type: 'neutral', text: `  ${origLines[i]}` });
        } else {
          lines.push({ type: 'removed', text: `- ${origLines[i]}` });
          lines.push({ type: 'added', text: `+ ${modLines[i]}` });
        }
      } else if (i < origLines.length) {
        lines.push({ type: 'removed', text: `- ${origLines[i]}` });
      } else {
        lines.push({ type: 'added', text: `+ ${modLines[i]}` });
      }
    }

    return lines;
  };

  return (
    <div className={`suggestion-card ${suggestion.status !== 'pending' ? 'suggestion-card--resolved' : ''}`}>
      <div
        className="suggestion-card__header"
        onClick={() => setExpanded(!expanded)}
        style={{ cursor: 'pointer' }}
      >
        <span className={`suggestion-card__dot suggestion-card__dot--${suggestion.type} ${loading ? 'suggestion-card__dot--loading' : ''}`} />
        <span className={`suggestion-card__type suggestion-card__type--${suggestion.type}`}>
          {TYPE_LABELS[suggestion.type] || suggestion.type}
        </span>
        <span className="suggestion-card__title">{suggestion.title}</span>
        <span className={`suggestion-card__status suggestion-card__status--${suggestion.status}`}>
          {suggestion.status === 'pending' ? '待处理' :
           suggestion.status === 'accepted' ? '已接受' :
           suggestion.status === 'rejected' ? '已拒绝' : '已应用'}
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
            <div key={idx}>
              <div className="suggestion-card__file">
                📄 <span>{change.filePath}</span>
                {change.explanation && (
                <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>
                  — <MarkdownContent content={change.explanation} enableOptions={false} />
                </span>
              )}
              </div>
              <div className="suggestion-card__diff">
                {renderDiff(change).map((line, li) => (
                  <div key={li} className={`diff-line--${line.type}`}>{line.text}</div>
                ))}
              </div>
            </div>
          ))}

          {suggestion.status === 'pending' && (
            <div className="suggestion-card__actions">
              <button className="action-btn action-btn--accept" onClick={() => onAccept(suggestion.id)}>
                ✓ 接受
              </button>
              <button className="action-btn action-btn--reject" onClick={() => onReject(suggestion.id)}>
                ✕ 拒绝
              </button>
              {suggestion.changes.length > 0 && (
                <button className="action-btn action-btn--preview" onClick={() => onPreviewDiff(suggestion.id)}>
                  ⇄ 预览差异
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
