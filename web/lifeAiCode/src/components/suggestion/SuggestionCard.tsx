/* ─────────────────────────────────────────────────────────────────── */
/*  SuggestionCard：建议卡片主组件                                      */
/* ─────────────────────────────────────────────────────────────────── */
/*  渲染建议卡片骨架（header: 类型标签 + 标题 + 状态；body: 描述 +
 *  diff 对比 + 操作按钮）。
 *
 *  Action 模式：建议类型元数据（label/icon）从 suggestionTypes 注册表
 *  获取，新增类型只需 registerSuggestionType，不改动此组件。
 *  DiffView 已拆为独立组件，可复用。                              */

import { useState } from 'react';
import { Check, X } from 'lucide-react';
import type { Suggestion, SuggestionChange } from '../../types';
import { MarkdownContent } from '../MarkdownContent';
import { DiffView } from './DiffView';
import { getSuggestionTypeMeta, isKnownSuggestionType } from './suggestionTypes';

interface SuggestionCardProps {
  suggestion: Suggestion;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onOpenDiffInEditor: (change: SuggestionChange) => void;
  loading?: boolean;
}

export function SuggestionCard({ suggestion, onAccept, onReject, onOpenDiffInEditor, loading }: SuggestionCardProps) {
  const [expanded, setExpanded] = useState(true);
  const typeMeta = getSuggestionTypeMeta(suggestion.type);
  const knownType = isKnownSuggestionType(suggestion.type);
  const typeClass = knownType ? suggestion.type : 'refactor';

  return (
    <div className={`suggestion-card ${suggestion.status !== 'pending' ? 'suggestion-card--resolved' : ''}`}>
      <div
        className="suggestion-card__header"
        onClick={() => setExpanded(!expanded)}
        style={{ cursor: 'pointer' }}
      >
        <span className={`suggestion-card__dot suggestion-card__dot--${typeClass} ${loading ? 'suggestion-card__dot--loading' : ''}`} />
        <span className={`suggestion-card__type suggestion-card__type--${typeClass}`}>
          <span className="suggestion-card__type-icon">
            {typeMeta.icon}
          </span>
          <span>{typeMeta.label}</span>
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
            <DiffView key={idx} change={change} onOpenDiffInEditor={onOpenDiffInEditor} />
          ))}

          {suggestion.status === 'pending' && (
            <div className="suggestion-card__actions">
              <button className="action-btn action-btn--accept" onClick={() => onAccept(suggestion.id)}>
                <Check size={13} strokeWidth={2.5} /> 接受
              </button>
              <button className="action-btn action-btn--reject" onClick={() => onReject(suggestion.id)}>
                <X size={13} strokeWidth={2.5} /> 拒绝
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
