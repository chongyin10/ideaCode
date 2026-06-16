/**
 * 终端管理器
 * 
 * 负责：
 * 1. 终端进程生命周期管理 (创建/销毁/输入/调整大小)
 * 2. Shell Profile 自动检测
 * 3. 流控 ACK 管理
 * 4. 持久化会话（终端布局保存/恢复）
 * 5. 广播输入同步
 * 6. AI 增强功能
 */

import type {
  TerminalCreateConfig,
  TerminalCreateResult,
  TerminalOutputEvent,
  TerminalProfilesResult,
} from '../types/electron';
import { AdaptiveEWMA } from './terminalMath';
import { AhoCorasick } from './terminalIndexes';

const API = () => window.electronAPI?.terminal;

/* ─── EWMA 自适应流控 (数学优化 #2) ─── */

const ACK_BATCH = 5000;
const pendingChars: Map<number, number> = new Map();
/** 每个终端实例的 ACK 批量大小（EWMA 自适应） */
const adaptiveBatchSize = new Map<number, AdaptiveEWMA>();

let ackTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleAck() {
  if (ackTimer) return;
  ackTimer = setTimeout(() => {
    ackTimer = null;
    const api = API();
    if (!api) return;
    pendingChars.forEach((count, id) => {
      if (count > 0) {
        api.ack(id, count);
        pendingChars.set(id, 0);
      }
    });
  }, 100);
}

/** 获取自适应 ACK 批量大小 */
function getBatchSize(id: number): number {
  if (!adaptiveBatchSize.has(id)) {
    adaptiveBatchSize.set(id, new AdaptiveEWMA(ACK_BATCH));
  }
  return adaptiveBatchSize.get(id)!.value;
}

function trackOutput(id: number, dataLength: number) {
  const current = pendingChars.get(id) || 0;
  pendingChars.set(id, current + dataLength);

  const batch = getBatchSize(id);
  if (current + dataLength >= batch) {
    const api = API();
    if (api) {
      api.ack(id, current + dataLength);
      pendingChars.set(id, 0);
      // 反馈实际的批量大小到 EWMA
      if (adaptiveBatchSize.has(id)) {
        adaptiveBatchSize.get(id)!.add(current + dataLength);
      }
    }
  } else {
    scheduleAck();
  }
}

/* ─── 终端创建/销毁 ─── */

export async function createTerminal(config?: TerminalCreateConfig): Promise<TerminalCreateResult> {
  const api = API();
  if (!api) {
    return { success: false, error: 'Electron API 不可用' };
  }
  return api.create(config);
}

export async function disposeTerminal(id: number): Promise<void> {
  const api = API();
  if (api) {
    await api.dispose(id);
  }
  pendingChars.delete(id);
  adaptiveBatchSize.delete(id);
}

export async function sendInput(id: number, data: string): Promise<void> {
  const api = API();
  if (api) {
    await api.input(id, data);
  }
}

export async function resizeTerminal(id: number, cols: number, rows: number): Promise<void> {
  const api = API();
  if (api) {
    await api.resize(id, cols, rows);
  }
}

export async function sendSignal(id: number, signal: string): Promise<void> {
  const api = API();
  if (api) {
    await api.sendSignal(id, signal);
  }
}

export async function clearTerminal(id: number): Promise<void> {
  const api = API();
  if (api) {
    await api.clear(id);
  }
}

/* ─── Shell Profile ─── */

export async function listProfiles(): Promise<TerminalProfilesResult> {
  const api = API();
  if (!api) {
    return { success: false, error: 'Electron API 不可用' };
  }
  return api.listProfiles();
}

export async function getTerminalCwd(id: number): Promise<string | null> {
  const api = API();
  if (!api) return null;
  const result = await api.getCwd(id);
  return result.cwd || null;
}

/* ─── 广播输入 ─── */

export async function broadcastInput(senderId: number, data: string, targetIds: number[]): Promise<void> {
  const api = API();
  if (api) {
    await api.broadcast(senderId, data, targetIds);
  }
}

/* ─── 持久化 ─── */

export async function saveLayout(): Promise<void> {
  // 布局由 Redux slice 管理，此处保留接口
}

export async function restoreLayout(): Promise<void> {
  const api = API();
  if (api) {
    const result = await api.getLayout();
    if (result.layout) {
      // 布局恢复由调用方在 Redux 中处理
    }
  }
}

/* ─── 输出事件管理 ─── */

export type TerminalEventCallback = (event: TerminalOutputEvent) => void;

export function onTerminalOutput(callback: TerminalEventCallback): () => void {
  const api = API();
  if (!api) return () => {};

  return api.onOutput((event) => {
    if (event.type === 'data' && event.data) {
      trackOutput(event.id, event.data.length);
    }
    callback(event);
  });
}

/* ─── AI 辅助 ─── */

interface AITerminalContext {
  /** 最后一行输出 */
  lastLine: string;
  /** 上一个命令 */
  lastCommand: string;
  /** 退出码 */
  lastExitCode?: number;
}

let aiContext: AITerminalContext = {
  lastLine: '',
  lastCommand: '',
};

export function updateAIContext(context: Partial<AITerminalContext>) {
  aiContext = { ...aiContext, ...context };
}

export function getAIContext(): AITerminalContext {
  return { ...aiContext };
}

/**
 * AI 命令纠错建议
 * 使用 Aho-Corasick 多模式匹配 (数学优化 #8)
 */
const COMMON_TYPOS: Record<string, string> = {
  'gti': 'git', 'gerp': 'grep', 'npmn': 'npm', 'npn': 'npm',
  'git sttaus': 'git status', 'git commmit': 'git commit',
  'git pusj': 'git push', 'git pllu': 'git pull',
  'git chcekout': 'git checkout', 'git branhc': 'git branch',
  'dcoekr': 'docker', 'dokcer': 'docker',
  'pyhton': 'python', 'pythno': 'python', 'ndoe': 'node',
};

// 懒初始化 Aho-Corasick
let acMatcher: AhoCorasick | null = null;
function getACMatcher(): AhoCorasick {
  if (!acMatcher) {
    acMatcher = new AhoCorasick(Object.keys(COMMON_TYPOS));
  }
  return acMatcher;
}

export function suggestCommandCorrection(input: string): string | null {
  const trimmed = input.trim();
  const matcher = getACMatcher();
  const matches = matcher.search(trimmed);

  if (matches.length > 0) {
    // 取最长匹配
    let bestMatch = matches[0];
    for (const m of matches) {
      if (m.pattern.length > bestMatch.pattern.length) bestMatch = m;
    }
    const replacement = COMMON_TYPOS[bestMatch.pattern];
    if (replacement) {
      return trimmed.substring(0, bestMatch.index) + replacement + trimmed.substring(bestMatch.index + bestMatch.pattern.length);
    }
  }

  // fallback: 逐词替换
  const parts = trimmed.split(/\s+/);
  const corrected = parts.map(p => COMMON_TYPOS[p] || p).join(' ');
  return corrected !== trimmed ? corrected : null;
}

/**
 * AI 异常退出检测 — 返回修复建议
 */
export function detectAnomaly(exitCode: number, lastCommand: string): string | null {
  if (exitCode === 0) return null;

  const patterns: Array<{ match: RegExp; suggestion: string }> = [
    { match: /npm\s+install/, suggestion: '尝试 npm install --legacy-peer-deps 或删除 node_modules 后重试' },
    { match: /git\s+push/, suggestion: '尝试 git push --force-with-lease（注意：强制推送可能覆盖远程更改）' },
    { match: /git\s+pull/, suggestion: '可能存在合并冲突，尝试 git pull --rebase 或手动解决冲突' },
    { match: /docker\s+build/, suggestion: '检查 Dockerfile 语法和构建上下文路径' },
    { match: /tsc/, suggestion: '检查 tsconfig.json 配置和 TypeScript 类型错误' },
    { match: /npm\s+start/, suggestion: '检查 package.json 中 scripts.start 是否存在' },
  ];

  for (const { match, suggestion } of patterns) {
    if (match.test(lastCommand)) {
      return suggestion;
    }
  }

  return null;
}
