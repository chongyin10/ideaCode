import type { ToolCallInfo } from '../../types';
import { ToolCallCard } from './ToolCallCard';
import { ReadFileGroup } from './ReadFileGroup';
import { ShellGroup } from './ShellGroup';

interface ToolCallLogProps {
  toolCalls: ToolCallInfo[];
}

// 文件操作类工具集合（读取/生成/编辑/删除），这些工具的调用会聚合成组展示
const FILE_OP_TOOLS = new Set([
  'read_file',
  'read_file_outline',
  'read_file_lines',
  'search_in_file',
  'read_file_chunks',
  'write_file',
  'apply_edit',
  'delete_file',
]);

type Row =
  | { type: 'readGroup'; calls: ToolCallInfo[] }
  | { type: 'shellGroup'; calls: ToolCallInfo[]; merged?: boolean }
  | { type: 'card'; call: ToolCallInfo };

export function ToolCallLog({ toolCalls }: ToolCallLogProps) {
  if (toolCalls.length === 0) return null;

  // 分组策略：
  // 1. FILE_OP_TOOLS → ReadFileGroup（保持原顺序）
  // 2. execute_shell running → ShellGroup（实时展开）
  // 3. execute_shell 已完成/失败 → 统一合并到末尾的 ShellGroup（自动折叠，如图 5）
  // 4. 其他 → ToolCallCard
  const rows: Row[] = [];
  let currentReadGroup: ToolCallInfo[] = [];
  let currentRunningShellGroup: ToolCallInfo[] = [];
  const completedShells: ToolCallInfo[] = [];

  const flushReadGroup = () => {
    if (currentReadGroup.length > 0) {
      rows.push({ type: 'readGroup', calls: currentReadGroup });
      currentReadGroup = [];
    }
  };
  const flushRunningShellGroup = () => {
    if (currentRunningShellGroup.length > 0) {
      rows.push({ type: 'shellGroup', calls: currentRunningShellGroup });
      currentRunningShellGroup = [];
    }
  };

  for (const call of toolCalls) {
    if (FILE_OP_TOOLS.has(call.tool)) {
      flushRunningShellGroup();
      currentReadGroup.push(call);
      continue;
    }
    if (call.tool === 'execute_shell') {
      flushReadGroup();
      if (call.status === 'running') {
        currentRunningShellGroup.push(call);
      } else {
        flushRunningShellGroup();
        completedShells.push(call);
      }
      continue;
    }
    flushReadGroup();
    flushRunningShellGroup();
    rows.push({ type: 'card', call });
  }
  flushReadGroup();
  flushRunningShellGroup();

  // 所有已完成的 shell 合并成一个面板，放在最后
  if (completedShells.length > 0) {
    rows.push({ type: 'shellGroup', calls: completedShells, merged: true });
  }

  return (
    <div className="tool-call-log">
      <div className="tool-call-log__header">Tool 调用记录</div>
      {rows.map((row, index) => {
        if (row.type === 'readGroup') {
          const isGroupActive = row.calls.some((c) => c.status === 'running');
          return <ReadFileGroup key={`read-${index}`} calls={row.calls} isActive={isGroupActive} />;
        }
        if (row.type === 'shellGroup') {
          return <ShellGroup key={`shell-${index}`} calls={row.calls} merged={row.merged} />;
        }
        return <ToolCallCard key={`card-${index}`} toolCall={row.call} />;
      })}
    </div>
  );
}
