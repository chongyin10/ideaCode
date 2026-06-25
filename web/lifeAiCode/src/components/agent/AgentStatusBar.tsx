interface AgentStatusBarProps {
  status: string;
  message: string;
  onCancel?: () => void;
}

export function AgentStatusBar({ status, message, onCancel }: AgentStatusBarProps) {
  return (
    <div className={`agent-status agent-status--${status}`}>
      <span className="agent-status__indicator" />
      <span className="agent-status__message">{message}</span>
      {status === 'running' && onCancel && (
        <button className="agent-status__cancel" onClick={onCancel}>
          停止
        </button>
      )}
    </div>
  );
}
