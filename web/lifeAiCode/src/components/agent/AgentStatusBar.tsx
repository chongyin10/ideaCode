interface AgentStatusBarProps {
  status: string;
  message: string;
  onCancel?: () => void;
  /** 紧凑内联模式：用于底部状态栏，去掉卡片边框与大内边距 */
  inline?: boolean;
}

export function AgentStatusBar({ status, message, onCancel, inline }: AgentStatusBarProps) {
  return (
    <div className={`agent-status agent-status--${status} ${inline ? 'agent-status--inline' : ''}`}>
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
