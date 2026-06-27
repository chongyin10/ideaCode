var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// api.js
var require_api = __commonJS({
  "api.js"(exports2, module2) {
    var EventEmitter = class {
      constructor() {
        this._listeners = /* @__PURE__ */ new Set();
      }
      fire(data) {
        for (const listener of this._listeners) {
          try {
            listener(data);
          } catch {
          }
        }
      }
      get event() {
        const self = this;
        return function(listener) {
          self._listeners.add(listener);
          return { dispose: () => self._listeners.delete(listener) };
        };
      }
    };
    var send2 = (method, params) => {
      if (typeof process !== "undefined" && process.send) {
        process.send({ jsonrpc: "2.0", method, params });
      }
    };
    function request(method, params = {}) {
      return new Promise((resolve, reject) => {
        if (typeof process === "undefined" || !process.send) {
          reject(new Error("Extension Host not connected"));
          return;
        }
        const id = Date.now() + Math.random();
        const handler = (msg) => {
          if (msg && msg.id === id) {
            process.removeListener("message", handler);
            if (msg.error) reject(new Error(msg.error.message || msg.error));
            else resolve(msg.result);
          }
        };
        process.on("message", handler);
        process.send({ jsonrpc: "2.0", id, method, params });
        setTimeout(() => {
          process.removeListener("message", handler);
          reject(new Error(`RPC timeout: ${method}`));
        }, 3e4);
      });
    }
    var vscode2 = {
      window: {
        showInformationMessage: (message) => send2("window.showInformationMessage", { message }),
        showErrorMessage: (message) => send2("window.showErrorMessage", { message }),
        showWarningMessage: (message) => send2("window.showWarningMessage", { message }),
        createWebviewPanel: (viewType, title, _showOptions, options) => {
          const panelId = `git-webview-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
          send2("webview.create", {
            id: panelId,
            viewType,
            title,
            options
          });
          return {
            id: panelId,
            viewType,
            title,
            webview: {
              _html: "",
              get html() {
                return this._html;
              },
              set html(value) {
                this._html = value;
                send2("webview.setHtml", { id: panelId, html: value });
              },
              options: options || {},
              cspSource: "ideacode-webview-resource:",
              postMessage: (message) => send2("webview.postMessage", { id: panelId, message }),
              onDidReceiveMessage: (callback) => {
                if (!global._gitWebviewHandlers) global._gitWebviewHandlers = /* @__PURE__ */ new Map();
                if (!global._gitWebviewHandlers.has(panelId)) {
                  global._gitWebviewHandlers.set(panelId, []);
                }
                global._gitWebviewHandlers.get(panelId).push(callback);
                return { dispose: () => {
                } };
              },
              asWebviewUri: (localResource) => `ideacode-webview-resource://${localResource.fsPath}`
            },
            onDidDispose: (callback) => ({ dispose: () => {
            } }),
            onDidChangeViewState: (callback) => ({ dispose: () => {
            } }),
            reveal: () => send2("webview.reveal", { id: panelId }),
            dispose: () => send2("webview.dispose", { id: panelId })
          };
        }
      },
      workspace: {
        getConfiguration: () => ({
          get: (key, defaultValue) => defaultValue,
          update: () => Promise.resolve()
        }),
        /**
         * 获取当前工作区根路径（直接 RPC 调用，会转发到渲染进程查询 Redux state）
         */
        getRootPath: () => request("workspace.getRootPath"),
        getWorkspaceFolders: () => request("workspace.getFolders").then((r) => r || []),
        onDidChangeWorkspaceFolders: (_callback) => ({ dispose: () => {
        } })
      },
      commands: {
        registerCommand: (command, handler) => {
          if (!global._gitCommandHandlers) global._gitCommandHandlers = /* @__PURE__ */ new Map();
          global._gitCommandHandlers.set(command, handler);
          return { dispose: () => global._gitCommandHandlers?.delete(command) };
        },
        executeCommand: (command, ...args) => {
          if (global._gitCommandHandlers && global._gitCommandHandlers.has(command)) {
            return Promise.resolve(global._gitCommandHandlers.get(command)(...args));
          }
          return new Promise((resolve, reject) => {
            const id = Date.now() + Math.random();
            const handler = (msg) => {
              if (msg.id === id) {
                process.removeListener("message", handler);
                if (msg.error) reject(new Error(msg.error.message));
                else resolve(msg.result);
              }
            };
            process.on("message", handler);
            if (typeof process !== "undefined" && process.send) {
              process.send({ jsonrpc: "2.0", id, method: "commands.execute", params: { command, args } });
            }
            setTimeout(() => {
              process.removeListener("message", handler);
              reject(new Error(`Command execution timeout: ${command}`));
            }, 3e4);
          });
        }
      },
      Uri: {
        file: (path2) => ({ fsPath: path2, scheme: "file" }),
        parse: (uri) => {
          const match = uri.match(/^([^:]+):\/\/(.+)$/);
          return match ? { scheme: match[1], fsPath: match[2] } : { scheme: "file", fsPath: uri };
        }
      },
      env: {
        appName: "IDEACODE",
        appRoot: typeof process !== "undefined" ? process.cwd() : "",
        shell: process.env.SHELL || ""
      },
      version: "1.0.0",
      EventEmitter,
      Disposable: class Disposable {
        constructor(fn) {
          this._fn = fn;
        }
        dispose() {
          if (this._fn) {
            try {
              this._fn();
            } catch {
            }
            this._fn = null;
          }
        }
        static from(...disposables) {
          return new Disposable(() => {
            for (const d of disposables) {
              try {
                d.dispose();
              } catch {
              }
            }
          });
        }
      }
    };
    if (typeof process !== "undefined") {
      process.on("message", (msg) => {
        if (msg && msg.method === "webview.message" && msg.params) {
          const { id, message } = msg.params;
          const handlers = global._gitWebviewHandlers?.get(id);
          if (handlers) {
            for (const h of handlers) {
              try {
                h(message);
              } catch (e) {
                console.error("[Git] webview handler error:", e);
              }
            }
          }
        }
      });
    }
    module2.exports = vscode2;
    module2.exports.request = request;
    module2.exports.send = send2;
  }
});

// gitCLI.js
var require_gitCLI = __commonJS({
  "gitCLI.js"(exports2, module2) {
    var { spawn } = require("child_process");
    var DEFAULT_TIMEOUT = 3e4;
    var GitError2 = class extends Error {
      constructor(message, { stdout, stderr, code, gitErrorCode } = {}) {
        super(message);
        this.stdout = stdout;
        this.stderr = stderr;
        this.code = code;
        this.gitErrorCode = gitErrorCode;
      }
    };
    var _gitQueues = /* @__PURE__ */ new Map();
    function _spawnGit(args, options) {
      return new Promise((resolve) => {
        const { cwd, timeout = DEFAULT_TIMEOUT, input, env } = options;
        let stdout = "";
        let stderr = "";
        let settled = false;
        const child = spawn("git", args, {
          cwd,
          env: { ...process.env, ...env || {}, GIT_TERMINAL_PROMPT: "0" },
          stdio: ["pipe", "pipe", "pipe"]
        });
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            try {
              child.kill("SIGTERM");
            } catch {
            }
            resolve({
              stdout: "",
              stderr: `git ${args[0]} timeout after ${timeout}ms`,
              code: -1
            });
          }
        }, timeout);
        child.stdout.on("data", (data) => {
          stdout += data.toString();
        });
        child.stderr.on("data", (data) => {
          stderr += data.toString();
        });
        child.on("error", (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ stdout, stderr: stderr || err.message, code: -1 });
        });
        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ stdout, stderr, code: code ?? -1 });
        });
        if (input !== void 0) {
          child.stdin.end(input);
        } else {
          child.stdin.end();
        }
      });
    }
    function execGit(args, options = {}) {
      const cwd = options.cwd;
      if (!cwd) {
        return _spawnGit(args, options);
      }
      const run = () => _spawnGit(args, options);
      let queue = _gitQueues.get(cwd);
      if (!queue) {
        queue = Promise.resolve();
      }
      const result = queue.then(run, run);
      const nextTail = result.then(
        () => void 0,
        () => void 0
      );
      _gitQueues.set(cwd, nextTail);
      return result;
    }
    async function git(args, options = {}) {
      const { stdout, stderr, code } = await execGit(args, options);
      if (code !== 0) {
        throw new GitError2(
          `git ${args.join(" ")} failed (exit ${code}): ${stderr.trim() || stdout.trim()}`,
          { stdout, stderr, code }
        );
      }
      return stdout;
    }
    async function isGitAvailable2() {
      const { code } = await execGit(["--version"], { timeout: 5e3 });
      return code === 0;
    }
    module2.exports = { execGit, git, GitError: GitError2, isGitAvailable: isGitAvailable2 };
  }
});

// statusParser.js
var require_statusParser = __commonJS({
  "statusParser.js"(exports2, module2) {
    var INDEX_STATUS = {
      M: "modified",
      A: "added",
      D: "deleted",
      R: "renamed",
      C: "copied",
      U: "unmerged",
      T: "type-changed"
    };
    var WORKING_STATUS = {
      M: "modified",
      D: "deleted",
      R: "renamed",
      C: "copied",
      U: "unmerged",
      T: "type-changed"
    };
    function parseStatus(output) {
      const status = {
        staged: [],
        changes: [],
        merge: [],
        untracked: [],
        branch: "",
        upstream: null,
        ahead: 0,
        behind: 0
      };
      const lines = output.split("\n");
      let i = 0;
      for (; i < lines.length; i++) {
        const line = lines[i];
        if (!line.startsWith("#")) break;
        if (line.startsWith("# branch.head ")) {
          const head = line.slice("# branch.head ".length).trim();
          status.branch = head === "(detached)" ? "" : head;
        } else if (line.startsWith("# branch.upstream ")) {
          const upstream = line.slice("# branch.upstream ".length).trim();
          status.upstream = upstream === "(none)" ? null : upstream;
        } else if (line.startsWith("# branch.ab ")) {
          const ab = line.slice("# branch.ab ".length).trim();
          const m = ab.match(/^([+-])(\d+)\s+([+-])(\d+)/);
          if (m) {
            status.ahead = parseInt(m[2], 10);
            status.behind = parseInt(m[4], 10);
          }
        }
      }
      for (; i < lines.length; i++) {
        const line = lines[i];
        if (!line || line.startsWith("#")) continue;
        if (line.startsWith("? ")) {
          const untrackedPath = line.slice(2);
          if (untrackedPath.endsWith("/")) continue;
          status.untracked.push({
            path: untrackedPath,
            originalPath: null,
            indexStatus: "untracked",
            workingStatus: "untracked"
          });
          continue;
        }
        if (line.startsWith("! ")) continue;
        if (line.startsWith("1 ")) {
          const parts = line.split(" ");
          if (parts.length < 9) continue;
          const xy = parts[1];
          const path2 = parts.slice(8).join(" ");
          const indexChar = xy[0] === "." ? " " : xy[0];
          const workingChar = xy[1] === "." ? " " : xy[1];
          let originalPath = null;
          const next = lines[i + 1];
          if (next && next.startsWith("2 ")) {
          }
          const indexStatus = INDEX_STATUS[indexChar];
          const workingStatus = WORKING_STATUS[workingChar];
          if (indexChar === "U" || workingChar === "U" || indexChar === "A" && workingChar === "A" || indexChar === "D" && workingChar === "D") {
            status.merge.push({
              path: path2,
              originalPath: null,
              indexStatus: indexChar,
              workingStatus: workingChar
            });
            continue;
          }
          const change = {
            path: path2,
            originalPath: null,
            indexStatus: indexChar,
            workingStatus: workingChar
          };
          if (indexChar !== " " && indexChar !== "?") {
            status.staged.push(change);
          }
          if (workingChar !== " " && workingChar !== "?") {
            status.changes.push(change);
          }
        } else if (line.startsWith("2 ")) {
          const parts = line.split(" ");
          if (parts.length < 10) continue;
          const xy = parts[1];
          const indexChar = xy[0] === "." ? " " : xy[0];
          const workingChar = xy[1] === "." ? " " : xy[1];
          const path2 = parts.slice(9).join(" ");
          const originalPath = null;
          const change = {
            path: path2,
            originalPath,
            indexStatus: indexChar,
            workingStatus: workingChar
          };
          if (indexChar !== " ") {
            status.staged.push(change);
          }
          if (workingChar !== " ") {
            status.changes.push(change);
          }
        }
      }
      return status;
    }
    function toLegacyShape(status) {
      const staged = {};
      const changes = {};
      const merge = {};
      const untracked = {};
      for (const c of status.staged) {
        staged[c.path] = statusToCode2(c.indexStatus);
      }
      for (const c of status.changes) {
        changes[c.path] = statusToCode2(c.workingStatus);
      }
      for (const c of status.merge) {
        merge[c.path] = "U";
      }
      for (const c of status.untracked) {
        untracked[c.path] = "U";
      }
      return { staged, changes, merge, untracked };
    }
    function statusToCode2(s) {
      return s[0]?.toUpperCase() || "M";
    }
    module2.exports = { parseStatus, toLegacyShape };
  }
});

// repository.js
var require_repository = __commonJS({
  "repository.js"(exports2, module2) {
    var fs2 = require("fs");
    var fsp = fs2.promises;
    var path2 = require("path");
    var { execGit, git, GitError: GitError2 } = require_gitCLI();
    var { parseStatus } = require_statusParser();
    var STATUS_POLL_INTERVAL = 3e4;
    var FAST_POLL_INTERVAL = 500;
    var FAST_POLL_DURATION = 5e3;
    var WATCHER_DEBOUNCE_MS = 300;
    var STALE_LOCK_THRESHOLD_MS = 3e4;
    var Repository2 = class {
      /**
       * @param {string} rootPath 仓库根目录的绝对路径
       */
      constructor(rootPath) {
        this.rootPath = rootPath;
        this.state = {
          staged: [],
          changes: [],
          merge: [],
          untracked: [],
          branch: "",
          upstream: null,
          ahead: 0,
          behind: 0
        };
        this._changeListeners = /* @__PURE__ */ new Set();
        this._disposed = false;
        this._fastPollTimer = null;
        this._slowPollTimer = null;
        this._refreshInFlight = false;
        this._pendingRefresh = false;
        this._lastError = null;
        this._fileWatcher = null;
        this._gitWatcher = null;
        this._watcherRefreshTimer = null;
        this._setupWatcher();
        this._watchInterval = setInterval(() => {
          if (this._disposed) return;
          this._maybeRefresh("poll");
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
          if (process.platform !== "linux" || parseInt(process.versions.node, 10) >= 20) {
            watchOptions.recursive = true;
          }
          this._fileWatcher = fs2.watch(this.rootPath, watchOptions, (eventType, filename) => {
            if (this._disposed) return;
            if (!filename) return;
            if (filename.includes("node_modules") || filename.includes(".git/objects")) {
              return;
            }
            this._scheduleWatcherRefresh();
          });
          const gitDir = path2.join(this.rootPath, ".git");
          if (fs2.existsSync(gitDir)) {
            this._gitWatcher = fs2.watch(gitDir, { persistent: false }, (eventType, filename) => {
              if (this._disposed) return;
              if (!filename) return;
              if (filename === "index" || filename === "HEAD" || filename === "FETCH_HEAD" || filename === "ORIG_HEAD" || filename.startsWith("refs")) {
                this._scheduleWatcherRefresh();
              }
            });
          }
        } catch (err) {
          console.error("[Repository] \u542F\u52A8\u6587\u4EF6\u76D1\u542C\u5668\u5931\u8D25:", err.message);
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
            this.refresh().catch(() => {
            });
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
          try {
            fn(this.state);
          } catch (e) {
            console.error("[Repository] listener error:", e);
          }
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
            setImmediate(() => this.refresh().catch(() => {
            }));
          }
        }
      }
      async _doRefresh() {
        try {
          const output = await execGit(
            ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "--ignored=no"],
            { cwd: this.rootPath, timeout: 1e4 }
          );
          if (output.code !== 0) {
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
        const lockPath = path2.join(this.rootPath, ".git", "index.lock");
        try {
          const stat = await fsp.stat(lockPath);
          const age = Date.now() - stat.mtimeMs;
          if (age > STALE_LOCK_THRESHOLD_MS) {
            await fsp.unlink(lockPath);
            console.warn("[Repository] \u6E05\u7406\u8D85\u65F6\u7684 .git/index.lock (age=%dms)", age);
          }
        } catch {
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
        const args = ["add", "--", ...paths];
        const { code, stderr } = await this._execGitMutating(args);
        if (code !== 0) throw new GitError2(`stage failed: ${stderr}`);
        await this.refresh();
        this._fastPoll();
        return { success: true };
      }
      async unstage(paths) {
        if (!paths || paths.length === 0) return { success: true };
        const args = ["reset", "HEAD", "--", ...paths];
        const { code, stderr } = await this._execGitMutating(args);
        if (code !== 0) throw new GitError2(`unstage failed: ${stderr}`);
        await this.refresh();
        this._fastPoll();
        return { success: true };
      }
      async stageAll() {
        const { code, stderr } = await this._execGitMutating(["add", "-A"]);
        if (code !== 0) throw new GitError2(`stageAll failed: ${stderr}`);
        await this.refresh();
        this._fastPoll();
        return { success: true };
      }
      async unstageAll() {
        const { code, stderr } = await this._execGitMutating(["reset", "HEAD"]);
        if (code !== 0) throw new GitError2(`unstageAll failed: ${stderr}`);
        await this.refresh();
        this._fastPoll();
        return { success: true };
      }
      async commit(message, opts = {}) {
        const args = ["commit", "-m", message];
        if (opts.amend) args.push("--amend");
        if (opts.noVerify) args.push("--no-verify");
        if (opts.allowEmpty) args.push("--allow-empty");
        const { code, stdout, stderr } = await this._execGitMutating(args);
        if (code !== 0) throw new GitError2(`commit failed: ${stderr || stdout}`, { stdout, stderr, code });
        await this.refresh();
        this._fastPoll();
        return { success: true, message: stdout };
      }
      async discard(paths) {
        if (!paths || paths.length === 0) return { success: true };
        const args = ["checkout", "--", ...paths];
        const { code, stderr } = await this._execGitMutating(args);
        if (code !== 0) throw new GitError2(`discard failed: ${stderr}`);
        await this.refresh();
        this._fastPoll();
        return { success: true };
      }
      async deleteUntracked(paths) {
        if (!paths || paths.length === 0) return { success: true };
        for (const p of paths) {
          const full = path2.join(this.rootPath, p);
          try {
            const stat = await fsp.lstat(full);
            if (stat.isDirectory()) {
              await fsp.rm(full, { recursive: true, force: true });
            } else {
              await fsp.unlink(full);
            }
          } catch (e) {
          }
        }
        await this.refresh();
        this._fastPoll();
        return { success: true };
      }
      async checkoutBranch(name) {
        const { code, stderr } = await this._execGitMutating(["checkout", name]);
        if (code !== 0) throw new GitError2(`checkout failed: ${stderr}`);
        await this.refresh();
        this._fastPoll();
        return { success: true };
      }
      async createBranch(name, startPoint) {
        const args = ["checkout", "-b", name];
        if (startPoint) args.push(startPoint);
        const { code, stderr } = await this._execGitMutating(args);
        if (code !== 0) throw new GitError2(`createBranch failed: ${stderr}`);
        await this.refresh();
        this._fastPoll();
        return { success: true };
      }
      async deleteBranch(name, force = false) {
        const args = ["branch", force ? "-D" : "-d", name];
        const { code, stderr } = await this._execGitMutating(args);
        if (code !== 0) throw new GitError2(`deleteBranch failed: ${stderr}`);
        await this.refresh();
        return { success: true };
      }
      async listBranches() {
        const { code, stdout, stderr } = await execGit(
          ["for-each-ref", "--format=%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(upstream:track)%09%(objectname)%09%(objectname:short)%09%(subject)%09%(authordate:unix)%09%(authorname)", "refs/heads"],
          { cwd: this.rootPath }
        );
        if (code !== 0) throw new GitError2(`listBranches failed: ${stderr}`);
        const branches = [];
        for (const line of stdout.split("\n")) {
          if (!line) continue;
          const [name, head, upstream, track, hash, shortHash, subject, timestamp, authorName] = line.split("	");
          let ahead = 0, behind = 0;
          if (track) {
            const m = track.match(/ahead (\d+)/);
            if (m) ahead = parseInt(m[1], 10);
            const m2 = track.match(/behind (\d+)/);
            if (m2) behind = parseInt(m2[1], 10);
          }
          branches.push({
            name,
            current: head === "*",
            upstream: upstream || null,
            ahead,
            behind,
            isRemote: false,
            lastCommit: hash ? {
              hash,
              shortHash,
              subject: subject || "",
              authorName: authorName || "",
              timestamp: parseInt(timestamp, 10) * 1e3
            } : void 0
          });
        }
        const { code: rc, stdout: rOut } = await execGit(
          ["for-each-ref", "--format=%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(upstream:track)%09%(objectname)%09%(objectname:short)%09%(subject)%09%(authordate:unix)%09%(authorname)", "refs/remotes"],
          { cwd: this.rootPath }
        );
        if (rc === 0) {
          for (const line of rOut.split("\n")) {
            if (!line) continue;
            const [name, head, upstream, track, hash, shortHash, subject, timestamp, authorName] = line.split("	");
            if (name.endsWith("/HEAD")) continue;
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
                subject: subject || "",
                authorName: authorName || "",
                timestamp: parseInt(timestamp, 10) * 1e3
              } : void 0
            });
          }
        }
        return branches;
      }
      async listRemotes() {
        const { code, stdout } = await execGit(["remote", "-v"], { cwd: this.rootPath });
        if (code !== 0) return [];
        const map = /* @__PURE__ */ new Map();
        for (const line of stdout.split("\n")) {
          if (!line) continue;
          const m = line.match(/^(\S+)\s+(\S+)\s+\((\w+)\)/);
          if (m) {
            const [, name, url, type] = m;
            if (!map.has(name)) map.set(name, { name, url, type });
            else map.get(name).type = type;
          }
        }
        return Array.from(map.values());
      }
      async getLog(count = 50) {
        const format = "%H%x09%h%x09%s%x09%an%x09%ae%x09%at";
        const { code, stdout, stderr } = await execGit(
          ["log", `--pretty=format:${format}`, "-n", String(count)],
          { cwd: this.rootPath }
        );
        if (code !== 0) {
          if (/does not have any commits/i.test(stderr)) return [];
          throw new GitError2(`log failed: ${stderr}`);
        }
        const commits = [];
        for (const line of stdout.split("\n")) {
          if (!line) continue;
          const [hash, shortHash, subject, authorName, authorEmail, timestamp] = line.split("	");
          commits.push({ hash, shortHash, subject, authorName, authorEmail, timestamp: parseInt(timestamp, 10) * 1e3 });
        }
        return commits;
      }
      async listStashes() {
        const { code, stdout } = await execGit(
          ["stash", "list", "--pretty=format:%gd%x09%s%x09%ct"],
          { cwd: this.rootPath }
        );
        if (code !== 0) return [];
        const stashes = [];
        for (const line of stdout.split("\n")) {
          if (!line) continue;
          const [ref, message, timestamp] = line.split("	");
          stashes.push({ ref, message, timestamp: parseInt(timestamp, 10) * 1e3 });
        }
        return stashes;
      }
      async push(remote, branch) {
        const args = ["push"];
        if (remote) args.push(remote);
        if (branch) args.push(branch);
        const { code, stdout, stderr } = await this._execGitMutating(args, { timeout: 12e4 });
        if (code !== 0) throw new GitError2(`push failed: ${stderr || stdout}`, { stdout, stderr, code });
        await this.refresh();
        return { success: true, output: stdout };
      }
      async pull(remote, branch) {
        const args = ["pull"];
        if (remote) args.push(remote);
        if (branch) args.push(branch);
        const { code, stdout, stderr } = await this._execGitMutating(args, { timeout: 12e4 });
        if (code !== 0) throw new GitError2(`pull failed: ${stderr || stdout}`, { stdout, stderr, code });
        await this.refresh();
        return { success: true, output: stdout };
      }
      async fetch(remote) {
        const args = ["fetch"];
        if (remote) args.push(remote);
        else args.push("--all");
        const { code, stdout, stderr } = await this._execGitMutating(args, { timeout: 12e4 });
        if (code !== 0) throw new GitError2(`fetch failed: ${stderr || stdout}`, { stdout, stderr, code });
        await this.refresh();
        return { success: true, output: stdout };
      }
      async getRemotes() {
        return this.listRemotes();
      }
      async getOriginalContent(path3) {
        const { code, stdout } = await execGit(
          ["show", `HEAD:${path3}`],
          { cwd: this.rootPath, timeout: 1e4 }
        );
        if (code !== 0) return "";
        return stdout;
      }
      async getDiff(path3, staged = false) {
        const args = ["diff", "--no-color"];
        if (staged) args.push("--cached");
        if (path3) args.push("--", path3);
        const { code, stdout } = await execGit(args, { cwd: this.rootPath, timeout: 15e3 });
        if (code !== 0 && code !== 1) return "";
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
          try {
            this._fileWatcher.close();
          } catch {
          }
          this._fileWatcher = null;
        }
        if (this._gitWatcher) {
          try {
            this._gitWatcher.close();
          } catch {
          }
          this._gitWatcher = null;
        }
        this._changeListeners.clear();
      }
    };
    function findRepoRoot2(startPath) {
      let dir = path2.resolve(startPath);
      while (true) {
        const gitPath = path2.join(dir, ".git");
        try {
          const stat = fs2.statSync(gitPath);
          if (stat.isDirectory() || stat.isFile()) {
            return dir;
          }
        } catch {
        }
        const parent = path2.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
      }
    }
    module2.exports = { Repository: Repository2, findRepoRoot: findRepoRoot2, GitError: GitError2 };
  }
});

// extension.js
var fs = require("fs");
var path = require("path");
var vscode = require_api();
var { Repository, findRepoRoot, GitError } = require_repository();
var { isGitAvailable } = require_gitCLI();
var { request: sendRpc, send } = require_api();
var currentRepo = null;
var currentRootPath = null;
var webviewPanel = null;
var gitAvailable = true;
var activeFile = { path: null, staged: null };
var lastOpenedFile = { path: null, staged: null, time: 0 };
var workspaceChangeTimer = null;
function getWebviewHtml(extensionPath) {
  const htmlPath = path.join(extensionPath, "webview", "index.html");
  try {
    let html = fs.readFileSync(htmlPath, "utf-8");
    html = html.replace(/<link[^>]*rel="stylesheet"[^>]*href="(?:\.\/|\/)assets\/([^"]+)"[^>]*>/g, (match, filename) => {
      const cssPath = path.join(extensionPath, "webview", "assets", filename);
      try {
        const css = fs.readFileSync(cssPath, "utf-8");
        return `<style>${css}</style>`;
      } catch {
        return match;
      }
    });
    html = html.replace(/<script[^>]*type="module"[^>]*src="(?:\.\/|\/)assets\/([^"]+)"[^>]*><\/script>/g, (match, filename) => {
      const jsPath = path.join(extensionPath, "webview", "assets", filename);
      try {
        const js = fs.readFileSync(jsPath, "utf-8");
        return `<script type="module">${js}</script>`;
      } catch {
        return match;
      }
    });
    return html;
  } catch (err) {
    console.error("[Git Extension] \u8BFB\u53D6 WebView HTML \u5931\u8D25:", err.message);
    return `<html><body style="color:#fff;background:#1e1e1e;padding:20px;font-family:sans-serif;">
      <h1>Source Control</h1>
      <p>WebView \u8D44\u6E90\u672A\u627E\u5230\u3002\u8BF7\u8FD0\u884C\uFF1A</p>
      <pre>cd web/git && npm run build</pre>
    </body></html>`;
  }
}
function statusToCode(s) {
  if (!s || s === " " || s === "untracked") return "";
  const c = String(s)[0].toUpperCase();
  if (c === "T") return "M";
  if (["M", "A", "D", "R", "C", "U"].includes(c)) return c;
  return "";
}
function buildStatusMap(state) {
  if (!state) return {};
  const map = {};
  const add = (list, codeFn) => {
    for (const c of list || []) {
      const code = codeFn(c);
      if (code) map[c.path] = code;
    }
  };
  add(state.staged, (c) => statusToCode(c.indexStatus));
  add(state.changes, (c) => statusToCode(c.workingStatus));
  add(state.merge, () => "U");
  add(state.untracked, () => "U");
  return map;
}
function pushActiveFile() {
  if (!webviewPanel) return;
  try {
    webviewPanel.webview.postMessage({ type: "activeFile", path: activeFile.path, staged: activeFile.staged });
  } catch (e) {
    console.error("[Git Extension] push active file failed:", e.message);
  }
}
function resolveActiveFileStaged(path2) {
  if (!currentRepo || !path2) return null;
  const state = currentRepo.state;
  const inStaged = state.staged.some((c) => c.path === path2);
  const inUnstaged = state.changes.some((c) => c.path === path2) || state.merge.some((c) => c.path === path2) || state.untracked.some((c) => c.path === path2);
  if (inStaged && !inUnstaged) return true;
  if (!inStaged && inUnstaged) return false;
  if (lastOpenedFile.path === path2 && Date.now() - lastOpenedFile.time < 2e3) {
    return lastOpenedFile.staged;
  }
  return null;
}
function pushState() {
  const state = currentRepo?.state || null;
  try {
    send("git.statusChanged", { status: buildStatusMap(state) });
  } catch (e) {
    console.error("[Git Extension] push git status failed:", e.message);
  }
  try {
    send("git.branchChanged", { branch: state?.branch || "" });
  } catch (e) {
    console.error("[Git Extension] push branch failed:", e.message);
  }
  if (!webviewPanel) return;
  const message = {
    type: "state",
    rootPath: currentRootPath,
    repoRoot: currentRepo?.rootPath || null,
    isRepo: !!currentRepo,
    gitAvailable,
    state,
    lastError: currentRepo?._lastError || null
  };
  try {
    webviewPanel.webview.postMessage(message);
  } catch (e) {
    console.error("[Git Extension] postMessage failed:", e.message);
  }
  if (activeFile.path) {
    activeFile.staged = resolveActiveFileStaged(activeFile.path);
    pushActiveFile();
  }
  const badge = state ? (state.staged?.length || 0) + (state.changes?.length || 0) + (state.merge?.length || 0) + (state.untracked?.length || 0) : 0;
  try {
    send("ui.activityBar.setBadge", { id: "workbench.scm", badge });
  } catch (e) {
    console.error("[Git Extension] setBadge failed:", e.message);
  }
}
function pushBranches() {
  if (!webviewPanel || !currentRepo) return;
  currentRepo.listBranches().then((branches) => {
    try {
      webviewPanel.webview.postMessage({ type: "branches", branches });
    } catch {
    }
  }).catch(() => {
  });
}
function pushLog() {
  if (!webviewPanel || !currentRepo) return;
  currentRepo.getLog(50).then((log) => {
    try {
      webviewPanel.webview.postMessage({ type: "log", log });
    } catch {
    }
  }).catch(() => {
  });
}
function pushStashes() {
  if (!webviewPanel || !currentRepo) return;
  currentRepo.listStashes().then((stashes) => {
    try {
      webviewPanel.webview.postMessage({ type: "stashes", stashes });
    } catch {
    }
  }).catch(() => {
  });
}
async function openRepository(rootPath) {
  if (!rootPath) {
    closeRepository();
    return;
  }
  if (currentRootPath === rootPath && currentRepo) {
    return;
  }
  closeRepository();
  if (typeof rootPath === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(rootPath)) {
    currentRootPath = rootPath;
    currentRepo = null;
    pushState();
    return;
  }
  if (!gitAvailable) {
    currentRootPath = rootPath;
    pushState();
    return;
  }
  const repoRoot = findRepoRoot(rootPath);
  if (!repoRoot) {
    currentRootPath = rootPath;
    currentRepo = null;
    pushState();
    return;
  }
  currentRootPath = rootPath;
  currentRepo = new Repository(repoRoot);
  currentRepo.onDidChange(() => {
    pushState();
    pushBranches();
    pushStashes();
  });
  await currentRepo.refresh();
  pushState();
  pushBranches();
  pushLog();
  pushStashes();
}
function closeRepository() {
  if (currentRepo) {
    currentRepo.dispose();
    currentRepo = null;
  }
  currentRootPath = null;
  pushState();
}
function scheduleOpenForRoot(rootPath) {
  if (workspaceChangeTimer) clearTimeout(workspaceChangeTimer);
  workspaceChangeTimer = setTimeout(() => {
    openRepository(rootPath).catch((e) => {
      console.error("[Git Extension] openRepository failed:", e.message);
    });
  }, 200);
}
async function getCurrentRootPath() {
  try {
    const result = await vscode.workspace.getRootPath();
    return typeof result === "string" ? result : null;
  } catch {
    return null;
  }
}
async function handleWebviewMessage(message) {
  if (!message || typeof message !== "object") return;
  const reply = (payload) => {
    if (!webviewPanel) return;
    try {
      webviewPanel.webview.postMessage({ type: "rpc:reply", id: message.id, ...payload });
    } catch {
    }
  };
  try {
    switch (message.command) {
      case "ready":
        pushState();
        pushBranches();
        pushLog();
        pushStashes();
        reply({ success: true });
        break;
      case "refresh":
        if (currentRepo) {
          await currentRepo.refresh();
          pushState();
          pushBranches();
          pushStashes();
        }
        reply({ success: true });
        break;
      case "stage":
        if (!currentRepo) return reply({ success: false, error: "\u6CA1\u6709\u6253\u5F00\u7684\u4ED3\u5E93" });
        await currentRepo.stage(message.paths || []);
        reply({ success: true });
        break;
      case "unstage":
        if (!currentRepo) return reply({ success: false, error: "\u6CA1\u6709\u6253\u5F00\u7684\u4ED3\u5E93" });
        await currentRepo.unstage(message.paths || []);
        reply({ success: true });
        break;
      case "stageAll":
        if (!currentRepo) return reply({ success: false, error: "\u6CA1\u6709\u6253\u5F00\u7684\u4ED3\u5E93" });
        await currentRepo.stageAll();
        reply({ success: true });
        break;
      case "unstageAll":
        if (!currentRepo) return reply({ success: false, error: "\u6CA1\u6709\u6253\u5F00\u7684\u4ED3\u5E93" });
        await currentRepo.unstageAll();
        reply({ success: true });
        break;
      case "commit": {
        if (!currentRepo) return reply({ success: false, error: "\u6CA1\u6709\u6253\u5F00\u7684\u4ED3\u5E93" });
        const result = await currentRepo.commit(message.message || "", {
          amend: !!message.amend,
          noVerify: !!message.noVerify,
          allowEmpty: !!message.allowEmpty
        });
        reply({ success: true, output: result.message });
        break;
      }
      case "discard": {
        if (!currentRepo) return reply({ success: false, error: "\u6CA1\u6709\u6253\u5F00\u7684\u4ED3\u5E93" });
        const discardPaths = message.paths || [];
        await currentRepo.discard(discardPaths);
        if (discardPaths.length > 0) {
          send("git.filesChanged", { paths: discardPaths });
        }
        reply({ success: true });
        break;
      }
      case "discardAll": {
        if (!currentRepo) return reply({ success: false, error: "\u6CA1\u6709\u6253\u5F00\u7684\u4ED3\u5E93" });
        const paths = currentRepo.state.changes.map((c) => c.path);
        await currentRepo.discard(paths);
        if (paths.length > 0) {
          send("git.filesChanged", { paths });
        }
        reply({ success: true });
        break;
      }
      case "deleteUntracked":
        if (!currentRepo) return reply({ success: false, error: "\u6CA1\u6709\u6253\u5F00\u7684\u4ED3\u5E93" });
        await currentRepo.deleteUntracked(message.paths || []);
        reply({ success: true });
        break;
      case "checkoutBranch":
        if (!currentRepo) return reply({ success: false, error: "\u6CA1\u6709\u6253\u5F00\u7684\u4ED3\u5E93" });
        await currentRepo.checkoutBranch(message.name);
        pushBranches();
        pushLog();
        reply({ success: true });
        break;
      case "createBranch":
        if (!currentRepo) return reply({ success: false, error: "\u6CA1\u6709\u6253\u5F00\u7684\u4ED3\u5E93" });
        await currentRepo.createBranch(message.name, message.startPoint);
        pushBranches();
        reply({ success: true });
        break;
      case "deleteBranch":
        if (!currentRepo) return reply({ success: false, error: "\u6CA1\u6709\u6253\u5F00\u7684\u4ED3\u5E93" });
        await currentRepo.deleteBranch(message.name, !!message.force);
        pushBranches();
        reply({ success: true });
        break;
      case "push":
        if (!currentRepo) return reply({ success: false, error: "\u6CA1\u6709\u6253\u5F00\u7684\u4ED3\u5E93" });
        const pushResult = await currentRepo.push(message.remote, message.branch);
        reply({ success: true, output: pushResult.output });
        break;
      case "pull":
        if (!currentRepo) return reply({ success: false, error: "\u6CA1\u6709\u6253\u5F00\u7684\u4ED3\u5E93" });
        const pullResult = await currentRepo.pull(message.remote, message.branch);
        pushLog();
        reply({ success: true, output: pullResult.output });
        break;
      case "fetch":
        if (!currentRepo) return reply({ success: false, error: "\u6CA1\u6709\u6253\u5F00\u7684\u4ED3\u5E93" });
        await currentRepo.fetch(message.remote);
        pushBranches();
        reply({ success: true });
        break;
      case "getBranches":
        if (!currentRepo) return reply({ success: true, branches: [] });
        const branches = await currentRepo.listBranches();
        reply({ success: true, branches });
        break;
      case "getRemotes":
        if (!currentRepo) return reply({ success: true, remotes: [] });
        const remotes = await currentRepo.listRemotes();
        reply({ success: true, remotes });
        break;
      case "getLog":
        if (!currentRepo) return reply({ success: true, log: [] });
        const log = await currentRepo.getLog(message.count || 50);
        reply({ success: true, log });
        break;
      case "getStashes":
        if (!currentRepo) return reply({ success: true, stashes: [] });
        const stashes = await currentRepo.listStashes();
        reply({ success: true, stashes });
        break;
      case "getDiff":
        if (!currentRepo) return reply({ success: true, diff: "" });
        const diff = await currentRepo.getDiff(message.path, !!message.staged);
        reply({ success: true, diff });
        break;
      case "getOriginalContent":
        if (!currentRepo) return reply({ success: true, content: "" });
        const content = await currentRepo.getOriginalContent(message.path);
        reply({ success: true, content });
        break;
      case "openFile": {
        if (!message.path) return reply({ success: false, error: "\u7F3A\u5C11 path" });
        try {
          let originalContent = "";
          if (currentRepo) {
            try {
              originalContent = await currentRepo.getOriginalContent(message.path) || "";
            } catch (e) {
            }
          }
          let modifiedContent = "";
          let isBinary = false;
          try {
            const repoRoot = currentRepo ? currentRepo.rootPath : currentRootPath;
            const fullPath = path.join(repoRoot || "", message.path);
            const buf = fs.readFileSync(fullPath);
            isBinary = buf.includes(0);
            if (!isBinary) {
              modifiedContent = buf.toString("utf8");
            }
          } catch (e) {
          }
          await sendRpc("git.openFile", {
            path: message.path,
            staged: !!message.staged,
            original: originalContent,
            modified: modifiedContent,
            isBinary
          });
          activeFile = { path: message.path, staged: !!message.staged };
          lastOpenedFile = { path: message.path, staged: !!message.staged, time: Date.now() };
          pushActiveFile();
          reply({ success: true });
        } catch (e) {
          reply({ success: false, error: e.message });
        }
        break;
      }
      case "openRepositoryDialog": {
        try {
          const result = await sendRpc("git.openRepositoryDialog");
          const selected = result?.selected || result || null;
          if (selected) {
            await sendRpc("git.loadDirectory", { path: selected });
          }
          reply({ success: true, selected });
        } catch (e) {
          reply({ success: false, error: e.message });
        }
        break;
      }
      case "initRepository":
        if (!currentRootPath) return reply({ success: false, error: "\u6CA1\u6709\u5DE5\u4F5C\u533A" });
        try {
          await execInit(currentRootPath);
          await openRepository(currentRootPath);
          reply({ success: true });
        } catch (e) {
          reply({ success: false, error: e.message });
        }
        break;
      case "cloneRepository": {
        const { url, targetPath } = message;
        if (!url || !targetPath) return reply({ success: false, error: "\u7F3A\u5C11 url \u6216 targetPath" });
        try {
          await sendRpc("git.clone", { url, targetPath });
          await openRepository(targetPath);
          reply({ success: true });
        } catch (e) {
          reply({ success: false, error: e.message });
        }
        break;
      }
    }
  } catch (err) {
    reply({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}
function execInit(rootPath) {
  const { execGit } = require_gitCLI();
  return execGit(["init"], { cwd: rootPath }).then(({ code, stderr }) => {
    if (code !== 0) throw new Error(stderr || `git init failed (exit ${code})`);
  });
}
async function activate(context) {
  console.log("[Git Extension] \u5DF2\u6FC0\u6D3B");
  gitAvailable = await isGitAvailable();
  if (!gitAvailable) {
    console.warn("[Git Extension] git \u547D\u4EE4\u4E0D\u53EF\u7528\uFF0C\u6269\u5C55\u5C06\u4EE5\u53D7\u9650\u6A21\u5F0F\u8FD0\u884C");
  }
  webviewPanel = vscode.window.createWebviewPanel(
    "git.changesView",
    "\u6E90\u4EE3\u7801\u7BA1\u7406",
    { preserveFocus: true },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      extensionId: "ideacode-git",
      extensionPath: context.extensionPath
    }
  );
  webviewPanel.webview.html = getWebviewHtml(context.extensionPath);
  webviewPanel.webview.onDidReceiveMessage(handleWebviewMessage);
  context.subscriptions.push({
    dispose: () => {
      closeRepository();
      try {
        webviewPanel?.dispose();
      } catch {
      }
      webviewPanel = null;
    }
  });
  setTimeout(async () => {
    const rootPath = await getCurrentRootPath();
    if (rootPath) {
      await openRepository(rootPath);
    }
  }, 300);
  let lastKnownRoot = null;
  const pollTimer = setInterval(async () => {
    try {
      const root = await getCurrentRootPath();
      if (root !== lastKnownRoot) {
        lastKnownRoot = root;
        if (root) {
          scheduleOpenForRoot(root);
        } else {
          closeRepository();
        }
      }
    } catch {
    }
  }, 5e3);
  context.subscriptions.push({
    dispose: () => clearInterval(pollTimer)
  });
}
function deactivate() {
  console.log("[Git Extension] \u5DF2\u505C\u7528");
  closeRepository();
  try {
    webviewPanel?.dispose();
  } catch {
  }
  webviewPanel = null;
}
module.exports = {
  activate,
  deactivate,
  setActiveFile({ path: path2 }) {
    activeFile = { path: path2 || null, staged: resolveActiveFileStaged(path2) };
    pushActiveFile();
  }
};
