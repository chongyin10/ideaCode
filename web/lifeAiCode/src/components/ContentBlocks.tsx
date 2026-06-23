import { useState, useMemo } from 'react';
import { Eye, Brain, Bot, Pencil, Terminal } from 'lucide-react';
import type { ContentBlock, FileStatus, StepType, StepStatus } from '../types';

function parseContentBlocks(content: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  let remaining = content;

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

  const tagPattern = /<(reasoning|edit|shell|fileStatus|step)\b[^>]*>[\s\S]*?<\/\1>|<(fileStatus|step)\b[^>]*\/>/gi;
  let match: RegExpExecArray | null;
  let lastIndex = 0;

  // eslint-disable-next-line no-cond-assign
  while ((match = tagPattern.exec(remaining)) !== null) {
    const textBefore = remaining.slice(lastIndex, match.index);
    pushText(textBefore);
    lastIndex = tagPattern.lastIndex;

    const tagHtml = match[0];
    const tagName = match[1].toLowerCase();

    if (tagName === 'reasoning') {
      const inner = tagHtml.replace(/<reasoning\b[^>]*>([\s\S]*?)<\/reasoning>/i, '$1').trim();
      if (inner) blocks.push({ type: 'reasoning', content: inner });
    } else if (tagName === 'edit') {
      const fileMatch = tagHtml.match(/file=["']([^"']+)["']/i);
      const filePath = fileMatch ? fileMatch[1] : '未知文件';
      const inner = tagHtml.replace(/<edit\b[^>]*>([\s\S]*?)<\/edit>/i, '$1');
      const lines = inner.split('\n');
      let additions = 0;
      let deletions = 0;
      lines.forEach((line) => {
        const t = line.trim();
        if (t.startsWith('+')) additions++;
        else if (t.startsWith('-')) deletions++;
      });
      blocks.push({ type: 'edit', filePath, additions, deletions });
    } else if (tagName === 'shell') {
      const cmdMatch = tagHtml.match(/command=["']([^"']+)["']/i);
      const command = cmdMatch ? cmdMatch[1] : '';
      const output = tagHtml.replace(/<shell\b[^>]*>([\s\S]*?)<\/shell>/i, '$1').trim();
      blocks.push({ type: 'shell', command, output, status: 'success' });
    } else if (tagName === 'filestatus') {
      const fileMatch = tagHtml.match(/file=["']([^"']+)["']/i);
      const statusMatch = tagHtml.match(/status=["']([^"']+)["']/i);
      const filePath = fileMatch ? fileMatch[1] : '未知文件';
      const status = (statusMatch ? statusMatch[1] : 'modified') as FileStatus;
      blocks.push({ type: 'fileStatus', filePath, status });
    } else if (tagName === 'step') {
      const typeMatch = tagHtml.match(/type=["']([^"']+)["']/i);
      const targetMatch = tagHtml.match(/target=["']([^"']+)["']/i);
      const paramsMatch = tagHtml.match(/params=["']([^"']+)["']/i);
      const statusMatch = tagHtml.match(/status=["']([^"']+)["']/i);
      const stepType = (typeMatch ? typeMatch[1] : 'think') as StepType;
      const target = targetMatch ? targetMatch[1] : undefined;
      const params = paramsMatch ? paramsMatch[1] : undefined;
      const status = (statusMatch ? statusMatch[1] : 'running') as StepStatus;
      const label = tagHtml.replace(/<step\b[^>]*>([\s\S]*?)<\/step>/i, '$1').trim() || undefined;
      blocks.push({ type: 'step', stepType, target, params, label, status });
    }
  }

  pushText(remaining.slice(lastIndex));
  return blocks;
}

interface ContentBlocksProps {
  content: string;
}

export function ContentBlocks({ content }: ContentBlocksProps) {
  const blocks = useMemo(() => parseContentBlocks(content), [content]);

  return (
    <div className="content-blocks">
      {blocks.map((block, idx) => (
        <BlockRenderer key={idx} block={block} />
      ))}
    </div>
  );
}

function BlockRenderer({ block }: { block: ContentBlock }) {
  switch (block.type) {
    case 'text':
      return <div className="content-block content-block--text">{block.content}</div>;
    case 'reasoning':
      return <ReasoningBlock content={block.content} />;
    case 'edit':
      return <EditBlock filePath={block.filePath} additions={block.additions} deletions={block.deletions} />;
    case 'shell':
      return <ShellBlock command={block.command} output={block.output} status={block.status} />;
    case 'fileStatus':
      return <FileStatusBlock filePath={block.filePath} status={block.status} />;
    case 'step':
      return <StepBlock stepType={block.stepType} target={block.target} params={block.params} label={block.label} status={block.status} />;
    default:
      return null;
  }
}

function ReasoningBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="content-block content-block--reasoning">
      <button className="reasoning-header" onClick={() => setExpanded(!expanded)}>
        <span className="reasoning-icon">🧠</span>
        <span>推理</span>
        <span className="reasoning-arrow">{expanded ? '▼' : '▶'}</span>
      </button>
      {expanded && <div className="reasoning-body">{content}</div>}
    </div>
  );
}

function EditBlock({ filePath, additions, deletions }: { filePath: string; additions: number; deletions: number }) {
  return (
    <div className="content-block content-block--edit">
      <div className="edit-header">
        <span className="edit-icon">✏️</span>
        <span className="edit-label">编辑</span>
        <span className="edit-file">{filePath}</span>
        <span className="edit-stats">
          {additions > 0 && <span className="edit-add">+{additions}</span>}
          {deletions > 0 && <span className="edit-del">-{deletions}</span>}
        </span>
      </div>
    </div>
  );
}

function ShellBlock({ command, output, status }: { command: string; output?: string; status?: 'success' | 'error' }) {
  return (
    <div className={`content-block content-block--shell content-block--shell-${status || 'success'}`}>
      <div className="shell-header">
        <span className="shell-icon">{'>'}</span>
        <span className="shell-command">{command}</span>
      </div>
      {output && <pre className="shell-output">{output}</pre>}
    </div>
  );
}

function FileStatusBlock({ filePath, status }: { filePath: string; status: FileStatus }) {
  const labels: Record<FileStatus, string> = {
    modified: '已修改',
    created: '已创建',
    deleted: '已删除',
  };
  return (
    <div className="content-block content-block--file-status">
      <span className={`file-status-dot file-status-dot--${status}`} />
      <span className="file-status-file">{filePath}</span>
      <span className="file-status-label">{labels[status]}</span>
    </div>
  );
}

function StepBlock({ stepType, target, params, label, status }: {
  stepType: StepType;
  target?: string;
  params?: string;
  label?: string;
  status: StepStatus;
}) {
  const config: Record<StepType, { icon: JSX.Element; title: string }> = {
    read: { icon: <Eye size={13} strokeWidth={1.6} />, title: '读取' },
    think: { icon: <Brain size={13} strokeWidth={1.6} />, title: '思考' },
    agent: { icon: <Bot size={13} strokeWidth={1.6} />, title: '调用 Agent' },
    edit: { icon: <Pencil size={13} strokeWidth={1.6} />, title: '正在编辑' },
    run: { icon: <Terminal size={13} strokeWidth={1.6} />, title: '运行' },
  };
  const c = config[stepType];
  const targetText = target ? (params ? `${target} ${params}` : target) : '';
  const displayLabel = label || c.title;
  return (
    <div className={`content-block content-block--step content-block--step-${status}`}>
      <span className="step-icon">{status === 'running' ? <span className="step-spinner" /> : c.icon}</span>
      <span className="step-title">{displayLabel}</span>
      {targetText && <span className="step-target">{targetText}</span>}
      {status === 'done' && <span className="step-check">✓</span>}
      {status === 'error' && <span className="step-error">✗</span>}
    </div>
  );
}
