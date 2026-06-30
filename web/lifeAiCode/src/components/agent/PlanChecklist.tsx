import { Check, Loader2, AlertCircle, Circle, MinusCircle } from 'lucide-react';

/** §需求9：单个 plan step 的状态 */
export type PlanStepStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';

/** §需求9：plan step 数据结构 */
export interface PlanStep {
  step: number;
  tool: string;
  args: Record<string, unknown>;
  reason: string;
  status?: PlanStepStatus;
  summary?: string;
  /** §待办任务：执行起止时间戳，用于显示执行时长 */
  startTime?: number;
  endTime?: number;
  /** §待办任务：任务显示名称（优先于 tool） */
  title?: string;
}

interface PlanChecklistProps {
  steps: PlanStep[];
}

/** 把 args 对象压缩成简短摘要，便于一行展示 */
function summarizeArgs(args: Record<string, unknown>): string {
  if (!args || Object.keys(args).length === 0) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    let v: string;
    if (typeof value === 'string') {
      v = value.length > 40 ? `${value.slice(0, 37)}...` : value;
    } else if (value === null || value === undefined) {
      v = '';
    } else {
      try {
        v = JSON.stringify(value);
        if (v.length > 40) v = `${v.slice(0, 37)}...`;
      } catch {
        v = String(value);
      }
    }
    if (v !== '') parts.push(`${key}=${v}`);
  }
  return parts.slice(0, 3).join('  ');
}

const STATUS_META: Record<PlanStepStatus, { icon: typeof Check; className: string; label: string }> = {
  pending: { icon: Circle, className: 'plan-step--pending', label: '待执行' },
  running: { icon: Loader2, className: 'plan-step--running', label: '执行中' },
  done: { icon: Check, className: 'plan-step--done', label: '完成' },
  error: { icon: AlertCircle, className: 'plan-step--error', label: '失败' },
  skipped: { icon: MinusCircle, className: 'plan-step--skipped', label: '跳过' },
};

export function PlanChecklist({ steps }: PlanChecklistProps) {
  if (!steps || steps.length === 0) return null;

  const doneCount = steps.filter((s) => s.status === 'done').length;
  const errorCount = steps.filter((s) => s.status === 'error').length;
  const runningCount = steps.filter((s) => s.status === 'running').length;
  const total = steps.length;

  let summaryLabel = `${doneCount}/${total}`;
  if (errorCount > 0) summaryLabel += ` · ${errorCount} 失败`;
  if (runningCount > 0) summaryLabel += ` · 执行中`;

  return (
    <div className="plan-checklist">
      <div className="plan-checklist__header">
        <span className="plan-checklist__title">执行计划</span>
        <span className="plan-checklist__count">{summaryLabel}</span>
      </div>
      <ol className="plan-checklist__list">
        {steps.map((s, i) => {
          const status: PlanStepStatus = s.status || 'pending';
          const meta = STATUS_META[status];
          const Icon = meta.icon;
          const argsText = summarizeArgs(s.args);
          return (
            <li key={i} className={`plan-step ${meta.className}`}>
              <span className="plan-step__index">{i + 1}</span>
              <span className="plan-step__icon">
                <Icon size={13} strokeWidth={2} className={status === 'running' ? 'plan-step__spinner' : undefined} />
              </span>
              <div className="plan-step__body">
                <div className="plan-step__title">
                  <code className="plan-step__tool">{s.tool}</code>
                  {argsText && <span className="plan-step__args">{argsText}</span>}
                </div>
                {s.reason && <div className="plan-step__reason">{s.reason}</div>}
                {s.summary && status === 'done' && (
                  <div className="plan-step__summary">{s.summary}</div>
                )}
                {s.summary && status === 'error' && (
                  <div className="plan-step__summary plan-step__summary--error">{s.summary}</div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
