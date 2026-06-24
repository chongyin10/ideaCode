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

/* ─── 全局状态 ─── */

let llmClient = null;
let contextBuilder = null;
let suggestionGenerator = null;
let panel = null;
let isProcessing = false;
let configs = [];          // 所有配置
let activeConfigId = null; // 当前激活配置 ID

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
 * 执行 <shell> 命令：启动临时终端，任务结束后自动销毁
 */
async function executeShellCommand(id, shellCommand, cwd) {
  const isWindows = process.platform === 'win32';
  const executable = isWindows ? 'cmd.exe' : '/bin/sh';
  const args = isWindows ? ['/c', shellCommand] : ['-c', shellCommand];

  let workingDir = cwd || process.cwd();
  if (!workingDir || !fs.existsSync(workingDir)) {
    workingDir = os.homedir();
  }

  let terminal;
  try {
    terminal = await vscode.window.createTerminal({
      name: 'LifeAiCode Shell',
      cwd: workingDir,
      executable,
      args,
    });
  } catch (err) {
    postToWebView({ type: 'shellUpdate', id, shellCommand, output: `创建终端失败: ${err.message}`, status: 'error' });
    return;
  }

  terminal.show();

  const outputs = [];
  let finished = false;
  const maxOutput = 8192;

  const flushOutput = (status) => {
    const output = outputs.join('').slice(-maxOutput);
    postToWebView({ type: 'shellUpdate', id, shellCommand, output, status });
  };

  const unsubOutput = terminal.onDidWriteData((data) => {
    outputs.push(data);
    if (outputs.length > 200) {
      outputs.splice(0, outputs.length - 200);
    }
  });

  // 运行期间每 300ms 推送一次输出，让用户看到实时进度
  const timer = setInterval(() => {
    if (!finished) flushOutput('running');
  }, 300);

  terminal.onDidClose((exitCode) => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    unsubOutput();
    const status = exitCode === 0 || exitCode === undefined ? 'success' : 'error';
    flushOutput(status);
    try { terminal.dispose(); } catch { /* ignore */ }
  });

  // 兜底：30 秒后强制结束
  setTimeout(() => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    unsubOutput();
    flushOutput('error');
    try { terminal.dispose(); } catch { /* ignore */ }
  }, 30000);
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
  console.log('[LifeAiCode] LLM 客户端已初始化, provider:', llmClient.provider, 'model:', llmClient.model, 'baseUrl:', llmClient.baseUrl);
}

/**
 * 发送消息到 LLM 并获取建议
 */
async function processMessage(text, context, options = {}) {
  if (isProcessing) return;
  isProcessing = true;

  const { thinkingEnabled } = options || {};
  const msgId = generateId();
  console.log('[LifeAiCode] 处理用户消息:', text.slice(0, 60), 'thinkingEnabled:', thinkingEnabled);

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

    // 3. 构建 LLM 提示词
    const contextStr = contextBuilder.formatContextForPrompt(context);
    const userMessage = contextStr
      ? `## 用户问题\n${text}\n\n## 代码上下文\n${contextStr}`
      : text;

    // 3.5 把 IDE 自动读取的文件以步骤形式展示出来
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

    const messages = [
      { role: 'user', content: userMessage },
    ];

    // 4. 先发空消息让 WebView 显示 loading
    postToWebView({
      type: 'chatResponse',
      id: msgId,
      content: '',
      done: false,
    });

    // 5. 调用 LLM（先尝试流式，失败回退非流式）
    let fullResponse = '';
    try {
      // 避免多次对话后 token 监听器累积
      llmClient.removeAllListeners('token');
      llmClient.on('token', (token) => {
        fullResponse += token;
        // 实时推送流式内容
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
      fullResponse = await llmClient.chat(messages);
    }

    console.log('[LifeAiCode] LLM 响应长度:', fullResponse.length, '字符');

    // 6. 发送完整响应（如果为空，给出友好提示）
    postToWebView({
      type: 'chatResponse',
      id: msgId,
      content: fullResponse || '⚠️ AI 未返回任何内容。请检查：\n1. 模型名称是否正确\n2. API Key 是否有效\n3. Provider / Base URL 是否匹配',
      done: true,
    });

    // 7. 解析建议
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
      vscode.window.showInformationMessage('LifeAiCode: 建议已应用');
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
          await processMessage(message.text, ctx, { thinkingEnabled: message.thinkingEnabled });
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
          const shellId = message.id || `shell-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
          executeShellCommand(shellId, message.shellCommand, message.cwd);
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
