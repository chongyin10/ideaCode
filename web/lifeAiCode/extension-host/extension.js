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
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      windowsHide: true,
    });
    console.log('[LifeAiCode][executeShellCommand] spawned pid:', proc.pid);
  } catch (err) {
    console.error('[LifeAiCode][executeShellCommand] spawn failed:', err);
    postToWebView({
      type: 'shellUpdate',
      id, shellCommand,
      output: `执行失败: ${err.message}`,
      status: 'error',
    });
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

  const entry = { proc, finished: false, cwd: workingDir, buffers: { stdout: '', stderr: '' } };
  activeProcs.set(id, entry);

  // 推一条 "running" 启动事件（带 cwd + 命令）
  postToWebView({
    type: 'shellUpdate',
    id, shellCommand,
    output: `$ ${shellCommand}\n[工作目录] ${workingDir}\n\n`,
    status: 'running',
  });

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

  proc.stdout.on('data', (chunk) => {
    entry.buffers.stdout += chunk.toString('utf8');
    if (entry.buffers.stdout.length > MAX_LINE_BUFFER) flush('running');
  });

  proc.stderr.on('data', (chunk) => {
    entry.buffers.stderr += chunk.toString('utf8');
    if (entry.buffers.stderr.length > MAX_LINE_BUFFER) flush('running');
  });

  proc.on('error', (err) => {
    entry.buffers.stdout += `\n[进程错误] ${err.message}\n`;
  });

  proc.on('close', (code, signal) => {
    if (entry.finished) return;
    entry.finished = true;
    clearInterval(flushTimer);
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
    activeProcs.delete(id);
  });

  // 兜底超时
  setTimeout(() => {
    if (entry.finished) return;
    entry.buffers.stdout += `\n[超时] 命令执行超过 5 分钟，已强制终止。\n`;
    flush('error');
    try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }, 2000);
  }, DEFAULT_TIMEOUT_MS);
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
/** 维护最近一次请求的上下文，用于 continue 继续生成 */
let lastRequestContext = null;

async function processMessage(text, context, options = {}) {
  if (isProcessing) return;
  isProcessing = true;

  const { thinkingEnabled, continueFromMessageId, continueFromContent, continueFromText } = options || {};
  const msgId = continueFromMessageId || generateId();
  console.log('[LifeAiCode] 处理用户消息:', text.slice(0, 60), 'thinkingEnabled:', thinkingEnabled, 'continue:', !!continueFromMessageId);

  // 记录上下文以便 continue 使用
  lastRequestContext = { text, context, thinkingEnabled };

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
      messages = [{ role: 'user', content: userMessage }];
    }

    // 4. 调用 LLM（先尝试流式，失败回退非流式）
    let fullResponse = '';
    try {
      // 避免多次对话后 token 监听器累积
      llmClient.removeAllListeners('token');
      llmClient.on('token', (token) => {
        // continue 模式下，token 是续写部分，需要追加到原 content 上
        if (continueFromContent) {
          fullResponse = continueFromContent + token;
        } else {
          fullResponse += token;
        }
        postToWebView({
          type: 'chatResponse',
          id: msgId,
          content: fullResponse,
          done: false,
        });
      });
      fullResponse = await llmClient.chatStream(messages);
    } catch (streamErr) {
      console.warn('[LifeAiCode] 流式请求失败, 回退到非流式:', streamErr.message);
      const resp = await llmClient.chat(messages);
      fullResponse = continueFromContent ? continueFromContent + resp : resp;
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
    console.error('[LifeAiCode] LLM 请求失败:', err.message);
    postToWebView({
      type: 'chatResponse',
      id: msgId,
      content: `❌ **错误**: ${err.message}\n\n请检查:\n1. API Key 是否正确配置\n2. 网络连接是否正常\n3. Provider 服务是否可用`,
      done: true,
    });
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
  console.log('[LifeAiCode][Agent] 开始任务:', text.slice(0, 60));

  try {
    if (!agentRuntime) {
      throw new Error('Agent 运行时未初始化');
    }

    postToWebView({
      type: 'agentStatus',
      status: 'running',
      message: 'Agent 开始执行任务...',
    });

    let streamedContent = '';
    const finalResponse = await agentRuntime.run(text, context, {
      onToken: (token) => {
        // 实时推送内容到 WebView，过滤 prompt-based 模式下可能混入的 <tool_call> 标签
        streamedContent += token;
        const displayContent = streamedContent.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
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

    const displayContent = (streamedContent || finalResponse || '').replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
    postToWebView({
      type: 'chatResponse',
      id: msgId,
      content: displayContent || '任务已完成，但没有返回内容。',
      done: true,
    });
  } catch (err) {
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
        for (const change of changes) {
          if (!newContent.includes(change.original)) {
            console.warn('[LifeAiCode] 原始代码未找到，跳过:', filePath);
            continue;
          }
          newContent = newContent.replace(change.original, change.modified);
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
              original: changes.map((c) => c.original),
              modified: changes.map((c) => c.modified),
            },
          });
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
    registerPendingEdit: (editId, edit) => {
      pendingAgentEdits.set(editId, edit);
    },
  });
  try {
    const auditPath = path.join(context.extensionPath, '.lifeAiCode-agent-audit.log');
    agentRuntime.auditLogger.setLogPath(auditPath);
    console.log('[LifeAiCode] Agent 审计日志:', auditPath);
  } catch { /* ignore */ }

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
        postToWebView({
          type: 'connectionTestResult',
          success: true,
          message: `连接成功！响应: ${result.slice(0, 100)}`,
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
            await runAgentTask(message.text, ctx);
          } else {
            await processMessage(message.text, ctx, { thinkingEnabled: message.thinkingEnabled });
          }
          break;
        }
        case 'continueMessage': {
          // 继续被截断的回答
          if (!lastRequestContext) {
            postToWebView({ type: 'error', message: '无法继续：缺少原始上下文' });
            break;
          }
          // 找到对应的 assistant 消息内容（最近一条 incomplete 的）
          // 这里依赖 webview 传过来的 continueFromContent（被截断的最终内容）
          const continueFromContent = message.continueFromContent || '';
          await processMessage(
            lastRequestContext.text,
            lastRequestContext.context,
            {
              thinkingEnabled: lastRequestContext.thinkingEnabled,
              continueFromMessageId: message.messageId,
              continueFromContent,
              continueFromText: lastRequestContext.text,
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
            postToWebView({
              type: 'connectionTestResult',
              success: true,
              message: `✅ 连接成功！响应: ${result.slice(0, 120)}`,
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
          console.log('[LifeAiCode][executeShell] dispatching:', { shellId, shellCommand: message.shellCommand, cwd: message.cwd });
          try {
            executeShellCommand(shellId, message.shellCommand, message.cwd);
          } catch (err) {
            console.error('[LifeAiCode][executeShell] sync throw:', err);
            postToWebView({ type: 'shellUpdate', id: shellId, shellCommand: message.shellCommand || '', output: `执行失败: ${err.message}`, status: 'error' });
          }
          break;
        }
        case 'cancelAgent': {
          if (agentRuntime) {
            agentRuntime.cancel();
            postToWebView({ type: 'agentStatus', status: 'cancelled', message: 'Agent 任务已取消' });
          }
          break;
        }
        case 'confirmAgentEdit': {
          const edit = pendingAgentEdits.get(message.editId);
          if (!edit) {
            postToWebView({ type: 'error', message: '未找到待确认的编辑' });
            break;
          }
          if (typeof process !== 'undefined' && process.send) {
            const params = edit.mode === 'write'
              ? { filePath: edit.filePath, content: edit.modified }
              : { filePath: edit.filePath, original: [edit.original], modified: [edit.modified] };
            process.send({
              jsonrpc: '2.0',
              method: 'lifeAiCode.applyChanges',
              params,
            });
            pendingAgentEdits.delete(message.editId);
            postToWebView({ type: 'agentEditStatus', editId: message.editId, status: 'applied' });
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
  if (panel) {
    try { panel.dispose(); } catch { /* ignore */ }
    panel = null;
  }
  llmClient = null;
  contextBuilder = null;
  suggestionGenerator = null;
}

module.exports = { activate, deactivate };
