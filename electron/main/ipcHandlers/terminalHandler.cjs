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

const { ipcMain, BrowserWindow } = require('electron');
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
const HIGH_WATERMARK = 100000;   // 100K 未确认字符 → 暂停 PTY (PID 控制降级时的回退)
const LOW_WATERMARK = 5000;      // 5K 未确认字符 → 恢复 PTY
const ACK_BATCH_SIZE = 5000;     // 客户端每解析 5K 字符发送一次 ACK

// ============ PID 流控 (数学优化 #1) ============
/** 简化的 PID 控制器（JavaScript 实现，避免依赖 TypeScript 模块） */
class PIDControl {
  constructor(kp, ki, kd, setpoint) {
    this.kp = kp; this.ki = ki; this.kd = kd;
    this.setpoint = setpoint;
    this.integral = 0; this.prevError = 0;
    this.lastTime = Date.now();
  }
  compute(measurement) {
    const now = Date.now();
    const dt = Math.max(1, now - this.lastTime);
    this.lastTime = now;
    const error = this.setpoint - measurement;
    this.integral = Math.max(-50, Math.min(50, this.integral + error * dt / 1000));
    const derivative = dt > 0 ? (error - this.prevError) / (dt / 1000) : 0;
    this.prevError = error;
    let out = this.kp * error / this.setpoint + this.ki * this.integral / this.setpoint + this.kd * derivative / this.setpoint;
    out = Math.max(0, Math.min(1, out + 0.5));
    return out;
  }
}

// ============ zsh compinit 断链清理 ============

/**
 * 清理 Homebrew zsh 补全目录中的断裂符号链接。
 *
 * 问题: Homebrew 更新/卸载软件包后，/opt/homebrew/share/zsh/site-functions/ 下的
 * 补全文件 (如 _brew_services) 可能变成指向已不存在目标的断裂符号链接。
 * zsh compinit 启动时会尝试读取这些文件，触发:
 *   compinit:527: no such file or directory: .../_brew_services
 *
 * 此函数遍历常见补全目录，删除所有断裂的符号链接。
 * 幂等操作，可安全重复调用。每次终端创建时调用一次。
 */
const _brokenLinkCleanupDone = new Set(); // 已清理过的目录，避免重复 I/O
function cleanupBrokenZshCompletions() {
  // 常见补全目录 (Homebrew Apple Silicon / Intel + 系统级)
  const completionDirs = [
    '/opt/homebrew/share/zsh/site-functions',
    '/usr/local/share/zsh/site-functions',
  ];

  for (const dir of completionDirs) {
    if (_brokenLinkCleanupDone.has(dir)) continue;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // 目录不存在或无权限，跳过
      _brokenLinkCleanupDone.add(dir); // 标记已尝试，避免反复 stat
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        const fullPath = path.join(dir, entry.name);
        try {
          // fs.statSync 会跟随符号链接；如果目标不存在则抛 ENOENT
          fs.statSync(fullPath);
        } catch {
          // 断裂符号链接 → 删除
          try {
            fs.unlinkSync(fullPath);
          } catch {
            // 删除失败（权限等）忽略，后续靠 ZSH_DISABLE_COMPFIX 抑制警告
          }
        }
      }
    }

    _brokenLinkCleanupDone.add(dir);
  }
}

// 每个终端实例附带 PID 控制器
const pidControllers = new Map();

// ============ 终端实例管理 ============
/** @type {Map<number, TerminalProcess>} */
const terminals = new Map();
let nextTerminalId = 1;

/** 每个窗口是否启用广播模式 */
const broadcastModeByWindow = new Map();

class TerminalProcess {
  constructor(id, ptyProcess, shellLaunchConfig, ownerWindow, ownerWebContents) {
    this.id = id;
    this.pty = ptyProcess;
    this.config = shellLaunchConfig;
    this.ownerWindow = ownerWindow;
    this.ownerWebContents = ownerWebContents;
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
          if (this.ownerWebContents && !this.ownerWebContents.isDestroyed()) {
            this.ownerWebContents.send(Channels.GIT_STATUS_CHANGED, { cwd: this.config.cwd });
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
 * @param {import('electron').BrowserWindow} ownerWindow - 所属主窗口
 * @param {import('electron').WebContents} ownerWebContents - 主窗口 React 渲染进程
 */
async function createTerminalProcess(config, cwd, cols, rows, ownerWindow, ownerWebContents) {
  if (!ptyModule) {
    // 无 node-pty 时的降级处理：返回模拟终端
    const id = nextTerminalId++;
    const mockProcess = new TerminalProcess(id, null, config, ownerWindow, ownerWebContents);
    terminals.set(id, mockProcess);
    // 发送模拟就绪事件
    ownerWebContents.send(Channels.TERMINAL_OUTPUT, {
      id,
      type: 'ready',
      pid: -1,
      cwd: cwd || process.cwd(),
    });
    // 发送欢迎信息
    ownerWebContents.send(Channels.TERMINAL_OUTPUT, {
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

  // ── 修复 zsh compinit 警告 ──
  // Homebrew 的 _brew_services 等补全文件偶尔会变成断裂符号链接，
  // 导致 zsh compinit 在启动时报:
  //   compinit:527: no such file or directory: /opt/homebrew/share/zsh/site-functions/_brew_services
  // 此处主动清理断裂的符号链接，并设置 ZSH_DISABLE_COMPFIX 抑制残余警告。
  cleanupBrokenZshCompletions();

  // 抑制 zsh compinit 的 " insecure directories" / 缺失文件警告
  // (不影响补全功能本身，仅跳过 compfix 安全检查)
  if (env.ZSH_DISABLE_COMPFIX === undefined) {
    env.ZSH_DISABLE_COMPFIX = 'true';
  }

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

  // 终端现在直接渲染在主窗口 DOM 中，无需再创建 BrowserView

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

      const termProcess = new TerminalProcess(id, ptyProcess, config, ownerWindow, ownerWebContents);
      terminals.set(id, termProcess);

      // PID 流控初始化
      pidControllers.set(id, new PIDControl(0.5, 0.1, 0.05, HIGH_WATERMARK * 0.6));

      // --- PTY 数据事件 → 转发到对应 BrowserView ---
      ptyProcess.onData((data) => {
        if (termProcess.exited) return;

        termProcess.unackedChars += data.length;

        // PID 流控: 计算 throttle 因子 [0, 1]
        const pid = pidControllers.get(id);
        const throttle = pid ? pid.compute(termProcess.unackedChars) : 1.0;

        // throttle < 0.3 时暂停 PTY (强节流), > 0.7 时恢复
        if (!termProcess.paused && throttle < 0.3) {
          termProcess.paused = true;
          try { if (typeof ptyProcess.pause === 'function') ptyProcess.pause(); } catch {}
        } else if (termProcess.paused && throttle > 0.7) {
          termProcess.paused = false;
          try { if (typeof ptyProcess.resume === 'function') ptyProcess.resume(); } catch {}
        }

        termProcess.ownerWebContents.send(Channels.TERMINAL_OUTPUT, {
          id,
          type: 'data',
          data: data,
        });
      });

      // --- PTY 进程退出事件 ---
      ptyProcess.onExit(({ exitCode, signal }) => {
        termProcess.exited = true;
        termProcess.exitCode = exitCode;
        ownerWebContents.send(Channels.TERMINAL_OUTPUT, {
          id,
          type: 'exit',
          exitCode,
          signal,
        });
      });

      // 发送就绪事件（主窗口 UI 更新用）
      ownerWebContents.send(Channels.TERMINAL_OUTPUT, {
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
 * @param {object} options
 * @param {number} options.id
 */
function disposeTerminalProcess({ id }) {
  const term = terminals.get(id);
  if (!term) return;

  pidControllers.delete(id);
  try {
    if (term.pty) { term.pty.kill(); }
  } catch (e) { /* 进程可能已经退出 */ }

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
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    try {
      const id = await createTerminalProcess(config, cwd, cols, rows, ownerWindow, event.sender);
      return { success: true, id };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(Channels.TERMINAL_DISPOSE, async (_event, { id }) => {
    disposeTerminalProcess({ id });
    return { success: true };
  });

  ipcMain.handle(Channels.TERMINAL_INPUT, async (_event, { id, data }) => {
    const term = terminals.get(id);
    sendInput(id, data);
    // 广播模式：同窗口其他终端同步输入
    if (term && term.ownerWindow && broadcastModeByWindow.get(term.ownerWindow)) {
      for (const [otherId, other] of terminals) {
        if (otherId !== id && other.ownerWindow === term.ownerWindow) {
          sendInput(otherId, data);
        }
      }
    }
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
    const term = terminals.get(id);
    if (!term || term.exited) return { success: false };
    try {
      // 1. 直接向终端渲染进程发送清屏转义序列，清空屏幕和滚动缓冲区
      if (term.ownerWebContents && !term.ownerWebContents.isDestroyed()) {
        term.ownerWebContents.send(Channels.TERMINAL_OUTPUT, {
          id,
          type: 'data',
          data: '\x1b[2J\x1b[3J\x1b[H',
        });
      }
      // 2. 给 PTY 发送 Ctrl-L，触发 shell 的 clear-screen 小部件重新打印提示符
      if (term.pty && !term.exited) {
        term.pty.write('\x0c');
      }
    } catch (e) {
      console.warn('[TerminalHandler] 清屏失败:', e.message);
    }
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

  // 设置当前窗口的广播模式
  ipcMain.handle(Channels.TERMINAL_SET_BROADCAST_MODE, async (event, { enabled }) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (ownerWindow) {
      broadcastModeByWindow.set(ownerWindow, !!enabled);
    }
    return { success: true };
  });

  console.log('[TerminalHandler] 终端 IPC 处理器已注册');
}

module.exports = { registerTerminalHandlers };
