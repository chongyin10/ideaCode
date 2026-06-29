import type { ToolCallInfo } from '../../types';
import { ToolCallCard } from './ToolCallCard';
import { ReadFileGroup } from './ReadFileGroup';

interface ToolCallLogProps {
  toolCalls: ToolCallInfo[];
}

// 文件读取类工具集合，这些工具的调用会聚合成组展示
const FILE_READ_TOOLS = new Set([
  'read_file',
  'read_file_outline',
  'read_file_lines',
  'search_in_file',
  'read_file_chunks',
]);

export function ToolCallLog({ toolCalls }: ToolCallLogProps) {
  if (toolCalls.length === 0) return null;

  // 将连续的文件读取类调用聚合成组，减少界面占用
  const rows: Array<{ type: 'readGroup'; calls: ToolCallInfo[] } | { type: 'card'; call: ToolCallInfo }> = [];
  let currentReadGroup: ToolCallInfo[] = [];

  for (const call of toolCalls) {
    if (FILE_READ_TOOLS.has(call.tool)) {
      currentReadGroup.push(call);
      continue;
    }
    if (currentReadGroup.length > 0) {
      rows.push({ type: 'readGroup', calls: currentReadGroup });
      currentReadGroup = [];
    }
    rows.push({ type: 'card', call });
  }
  if (currentReadGroup.length > 0) {
    rows.push({ type: 'readGroup', calls: currentReadGroup });
  }

  return (
    <div className="tool-call-log">
      <div className="tool-call-log__header">Tool 调用记录</div>
      {rows.map((row, index) =>
        row.type === 'readGroup' ? (
          <ReadFileGroup key={`read-${index}`} calls={row.calls} />
        ) : (
          <ToolCallCard key={`card-${index}`} toolCall={row.call} />
        )
      )}
    </div>
  );
}
