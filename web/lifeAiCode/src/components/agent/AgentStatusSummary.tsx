import { forwardRef } from 'react';
import { ListTodo, FilePlus, FileEdit, FileMinus, CheckCircle2, Loader2, AlertCircle } from 'lucide-react';
import type { PlanStep } from './PlanChecklist';
import type { SuggestionChange } from '../../types';

interface AgentStatusSummaryProps {
  steps: PlanStep[];
  changes: SuggestionChange[];
}

function classifyChanges(changes: SuggestionChange[]) {
  let created = 0;
  let modified = 0;
  let deleted = 0;
  for (const c of changes) {
    if (c.status === 'reverted') continue;
    if (c.original === '' && c.modified !== '') {
      created++;
    } else if (c.modified === '' && c.original !== '') {
      deleted++;
    } else {
      modified++;
    }
  }
  return { created, modified, deleted };
}

export const AgentStatusSummary = forwardRef<HTMLDivElement, AgentStatusSummaryProps>(
  ({ steps, changes }, _ref) => {
    if ((!steps || steps.length === 0) && changes.length === 0) return null;

    const total = steps.length;
    const doneCount = steps.filter((s) => s.status === 'done').length;
    const runningCount = steps.filter((s) => s.status === 'running').length;
    const errorCount = steps.filter((s) => s.status === 'error').length;
    const { created, modified, deleted } = classifyChanges(changes);
    const hasChanges = created > 0 || modified > 0 || deleted > 0;

    let StatusIcon = CheckCircle2;
    let statusClass = 'agent-summary__status--done';
    if (runningCount > 0) {
      StatusIcon = Loader2;
      statusClass = 'agent-summary__status--running';
    } else if (errorCount > 0) {
      StatusIcon = AlertCircle;
      statusClass = 'agent-summary__status--error';
    }

    return (
      <div className="agent-summary">
        {total > 0 && (
          <div className={`agent-summary__status ${statusClass}`}>
            <StatusIcon size={12} strokeWidth={2} className={runningCount > 0 ? 'agent-summary__spin' : undefined} />
            <ListTodo size={12} strokeWidth={2} />
            <span className="agent-summary__text">
              计划 {doneCount}/{total}
            </span>
          </div>
        )}
        {hasChanges && (
          <div className="agent-summary__changes">
            {created > 0 && (
              <span className="agent-summary__tag agent-summary__tag--created" title={`创建 ${created} 个文件`}>
                <FilePlus size={10} strokeWidth={2} />
                {created}
              </span>
            )}
            {modified > 0 && (
              <span className="agent-summary__tag agent-summary__tag--modified" title={`修改 ${modified} 个文件`}>
                <FileEdit size={10} strokeWidth={2} />
                {modified}
              </span>
            )}
            {deleted > 0 && (
              <span className="agent-summary__tag agent-summary__tag--deleted" title={`删除 ${deleted} 个文件`}>
                <FileMinus size={10} strokeWidth={2} />
                {deleted}
              </span>
            )}
          </div>
        )}
      </div>
    );
  }
);

AgentStatusSummary.displayName = 'AgentStatusSummary';
