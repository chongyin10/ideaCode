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

/**
 * §远程 git 命令参数转义：将单个参数安全引号化，防止 SSH 执行时 shell 解析错误。
 * 安全字符（字母、数字、常见符号）直接返回；含空格/特殊字符的用单引号包裹。
 */
function shellEscapeArg(arg) {
  if (/^[a-zA-Z0-9_\-./=,@:%+]+$/.test(arg)) return arg;
  return "'" + String(arg).replace(/'/g, "'\\''") + "'";
}

// 兜底轮询间隔：fs.watch 已覆盖 99% 实时场景，这里仅作 fs.watch 漏报兜底。
// 从 2s 放宽到 30s，避免与 fs.watch 重复触发导致 git status 子进程执行 2~3 次/保存。
const STATUS_POLL_INTERVAL = 30000;
// §远程仓库无 fs.watch，轮询是唯一刷新手段，但每次轮询触发多次 SSH execute，
// 30s 太频繁会导致 CPU 占用高。远程仓库使用 60s 间隔。
const REMOTE_STATUS_POLL_INTERVAL = 60000;
const FAST_POLL_INTERVAL = 500;          // 操作后快速刷新窗口
const FAST_POLL_DURATION = 5000;          // 快速刷新持续时间
const WATCHER_DEBOUNCE_MS = 300;          // 文件变更去抖，避免频繁刷 git status
const STALE_LOCK_THRESHOLD_MS = 30000;     // 超过此时间的 index.lock 视为残留并清理

class Repository {
  /**
   * @param {string} rootPath 仓库根目录的绝对路径
   * @param {object} [options]
   * @param {function} [options.remoteExecutor] 远程命令执行器 (command, cwd) => { stdout, stderr, code }
   *   传入时所有 git 命令通过 SSH 在远程主机执行，跳过本地 fs.watch / lock 清理
   */
  constructor(rootPath, options = {}) {
    this.rootPath = rootPath;
    this._remoteExecutor = options.remoteExecutor || null;
    this._isRemote = !!this._remoteExecutor;
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
    /** @type {boolean} 标记 .git/index 是否已用 watchFile 监听，dispose 时 unwatchFile */
    this._indexWatched = false;

    // 远程仓库不使用 fs.watch（路径在远程主机上），仅靠轮询
    if (!this._isRemote) {
      this._setupWatcher();
    }

    // §轮询作为兜底（简单可靠）。远程仓库使用更长间隔（60s），
    // 因为每次轮询通过 SSH 执行多次 git 命令，频繁轮询会导致 CPU 占用高。
    const pollInterval = this._isRemote ? REMOTE_STATUS_POLL_INTERVAL : STATUS_POLL_INTERVAL;
    this._watchInterval = setInterval(() => {
      if (this._disposed) return;
      this._maybeRefresh('poll');
    }, pollInterval);
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

        // §macOS 兼容：fs.watch 对 .git/index 的 rename 操作监听不可靠。
        // git add/commit 等命令会写入 index.lock 再 rename 为 index，FSEvents 可能漏报，
        // 导致终端执行 git 命令后 SCM 面板不刷新。
        // 用 fs.watchFile（基于 stat 轮询）补充监听 index 文件的 mtime 变化，可靠兜底。
        // §间隔设为 5s（而非默认 2s）：配合 --no-optional-locks 避免循环，5s 足够及时且开销低。
        const indexPath = path.join(gitDir, 'index');
        if (fs.existsSync(indexPath)) {
          this._indexWatched = true;
          fs.watchFile(indexPath, { persistent: false, interval: 5000 }, (curr, prev) => {
            if (this._disposed) return;
            if (curr.mtimeMs !== prev.mtimeMs) {
              this._scheduleWatcherRefresh();
            }
          });
        }
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

  /**
   * §统一的 git 命令执行入口。
   * 本地仓库：spawn 本地 git 二进制；远程仓库：通过 remoteExecutor 在 SSH 主机上执行。
   * @param {string[]} args git 子命令参数
   * @param {object} [options] { cwd, timeout, input, env }
   * @returns {Promise<{ stdout: string; stderr: string; code: number }>}
   */
  async _execGit(args, options = {}) {
    if (this._remoteExecutor) {
      // §ssh.internal.execute 默认非 PTY 模式，不会触发分页器。
      // 保留 --no-pager 和 GIT_PAGER=cat 作为双重保险。
      // §options.cwd 用于子模块操作：子模块的 git 命令需要在子模块目录下执行。
      // §options.env 中的变量作为命令前缀传递给远程 SSH 执行（如 GIT_OPTIONAL_LOCKS=0）。
      const cwd = options.cwd || this.rootPath;
      const cmd = ['git', '--no-pager', ...args.map(shellEscapeArg)].join(' ');
      const envPrefix = options.env
        ? Object.entries(options.env).map(([k, v]) => `${k}=${shellEscapeArg(String(v))}`).join(' ') + ' '
        : '';
      const result = await this._remoteExecutor(`${envPrefix}GIT_PAGER=cat ${cmd}`, cwd);
      return result;
    }
    return execGit(args, { cwd: this.rootPath, ...options });
  }

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
      // §保存旧状态的快照，用于 refresh 后比较是否有变化。
      // 状态没变化时不触发 _fire()，避免无意义的 webview 推送和日志输出。
      const oldStateSnapshot = this._stateSnapshot;
      const output = await this._execGit(
        // §关键修复：GIT_OPTIONAL_LOCKS=0 阻止 git 获取 index 锁和更新 stat 缓存。
        // 不加此选项时 git status 会修改 .git/index 的 mtime（更新 stat 缓存），
        // 导致 fs.watchFile 检测到变化 → 触发 refresh → 再次 git status → 再次修改 index → 无限循环。
        // 用环境变量而非 --no-optional-locks 命令行选项，兼容 git 2.8+（命令行选项需 2.15+）。
        // --untracked-files=normal：未跟踪目录只报目录级（如 node_modules/），不递归展开其下每个文件。
        // 用 all 会让 node_modules 这类目录刷出几万个 ? 条目，git 子进程慢、状态数据巨大、UI 卡死。
        // 第三方依赖/构建产物目录的进一步过滤见 statusParser.DEFAULT_IGNORE_DIRS。
        ['status', '--porcelain=v2', '--branch', '--untracked-files=normal', '--ignored=no'],
        { timeout: 10000, env: { GIT_OPTIONAL_LOCKS: '0' } }
      );
      if (output.code !== 0) {
        // 可能在 repo 失效时（如 .git 被删除）
        this._lastError = output.stderr || `exit code ${output.code}`;
        return;
      }
      this.state = parseStatus(output.stdout);
      this._lastError = null;

      // §为主仓库的所有变更打上仓库标记，UI 据此分组渲染。
      const mainRepoName = path.basename(this.rootPath);
      const mainBranch = this.state.branch;
      const tagMain = (c) => {
        if (!c.repoPath) {
          c.repoPath = this.rootPath;
          c.repoName = mainRepoName;
          c.repoBranch = mainBranch;
        }
      };
      this.state.staged.forEach(tagMain);
      this.state.changes.forEach(tagMain);
      this.state.merge.forEach(tagMain);
      this.state.untracked.forEach(tagMain);

      // §获取子模块内部文件变更并合并到 state 中。
      // 父仓库的 git status 只能看到子模块指针变更（sub > 0），
      // 子模块内部的文件增删改需要 cd 进子模块目录单独执行 git status。
      await this._refreshSubmodules();

      // §状态变化检测：用 JSON 序列化比较新旧状态。
      // 如果状态没变化（相同的 staged/changes/untracked/branch），跳过 _fire()，
      // 避免 watchFile 或 fastPoll 触发的无变化 refresh 导致 UI 闪烁和卡顿。
      const newSnapshot = JSON.stringify({
        s: this.state.staged, c: this.state.changes,
        m: this.state.merge, u: this.state.untracked,
        b: this.state.branch, u2: this.state.upstream,
        a: this.state.ahead, d: this.state.behind,
      });
      this._stateSnapshot = newSnapshot;
      if (oldStateSnapshot && oldStateSnapshot === newSnapshot) {
        return; // 状态无变化，跳过推送
      }
      this._fire();
    } catch (err) {
      this._lastError = err.message;
    }
  }

  /**
   * §获取子模块列表。
   * 解析 `git submodule status` 输出，返回 { path, name } 数组。
   * 跳过未初始化的子模块（状态字符为 '-'），因为其目录无 .git 无法执行 git status。
   * @returns {Promise<Array<{path: string, name: string}>>}
   */
  async _getSubmodules() {
    const { code, stdout } = await this._execGit(['submodule', 'status'], {});
    if (code !== 0 || !stdout) return [];
    const subs = [];
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      // 格式：<statusChar><40-char-sha> <path> (<describe>)
      // statusChar: space=clean, +=different commit, -=not initialized, U=merge conflicts
      const statusChar = line[0];
      if (statusChar === '-') continue; // 未初始化，跳过
      const rest = line.slice(1).trim();
      const spaceIdx = rest.indexOf(' ');
      if (spaceIdx === -1) continue;
      const remaining = rest.slice(spaceIdx + 1);
      // 去掉末尾的 (describe) 部分
      const subPath = remaining.split(' (')[0].trim();
      if (subPath) {
        subs.push({ path: subPath, name: subPath.split('/').pop() });
      }
    }
    return subs;
  }

  /**
   * §获取所有子模块的内部文件变更，合并到 this.state 中。
   *
   * 对每个子模块：
   *   1. 在子模块目录下执行 git status --porcelain=v2 --branch
   *   2. 解析子模块状态
   *   3. 为每条变更打上 { repoPath, repoName, repoBranch } 标记
   *   4. 合并到主仓库的 staged/changes/merge/untracked 数组中
   *
   * 子模块内部的路径是相对于子模块根的，UI 分组后用户能正确理解文件归属。
   * 后续 stage/unstage/discard 等操作通过 repoPath（cwd）在正确的仓库下执行。
   */
  async _refreshSubmodules() {
    let submodules;
    try {
      submodules = await this._getSubmodules();
    } catch {
      return; // 获取子模块失败（如非 git 仓库），静默跳过
    }
    if (submodules.length === 0) return;

    for (const sub of submodules) {
      try {
        const subCwd = path.join(this.rootPath, sub.path);
        const output = await this._execGit(
          ['status', '--porcelain=v2', '--branch', '--untracked-files=normal', '--ignored=no'],
          { cwd: subCwd, timeout: 10000 }
        );
        if (output.code !== 0) continue;
        const subStatus = parseStatus(output.stdout);

        // 为子模块的所有变更打上子模块仓库标记
        const tagSub = (c) => {
          c.repoPath = subCwd;
          c.repoName = sub.name;
          c.repoBranch = subStatus.branch || '';
        };
        subStatus.staged.forEach(tagSub);
        subStatus.changes.forEach(tagSub);
        subStatus.merge.forEach(tagSub);
        subStatus.untracked.forEach(tagSub);

        // 合并到主仓库 state
        this.state.staged.push(...subStatus.staged);
        this.state.changes.push(...subStatus.changes);
        this.state.merge.push(...subStatus.merge);
        this.state.untracked.push(...subStatus.untracked);
      } catch {
        // 单个子模块状态获取失败，静默跳过不影响主仓库
      }
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
    // 远程仓库跳过本地 lock 清理（文件在远程主机上）
    if (this._isRemote) return;
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
    return this._execGit(args, options);
  }

  /** 操作完成后快速刷新一段时间 */
  _fastPoll() {
    // §远程仓库跳过快速轮询：每次 refresh 触发多次 SSH execute，
    // 500ms 间隔的快速轮询会导致 SSH 命令密集执行，CPU 飙升。
    // 远程仓库操作后单次 refresh 已足够，不需要 fastPoll 补偿。
    if (this._isRemote) return;
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

  async stage(paths, cwd) {
    if (!paths || paths.length === 0) return { success: true };
    const args = ['add', '--', ...paths];
    const { code, stderr } = await this._execGitMutating(args, cwd ? { cwd } : {});
    if (code !== 0) throw new GitError(`stage failed: ${stderr}`);
    await this.refresh();
    this._fastPoll();
    return { success: true };
  }

  async unstage(paths, cwd) {
    if (!paths || paths.length === 0) return { success: true };
    const args = ['reset', 'HEAD', '--', ...paths];
    const { code, stderr } = await this._execGitMutating(args, cwd ? { cwd } : {});
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
    // §对每个子模块也执行 stageAll，确保子模块内的文件变更也被暂存
    try {
      const submodules = await this._getSubmodules();
      for (const sub of submodules) {
        try {
          const subCwd = path.join(this.rootPath, sub.path);
          await this._execGitMutating(args, { cwd: subCwd });
        } catch { /* 忽略单个子模块失败 */ }
      }
    } catch { /* 忽略子模块枚举失败 */ }
    await this.refresh();
    this._fastPoll();
    return { success: true };
  }

  async unstageAll() {
    const { code, stderr } = await this._execGitMutating(['reset', 'HEAD']);
    if (code !== 0) throw new GitError(`unstageAll failed: ${stderr}`);
    // §对每个子模块也执行 unstageAll
    try {
      const submodules = await this._getSubmodules();
      for (const sub of submodules) {
        try {
          const subCwd = path.join(this.rootPath, sub.path);
          await this._execGitMutating(['reset', 'HEAD'], { cwd: subCwd });
        } catch { /* 忽略单个子模块失败 */ }
      }
    } catch { /* 忽略子模块枚举失败 */ }
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

  async discard(paths, cwd) {
    if (!paths || paths.length === 0) return { success: true };
    const args = ['checkout', '--', ...paths];
    const { code, stderr } = await this._execGitMutating(args, cwd ? { cwd } : {});
    if (code !== 0) throw new GitError(`discard failed: ${stderr}`);
    await this.refresh();
    this._fastPoll();
    return { success: true };
  }

  async deleteUntracked(paths, cwd) {
    if (!paths || paths.length === 0) return { success: true };
    const baseCwd = cwd || this.rootPath;
    if (this._isRemote) {
      // §远程：通过 SSH 执行 rm -rf 删除未跟踪文件
      for (const p of paths) {
        try {
          await this._remoteExecutor(`rm -rf -- ${shellEscapeArg(p)}`, baseCwd);
        } catch { /* 忽略单个失败 */ }
      }
      await this.refresh();
      this._fastPoll();
      return { success: true };
    }
    // 本地：使用 rm -f 逐个删除（比 git clean 更安全，避免误删）
    for (const p of paths) {
      const full = path.join(baseCwd, p);
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

  /**
   * §读取工作区文件内容（用于 diff 视图的 modified 端）。
   * 本地：fs.readFileSync；远程：通过 SSH cat 读取。
   * @param {string} relPath 相对仓库根的路径
   * @param {string} [cwd] 子模块的绝对路径（操作子模块内文件时传入）
   * @returns {Promise<{ content: string; isBinary: boolean }>}
   */
  async readFile(relPath, cwd) {
    const baseCwd = cwd || this.rootPath;
    if (this._isRemote) {
      // §ssh.internal.execute 默认非 PTY 模式，stdout 干净可靠。
      // 命令失败时 stdout 为空，等价于返回空内容。
      const { stdout } = await this._remoteExecutor(
        `cat -- ${shellEscapeArg(relPath)}`, baseCwd
      );
      const isBinary = stdout.includes('\0');
      return { content: isBinary ? '' : stdout, isBinary };
    }
    const full = path.join(baseCwd, relPath);
    const buf = fs.readFileSync(full);
    const isBinary = buf.includes(0);
    return { content: isBinary ? '' : buf.toString('utf8'), isBinary };
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
    const { code, stdout, stderr } = await this._execGit(
      ['for-each-ref', "--format=%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(upstream:track)%09%(objectname)%09%(objectname:short)%09%(subject)%09%(authordate:unix)%09%(authorname)", 'refs/heads'],
      {}
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
    const { code: rc, stdout: rOut } = await this._execGit(
      ['for-each-ref', "--format=%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(upstream:track)%09%(objectname)%09%(objectname:short)%09%(subject)%09%(authordate:unix)%09%(authorname)", 'refs/remotes'],
      {}
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
    const { code, stdout } = await this._execGit(['remote', '-v'], {});
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
    const { code, stdout, stderr } = await this._execGit(
      ['log', `--pretty=format:${format}`, '-n', String(count)],
      {}
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
    const { code, stdout } = await this._execGit(
      ['stash', 'list', '--pretty=format:%gd%x09%s%x09%ct'],
      {}
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

  async getOriginalContent(filePath, cwd) {
    // §ssh.internal.execute 默认非 PTY 模式，stdout 干净可靠。
    // 命令失败时（如路径不在 HEAD 中）stdout 为空，等价于返回空内容。
    // §cwd 用于子模块：子模块内文件的 HEAD 版本需要在子模块目录下执行 git show。
    const { stdout } = await this._execGit(
      ['show', `HEAD:${filePath}`],
      { cwd, timeout: 10000 }
    );
    return stdout;
  }

  async getDiff(filePath, staged = false, cwd) {
    const args = ['diff', '--no-color'];
    if (staged) args.push('--cached');
    if (filePath) args.push('--', filePath);
    const { code, stdout } = await this._execGit(args, { cwd, timeout: 15000 });
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
    // 清理 .git/index 的 watchFile 监听
    if (this._indexWatched) {
      try { fs.unwatchFile(path.join(this.rootPath, '.git', 'index')); } catch { /* ignore */ }
      this._indexWatched = false;
    }
    this._changeListeners.clear();
  }

  /**
   * §按需激活机制：暂停轮询和定时器。
   *
   * 当源代码管理面板不可见时调用，停止所有轮询（远程仓库的 SSH execute 降为 0）。
   * 本地仓库的 fs.watch 保持运行（零成本），仅暂停轮询兜底。
   * 不 dispose Repository 实例，保持状态缓存，resume 后立即可用。
   */
  pause() {
    if (this._disposed) return;
    if (this._watchInterval) {
      clearInterval(this._watchInterval);
      this._watchInterval = null;
    }
    if (this._slowPollTimer) {
      clearTimeout(this._slowPollTimer);
      this._slowPollTimer = null;
    }
    if (this._fastPollTimer) {
      clearTimeout(this._fastPollTimer);
      this._fastPollTimer = null;
    }
  }

  /**
   * §按需激活机制：恢复轮询并立即刷新一次。
   *
   * 当源代码管理面板重新可见时调用，恢复轮询定时器并立即触发一次 refresh，
   * 让用户立即看到最新状态（面板不可见期间可能有变更）。
   */
  resume() {
    if (this._disposed) return;
    if (!this._watchInterval) {
      const pollInterval = this._isRemote ? REMOTE_STATUS_POLL_INTERVAL : STATUS_POLL_INTERVAL;
      this._watchInterval = setInterval(() => {
        if (this._disposed) return;
        this._maybeRefresh('poll');
      }, pollInterval);
    }
    // 立即触发一次刷新，同步面板不可见期间的变更
    this._maybeRefresh('resume');
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