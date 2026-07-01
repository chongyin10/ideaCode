/**
 * IDEACODE SSH 插件入口
 */

const vscode = require('./api');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('ssh2');

const sessions = new Map();
const sshClients = new Map();
let connections = [];
let globalBroadcast = null;

function log(level, ...args) {
  const msg = `[${new Date().toLocaleTimeString()}] ${args.join(' ')}`;
  if (level === 'error') {
    console.error(msg);
  } else {
    console.log(msg);
  }
  if (globalBroadcast) {
    try {
      globalBroadcast({ type: 'sshLog', level, message: msg });
    } catch { /* ignore */ }
  }
}

function generateId() {
  return `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * 尝试读取本地默认 SSH 私钥
 */
function loadDefaultPrivateKey() {
  const home = os.homedir();
  const keyFiles = ['id_rsa', 'id_ed25519', 'id_ecdsa'];
  for (const file of keyFiles) {
    const keyPath = path.join(home, '.ssh', file);
    try {
      const key = fs.readFileSync(keyPath, 'utf-8');
      if (key.includes('PRIVATE KEY')) {
        console.log('[SSH Extension] 使用本地默认私钥:', keyPath);
        return key;
      }
    } catch {
      // ignore missing key
    }
  }
  return null;
}

/**
 * 读取 WebView 构建后的 HTML 文件，并将资源内联
 * @param {string} extensionPath
 * @param {object} [popupSession] 如果传入，会在页面中注入弹窗会话数据
 */
function getWebviewHtml(extensionPath, popupSession) {
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

    // 如果是弹窗模式，注入会话数据供前端读取
    if (popupSession) {
      const inject = `<script>window.__sshPopupSession = ${JSON.stringify(popupSession).replace(/</g, '\\u003c')}</script>`;
      html = html.replace('</head>', `${inject}</head>`);
    }

    return html;
  } catch (err) {
    console.error('[SSH Extension] 读取 WebView HTML 失败:', err.message);
    return `<html><body style="color:#fff;background:#1e1e1e;padding:20px;"><h1>SSH 远程连接</h1><p>WebView 资源未找到，请运行 <code>cd web/ssh && npm run build</code></p></body></html>`;
  }
}

function attemptConnect(id, connConfig, password) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    sshClients.set(id, client);

    client.on('ready', () => {
      log('log', '[SSH Extension] 连接成功:', connConfig.host);
      resolve({ success: true });
    });

    client.on('error', (err) => {
      log('error', '[SSH Extension] 连接失败:', connConfig.host, err.message);
      try { client.end(); } catch { /* ignore */ }
      if (sshClients.get(id) === client) {
        sshClients.delete(id);
      }
      reject(err);
    });

    client.on('close', () => {
      log('log', '[SSH Extension] 连接关闭:', connConfig.host, 'session:', id);
      if (sshClients.get(id) === client) {
        sshClients.delete(id);
      }
    });

    client.on('keyboard-interactive', (name, instructions, instructionsLang, prompts, finish) => {
      if (password && prompts.length > 0) {
        finish([password]);
      } else {
        finish([]);
      }
    });

    try {
      client.connect(connConfig);
    } catch (err) {
      log('error', '[SSH Extension] 连接异常:', err.message);
      if (sshClients.get(id) === client) {
        sshClients.delete(id);
      }
      reject(err);
    }
  });
}

/**
 * 注册 SSH 内部命令处理器
 */
function registerSshCommands() {
  vscode.commands.registerCommand('ssh.internal.connect', async (config) => {
    const { id, host, port, username, password, privateKey } = config;
    log('log', '[SSH Extension] 开始连接:', host, port, username);

    const baseConfig = {
      host,
      port: port || 22,
      username,
      readyTimeout: 20000,
      keepaliveInterval: 30000,
      keepaliveCountMax: 3,
    };

    // 1. 显式私钥
    if (privateKey) {
      try {
        return await attemptConnect(id, { ...baseConfig, privateKey }, password);
      } catch (err) {
        return { success: false, error: err.message };
      }
    }

    // 2. 显式密码
    if (password) {
      try {
        return await attemptConnect(id, { ...baseConfig, password }, password);
      } catch (err) {
        return { success: false, error: err.message };
      }
    }

    // 3. 未提供认证信息：先尝试 ssh-agent，失败再尝试本地默认私钥
    const agentSock = process.env.SSH_AUTH_SOCK;
    if (agentSock) {
      console.log('[SSH Extension] 尝试 ssh-agent:', agentSock);
      try {
        return await attemptConnect(id, { ...baseConfig, agent: agentSock }, password);
      } catch (err) {
        console.log('[SSH Extension] ssh-agent 认证失败，尝试本地默认私钥:', err.message);
      }
    }

    const defaultKey = loadDefaultPrivateKey();
    if (defaultKey) {
      console.log('[SSH Extension] 尝试本地默认私钥');
      try {
        return await attemptConnect(id, { ...baseConfig, privateKey: defaultKey }, password);
      } catch (err) {
        return { success: false, error: err.message };
      }
    }

    return { success: false, error: '未配置认证信息，也未找到可用的 ssh-agent 或本地默认私钥' };
  });

  vscode.commands.registerCommand('ssh.internal.disconnect', (config) => {
    const { id } = config;
    const client = sshClients.get(id);
    if (client) {
      try { client.end(); } catch { /* ignore */ }
      sshClients.delete(id);
    }
    return { success: true };
  });

  vscode.commands.registerCommand('ssh.internal.execute', (config) => {
    return new Promise((resolve) => {
      const { id, command } = config;
      const client = sshClients.get(id);
      log('log', '[SSH Extension] execute 请求:', id, 'client 存在:', !!client);
      if (!client) {
        log('error', '[SSH Extension] execute 会话不存在:', id, '当前会话:', Array.from(sshClients.keys()));
        return resolve({ success: false, error: '会话不存在或已断开' });
      }

      // 申请伪终端，兼容对普通 exec 通道做了限制的服务器
      client.exec(command, { pty: true }, (err, stream) => {
        if (err) {
          return resolve({ success: false, error: err.message });
        }

        let stdout = '';
        let stderr = '';

        stream.on('close', (code, signal) => {
          const success = code === 0;
          if (!success && !stderr && code !== null) {
            stderr = `命令退出码: ${code}`;
          }
          resolve({ success, stdout, stderr, code, signal });
        });

        stream.on('data', (data) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data) => {
          stderr += data.toString();
        });
      });
    });
  });
}

/**
 * 将 find 输出解析为目录树
 * 输入格式：每行 "type|path"，type 为 d 表示目录，其他表示文件
 */
function buildRemoteTree(lines, explicitRootPath) {
  const entries = [];
  let rootPath = explicitRootPath || '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf('|');
    if (idx < 0) continue;
    const typeChar = trimmed.slice(0, idx);
    const fullPath = trimmed.slice(idx + 1).trim();
    if (!fullPath) continue;
    const type = typeChar === 'd' ? 'directory' : 'file';
    entries.push({ type, fullPath });
    if (!rootPath && type === 'directory') {
      rootPath = fullPath;
    }
  }

  if (!rootPath && entries.length > 0) {
    const parts = entries[0].fullPath.split('/').filter(Boolean);
    parts.pop();
    rootPath = `/${parts.join('/')}`;
  }

  if (!rootPath) {
    return { name: '~', path: '~', type: 'directory', children: [] };
  }

  const rootName = explicitRootPath
    ? (explicitRootPath.split('/').filter(Boolean).pop() || explicitRootPath)
    : '~';
  const root = { name: rootName, path: rootPath, type: 'directory', children: [] };
  const nodeMap = new Map();
  nodeMap.set(rootPath, root);

  entries.sort((a, b) => a.fullPath.length - b.fullPath.length);

  for (const { type, fullPath } of entries) {
    if (fullPath === rootPath) continue;
    const relative = fullPath.startsWith(rootPath + '/')
      ? fullPath.slice(rootPath.length + 1)
      : fullPath.startsWith('/')
        ? fullPath.slice(1)
        : fullPath;
    const parts = relative.split('/').filter(Boolean);
    if (parts.length === 0) continue;

    let parentPath = rootPath;
    for (let i = 0; i < parts.length - 1; i++) {
      parentPath = parentPath + '/' + parts[i];
      if (!nodeMap.has(parentPath)) {
        const parentNode = {
          name: parts[i],
          path: parentPath,
          type: 'directory',
          children: [],
        };
        nodeMap.set(parentPath, parentNode);
        const grandparentPath = parentPath.slice(0, parentPath.lastIndexOf('/'));
        const grandparent = nodeMap.get(grandparentPath);
        if (grandparent) grandparent.children.push(parentNode);
      }
    }

    const name = parts[parts.length - 1];
    const nodePath = parentPath + '/' + name;
    const node = {
      name,
      path: nodePath,
      type,
      children: type === 'directory' ? [] : undefined,
    };
    nodeMap.set(nodePath, node);
    const parent = nodeMap.get(parentPath);
    if (parent) parent.children.push(node);
  }

  sortRemoteTree(root);
  return root;
}

function sortRemoteTree(node) {
  if (!node.children) return;
  node.children.sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    return a.type === 'directory' ? -1 : 1;
  });
  node.children.forEach(sortRemoteTree);
}

function findConnection(connectionId) {
  return connections.find((c) => c.id === connectionId);
}

function getPrompt(session) {
  const cwd = session.cwd || '~';
  if (session.username && session.host) {
    return `${session.username}@${session.host}:${cwd}$`;
  }
  return `${cwd}$`;
}

function resolveCwd(current, target) {
  if (!target) return current;
  if (target.startsWith('/')) return target;
  if (target === '~') return '~';
  if (current === '~') {
    if (target === '..' || target.startsWith('../')) return '~';
    return `~/${target.replace(/^\.\.?\//, '')}`;
  }
  const parts = current.split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return '/' + parts.join('/');
}

function parseSshUri(uri) {
  const match = String(uri).match(/^ssh:\/\/([^/]+)(\/.*)$/);
  if (!match) throw new Error(`无效的 SSH URI: ${uri}`);
  return { connectionId: match[1], path: match[2] || '/' };
}

async function executeOnSession(sessionId, command) {
  return vscode.commands.executeCommand('ssh.internal.execute', { id: sessionId, command });
}

const sshFileSystemProvider = {
  async readDirectory(uri) {
    const { connectionId, path } = parseSshUri(uri);
    const session = findConnectedSession(connectionId);
    if (!session) throw new Error('没有已连接的 SSH 会话');
    const cmd = `find ${shellEscape(path)} -maxdepth 1 -mindepth 1 -exec sh -c 'for p; do if [ -d "$p" ]; then echo "d|$(basename "$p")|$p"; else echo "f|$(basename "$p")|$p"; fi; done' sh {} + 2>/dev/null || true`;
    const result = await executeOnSession(session.id, cmd);
    const entries = [];
    for (const line of (result.stdout || '').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split('|');
      if (parts.length < 3) continue;
      const [typeChar, name, fullPath] = parts;
      entries.push({
        name,
        kind: typeChar === 'd' ? 'directory' : 'file',
        uri: `ssh://${connectionId}${fullPath}`,
      });
    }
    entries.sort((a, b) => {
      if (a.kind === b.kind) return a.name.localeCompare(b.name);
      return a.kind === 'directory' ? -1 : 1;
    });
    return entries;
  },

  async readFile(uri) {
    const { connectionId, path } = parseSshUri(uri);
    const session = findConnectedSession(connectionId);
    if (!session) throw new Error('没有已连接的 SSH 会话');
    const result = await executeOnSession(session.id, `cat ${shellEscape(path)}`);
    if (!result.success) throw new Error(result.error || result.stderr || '读取文件失败');
    return result.stdout;
  },

  async writeFile(uri, content) {
    const { connectionId, path } = parseSshUri(uri);
    const session = findConnectedSession(connectionId);
    if (!session) throw new Error('没有已连接的 SSH 会话');
    const base64 = Buffer.from(content).toString('base64');
    const result = await executeOnSession(session.id, `echo '${base64}' | base64 -d > ${shellEscape(path)}`);
    if (!result.success) throw new Error(result.error || result.stderr || '写入文件失败');
  },

  async createDirectory(uri) {
    const { connectionId, path } = parseSshUri(uri);
    const session = findConnectedSession(connectionId);
    if (!session) throw new Error('没有已连接的 SSH 会话');
    const result = await executeOnSession(session.id, `mkdir -p ${shellEscape(path)}`);
    if (!result.success) throw new Error(result.error || result.stderr || '创建目录失败');
  },

  async delete(uri, options = {}) {
    const { connectionId, path } = parseSshUri(uri);
    const session = findConnectedSession(connectionId);
    if (!session) throw new Error('没有已连接的 SSH 会话');
    const cmd = options.recursive ? `rm -rf ${shellEscape(path)}` : `rm -f ${shellEscape(path)}`;
    const result = await executeOnSession(session.id, cmd);
    if (!result.success) throw new Error(result.error || result.stderr || '删除失败');
  },

  async rename(oldUri, newUri) {
    const oldInfo = parseSshUri(oldUri);
    const newInfo = parseSshUri(newUri);
    if (oldInfo.connectionId !== newInfo.connectionId) {
      throw new Error('不支持跨连接重命名');
    }
    const session = findConnectedSession(oldInfo.connectionId);
    if (!session) throw new Error('没有已连接的 SSH 会话');
    const result = await executeOnSession(
      session.id,
      `mv ${shellEscape(oldInfo.path)} ${shellEscape(newInfo.path)}`
    );
    if (!result.success) throw new Error(result.error || result.stderr || '重命名失败');
  },

  async stat(uri) {
    const { connectionId, path } = parseSshUri(uri);
    const session = findConnectedSession(connectionId);
    if (!session) return null;
    const result = await executeOnSession(
      session.id,
      `if [ -d ${shellEscape(path)} ]; then echo "dir"; elif [ -f ${shellEscape(path)} ]; then stat -c '%s' ${shellEscape(path)} 2>/dev/null || stat -f '%z' ${shellEscape(path)} 2>/dev/null || echo "file"; else echo "none"; fi`
    );
    const out = (result.stdout || '').trim();
    if (out === 'dir') return { isDirectory: true };
    if (out === 'none') return null;
    if (out === 'file') return { isDirectory: false };
    const size = parseInt(out, 10);
    return { isDirectory: false, size: Number.isNaN(size) ? 0 : size };
  },
};

function callFileSystemProvider(scheme, method, args) {
  if (scheme !== 'ssh') throw new Error(`未注册的 scheme: ${scheme}`);
  const fn = sshFileSystemProvider[method];
  if (typeof fn !== 'function') throw new Error(`provider 方法不存在: ${method}`);
  return fn.apply(sshFileSystemProvider, args);
}

function findConnectedSession(connectionId) {
  return Array.from(sessions.values()).find(
    (s) => s.connectionId === connectionId && s.status === 'connected'
  );
}

async function getRemoteFileTree(connectionId, targetPath) {
  const conn = findConnection(connectionId);
  if (!conn) throw new Error('连接不存在');
  const session = findConnectedSession(connectionId);
  if (!session) throw new Error('没有已连接的会话');

  // §需求：getRemoteFileTree 之前用 `find ~ -maxdepth 3 -printf '%y|%p\n'`，在某些
  // 非交互式 shell（pty 模式）下 `~` 不会展开，导致 find 报"找不到 HOME"或
  // 退出码非 0。改用 `${HOME:-/root}` 兜底，且并行列举多级目录以加快响应。
  // 用单引号包住 printf 格式串，避免 shell 提前展开 $ % 等。
  // §支持 targetPath：点击子目录时拉取该目录内容。home 表达式不加引号让 shell 展开 $HOME，
  // 自定义路径用 shellEscape 包裹防注入。
  const useCustomPath = targetPath && targetPath !== '/' && targetPath !== '~';
  const basePath = useCustomPath ? shellEscape(targetPath) : '${HOME:-/root}';
  const maxDepth = useCustomPath ? 2 : 3;
  const findCmd = `find ${basePath} -maxdepth ${maxDepth} -mindepth 1 -printf '%y|%p\\n' 2>/dev/null || true`;

  const result = await vscode.commands.executeCommand('ssh.internal.execute', {
    id: session.id,
    command: findCmd,
  });

  if (!result.success) {
    throw new Error(result.error || '加载目录结构失败');
  }
  if (!result.stdout || !result.stdout.trim()) {
    // 空输出（find 在受限 shell 下完全没回显）——返回空根，不当作失败
    log('warn', '[SSH Extension] getRemoteFileTree 返回空输出，根目录不可读');
    const emptyRoot = useCustomPath ? targetPath : '~';
    const emptyName = useCustomPath
      ? (targetPath.split('/').filter(Boolean).pop() || targetPath)
      : '~';
    return { rootPath: emptyRoot, tree: { name: emptyName, path: emptyRoot, type: 'directory', children: [] } };
  }

  const explicitRoot = useCustomPath ? targetPath : undefined;
  const tree = buildRemoteTree(result.stdout.split('\n'), explicitRoot);
  return { rootPath: tree.path, tree };
}

/**
 * §需求：让其他扩展（如 git 扩展）能在 SSH 远程主机上执行命令并拿到 stdout/stderr。
 * 之前 git 扩展看到 ssh:// 路径就直接报"不是 Git 仓库"——是因为没有远程执行能力。
 * 现在通过此导出，git 扩展可以调用 git rev-parse --show-toplevel 等命令远程检测。
 *
 * 调用方（外部扩展）：ext.invoke('ideacode-ssh', 'executeRemote', [connectionId, command, cwd])
 *
 * @param {string} connectionId  连接 ID
 * @param {string} command       要执行的 shell 命令
 * @param {string} [cwd]         可选的工作目录
 * @returns {Promise<{success: boolean, stdout: string, stderr: string, code: number}>}
 */
async function executeRemote(connectionId, command, cwd) {
  const conn = findConnection(connectionId);
  if (!conn) throw new Error('SSH 连接不存在: ' + connectionId);
  const session = findConnectedSession(connectionId);
  if (!session) throw new Error('SSH 没有已连接的会话: ' + connectionId);

  // 若指定 cwd，包装成 `cd <cwd> && <command>` 形式
  const finalCommand = cwd
    ? `cd ${shellEscape(cwd)} && ${command}`
    : command;

  const result = await vscode.commands.executeCommand('ssh.internal.execute', {
    id: session.id,
    command: finalCommand,
  });

  return {
    success: result.success === true && result.code === 0,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    code: typeof result.code === 'number' ? result.code : -1,
  };
}

/**
 * 建立指定连接的 SSH 会话（供主应用"连接到..."Modal 调用）
 * 幂等：若已存在连接中/已连接的会话，直接返回现有会话。
 */
async function connectConnection(conn) {
  const existing = Array.from(sessions.values()).find(
    (s) => s.connectionId === conn.id && ['connecting', 'connected'].includes(s.status)
  );
  if (existing) {
    log('log', '[SSH Extension] 已存在活动会话，跳过重复连接:', conn.host, conn.username);
    return { sessionId: existing.id, status: existing.status };
  }

  log('log', '[SSH Extension] 收到连接请求:', conn.host, conn.username);
  const sessionId = generateId();
  const session = {
    id: sessionId,
    connectionId: conn.id,
    name: conn.name,
    username: conn.username,
    host: conn.host,
    cwd: '~',
    status: 'connecting',
    output: [`[${new Date().toLocaleTimeString()}] 正在连接 ${conn.host}:${conn.port || 22}...`],
  };
  sessions.set(sessionId, session);
  if (globalBroadcast) {
    globalBroadcast({ type: 'sessions', sessions: Array.from(sessions.values()) });
  }

  try {
    const result = await vscode.commands.executeCommand('ssh.internal.connect', {
      id: sessionId,
      host: conn.host,
      port: conn.port,
      username: conn.username,
      password: conn.password,
      privateKey: conn.privateKey,
    });

    if (result.success) {
      session.status = 'connected';
      session.output.push(`[${new Date().toLocaleTimeString()}] 连接成功`);
      session.output.push(getPrompt(session));
      log('log', '[SSH Extension] 连接成功，sessionId:', sessionId, '当前 client 数:', sshClients.size);
    } else {
      session.status = 'failed';
      session.output.push(`[${new Date().toLocaleTimeString()}] 连接失败: ${result.error}`);
      log('error', `[SSH Extension] 连接失败 [${conn.name}]: ${result.error}`);
    }
  } catch (err) {
    session.status = 'failed';
    session.output.push(`[${new Date().toLocaleTimeString()}] 连接错误: ${err.message}`);
    log('error', `[SSH Extension] 连接异常 [${conn.name}]: ${err.message}`);
  }

  if (globalBroadcast) {
    globalBroadcast({ type: 'sessions', sessions: Array.from(sessions.values()) });
  }

  return {
    sessionId,
    status: session.status,
    error: session.status === 'failed' ? session.output[session.output.length - 1] : undefined,
  };
}

async function openConnection(connectionId) {
  const conn = findConnection(connectionId);
  if (!conn) throw new Error('连接不存在');
  return connectConnection(conn);
}

async function handleFileOperation(payload) {
  const { operation, connectionId } = payload;
  const conn = findConnection(connectionId);
  if (!conn) throw new Error('连接不存在');
  const session = findConnectedSession(connectionId);
  if (!session) throw new Error('没有已连接的会话');

  let command = '';
  if (operation === 'delete') {
    command = `rm -rf ${shellEscape(payload.path)}`;
  } else if (operation === 'rename') {
    const parent = payload.path.slice(0, payload.path.lastIndexOf('/'));
    const target = `${parent}/${payload.newName}`;
    command = `mv ${shellEscape(payload.path)} ${shellEscape(target)}`;
  } else if (operation === 'move') {
    command = `mv ${shellEscape(payload.path)} ${shellEscape(payload.target)}`;
  } else if (operation === 'copy') {
    command = `cp -r ${shellEscape(payload.path)} ${shellEscape(payload.target)}`;
  } else if (operation === 'createFile') {
    command = `touch ${shellEscape(payload.path)}`;
  } else if (operation === 'createFolder') {
    command = `mkdir -p ${shellEscape(payload.path)}`;
  } else if (operation === 'getTree') {
    return getRemoteFileTree(connectionId);
  } else {
    throw new Error(`未知操作: ${operation}`);
  }

  console.log('[SSH Extension] 执行文件操作:', command);
  const result = await vscode.commands.executeCommand('ssh.internal.execute', {
    id: session.id,
    command,
  });

  if (!result.success) {
    throw new Error(result.error || '操作失败');
  }
  if (result.code !== 0) {
    throw new Error(result.stderr || `操作失败，退出码: ${result.code}`);
  }
  return { success: true, stdout: result.stdout, stderr: result.stderr };
}

function shellEscape(str) {
  return `'${String(str).replace(/'/g, "'\"'\"'")}'`;
}

async function activate(context) {
  console.log('[SSH Extension] 已激活');

  registerSshCommands();

  // 注册 ssh:// 文件系统 provider，供 IDE 资源管理器映射远程目录
  vscode.workspace.registerFileSystemProvider('ssh', sshFileSystemProvider);

  const panel = vscode.window.createWebviewPanel(
    'ssh-connections',
    'SSH 远程连接',
    { preserveFocus: false },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(context.extensionPath)],
    }
  );

  panel.webview.html = getWebviewHtml(context.extensionPath);

  // 维护所有 WebView 面板（主面板 + 弹窗），方便广播状态
  const webviewPanels = [panel];
  const popupPanels = new Map();
  function broadcast(message) {
    for (const p of webviewPanels) {
      try {
        p.webview.postMessage(message);
      } catch {
        // ignore closed panels
      }
    }
  }
  globalBroadcast = broadcast;

  try {
    const data = await context.globalState.get('ssh.connections', '[]');
    connections = JSON.parse(data);
  } catch {
    connections = [];
  }

  broadcast({ type: 'connections', connections });
  // 扩展宿主重启后，清空 WebView 中的旧会话状态，避免显示“已连接”但实际会话已丢失
  sessions.clear();
  broadcast({ type: 'sessions', sessions: [] });

  async function handleWebviewMessage(message) {
    switch (message.command) {
      case 'loadConnections':
        broadcast({ type: 'connections', connections });
        break;

      case 'loadSessions':
        broadcast({ type: 'sessions', sessions: Array.from(sessions.values()) });
        break;

      case 'addConnection':
      case 'updateConnection': {
        const { connection } = message;
        if (message.command === 'addConnection') {
          // 幂等：按 ID 去重，避免重复消息或快速双击导致重复记录
          if (!connections.find((c) => c.id === connection.id)) {
            connections.push(connection);
          }
        } else {
          const idx = connections.findIndex((c) => c.id === connection.id);
          if (idx >= 0) connections[idx] = connection;
        }
        await context.globalState.update('ssh.connections', JSON.stringify(connections));
        broadcast({ type: 'connections', connections });
        break;
      }

      case 'deleteConnection': {
        connections = connections.filter((c) => c.id !== message.connectionId);
        await context.globalState.update('ssh.connections', JSON.stringify(connections));
        broadcast({ type: 'connections', connections });
        break;
      }

      case 'connect': {
        const conn = connections.find((c) => c.id === message.connectionId);
        if (!conn) return;
        await connectConnection(conn);
        break;
      }

      case 'disconnect': {
        const sess = sessions.get(message.sessionId);
        if (sess) {
          try {
            await vscode.commands.executeCommand('ssh.internal.disconnect', { id: message.sessionId });
          } catch { /* ignore */ }
          sess.status = 'disconnected';
          sess.output.push(`[${new Date().toLocaleTimeString()}] 已断开连接`);
          broadcast({ type: 'sessions', sessions: Array.from(sessions.values()) });
        }
        break;
      }

      case 'closeSession': {
        const s = sessions.get(message.sessionId);
        if (s && s.status === 'connected') {
          try {
            await vscode.commands.executeCommand('ssh.internal.disconnect', { id: message.sessionId });
          } catch { /* ignore */ }
        }
        sessions.delete(message.sessionId);
        broadcast({ type: 'sessions', sessions: Array.from(sessions.values()) });
        break;
      }

      case 'openPopupWindow': {
        const sess = sessions.get(message.sessionId);
        if (!sess) break;
        const conn = connections.find((c) => c.id === sess.connectionId);
        const popupData = { ...sess, connectionName: conn?.name || sess.name };
        const popupPanel = vscode.window.createWebviewPanel(
          'ssh-popup',
          sess.name,
          { modal: true },
          {
            enableScripts: true,
            extensionId: 'ideacode-ssh',
            extensionPath: context.extensionPath,
          }
        );
        popupPanel.webview.html = getWebviewHtml(context.extensionPath, popupData);
        popupPanel.webview.onDidReceiveMessage(handleWebviewMessage);
        popupPanel.onDidDispose(() => {
          const idx = webviewPanels.indexOf(popupPanel);
          if (idx >= 0) webviewPanels.splice(idx, 1);
          popupPanels.delete(sess.id);
        });
        popupPanels.set(sess.id, popupPanel);
        webviewPanels.push(popupPanel);
        break;
      }

      case 'closePopupWindow': {
        const pp = popupPanels.get(message.sessionId);
        if (pp) {
          popupPanels.delete(message.sessionId);
          pp.dispose();
        }
        break;
      }

      case 'clearSessionOutput': {
        const clearSession = sessions.get(message.sessionId);
        if (clearSession) {
          clearSession.output = [];
          broadcast({ type: 'sessions', sessions: Array.from(sessions.values()) });
        }
        break;
      }

      case 'openTerminal': {
        const conn = connections.find((c) => c.id === message.connectionId);
        if (!conn) return;
        const terminalName = `${conn.name} ${conn.host}`;
        const options = {
          name: terminalName,
          executable: 'ssh',
          args: ['-p', String(conn.port || 22), `${conn.username}@${conn.host}`],
          isModal: true,
          // §需求：标识为 SSH 远程终端——前端 TerminalModal.handleExpandToTab
          // 检测到 isSSH=true 时只关闭 modal，不再走 moveToEditor（避免在 BottomPanel
          // tab 列表 / editor area 出现 SSH 终端）。SSH 终端的归宿只在 modal / SSH 面板。
          isSSH: true,
          profile: { name: 'ssh', path: 'ssh' },
        };
        // 密码认证时自动输入密码，并过滤掉密码提示行，避免显示不美观
        if (conn.authType === 'password' && conn.password) {
          options.input = conn.password;
          options.outputFilter = '[^\\r\\n]*password:\\s*\\r?\\n?';
        }
        try {
          const terminal = await vscode.window.createTerminal(options);
          // 在 IDE Modal 中打开真实终端面板
          if (typeof terminal.openInModal === 'function') {
            terminal.openInModal(terminalName);
          }
          // 关联到当前会话，实现弹窗/扩展与底部终端双向互通
          const session = Array.from(sessions.values()).find(
            (s) => s.connectionId === conn.id && s.status === 'connected'
          );
          if (session) {
            session.terminal = terminal;
            terminal.onDidWriteData((data) => {
              broadcast({ type: 'terminalOutput', connectionId: conn.id, data });
            });
            terminal.onDidClose((exitCode) => {
              broadcast({ type: 'terminalClosed', connectionId: conn.id, exitCode });
              if (session.terminal === terminal) {
                session.terminal = null;
              }
            });
          }
        } catch (err) {
          console.error('[SSH Extension] 创建终端失败:', err.message);
        }
        break;
      }

      case 'sendTerminalInput': {
        const session = sessions.get(message.sessionId);
        if (session?.terminal) {
          session.terminal.sendText(message.text, false);
        }
        break;
      }

      case 'loadRemoteFileTree': {
        const conn = connections.find((c) => c.id === message.connectionId);
        if (!conn) return;

        const session = Array.from(sessions.values()).find(
          (s) => s.connectionId === conn.id && s.status === 'connected'
        );
        if (!session) {
          broadcast({
            type: 'remoteFileTreeError',
            connectionId: conn.id,
            error: '没有已连接的会话，请先连接',
          });
          break;
        }

        broadcast({ type: 'remoteFileTreeLoading', connectionId: conn.id });

        try {
          // 使用跨平台的 find 命令（兼容 GNU/BSD find）。
          // 某些子目录无权限会导致 find 退出码非 0，用 || true 忽略，保留已有输出。
          const result = await vscode.commands.executeCommand('ssh.internal.execute', {
            id: session.id,
            command: "(find ~ -maxdepth 3 -exec sh -c 'for p; do if [ -d \"$p\" ]; then echo \"d|$p\"; else echo \"f|$p\"; fi; done' sh {} +) 2>/dev/null || true",
          });

          if (!result.success) {
            broadcast({
              type: 'remoteFileTreeError',
              connectionId: conn.id,
              error: result.error || result.stderr || '加载失败',
            });
            break;
          }

          if (result.stderr) {
            console.warn('[SSH Extension] 加载目录结构 stderr:', result.stderr);
          }

          const tree = buildRemoteTree(result.stdout.split('\n'));
          await vscode.workspace.openRemoteFileTree({
            title: `${conn.name} 目录结构`,
            tree: {
              connectionId: conn.id,
              rootPath: tree.path,
              connection: conn,
              tree,
            },
          });
          broadcast({ type: 'remoteFileTreeLoaded', connectionId: conn.id });
        } catch (err) {
          broadcast({
            type: 'remoteFileTreeError',
            connectionId: conn.id,
            error: err.message,
          });
        }
        break;
      }

      case 'execute': {
        const execSession = sessions.get(message.sessionId);
        if (!execSession || execSession.status !== 'connected') return;

        const trimmedCmd = message.cmd.trim();
        execSession.output.push(`${getPrompt(execSession)} ${trimmedCmd}`);
        broadcast({ type: 'sessions', sessions: Array.from(sessions.values()) });

        try {
          const result = await vscode.commands.executeCommand('ssh.internal.execute', {
            id: message.sessionId,
            command: message.cmd,
          });

          if (result.success) {
            if (trimmedCmd.startsWith('cd ')) {
              const target = trimmedCmd.slice(3).trim().split(/[\s;&|]/)[0];
              execSession.cwd = resolveCwd(execSession.cwd, target);
            }
            if (result.stdout) execSession.output.push(result.stdout);
            if (result.stderr) execSession.output.push(result.stderr);
            execSession.output.push(getPrompt(execSession));
          } else {
            execSession.output.push(`Error: ${result.error || 'Unknown error'}`);
            execSession.output.push(getPrompt(execSession));
          }
        } catch (err) {
          execSession.output.push(`Error: ${err.message}`);
          execSession.output.push(getPrompt(execSession));
        }

        broadcast({ type: 'sessions', sessions: Array.from(sessions.values()) });
        break;
      }
    }
  }

  panel.webview.onDidReceiveMessage(handleWebviewMessage);

  context.subscriptions.push({
    dispose: () => {
      for (const client of sshClients.values()) {
        try { client.end(); } catch { /* ignore */ }
      }
      sshClients.clear();
      for (const p of webviewPanels) {
        try { p.dispose(); } catch { /* ignore */ }
      }
      webviewPanels.length = 0;
    },
  });
}

function deactivate() {
  console.log('[SSH Extension] 已停用');
  for (const session of sessions.values()) {
    if (session.status === 'connected') {
      try {
        vscode.commands.executeCommand('ssh.internal.disconnect', { id: session.id });
      } catch { /* ignore */ }
    }
  }
  sessions.clear();
}

/**
 * §需求：让主应用（"连接到..." Modal）能列出已配置的 SSH 连接。
 * 用户通常已经在 SSH 面板配置好连接；Modal 输入 user@host 时按此列表匹配。
 * 返回值只暴露脱敏信息（不含 password/privateKey），只用于 UI 选择/匹配。
 */
function listConnections() {
  return connections.map((c) => {
    // 以实际保存的凭证为准推断认证方式，避免用户选了密码但未填密码、或选了密钥等情况显示错误
    let effectiveAuthType = c.authType;
    if (c.privateKey) {
      effectiveAuthType = 'key';
    } else if (c.password) {
      effectiveAuthType = 'password';
    } else if (!effectiveAuthType) {
      // 未配置任何凭证时，默认会尝试 ssh-agent / 本地默认私钥
      effectiveAuthType = 'key';
    }
    return {
      id: c.id,
      name: c.name,
      host: c.host,
      port: c.port,
      username: c.username,
      authType: effectiveAuthType,
    };
  });
}

module.exports = { activate, deactivate, getRemoteFileTree, handleFileOperation, callFileSystemProvider, executeRemote, listConnections, openConnection };
