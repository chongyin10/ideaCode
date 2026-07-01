import { useState, useMemo } from 'react';
import { Check, Loader2, Circle, ChevronDown } from 'lucide-react';
import type { ContentBlock } from '../../types';

interface StepSummaryProps {
  steps: Array<Extract<ContentBlock, { type: 'step' }>>;
  completed?: boolean;
}

export function StepSummary({ steps, completed }: StepSummaryProps) {
  const [expanded, setExpanded] = useState(true);

  const { doneCount, total, items } = useMemo(() => {
    const effectiveSteps = steps.map((s) => {
      const status = completed && (s.status === 'running' || !s.status) ? 'done' : (s.status || 'pending');
      return { ...s, status };
    });
    const done = effectiveSteps.filter((s) => s.status === 'done').length;
    return { doneCount: done, total: effectiveSteps.length, items: effectiveSteps };
  }, [steps, completed]);

  if (total === 0) return null;

  return (
    <div className="step-summary">
      <button
        type="button"
        className="step-summary__header"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className="step-summary__title">
          已完成 {doneCount} 个任务（共 {total} 个）
        </span>
        <span className={`step-summary__chevron ${expanded ? 'step-summary__chevron--open' : ''}`}>
          <ChevronDown size={14} strokeWidth={2} />
        </span>
      </button>
      {expanded && (
        <ul className="step-summary__list">
          {items.map((step, i) => {
            const status = step.status || 'pending';
            const isDone = status === 'done';
            const isRunning = status === 'running';
            const label = step.label || step.target || `任务 ${i + 1}`;
            return (
              <li key={i} className={`step-summary__item step-summary__item--${status}`}>
                <span className="step-summary__checkbox">
                  {isDone ? (
                    <Check size={12} strokeWidth={2.5} />
                  ) : isRunning ? (
                    <Loader2 size={12} strokeWidth={2} className="step-summary__spin" />
                  ) : (
                    <Circle size={12} strokeWidth={2} />
                  )}
                </span>
                <span className="step-summary__label" title={label}>{label}</span>
                {step.params && (
                  <span className="step-summary__params" title={step.params}>{step.params}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
