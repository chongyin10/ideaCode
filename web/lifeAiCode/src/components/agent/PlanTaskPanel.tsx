import { useMemo, useState } from 'react';
import { ListTodo, Loader2, Check, AlertCircle, Circle, MinusCircle, ChevronDown } from 'lucide-react';
import type { PlanStep, PlanStepStatus } from './PlanChecklist';

interface PlanTaskPanelProps {
  steps: PlanStep[];
}

const STATUS_ICON: Record<PlanStepStatus, typeof Circle> = {
  pending: Circle,
  running: Loader2,
  done: Check,
  error: AlertCircle,
  skipped: MinusCircle,
};

const STATUS_LABEL: Record<PlanStepStatus, string> = {
  pending: '待执行',
  running: '执行中',
  done: '完成',
  error: '失败',
  skipped: '跳过',
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

function getTaskName(step: PlanStep): string {
  if (step.title) return step.title;
  if (step.tool) return step.tool;
  return step.reason || '未命名任务';
}

export function PlanTaskPanel({ steps }: PlanTaskPanelProps) {
  const [expanded, setExpanded] = useState(true);

  if (!steps || steps.length === 0) return null;

  const total = steps.length;
  const doneCount = steps.filter((s) => s.status === 'done').length;
  const runningCount = steps.filter((s) => s.status === 'running').length;
  const errorCount = steps.filter((s) => s.status === 'error').length;

  const isRunning = runningCount > 0;

  return (
    <div className="plan-task-panel">
      <button
        type="button"
        className="plan-task-panel__header"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className="plan-task-panel__icon">
          {isRunning ? (
            <Loader2 size={13} strokeWidth={2} className="plan-task-panel__spin" />
          ) : (
            <ListTodo size={13} strokeWidth={2} />
          )}
        </span>
        <span className="plan-task-panel__title">执行计划</span>
        <span className="plan-task-panel__count">
          {doneCount}/{total}
          {runningCount > 0 && ` · ${runningCount} 执行中`}
          {errorCount > 0 && ` · ${errorCount} 失败`}
        </span>
        <span className={`plan-task-panel__chevron ${expanded ? 'plan-task-panel__chevron--open' : ''}`}>
          <ChevronDown size={14} strokeWidth={2} />
        </span>
      </button>
      {expanded && (
        <ul className="plan-task-panel__list">
          {steps.map((step, i) => {
            const status = step.status || 'pending';
            const StatusIcon = STATUS_ICON[status];
            const name = getTaskName(step);
            let duration = '';
            if (step.startTime && step.endTime) {
              duration = formatDuration(step.endTime - step.startTime);
            } else if (step.startTime && status === 'running') {
              duration = '进行中';
            }
            return (
              <li key={i} className={`plan-task-panel__item plan-task-panel__item--${status}`}>
                <span className="plan-task-panel__item-icon">
                  <StatusIcon size={12} strokeWidth={2} className={status === 'running' ? 'plan-task-panel__spin' : undefined} />
                </span>
                <span className="plan-task-panel__item-index">{i + 1}</span>
                <span className="plan-task-panel__item-name" title={name}>{name}</span>
                {step.reason && step.reason !== name && (
                  <span className="plan-task-panel__item-reason" title={step.reason}>{step.reason}</span>
                )}
                {duration && (
                  <span className="plan-task-panel__item-time">{duration}</span>
                )}
                {step.summary && (status === 'done' || status === 'error') && (
                  <span className="plan-task-panel__item-summary" title={step.summary}>{step.summary}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
