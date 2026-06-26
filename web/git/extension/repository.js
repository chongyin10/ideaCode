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
const { parseStatus } = require('./statusParser');

const STATUS_POLL_INTERVAL = 2000;       // 空闲时定期刷新
const FAST_POLL_INTERVAL = 500;          // 操作后快速刷新窗口
const FAST_POLL_DURATION = 5000;          // 快速刷新持续时间
const WATCHER_DEBOUNCE_MS = 300;          // 文件变更去抖，避免频繁刷 git status

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
    const { code, stderr } = await execGit(args, { cwd: this.rootPath });
    if (code !== 0) throw new GitError(`stage failed: ${stderr}`);
    await this.refresh();
    this._fastPoll();
    return { success: true };
  }

  async unstage(paths) {
    if (!paths || paths.length === 0) return { success: true };
    const args = ['reset', 'HEAD', '--', ...paths];
    const { code, stderr } = await execGit(args, { cwd: this.rootPath });
    if (code !== 0) throw new GitError(`unstage failed: ${stderr}`);
    await this.refresh();
    this._fastPoll();
    return { success: true };
  }

  async stageAll() {
    const { code, stderr } = await execGit(['add', '-A'], { cwd: this.rootPath });
    if (code !== 0) throw new GitError(`stageAll failed: ${stderr}`);
    await this.refresh();
    this._fastPoll();
    return { success: true };
  }

  async unstageAll() {
    const { code, stderr } = await execGit(['reset', 'HEAD'], { cwd: this.rootPath });
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
    const { code, stdout, stderr } = await execGit(args, { cwd: this.rootPath });
    if (code !== 0) throw new GitError(`commit failed: ${stderr || stdout}`, { stdout, stderr, code });
    await this.refresh();
    this._fastPoll();
    return { success: true, message: stdout };
  }

  async discard(paths) {
    if (!paths || paths.length === 0) return { success: true };
    const args = ['checkout', '--', ...paths];
    const { code, stderr } = await execGit(args, { cwd: this.rootPath });
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
    const { code, stderr } = await execGit(['checkout', name], { cwd: this.rootPath });
    if (code !== 0) throw new GitError(`checkout failed: ${stderr}`);
    await this.refresh();
    this._fastPoll();
    return { success: true };
  }

  async createBranch(name, startPoint) {
    const args = ['checkout', '-b', name];
    if (startPoint) args.push(startPoint);
    const { code, stderr } = await execGit(args, { cwd: this.rootPath });
    if (code !== 0) throw new GitError(`createBranch failed: ${stderr}`);
    await this.refresh();
    this._fastPoll();
    return { success: true };
  }

  async deleteBranch(name, force = false) {
    const args = ['branch', force ? '-D' : '-d', name];
    const { code, stderr } = await execGit(args, { cwd: this.rootPath });
    if (code !== 0) throw new GitError(`deleteBranch failed: ${stderr}`);
    await this.refresh();
    return { success: true };
  }

  async listBranches() {
    const { code, stdout, stderr } = await execGit(
      ['for-each-ref', '--format=%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(upstream:track)', 'refs/heads'],
      { cwd: this.rootPath }
    );
    if (code !== 0) throw new GitError(`listBranches failed: ${stderr}`);
    const branches = [];
    for (const line of stdout.split('\n')) {
      if (!line) continue;
      const [name, head, upstream, track] = line.split('\t');
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
      });
    }
    // 远程分支
    const { code: rc, stdout: rOut } = await execGit(
      ['for-each-ref', '--format=%(refname:short)%09%(upstream:track)', 'refs/remotes'],
      { cwd: this.rootPath }
    );
    if (rc === 0) {
      for (const line of rOut.split('\n')) {
        if (!line) continue;
        const [name, track] = line.split('\t');
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
    const { code, stdout, stderr } = await execGit(args, { cwd: this.rootPath, timeout: 120000 });
    if (code !== 0) throw new GitError(`push failed: ${stderr || stdout}`, { stdout, stderr, code });
    await this.refresh();
    return { success: true, output: stdout };
  }

  async pull(remote, branch) {
    const args = ['pull'];
    if (remote) args.push(remote);
    if (branch) args.push(branch);
    const { code, stdout, stderr } = await execGit(args, { cwd: this.rootPath, timeout: 120000 });
    if (code !== 0) throw new GitError(`pull failed: ${stderr || stdout}`, { stdout, stderr, code });
    await this.refresh();
    return { success: true, output: stdout };
  }

  async fetch(remote) {
    const args = ['fetch'];
    if (remote) args.push(remote);
    else args.push('--all');
    const { code, stdout, stderr } = await execGit(args, { cwd: this.rootPath, timeout: 120000 });
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
 * 向上查找 git 仓库根
 * @param {string} startPath
 * @returns {string|null}
 */
function findRepoRoot(startPath) {
  let dir = path.resolve(startPath);
  while (true) {
    const gitPath = path.join(dir, '.git');
    try {
      const stat = fs.statSync(gitPath);
      if (stat.isDirectory() || stat.isFile()) {
        return dir;
      }
    } catch {
      // 不存在，继续向上
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

module.exports = { Repository, findRepoRoot, GitError };