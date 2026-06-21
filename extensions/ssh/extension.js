/**
 * IDEACODE SSH 插件入口
 */

const vscode = require('./api');
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');

const sessions = new Map();
const sshClients = new Map();

function generateId() {
  return `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * 读取 WebView 构建后的 HTML 文件，并将资源内联
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
    console.error('[SSH Extension] 读取 WebView HTML 失败:', err.message);
    return `<html><body style="color:#fff;background:#1e1e1e;padding:20px;"><h1>SSH 远程连接</h1><p>WebView 资源未找到，请运行 <code>cd web/ssh && npm run build</code></p></body></html>`;
  }
}

/**
 * 注册 SSH 内部命令处理器
 */
function registerSshCommands() {
  vscode.commands.registerCommand('ssh.internal.connect', (config) => {
    return new Promise((resolve) => {
      const { id, host, port, username, password, privateKey } = config;
      console.log('[SSH Extension] 开始连接:', host, port, username);

      const client = new Client();
      sshClients.set(id, client);

      const connConfig = {
        host,
        port: port || 22,
        username,
        readyTimeout: 20000,
      };

      if (privateKey) {
        connConfig.privateKey = privateKey;
      } else if (password) {
        connConfig.password = password;
      }

      client.on('ready', () => {
        console.log('[SSH Extension] 连接成功:', host);
        resolve({ success: true });
      });

      client.on('error', (err) => {
        console.error('[SSH Extension] 连接失败:', host, err.message);
        sshClients.delete(id);
        resolve({ success: false, error: err.message });
      });

      client.on('close', () => {
        console.log('[SSH Extension] 连接关闭:', host);
        sshClients.delete(id);
      });

      client.on('keyboard-interactive', (name, instructions, instructionsLang, prompts, finish) => {
        // 如果服务器要求 keyboard-interactive 且我们有密码，直接提交密码
        if (password && prompts.length > 0) {
          finish([password]);
        } else {
          finish([]);
        }
      });

      try {
        client.connect(connConfig);
      } catch (err) {
        console.error('[SSH Extension] 连接异常:', err.message);
        sshClients.delete(id);
        resolve({ success: false, error: err.message });
      }
    });
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
      if (!client) {
        return resolve({ success: false, error: '会话不存在或已断开' });
      }

      client.exec(command, (err, stream) => {
        if (err) {
          return resolve({ success: false, error: err.message });
        }

        let stdout = '';
        let stderr = '';

        stream.on('close', (code, signal) => {
          resolve({ success: true, stdout, stderr, code, signal });
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

async function activate(context) {
  console.log('[SSH Extension] 已激活');

  registerSshCommands();

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

  let connections = [];
  try {
    const data = await context.globalState.get('ssh.connections', '[]');
    connections = JSON.parse(data);
  } catch {
    connections = [];
  }

  panel.webview.postMessage({ type: 'connections', connections });

  panel.webview.onDidReceiveMessage(async (message) => {
    switch (message.command) {
      case 'loadConnections':
        panel.webview.postMessage({ type: 'connections', connections });
        break;

      case 'addConnection':
      case 'updateConnection': {
        const { connection } = message;
        if (message.command === 'addConnection') {
          connections.push(connection);
        } else {
          const idx = connections.findIndex((c) => c.id === connection.id);
          if (idx >= 0) connections[idx] = connection;
        }
        await context.globalState.update('ssh.connections', JSON.stringify(connections));
        panel.webview.postMessage({ type: 'connections', connections });
        break;
      }

      case 'deleteConnection': {
        connections = connections.filter((c) => c.id !== message.connectionId);
        await context.globalState.update('ssh.connections', JSON.stringify(connections));
        panel.webview.postMessage({ type: 'connections', connections });
        break;
      }

      case 'connect': {
        const conn = connections.find((c) => c.id === message.connectionId);
        if (!conn) return;

        const sessionId = generateId();
        const session = {
          id: sessionId,
          connectionId: conn.id,
          name: conn.name,
          status: 'connecting',
          output: [`[${new Date().toLocaleTimeString()}] 正在连接 ${conn.host}:${conn.port || 22}...`],
        };
        sessions.set(sessionId, session);
        panel.webview.postMessage({ type: 'sessions', sessions: Array.from(sessions.values()) });

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
          } else {
            session.status = 'disconnected';
            session.output.push(`[${new Date().toLocaleTimeString()}] 连接失败: ${result.error}`);
          }
        } catch (err) {
          session.status = 'disconnected';
          session.output.push(`[${new Date().toLocaleTimeString()}] 连接错误: ${err.message}`);
        }

        panel.webview.postMessage({ type: 'sessions', sessions: Array.from(sessions.values()) });
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
          panel.webview.postMessage({ type: 'sessions', sessions: Array.from(sessions.values()) });
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
        panel.webview.postMessage({ type: 'sessions', sessions: Array.from(sessions.values()) });
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
        };
        // 密码认证时自动输入密码，并过滤掉密码提示行，避免显示不美观
        if (conn.authType === 'password' && conn.password) {
          options.input = conn.password;
          options.outputFilter = '[^\\r\\n]*password:\\s*\\r?\\n?';
        }
        try {
          await vscode.window.createTerminal(options);
        } catch (err) {
          console.error('[SSH Extension] 创建终端失败:', err.message);
        }
        break;
      }

      case 'execute': {
        const execSession = sessions.get(message.sessionId);
        if (!execSession || execSession.status !== 'connected') return;

        execSession.output.push(`$ ${message.cmd}`);
        panel.webview.postMessage({ type: 'sessions', sessions: Array.from(sessions.values()) });

        try {
          const result = await vscode.commands.executeCommand('ssh.internal.execute', {
            id: message.sessionId,
            command: message.cmd,
          });

          if (result.success) {
            if (result.stdout) execSession.output.push(result.stdout);
            if (result.stderr) execSession.output.push(result.stderr);
          } else {
            execSession.output.push(`Error: ${result.error || 'Unknown error'}`);
          }
        } catch (err) {
          execSession.output.push(`Error: ${err.message}`);
        }

        panel.webview.postMessage({ type: 'sessions', sessions: Array.from(sessions.values()) });
        break;
      }
    }
  });

  context.subscriptions.push({
    dispose: () => {
      for (const client of sshClients.values()) {
        try { client.end(); } catch { /* ignore */ }
      }
      sshClients.clear();
      panel.dispose();
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

module.exports = { activate, deactivate };
