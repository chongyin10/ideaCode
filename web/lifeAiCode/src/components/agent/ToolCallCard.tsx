import type { ToolCallInfo } from '../../types';

interface ToolCallCardProps {
  toolCall: ToolCallInfo;
}

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const statusText =
    toolCall.status === 'running' ? '运行中' :
    toolCall.status === 'success' ? '成功' : '失败';

  return (
    <div className={`tool-call-card tool-call-card--${toolCall.status}`}>
      <div className="tool-call-card__header">
        <span className="tool-call-card__name">{toolCall.tool}</span>
        <span className={`tool-call-card__status tool-call-card__status--${toolCall.status}`}>
          {statusText}
        </span>
      </div>
      <div className="tool-call-card__args">
        {Object.entries(toolCall.args).map(([key, value]) => (
          <span key={key} className="tool-call-card__arg">
            {key}: {String(value).slice(0, 80)}
          </span>
        ))}
      </div>
      {toolCall.summary && (
        <div className="tool-call-card__summary">{toolCall.summary}</div>
      )}
    </div>
  );
}
