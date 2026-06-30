import { useState, useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight, Terminal, Loader2, Check, X } from 'lucide-react';
import type { ToolCallInfo } from '../../types';

interface ToolCallCardProps {
  toolCall: ToolCallInfo;
  /** 由父级容器（ShellGroup）传入：是否强制展开。当前用于展开正在运行的子任务 */
  forceExpanded?: boolean;
  /** 是否隐藏本身的折叠控件（在 ShellGroup 内嵌时不需要重复展开/收起按钮） */
  hideOutputToggle?: boolean;
}

/**
 * 单个工具调用的卡片：
 *
 * ▸ 整个 header 可点击，切换"展开/折叠 body"。
 *   - 折叠态：只显示头部（图标 + 工具名 + 时间 + 状态徽章 + chevron）
 *   - 展开态：头部 + 命令行 + 输出区
 *
 * ▸ 自动行为：
 *   - status === 'running' → 自动展开（用户接管后保持用户选择）
 *   - 进入 success/error（无任何 running）→ 1.2s 后自动折叠，让用户先看到结果再收起
 *
 * ▸ 优先级：用户手动 > forceExpanded（父级 ShellGroup 覆盖）> 自动
 */
export function ToolCallCard({ toolCall, forceExpanded, hideOutputToggle }: ToolCallCardProps) {
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const autoCollapseTimerRef = useRef<number | null>(null);

  const isShell = toolCall.tool === 'execute_shell';


  // execute_shell 的真实输出在 result.output 中（被 _sanitizeResult 截断到 1000 字符）
  const rawOutput = isShell && toolCall.result
    ? String(toolCall.result.output || toolCall.result.error || '')
    : '';
  const hasOutput = isShell && rawOutput.length > 0;
  const outputLines = rawOutput ? rawOutput.split('\n').filter((l) => l.length > 0).length : 0;

  // 自动展开/折叠逻辑（仅当用户未接管时生效）
  useEffect(() => {
    if (userExpanded !== null) return;
    if (!isShell) return;

    if (toolCall.status === 'running') {
      // 立即展开
      setUserExpanded(true);
    } else if (toolCall.status === 'success' || toolCall.status === 'error') {
      // 1.2s 后自动折叠，给用户一点时间看清结果
      if (autoCollapseTimerRef.current != null) {
        window.clearTimeout(autoCollapseTimerRef.current);
      }
      autoCollapseTimerRef.current = window.setTimeout(() => {
        setUserExpanded((cur) => (cur === null ? false : cur));
      }, 1200);
    }
    return () => {
      if (autoCollapseTimerRef.current != null) {
        window.clearTimeout(autoCollapseTimerRef.current);
        autoCollapseTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolCall.status, isShell]);

  // 最终是否展开：用户优先 → 否则跟随 forceExpanded → 否则默认折叠
  const expanded = userExpanded !== null ? userExpanded : (forceExpanded ?? false);

  // 时长显示
  const durationText = (() => {
    if (toolCall.status === 'running') return '执行中';
    if (toolCall.duration != null) {
      const ms = toolCall.duration;
      const s = Math.floor(ms / 1000);
      const ms2 = ms % 1000;
      if (s > 0) return `${s}.${String(ms2).padStart(3, '0').slice(0, 2)}s`;
      return `${ms}ms`;
    }
    return '';
  })();

  // 工具显示名：execute_shell → "Shell"
  const displayName = isShell ? 'Shell' : toolCall.tool;
  // 命令：从 args.command 取
  const commandLine = isShell
    ? String(toolCall.args.command ?? toolCall.args.shellCommand ?? '')
    : Object.entries(toolCall.args).map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`).join(' · ');

  // 状态图标
  const statusIcon = toolCall.status === 'running'
    ? <Loader2 size={11} strokeWidth={2} className="tool-call-card__spinner" />
    : toolCall.status === 'error'
      ? <X size={11} strokeWidth={2.5} />
      : <Check size={11} strokeWidth={2.5} />;

  // 头部点击：切换展开（仅当有命令/输出可显示时才提供切换；否则 header 不可点）
  const hasBody = !!commandLine || (hasOutput && !hideOutputToggle) || (hasOutput && hideOutputToggle);
  const handleHeaderClick = () => {
    if (!hasBody) return;
    setUserExpanded((cur) => !(cur !== null ? cur : (forceExpanded ?? false)));
  };

  return (
    <div className={`tool-call-card tool-call-card--${toolCall.status} ${expanded ? 'tool-call-card--expanded' : 'tool-call-card--collapsed'}`}>
      <button
        type="button"
        className={`tool-call-card__header ${hasBody ? 'tool-call-card__header--clickable' : ''}`}
        onClick={handleHeaderClick}
        aria-expanded={expanded}
        disabled={!hasBody}
      >
        <span className="tool-call-card__icon">
          {isShell ? <Terminal size={12} strokeWidth={1.8} /> : statusIcon}
        </span>
        <span className="tool-call-card__name">{displayName}</span>
        <span className="tool-call-card__duration">{durationText}</span>
        <span className="tool-call-card__actions">
          <span className={`tool-call-card__status tool-call-card__status--${toolCall.status}`} title={toolCall.status === 'running' ? '执行中' : toolCall.status === 'success' ? '已完成' : '失败'}>
            {statusIcon}
          </span>
          {hasBody && (
            <span className={`tool-call-card__chevron ${expanded ? 'tool-call-card__chevron--open' : ''}`}>
              <ChevronDown size={13} strokeWidth={2} />
            </span>
          )}
        </span>
      </button>

      {expanded && (
        <div className="tool-call-card__body">
          {commandLine && (
            <div className="tool-call-card__command">
              <code>{commandLine}</code>
            </div>
          )}
          {hasOutput && !hideOutputToggle && (
            <div className="tool-call-card__output-wrap">
              {expanded && (
                <pre className="tool-call-card__output">{rawOutput}</pre>
              )}
              <div className="tool-call-card__output-foot">
                <span className="tool-call-card__output-count">{outputLines} 行</span>
              </div>
            </div>
          )}
          {hasOutput && hideOutputToggle && (
            <div className="tool-call-card__output-wrap">
              <pre className="tool-call-card__output tool-call-card__output--inline">{rawOutput}</pre>
              <div className="tool-call-card__output-foot">
                <span className="tool-call-card__output-count">{outputLines} 行</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
