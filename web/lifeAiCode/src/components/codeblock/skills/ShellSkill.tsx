/* ─────────────────────────────────────────────────────────────────── */
/*  ShellSkill：shell/bash 代码块专属行为                              */
/*  ANSI 转义序列处理属于终端场景的合法用途，豁免 no-control-regex     */
/* eslint-disable no-control-regex */
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
import { isShellCommand } from '../shellDetect';

/**
 * ShellSkill 静态语言前缀：
 * 1. 第一层粗筛：CodeBlock 只在 markdown 声明的语言属于这个集合时才考虑激活
 * 2. 第二层精筛：canActivate 用 isShellCommand 智能判断代码真正是否为 shell 命令
 *    避免 import/export 等 JS/TS 代码被 detectCodeLanguage 误识别为 bash 后
 *    显示"执行"按钮（用户点击会把 JS 代码当 shell 执行）。
 */
const SHELL_LANGUAGES = ['bash', 'shell', 'sh', 'zsh', 'fish'];

/* ── ANSI → HTML 转换（保留终端彩色输出） ──────────────────────── */
const ANSI_COLORS: Record<number, string> = {
  30: '#5c6370', 31: '#e06c75', 32: '#98c379', 33: '#e5c07b',
  34: '#61afef', 35: '#c678dd', 36: '#56b6c2', 37: '#abb2bf',
  90: '#5c6370', 91: '#e06c75', 92: '#98c379', 93: '#e5c07b',
  94: '#61afef', 95: '#c678dd', 96: '#56b6c2', 97: '#ffffff',
};

function ansiToHtml(text: string): string {
  const processed = text.replace(/[^\n]*\r([^\n])/g, '$1');
  const escaped = processed
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

/**
 * 提取代码块中要执行的命令（去掉 $ 前缀、合并多行）
 * 兼容 ShellSkill 内部调用，与 shellDetect.describeShellCommand 用途不同
 * （本函数返回完整多行命令串，describeShellCommand 仅返回简短描述）
 */
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
    const cmd = line.replace(/^\$\s*/, '').replace(/^>\s*/, '');
    // 反斜杠行继续符：移除 \ 并与下一行拼接（shell 中 \ + newline = 空）
    if (cmd.endsWith('\\')) {
      current += (current ? ' ' : '') + cmd.slice(0, -1).trim();
      continue;
    }
    // 命令串联符（&& || |）：必须保留操作符，不能删除！
    // 删除会导致 `cd /project &&` + `npm install` → `cd /project npm install`（错误）
    if (cmd.endsWith('&&') || cmd.endsWith('||') || cmd.endsWith('|')) {
      current += (current ? ' ' : '') + cmd;
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

/** 计算执行状态文本与样式 class
 * longRunning: 后端识别为长驻进程（dev server / watch / tail -f 等）时为 true，
 * 已脱离 Agent 同步等待，仅节流推送日志到 UI，不会塞进 LLM 上下文。
 * deferred: §后台任务管理器，命令执行超阈值后转入后台队列，不阻塞 Agent 主流程。
 */
function computeStatus(execId: string | undefined, shellOutputs?: ShellOutputsMap) {
  const shellResult = execId && shellOutputs ? shellOutputs[execId] : null;
  const isWaiting = !!execId && !shellResult;
  const isRunning = shellResult?.status === 'running' || isWaiting;
  const isLongRunning = shellResult?.longRunning === true;
  const isDeferred = shellResult?.deferred === true && shellResult?.status === 'deferred';
  const htmlOutput = shellResult?.output ? ansiToHtml(shellResult.output) : '';
  const statusText = isWaiting ? '连接中…' :
    shellResult?.status === 'running' ? (isLongRunning ? '长驻进程中（不阻塞）' : '执行中…') :
    shellResult?.status === 'deferred' ? '已转入后台…' :
    shellResult?.status === 'success' ? (shellResult?.deferred ? '后台完成' : '完成') :
    shellResult?.status === 'error' ? (shellResult?.deferred ? '后台失败' : '失败') :
    shellResult?.status === 'killed' ? '已停止' : '';
  const statusClass = isWaiting ? 'running' : (shellResult?.status || 'running');
  return { shellResult, isWaiting, isRunning, isLongRunning, isDeferred, htmlOutput, statusText, statusClass };
}

export const ShellSkill: CodeBlockSkill = {
  id: 'shell',
  // 不再静态匹配 languages，而是用 canActivate 做两层判断：
  // 1. 语言必须是 shell 系列（bash/sh/zsh/...）
  // 2. 代码本体必须通过智能 shell 命令检测（isShellCommand）
  // 这样可以避免 JS/TS/Python 等代码被误识别为 bash 后弹出"执行"按钮。
  canActivate(ctx: CodeBlockSkillContext): boolean {
    if (!SHELL_LANGUAGES.includes(ctx.language)) return false;
    return isShellCommand(ctx.code);
  },

  renderActions(ctx: CodeBlockSkillContext) {
    const { code, onExecuteShell, onKillShell, shellOutputs, setSkillState } = ctx;
    const { execId } = getShellState(ctx);
    const { shellResult, isWaiting, isRunning, isLongRunning, isDeferred, statusClass } = computeStatus(execId, shellOutputs);

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

    const runTitle = isWaiting ? '连接中…' :
      shellResult?.status === 'running' ? (isLongRunning ? '长驻进程中（点击 ◼ 可停止）' : '执行中…') :
      shellResult?.status === 'deferred' ? '已转入后台执行（不阻塞主流程）' :
      shellResult?.status === 'success' ? (isDeferred ? '后台任务已完成' : '已完成') :
      shellResult?.status === 'error' ? (isDeferred ? '后台任务失败' : '失败') :
      shellResult?.status === 'killed' ? '已停止' : '执行';

    // deferred 状态下进程仍在后台运行，允许停止
    const canKill = (isRunning || shellResult?.status === 'deferred') && onKillShell;

    return (
      <>
        <button
          className={`codeblock-run-btn codeblock-run-btn--icon ${execId ? `codeblock-run-btn--${statusClass}` : ''} ${isLongRunning ? 'codeblock-run-btn--long-running' : ''} ${isDeferred ? 'codeblock-run-btn--deferred' : ''}`}
          onClick={handleRun}
          title={runTitle}
          disabled={isRunning}
          data-long-running={isLongRunning ? 'true' : undefined}
          data-deferred={isDeferred ? 'true' : undefined}
        >
          {isWaiting ? <Loader2 size={12} className="codeblock-icon-spin" /> :
           shellResult?.status === 'running' ? <Loader2 size={12} className="codeblock-icon-spin" /> :
           shellResult?.status === 'deferred' ? <Loader2 size={12} className="codeblock-icon-spin" /> :
           shellResult?.status === 'success' ? <Check size={13} strokeWidth={2.5} /> :
           shellResult?.status === 'error' ? <X size={13} strokeWidth={2.5} /> :
           shellResult?.status === 'killed' ? <Square size={11} strokeWidth={2} /> :
           <Play size={12} strokeWidth={2} />}
        </button>
        {canKill && (
          <button
            className="codeblock-kill-btn codeblock-kill-btn--icon"
            onClick={handleKill}
            title="停止执行（终止子进程）"
          >
            <Square size={11} strokeWidth={2} />
          </button>
        )}
      </>
    );
  },

  renderOutput(ctx: CodeBlockSkillContext) {
    const { shellOutputs, setSkillState } = ctx;
    const { execId, outputCollapsed } = getShellState(ctx);
    if (!execId) return null;

    const { htmlOutput, statusText, statusClass, isLongRunning, isDeferred } = computeStatus(execId, shellOutputs);

    return (
      <div
        id={execId}
        className={`codeblock-shell-output codeblock-shell-output--${statusClass} ${outputCollapsed ? 'codeblock-shell-output--collapsed' : ''} ${isLongRunning ? 'codeblock-shell-output--long-running' : ''} ${isDeferred ? 'codeblock-shell-output--deferred' : ''}`}
        data-long-running={isLongRunning ? 'true' : undefined}
        data-deferred={isDeferred ? 'true' : undefined}
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
          {isLongRunning && (
            <span className="codeblock-shell-output__badge codeblock-shell-output__badge--long-running" title="长驻进程：spawn 后已脱离 Agent 同步等待，日志节流（5s）推送，不会发送到 LLM">
              长驻进程
            </span>
          )}
          {isDeferred && (
            <span className="codeblock-shell-output__badge codeblock-shell-output__badge--deferred" title="后台任务：命令执行超过 30s 阈值，已转入后台队列继续执行，不阻塞 Agent 主流程。完成后自动通知。">
              后台队列
            </span>
          )}
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
