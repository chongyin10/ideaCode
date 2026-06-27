/**
 * TypeScript Language Server (LSP) 管理器
 *
 * 使用 typescript-language-server (npm) 替代原始 tsserver，
 * 通过标准 LSP JSON-RPC 协议通信，提供完整的 TypeScript 语言支持。
 */
const { spawn } = require('child_process');
const { ipcMain } = require('electron');
const { Channels } = require('../../shared/channels.cjs');
const { SEMANTIC_TOKEN_TYPES, SEMANTIC_TOKEN_MODIFIERS } = require('../../shared/semanticTokensLegend.cjs');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');

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
  const cliPath = path.join(
    process.cwd(),
    'node_modules',
    'typescript-language-server',
    'lib',
    'cli.mjs',
  );
  serverProcess = spawn(process.execPath, [cliPath, '--stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
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
