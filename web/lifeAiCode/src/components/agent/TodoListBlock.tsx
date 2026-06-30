import { useState } from 'react';
import {
  ChevronDown, Circle, Loader2, Check, AlertCircle, MinusCircle, ListChecks,
} from 'lucide-react';
import type { PlanStep, PlanStepStatus } from './PlanChecklist';

interface TodoListBlockProps {
  steps: PlanStep[];
  /** 是否默认展开（最后一条消息默认展开） */
  defaultExpanded?: boolean;
}

const STATUS_ICON: Record<PlanStepStatus, typeof Circle> = {
  pending: Circle,
  running: Loader2,
  done: Check,
  error: AlertCircle,
  skipped: MinusCircle,
};

const STATUS_CLASS: Record<PlanStepStatus, string> = {
  pending: 'todo-block__item--pending',
  running: 'todo-block__item--running',
  done: 'todo-block__item--done',
  error: 'todo-block__item--error',
  skipped: 'todo-block__item--skipped',
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}.${Math.floor((ms % 1000) / 100)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

function getTaskName(step: PlanStep): string {
  if (step.title) return step.title;
  if (step.tool) return step.tool;
  return step.reason || '未命名任务';
}

export function TodoListBlock({ steps, defaultExpanded = true }: TodoListBlockProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (!steps || steps.length === 0) return null;

  const total = steps.length;
  const doneCount = steps.filter((s) => s.status === 'done').length;
  const runningCount = steps.filter((s) => s.status === 'running').length;
  const errorCount = steps.filter((s) => s.status === 'error').length;

  // 头部图标随整体状态变化
  let HeaderIcon = ListChecks;
  let headerClass = 'todo-block__header';
  if (runningCount > 0) {
    HeaderIcon = Loader2;
    headerClass += ' todo-block__header--running';
  } else if (errorCount > 0) {
    HeaderIcon = AlertCircle;
    headerClass += ' todo-block__header--error';
  } else if (doneCount === total) {
    HeaderIcon = Check;
    headerClass += ' todo-block__header--done';
  }

  let summaryText = `${doneCount}/${total} 完成`;
  if (runningCount > 0) summaryText += ` · ${runningCount} 执行中`;
  if (errorCount > 0) summaryText += ` · ${errorCount} 失败`;

  return (
    <div className="todo-block">
      <button
        type="button"
        className={headerClass}
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className="todo-block__header-icon">
          <HeaderIcon
            size={13}
            strokeWidth={2}
            className={runningCount > 0 ? 'todo-block__header-spinner' : undefined}
          />
        </span>
        <span className="todo-block__header-title">待办任务</span>
        <span className="todo-block__header-summary">{summaryText}</span>
        <span className={`todo-block__chevron ${expanded ? 'todo-block__chevron--open' : ''}`}>
          <ChevronDown size={13} strokeWidth={2} />
        </span>
      </button>

      {expanded && (
        <ul className="todo-block__list">
          {steps.map((step, i) => {
            const status: PlanStepStatus = step.status || 'pending';
            const StatusIcon = STATUS_ICON[status];
            const taskName = getTaskName(step);
            let durationText = '';
            if (step.startTime && step.endTime) {
              durationText = formatDuration(step.endTime - step.startTime);
            } else if (step.startTime && status === 'running') {
              durationText = '进行中';
            }
            return (
              <li key={i} className={`todo-block__item ${STATUS_CLASS[status]}`}>
                <span className="todo-block__item-icon">
                  <StatusIcon
                    size={12}
                    strokeWidth={2}
                    className={status === 'running' ? 'todo-block__item-spinner' : undefined}
                  />
                </span>
                <span className="todo-block__item-index">{i + 1}</span>
                <span className="todo-block__item-name" title={taskName}>{taskName}</span>
                {step.reason && step.reason !== taskName && (
                  <span className="todo-block__item-reason" title={step.reason}>{step.reason}</span>
                )}
                {durationText && (
                  <span className="todo-block__item-time">{durationText}</span>
                )}
                {step.summary && (status === 'done' || status === 'error') && (
                  <span className="todo-block__item-summary" title={step.summary}>{step.summary}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
