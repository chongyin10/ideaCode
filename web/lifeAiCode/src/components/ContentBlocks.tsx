import { useState, useMemo, useRef, useEffect } from 'react';
import {
  Brain, Bot, Pencil, Terminal, FileText, Search, Info,
  ChevronDown, Copy, Check, Loader2, X,
  GitBranch,
  AlertTriangle, RefreshCw, Network,
} from 'lucide-react';
import type { ContentBlock as ContentBlockType, FileStatus, StepType, StepStatus } from '../types';
import { MarkdownContent } from './MarkdownContent';
import { StepSummary } from './agent/StepSummary';
import { parseProviderTags, type ProviderId, type ExtractedTag, type CanonicalTagName } from '../llmTags';

/* ─────────────────────────────────────────────────────────────────── */
/*  Parser（多 Provider 标签归一化）                                       */
/* ─────────────────────────────────────────────────────────────────── */

function buildReasoningFromThinking(content: string): ContentBlockType {
  return { type: 'reasoning', content: content.trim() };
}

function buildEnvironmentFromTag(content: string): ContentBlockType {
  // 解析 <environment_details> 内部的多行键值对
  // 形如 "Current time: 2026-06-25T17:33:59+08:00"
  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
  return {
    type: 'environment',
    raw: content,
    lines,
  } as unknown as ContentBlockType; // 见 types.ts 中的 type
}

function buildCanonicalBlock(tag: ExtractedTag): ContentBlockType | null {
  const { tagName, attrs = '', content } = tag;
  if (!tagName) return null;

  switch (tagName as CanonicalTagName) {
    case 'reasoning':
      return content.trim() ? { type: 'reasoning', content: content.trim() } : null;

    case 'edit': {
      const fileMatch = attrs!.match(/file=["']([^"']+)["']/i);
      const filePath = fileMatch ? fileMatch[1] : '未知文件';
      const lines = content.split('\n');
      let additions = 0;
      let deletions = 0;
      lines.forEach((line) => {
        const t = line.trim();
        if (t.startsWith('+')) additions++;
        else if (t.startsWith('-')) deletions++;
      });
      return { type: 'edit', filePath, additions, deletions };
    }

    case 'shell': {
      const cmdMatch = attrs!.match(/command=["']([^"']+)["']/i);
      const command = cmdMatch ? cmdMatch[1] : '';
      const output = content.trim();
      return { type: 'shell', command, output, status: 'running' as const };
    }

    case 'fileStatus': {
      const fileMatch = attrs!.match(/file=["']([^"']+)["']/i);
      const statusMatch = attrs!.match(/status=["']([^"']+)["']/i);
      const filePath = fileMatch ? fileMatch[1] : '未知文件';
      const status = (statusMatch ? statusMatch[1] : 'modified') as FileStatus;
      return { type: 'fileStatus', filePath, status };
    }

    case 'step': {
      const typeMatch = attrs!.match(/type=["']([^"']+)["']/i);
      const targetMatch = attrs!.match(/target=["']([^"']+)["']/i);
      const paramsMatch = attrs!.match(/params=["']([^"']+)["']/i);
      const statusMatch = attrs!.match(/status=["']([^"']+)["']/i);
      const stepType = (typeMatch ? typeMatch[1] : 'think') as StepType;
      const target = targetMatch ? targetMatch[1] : undefined;
      const params = paramsMatch ? paramsMatch[1] : undefined;
      const rawStatus = statusMatch ? statusMatch[1] : undefined;
      const status = (rawStatus || (stepType === 'read' ? 'done' : 'running')) as StepStatus;
      const label = content.trim() || undefined;
      return { type: 'step', stepType, target, params, label, status };
    }
  }
  return null;
}

/**
 * 解析内容块（多 Provider 标签归一化）
 * 流程：
 *   1. 用 parseProviderTags 提取所有标签（thinking/environment/canonical）
 *   2. 按位置在原始文本中切出 text 段
 *   3. 把标签转成对应的 ContentBlock
 *   4. 维持原文本顺序（text / 块 / text / 块 ...）
 */
function parseContentBlocks(content: string, provider: ProviderId = 'custom'): ContentBlockType[] {
  const blocks: ContentBlockType[] = [];
  if (!content) return blocks;

  const parseResult = parseProviderTags(content, provider);
  const tags = parseResult.tags;
  const incomplete = parseResult.incomplete;

  // 自动补齐未闭合的 canonical 标签（在 cleanedText 末尾补闭标签，避免 markdown 解析错乱）
  let cleanedText = parseResult.cleanedText;
  if (incomplete.length > 0) {
    for (const tagName of [...new Set(incomplete)]) {
      cleanedText += `\n\n</${tagName}>`;
    }
  }

  const pushText = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const last = blocks[blocks.length - 1];
    if (last && last.type === 'text') {
      last.content += '\n\n' + trimmed;
    } else {
      blocks.push({ type: 'text', content: trimmed });
    }
  };

  let cursor = 0;
  for (const tag of tags) {
    if (tag.start > cursor) {
      pushText(content.slice(cursor, tag.start));
    }

    if (tag.kind === 'thinking') {
      const block = buildReasoningFromThinking(tag.content);
      if (block) blocks.push(block);
    } else if (tag.kind === 'environment') {
      // environment 当前默认不显示（context 信息，用户无需看）；
      // 如果未来需要展示，取消下面这行注释即可
      // const block = buildEnvironmentFromTag(tag.content);
      // if (block) blocks.push(block);
    } else if (tag.kind === 'canonical') {
      const block = buildCanonicalBlock(tag);
      if (block) blocks.push(block);
    }

    cursor = tag.end;
  }

  // 最后一个 tag 后的剩余 text
  if (cursor < content.length) {
    pushText(content.slice(cursor));
  }

  // 如果没有提取到任何标签但有 cleanedText（理论上不会发生），也要 push
  if (blocks.length === 0 && cleanedText) {
    blocks.push({ type: 'text', content: cleanedText });
  }

  return blocks;
}

/* ─────────────────────────────────────────────────────────────────── */
/*  Title extraction                                                  */
/* ─────────────────────────────────────────────────────────────────── */

function extractTitle(blocks: ContentBlockType[]): string {
  // 单遍扫描 Θ(b)：首个非空 text 行命中即短路返回（最高优先级，与旧逻辑一致）；
  // 否则在同一遍内顺带累计各类块计数，取代旧实现对 step/shell/edit/fileStatus
  // 各做一次 filter（共 ~5 次全表扫描）的做法。
  let stepCount = 0;
  let firstStep: Extract<ContentBlockType, { type: 'step' }> | null = null;
  let shellCount = 0;
  let editCount = 0;
  let fileStatusCount = 0;

  for (const block of blocks) {
    switch (block.type) {
      case 'text': {
        const firstLine = block.content.split('\n')[0].trim();
        const clean = firstLine.replace(/^#{1,6}\s+/, '').trim();
        if (clean.length > 0) return clean.slice(0, 80) + (clean.length > 80 ? '…' : '');
        break;
      }
      case 'step':
        if (!firstStep) firstStep = block;
        stepCount++;
        break;
      case 'shell':
        shellCount++;
        break;
      case 'edit':
        editCount++;
        break;
      case 'fileStatus':
        fileStatusCount++;
        break;
    }
  }

  if (firstStep) {
    const label = firstStep.label || stepLabel(firstStep.stepType);
    return stepCount === 1 ? label : `${label} 等 ${stepCount} 步`;
  }
  if (shellCount > 0) return `执行 ${shellCount} 个命令`;
  if (editCount > 0) return `编辑 ${editCount} 个文件`;
  if (fileStatusCount > 0) return `更新 ${fileStatusCount} 个文件`;
  return 'AI 回复';
}

function stepLabel(stepType: StepType): string {
  switch (stepType) {
    case 'read': return '读取文件';
    case 'think': return '深入思考';
    case 'edit': return '编辑代码';
    case 'run': return '执行命令';
    case 'agent': return '调用 Agent';
  }
}

/* ─────────────────────────────────────────────────────────────────── */
/*  Public component                                                  */
/* ─────────────────────────────────────────────────────────────────── */

interface ContentBlocksProps {
  content: string;
  role?: 'user' | 'assistant' | 'system';
  shellOutputs?: Record<string, { output: string; status: 'running' | 'success' | 'error' | 'killed'; longRunning?: boolean }>;
  onExecuteShell?: (id: string, command: string) => void;
  onKillShell?: (id: string) => void;
  onOptionClick?: (text: string) => void;

  onContinue?: () => void;
  incomplete?: boolean;
  incompleteReasons?: string[];
  completed?: boolean;
  providerLabel?: string;
  modelLabel?: string;
  /** Provider ID（用于多厂商标签归一化） */
  provider?: ProviderId;
  /** 当前 Agent 执行状态，用于卡片标题左侧展示动态图标 */
  agentStatus?: { status: string; message?: string; stepType?: string } | null;
}

export function ContentBlocks({
  content,
  role = 'assistant',
  shellOutputs = {},
  onExecuteShell,
  onKillShell,
  onOptionClick,
  onContinue,
  incomplete,
  incompleteReasons,
  completed,
  providerLabel,
  modelLabel,
  provider = 'custom',
  agentStatus,
}: ContentBlocksProps) {
  const blocks = useMemo(() => parseContentBlocks(content, provider), [content, provider]);
  const title = useMemo(() => extractTitle(blocks), [blocks]);
  const hasRunning = blocks.some((b) =>
    (b.type === 'step' && b.status === 'running') ||
    (b.type === 'shell' && b.status === 'running')
  );

  const status: 'running' | 'done' | 'error' =
    completed ? 'done' : hasRunning ? 'running' : 'done';

  // 用户消息：直接渲染简洁气泡
  if (role === 'user') {
    return <UserBubble content={content} />;
  }

  // 系统消息
  if (role === 'system') {
    return (
      <div className="ai-card ai-card--done" style={{ borderStyle: 'dashed' }}>
        <div className="ai-card__body">
          <div className="ai-card__section ai-card__section--text">
            <MarkdownContent content={content} enableOptions={false} />
          </div>
        </div>
      </div>
    );
  }

  // AI 回复：渲染完整消息卡片
  const isStreaming = !completed;
  // §任务列表归纳：把 <step> 标签从普通 block 流中抽出，统一渲染为顶部汇总面板
  const stepBlocks = blocks.filter((b): b is Extract<ContentBlockType, { type: 'step' }> => b.type === 'step');
  const otherBlocks = blocks.filter((b) => b.type !== 'step');

  return (
    <MessageCard
      title={title}
      status={status}
      providerLabel={providerLabel}
      modelLabel={modelLabel}
      onContinue={onContinue}
      incomplete={incomplete}
      incompleteReasons={incompleteReasons}
      showActions={false}
      agentStatus={agentStatus}
    >
      {stepBlocks.length > 0 && (
        <StepSummary steps={stepBlocks} completed={completed} />
      )}
      {otherBlocks.map((block, idx) => {
        const isLastBlock = idx === otherBlocks.length - 1;
        return (
          <BlockRenderer
            key={idx}
            block={block}
            shellOutputs={shellOutputs}
            onExecuteShell={onExecuteShell}
            onKillShell={onKillShell}
            onOptionClick={onOptionClick}
            completed={completed}
            showStreamingCursor={isStreaming && isLastBlock && block.type === 'text'}
          />
        );
      })}
    </MessageCard>
  );
}

/* ─────────────────────────────────────────────────────────────────── */
/*  User Bubble (with copy action)                                    */
/* ─────────────────────────────────────────────────────────────────── */

function UserBubble({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="user-bubble-wrap">
      <div className="user-bubble">
        <MarkdownContent content={content} enableOptions={false} />
      </div>
      <button
        className={`user-bubble__copy ${copied ? 'user-bubble__copy--done' : ''}`}
        title={copied ? '已复制' : '复制'}
        onClick={async (e) => {
          e.stopPropagation();
          try {
            await navigator.clipboard.writeText(content);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch { /* ignore */ }
        }}
      >
        {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={1.8} />}
      </button>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────── */
/*  Message Card (collapsible, the centerpiece)                      */
/* ─────────────────────────────────────────────────────────────────── */

const CARD_STATUS_VARIANTS = {
  thinking:  { Icon: Brain,    text: '思考中' },
  reading:   { Icon: FileText, text: '读取文件' },
  editing:   { Icon: Pencil,   text: '编辑文件' },
  running:   { Icon: Terminal, text: '执行 shell' },
  planning:  { Icon: Network,  text: '计划任务' },
  recovering:{ Icon: RefreshCw, text: '恢复中' },
  done:      { Icon: Check,    text: '已完成' },
  default:   { Icon: Loader2,  text: '回复中' },
} as const;

function resolveCardStatusVariant(stepType?: string, message?: string) {
  const msg = message || '';
  if (stepType === 'done') return CARD_STATUS_VARIANTS.done;
  if (stepType === 'think' || /思考/.test(msg)) return CARD_STATUS_VARIANTS.thinking;
  if (stepType === 'read' || /读取|读文件/.test(msg)) return CARD_STATUS_VARIANTS.reading;
  if (stepType === 'edit' || /编辑|修改/.test(msg)) return CARD_STATUS_VARIANTS.editing;
  if (stepType === 'run' || /执行|命令|shell/.test(msg)) return CARD_STATUS_VARIANTS.running;
  if (stepType === 'agent' || /分配|工具|计划/.test(msg)) return CARD_STATUS_VARIANTS.planning;
  if (/恢复|中断/.test(msg)) return CARD_STATUS_VARIANTS.recovering;
  return CARD_STATUS_VARIANTS.default;
}

interface MessageCardProps {
  title: string;
  status: 'running' | 'done' | 'error';
  children: React.ReactNode;
  providerLabel?: string;
  modelLabel?: string;
  showActions?: boolean;
  onContinue?: () => void;
  incomplete?: boolean;
  incompleteReasons?: string[];
  defaultCollapsed?: boolean;
  agentStatus?: { status: string; message?: string; stepType?: string } | null;
}

function MessageCard({
  title, status, children,
  providerLabel, modelLabel,
  showActions = false,
  onContinue,
  incomplete, incompleteReasons,
  defaultCollapsed = false,
  agentStatus,
}: MessageCardProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  const statusClass = `ai-card--${status}`;
  const badgeClass = `ai-card__badge--${status}`;
  const badgeIcon = status === 'running'
    ? <Loader2 size={10} strokeWidth={2.5} className="ai-card__badge-spinner" />
    : status === 'error'
      ? <X size={10} strokeWidth={2.5} />
      : <Check size={10} strokeWidth={2.5} />;
  const badgeTitle = status === 'running' ? '进行中' : status === 'error' ? '出错' : '已完成';

  return (
    <div className={`ai-card ${statusClass} ${incomplete ? 'ai-card--incomplete' : ''}`}>
      {/* Header */}
      <div
        className="ai-card__header"
        onClick={() => setCollapsed(!collapsed)}
        title={collapsed ? '展开' : '折叠'}
      >
        <span className="ai-card__status-dot" />
        {agentStatus?.status === 'running' ? (() => {
          const { Icon, text } = resolveCardStatusVariant(agentStatus.stepType, agentStatus.message);
          return (
            <span className="ai-card__status-title" title={text}>
              <Icon size={12} strokeWidth={2} className={text === '回复中' ? 'ai-card__status-title-spinner' : ''} />
              <span>{text}</span>
            </span>
          );
        })() : <span className="ai-card__title">{title}</span>}
        {(providerLabel || modelLabel) && (
          <span className="ai-card__meta" style={{ fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0 }}>
            {providerLabel}{modelLabel ? ` · ${modelLabel}` : ''}
          </span>
        )}
        {incomplete && (
          <span className="ai-card__incomplete-badge" title={incompleteReasons?.join('、') || '可能被截断'}>
            <AlertTriangle size={10} strokeWidth={2.2} /> 不完整
          </span>
        )}
        <span className={`ai-card__badge ${badgeClass}`} title={badgeTitle}>{badgeIcon}</span>
        <span className={`ai-card__chevron ${collapsed ? 'ai-card__chevron--collapsed' : ''}`}>
          <ChevronDown size={14} strokeWidth={2} />
        </span>
      </div>

      {/* Top progress bar — only visible while running */}
      <div className="ai-card__progress" />

      {/* Body */}
      {!collapsed && (
        <>
          {/* §需求2：body 与 actions 并排的 row 容器——
              之前是上下排列（body 在上、actions 独占下一行）。
              现在让两者并排：body 占主宽度，actions 紧贴右侧（不另起一行），
              复制按钮与正文内容在同一行布局中呈现。 */}
          <div className="ai-card__body-row">
            <div className="ai-card__body">
              {children}

              {/* Incomplete banner — only when done but truncated */}
              {status !== 'running' && incomplete && (
                <div className="ai-card__incomplete-banner" title={incompleteReasons?.join('、')}>
                  <AlertTriangle size={13} strokeWidth={2.2} />
                  <span>
                    回答可能不完整{Array.isArray(incompleteReasons) && incompleteReasons.length > 0
                      ? `（${incompleteReasons.join('、')}）`
                      : ''}
                  </span>
                  {onContinue && (
                    <button
                      className="ai-card__continue-btn"
                      onClick={(e) => { e.stopPropagation(); onContinue(); }}
                      title="请求 LLM 继续完成回答"
                    >
                      <RefreshCw size={11} strokeWidth={2.2} />
                      继续生成
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Action bar — 复制按钮已上移到 assistant-header，卡片内不再重复显示 */}
          </div>
        </>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────── */
/*  Block Renderer                                                    */
/* ─────────────────────────────────────────────────────────────────── */

interface BlockRendererProps {
  block: ContentBlockType;
  shellOutputs: Record<string, { output: string; status: 'running' | 'success' | 'error' | 'killed'; longRunning?: boolean }>;
  onExecuteShell?: (id: string, command: string) => void;
  onKillShell?: (id: string) => void;
  onOptionClick?: (text: string) => void;
  completed?: boolean;
  showStreamingCursor?: boolean;
}

function BlockRenderer({ block, shellOutputs, onExecuteShell, onKillShell, onOptionClick, completed, showStreamingCursor }: BlockRendererProps) {
  switch (block.type) {
    case 'text':
      return (
        <div className="ai-card__section ai-card__section--text">
          <MarkdownContent
            content={block.content}
            onOptionClick={onOptionClick}
            onExecuteShell={onExecuteShell}
            onKillShell={onKillShell}
            shellOutputs={shellOutputs}
          />
          {showStreamingCursor && <span className="streaming-cursor" />}
        </div>
      );
    case 'reasoning':
      return <ReasoningBlock content={block.content} />;
    case 'edit':
      return <EditSummary filePath={block.filePath} additions={block.additions} deletions={block.deletions} />;
    case 'shell':
      return <ToolCall command={block.command} output={block.output} status={block.status} shellOutputs={shellOutputs} onExecuteShell={onExecuteShell} onKillShell={onKillShell} />;
    case 'fileStatus':
      return <FileStatusRow filePath={block.filePath} status={block.status} />;
    case 'step':
      return <StepRow stepType={block.stepType} target={block.target} params={block.params} label={block.label} status={block.status} completed={completed} />;
    default:
      return null;
  }
}

/* ─────────────────────────────────────────────────────────────────── */
/*  Reasoning Block                                                   */
/* ─────────────────────────────────────────────────────────────────── */

function ReasoningBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="reasoning">
      <button
        className="reasoning-header"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="reasoning-icon">
          <Brain size={12} strokeWidth={1.8} />
        </span>
        <span className="reasoning-label">推理</span>
        <span className={`reasoning-chevron ${open ? 'reasoning-chevron--open' : ''}`}>
          <ChevronDown size={14} strokeWidth={2} />
        </span>
      </button>
      {open && (
        <div className="reasoning-body">
          <MarkdownContent content={content} enableOptions={false} />
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────── */
/*  Edit Summary                                                      */
/* ─────────────────────────────────────────────────────────────────── */

function EditSummary({ filePath, additions, deletions }: { filePath: string; additions: number; deletions: number }) {
  return (
    <div className="edit-summary">
      <span className="edit-summary__icon">
        <Pencil size={14} strokeWidth={1.8} />
      </span>
      <span className="edit-summary__label">编辑</span>
      <span className="edit-summary__file" title={filePath}>{filePath}</span>
      {(additions > 0 || deletions > 0) && (
        <span className="edit-summary__stats">
          {additions > 0 && <span className="edit-summary__add">+{additions}</span>}
          {deletions > 0 && <span className="edit-summary__del">−{deletions}</span>}
        </span>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────── */
/*  Tool Call (Shell / Command Execution)                             */
/* ─────────────────────────────────────────────────────────────────── */

function ToolCall({
  command, output: initialOutput, status: initialStatus,
  shellOutputs, onExecuteShell, onKillShell,
}: {
  command: string;
  output?: string;
  status?: 'running' | 'success' | 'error' | 'killed';
  shellOutputs: Record<string, { output: string; status: 'running' | 'success' | 'error' | 'killed'; longRunning?: boolean }>;
  onExecuteShell?: (id: string, command: string) => void;
  onKillShell?: (id: string) => void;
}) {
  const execId = useMemo(() => `shell-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`, []);
  const executedRef = useRef(false);
  const [copied, setCopied] = useState(false);
  const data = shellOutputs[execId];
  const output = data ? data.output : initialOutput;
  const status = data ? data.status : (initialStatus || 'running');

  useEffect(() => {
    if (!executedRef.current && status === 'running' && onExecuteShell) {
      executedRef.current = true;
      onExecuteShell(execId, command);
    }
  }, [execId, command, status, onExecuteShell]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  const statusBadge =
    status === 'running' ? (
      <span className="tool-call-status tool-call-status--running">
        <Loader2 size={11} strokeWidth={2.4} className="tool-call-status__spinner" />
        运行中
      </span>
    ) : status === 'error' ? (
      <span className="tool-call-status tool-call-status--error">✕ 失败</span>
    ) : (
      <span className="tool-call-status tool-call-status--success">
        <Check size={11} strokeWidth={2.5} />
        完成
      </span>
    );

  return (
    <div className="tool-call">
      <div className={`tool-call-header tool-call--${status}`}>
        <div className="tool-call-dots">
          <span className="tool-call-dots__dot tool-call-dots__dot--red" />
          <span className="tool-call-dots__dot tool-call-dots__dot--yellow" />
          <span className="tool-call-dots__dot tool-call-dots__dot--green" />
        </div>
        <span className="tool-call-icon">
          <Terminal size={14} strokeWidth={1.8} />
        </span>
        <span className="tool-call-title" title={`在聊天内执行：${command}`}>
          <span className="tool-call-title__prompt">$</span>
          <span className="tool-call-title__cmd">{command}</span>
        </span>
        <div className="tool-call-actions">
          {statusBadge}
          <button className="tool-call-copy" onClick={handleCopy} title="复制命令">
            {copied ? <Check size={13} strokeWidth={2.5} /> : <Copy size={13} strokeWidth={1.8} />}
          </button>
        </div>
      </div>
      {output && (
        <div className="tool-call-body">
          <pre className="tool-call-output">{output}</pre>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────── */
/*  File Status Row                                                   */
/* ─────────────────────────────────────────────────────────────────── */

function FileStatusRow({ filePath, status }: { filePath: string; status: FileStatus }) {
  const meta = {
    modified: { label: '已修改', icon: <GitBranch size={14} strokeWidth={1.8} /> },
    created: { label: '已创建', icon: <FileText size={14} strokeWidth={1.8} /> },
    deleted: { label: '已删除', icon: <FileText size={14} strokeWidth={1.8} /> },
  }[status];

  return (
    <div className={`file-status file-status--${status}`}>
      <span className="file-status__icon">{meta.icon}</span>
      <span className="file-status__main" title={filePath}>{filePath}</span>
      <span className="file-status__label">{meta.label}</span>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────── */
/*  Step Row (Timeline)                                               */
/* ─────────────────────────────────────────────────────────────────── */

function StepRow({ stepType, target, params, label, status, completed }: {
  stepType: StepType;
  target?: string;
  params?: string;
  label?: string;
  status: StepStatus;
  completed?: boolean;
}) {
  const targetText = target ? (params ? `${target} ${params}` : target) : '';
  const displayLabel = label || stepLabel(stepType);
  const effectiveStatus: StepStatus =
    completed && (status === 'running' || !status) ? 'done' : status;

  const isSearch = stepType === 'agent' && /\b(Glob|Search|Find)\b/i.test(targetText || label || '');
  const icon = isSearch ? <Search size={13} strokeWidth={1.8} /> :
    stepType === 'read' ? <FileText size={13} strokeWidth={1.8} /> :
    stepType === 'think' ? <Brain size={13} strokeWidth={1.8} /> :
    stepType === 'edit' ? <Pencil size={13} strokeWidth={1.8} /> :
    stepType === 'run' ? <Terminal size={13} strokeWidth={1.8} /> :
    <Bot size={13} strokeWidth={1.8} />;

  const isRunning = effectiveStatus === 'running';

  return (
    <div className={`step-item step-item--${stepType} ${isRunning ? 'step-item--running' : ''}`}>
      <span className={`step-item__dot step-item__dot--${effectiveStatus}`} />
      <span className="step-item__icon">
        {isRunning ? (
          <Loader2 size={13} strokeWidth={2} className="step-item__spinner" />
        ) : icon}
      </span>
      <span className="step-item__main">
        <span className="step-item__title">{displayLabel}</span>
        {targetText && <span className="step-item__target" title={targetText}>{targetText}</span>}
      </span>
      {isRunning && stepType === 'read' && (
        <span className="step-item__status-text">读取中…</span>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────── */
/*  StepList (groups steps into timeline)                             */
/* ─────────────────────────────────────────────────────────────────── */

export function StepList({ children }: { children: React.ReactNode }) {
  return <div className="step-list">{children}</div>;
}

/* ─────────────────────────────────────────────────────────────────── */
/*  Optional: grouped step timeline component                         */
/* ─────────────────────────────────────────────────────────────────── */

interface StepTimelineProps {
  steps: Array<{
    stepType: StepType;
    target?: string;
    params?: string;
    label?: string;
    status: StepStatus;
  }>;
  completed?: boolean;
}

export function StepTimeline({ steps, completed }: StepTimelineProps) {
  if (steps.length === 0) return null;
  return (
    <div className="step-list">
      {steps.map((s, i) => (
        <StepRow
          key={i}
          stepType={s.stepType}
          target={s.target}
          params={s.params}
          label={s.label}
          status={s.status}
          completed={completed}
        />
      ))}
    </div>
  );
}
