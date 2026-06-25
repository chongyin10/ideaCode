interface AgentModeToggleProps {
  enabled: boolean;
  onToggle: () => void;
}

export function AgentModeToggle({ enabled, onToggle }: AgentModeToggleProps) {
  return (
    <button
      className={`input-icon-btn ${enabled ? 'input-icon-btn--active' : ''}`}
      title={enabled ? 'Agent 模式已开启' : 'Agent 模式已关闭'}
      onClick={onToggle}
    >
      <span style={{ fontSize: 11, fontWeight: 600 }}>A</span>
    </button>
  );
}
