import { useState, useRef, useEffect, forwardRef } from 'react';
import {
  ListTodo, Loader2, CheckCircle2, AlertCircle, ChevronDown,
  Circle, Check, MinusCircle,
} from 'lucide-react';
import type { PlanStep, PlanStepStatus } from './PlanChecklist';

interface TodoDropdownProps {
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
  pending: 'todo-dd__item--pending',
  running: 'todo-dd__item--running',
  done: 'todo-dd__item--done',
  error: 'todo-dd__item--error',
  skipped: 'todo-dd__item--skipped',
};

/** 格式化执行时长：ms → "1.2s" / "35s" / "2m10s" */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}.${Math.floor((ms % 1000) / 100)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

/** 获取任务的显示名称：优先 title，其次 tool，最后 reason */
function getTaskName(step: PlanStep): string {
  if (step.title) return step.title;
  if (step.tool) return step.tool;
  return step.reason || '未命名任务';
}

export const TodoDropdown = forwardRef<HTMLDivElement, TodoDropdownProps>(({ steps }, _ref) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // 外部点击关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const blurHandler = () => setOpen(false);
    document.addEventListener('mousedown', handler);
    window.addEventListener('blur', blurHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      window.removeEventListener('blur', blurHandler);
    };
  }, [open]);

  if (!steps || steps.length === 0) return null;

  const total = steps.length;
  const doneCount = steps.filter((s) => s.status === 'done').length;
  const runningCount = steps.filter((s) => s.status === 'running').length;
  const errorCount = steps.filter((s) => s.status === 'error').length;

  // 按钮图标随当前阶段动态变化
  let ButtonIcon = ListTodo;
  let buttonClass = 'todo-dd__btn';
  let buttonTitle = `待办任务 ${doneCount}/${total}`;
  if (runningCount > 0) {
    ButtonIcon = Loader2;
    buttonClass += ' todo-dd__btn--running';
    buttonTitle = `执行中 ${doneCount}/${total}`;
  } else if (errorCount > 0) {
    ButtonIcon = AlertCircle;
    buttonClass += ' todo-dd__btn--error';
    buttonTitle = `${errorCount} 项失败 · ${doneCount}/${total}`;
  } else if (doneCount === total) {
    ButtonIcon = CheckCircle2;
    buttonClass += ' todo-dd__btn--done';
    buttonTitle = `全部完成 ${doneCount}/${total}`;
  }

  return (
    <div className="todo-dd" ref={containerRef}>
      <button
        ref={buttonRef}
        type="button"
        className={buttonClass}
        title={buttonTitle}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <ButtonIcon
          size={13}
          strokeWidth={2}
          className={runningCount > 0 ? 'todo-dd__btn-spinner' : undefined}
        />
        <span className="todo-dd__btn-count">{doneCount}/{total}</span>
        <ChevronDown
          size={11}
          strokeWidth={2}
          className={`todo-dd__btn-chevron ${open ? 'todo-dd__btn-chevron--open' : ''}`}
        />
      </button>

      {open && (
        <div className="todo-dd__panel">
          <div className="todo-dd__header">
            <span className="todo-dd__title">待办任务</span>
            <span className="todo-dd__summary">
              {doneCount}/{total} 完成
              {runningCount > 0 && ` · ${runningCount} 执行中`}
              {errorCount > 0 && ` · ${errorCount} 失败`}
            </span>
          </div>
          <ul className="todo-dd__list">
            {steps.map((step, i) => {
              const status: PlanStepStatus = step.status || 'pending';
              const StatusIcon = STATUS_ICON[status];
              const taskName = getTaskName(step);
              // 计算执行时长
              let durationText = '';
              if (step.startTime && step.endTime) {
                durationText = formatDuration(step.endTime - step.startTime);
              } else if (step.startTime && status === 'running') {
                durationText = '进行中';
              }
              return (
                <li key={i} className={`todo-dd__item ${STATUS_CLASS[status]}`}>
                  <span className="todo-dd__item-icon">
                    <StatusIcon
                      size={12}
                      strokeWidth={2}
                      className={status === 'running' ? 'todo-dd__item-spinner' : undefined}
                    />
                  </span>
                  <span className="todo-dd__item-index">{i + 1}</span>
                  <span className="todo-dd__item-name" title={taskName}>{taskName}</span>
                  {step.reason && step.reason !== taskName && (
                    <span className="todo-dd__item-reason" title={step.reason}>{step.reason}</span>
                  )}
                  {durationText && (
                    <span className="todo-dd__item-time">{durationText}</span>
                  )}
                  {step.summary && (status === 'done' || status === 'error') && (
                    <span className="todo-dd__item-summary" title={step.summary}>{step.summary}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
});

TodoDropdown.displayName = 'TodoDropdown';
