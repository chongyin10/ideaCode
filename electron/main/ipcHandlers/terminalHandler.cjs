/**
 * 终端 IPC 处理器
 * 
 * 负责：
 * 1. 通过 node-pty 创建/管理伪终端进程
 * 2. 流控机制 (Flow Control) — 防止大量输出淹没渲染进程
 * 3. 终端输入/输出数据的 IPC 转发
 * 4. Shell Profile 自动检测
 * 5. 持久化会话 — 终端布局保存/恢复
 * 6. 广播模式 — 输入同步到多个终端
 */

const { ipcMain } = require('electron');
const { Channels } = require('../../shared/channels.cjs');
const os = require('os');
const path = require('path');
const fs = require('fs');

// node-pty 在 electron 环境中需要特殊处理
let ptyModule = null;
try {
  ptyModule = require('node-pty');
} catch (e) {
  console.warn('[TerminalHandler] node-pty 加载失败，终端将以模拟模式运行:', e.message);
}

// ============ 流控常量 ============
const HIGH_WATERMARK = 100000;   // 100K 未确认字符 → 暂停 PTY
const LOW_WATERMARK = 5000;      // 5K 未确认字符 → 恢复 PTY
const ACK_BATCH_SIZE = 5000;     // 客户端每解析 5K 字符发送一次 ACK

// ============ 终端实例管理 ============
/** @type {Map<number, TerminalProcess>} */
const terminals = new Map();
let nextTerminalId = 1;

class TerminalProcess {
  constructor(id, ptyProcess, shellLaunchConfig, webContents) {
    this.id = id;
    this.pty = ptyProcess;
    this.config = shellLaunchConfig;
    this.webContents = webContents;
    this.paused = false;
    /** 未确认的字符数（已发送到渲染但未被 ACK） */
    this.unackedChars = 0;
    /** 进程是否已经退出 */
    this.exited = false;
    /** 退出码 */
    this.exitCode = null;
    /** 是否为广播模式的接收者 */
    this.isBroadcastReceiver = false;
    /** 持久化 ID */
    this.persistentId = null;
    /** 当前行输入缓冲，用于识别 git 命令 */
    this.inputBuffer = '';
  }

  /**
   * 写入输入并识别可能改变 Git 状态的命令
   * @param {string} data
   */
  writeInput(data) {
    if (!this.pty || this.exited) return;
    this.pty.write(data);

    // 累积输入行，识别 git 命令后通知渲染进程刷新状态
    this.inputBuffer += data;
    const lines = this.inputBuffer.split(/\r?\n/);
    // 保留最后一段未结束的行
    this.inputBuffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // 匹配常见会修改 git index/working tree 的命令
      if (/^git\b/.test(trimmed)) {
        try {
          if (this.webContents && !this.webContents.isDestroyed()) {
            this.webContents.send(Channels.GIT_STATUS_CHANGED, { cwd: this.config.cwd });
          }
        } catch (e) {
          console.warn('[TerminalHandler] 发送 GIT_STATUS_CHANGED 失败:', e.message);
        }
      }
    }
  }
}

// ============ Shell Profile 自动检测 ============

/** @returns {Array<{name: string, path: string, args?: string[], icon?: string}>} */
function detectShellProfiles() {
  const profiles = [];
  const platform = os.platform();

  if (platform === 'darwin' || platform === 'linux') {
    // Unix: 从 /etc/shells 读取可用 shell
    try {
      const shellsFile = fs.readFileSync('/etc/shells', 'utf-8');
      const shells = shellsFile.split('\n')
        .map(s => s.trim())
        .filter(s => s && !s.startsWith('#') && fs.existsSync(s));

      for (const shellPath of shells) {
        const basename = path.basename(shellPath);
        profiles.push({
          name: basename,
          path: shellPath,
          args: basename === 'zsh' || basename === 'bash' ? ['-l'] : undefined,
          icon: getShellIcon(basename),
        });
      }
    } catch (e) {
      // fallback: 检查常见 shell
      const commonShells = [
        '/bin/zsh', '/bin/bash', '/bin/fish', '/bin/sh',
        '/usr/local/bin/fish', '/usr/local/bin/zsh',
      ];
      for (const shellPath of commonShells) {
        if (fs.existsSync(shellPath)) {
          const basename = path.basename(shellPath);
          profiles.push({
            name: basename,
            path: shellPath,
            args: basename === 'zsh' || basename === 'bash' ? ['-l'] : undefined,
            icon: getShellIcon(basename),
          });
        }
      }
    }
  } else if (platform === 'win32') {
    // Windows: 检测 PowerShell、CMD、Git Bash、WSL
    const windir = process.env.WINDIR || 'C:\\Windows';
    // PowerShell 7+
    const pwshPath = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
    if (fs.existsSync(pwshPath)) {
      profiles.push({ name: 'pwsh', path: pwshPath, args: ['-NoLogo'], icon: 'terminal-powershell' });
    }
    // Windows PowerShell
    profiles.push({ name: 'powershell', path: path.join(windir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo'], icon: 'terminal-powershell' });
    // CMD
    profiles.push({ name: 'cmd', path: path.join(windir, 'System32', 'cmd.exe'), icon: 'terminal-cmd' });
    // Git Bash
    const gitBashPath = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
    if (fs.existsSync(gitBashPath)) {
      profiles.push({ name: 'Git Bash', path: gitBashPath, args: ['-l'], icon: 'terminal-bash' });
    }
  }

  return profiles;
}

function getShellIcon(shellName) {
  const icons = {
    'zsh': 'terminal-zsh',
    'bash': 'terminal-bash',
    'fish': 'terminal-fish',
    'sh': 'terminal',
    'node': 'terminal-node',
    'python': 'terminal-python',
    'pwsh': 'terminal-powershell',
    'powershell': 'terminal-powershell',
    'cmd': 'terminal-cmd',
  };
  return icons[shellName] || 'terminal';
}

function getDefaultShell() {
  const platform = os.platform();
  if (platform === 'win32') {
    return { name: 'powershell', path: path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo'] };
  }
  // Unix: 默认优先 zsh，zsh 不存在时回退 bash，最后使用 $SHELL
  const candidates = [];
  if (process.env.SHELL && path.basename(process.env.SHELL) === 'zsh') candidates.push(process.env.SHELL);
  if (fs.existsSync('/bin/zsh')) candidates.push('/bin/zsh');
  if (fs.existsSync('/usr/local/bin/zsh')) candidates.push('/usr/local/bin/zsh');
  if (process.env.SHELL && path.basename(process.env.SHELL) === 'bash') candidates.push(process.env.SHELL);
  if (fs.existsSync('/bin/bash')) candidates.push('/bin/bash');
  if (fs.existsSync('/usr/local/bin/bash')) candidates.push('/usr/local/bin/bash');
  if (process.env.SHELL && fs.existsSync(process.env.SHELL)) candidates.push(process.env.SHELL);

  for (const shellPath of candidates) {
    if (fs.existsSync(shellPath)) {
      const basename = path.basename(shellPath);
      return { name: basename, path: shellPath, args: basename === 'zsh' || basename === 'bash' ? ['-l'] : undefined };
    }
  }
  return { name: 'zsh', path: '/bin/zsh', args: ['-l'] };
}

// ============ PTY 创建与销毁 ============

/**
 * 创建终端进程
 * @param {object} config
 * @param {string} cwd - 工作目录
 * @param {number} cols - 列数
 * @param {number} rows - 行数
 * @param {import('electron').WebContents} webContents - 渲染进程引用
 */
async function createTerminalProcess(config, cwd, cols, rows, webContents) {
  if (!ptyModule) {
    // 无 node-pty 时的降级处理：返回模拟终端
    const id = nextTerminalId++;
    const mockProcess = new TerminalProcess(id, null, config, webContents);
    terminals.set(id, mockProcess);
    // 发送模拟就绪事件
    webContents.send(Channels.TERMINAL_OUTPUT, {
      id,
      type: 'ready',
      pid: -1,
      cwd: cwd || process.cwd(),
    });
    // 发送欢迎信息
    webContents.send(Channels.TERMINAL_OUTPUT, {
      id,
      type: 'data',
      data: '\x1b[32m●\x1b[0m 终端模拟模式 — node-pty 未安装\r\n' +
            '请在终端中运行:\r\n' +
            '  \x1b[33mnpm install node-pty\x1b[0m\r\n' +
            '然后重新编译原生模块:\r\n' +
            '  \x1b[33mnpx electron-rebuild\x1b[0m\r\n\r\n',
    });
    return id;
  }

  const shellConfig = config.shellConfig || getDefaultShell();
  const shellPath = config.executable || shellConfig.path;
  const shellArgs = config.args || shellConfig.args || [];
  const env = { ...process.env, ...(config.env || {}) };

  // 校验工作目录：不存在则回退到进程当前目录
  let workDir = cwd || config.cwd || process.cwd();
  try {
    if (!fs.statSync(workDir).isDirectory()) {
      workDir = process.cwd();
    }
  } catch {
    workDir = process.cwd();
  }

  const id = nextTerminalId++;

  // 尝试主 shell，失败后使用常见 fallback
  const fallbackShells = ['/bin/zsh', '/bin/bash', '/bin/sh'];
  const shellsToTry = new Set([
    shellPath,
    ...(process.env.SHELL && fs.existsSync(process.env.SHELL) ? [process.env.SHELL] : []),
    ...fallbackShells,
  ]);

  let lastError = null;
  for (const tryPath of shellsToTry) {
    if (!tryPath || !fs.existsSync(tryPath)) continue;

    const basename = path.basename(tryPath);
    const tryArgs = basename === 'zsh' || basename === 'bash' ? ['-l'] : [];

    try {
      const ptyProcess = ptyModule.spawn(tryPath, tryArgs, {
        name: 'xterm-256color',
        cols: cols || config.cols || 80,
        rows: rows || config.rows || 24,
        cwd: workDir,
        env: env,
      });

      const termProcess = new TerminalProcess(id, ptyProcess, config, webContents);
      terminals.set(id, termProcess);

      // --- PTY 数据事件 → 流控转发到渲染进程 ---
      ptyProcess.onData((data) => {
        if (termProcess.exited) return;

        termProcess.unackedChars += data.length;

        // 流控：超过高水位线时暂停 PTY 输出（优雅降级）
        if (!termProcess.paused && termProcess.unackedChars > HIGH_WATERMARK) {
          termProcess.paused = true;
          try {
            if (typeof ptyProcess.pause === 'function') {
              ptyProcess.pause();
            }
          } catch (e) { /* node-pty 可能不支持 pause */ }
        }

        webContents.send(Channels.TERMINAL_OUTPUT, {
          id,
          type: 'data',
          data: data,
        });
      });

      // --- PTY 进程退出事件 ---
      ptyProcess.onExit(({ exitCode, signal }) => {
        termProcess.exited = true;
        termProcess.exitCode = exitCode;
        webContents.send(Channels.TERMINAL_OUTPUT, {
          id,
          type: 'exit',
          exitCode,
          signal,
        });
      });

      // 发送就绪事件
      webContents.send(Channels.TERMINAL_OUTPUT, {
        id,
        type: 'ready',
        pid: ptyProcess.pid,
        cwd: workDir,
      });

      return id;
    } catch (error) {
      lastError = error;
      console.warn(`[TerminalHandler] 尝试启动 ${tryPath} 失败:`, error.message);
    }
  }

  throw new Error(`创建终端进程失败: ${lastError?.message || '无可用 shell'}`);
}

/**
 * 销毁终端进程
 */
function disposeTerminalProcess(id) {
  const term = terminals.get(id);
  if (!term) return;

  try {
    if (term.pty) {
      term.pty.kill();
    }
  } catch (e) {
    // 进程可能已经退出
  }
  terminals.delete(id);
}

/**
 * 发送输入到终端进程
 */
function sendInput(id, data) {
  const term = terminals.get(id);
  if (!term || term.exited) return;
  try {
    term.writeInput(data);
  } catch (e) {
    console.error(`[TerminalHandler] 写入输入失败 (id=${id}):`, e.message);
  }
}

/**
 * 发送信号到终端进程
 */
function sendSignal(id, signal) {
  const term = terminals.get(id);
  if (!term || term.exited || !term.pty) return;
  try {
    term.pty.kill(signal);
  } catch (e) {
    console.error(`[TerminalHandler] 发送信号失败 (id=${id}):`, e.message);
  }
}

/**
 * 调整终端尺寸
 */
function resizeTerminal(id, cols, rows) {
  const term = terminals.get(id);
  if (!term || term.exited || !term.pty) return;
  try {
    term.pty.resize(cols, rows);
  } catch (e) {
    console.error(`[TerminalHandler] 调整尺寸失败 (id=${id}):`, e.message);
  }
}

/**
 * ACK — 渲染进程确认已处理指定数量的字符
 * 用于流控恢复
 */
function ackChars(id, charCount) {
  const term = terminals.get(id);
  if (!term) return;

  term.unackedChars = Math.max(0, term.unackedChars - charCount);

  // 低于低水位线，恢复 PTY（优雅降级）
  if (term.paused && term.unackedChars < LOW_WATERMARK) {
    term.paused = false;
    if (term.pty) {
      try {
        if (typeof term.pty.resume === 'function') {
          term.pty.resume();
        }
      } catch (e) { /* node-pty 可能不支持 resume */ }
    }
  }
}

/**
 * 获取终端当前工作目录
 */
async function getTerminalCwd(id) {
  const term = terminals.get(id);
  if (!term || !term.pty || term.exited) return null;

  const platform = os.platform();
  if (platform === 'win32') {
    return process.cwd(); // Windows 暂不实现
  }

  // Unix: 通过 lsof 或 /proc 获取 cwd
  try {
    const pid = term.pty.pid;
    const procPath = `/proc/${pid}/cwd`;
    if (fs.existsSync(procPath)) {
      const cwd = fs.readlinkSync(procPath);
      return cwd;
    }
  } catch (e) {
    // fallback
  }
  return process.cwd();
}

/**
 * 持久化终端布局
 */
function getLayout() {
  const tabs = [];
  terminals.forEach((term) => {
    if (!term.exited) {
      tabs.push({
        id: term.id,
        pid: term.pty?.pid,
        config: term.config,
        cwd: process.cwd(),
      });
    }
  });
  return { tabs };
}

/**
 * 分离终端（保留进程以供后续重新附加）
 */
function detachTerminal(id) {
  const term = terminals.get(id);
  if (!term) return;

  if (term.pty) {
    // node-pty 不支持真正的 detach，这里做逻辑分离
    // 停止监听 data 事件来模拟分离
    try { term.pty.removeAllListeners('data'); } catch (e) { /* ignore */ }
    term.persistentId = id;
  }
}

/**
 * 广播输入到多个终端
 */
function broadcastInput(senderId, data, targetIds) {
  for (const id of targetIds) {
    if (id !== senderId) {
      sendInput(id, data);
    }
  }
}

// ============ IPC 处理器注册 ============

/**
 * 注册所有终端相关 IPC 处理器
 */
function registerTerminalHandlers() {
  // --- 终端生命周期 ---
  ipcMain.handle(Channels.TERMINAL_CREATE, async (event, payload) => {
    // 兼容两种调用格式：{ config, cwd, cols, rows } 或直接将配置对象作为 payload
    const config = payload?.config || payload || {};
    const cwd = payload?.cwd ?? config.cwd;
    const cols = payload?.cols ?? config.cols;
    const rows = payload?.rows ?? config.rows;
    try {
      const id = await createTerminalProcess(config, cwd, cols, rows, event.sender);
      return { success: true, id };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(Channels.TERMINAL_DISPOSE, async (_event, { id }) => {
    disposeTerminalProcess(id);
    return { success: true };
  });

  ipcMain.handle(Channels.TERMINAL_INPUT, async (_event, { id, data }) => {
    sendInput(id, data);
    return { success: true };
  });

  ipcMain.handle(Channels.TERMINAL_RESIZE, async (_event, { id, cols, rows }) => {
    resizeTerminal(id, cols, rows);
    return { success: true };
  });

  ipcMain.handle(Channels.TERMINAL_SEND_SIGNAL, async (_event, { id, signal }) => {
    sendSignal(id, signal);
    return { success: true };
  });

  ipcMain.handle(Channels.TERMINAL_CLEAR, async (_event, { id }) => {
    sendInput(id, '\x1b[2J\x1b[H');
    return { success: true };
  });

  // --- 流控 ACK ---
  ipcMain.handle('terminal:ack', async (_event, { id, charCount }) => {
    if (typeof id === 'number' && typeof charCount === 'number') {
      ackChars(id, charCount);
    }
    return { success: true };
  });

  // --- Shell Profile ---
  ipcMain.handle(Channels.TERMINAL_LIST_PROFILES, async () => {
    try {
      const profiles = detectShellProfiles();
      const defaultShell = getDefaultShell();
      return { success: true, profiles, defaultShell };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // --- CWD ---
  ipcMain.handle(Channels.TERMINAL_GET_CWD, async (_event, { id }) => {
    try {
      const cwd = await getTerminalCwd(id);
      return { success: true, cwd };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // --- 持久化 ---
  ipcMain.handle(Channels.TERMINAL_DETACH, async (_event, { id }) => {
    detachTerminal(id);
    return { success: true };
  });

  ipcMain.handle(Channels.TERMINAL_GET_LAYOUT, async () => {
    return { success: true, layout: getLayout() };
  });

  ipcMain.handle(Channels.TERMINAL_SET_LAYOUT, async () => {
    return { success: true };
  });

  // --- 广播 ---
  ipcMain.handle(Channels.TERMINAL_BROADCAST, async (_event, { senderId, data, targetIds }) => {
    broadcastInput(senderId, data, targetIds);
    return { success: true };
  });

  console.log('[TerminalHandler] 终端 IPC 处理器已注册');
}

module.exports = { registerTerminalHandlers };
