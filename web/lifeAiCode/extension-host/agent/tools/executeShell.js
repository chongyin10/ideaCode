/**
 * Tool: execute_shell
 *
 * 执行 shell 命令并返回**完整输出**（包括 stdout + stderr）。
 * - 优先使用 context.executeShell + context.waitShellCompletion（Extension.js 中的完整实现）
 * - 否则使用内部简化实现（异步 spawn + 累积输出）
 *
 * 输出上限统一 64KB（与 Extension.js 内部一致）；超出部分截断尾部并标记。
 */

const { spawn } = require('child_process');
const path = require('path');
const MAX_OUTPUT_BYTES = 64 * 1024; // 与 Extension.js 内的 MAX_OUTPUT_BYTES 一致

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
  // Bug 12: 补全危险命令清单：原列表遗漏 rm -rf 系统目录、chmod -R 777 /、
  // shutdown/reboot/halt/poweroff、rm -rf * 等。
  const dangerousPatterns = [
    { pattern: /rm\s+-rf\s*\//, reason: '递归删除根目录' },
    { pattern: /rm\s+-rf\s+~/, reason: '递归删除用户目录' },
    { pattern: /rm\s+-rf\s+\/(home|usr|var|etc|boot|bin|sbin|lib|root|opt|proc|sys)\b/, reason: '递归删除系统目录' },
    { pattern: /rm\s+-rf\s+\*/, reason: '递归删除当前目录所有文件' },
    { pattern: /chmod\s+-R\s+777\s+\//, reason: '递归修改根目录权限' },
    { pattern: /mkfs/, reason: '格式化文件系统' },
    { pattern: /:(){ :|:& };:/, reason: 'fork 炸弹' },
    { pattern: />\s*\/dev\/[sh]d[a-z]/, reason: '直接写入磁盘设备' },
    { pattern: /dd\s+if=.*of=\/dev/, reason: 'dd 写入设备' },
    { pattern: /curl\s+.*\|\s*(ba)?sh/, reason: 'curl 管道执行 shell' },
    { pattern: /wget\s+.*\|\s*(ba)?sh/, reason: 'wget 管道执行 shell' },
    { pattern: /\bformat\s+/i, reason: '格式化命令' },
    { pattern: /diskpart/i, reason: 'Windows 磁盘分区工具' },
    { pattern: /\bshutdown\b/, reason: '关机命令' },
    { pattern: /\breboot\b/, reason: '重启命令' },
    { pattern: /\bhalt\b/, reason: '停机命令' },
    { pattern: /\bpoweroff\b/, reason: '关机命令' },
    { pattern: /\biptables\s+-F\b/, reason: '清空防火墙规则' },
  ];
  for (const { pattern, reason } of dangerousPatterns) {
    if (pattern.test(command)) {
      return { success: false, error: `检测到危险命令（${reason}），已拦截: ${command}` };
    }
  }

  // 优先使用 context 中的完整实现
  if (typeof context.executeShell === 'function' && typeof context.waitShellCompletion === 'function') {
    const shellId = `agent-shell-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    try {
      // 触发执行（不 await — 走实时流式输出到 webview）
      context.executeShell(shellId, command, workingDir);
      // 等待完成 + 拿到完整输出
      const result = await context.waitShellCompletion(shellId, timeout);
      return {
        success: result.success === true,
        command,
        cwd: workingDir,
        exitCode: result.exitCode,
        signal: result.signal,
        output: typeof result.output === 'string' ? truncateOutput(result.output) : '',
        error: result.error,
        shellId,
      };
    } catch (err) {
      return { success: false, error: `执行命令失败: ${err.message}` };
    }
  }

  // 内部简化实现（fallback）
  return runInternal(command, workingDir, timeout);
}

/**
 * 截断输出到 64KB，保留尾部并标记
 * Bug 13: 原代码用 output.length（字符数）和 MAX_OUTPUT_BYTES（字节数）比较，
 * 对多字节 UTF-8 字符（如中文）会低估实际字节数，导致超长输出未被截断。
 * 改用 Buffer.byteLength 按字节判断，并按字节边界截断。
 */
function truncateOutput(output) {
  const byteLen = Buffer.byteLength(output, 'utf8');
  if (byteLen <= MAX_OUTPUT_BYTES) return output;
  const buf = Buffer.from(output, 'utf8');
  // 保留尾部 MAX_OUTPUT_BYTES 字节；toString('utf8') 会自动处理被截断的多字节字符
  const tail = buf.slice(buf.length - MAX_OUTPUT_BYTES).toString('utf8');
  return '…(输出过长，已截断)…\n' + tail;
}

function runInternal(command, workingDir, timeout) {
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
    const killTimer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      }, 2000);
    }, timeout);

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    proc.on('error', (err) => {
      clearTimeout(killTimer);
      resolve({ success: false, error: err.message });
    });

    proc.on('close', (code, signal) => {
      clearTimeout(killTimer);
      const output = stdout + (stderr ? `\n${stderr}` : '');
      resolve({
        success: code === 0,
        command,
        cwd: workingDir,
        exitCode: code ?? undefined,
        signal: signal ?? undefined,
        output: truncateOutput(output),
      });
    });
  });
}

module.exports = executeShell;
