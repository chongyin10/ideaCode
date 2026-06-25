import { useState } from 'react';
import type { ToolCallInfo } from '../../types';
import { FileText, ChevronDown, Check, Loader2, X } from 'lucide-react';

interface ReadFileGroupProps {
  calls: ToolCallInfo[];
}

function getFileName(call: ToolCallInfo) {
  const path = String(call.args.path || call.args.file_path || '未知文件');
  return path.split('/').pop() || path;
}

export function ReadFileGroup({ calls }: ReadFileGroupProps) {
  const [expanded, setExpanded] = useState(false);

  if (calls.length === 0) return null;

  const runningCount = calls.filter((c) => c.status === 'running').length;
  const errorCount = calls.filter((c) => c.status === 'error').length;

  // 当前正在读取或最后读取的文件，用于折叠态预览
  const currentCall = calls.find((c) => c.status === 'running') || calls[calls.length - 1];
  const currentName = getFileName(currentCall);
  const hasMore = calls.length > 1;

  let statusIcon = <Check size={12} strokeWidth={2.5} />;
  let statusClass = 'read-file-group__status--success';
  if (runningCount > 0) {
    statusIcon = <Loader2 size={12} strokeWidth={2.5} className="read-file-group__spinner" />;
    statusClass = 'read-file-group__status--running';
  } else if (errorCount > 0) {
    statusIcon = <X size={12} strokeWidth={2.5} />;
    statusClass = 'read-file-group__status--error';
  }

  return (
    <div className="tool-call-card read-file-group">
      <button
        type="button"
        className="read-file-group__header"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className="read-file-group__icon">
          <FileText size={14} strokeWidth={1.8} />
        </span>
        <span className="read-file-group__title">
          已读取 {calls.length} 个文件
        </span>
        {!expanded && (
          <span className="read-file-group__preview" title={currentName}>
            {runningCount > 0 ? `读取 ${currentName} 中` : currentName}
            {hasMore && ` 等 ${calls.length} 个`}
          </span>
        )}
        <span className={`read-file-group__status ${statusClass}`}>
          {statusIcon}
          {runningCount > 0 ? '读取中' : errorCount > 0 ? '部分失败' : '完成'}
        </span>
        <span className={`read-file-group__chevron ${expanded ? 'read-file-group__chevron--open' : ''}`}>
          <ChevronDown size={14} strokeWidth={2} />
        </span>
      </button>

      {expanded && (
        <div className="read-file-group__list">
          {calls.map((call, index) => {
            const path = String(call.args.path || call.args.file_path || '未知文件');
            const fileName = path.split('/').pop() || path;
            const dir = path.slice(0, -fileName.length).replace(/\/$/, '');
            return (
              <div key={index} className={`read-file-group__item read-file-group__item--${call.status}`}>
                <span className="read-file-group__bullet" />
                <span className="read-file-group__path" title={path}>
                  <span className="read-file-group__dir">{dir ? `${dir}/` : ''}</span>
                  <span className="read-file-group__name">{fileName}</span>
                </span>
                {call.summary && (
                  <span className="read-file-group__meta">{call.summary}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
