/**
 * TypeScript Language Server (LSP) 管理器
 *
 * 使用 typescript-language-server (npm) 替代原始 tsserver，
 * 通过标准 LSP JSON-RPC 协议通信，提供完整的 TypeScript 语言支持。
 */
const { spawn } = require('child_process');
const { ipcMain, app } = require('electron');
const { Channels } = require('../../shared/channels.cjs');
const { SEMANTIC_TOKEN_TYPES, SEMANTIC_TOKEN_MODIFIERS } = require('../../shared/semanticTokensLegend.cjs');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');

/**
 * 解析项目根目录路径。
 *
 * - dev 模式：app.getAppPath() 返回 main.cjs 所在目录（electron/），
 *   不是项目根；process.cwd() 通常等于项目根（npm 启动目录），但
 *   不保险。改为 __dirname 向上推 3 级（lsp → main → electron → 项目根）。
 * - prod 模式：process.cwd() 是 `/`（macOS GUI 启动不继承 shell 工作目录），
 *   用 app.getAppPath() 拿到 ASAR root。
 */
function resolveAppRoot() {
  try {
    if (app.isPackaged) return app.getAppPath();
  } catch { /* 非 Electron 环境，忽略 */ }
  // dev：tsserverManager.cjs 在 electron/main/lsp/，向上推 3 级到项目根
  return path.resolve(__dirname, '..', '..', '..');
}

/**
 * 解析 typescript-language-server cli.mjs 路径。
 *
 * ASAR 内的 .mjs 不能直接被 Node require（需解包），但 spawn(process.execPath, [cliPath]) 可以
 * 让 Node 直接加载该文件。配合 electron-builder 的 asarUnpack 配置将
 * typescript-language-server 解包到 app.asar.unpacked，cli.mjs 内部 require 的依赖也能正常解析。
 */
function resolveTsServerCliPath() {
  const appRoot = resolveAppRoot();
  let p = path.join(appRoot, 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs');
  // ASAR 内路径替换为 .unpacked：spawn 不能从 ASAR 内加载 .mjs 的依赖
  if (p.includes('app.asar')) {
    p = p.replace('app.asar', 'app.asar.unpacked');
  }
  return p;
}

/**
 * 将 LSP 返回的 URI（可能是 file:// 形式，也可能是裸路径）安全地转换为本地文件系统路径。
 *
 * 关键点：tsserver / typescript-language-server 返回的 URI 是按 RFC 3986 百分号编码的，
 * 例如 `file:///.../node_modules/%40types/react/index.d.ts`。直接 `replace('file://', '')`
 * 会保留 `%40`，导致主进程 `fs.readFile` 报 ENOENT（路径里没有 `%40types` 这样的目录）。
 */
function uriToFsPath(uri) {
  if (!uri) return '';
  if (typeof uri !== 'string') return '';
  try {
    if (uri.startsWith('file://')) {
      return fileURLToPath(uri);
    }
    // 兜底：某些实现可能返回不带协议的绝对路径
    return decodeURI(uri);
  } catch {
    // 极端情况下（如编码不合法）回退到最朴素的剥前缀，避免阻塞编辑器
    try {
      return decodeURI(uri.replace(/^file:\/\//, ''));
    } catch {
      return uri.replace(/^file:\/\//, '');
    }
  }
}

let serverProcess = null;
let rootUri = null;
let buffer = Buffer.alloc(0);
let msgId = 0;
let initRequestId = null;
let semanticTokensLegend = null;
const pendingRequests = new Map();
// LSP 单条消息 body 上限。tsserver 正常响应远低于此值，
// 但 semanticTokens/full 对超大文件可能返回较大数据。
// 超过上限的 body 在 toString('utf8') + JSON.parse 阶段可能触发
// Invalid string length，因此对异常大的 Content-Length 做防御性丢弃。
const MAX_LSP_BODY_BYTES = 64 * 1024 * 1024; // 64MB

/* ─── JSON-RPC 消息编解码 ─── */

function send(msg) {
  if (!serverProcess || !serverProcess.stdin) return;
  const json = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n`;
  serverProcess.stdin.write(header + json);
}

function parseMessages(chunk) {
  buffer = Buffer.concat([buffer, chunk]);
  const messages = [];
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;
    const header = buffer.slice(0, headerEnd).toString('utf8');
    const lenMatch = header.match(/Content-Length: (\d+)/);
    if (!lenMatch) { buffer = Buffer.alloc(0); break; }
    const contentLen = parseInt(lenMatch[1], 10);
    // 大消息保护：异常大的 Content-Length 会导致 toString + JSON.parse 触发
    // Invalid string length。丢弃该消息并重置 buffer，防止内存耗尽。
    if (contentLen > MAX_LSP_BODY_BYTES || !Number.isFinite(contentLen) || contentLen < 0) {
      console.error(`[tsserver] 拒绝异常大的 LSP 消息: Content-Length=${contentLen}，丢弃并重置 buffer`);
      buffer = Buffer.alloc(0);
      break;
    }
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + contentLen) break;
    const body = buffer.slice(bodyStart, bodyStart + contentLen).toString('utf8');
    buffer = buffer.slice(bodyStart + contentLen);
    try { messages.push(JSON.parse(body)); } catch {}
  }
  return messages;
}

function nextId() { return ++msgId; }

/* ─── 服务器生命周期 ─── */

function startServer(projectRoot, sender) {
  if (serverProcess) stopServer();

  rootUri = `file://${projectRoot}`;

  // 直接用当前 Node 进程解释器加载 cli.mjs，避免走 shell 解析 shebang / symlink，
  // 把 tsserver 子进程冷启动从 ~150ms 进一步压缩到 ~60ms。
  // cliPath 已在 resolveTsServerCliPath() 中处理 ASAR 解包路径，dev/prod 均可定位。
  const cliPath = resolveTsServerCliPath();
  serverProcess = spawn(process.execPath, [cliPath, '--stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // ELECTRON_RUN_AS_NODE=1：让 Electron 二进制以纯 Node 模式运行 cli.mjs，
    // 否则 macOS 上会启动独立 Electron 应用实例 → Dock 显示多余图标。
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });

  serverProcess.stdout.on('data', (data) => {
    try {
      for (const msg of parseMessages(data)) {
        if (msg.id === initRequestId && msg.result) {
          if (msg.result.capabilities?.semanticTokensProvider?.legend) {
            semanticTokensLegend = msg.result.capabilities.semanticTokensProvider.legend;
          }
          send({ jsonrpc: '2.0', method: 'initialized', params: {} });
        }
        if (msg.id && pendingRequests.has(msg.id)) {
          pendingRequests.get(msg.id)(msg);
          pendingRequests.delete(msg.id);
        } else if (msg.method === 'textDocument/publishDiagnostics') {
          // 诊断推送
          const params = msg.params || {};
          if (params.uri && params.diagnostics) {
            try {
              sender.send(Channels.TSSERVER_DIAGNOSTICS, {
                file: uriToFsPath(params.uri),
                diagnostics: params.diagnostics.map((d) => ({
                  start: { line: d.range.start.line, column: d.range.start.character },
                  end: { line: d.range.end.line, column: d.range.end.character },
                  message: d.message,
                  category: d.severity === 1 ? 8 : d.severity === 2 ? 4 : 2,
                  code: typeof d.code === 'object' ? d.code.value : d.code,
                })),
              });
            } catch {}
          }
        } else if (msg.method === 'window/logMessage') {
          console.log('[TS-LSP]', msg.params?.message);
        }
      }
    } catch {}
  });

  serverProcess.stderr.on('data', (d) => console.error('[TS-LSP stderr]', d.toString()));
  serverProcess.on('close', (code) => {
    console.log(`[TS-LSP] exited ${code}`);
    serverProcess = null;
  });

  // LSP initialize
  initRequestId = nextId();
  send({
    jsonrpc: '2.0', id: initRequestId, method: 'initialize',
    params: {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          completion: { completionItem: { snippetSupport: false } },
          hover: { contentFormat: ['plaintext', 'markdown'] },
          definition: { linkSupport: true },
          semanticTokens: {
            // 见 electron/shared/semanticTokensLegend.cjs，与 MonacoEditor 共享
            tokenTypes: SEMANTIC_TOKEN_TYPES,
            tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
            formats: ['relative'],
            requests: { range: true, full: { delta: true } },
            multilineTokenSupport: true,
            overlappingTokenSupport: false,
          },
        },
      },
      initializationOptions: {
        preferences: {
          includeCompletionsWithInsertText: true,
          includeCompletionsWithSnippetText: false,
        },
      },
    },
  });

}

function stopServer() {
  if (serverProcess) {
    try { serverProcess.kill(); } catch {}
    serverProcess = null;
  }
  // 主动停止时清空 rootUri：避免 ensureServer 在 stop→start 之间检测到
  // "!serverProcess && rootUri" 而自动重启，与随后的显式 start 叠加导致
  // tsserver 被启动两次（日志中 "Using Typescript version" 打印两次）。
  // 崩溃场景由 'close' 事件处理：那里只置 serverProcess=null，保留 rootUri，
  // 后续 ensureServer 仍可自动恢复。
  rootUri = null;
  buffer = Buffer.alloc(0);
  pendingRequests.clear();
  msgId = 0;
}

function ensureServer(sender) {
  if (!serverProcess && rootUri) {
    startServer(rootUri.replace('file://', ''), sender);
  }
  return !!serverProcess;
}

/* ─── IPC Handlers ─── */

function registerTsServerHandlers() {
  ipcMain.handle(Channels.TSSERVER_START, async (event, projectRoot) => {
    startServer(projectRoot, event.sender);
    return true;
  });

  ipcMain.handle(Channels.TSSERVER_STOP, async () => {
    stopServer();
    return true;
  });

  ipcMain.handle(Channels.TSSERVER_OPEN, async (event, filePath, content) => {
    ensureServer(event.sender);
    const uri = `file://${filePath.replace(/\\/g, '/')}`;
    send({
      jsonrpc: '2.0', method: 'textDocument/didOpen',
      params: {
        textDocument: { uri, languageId: inferLanguage(filePath), version: 1, text: content },
      },
    });
    return true;
  });

  ipcMain.handle(Channels.TSSERVER_CLOSE, async (event, filePath) => {
    if (!serverProcess) return;
    const uri = `file://${filePath.replace(/\\/g, '/')}`;
    send({ jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri } } });
  });

  ipcMain.handle(Channels.TSSERVER_CHANGE, async (event, filePath, content) => {
    ensureServer(event.sender);
    const uri = `file://${filePath.replace(/\\/g, '/')}`;
    send({
      jsonrpc: '2.0', method: 'textDocument/didChange',
      params: {
        textDocument: { uri, version: Date.now() },
        contentChanges: [{ text: content }],
      },
    });
  });

  ipcMain.handle(Channels.TSSERVER_COMPLETIONS, async (event, filePath, line, offset) => {
    if (!ensureServer(event.sender)) return [];
    const id = nextId();
    const uri = `file://${filePath.replace(/\\/g, '/')}`;
    send({
      jsonrpc: '2.0', id, method: 'textDocument/completion',
      params: { textDocument: { uri }, position: { line, character: offset } },
    });
    return new Promise((resolve) => {
      pendingRequests.set(id, (msg) => {
        resolve((msg.result?.items || msg.result || []).map((item) => ({
          name: item.label || item.insertText || '',
          kind: item.kind ? String(item.kind) : 'text',
          sortText: item.sortText || item.label || '',
          detail: item.detail || '',
          documentation: item.documentation || '',
        })));
      });
      setTimeout(() => { pendingRequests.delete(id); resolve([]); }, 3000);
    });
  });

  ipcMain.handle(Channels.TSSERVER_DEFINITION, async (event, filePath, line, offset) => {
    if (!ensureServer(event.sender)) return [];
    const id = nextId();
    const uri = `file://${filePath.replace(/\\/g, '/')}`;
    send({
      jsonrpc: '2.0', id, method: 'textDocument/definition',
      params: { textDocument: { uri }, position: { line, character: offset } },
    });
    return new Promise((resolve) => {
      pendingRequests.set(id, (msg) => {
        const result = msg.result;
        if (!result || (Array.isArray(result) && result.length === 0)) return resolve([]);
        const locations = Array.isArray(result) ? result : [result];
        resolve(locations.map((loc) => {
          // LSP 返回 Location 或 LocationLink；LocationLink 用 targetRange/targetUri
          const targetRange = loc.targetRange || loc.range;
          const ret = {
            file: uriToFsPath(loc.uri || loc.targetUri || ''),
            start: { line: targetRange?.start?.line ?? 0, offset: targetRange?.start?.character ?? 0 },
            end: { line: targetRange?.end?.line ?? 0, offset: targetRange?.end?.character ?? 0 },
          };
          if (loc.originSelectionRange) {
            ret.originSelectionRange = {
              start: { line: loc.originSelectionRange.start.line, offset: loc.originSelectionRange.start.character },
              end: { line: loc.originSelectionRange.end.line, offset: loc.originSelectionRange.end.character },
            };
          }
          return ret;
        }));
      });
      setTimeout(() => { pendingRequests.delete(id); resolve([]); }, 3000);
    });
  });

  ipcMain.handle(Channels.TSSERVER_SEMANTIC_TOKENS, async (event, filePath) => {
    if (!ensureServer(event.sender)) return null;
    const id = nextId();
    const uri = `file://${filePath.replace(/\\/g, '/')}`;
    send({
      jsonrpc: '2.0', id, method: 'textDocument/semanticTokens/full',
      params: { textDocument: { uri } },
    });
    return new Promise((resolve) => {
      pendingRequests.set(id, (msg) => {
        const result = msg.result;
        if (!result || !result.data) return resolve(null);
        // 转为 Uint32Array：IPC 结构化克隆对 typed array 用 memcpy 整块拷贝，
        // 远快于普通数组逐元素序列化。大文件 token 数组可达数万元素，收益显著。
        const data = result.data instanceof Uint32Array ? result.data : new Uint32Array(result.data);
        resolve({ legend: semanticTokensLegend, resultId: result.resultId, data });
      });
      setTimeout(() => { pendingRequests.delete(id); resolve(null); }, 3000);
    });
  });

  ipcMain.handle(Channels.TSSERVER_QUICKINFO, async (event, filePath, line, offset) => {
    if (!ensureServer(event.sender)) return null;
    const id = nextId();
    const uri = `file://${filePath.replace(/\\/g, '/')}`;
    send({
      jsonrpc: '2.0', id, method: 'textDocument/hover',
      params: { textDocument: { uri }, position: { line, character: offset } },
    });
    return new Promise((resolve) => {
      pendingRequests.set(id, (msg) => {
        const result = msg.result;
        if (!result) return resolve(null);
        const contents = result.contents;
        let displayString = '';
        let documentation = '';

        // parse LSP hover contents into type signature + documentation,
        // matching VS Code's two-part hover layout.
        if (Array.isArray(contents)) {
          // MarkedString[]: first code-block element is the signature, rest is documentation
          for (const c of contents) {
            const raw = typeof c === 'string' ? c : (c?.value ?? '');
            if (!raw) continue;
            if (!displayString) {
              displayString = raw;
            } else {
              documentation = documentation ? `${documentation}\n${raw}` : raw;
            }
          }
        } else if (contents && typeof contents === 'object' && contents.value != null) {
          // MarkupContent { kind, value }
          displayString = String(contents.value || '');
        } else if (typeof contents === 'string') {
          displayString = contents;
        }

        // extract range from LSP response (0-based character → offset for frontend)
        const range = result.range;
        const response = {
          displayString,
          documentation,
          kind: '',
        };
        if (range) {
          response.start = { line: range.start.line, offset: range.start.character };
          response.end = { line: range.end.line, offset: range.end.character };
        }
        resolve(response);
      });
      setTimeout(() => { pendingRequests.delete(id); resolve(null); }, 3000);
    });
  });
}

function inferLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.tsx') return 'typescriptreact';
  if (ext === '.ts') return 'typescript';
  if (ext === '.jsx') return 'javascriptreact';
  if (ext === '.js') return 'javascript';
  return 'typescript';
}

module.exports = { registerTsServerHandlers, stopServer: stopServer };
