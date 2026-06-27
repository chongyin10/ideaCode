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
 * 按仓库根目录分组的串行化队列。
 *
 * 同一仓库内的 git 命令串行执行，避免 discard / refresh / fastPoll 等并发
 * 操作争抢 `.git/index.lock`；不同仓库之间互不阻塞。
 * 灵感来自 VS Code git 扩展的 askpass / exec 串行化策略。
 *
 * @type {Map<string, Promise<void>>}
 */
const _gitQueues = new Map();

/**
 * 执行单个 git 子进程（不含队列逻辑）
 * @param {string[]} args
 * @param {object} options
 * @returns {Promise<{ stdout: string; stderr: string; code: number }>}
 */
function _spawnGit(args, options) {
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
 * 执行 git 命令并返回结果。
 *
 * 同一 `options.cwd` 下的命令会按调用顺序串行执行，防止并发修改 index
 * 导致 `Unable to create '.git/index.lock': File exists`。
 *
 * @param {string[]} args
 * @param {object} options
 * @param {string} options.cwd - 工作目录（仓库根），用于队列分组
 * @param {number} [options.timeout] - 超时毫秒数
 * @param {string} [options.input] - stdin 输入
 * @param {Record<string, string>} [options.env] - 额外环境变量
 * @returns {Promise<{ stdout: string; stderr: string; code: number }>}
 */
function execGit(args, options = {}) {
  const cwd = options.cwd;

  // 无 cwd（如 git --version）的命令不进队列，直接执行
  if (!cwd) {
    return _spawnGit(args, options);
  }

  const run = () => _spawnGit(args, options);

  let queue = _gitQueues.get(cwd);
  if (!queue) {
    queue = Promise.resolve();
  }

  // 无论前一个命令成功或失败，都继续执行下一个（then 第二参数 = onRejected）
  const result = queue.then(run, run);

  // 更新队列尾：result 完成后清空错误，避免一个失败阻塞后续所有命令
  const nextTail = result.then(
    () => undefined,
    () => undefined
  );
  _gitQueues.set(cwd, nextTail);

  return result;
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