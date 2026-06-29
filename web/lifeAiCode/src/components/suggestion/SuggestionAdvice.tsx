/* ─────────────────────────────────────────────────────────────────── */
/*  SuggestionAdvice：轻量级建议行（无具体文件位置时使用）              */
/* ─────────────────────────────────────────────────────────────────── */
/*  §需求：没有具体文件位置的"建议"不应走完整 SuggestionCard 卡片样式。
 *  设计原则：
 *  1. 轻量：单行布局、无 background、无完整 border，整体高度约为 Card 的 60%
 *  2. 明确：左侧 💡 icon + 强调线 标识这是"建议"（与有 filePath 的"变更"区分）
 *  3. 可控：保留接受/拒绝入口，让用户依然能 confirm 这条建议
 *
 *  使用场景：SuggestionList 检测到 suggestion.changes[0]?.filePath 为空时
 *  渲染本组件（见 SuggestionList.tsx 路由）。                            */

import { Lightbulb, Check, X } from 'lucide-react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { Suggestion } from '../../types';

interface SuggestionAdviceProps {
  suggestion: Suggestion;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  loading?: boolean;
}

export function SuggestionAdvice({ suggestion, onAccept, onReject }: SuggestionAdviceProps) {
  // §建议文字优先级：title 优先（LLM 总结的简短说明），缺失则用 description
  const text = (suggestion.title && suggestion.title.trim()) || suggestion.description || '代码建议';
  const isResolved = suggestion.status !== 'pending';

  const handleAccept = (e: ReactMouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    onAccept(suggestion.id);
  };
  const handleReject = (e: ReactMouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    onReject(suggestion.id);
  };

  return (
    <div className={`suggestion-advice ${isResolved ? 'suggestion-advice--resolved' : ''}`}>
      <span className="suggestion-advice__icon" aria-hidden>
        <Lightbulb size={13} strokeWidth={2} />
      </span>
      <span className="suggestion-advice__text" title={text}>
        {text}
      </span>
      {suggestion.status === 'pending' ? (
        <div className="suggestion-advice__actions">
          <button
            type="button"
            className="action-btn action-btn--accept"
            title="接受建议"
            onClick={handleAccept}
          >
            <Check size={13} strokeWidth={2.5} />
          </button>
          <button
            type="button"
            className="action-btn action-btn--reject"
            title="拒绝建议"
            onClick={handleReject}
          >
            <X size={13} strokeWidth={2.5} />
          </button>
        </div>
      ) : (
        <span className={`suggestion-advice__status suggestion-advice__status--${suggestion.status}`}>
          {suggestion.status === 'accepted' ? '已接受' :
           suggestion.status === 'rejected' ? '已拒绝' :
           suggestion.status === 'applied' ? '已应用' : '未知'}
        </span>
      )}
    </div>
  );
}
