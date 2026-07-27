import { useState, useEffect, useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ToolCallInfo } from '../../types';
import { ToolCallCard } from './ToolCallCard';

interface ShellGroupProps {
  calls: ToolCallInfo[];
  /** 是否为“已完成 shell 合并面板”，默认折叠 */
  merged?: boolean;
}

/**
 * 多个 execute_shell 工具调用的容器面板：
 *
 * ▸ 顶部 header：图标 + "General智能体 N" 标题 + 状态徽章 + 折叠 chevron
 * ▸ 当且仅当面板里存在 running 子任务时，自动展开（并把运行中的子任务高亮）
 * ▸ 当所有子任务都是 success/error 时，自动折叠（但保留上次手动状态 1.5s 再切）
 * ▸ 用户点击 header 可强制展开/收起——手动状态优先级最高
 * ▸ 子任务卡片继续用 ToolCallCard 渲染，子任务本身已能"running 时自动展开"
 */
export function ShellGroup({ calls, merged }: ShellGroupProps) {
  const [userExpanded, setUserExpanded] = useState<boolean | null>(merged ? false : null);
  // 保留自动模式结束后 1.5s 的"用户操作冻结期"，避免状态抖动导致反复展开/收起
  const freezeTimerRef = useRef<number | null>(null);

  const runningCount = calls.filter((c) => c.status === 'running').length;
  const allDone = runningCount === 0;

  // 当前正在运行的子任务（用于面板展开时聚焦到它）
  const currentCall = calls.find((c) => c.status === 'running') || calls[calls.length - 1];

  // 自动展开策略：
  // - 有 running → 自动展开（高亮当前子任务）
  // - 全部完成 → 自动折叠（经历 1.5s 冻结期，避免用户刚读到结果时被立即收起）
  // 用户主动点 header 切到非 null 后不再被自动模式覆盖
  useEffect(() => {
    if (userExpanded !== null) return;
    if (runningCount > 0) {
      setUserExpanded(true);
    } else if (allDone && calls.length > 0) {
      // 冻结 1.5s 后再切到"已折叠"
      if (freezeTimerRef.current != null) {
        window.clearTimeout(freezeTimerRef.current);
      }
      freezeTimerRef.current = window.setTimeout(() => {
        setUserExpanded((cur) => (cur === null ? false : cur));
      }, 1500);
    }
    return () => {
      if (freezeTimerRef.current != null) {
        window.clearTimeout(freezeTimerRef.current);
        freezeTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningCount, allDone, calls.length]);

  // 用户点击 header：切换；若当前是 null（自动模式），首次点击视为"用户接管"
  const handleHeaderClick = () => {
    setUserExpanded((cur) => {
      // 自动模式：当前展开 → 收起；当前收起 → 展开
      if (cur === null) return !autoExpanded;
      return !cur;
    });
  };

  const autoExpanded = runningCount > 0;
  const expanded = userExpanded !== null ? userExpanded : autoExpanded;

  // §图标对齐：header 右侧只保留 chevron；运行/成功/失败状态由左侧
  // shell-group__dot 的颜色与脉冲表达（CSS :has() 根据子任务卡片状态着色）。

  return (
    <div className={`shell-group ${expanded ? 'shell-group--open' : 'shell-group--collapsed'}`}>
      <button
        type="button"
        className="shell-group__header"
        onClick={handleHeaderClick}
        aria-expanded={expanded}
      >
        <span className="shell-group__dot" />
        <span className="shell-group__title">General智能体</span>
        <span className="shell-group__count">{calls.length}</span>
        <span className={`shell-group__chevron ${expanded ? 'shell-group__chevron--open' : ''}`}>
          <ChevronDown size={14} strokeWidth={2} />
        </span>
      </button>

      {expanded && (
        <div className="shell-group__list">
          {calls.map((call, index) => {
            const isCurrent = call === currentCall && runningCount > 0;
            return (
              <div
                key={index}
                className={`shell-group__item ${isCurrent ? 'shell-group__item--current' : ''}`}
              >
                <ToolCallCard toolCall={call} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
