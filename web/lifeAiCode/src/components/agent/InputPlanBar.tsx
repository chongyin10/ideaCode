import { useState } from 'react';
import {
  ChevronDown, Circle, Loader2, Check, AlertCircle, MinusCircle, ListChecks,
} from 'lucide-react';
import type { PlanStep, PlanStepStatus } from './PlanChecklist';

interface InputPlanBarProps {
  steps: PlanStep[];
}

const STATUS_ICON: Record<PlanStepStatus, typeof Circle> = {
  pending: Circle,
  running: Loader2,
  done: Check,
  error: AlertCircle,
  skipped: MinusCircle,
};

const STATUS_CLASS: Record<PlanStepStatus, string> = {
  pending: 'input-plan-bar__item--pending',
  running: 'input-plan-bar__item--running',
  done: 'input-plan-bar__item--done',
  error: 'input-plan-bar__item--error',
  skipped: 'input-plan-bar__item--skipped',
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

export function InputPlanBar({ steps }: InputPlanBarProps) {
  const [expanded, setExpanded] = useState(true);

  if (!steps || steps.length === 0) return null;

  const total = steps.length;
  const doneCount = steps.filter((s) => s.status === 'done').length;
  const runningCount = steps.filter((s) => s.status === 'running').length;
  const errorCount = steps.filter((s) => s.status === 'error').length;

  let HeaderIcon = ListChecks;
  let headerClass = 'input-plan-bar__header';
  if (runningCount > 0) {
    HeaderIcon = Loader2;
    headerClass += ' input-plan-bar__header--running';
  } else if (errorCount > 0) {
    HeaderIcon = AlertCircle;
    headerClass += ' input-plan-bar__header--error';
  } else if (doneCount === total) {
    HeaderIcon = Check;
    headerClass += ' input-plan-bar__header--done';
  }

  let summaryText = `${doneCount}/${total} 完成`;
  if (runningCount > 0) summaryText += ` · ${runningCount} 执行中`;
  if (errorCount > 0) summaryText += ` · ${errorCount} 失败`;

  return (
    <div className="input-plan-bar">
      <button
        type="button"
        className={headerClass}
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className="input-plan-bar__header-icon">
          <HeaderIcon
            size={13}
            strokeWidth={2}
            className={runningCount > 0 ? 'input-plan-bar__header-spinner' : undefined}
          />
        </span>
        <span className="input-plan-bar__header-title">计划任务</span>
        <span className="input-plan-bar__header-summary">{summaryText}</span>
        <span className={`input-plan-bar__chevron ${expanded ? 'input-plan-bar__chevron--open' : ''}`}>
          <ChevronDown size={13} strokeWidth={2} />
        </span>
      </button>

      {expanded && (
        <ul className="input-plan-bar__list">
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
              <li key={i} className={`input-plan-bar__item ${STATUS_CLASS[status]}`}>
                <span className="input-plan-bar__item-icon">
                  <StatusIcon
                    size={12}
                    strokeWidth={2}
                    className={status === 'running' ? 'input-plan-bar__item-spinner' : undefined}
                  />
                </span>
                <span className="input-plan-bar__item-index">{i + 1}</span>
                <span className="input-plan-bar__item-name" title={taskName}>{taskName}</span>
                {step.reason && step.reason !== taskName && (
                  <span className="input-plan-bar__item-reason" title={step.reason}>{step.reason}</span>
                )}
                {durationText && (
                  <span className="input-plan-bar__item-time">{durationText}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
