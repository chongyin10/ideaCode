import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

interface Props {
  icon: ReactNode;
  title: string;
  description?: string;
  primaryAction?: {
    label: string;
    icon?: ReactNode;
    onClick: () => void;
  };
  secondaryAction?: {
    label: string;
    icon?: ReactNode;
    onClick: () => void;
  };
  busy?: boolean;
}

export default function EmptyState({ icon, title, description, primaryAction, secondaryAction, busy }: Props) {
  return (
    <div className="git-empty">
      <div className="git-empty__icon">{icon}</div>
      <h2 className="git-empty__title">{title}</h2>
      {description && <p className="git-empty__desc">{description}</p>}
      <div className="git-empty__actions">
        {primaryAction && (
          <button className="git-btn git-btn--primary" onClick={primaryAction.onClick} disabled={busy}>
            {busy ? <Loader2 size={14} className="git-spin" /> : primaryAction.icon}
            <span>{primaryAction.label}</span>
          </button>
        )}
        {secondaryAction && (
          <button className="git-btn" onClick={secondaryAction.onClick} disabled={busy}>
            {secondaryAction.icon}
            <span>{secondaryAction.label}</span>
          </button>
        )}
      </div>
    </div>
  );
}