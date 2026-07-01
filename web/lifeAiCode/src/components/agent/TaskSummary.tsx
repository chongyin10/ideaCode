import { useMemo } from 'react';
import { FileText, FilePlus, FileEdit, FileMinus, Terminal, CheckCircle2, Clock, ListTodo, GitCompare } from 'lucide-react';
import type { ToolCallInfo } from '../../types';
import type { PlanStep } from './PlanChecklist';
import type { SuggestionChange } from '../../types';

interface TaskSummaryProps {
  toolCalls?: ToolCallInfo[];
  planSteps?: PlanStep[];
  changes?: SuggestionChange[];
  duration?: number | null;
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r > 0 ? `${m}m${r}s` : `${m}m`;
}

export function TaskSummary({ toolCalls = [], planSteps = [], changes = [], duration }: TaskSummaryProps) {
  const stats = useMemo(() => {
    let read = 0;
    let created = 0;
    let edited = 0;
    let deleted = 0;
    let commands = 0;
    for (const call of toolCalls) {
      if (call.status !== 'success' && call.status !== 'error') continue;
      switch (call.tool) {
        case 'read_file':
        case 'read_file_outline':
        case 'read_file_lines':
        case 'read_file_chunks':
        case 'search_in_file':
          read++;
          break;
        case 'write_file':
          created++;
          break;
        case 'apply_edit':
          edited++;
          break;
        case 'delete_file':
          deleted++;
          break;
        case 'execute_shell':
          commands++;
          break;
      }
    }
    return { read, created, edited, deleted, commands };
  }, [toolCalls]);

  const changedFiles = useMemo(() => {
    let created = 0;
    let modified = 0;
    let deleted = 0;
    for (const c of changes) {
      if (c.status === 'reverted') continue;
      if (c.original === '' && c.modified !== '') created++;
      else if (c.modified === '' && c.original !== '') deleted++;
      else modified++;
    }
    return { created, modified, deleted, total: changes.length };
  }, [changes]);

  const doneSteps = planSteps.filter((s) => s.status === 'done').length;
  const totalSteps = planSteps.length;

  const hasOperations =
    stats.read > 0 ||
    stats.created > 0 ||
    stats.edited > 0 ||
    stats.deleted > 0 ||
    stats.commands > 0 ||
    changedFiles.total > 0 ||
    totalSteps > 0;

  if (!hasOperations) return null;

  return (
    <div className="task-summary">
      <div className="task-summary__header">
        <CheckCircle2 size={13} strokeWidth={2} />
        <span>任务完成</span>
        {duration != null && (
          <span className="task-summary__time">
            <Clock size={11} strokeWidth={2} />
            {formatDuration(duration)}
          </span>
        )}
      </div>
      <div className="task-summary__body">
        {totalSteps > 0 && (
          <div className="task-summary__item" title="执行计划">
            <ListTodo size={12} strokeWidth={2} />
            <span>计划 {doneSteps}/{totalSteps}</span>
          </div>
        )}
        {stats.read > 0 && (
          <div className="task-summary__item" title="读取文件">
            <FileText size={12} strokeWidth={2} />
            <span>读取 {stats.read}</span>
          </div>
        )}
        {(stats.created > 0 || changedFiles.created > 0) && (
          <div className="task-summary__item task-summary__item--created" title="创建文件">
            <FilePlus size={12} strokeWidth={2} />
            <span>创建 {stats.created + changedFiles.created}</span>
          </div>
        )}
        {(stats.edited > 0 || changedFiles.modified > 0) && (
          <div className="task-summary__item task-summary__item--modified" title="修改文件">
            <FileEdit size={12} strokeWidth={2} />
            <span>修改 {stats.edited + changedFiles.modified}</span>
          </div>
        )}
        {(stats.deleted > 0 || changedFiles.deleted > 0) && (
          <div className="task-summary__item task-summary__item--deleted" title="删除文件">
            <FileMinus size={12} strokeWidth={2} />
            <span>删除 {stats.deleted + changedFiles.deleted}</span>
          </div>
        )}
        {stats.commands > 0 && (
          <div className="task-summary__item" title="执行命令">
            <Terminal size={12} strokeWidth={2} />
            <span>命令 {stats.commands}</span>
          </div>
        )}
        {changedFiles.total > 0 && (
          <div className="task-summary__item" title="文件变更总数">
            <GitCompare size={12} strokeWidth={2} />
            <span>变更 {changedFiles.total}</span>
          </div>
        )}
      </div>
    </div>
  );
}
