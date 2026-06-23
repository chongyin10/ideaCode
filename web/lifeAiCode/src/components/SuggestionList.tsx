import type { Suggestion } from '../types';
import { SuggestionCard } from './SuggestionCard';

interface SuggestionListProps {
  suggestions: Suggestion[];
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onPreviewDiff: (id: string) => void;
}

export function SuggestionList({ suggestions, onAccept, onReject, onPreviewDiff }: SuggestionListProps) {
  if (suggestions.length === 0) return null;

  return (
    <div className="suggestions-container">
      {suggestions.map((s) => (
        <SuggestionCard
          key={s.id}
          suggestion={s}
          onAccept={onAccept}
          onReject={onReject}
          onPreviewDiff={onPreviewDiff}
        />
      ))}
    </div>
  );
}
