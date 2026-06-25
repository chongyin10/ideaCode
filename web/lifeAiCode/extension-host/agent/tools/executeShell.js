/**
 * Tool: execute_shell
 *
 * 执行 shell 命令并返回输出。
 * 优先使用 context.executeShell（Extension.js 中的完整实现）。
 * 否则使用内部简化实现。
 */

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

async function executeShell(args, context) {
  const { command, cwd, timeout = 60000 } = args || {};
  if (!command || typeof command !== 'string') {
    return { success: false, error: '缺少 command 参数' };
  }

  const workspaceRoot = context.workspaceRoot || '';
  let workingDir = cwd || workspaceRoot || process.cwd();
  if (!path.isAbsolute(workingDir) && workspaceRoot) {
    workingDir = path.join(workspaceRoot, workingDir);
  }
  workingDir = path.resolve(workingDir);

  // 路径边界检查
  if (workspaceRoot && !workingDir.startsWith(path.resolve(workspaceRoot))) {
    return { success: false, error: `拒绝在工作区外执行命令: ${cwd}` };
  }

  // 危险命令检查
  const normalizedCommand = command.toLowerCase().trim();
  const dangerousPatterns = [
    { pattern: /rm\s+-rf\s*\//, reason: '递归删除根目录' },
    { pattern: /rm\s+-rf\s+~/, reason: '递归删除用户目录' },
    { pattern: /mkfs/, reason: '格式化文件系统' },
    { pattern: /:(){ :|:& };:/, reason: 'fork 炸弹' },
    { pattern: />\s*\/dev\/[sh]d[a-z]/, reason: '直接写入磁盘设备' },
    { pattern: /dd\s+if=.*of=\/dev/, reason: 'dd 写入设备' },
    { pattern: /curl\s+.*\|\s*(ba)?sh/, reason: 'curl 管道执行 shell' },
    { pattern: /wget\s+.*\|\s*(ba)?sh/, reason: 'wget 管道执行 shell' },
    { pattern: /\bformat\s+/i, reason: '格式化命令' },
    { pattern: /diskpart/i, reason: 'Windows 磁盘分区工具' },
  ];
  for (const { pattern, reason } of dangerousPatterns) {
    if (pattern.test(command)) {
      return { success: false, error: `检测到危险命令（${reason}），已拦截: ${command}` };
    }
  }

  // 如果 context 提供了完整的 executeShell，直接调用
  if (typeof context.executeShell === 'function') {
    const shellId = `agent-shell-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    try {
      context.executeShell(shellId, command, workingDir);
      // 由于 executeShellCommand 是异步推送，这里同步返回提示
      return {
        success: true,
        command,
        cwd: workingDir,
        note: '命令已在后台执行，输出将实时显示在聊天窗口中',
        shellId,
      };
    } catch (err) {
      return { success: false, error: `执行命令失败: ${err.message}` };
    }
  }

  // 内部简化实现
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/sh';
    const shellArgs = isWindows ? ['/c', command] : ['-c', command];

    let proc;
    try {
      proc = spawn(shell, shellArgs, {
        cwd: workingDir,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        windowsHide: true,
      });
    } catch (err) {
      resolve({ success: false, error: `启动进程失败: ${err.message}` });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timeoutId;

    const killTimeout = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      }, 2000);
    }, timeout);

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    proc.on('error', (err) => {
      clearTimeout(killTimeout);
      resolve({ success: false, error: err.message });
    });

    proc.on('close', (code, signal) => {
      clearTimeout(killTimeout);
      const output = stdout + (stderr ? `\n${stderr}` : '');
      const MAX_OUTPUT = 32 * 1024;
      const finalOutput = output.length > MAX_OUTPUT
        ? '…（输出过长，已截断）…\n' + output.slice(-MAX_OUTPUT)
        : output;

      resolve({
        success: code === 0,
        command,
        cwd: workingDir,
        exitCode: code ?? undefined,
        signal: signal ?? undefined,
        output: finalOutput,
      });
    });
  });
}

module.exports = executeShell;
