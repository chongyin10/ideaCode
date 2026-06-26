/**
 * Git CLI Wrapper
 *
 * 封装所有对 `git` 命令行工具的调用。
 * - 统一的错误处理（永不抛出，全部返回 { stdout, stderr, code }）
 * - 可配置超时
 * - 支持自定义环境变量
 *
 * 灵感来自 VS Code 的 vscode.git 扩展（git.ts → Git CLI 封装层）
 */

const { spawn } = require('child_process');

const DEFAULT_TIMEOUT = 30000;

class GitError extends Error {
  constructor(message, { stdout, stderr, code, gitErrorCode } = {}) {
    super(message);
    this.stdout = stdout;
    this.stderr = stderr;
    this.code = code;
    this.gitErrorCode = gitErrorCode;
  }
}

/**
 * 执行 git 命令并返回结果
 * @param {string[]} args
 * @param {object} options
 * @param {string} options.cwd - 工作目录（仓库根）
 * @param {number} [options.timeout] - 超时毫秒数
 * @param {string} [options.input] - stdin 输入
 * @param {Record<string, string>} [options.env] - 额外环境变量
 * @returns {Promise<{ stdout: string; stderr: string; code: number }>}
 */
function execGit(args, options = {}) {
  return new Promise((resolve) => {
    const { cwd, timeout = DEFAULT_TIMEOUT, input, env } = options;

    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, ...(env || {}), GIT_TERMINAL_PROMPT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        resolve({
          stdout: '',
          stderr: `git ${args[0]} timeout after ${timeout}ms`,
          code: -1,
        });
      }
    }, timeout);

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr || err.message, code: -1 });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });

    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

/**
 * 带抛错的版本：返回 stdout，失败时抛出 GitError
 */
async function git(args, options = {}) {
  const { stdout, stderr, code } = await execGit(args, options);
  if (code !== 0) {
    throw new GitError(
      `git ${args.join(' ')} failed (exit ${code}): ${stderr.trim() || stdout.trim()}`,
      { stdout, stderr, code }
    );
  }
  return stdout;
}

/**
 * 检测 git 是否可用
 */
async function isGitAvailable() {
  const { code } = await execGit(['--version'], { timeout: 5000 });
  return code === 0;
}

module.exports = { execGit, git, GitError, isGitAvailable };