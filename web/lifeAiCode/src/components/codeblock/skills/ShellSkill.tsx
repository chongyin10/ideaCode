/* ─────────────────────────────────────────────────────────────────── */
/*  ShellSkill：shell/bash 代码块专属行为                              */
/* ─────────────────────────────────────────────────────────────────── */
/*  - "执行"按钮：点击后 spawn 子进程隐藏执行，输出实时流回占位区
 *  - "停止"按钮：终止长期运行命令（npm run dev 等），释放子进程资源
 *  - 终端输出占位区：ANSI 彩色输出、可折叠、状态指示
 *
 *  execId / outputCollapsed 等 Skill 专属 state 通过 ctx.getSkillState
 *  /setSkillState 持久化，不依赖 React hooks（renderActions/renderOutput
 *  是函数，无法用 useState）。                                    */

import type { CodeBlockSkill, CodeBlockSkillContext, ShellOutputsMap } from './types';
import { Play, Loader2, Check, X, Square } from 'lucide-react';

const SHELL_LANGUAGES = ['bash', 'shell', 'sh', 'zsh', 'fish'];

/* ── ANSI → HTML 转换（保留终端彩色输出） ──────────────────────── */
const ANSI_COLORS: Record<number, string> = {
  30: '#5c6370', 31: '#e06c75', 32: '#98c379', 33: '#e5c07b',
  34: '#61afef', 35: '#c678dd', 36: '#56b6c2', 37: '#abb2bf',
  90: '#5c6370', 91: '#e06c75', 92: '#98c379', 93: '#e5c07b',
  94: '#61afef', 95: '#c678dd', 96: '#56b6c2', 97: '#ffffff',
};

function ansiToHtml(text: string): string {
  let processed = text.replace(/[^\n]*\r([^\n])/g, '$1');
  let escaped = processed
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  let result = '';
  let lastIdx = 0;
  let openSpan = false;
  const sgrRegex = /\x1b\[([0-9;]*)m/g;
  let match: RegExpExecArray | null;

  while ((match = sgrRegex.exec(escaped)) !== null) {
    result += escaped.slice(lastIdx, match.index);
    const codes = match[1] ? match[1].split(';').map(Number) : [0];
    for (const code of codes) {
      if (code === 0) {
        if (openSpan) { result += '</span>'; openSpan = false; }
      } else if (ANSI_COLORS[code]) {
        if (openSpan) result += '</span>';
        result += `<span style="color:${ANSI_COLORS[code]}">`;
        openSpan = true;
      }
    }
    lastIdx = sgrRegex.lastIndex;
  }
  result += escaped.slice(lastIdx);
  if (openSpan) result += '</span>';

  result = result.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07?|\x1b[=>]/g, '');
  return result;
}

/** 提取代码块中要执行的命令（去掉 $ 前缀、合并多行） */
function extractShellCommand(code: string): string | null {
  const lines = code.split('\n');
  const commands: string[] = [];
  let current = '';

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      if (current) { commands.push(current.trim()); current = ''; }
      continue;
    }
    let cmd = line.replace(/^\$\s*/, '').replace(/^>\s*/, '');
    if (cmd.endsWith('\\') || cmd.endsWith('&&') || cmd.endsWith('||') || cmd.endsWith('|')) {
      current += (current ? ' ' : '') + cmd.replace(/[\\&&||]+$/, '');
      continue;
    }
    current += (current ? ' ' : '') + cmd;
    commands.push(current.trim());
    current = '';
  }
  if (current) commands.push(current.trim());

  if (commands.length === 0) return null;
  return commands.join('\n');
}

/** 从 ctx 读取 shell skill 的 state（execId、outputCollapsed） */
function getShellState(ctx: CodeBlockSkillContext): { execId?: string; outputCollapsed?: boolean } {
  return (ctx.getSkillState('shell') || {}) as { execId?: string; outputCollapsed?: boolean };
}

/** 计算执行状态文本与样式 class */
function computeStatus(execId: string | undefined, shellOutputs?: ShellOutputsMap) {
  const shellResult = execId && shellOutputs ? shellOutputs[execId] : null;
  const isWaiting = !!execId && !shellResult;
  const isRunning = shellResult?.status === 'running' || isWaiting;
  const htmlOutput = shellResult?.output ? ansiToHtml(shellResult.output) : '';
  const statusText = isWaiting ? '连接中…' :
    shellResult?.status === 'running' ? '执行中…' :
    shellResult?.status === 'success' ? '完成' :
    shellResult?.status === 'error' ? '失败' :
    shellResult?.status === 'killed' ? '已停止' : '';
  const statusClass = isWaiting ? 'running' : (shellResult?.status || 'running');
  return { shellResult, isWaiting, isRunning, htmlOutput, statusText, statusClass };
}

export const ShellSkill: CodeBlockSkill = {
  id: 'shell',
  languages: SHELL_LANGUAGES,

  renderActions(ctx: CodeBlockSkillContext) {
    const { code, onExecuteShell, onKillShell, shellOutputs, setSkillState } = ctx;
    const { execId } = getShellState(ctx);
    const { shellResult, isWaiting, isRunning, statusText, statusClass } = computeStatus(execId, shellOutputs);

    const shellCmd = extractShellCommand(code);
    if (!shellCmd || !onExecuteShell) return null;

    const handleRun = () => {
      const id = `bash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setSkillState('shell', { execId: id, outputCollapsed: false });
      onExecuteShell(id, shellCmd);
    };
    const handleKill = () => {
      if (execId && onKillShell) onKillShell(execId);
    };

    return (
      <>
        <button
          className={`codeblock-run-btn codeblock-run-btn--icon ${execId ? `codeblock-run-btn--${statusClass}` : ''}`}
          onClick={handleRun}
          title={isWaiting ? '连接中…' :
            shellResult?.status === 'running' ? '执行中…' :
            shellResult?.status === 'success' ? '已完成' :
            shellResult?.status === 'error' ? '失败' :
            shellResult?.status === 'killed' ? '已停止' : '执行'}
          disabled={isRunning}
        >
          {isWaiting ? <Loader2 size={12} className="codeblock-icon-spin" /> :
           shellResult?.status === 'running' ? <Loader2 size={12} className="codeblock-icon-spin" /> :
           shellResult?.status === 'success' ? <Check size={13} strokeWidth={2.5} /> :
           shellResult?.status === 'error' ? <X size={13} strokeWidth={2.5} /> :
           shellResult?.status === 'killed' ? <Square size={11} fill="currentColor" /> :
           <Play size={12} fill="currentColor" />}
        </button>
        {isRunning && onKillShell && (
          <button
            className="codeblock-kill-btn codeblock-kill-btn--icon"
            onClick={handleKill}
            title="停止执行（终止子进程）"
          >
            <Square size={11} fill="currentColor" />
          </button>
        )}
      </>
    );
  },

  renderOutput(ctx: CodeBlockSkillContext) {
    const { shellOutputs, setSkillState } = ctx;
    const { execId, outputCollapsed } = getShellState(ctx);
    if (!execId) return null;

    const { htmlOutput, statusText, statusClass } = computeStatus(execId, shellOutputs);

    return (
      <div
        id={execId}
        className={`codeblock-shell-output codeblock-shell-output--${statusClass} ${outputCollapsed ? 'codeblock-shell-output--collapsed' : ''}`}
      >
        <button
          className="codeblock-shell-output__header"
          onClick={() => setSkillState('shell', { execId, outputCollapsed: !outputCollapsed })}
          title={outputCollapsed ? '展开' : '收起'}
        >
          <span className="codeblock-shell-output__toggle">
            {outputCollapsed ? '▸' : '▾'}
          </span>
          <span className="codeblock-shell-output__prompt">$</span>
          <span className="codeblock-shell-output__label">终端输出</span>
          <span className="codeblock-shell-output__status">{statusText}</span>
        </button>
        {!outputCollapsed && htmlOutput && (
          <pre
            className="codeblock-shell-output__body"
            dangerouslySetInnerHTML={{ __html: htmlOutput }}
          />
        )}
      </div>
    );
  },
};
