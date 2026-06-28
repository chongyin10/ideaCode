interface AgentModeToggleProps {
  enabled: boolean;
  onToggle: () => void;
  disabled?: boolean;
}

export function AgentModeToggle({ enabled, onToggle, disabled }: AgentModeToggleProps) {
  return (
    <button
      className={`input-icon-btn ${enabled ? 'input-icon-btn--active' : ''} ${disabled ? 'input-icon-btn--disabled' : ''}`}
      title={disabled ? '当前正在对话中，功能暂不可用' : (enabled ? 'Agent 模式已开启' : 'Agent 模式已关闭')}
      disabled={disabled}
      onClick={() => !disabled && onToggle()}
    >
      <span style={{ fontSize: 11, fontWeight: 600 }}>A</span>
    </button>
  );
}
