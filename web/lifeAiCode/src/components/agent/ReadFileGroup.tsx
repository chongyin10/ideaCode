import { useEffect, useRef, useState } from 'react';
import type { ToolCallInfo } from '../../types';
import {
  FileText, ChevronDown, Check, Loader2, X, Search, List, Layers,
  FilePlus, Edit3, Trash2, Clock, Hourglass,
} from 'lucide-react';

interface ReadFileGroupProps {
  calls: ToolCallInfo[];
  /** 当前 group 处于活跃输出态：展开并跟随流程 */
  isActive?: boolean;
}

function getFileName(call: ToolCallInfo) {
  const path = String(call.args.path || call.args.file_path || '未知文件');
  return path.split('/').pop() || path;
}

/** 工具中文名称（操作类型） */
function getToolLabel(tool: string): string {
  switch (tool) {
    case 'read_file': return '读取';
    case 'read_file_outline': return '大纲';
    case 'read_file_lines': return '行范围';
    case 'search_in_file': return '搜索';
    case 'read_file_chunks': return '分块';
    case 'write_file': return '生成';
    case 'apply_edit': return '编辑';
    case 'delete_file': return '删除';
    default: return tool;
  }
}

/** 操作类型图标 */
function getToolIcon(tool: string) {
  switch (tool) {
    case 'search_in_file': return <Search size={11} strokeWidth={2} />;
    case 'read_file_outline': return <List size={11} strokeWidth={2} />;
    case 'read_file_chunks': return <Layers size={11} strokeWidth={2} />;
    case 'write_file': return <FilePlus size={11} strokeWidth={2} />;
    case 'apply_edit': return <Edit3 size={11} strokeWidth={2} />;
    case 'delete_file': return <Trash2 size={11} strokeWidth={2} />;
    default: return <FileText size={11} strokeWidth={2} />;
  }
}

/** 根据工具类型和参数生成详情文本 */
function getToolDetail(call: ToolCallInfo): string {
  switch (call.tool) {
    case 'read_file':
      return '';
    case 'read_file_outline':
      return '';
    case 'read_file_lines': {
      const s = call.args.startLine;
      const e = call.args.endLine;
      return s && e ? `L${s}-L${e}` : '';
    }
    case 'search_in_file': {
      const pattern = call.args.pattern;
      return pattern ? `"${String(pattern).slice(0, 30)}"` : '';
    }
    case 'read_file_chunks': {
      const idx = call.args.chunkIndex;
      return idx !== undefined ? `块 ${idx}` : '';
    }
    case 'write_file':
      return '';
    case 'apply_edit':
      return '';
    case 'delete_file':
      return '';
    default:
      return '';
  }
}

function isToolCallPending(call: ToolCallInfo) {
  return call.status === 'success' &&
    call.result && typeof call.result === 'object' &&
    'pending' in call.result && call.result.pending === true;
}

/**
 * 文件操作状态图标：
 * - running → Loader2 旋转
 * - error → X
 * - success + pending（等待用户确认） → Hourglass
 * - success（已确认/已完成） → Check
 */
function getStatusIcon(call: ToolCallInfo) {
  if (call.status === 'running') {
    return <Loader2 size={11} strokeWidth={2.5} className="read-file-group__status-icon--spinner" />;
  }
  if (call.status === 'error') {
    return <X size={11} strokeWidth={2.5} />;
  }
  if (isToolCallPending(call)) {
    return <Hourglass size={11} strokeWidth={2} />;
  }
  return <Check size={11} strokeWidth={2.5} />;
}

function getStatusClass(call: ToolCallInfo): string {
  if (call.status === 'running') return 'read-file-group__status-icon--running';
  if (call.status === 'error') return 'read-file-group__status-icon--error';
  if (isToolCallPending(call)) return 'read-file-group__status-icon--pending';
  return 'read-file-group__status-icon--success';
}

export function ReadFileGroup({ calls, isActive }: ReadFileGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const autoOpenedRef = useRef(false);

  if (calls.length === 0) return null;

  const runningCount = calls.filter((c) => c.status === 'running').length;
  const shouldExpand = isActive || runningCount > 0;

  useEffect(() => {
    if (shouldExpand) {
      if (!expanded) {
        setExpanded(true);
        autoOpenedRef.current = true;
      }
    } else if (expanded && autoOpenedRef.current) {
      setExpanded(false);
      autoOpenedRef.current = false;
    }
  }, [shouldExpand, expanded]);

  const errorCount = calls.filter((c) => c.status === 'error').length;
  const pendingCount = calls.filter((c) => {
    return c.status === 'success' && c.result && typeof c.result === 'object' &&
      'pending' in c.result && c.result.pending === true;
  }).length;

  // 当前正在执行或最后执行的操作，用于折叠态预览
  const currentCall = calls.find((c) => c.status === 'running') || calls[calls.length - 1];
  const currentName = getFileName(currentCall);
  const hasMore = calls.length > 1;

  const allPending = pendingCount > 0 && runningCount === 0 && errorCount === 0;
  let statusIcon = allPending ? <Hourglass size={12} strokeWidth={2} /> : <Check size={12} strokeWidth={2.5} />;
  let statusClass = allPending ? 'read-file-group__status--pending' : 'read-file-group__status--success';
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
          {calls.length} 次文件操作
        </span>
        {!expanded && (
          <span className="read-file-group__preview" title={currentName}>
            {runningCount > 0 ? `${getToolLabel(currentCall.tool)} ${currentName} 中` : `${getToolLabel(currentCall.tool)} ${currentName}`}
            {hasMore && ` 等 ${calls.length} 项`}
          </span>
        )}
        <span className={`read-file-group__chevron ${expanded ? 'read-file-group__chevron--open' : ''}`}>
          <ChevronDown size={14} strokeWidth={2} />
        </span>
        <span className={`read-file-group__status ${statusClass}`} title={
          runningCount > 0 ? '执行中' :
          errorCount > 0 ? '部分失败' :
          allPending ? '等待确认' : '完成'
        }>
          {statusIcon}
        </span>
      </button>

      {expanded && (
        <div className="read-file-group__list">
          {calls.map((call, index) => {
            const path = String(call.args.path || call.args.file_path || '未知文件');
            const fileName = path.split('/').pop() || path;
            const dir = path.slice(0, -fileName.length).replace(/\/$/, '');
            const detail = getToolDetail(call);
            return (
              <div key={index} className={`read-file-group__item read-file-group__item--${call.status}`}>
                <span className="read-file-group__tool-icon" title={call.tool}>
                  {getToolIcon(call.tool)}
                </span>
                <span className="read-file-group__tool-label">{getToolLabel(call.tool)}</span>
                <span className="read-file-group__path" title={path}>
                  <span className="read-file-group__dir">{dir ? `${dir}/` : ''}</span>
                  <span className="read-file-group__name">{fileName}</span>
                </span>
                {detail && (
                  <span className="read-file-group__detail">{detail}</span>
                )}
                {call.summary && (
                  <span className="read-file-group__meta">{call.summary}</span>
                )}
                <span className={`read-file-group__status-icon ${getStatusClass(call)}`} title={
                  call.status === 'running' ? '执行中' :
                  call.status === 'error' ? '失败' :
                  (call.result && typeof call.result === 'object' && 'pending' in call.result && call.result.pending === true) ? '等待确认' : '完成'
                }>
                  {getStatusIcon(call)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
