/**
 * Repository - 单一 Git 仓库的状态与操作封装
 *
 * 灵感来自 VS Code 的 vscode.git 扩展的 Repository 类。
 * 核心职责：
 *   - 跟踪当前 HEAD、分支、工作区状态
 *   - 提供 stage / unstage / commit / discard / push / pull 等操作
 *   - 监听 .git 目录和工作区变更，自动刷新状态
 *   - 通过 onDidChange 事件向 UI 推送状态
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execGit, git, GitError } = require('./gitCLI');
const { parseStatus, DEFAULT_IGNORE_DIRS } = require('./statusParser');

// 兜底轮询间隔：fs.watch 已覆盖 99% 实时场景，这里仅作 fs.watch 漏报兜底。
// 从 2s 放宽到 30s，避免与 fs.watch 重复触发导致 git status 子进程执行 2~3 次/保存。
const STATUS_POLL_INTERVAL = 30000;
const FAST_POLL_INTERVAL = 500;          // 操作后快速刷新窗口
const FAST_POLL_DURATION = 5000;          // 快速刷新持续时间
const WATCHER_DEBOUNCE_MS = 300;          // 文件变更去抖，避免频繁刷 git status
const STALE_LOCK_THRESHOLD_MS = 30000;     // 超过此时间的 index.lock 视为残留并清理

class Repository {
  /**
   * @param {string} rootPath 仓库根目录的绝对路径
   */
  constructor(rootPath) {
    this.rootPath = rootPath;
    /** @type {import('./statusParser').GitStatus} */
    this.state = {
      staged: [], changes: [], merge: [], untracked: [],
      branch: '', upstream: null, ahead: 0, behind: 0,
    };
    /** @type {Set<(state: any) => void>} */
    this._changeListeners = new Set();
    this._disposed = false;
    this._fastPollTimer = null;
    this._slowPollTimer = null;
    this._refreshInFlight = false;
    this._pendingRefresh = false;
    this._lastError = null;
    /** @type {fs.FSWatcher|null} */
    this._fileWatcher = null;
    /** @type {fs.FSWatcher|null} */
    this._gitWatcher = null;
    /** @type {NodeJS.Timeout|null} */
    this._watcherRefreshTimer = null;

    // 启动文件系统监听，文件变化时实时刷新
    this._setupWatcher();

    // 轮询作为兜底（简单可靠）
    this._watchInterval = setInterval(() => {
      if (this._disposed) return;
      this._maybeRefresh('poll');
    }, STATUS_POLL_INTERVAL);
  }

  /**
   * 启动仓库文件监听
   * - 监听工作区根目录（递归，尽可能实时感知编辑/保存/重命名）
   * - 监听 .git 目录（感知 git index/HEAD 等内部状态变化）
   * - 变更事件经过去抖后触发 refresh
   */
  _setupWatcher() {
    try {
      const watchOptions = { persistent: false };
      // Linux 下 Node 20+ 才支持 recursive
      if (process.platform !== 'linux' || parseInt(process.versions.node, 10) >= 20) {
        watchOptions.recursive = true;
      }

      this._fileWatcher = fs.watch(this.rootPath, watchOptions, (eventType, filename) => {
        if (this._disposed) return;
        if (!filename) return;
        // 忽略 node_modules 与 .git 内部对象目录的频繁变更
        if (filename.includes('node_modules') || filename.includes('.git/objects')) {
          return;
        }
        this._scheduleWatcherRefresh();
      });

      // 单独监听 .git 目录，捕获 index / HEAD / refs 等变更
      const gitDir = path.join(this.rootPath, '.git');
      if (fs.existsSync(gitDir)) {
        this._gitWatcher = fs.watch(gitDir, { persistent: false }, (eventType, filename) => {
          if (this._disposed) return;
          if (!filename) return;
          if (
            filename === 'index' ||
            filename === 'HEAD' ||
            filename === 'FETCH_HEAD' ||
            filename === 'ORIG_HEAD' ||
            filename.startsWith('refs')
          ) {
            this._scheduleWatcherRefresh();
          }
        });
      }
    } catch (err) {
      console.error('[Repository] 启动文件监听器失败:', err.message);
    }
  }

  /** 去抖调度一次由 watcher 触发的刷新 */
  _scheduleWatcherRefresh() {
    if (this._watcherRefreshTimer) {
      clearTimeout(this._watcherRefreshTimer);
    }
    this._watcherRefreshTimer = setTimeout(() => {
      this._watcherRefreshTimer = null;
      if (!this._disposed) {
        this.refresh().catch(() => {});
      }
    }, WATCHER_DEBOUNCE_MS);
  }

  /* ─── 事件订阅 ─── */

  onDidChange(listener) {
    this._changeListeners.add(listener);
    return { dispose: () => this._changeListeners.delete(listener) };
  }

  _fire() {
    for (const fn of this._changeListeners) {
      try { fn(this.state); } catch (e) { console.error('[Repository] listener error:', e); }
    }
  }

  /* ─── 状态查询与刷新 ─── */

  async refresh() {
    if (this._refreshInFlight) {
      this._pendingRefresh = true;
      return;
    }
    this._refreshInFlight = true;
    try {
      await this._doRefresh();
    } finally {
      this._refreshInFlight = false;
      if (this._pendingRefresh) {
        this._pendingRefresh = false;
        // 异步触发，不阻塞当前调用方
        setImmediate(() => this.refresh().catch(() => {}));
      }
    }
  }

  async _doRefresh() {
    try {
      const output = await execGit(
        // --untracked-files=normal：未跟踪目录只报目录级（如 node_modules/），不递归展开其下每个文件。
        // 用 all 会让 node_modules 这类目录刷出几万个 ? 条目，git 子进程慢、状态数据巨大、UI 卡死。
        // 第三方依赖/构建产物目录的进一步过滤见 statusParser.DEFAULT_IGNORE_DIRS。
        ['status', '--porcelain=v2', '--branch', '--untracked-files=normal', '--ignored=no'],
        { cwd: this.rootPath, timeout: 10000 }
      );
      if (output.code !== 0) {
        // 可能在 repo 失效时（如 .git 被删除）
        this._lastError = output.stderr || `exit code ${output.code}`;
        return;
      }
      this.state = parseStatus(output.stdout);
      this._lastError = null;
      this._fire();
    } catch (err) {
      this._lastError = err.message;
    }
  }

  async _maybeRefresh(reason) {
    // 简单策略：每次轮询都刷新一次（避免复杂的 mtime 比较）
    await this.refresh();
  }

  /**
   * 清理超时的 `.git/index.lock` 残留文件。
   *
   * 场景：历史遗留的崩溃 lock、外部 git 进程异常退出、或升级到串行队列前
   * 产生的残留。execGit 已串行化，但首条命令仍可能命中残留 lock，故在
   * 所有写操作前做一次兜底清理。
   *
   * 仅当 lock 文件存在且 mtime 距今超过 STALE_LOCK_THRESHOLD_MS 时才删除，
   * 避免误删外部正在运行的合法 git 进程持有的锁。
   */
  async _cleanupStaleLock() {
    const lockPath = path.join(this.rootPath, '.git', 'index.lock');
    try {
      const stat = await fsp.stat(lockPath);
      const age = Date.now() - stat.mtimeMs;
      if (age > STALE_LOCK_THRESHOLD_MS) {
        await fsp.unlink(lockPath);
        console.warn('[Repository] 清理超时的 .git/index.lock (age=%dms)', age);
      }
    } catch {
      // lock 文件不存在：正常情况，无需处理
    }
  }

  /**
   * 执行会修改 git index 的命令。
   *
   * 与只读命令的区别：执行前先清理 stale lock，避免残留锁导致
   * `Unable to create '.git/index.lock': File exists`。
   */
  async _execGitMutating(args, options = {}) {
    await this._cleanupStaleLock();
    return execGit(args, { cwd: this.rootPath, ...options });
  }

  /** 操作完成后快速刷新一段时间 */
  _fastPoll() {
    if (this._fastPollTimer) clearTimeout(this._fastPollTimer);
    const sinceLast = Date.now() - (this._lastFastPollAt || 0);
    if (sinceLast > FAST_POLL_DURATION) {
      this._lastFastPollAt = Date.now();
    }
    this._fastPollTimer = setTimeout(async () => {
      await this.refresh();
      // 在快速刷新窗口内持续
      if (Date.now() - this._lastFastPollAt < FAST_POLL_DURATION) {
        this._fastPollTimer = setTimeout(() => this._fastPoll(), 500);
      } else {
        this._fastPollTimer = null;
      }
    }, FAST_POLL_INTERVAL);
  }

  /* ─── Git 操作 ─── */

  async stage(paths) {
    if (!paths || paths.length === 0) return { success: true };
    const args = ['add', '--', ...paths];
    const { code, stderr } = await this._execGitMutating(args);
    if (code !== 0) throw new GitError(`stage failed: ${stderr}`);
    await this.refresh();
    this._fastPoll();
    return { success: true };
  }

  async unstage(paths) {
    if (!paths || paths.length === 0) return { success: true };
    const args = ['reset', 'HEAD', '--', ...paths];
    const { code, stderr } = await this._execGitMutating(args);
    if (code !== 0) throw new GitError(`unstage failed: ${stderr}`);
    await this.refresh();
    this._fastPoll();
    return { success: true };
  }

  async stageAll() {
    // 用 pathspec 显式排除默认忽略目录（node_modules/dist/build 等），
    // 避免 git add -A 把第三方依赖几万个文件全部 stage 进暂存区。
    // 与 statusParser.DEFAULT_IGNORE_DIRS 保持一致，确保 stageAll 行为与
    // 源代码管理面板的未跟踪文件过滤口径一致。
    // pathspec `:!./dir` 语法在 git 1.9+ 支持，排除仓库根下的顶层目录。
    const excludeArgs = [...DEFAULT_IGNORE_DIRS].map((d) => `:!./${d}`);
    const args = ['add', '-A', '--', '.', ...excludeArgs];
    const { code, stderr } = await this._execGitMutating(args);
    if (code !== 0) throw new GitError(`stageAll failed: ${stderr}`);
    await this.refresh();
    this._fastPoll();
    return { success: true };
  }

  async unstageAll() {
    const { code, stderr } = await this._execGitMutating(['reset', 'HEAD']);
    if (code !== 0) throw new GitError(`unstageAll failed: ${stderr}`);
    await this.refresh();
    this._fastPoll();
    return { success: true };
  }

  async commit(message, opts = {}) {
    const args = ['commit', '-m', message];
    if (opts.amend) args.push('--amend');
    if (opts.noVerify) args.push('--no-verify');
    if (opts.allowEmpty) args.push('--allow-empty');
    const { code, stdout, stderr } = await this._execGitMutating(args);
    if (code !== 0) throw new GitError(`commit failed: ${stderr || stdout}`, { stdout, stderr, code });
    await this.refresh();
    this._fastPoll();
    return { success: true, message: stdout };
  }

  async discard(paths) {
    if (!paths || paths.length === 0) return { success: true };
    const args = ['checkout', '--', ...paths];
    const { code, stderr } = await this._execGitMutating(args);
    if (code !== 0) throw new GitError(`discard failed: ${stderr}`);
    await this.refresh();
    this._fastPoll();
    return { success: true };
  }

  async deleteUntracked(paths) {
    if (!paths || paths.length === 0) return { success: true };
    // 使用 rm -f 逐个删除（比 git clean 更安全，避免误删）
    for (const p of paths) {
      const full = path.join(this.rootPath, p);
      try {
        const stat = await fsp.lstat(full);
        if (stat.isDirectory()) {
          await fsp.rm(full, { recursive: true, force: true });
        } else {
          await fsp.unlink(full);
        }
      } catch (e) {
        // 忽略单个失败
      }
    }
    await this.refresh();
    this._fastPoll();
    return { success: true };
  }

  async checkoutBranch(name) {
    const { code, stderr } = await this._execGitMutating(['checkout', name]);
    if (code !== 0) throw new GitError(`checkout failed: ${stderr}`);
    await this.refresh();
    this._fastPoll();
    return { success: true };
  }

  async createBranch(name, startPoint) {
    const args = ['checkout', '-b', name];
    if (startPoint) args.push(startPoint);
    const { code, stderr } = await this._execGitMutating(args);
    if (code !== 0) throw new GitError(`createBranch failed: ${stderr}`);
    await this.refresh();
    this._fastPoll();
    return { success: true };
  }

  async deleteBranch(name, force = false) {
    const args = ['branch', force ? '-D' : '-d', name];
    const { code, stderr } = await this._execGitMutating(args);
    if (code !== 0) throw new GitError(`deleteBranch failed: ${stderr}`);
    await this.refresh();
    return { success: true };
  }

  async listBranches() {
    const { code, stdout, stderr } = await execGit(
      ['for-each-ref', "--format=%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(upstream:track)%09%(objectname)%09%(objectname:short)%09%(subject)%09%(authordate:unix)%09%(authorname)", 'refs/heads'],
      { cwd: this.rootPath }
    );
    if (code !== 0) throw new GitError(`listBranches failed: ${stderr}`);
    const branches = [];
    for (const line of stdout.split('\n')) {
      if (!line) continue;
      const [name, head, upstream, track, hash, shortHash, subject, timestamp, authorName] = line.split('\t');
      let ahead = 0, behind = 0;
      if (track) {
        const m = track.match(/ahead (\d+)/);
        if (m) ahead = parseInt(m[1], 10);
        const m2 = track.match(/behind (\d+)/);
        if (m2) behind = parseInt(m2[1], 10);
      }
      branches.push({
        name,
        current: head === '*',
        upstream: upstream || null,
        ahead,
        behind,
        isRemote: false,
        lastCommit: hash ? {
          hash,
          shortHash,
          subject: subject || '',
          authorName: authorName || '',
          timestamp: parseInt(timestamp, 10) * 1000,
        } : undefined,
      });
    }
    // 远程分支
    const { code: rc, stdout: rOut } = await execGit(
      ['for-each-ref', "--format=%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(upstream:track)%09%(objectname)%09%(objectname:short)%09%(subject)%09%(authordate:unix)%09%(authorname)", 'refs/remotes'],
      { cwd: this.rootPath }
    );
    if (rc === 0) {
      for (const line of rOut.split('\n')) {
        if (!line) continue;
        const [name, head, upstream, track, hash, shortHash, subject, timestamp, authorName] = line.split('\t');
        if (name.endsWith('/HEAD')) continue;
        let ahead = 0, behind = 0;
        if (track) {
          const m = track.match(/ahead (\d+)/);
          if (m) ahead = parseInt(m[1], 10);
          const m2 = track.match(/behind (\d+)/);
          if (m2) behind = parseInt(m2[1], 10);
        }
        branches.push({
          name,
          current: false,
          upstream: null,
          ahead,
          behind,
          isRemote: true,
          lastCommit: hash ? {
            hash,
            shortHash,
            subject: subject || '',
            authorName: authorName || '',
            timestamp: parseInt(timestamp, 10) * 1000,
          } : undefined,
        });
      }
    }
    return branches;
  }

  async listRemotes() {
    const { code, stdout } = await execGit(['remote', '-v'], { cwd: this.rootPath });
    if (code !== 0) return [];
    const map = new Map();
    for (const line of stdout.split('\n')) {
      if (!line) continue;
      const m = line.match(/^(\S+)\s+(\S+)\s+\((\w+)\)/);
      if (m) {
        const [, name, url, type] = m;
        if (!map.has(name)) map.set(name, { name, url, type });
        else map.get(name).type = type; // fetch + push 都保留后者
      }
    }
    return Array.from(map.values());
  }

  async getLog(count = 50) {
    const format = '%H%x09%h%x09%s%x09%an%x09%ae%x09%at';
    const { code, stdout, stderr } = await execGit(
      ['log', `--pretty=format:${format}`, '-n', String(count)],
      { cwd: this.rootPath }
    );
    if (code !== 0) {
      // 空仓库会失败，返回空数组
      if (/does not have any commits/i.test(stderr)) return [];
      throw new GitError(`log failed: ${stderr}`);
    }
    const commits = [];
    for (const line of stdout.split('\n')) {
      if (!line) continue;
      const [hash, shortHash, subject, authorName, authorEmail, timestamp] = line.split('\t');
      commits.push({ hash, shortHash, subject, authorName, authorEmail, timestamp: parseInt(timestamp, 10) * 1000 });
    }
    return commits;
  }

  async listStashes() {
    const { code, stdout } = await execGit(
      ['stash', 'list', '--pretty=format:%gd%x09%s%x09%ct'],
      { cwd: this.rootPath }
    );
    if (code !== 0) return [];
    const stashes = [];
    for (const line of stdout.split('\n')) {
      if (!line) continue;
      const [ref, message, timestamp] = line.split('\t');
      stashes.push({ ref, message, timestamp: parseInt(timestamp, 10) * 1000 });
    }
    return stashes;
  }

  async push(remote, branch) {
    const args = ['push'];
    if (remote) args.push(remote);
    if (branch) args.push(branch);
    const { code, stdout, stderr } = await this._execGitMutating(args, { timeout: 120000 });
    if (code !== 0) throw new GitError(`push failed: ${stderr || stdout}`, { stdout, stderr, code });
    await this.refresh();
    return { success: true, output: stdout };
  }

  async pull(remote, branch) {
    const args = ['pull'];
    if (remote) args.push(remote);
    if (branch) args.push(branch);
    const { code, stdout, stderr } = await this._execGitMutating(args, { timeout: 120000 });
    if (code !== 0) throw new GitError(`pull failed: ${stderr || stdout}`, { stdout, stderr, code });
    await this.refresh();
    return { success: true, output: stdout };
  }

  async fetch(remote) {
    const args = ['fetch'];
    if (remote) args.push(remote);
    else args.push('--all');
    const { code, stdout, stderr } = await this._execGitMutating(args, { timeout: 120000 });
    if (code !== 0) throw new GitError(`fetch failed: ${stderr || stdout}`, { stdout, stderr, code });
    await this.refresh();
    return { success: true, output: stdout };
  }

  async getRemotes() {
    return this.listRemotes();
  }

  async getOriginalContent(path) {
    const { code, stdout } = await execGit(
      ['show', `HEAD:${path}`],
      { cwd: this.rootPath, timeout: 10000 }
    );
    if (code !== 0) return '';
    return stdout;
  }

  async getDiff(path, staged = false) {
    const args = ['diff', '--no-color'];
    if (staged) args.push('--cached');
    if (path) args.push('--', path);
    const { code, stdout } = await execGit(args, { cwd: this.rootPath, timeout: 15000 });
    if (code !== 0 && code !== 1) return '';
    // code=1 表示有差异（diff 正常返回 1）
    return stdout;
  }

  dispose() {
    this._disposed = true;
    if (this._watchInterval) clearInterval(this._watchInterval);
    if (this._slowPollTimer) clearTimeout(this._slowPollTimer);
    if (this._fastPollTimer) clearTimeout(this._fastPollTimer);
    if (this._watcherRefreshTimer) {
      clearTimeout(this._watcherRefreshTimer);
      this._watcherRefreshTimer = null;
    }
    if (this._fileWatcher) {
      try { this._fileWatcher.close(); } catch { /* ignore */ }
      this._fileWatcher = null;
    }
    if (this._gitWatcher) {
      try { this._gitWatcher.close(); } catch { /* ignore */ }
      this._gitWatcher = null;
    }
    this._changeListeners.clear();
  }
}

/* ─── 仓库根检测 ─── */

/**
 * 检测给定目录自身是否为 git 仓库根。
 *
 * 不再向上级目录遍历查找 .git，避免用户打开一个非 git 项目时，
 * 错误地关联到其父目录（如桌面、文档或某个大工作区）的 git 仓库，
 * 从而显示上一个/其他项目的 git 变更记录。
 *
 * @param {string} startPath
 * @returns {string|null}
 */
function findRepoRoot(startPath) {
  const dir = path.resolve(startPath);
  const gitPath = path.join(dir, '.git');
  try {
    const stat = fs.statSync(gitPath);
    if (stat.isDirectory() || stat.isFile()) {
      return dir;
    }
  } catch {
    // 当前目录不是 git 仓库根
  }
  return null;
}

module.exports = { Repository, findRepoRoot, GitError };