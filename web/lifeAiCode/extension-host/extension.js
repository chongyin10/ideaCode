/**
 * LifeAiCode 扩展主入口
 *
 * 运行在 Extension Host（独立 Node.js 子进程）
 *
 * 架构：
 * ┌──────────────────────────────────────────────────┐
 * │               Extension Host                     │
 * │  ┌───────────────────────────────────────────┐   │
 * │  │  LifeAiCode Extension                       │   │
 * │  │  ├─ LlmClient        (LLM API 通信)       │   │
 * │  │  ├─ CodeContextBuilder (代码上下文收集)    │   │
 * │  │  └─ SuggestionGenerator (建议解析管理)    │   │
 * │  └───────────────────────────────────────────┘   │
 * │         ↕ JSON-RPC (通过主进程)                    │
 * ├──────────────────────────────────────────────────┤
 * │              Renderer Process                    │
 * │  ┌───────────────────────────────────────────┐   │
 * │  │  WebView (iframe) ←→ ExtensionBridge      │   │
 * │  └───────────────────────────────────────────┘   │
 * └──────────────────────────────────────────────────┘
 *
 * 核心设计原则：
 * 1. 只读模式：AI 只能分析代码、提供建议，绝不直接修改
 * 2. 用户确认：所有代码变更必须经过用户明确确认
 * 3. 进程隔离：运行在独立 Extension Host，不拖垮主界面
 * 4. 可插拔 Provider：支持 OpenAI / Anthropic / Ollama
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const vscode = require('./api');
const { LlmClient } = require('./llmClient');
const { CodeContextBuilder } = require('./codeContext');
const { SuggestionGenerator } = require('./suggestionGenerator');
const { AgentRuntime } = require('./agent/agentRuntime');

/* ─── 全局状态 ─── */

let llmClient = null;
let contextBuilder = null;
let suggestionGenerator = null;
let agentRuntime = null;
let panel = null;
let isProcessing = false;
let configs = [];          // 所有配置
let activeConfigId = null; // 当前激活配置 ID

/* ─── Agent 待确认编辑 ─── */
const pendingAgentEdits = new Map(); // editId -> { filePath, original, modified }

/* ─── 工具函数 ─── */

function generateId() {
  return `lifeAiCode-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * 在候选路径列表中找第一个可写的路径。
 * 用于把日志、缓存等写入用户机器上的"安全位置"，避开打包目录只读 / 路径不存在等问题。
 * @param {string[]} candidates 候选绝对路径
 * @returns {string|null} 第一个能成功 ensureDir + ensureWrite 的路径；都失败返回 null
 */
function pickWritablePath(candidates) {
  for (const filePath of candidates) {
    if (!filePath) continue;
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // 用 fs.openSync 探测可写性（O_CREAT | O_WRONLY | O_APPEND）
      const fd = fs.openSync(filePath, 'a');
      fs.closeSync(fd);
      return filePath;
    } catch {
      // 当前路径不可写，试下一个
    }
  }
  return null;
}

/**
 * 读取 WebView HTML 并内联资源
 */
function getWebviewHtml(extensionPath) {
  const htmlPath = path.join(extensionPath, 'webview', 'index.html');
  try {
    let html = fs.readFileSync(htmlPath, 'utf-8');

    // 内联 CSS
    html = html.replace(/<link rel="stylesheet"[^>]*href="\.\/assets\/([^"]+)"[^>]*>/g, (match, filename) => {
      const cssPath = path.join(extensionPath, 'webview', 'assets', filename);
      try {
        const css = fs.readFileSync(cssPath, 'utf-8');
        return `<style>${css}</style>`;
      } catch {
        return match;
      }
    });

    // 内联 JS
    html = html.replace(/<script type="module"[^>]*src="\.\/assets\/([^"]+)"[^>]*><\/script>/g, (match, filename) => {
      const jsPath = path.join(extensionPath, 'webview', 'assets', filename);
      try {
        const js = fs.readFileSync(jsPath, 'utf-8');
        return `<script type="module">${js}</script>`;
      } catch {
        return match;
      }
    });

    return html;
  } catch (err) {
    console.error('[LifeAiCode] 读取 WebView HTML 失败:', err.message);
    return `<html><body style="color:#fff;background:#1e1e1e;padding:20px;font-family:sans-serif;">
      <h1>LifeAiCode</h1>
      <p>WebView 资源未找到，请运行 <code>cd web/lifeAiCode && npm run build</code></p>
      </body></html>`;
  }
}

/**
 * 执行 <shell> 命令：使用 child_process.spawn 隐藏执行
 *   - 不创建 VS Code 终端面板（避免 IDE 底部自动弹出）
 *   - stdout/stderr 实时流回 webview，由聊天窗口的代码块/工具块内嵌显示
 *   - 通过 idle/keepalive/kill 信号控制生命周期
 */
const { spawn } = require('child_process');
const MAX_OUTPUT_BYTES = 64 * 1024; // 单次 shellUpdate 推送的最大字节数（64KB）
const MAX_LINE_BUFFER = 2000;        // 累积超过 N 行就 flush
const FLUSH_INTERVAL_MS = 200;       // 实时推送的节流间隔
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟兜底超时

// 维护当前活跃的子进程，用于中止/重置
const activeProcs = new Map(); // id -> { proc, finished, cwd }
// 等待中的 executeShell 调用方（resolve/reject）—— 用于 Agent tool 同步等待输出
const pendingShellWaits = new Map(); // id -> { resolve, reject }

// executeShell 消息去重：同一 shellId 在 2 秒内重复到达时忽略，
// 防止 webview → 渲染进程 → 扩展宿主的消息路由重复转发导致同一命令被 spawn 两次。
const recentShellIds = new Map(); // id -> timestamp(ms)
const SHELL_DEDUP_MS = 2000;

/**
 * 异步执行 shell 命令。
 * - 立即把命令的初始事件 push 到 webview（命令回显 + cwd）
 * - stdout/stderr 实时通过 postToWebView 流回聊天窗口
 * - **同时**：如果有调用方在等结果（Agent tool），返回一个 Promise，
 *   在进程结束时 resolve({success, exitCode, output})。
 * @returns {Promise<{success: boolean, exitCode?: number, output: string}> | undefined}
 *   返回 undefined 表示"发射后不管"（webview 模式）；返回 Promise 表示有调用方在等。
 */
async function executeShellCommand(id, shellCommand, cwd) {
  console.log('[LifeAiCode][executeShellCommand] called:', { id, shellCommand, cwd });

  // 如果已经存在同 id 的进程，先杀掉（避免并发冲突）
  if (activeProcs.has(id)) {
    const prev = activeProcs.get(id);
    if (!prev.finished) {
      try { prev.proc.kill('SIGTERM'); } catch { /* ignore */ }
    }
    activeProcs.delete(id);
  }

  // 防御：shellCommand 不能为空
  if (!shellCommand || typeof shellCommand !== 'string') {
    console.error('[LifeAiCode][executeShellCommand] shellCommand is empty/invalid');
    postToWebView({
      type: 'shellUpdate',
      id, shellCommand: shellCommand || '',
      output: '执行失败: 命令为空',
      status: 'error',
    });
    return;
  }

  let workingDir = cwd || process.cwd();
  if (!workingDir || !fs.existsSync(workingDir)) {
    workingDir = os.homedir();
  }
  console.log('[LifeAiCode][executeShellCommand] workingDir:', workingDir);

  // 平台相关 shell 选择
  const isWindows = process.platform === 'win32';
  const shell = isWindows ? 'cmd.exe' : '/bin/sh';
  const shellArgs = isWindows ? ['/c', shellCommand] : ['-c', shellCommand];

  let proc;
  try {
    proc = spawn(shell, shellArgs, {
      cwd: workingDir,
      env: { ...process.env, FORCE_COLOR: '1', CLICOLOR_FORCE: '1' },
      windowsHide: true,
    });
    console.log('[LifeAiCode][executeShellCommand] spawned pid:', proc.pid);
  } catch (err) {
    console.error('[LifeAiCode][executeShellCommand] spawn failed:', err);
    const errorMsg = `执行失败: ${err.message}`;
    postToWebView({
      type: 'shellUpdate',
      id, shellCommand,
      output: errorMsg,
      status: 'error',
    });
    // Bug 11: 注册 finished entry + result，让 waitShellCompletion 能拿到真实错误
    // 而非通用的 "shell 进程未运行或不存在"
    activeProcs.set(id, { proc: null, finished: true, cwd: workingDir, buffers: { stdout: '', stderr: '' }, fullOutput: errorMsg, result: { success: false, error: errorMsg, output: errorMsg } });
    return;
  }

  // 立刻推送 "running" 启动事件（确保 webview 立即有反应）
  console.log('[LifeAiCode][executeShellCommand] posting initial running event');
  postToWebView({
    type: 'shellUpdate',
    id, shellCommand,
    output: `$ ${shellCommand}\n[工作目录] ${workingDir}\n\n`,
    status: 'running',
  });
  console.log('[LifeAiCode][executeShellCommand] initial event posted');

  // Bug 1: 新增 fullOutput 字段，累积完整输出（flush 不会清空它），
  // waiter resolve 时使用 fullOutput 而非会被 flush 清空的 buffers
  const entry = { proc, finished: false, cwd: workingDir, buffers: { stdout: '', stderr: '' }, fullOutput: '', result: null };
  activeProcs.set(id, entry);

  // 注：原代码在此处又推送了一次完全相同的 running 事件，导致 webview 收到两条
  // 重复的初始输出（$ 命令 + [工作目录] 出现两次）。已删除重复推送。

  // 累积行缓冲 + 节流 flush
  const flush = (status) => {
    const stdout = entry.buffers.stdout;
    const stderr = entry.buffers.stderr;
    if (!stdout && !stderr) return;
    let combined = '';
    if (stdout) combined += stdout;
    if (stderr) combined += stderr;
    // 截断过长的输出
    if (combined.length > MAX_OUTPUT_BYTES) {
      combined = '…(输出过长，已截断)…\n' + combined.slice(-MAX_OUTPUT_BYTES);
    }
    postToWebView({ type: 'shellUpdate', id, shellCommand, output: combined, status });
    entry.buffers.stdout = '';
    entry.buffers.stderr = '';
  };

  const flushTimer = setInterval(() => {
    if (!entry.finished) flush('running');
  }, FLUSH_INTERVAL_MS);
  // 存储 timer 引用，便于 killShellCommand 清理，防止进程结束后 timer 仍空转
  entry.flushTimer = flushTimer;

  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    entry.buffers.stdout += text;
    entry.fullOutput += text;
    if (entry.buffers.stdout.length > MAX_LINE_BUFFER) flush('running');
  });

  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    entry.buffers.stderr += text;
    entry.fullOutput += text;
    if (entry.buffers.stderr.length > MAX_LINE_BUFFER) flush('running');
  });

  proc.on('error', (err) => {
    const text = `\n[进程错误] ${err.message}\n`;
    entry.buffers.stdout += text;
    entry.fullOutput += text;
  });

  proc.on('close', (code, signal) => {
    if (entry.finished) return;
    entry.finished = true;
    clearInterval(flushTimer);
    if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
    const status = code === 0 ? 'success' : (signal ? 'error' : 'error');
    flush(status);
    // 补一个空输出但带状态的最终事件（确保 webview 收到 done 信号）
    postToWebView({
      type: 'shellUpdate',
      id, shellCommand,
      output: '',
      status,
      exitCode: code ?? undefined,
      signal: signal ?? undefined,
    });
    // 唤醒在等结果的人（Agent tool）
    // Bug 1: 使用 fullOutput（完整累积），不用会被 flush 清空的 buffers
    const result = {
      success: code === 0,
      exitCode: code ?? undefined,
      signal: signal ?? undefined,
      output: entry.fullOutput.trim(),
    };
    entry.result = result;
    const waiter = pendingShellWaits.get(id);
    if (waiter) {
      pendingShellWaits.delete(id);
      waiter.resolve(result);
    }
    activeProcs.delete(id);
  });

  // 兜底超时
  const timeoutTimer = setTimeout(() => {
    if (entry.finished) return;
    entry.buffers.stdout += `\n[超时] 命令执行超过 5 分钟，已强制终止。\n`;
    flush('error');
    try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }, 2000);
  }, DEFAULT_TIMEOUT_MS);
  entry.timeoutTimer = timeoutTimer;

  // 返回 Promise 给在等的调用方（Agent tool）
  // 注意：首次调用时这个 Promise 还没人等，所以 pendingShellWaits 里没记录
  // 后续如果有 waitShellCompletion(id) 调用，会被 addShellWaiter 添加到 map
  // 这里我们返回 Promise 主动挂入（如果没有 waiter 就 setTimeout 删除自身）
  return new Promise((resolve, reject) => {
    pendingShellWaits.set(id, { resolve, reject });
    // 如果 60 秒后还没人 wait，清理自身（避免泄漏）
    setTimeout(() => {
      const w = pendingShellWaits.get(id);
      if (w) {
        pendingShellWaits.delete(id);
        w.resolve({
          success: false,
          error: 'shell 命令已触发但无调用方等待结果',
        });
      }
    }, 60_000);
  });
}

/**
 * 终止指定 shellId 对应的子进程，释放 CPU/内存资源。
 * 用于 webview 点击"停止"按钮关闭长期运行命令（如 npm run dev）。
 * - 先 SIGTERM 优雅终止，2 秒后 SIGKILL 强制兜底
 * - 清理 flushTimer / timeoutTimer 避免泄漏
 * - 推送 status='killed' 让 webview 切换 UI 状态
 * - 唤醒在等结果的 Agent tool waiter
 */
function killShellCommand(id) {
  const entry = activeProcs.get(id);
  if (!entry) {
    console.log('[LifeAiCode][killShell] no active proc for id:', id);
    return false;
  }
  if (entry.finished) {
    console.log('[LifeAiCode][killShell] already finished:', id);
    return false;
  }
  const proc = entry.proc;
  // 标记 finished，防止后续 'close' 事件重复处理
  entry.finished = true;
  // 清理定时器，释放资源
  if (entry.flushTimer) { clearInterval(entry.flushTimer); entry.flushTimer = null; }
  if (entry.timeoutTimer) { clearTimeout(entry.timeoutTimer); entry.timeoutTimer = null; }
  // 最后 flush 一次剩余缓冲
  try {
    const flush = () => {
      const stdout = entry.buffers.stdout;
      const stderr = entry.buffers.stderr;
      let combined = '';
      if (stdout) combined += stdout;
      if (stderr) combined += stderr;
      if (combined) {
        postToWebView({ type: 'shellUpdate', id, shellCommand: '', output: combined, status: 'killed' });
        entry.buffers.stdout = '';
        entry.buffers.stderr = '';
      }
    };
    flush();
  } catch { /* ignore */ }
  // 推送终止事件（带 killed 状态），让 webview 切换 UI
  postToWebView({
    type: 'shellUpdate',
    id, shellCommand: '',
    output: '\n[已终止] 用户手动停止了命令执行。\n',
    status: 'killed',
    signal: 'SIGTERM',
  });
  // 优雅终止 → 2 秒后强制 kill 兜底（确保进程树释放，不残留 zombie）
  if (proc) {
    try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }, 2000);
  }
  // 唤醒在等结果的 Agent tool waiter（kill 也算结束）
  const result = {
    success: false,
    error: '命令已被用户终止',
    signal: 'SIGTERM',
    output: entry.fullOutput ? entry.fullOutput.trim() + '\n[已终止]' : '[已终止]',
  };
  entry.result = result;
  const waiter = pendingShellWaits.get(id);
  if (waiter) {
    pendingShellWaits.delete(id);
    waiter.resolve(result);
  }
  // 释放 entry（保留短暂时间防止竞争，2 秒后删除）
  setTimeout(() => {
    activeProcs.delete(id);
  }, 100);
  console.log('[LifeAiCode][killShell] terminated:', id, 'pid:', proc ? proc.pid : null);
  return true;
}

/**
 * Agent tool 用：在等指定 shellId 的完成结果。
 * 如果 executeShellCommand 还没跑或已经结束，立即 resolve。
 * @param {string} id shellId
 * @param {number} timeoutMs 超时（默认 60s）
 * @returns {Promise<{success, exitCode, output, error?}>}
 */
function waitShellCompletion(id, timeoutMs = 60_000) {
  // Bug 11: 进程已结束（含 spawn 失败）且存有 result → 直接返回
  const entry = activeProcs.get(id);
  if (entry && entry.finished && entry.result) {
    activeProcs.delete(id);
    return Promise.resolve(entry.result);
  }
  // 进程已结束 → 没有 waiter 注册，构造一个同步的 resolved
  if (!activeProcs.has(id) && !pendingShellWaits.has(id)) {
    return Promise.resolve({ success: false, error: 'shell 进程未运行或不存在' });
  }
  // 已有 waiter 在等 → 复用
  const existing = pendingShellWaits.get(id);
  if (existing) {
    return new Promise((resolve, reject) => {
      const prev = existing;
      // 包一层：之前已注册的 resolve 也会被这个新 resolve 拿到结果
      const wrappedResolve = (v) => { prev.resolve(v); resolve(v); };
      const wrappedReject = (e) => { prev.reject(e); reject(e); };
      pendingShellWaits.set(id, { resolve: wrappedResolve, reject: wrappedReject });
      // 设超时
      setTimeout(() => {
        if (pendingShellWaits.get(id)?.resolve === wrappedResolve) {
          pendingShellWaits.delete(id);
          resolve({ success: false, error: '等待 shell 完成超时' });
        }
      }, timeoutMs);
    });
  }
  return Promise.resolve({ success: false, error: 'shell 进程未运行' });
}

/**
 * 发送消息到 WebView
 */
function postToWebView(message) {
  if (panel && panel.webview) {
    panel.webview.postMessage(message);
  }
}

/* ─── LLM 交互 ─── */

/**
 * 初始化 LLM 客户端
 */
function initLlmClient(config) {
  llmClient = new LlmClient({
    provider: config.provider || 'openai',
    apiKey: config.apiKey || '',
    model: config.model || '',
    baseUrl: config.baseUrl || '',
  });
  if (agentRuntime) {
    agentRuntime.llmClient = llmClient;
    agentRuntime.adapter.llmClient = llmClient;
  }
  console.log('[LifeAiCode] LLM 客户端已初始化, provider:', llmClient.provider, 'model:', llmClient.model, 'baseUrl:', llmClient.baseUrl);
}

/**
 * 发送消息到 LLM 并获取建议
 */
/** 维护每次请求的上下文，用于 continue 继续生成 */
let lastRequestContext = null;
/**
 * Bug 14: 按 messageId 存储请求上下文，避免被后续消息覆盖。
 * 原来用单个 lastRequestContext，用户发消息 B 后对消息 A 点"继续"
 * 会用到 B 的 text/context，导致语义错乱。
 */
const requestContextMap = new Map();

async function processMessage(text, context, options = {}) {
  if (isProcessing) return;
  isProcessing = true;

  const { thinkingEnabled, continueFromMessageId, continueFromContent, continueFromText, history } = options || {};
  const msgId = continueFromMessageId || generateId();
  console.log('[LifeAiCode] 处理用户消息:', text.slice(0, 60), 'thinkingEnabled:', thinkingEnabled, 'continue:', !!continueFromMessageId, 'history:', Array.isArray(history) ? history.length : 0);

  // 记录上下文以便 continue 使用
  lastRequestContext = { text, context, thinkingEnabled };
  // Bug 14: 按 msgId 存储上下文，避免被后续消息覆盖
  requestContextMap.set(msgId, { text, context, thinkingEnabled });
  // 清理过旧条目（保留最近 50 条），避免内存无限增长
  if (requestContextMap.size > 50) {
    const oldestKey = requestContextMap.keys().next().value;
    requestContextMap.delete(oldestKey);
  }

  try {
    // 1. 检查 LLM 客户端
    if (!llmClient) {
      throw new Error('LLM 客户端未初始化');
    }

    // 2. 根据思考模式开关切换系统提示词
    if (thinkingEnabled) {
      const basePrompt = llmClient._defaultSystemPrompt();
      const thinkingInstruction = `\n## 思考模式\n在给出最终回答前，请先逐步分析问题并展示你的推理过程。\n请把推理过程包裹在 <reasoning>...</reasoning> 标签内，然后再输出最终答案。\n推理过程可以包括：读取了哪些文件、考虑了哪些方案、为什么选择该方案等。`;
      llmClient.configure({ systemPrompt: `${basePrompt}${thinkingInstruction}` });
    } else {
      llmClient.configure({ systemPrompt: llmClient._defaultSystemPrompt() });
    }

    // 3. 构建消息数组
    let messages;
    if (continueFromContent && continueFromText) {
      // Continue 模式：把已截断的内容作为 assistant 消息，把"请继续"作为 user
      messages = [
        { role: 'user', content: continueFromText },
        { role: 'assistant', content: continueFromContent + '\n\n[回答被截断，请从上一个未完成的句子继续，不要重复已写内容]' },
        { role: 'user', content: '请从你上次中断的地方继续完成回答。不要重复已写过的内容，直接接着写。' },
      ];
    } else {
      const contextStr = contextBuilder.formatContextForPrompt(context);
      const userMessage = contextStr
        ? `## 用户问题\n${text}\n\n## 代码上下文\n${contextStr}`
        : text;

      // 把 IDE 自动读取的文件以步骤形式展示出来
      const readSteps = [];
      if (context.activeFile) {
        const rel = contextBuilder._getRelativePath(context.activeFile.filePath, context.workspaceRoot);
        readSteps.push(`<step type="read" target="${rel}" status="done">读取</step>`);
      }
      if (context.relatedFiles && context.relatedFiles.length > 0) {
        for (const f of context.relatedFiles) {
          const rel = contextBuilder._getRelativePath(f.filePath, context.workspaceRoot);
          readSteps.push(`<step type="read" target="${rel}" status="done">读取</step>`);
        }
      }
      if (readSteps.length > 0) {
        postToWebView({
          type: 'chatResponse',
          id: generateId(),
          content: readSteps.join('\n'),
          done: true,
        });
      }
      // §继续会话：若 WebView 传入了历史消息，作为多轮对话上下文前置拼接
      // （过滤掉空内容和占位符，最多保留最近 10 轮避免 token 爆炸）
      const historyMessages = Array.isArray(history) && history.length > 0
        ? history
            .filter((m) => m && m.content && typeof m.content === 'string' && m.content.trim())
            .slice(-20)
            .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
        : [];
      messages = [...historyMessages, { role: 'user', content: userMessage }];
    }

    // 4. 调用 LLM（先尝试流式，失败回退非流式）
    let fullResponse = '';
    let aborted = false;
    /** 跟踪本次请求的 token 监听器，结束/异常时精确移除 */
    let tokenListener = null;
    try {
      // 仅移除自己上一次的 token 监听器（如果存在），不破坏其他订阅者
      if (processMessage._lastTokenListener) {
        try { llmClient.off('token', processMessage._lastTokenListener); } catch { /* ignore */ }
      }
      // Bug 2: 使用单独变量累积续写 delta，避免每个 token 覆盖之前的内容
      // 原代码 fullResponse = continueFromContent + token 会丢失之前所有 delta
      let continuedContent = '';
      tokenListener = (token) => {
        if (continueFromContent) {
          continuedContent += token;
          fullResponse = continueFromContent + continuedContent;
        } else {
          fullResponse += token;
        }
        postToWebView({
          type: 'chatResponse',
          id: msgId,
          content: fullResponse,
          done: false,
        });
      };
      // 挂载并保存引用，便于下次请求时清理
      llmClient.on('token', tokenListener);
      processMessage._lastTokenListener = tokenListener;
      // Bug 2: chatStream 返回的是本次新生成的完整内容（fullContent），
      // 不含 continueFromContent 前缀，需手动拼接，否则续写后原内容丢失
      const streamResult = await llmClient.chatStream(messages);
      fullResponse = continueFromContent ? continueFromContent + streamResult : streamResult;
    } catch (streamErr) {
      if (streamErr.isAbort) {
        aborted = true;
      } else {
        console.warn('[LifeAiCode] 流式请求失败, 回退到非流式:', streamErr.message);
        const resp = await llmClient.chat(messages);
        fullResponse = continueFromContent ? continueFromContent + resp : resp;
      }
    } finally {
      // 清理 token 监听器，避免内存泄漏
      if (tokenListener) {
        try { llmClient.off('token', tokenListener); } catch { /* ignore */ }
        if (processMessage._lastTokenListener === tokenListener) {
          processMessage._lastTokenListener = null;
        }
      }
    }

    if (aborted) {
      postToWebView({
        type: 'chatResponse',
        id: msgId,
        content: fullResponse ? `${fullResponse}\n\n> ⏹ 已停止生成` : '> ⏹ 已停止生成',
        done: true,
      });
      return;
    }

    console.log('[LifeAiCode] LLM 响应长度:', fullResponse.length, '字符');

    // 6. 发送完整响应（如果为空，给出友好提示）
    postToWebView({
      type: 'chatResponse',
      id: msgId,
      content: fullResponse || '⚠️ AI 未返回任何内容。请检查：\n1. 模型名称是否正确\n2. API Key 是否有效\n3. Provider / Base URL 是否匹配',
      done: true,
    });

    // 7. 解析建议（continue 模式不重复解析）
    if (!continueFromMessageId) {
      const suggestions = suggestionGenerator.parseSuggestions(fullResponse, context);
      if (suggestions.length > 0) {
        console.log('[LifeAiCode] 生成', suggestions.length, '个建议');
        postToWebView({
          type: 'suggestions',
          suggestions: suggestions.map((s) => ({
            id: s.id,
            type: s.type,
            title: s.title,
            description: s.description,
            changes: s.changes,
            status: s.status,
            createdAt: s.createdAt,
          })),
        });
      }
    }
  } catch (err) {
    if (err.isAbort) {
      postToWebView({
        type: 'chatResponse',
        id: msgId,
        content: fullResponse ? `${fullResponse}\n\n> ⏹ 已停止生成` : '> ⏹ 已停止生成',
        done: true,
      });
    } else {
      console.error('[LifeAiCode] LLM 请求失败:', err.message);
      postToWebView({
        type: 'chatResponse',
        id: msgId,
        content: `❌ **错误**: ${err.message}\n\n请检查:\n1. API Key 是否正确配置\n2. 网络连接是否正常\n3. Provider 服务是否可用`,
        done: true,
      });
    }
  } finally {
    isProcessing = false;
  }
}

/**
 * 运行 Agent 任务
 */
async function runAgentTask(text, context, options = {}) {
  if (isProcessing) return;
  isProcessing = true;

  const msgId = generateId();
  const { history } = options || {};
  console.log('[LifeAiCode][Agent] 开始任务:', text.slice(0, 60), 'history:', Array.isArray(history) ? history.length : 0);

  try {
    if (!agentRuntime) {
      throw new Error('Agent 运行时未初始化');
    }

    postToWebView({
      type: 'agentStatus',
      status: 'running',
      message: 'Agent 开始执行任务...',
    });

    const cleanToolCallTags = (text) => text
      .replace(new RegExp("`tool_call`[\\s\\S]*?<\/tool_call>", "g"), "")
      .replace(new RegExp("`tool_call`[\\s\\S]*$", "g"), "")
      .trim();

    let streamedContent = '';
    const finalResponse = await agentRuntime.run(text, context, {
      history,
      onToken: (token) => {
        // 实时推送内容到 WebView，过滤 prompt-based 模式下可能混入的 <tool_call> 标签
        streamedContent += token;
        const displayContent = cleanToolCallTags(streamedContent);
        if (displayContent) {
          postToWebView({
            type: 'chatResponse',
            id: msgId,
            content: displayContent,
            done: false,
          });
        }
      },
      onToolCall: (toolCall) => {
        postToWebView({
          type: 'step',
          stepType: 'agent',
          target: toolCall.name,
          params: JSON.stringify(toolCall.arguments),
          status: 'running',
        });
      },
      onDone: () => {
        postToWebView({
          type: 'agentStatus',
          status: 'done',
          message: 'Agent 任务完成',
        });
      },
      onError: (error) => {
        postToWebView({
          type: 'agentStatus',
          status: 'error',
          message: `Agent 任务失败: ${error}`,
        });
      },
    });

    const displayContent = cleanToolCallTags(streamedContent || finalResponse || '');
    postToWebView({
      type: 'chatResponse',
      id: msgId,
      content: displayContent || '任务已完成，但没有返回内容。',
      done: true,
    });
  } catch (err) {
    if (err.isAbort) {
      postToWebView({
        type: 'chatResponse',
        id: msgId,
        content: '> ⏹ Agent 任务已停止',
        done: true,
      });
      postToWebView({
        type: 'agentStatus',
        status: 'cancelled',
        message: 'Agent 任务已停止',
      });
    } else {
      console.error('[LifeAiCode][Agent] 任务失败:', err.message);
      postToWebView({
        type: 'chatResponse',
        id: msgId,
        content: `❌ **Agent 任务失败**: ${err.message}`,
        done: true,
      });
      postToWebView({
        type: 'agentStatus',
        status: 'error',
        message: err.message,
      });
    }
  } finally {
    isProcessing = false;
  }
}

/**
 * 解释当前代码
 */
async function explainCode(context) {
  await processMessage(
    '请解释当前代码的功能、结构和关键逻辑。包括：\n1. 主要功能\n2. 关键函数/类的作用\n3. 数据流\n4. 潜在改进点',
    context
  );
}

/**
 * 建议重构
 */
async function suggestRefactor(context) {
  await processMessage(
    '请对当前代码提出重构建议。考虑：\n1. 代码复用性\n2. 类型安全性\n3. 可读性\n4. 性能\n5. 设计模式改进\n请以 suggestion 格式提供具体代码变更。',
    context
  );
}

/**
 * 接受建议 → 应用变更
 *
 * 这是唯一可以修改代码的地方。
 * 只有用户明确接受后，才会执行文件写入。
 */
async function acceptAndApplySuggestion(suggestionId) {
  const suggestion = suggestionGenerator.getSuggestion(suggestionId);
  if (!suggestion) {
    console.warn('[LifeAiCode] 建议不存在:', suggestionId);
    return;
  }

  suggestionGenerator.acceptSuggestion(suggestionId);

  postToWebView({
    type: 'suggestionStatus',
    suggestionId,
    status: 'accepted',
  });

  if (suggestion.changes.length > 0) {
    try {
      // 按文件分组变更
      const fileGroups = new Map();
      for (const change of suggestion.changes) {
        if (change.original === change.modified || !change.modified) continue;
        if (!fileGroups.has(change.filePath)) fileGroups.set(change.filePath, []);
        fileGroups.get(change.filePath).push(change);
      }

      for (const [filePath, changes] of fileGroups) {
        // 读取当前文件内容并依次替换
        let currentContent = '';
        try {
          currentContent = fs.readFileSync(filePath, 'utf-8');
        } catch {
          console.warn('[LifeAiCode] 无法读取文件:', filePath);
          continue;
        }

        let newContent = currentContent;
        // Bug 6: 跟踪实际应用的变更，只把这些发给主进程。
        // 原代码把所有 changes（含被跳过的）都发给主进程，导致主进程尝试替换不存在的片段。
        const appliedChanges = [];
        for (const change of changes) {
          if (!newContent.includes(change.original)) {
            console.warn('[LifeAiCode] 原始代码未找到，跳过:', filePath);
            continue;
          }
          // Bug 7: 用 replaceAll 替换所有匹配项，避免 String.replace 只替换首个。
          newContent = newContent.replaceAll(change.original, change.modified);
          appliedChanges.push(change);
        }

        if (newContent === currentContent) {
          console.warn('[LifeAiCode] 文件内容无变化:', filePath);
          continue;
        }

        console.log('[LifeAiCode] 应用变更到:', filePath);
        if (typeof process !== 'undefined' && process.send) {
          // 由 applyChanges 负责读取当前文件、安全替换并写入磁盘 + 刷新编辑器
          process.send({
            jsonrpc: '2.0',
            method: 'lifeAiCode.applyChanges',
            params: {
              filePath,
              original: appliedChanges.map((c) => c.original),
              modified: appliedChanges.map((c) => c.modified),
            },
          });
        } else {
          // B3: process.send 不可用时抛错，让外层 catch 捕获，
          // 避免继续执行 markApplied 误报"已应用"
          throw new Error('Extension Host 未连接到主进程，无法应用变更');
        }
      }
      suggestionGenerator.markApplied(suggestionId);
      postToWebView({ type: 'suggestionStatus', suggestionId, status: 'applied' });
      // 不再弹窗；改为通过 webview notice 在聊天位置提示
      const applied = suggestionGenerator.getSuggestion(suggestionId);
      postToWebView({
        type: 'notice',
        level: 'success',
        message: `已应用建议：${applied?.title || suggestionId}`,
        suggestionId,
      });
    } catch (err) {
      console.error('[LifeAiCode] 应用建议失败:', err.message);
      vscode.window.showErrorMessage(`LifeAiCode: 应用建议失败 - ${err.message}`);
    }
  }
}

/**
 * 预览差异
 */
function previewDiff(suggestionId) {
  const suggestion = suggestionGenerator.getSuggestion(suggestionId);
  if (!suggestion) return;

  const diffData = suggestionGenerator.getDiffData(suggestion);
  postToWebView({
    type: 'diffPreview',
    suggestionId,
    changes: diffData,
  });
}

/* ─── 扩展入口 ─── */

async function activate(context) {
  console.log('[LifeAiCode] 扩展已激活');

  // 初始化组件
  suggestionGenerator = new SuggestionGenerator();
  contextBuilder = new CodeContextBuilder({
    request: async (method, params) => {
      if (typeof process !== 'undefined' && process.send) {
        return new Promise((resolve, reject) => {
          const id = Date.now() + Math.random();
          process.send({ jsonrpc: '2.0', id, method, params });
          const handler = (msg) => {
            if (msg.id === id) {
              process.removeListener('message', handler);
              if (msg.error) reject(new Error(msg.error.message));
              else resolve(msg.result);
            }
          };
          process.on('message', handler);
          setTimeout(() => {
            process.removeListener('message', handler);
            reject(new Error('RPC timeout'));
          }, 30000);
        });
      }
      return null;
    },
  });

  // 初始化 Agent Runtime
  agentRuntime = new AgentRuntime(llmClient, {
    rpc: async (method, params) => {
      if (!contextBuilder) return null;
      return contextBuilder.rpc.request(method, params);
    },
    postToWebView,
    executeShell: executeShellCommand,
    waitShellCompletion,
    registerPendingEdit: (editId, edit) => {
      pendingAgentEdits.set(editId, edit);
    },
  });
  // 设置 Agent 审计日志路径（多级兜底：扩展目录 → 用户家目录 → 临时目录）
  try {
    const auditPath = pickWritablePath([
      context.extensionPath && path.join(context.extensionPath, '.lifeAiCode-agent-audit.log'),
      path.join(os.homedir(), '.lifeAiCode-agent-audit.log'),
      path.join(os.tmpdir(), 'lifeAiCode-agent-audit.log'),
    ]);
    if (auditPath) {
      agentRuntime.auditLogger.setLogPath(auditPath);
      console.log('[LifeAiCode] Agent 审计日志:', auditPath);
    } else {
      console.warn('[LifeAiCode] Agent 审计日志不可用，将跳过记录');
    }
  } catch (err) {
    console.warn('[LifeAiCode] 设置审计日志失败:', err.message);
  }

  // 初始化 LLM 客户端（优先加载持久化配置，其次环境变量）
  const envKey = process.env.MYAICODE_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY
    || process.env.DEEPSEEK_API_KEY || process.env.ZHIPU_API_KEY || process.env.DASHSCOPE_API_KEY || '';
  let initConfig = {
    id: 'env-config',
    name: '环境变量配置',
    provider: process.env.MYAICODE_PROVIDER || process.env.LLM_PROVIDER || 'openai',
    apiKey: envKey,
    model: process.env.MYAICODE_MODEL || '',
    baseUrl: '',
    verified: false,
  };

  // 尝试加载持久化配置（多配置）
  function loadPersistedConfigs() {
    try {
      const configPath = path.join(context.extensionPath, '.lifeAiCode-config.json');
      if (fs.existsSync(configPath)) {
        const saved = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (saved.configs && Array.isArray(saved.configs)) {
          configs = saved.configs;
          activeConfigId = saved.activeConfigId || configs[0]?.id || '';
          console.log('[LifeAiCode] 加载持久化配置:', configs.length, '个, 当前:', activeConfigId);
          return;
        }
      }
    } catch { /* ignore */ }
    configs = [];
    activeConfigId = '';
  }

  loadPersistedConfigs();

  // 合并环境变量配置到列表（如果没有持久化配置）
  if (configs.length === 0 && initConfig.apiKey) {
    configs = [initConfig];
    activeConfigId = initConfig.id;
  }

  const activeConfig = configs.find((c) => c.id === activeConfigId) || configs[0];
  if (activeConfig) {
    initLlmClient(activeConfig);
    console.log('[LifeAiCode] LLM 已配置:', activeConfig.provider, activeConfig.model || '(默认模型)');
  } else {
    console.log('[LifeAiCode] 未配置 API Key, 使用演示模式（仅显示占位响应）');
    initLlmClient(initConfig);
  }

  // 持久化当前配置状态并广播给 WebView
  function persistConfigs() {
    try {
      const configPath = path.join(context.extensionPath, '.lifeAiCode-config.json');
      fs.writeFileSync(configPath, JSON.stringify({ configs, activeConfigId }, null, 2));
    } catch { /* ignore */ }
  }

  function broadcastConfigs() {
    postToWebView({ type: 'configLoaded', configs, activeId: activeConfigId });
  }

  function setActiveConfig(config) {
    if (!config) return;
    initLlmClient(config);
    activeConfigId = config.id;
    persistConfigs();
    broadcastConfigs();
  }

  // 注册内部命令
  const commands = [
    ['lifeAiCode.internal.processMessage', async (params) => {
      const ctx = params.context || await contextBuilder.buildContext({ selection: params.selection });
      await processMessage(params.text, ctx);
    }],
    ['lifeAiCode.internal.explainCode', async (params) => {
      const ctx = params.context || await contextBuilder.buildContext();
      await explainCode(ctx);
    }],
    ['lifeAiCode.internal.suggestRefactor', async (params) => {
      const ctx = params.context || await contextBuilder.buildContext();
      await suggestRefactor(ctx);
    }],
    ['lifeAiCode.internal.accept', async (params) => {
      await acceptAndApplySuggestion(params.suggestionId);
    }],
    ['lifeAiCode.internal.reject', async (params) => {
      const s = suggestionGenerator.rejectSuggestion(params.suggestionId);
      if (s) {
        postToWebView({ type: 'suggestionStatus', suggestionId: params.suggestionId, status: 'rejected' });
      }
    }],
    ['lifeAiCode.internal.previewDiff', async (params) => {
      previewDiff(params.suggestionId);
    }],
    ['lifeAiCode.internal.setEditMode', async (params) => {
      postToWebView({ type: 'aiEditMode', enabled: !!params?.enabled });
    }],
    ['lifeAiCode.internal.configure', async (params) => {
      const { config } = params;
      if (config) {
        configs = configs.map((c) => c.id === config.id ? config : c);
        if (!configs.find((c) => c.id === config.id)) configs.push(config);
        setActiveConfig(config);
        console.log('[LifeAiCode] 配置已更新:', config.provider, config.model);
        vscode.window.showInformationMessage(`LifeAiCode: 已切换到 ${config.provider} / ${config.model || '默认'}`);
      }
    }],
    ['lifeAiCode.internal.testConnection', async (params) => {
      const { config } = params;
      try {
        if (!config || (!config.apiKey && config.provider !== 'ollama')) {
          postToWebView({ type: 'connectionTestResult', success: false, message: '请先填写 API Key' });
          return;
        }
        // 临时创建客户端测试
        const testClient = new LlmClient({
          provider: config.provider || 'openai',
          apiKey: config.apiKey || '',
          model: config.model || '',
          baseUrl: config.baseUrl || '',
          timeout: 10000,
        });
        const result = await testClient.chat([{ role: 'user', content: '回复 "ok" 表示连接正常' }]);
        const cleanResult = String(result || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        const preview = cleanResult.slice(0, 30);
        postToWebView({
          type: 'connectionTestResult',
          success: true,
          message: preview ? `连接成功（模型返回: ${preview}${cleanResult.length > 30 ? '…' : ''}）` : '连接成功',
        });
      } catch (err) {
        postToWebView({
          type: 'connectionTestResult',
          success: false,
          message: `连接失败: ${err.message}`,
        });
      }
    }],
  ];

  for (const [cmd, handler] of commands) {
    context.subscriptions.push(
      vscode.commands.registerCommand(cmd, handler)
    );
  }

  // 注册公共命令
  const publicCommands = [
    ['lifeAiCode.ask', async () => {
      if (panel) panel.reveal();
    }],
    ['lifeAiCode.explain', async () => {
      const ctx = await contextBuilder.buildContext();
      await explainCode(ctx);
    }],
    ['lifeAiCode.refactor', async () => {
      const ctx = await contextBuilder.buildContext();
      await suggestRefactor(ctx);
    }],
    ['lifeAiCode.accept', async () => {
      const pending = suggestionGenerator.getPendingSuggestions();
      if (pending.length > 0) await acceptAndApplySuggestion(pending[0].id);
    }],
    ['lifeAiCode.reject', async () => {
      const pending = suggestionGenerator.getPendingSuggestions();
      if (pending.length > 0) {
        const s = suggestionGenerator.rejectSuggestion(pending[0].id);
        if (s) postToWebView({ type: 'suggestionStatus', suggestionId: s.id, status: 'rejected' });
      }
    }],
    ['lifeAiCode.previewDiff', async () => {
      const pending = suggestionGenerator.getPendingSuggestions();
      if (pending.length > 0) previewDiff(pending[0].id);
    }],
    ['lifeAiCode.newChat', async () => {
      postToWebView({ type: 'newChat' });
      if (panel) panel.reveal();
    }],
    ['lifeAiCode.openConfig', async () => {
      postToWebView({ type: 'openConfig' });
      if (panel) panel.reveal();
    }],
    ['lifeAiCode.showHistory', async () => {
      postToWebView({ type: 'showHistory' });
      if (panel) panel.reveal();
    }],
  ];

  for (const [cmd, handler] of publicCommands) {
    context.subscriptions.push(
      vscode.commands.registerCommand(cmd, handler)
    );
  }

  // 创建 WebView 面板（AI 对话 UI）
  panel = vscode.window.createWebviewPanel(
    'lifeAiCode-chat',
    'LifeAiCode',
    { preserveFocus: false },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(context.extensionPath)],
    }
  );

  panel.webview.html = getWebviewHtml(context.extensionPath);

  // 处理 WebView 发来的消息
  panel.webview.onDidReceiveMessage(async (message) => {
    console.log('[LifeAiCode] 收到 WebView 消息:', message.command);

    try {
      switch (message.command) {
        case 'sendMessage': {
          const ctx = message.context || await contextBuilder.buildContext();
          // 更新 Agent Runtime 上下文
          if (agentRuntime) {
            agentRuntime.context.workspaceRoot = ctx.workspaceRoot || '';
          }
          if (message.agentMode) {
            await runAgentTask(message.text, ctx, { history: message.history });
          } else {
            await processMessage(message.text, ctx, { thinkingEnabled: message.thinkingEnabled, history: message.history });
          }
          break;
        }
        case 'continueMessage': {
          // 继续被截断的回答
          // Bug 14: 按 messageId 从 Map 中查找原始上下文，不再依赖可能被覆盖的 lastRequestContext
          const originalCtx = requestContextMap.get(message.messageId) || lastRequestContext;
          if (!originalCtx) {
            postToWebView({ type: 'error', message: '无法继续：缺少原始上下文' });
            break;
          }
          // 找到对应的 assistant 消息内容（最近一条 incomplete 的）
          // 这里依赖 webview 传过来的 continueFromContent（被截断的最终内容）
          const continueFromContent = message.continueFromContent || '';
          await processMessage(
            originalCtx.text,
            originalCtx.context,
            {
              thinkingEnabled: originalCtx.thinkingEnabled,
              continueFromMessageId: message.messageId,
              continueFromContent,
              continueFromText: originalCtx.text,
            }
          );
          break;
        }
        case 'explainCode': {
          const ctx = message.context || await contextBuilder.buildContext();
          await explainCode(ctx);
          break;
        }
        case 'suggestRefactor': {
          const ctx = message.context || await contextBuilder.buildContext();
          await suggestRefactor(ctx);
          break;
        }
        case 'acceptSuggestion': {
          await acceptAndApplySuggestion(message.suggestionId);
          break;
        }
        case 'rejectSuggestion': {
          const s = suggestionGenerator.rejectSuggestion(message.suggestionId);
          if (s) {
            postToWebView({ type: 'suggestionStatus', suggestionId: message.suggestionId, status: 'rejected' });
          }
          break;
        }
        case 'previewDiff': {
          previewDiff(message.suggestionId);
          break;
        }
        case 'openDiffInEditor': {
          // 在 IDE 代码编辑区域打开 diff 对比 tab（纯内存内容，不依赖磁盘文件）
          try {
            await contextBuilder.rpc.request('editor.openDiff', {
              filePath: message.filePath,
              original: message.original,
              modified: message.modified,
            });
          } catch (err) {
            postToWebView({ type: 'notice', level: 'error', message: `打开对比失败: ${err && err.message ? err.message : err}` });
          }
          break;
        }
        case 'requestConfig': {
          broadcastConfigs();
          break;
        }
        case 'switchConfig': {
          const targetConfig = message.configId && configs.find((c) => c.id === message.configId);
          if (targetConfig) {
            setActiveConfig(targetConfig);
            console.log('[LifeAiCode] 切换到配置:', targetConfig.name || targetConfig.provider);
          }
          break;
        }
        case 'configure': {
          // 单个配置更新（保存时触发）
          const { config } = message;
          if (config) {
            configs = configs.map((c) => c.id === config.id ? config : c);
            if (!configs.find((c) => c.id === config.id)) configs.push(config);
            setActiveConfig(config);
            console.log('[LifeAiCode] 配置已更新:', config.name || config.provider, config.model);
          }
          break;
        }
        case 'updateConfigs': {
          // WebView 拖拽排序后整体替换配置列表
          if (Array.isArray(message.configs)) {
            configs = message.configs.slice();
            if (!configs.find((c) => c.id === activeConfigId)) {
              activeConfigId = configs[0]?.id || '';
            }
            const activeConfig = configs.find((c) => c.id === activeConfigId);
            if (activeConfig) {
              setActiveConfig(activeConfig);
            } else {
              persistConfigs();
              broadcastConfigs();
            }
            console.log('[LifeAiCode] 配置列表已更新顺序:', configs.length);
          }
          break;
        }
        case 'testConnection': {
          const testConfig = message.config;
          try {
            if (!testConfig || (!testConfig.apiKey && testConfig.provider !== 'ollama')) {
              postToWebView({ type: 'connectionTestResult', success: false, message: '请先填写 API Key', configId: testConfig?.id || '' });
              break;
            }
            const testClient = new LlmClient({
              provider: testConfig.provider || 'openai',
              apiKey: testConfig.apiKey || '',
              model: testConfig.model || '',
              baseUrl: testConfig.baseUrl || '',
              timeout: 10000,
            });
            const result = await testClient.chat([{ role: 'user', content: '回复 "ok" 表示连接正常' }]);
            const cleanResult = String(result || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            const preview = cleanResult.slice(0, 30);
            postToWebView({
              type: 'connectionTestResult',
              success: true,
              message: preview ? `✅ 连接成功（模型返回: ${preview}${cleanResult.length > 30 ? '…' : ''}）` : '✅ 连接成功',
              configId: testConfig.id,
            });
          } catch (err) {
            postToWebView({
              type: 'connectionTestResult',
              success: false,
              message: `❌ 连接失败: ${err.message}`,
              configId: testConfig.id,
            });
          }
          break;
        }
        case 'toggleEditMode': {
          // 转发给主应用，由主应用切换 Redux 状态
          if (typeof process !== 'undefined' && process.send) {
            process.send({ jsonrpc: '2.0', method: 'lifeAiCode.toggleEditMode', params: {} });
          }
          break;
        }
        case 'executeShell': {
          console.log('[LifeAiCode][executeShell] received full message:', JSON.stringify(message, null, 2));
          const shellId = message.id || `shell-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
          // 去重：同一 shellId 在 2 秒内重复到达时直接忽略，
          // 避免消息路由重复转发导致同一命令被 spawn 两次
          const now = Date.now();
          const lastSeen = recentShellIds.get(shellId);
          if (lastSeen && (now - lastSeen) < SHELL_DEDUP_MS) {
            console.log('[LifeAiCode][executeShell] duplicate shellId ignored:', shellId);
            break;
          }
          recentShellIds.set(shellId, now);
          // 清理过期的去重条目（避免 Map 无限增长）
          if (recentShellIds.size > 100) {
            for (const [k, ts] of recentShellIds) {
              if (now - ts > SHELL_DEDUP_MS * 5) recentShellIds.delete(k);
            }
          }
          console.log('[LifeAiCode][executeShell] dispatching:', { shellId, shellCommand: message.shellCommand, cwd: message.cwd });
          try {
            // 聊天代码块"执行"按钮：隐藏执行（child_process.spawn）
            // 不创建 IDE 底部终端 tab，输出实时流回聊天占位区域
            executeShellCommand(shellId, message.shellCommand, message.cwd);
          } catch (err) {
            console.error('[LifeAiCode][executeShell] sync throw:', err);
            postToWebView({ type: 'shellUpdate', id: shellId, shellCommand: message.shellCommand || '', output: `执行失败: ${err.message}`, status: 'error' });
          }
          break;
        }
        case 'killShell': {
          // 用户点击"停止"按钮：终止长期运行命令（如 npm run dev），释放子进程资源
          const shellId = message.id;
          if (!shellId) {
            console.warn('[LifeAiCode][killShell] missing id');
            break;
          }
          try {
            const killed = killShellCommand(shellId);
            console.log('[LifeAiCode][killShell] result:', killed, 'id:', shellId);
          } catch (err) {
            console.error('[LifeAiCode][killShell] error:', err);
          }
          break;
        }
        case 'cancelAgent':
        case 'abortGeneration': {
          if (agentRuntime) {
            agentRuntime.cancel();
            // agentRuntime.cancel() 内部会通过 AbortController 把信号传给 LLM client
            postToWebView({ type: 'agentStatus', status: 'cancelled', message: 'Agent 任务已取消' });
          } else if (llmClient) {
            // 普通模式：直接中止 LLM 请求
            llmClient.abort();
          }
          break;
        }
        case 'confirmAgentEdit': {
          const edit = pendingAgentEdits.get(message.editId);
          if (!edit) {
            postToWebView({ type: 'error', message: '未找到待确认的编辑' });
            break;
          }
          const params = edit.mode === 'write'
            ? { filePath: edit.filePath, content: edit.modified }
            : { filePath: edit.filePath, original: [edit.original], modified: [edit.modified] };
          // B3: 原 if (process.send) 条件不成立时静默跳过，导致 pendingAgentEdit 永远挂起、
          // 前端 DiffConfirmDialog 永远收不到 agentEditStatus 反馈（用户点"接受"无反应）。
          // 改为：process.send 不可用时也清理 pending 并回 error，让前端能关闭弹窗。
          if (typeof process !== 'undefined' && process.send) {
            process.send({
              jsonrpc: '2.0',
              method: 'lifeAiCode.applyChanges',
              params,
            });
            pendingAgentEdits.delete(message.editId);
            postToWebView({ type: 'agentEditStatus', editId: message.editId, status: 'applied' });
          } else {
            pendingAgentEdits.delete(message.editId);
            postToWebView({ type: 'error', message: '应用编辑失败：Extension Host 未连接到主进程' });
            postToWebView({ type: 'agentEditStatus', editId: message.editId, status: 'error' });
          }
          break;
        }
        case 'rejectAgentEdit': {
          pendingAgentEdits.delete(message.editId);
          postToWebView({ type: 'agentEditStatus', editId: message.editId, status: 'rejected' });
          break;
        }
        default:
          console.warn('[LifeAiCode] 未知 WebView 命令:', message.command);
      }
    } catch (err) {
      console.error('[LifeAiCode] 处理 WebView 消息失败:', err.message);
      try {
        postToWebView({ type: 'error', message: err.message });
      } catch { /* ignore */ }
    }
  });

  // 清理
  context.subscriptions.push({
    dispose: () => {
      if (panel) {
        try { panel.dispose(); } catch { /* ignore */ }
        panel = null;
      }
      llmClient = null;
      contextBuilder = null;
      suggestionGenerator = null;
      agentRuntime = null;
      pendingAgentEdits.clear();
    },
  });

  console.log('[LifeAiCode] 扩展初始化完成');
}

function deactivate() {
  console.log('[LifeAiCode] 扩展已停用');
  // 清理所有活跃子进程，防止扩展卸载后残留 zombie 进程占用 CPU/内存
  if (activeProcs.size > 0) {
    console.log('[LifeAiCode] deactivate: cleaning up', activeProcs.size, 'active shell procs');
    for (const [id, entry] of activeProcs) {
      try {
        if (entry.flushTimer) clearInterval(entry.flushTimer);
        if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
        if (entry.proc && !entry.finished) {
          try { entry.proc.kill('SIGTERM'); } catch { /* ignore */ }
          // 同步 SIGKILL 兜底（进程即将退出，不等 2 秒）
          setTimeout(() => {
            try { entry.proc.kill('SIGKILL'); } catch { /* ignore */ }
          }, 500);
        }
      } catch { /* ignore */ }
    }
    activeProcs.clear();
  }
  if (panel) {
    try { panel.dispose(); } catch { /* ignore */ }
    panel = null;
  }
  llmClient = null;
  contextBuilder = null;
  suggestionGenerator = null;
}

module.exports = { activate, deactivate };
