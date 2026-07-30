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
          if (global._commandHandlers && global._commandHandlers.has(command)) {
            return Promise.resolve(global._commandHandlers.get(command)(...args));
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
        const child = spawn("git", ["-c", "core.quotepath=false", ...args], {
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
    var DEFAULT_IGNORE_DIRS = /* @__PURE__ */ new Set([
      // JS/TS 生态
      "node_modules",
      ".parcel-cache",
      ".turbo",
      ".next",
      ".nuxt",
      ".svelte-kit",
      ".astro",
      // 通用构建产物
      "dist",
      "build",
      "out",
      "bin",
      "obj",
      "target",
      "release",
      // 缓存/覆盖率
      ".cache",
      "coverage",
      ".nyc_output",
      // 编辑器/IDE
      ".vscode",
      ".idea",
      // Python
      "__pycache__",
      ".venv",
      "venv",
      ".mypy_cache",
      ".pytest_cache",
      // JVM
      ".gradle",
      ".mvn",
      ".classpath",
      // Go/Rust/其他
      "vendor",
      "pkg"
    ]);
    function isDefaultIgnored(p) {
      if (!p) return false;
      const top = p.split("/")[0];
      return DEFAULT_IGNORE_DIRS.has(top);
    }
    function decodeGitPath(p) {
      if (!p) return p;
      if (p.startsWith('"') && p.endsWith('"')) {
        let inner = p.slice(1, -1);
        if (inner.includes("\\")) {
          const bytes = [];
          let i = 0;
          while (i < inner.length) {
            if (inner[i] === "\\" && i + 3 < inner.length + 1) {
              const oct = inner.slice(i + 1, i + 4);
              if (/^[0-7]{3}$/.test(oct)) {
                bytes.push(parseInt(oct, 8));
                i += 4;
                continue;
              }
            }
            bytes.push(inner.charCodeAt(i));
            i++;
          }
          return Buffer.from(bytes).toString("utf-8");
        }
        return inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
      return p;
    }
    function aggregateIgnored(changes) {
      if (!changes || changes.length === 0) return changes;
      const result = [];
      const aggregatedMap = /* @__PURE__ */ new Map();
      for (const c of changes) {
        if (c.isSubmodule) {
          result.push(c);
          continue;
        }
        const top = (c.path || "").split("/")[0];
        if (DEFAULT_IGNORE_DIRS.has(top)) {
          const entry = aggregatedMap.get(top);
          if (entry) {
            entry.count += 1;
          } else {
            aggregatedMap.set(top, { count: 1, sample: c });
          }
        } else {
          result.push(c);
        }
      }
      for (const [top, { count, sample }] of aggregatedMap) {
        result.push({
          path: `${top}/`,
          originalPath: null,
          indexStatus: sample.indexStatus,
          workingStatus: sample.workingStatus,
          aggregated: true,
          count
        });
      }
      return result;
    }
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
          const untrackedPath = decodeGitPath(line.slice(2));
          if (isDefaultIgnored(untrackedPath)) continue;
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
          const sub = parseInt(parts[2], 10) || 0;
          const isSubmodule = sub > 0;
          const path2 = decodeGitPath(parts.slice(8).join(" "));
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
              workingStatus: workingChar,
              isSubmodule
            });
            continue;
          }
          const change = {
            path: path2,
            originalPath: null,
            indexStatus: indexChar,
            workingStatus: workingChar,
            isSubmodule
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
          const sub = parseInt(parts[2], 10) || 0;
          const isSubmodule = sub > 0;
          const indexChar = xy[0] === "." ? " " : xy[0];
          const workingChar = xy[1] === "." ? " " : xy[1];
          const path2 = decodeGitPath(parts.slice(9).join(" "));
          const originalPath = null;
          const change = {
            path: path2,
            originalPath,
            indexStatus: indexChar,
            workingStatus: workingChar,
            isSubmodule
          };
          if (indexChar !== " ") {
            status.staged.push(change);
          }
          if (workingChar !== " ") {
            status.changes.push(change);
          }
        }
      }
      status.staged = aggregateIgnored(status.staged);
      status.changes = aggregateIgnored(status.changes);
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
    module2.exports = { parseStatus, toLegacyShape, DEFAULT_IGNORE_DIRS, isDefaultIgnored, aggregateIgnored };
  }
});

// repository.js
var require_repository = __commonJS({
  "repository.js"(exports2, module2) {
    var fs2 = require("fs");
    var fsp = fs2.promises;
    var path2 = require("path");
    var { execGit, git, GitError: GitError2 } = require_gitCLI();
    var { parseStatus, DEFAULT_IGNORE_DIRS } = require_statusParser();
    function shellEscapeArg(arg) {
      if (/^[a-zA-Z0-9_\-./=,@:%+]+$/.test(arg)) return arg;
      return "'" + String(arg).replace(/'/g, "'\\''") + "'";
    }
    var STATUS_POLL_INTERVAL = 3e4;
    var REMOTE_STATUS_POLL_INTERVAL = 6e4;
    var FAST_POLL_INTERVAL = 500;
    var FAST_POLL_DURATION = 5e3;
    var WATCHER_DEBOUNCE_MS = 300;
    var STALE_LOCK_THRESHOLD_MS = 3e4;
    var Repository2 = class {
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
        this._indexWatched = false;
        if (!this._isRemote) {
          this._setupWatcher();
        }
        const pollInterval = this._isRemote ? REMOTE_STATUS_POLL_INTERVAL : STATUS_POLL_INTERVAL;
        this._watchInterval = setInterval(() => {
          if (this._disposed) return;
          this._maybeRefresh("poll");
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
            const indexPath = path2.join(gitDir, "index");
            if (fs2.existsSync(indexPath)) {
              this._indexWatched = true;
              fs2.watchFile(indexPath, { persistent: false, interval: 5e3 }, (curr, prev) => {
                if (this._disposed) return;
                if (curr.mtimeMs !== prev.mtimeMs) {
                  this._scheduleWatcherRefresh();
                }
              });
            }
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
      /**
       * §统一的 git 命令执行入口。
       * 本地仓库：spawn 本地 git 二进制；远程仓库：通过 remoteExecutor 在 SSH 主机上执行。
       * @param {string[]} args git 子命令参数
       * @param {object} [options] { cwd, timeout, input, env }
       * @returns {Promise<{ stdout: string; stderr: string; code: number }>}
       */
      async _execGit(args, options = {}) {
        if (this._remoteExecutor) {
          const cwd = options.cwd || this.rootPath;
          const cmd = ["git", "--no-pager", ...args.map(shellEscapeArg)].join(" ");
          const envPrefix = options.env ? Object.entries(options.env).map(([k, v]) => `${k}=${shellEscapeArg(String(v))}`).join(" ") + " " : "";
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
            setImmediate(() => this.refresh().catch(() => {
            }));
          }
        }
      }
      async _doRefresh() {
        try {
          const oldStateSnapshot = this._stateSnapshot;
          const output = await this._execGit(
            // §关键修复：GIT_OPTIONAL_LOCKS=0 阻止 git 获取 index 锁和更新 stat 缓存。
            // 不加此选项时 git status 会修改 .git/index 的 mtime（更新 stat 缓存），
            // 导致 fs.watchFile 检测到变化 → 触发 refresh → 再次 git status → 再次修改 index → 无限循环。
            // 用环境变量而非 --no-optional-locks 命令行选项，兼容 git 2.8+（命令行选项需 2.15+）。
            // --untracked-files=normal：未跟踪目录只报目录级（如 node_modules/），不递归展开其下每个文件。
            // 用 all 会让 node_modules 这类目录刷出几万个 ? 条目，git 子进程慢、状态数据巨大、UI 卡死。
            // 第三方依赖/构建产物目录的进一步过滤见 statusParser.DEFAULT_IGNORE_DIRS。
            ["status", "--porcelain=v2", "--branch", "--untracked-files=normal", "--ignored=no"],
            { timeout: 1e4, env: { GIT_OPTIONAL_LOCKS: "0" } }
          );
          if (output.code !== 0) {
            this._lastError = output.stderr || `exit code ${output.code}`;
            return;
          }
          this.state = parseStatus(output.stdout);
          this._lastError = null;
          const mainRepoName = path2.basename(this.rootPath);
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
          await this._refreshSubmodules();
          const newSnapshot = JSON.stringify({
            s: this.state.staged,
            c: this.state.changes,
            m: this.state.merge,
            u: this.state.untracked,
            b: this.state.branch,
            u2: this.state.upstream,
            a: this.state.ahead,
            d: this.state.behind
          });
          this._stateSnapshot = newSnapshot;
          if (oldStateSnapshot && oldStateSnapshot === newSnapshot) {
            return;
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
        const { code, stdout } = await this._execGit(["submodule", "status"], {});
        if (code !== 0 || !stdout) return [];
        const subs = [];
        for (const line of stdout.split("\n")) {
          if (!line.trim()) continue;
          const statusChar = line[0];
          if (statusChar === "-") continue;
          const rest = line.slice(1).trim();
          const spaceIdx = rest.indexOf(" ");
          if (spaceIdx === -1) continue;
          const remaining = rest.slice(spaceIdx + 1);
          const subPath = remaining.split(" (")[0].trim();
          if (subPath) {
            subs.push({ path: subPath, name: subPath.split("/").pop() });
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
          return;
        }
        if (submodules.length === 0) return;
        for (const sub of submodules) {
          try {
            const subCwd = path2.join(this.rootPath, sub.path);
            const output = await this._execGit(
              ["status", "--porcelain=v2", "--branch", "--untracked-files=normal", "--ignored=no"],
              { cwd: subCwd, timeout: 1e4 }
            );
            if (output.code !== 0) continue;
            const subStatus = parseStatus(output.stdout);
            const tagSub = (c) => {
              c.repoPath = subCwd;
              c.repoName = sub.name;
              c.repoBranch = subStatus.branch || "";
            };
            subStatus.staged.forEach(tagSub);
            subStatus.changes.forEach(tagSub);
            subStatus.merge.forEach(tagSub);
            subStatus.untracked.forEach(tagSub);
            this.state.staged.push(...subStatus.staged);
            this.state.changes.push(...subStatus.changes);
            this.state.merge.push(...subStatus.merge);
            this.state.untracked.push(...subStatus.untracked);
          } catch {
          }
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
        if (this._isRemote) return;
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
        return this._execGit(args, options);
      }
      /** 操作完成后快速刷新一段时间 */
      _fastPoll() {
        if (this._isRemote) return;
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
      async stage(paths, cwd) {
        if (!paths || paths.length === 0) return { success: true };
        const args = ["add", "--", ...paths];
        const { code, stderr } = await this._execGitMutating(args, cwd ? { cwd } : {});
        if (code !== 0) throw new GitError2(`stage failed: ${stderr}`);
        await this.refresh();
        this._fastPoll();
        return { success: true };
      }
      async unstage(paths, cwd) {
        if (!paths || paths.length === 0) return { success: true };
        const args = ["reset", "HEAD", "--", ...paths];
        const { code, stderr } = await this._execGitMutating(args, cwd ? { cwd } : {});
        if (code !== 0) throw new GitError2(`unstage failed: ${stderr}`);
        await this.refresh();
        this._fastPoll();
        return { success: true };
      }
      async stageAll() {
        const excludeArgs = [...DEFAULT_IGNORE_DIRS].map((d) => `:!./${d}`);
        const args = ["add", "-A", "--", ".", ...excludeArgs];
        const { code, stderr } = await this._execGitMutating(args);
        if (code !== 0) throw new GitError2(`stageAll failed: ${stderr}`);
        try {
          const submodules = await this._getSubmodules();
          for (const sub of submodules) {
            try {
              const subCwd = path2.join(this.rootPath, sub.path);
              await this._execGitMutating(args, { cwd: subCwd });
            } catch {
            }
          }
        } catch {
        }
        await this.refresh();
        this._fastPoll();
        return { success: true };
      }
      async unstageAll() {
        const { code, stderr } = await this._execGitMutating(["reset", "HEAD"]);
        if (code !== 0) throw new GitError2(`unstageAll failed: ${stderr}`);
        try {
          const submodules = await this._getSubmodules();
          for (const sub of submodules) {
            try {
              const subCwd = path2.join(this.rootPath, sub.path);
              await this._execGitMutating(["reset", "HEAD"], { cwd: subCwd });
            } catch {
            }
          }
        } catch {
        }
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
      async discard(paths, cwd) {
        if (!paths || paths.length === 0) return { success: true };
        const args = ["checkout", "--", ...paths];
        const { code, stderr } = await this._execGitMutating(args, cwd ? { cwd } : {});
        if (code !== 0) throw new GitError2(`discard failed: ${stderr}`);
        await this.refresh();
        this._fastPoll();
        return { success: true };
      }
      async deleteUntracked(paths, cwd) {
        if (!paths || paths.length === 0) return { success: true };
        const baseCwd = cwd || this.rootPath;
        if (this._isRemote) {
          for (const p of paths) {
            try {
              await this._remoteExecutor(`rm -rf -- ${shellEscapeArg(p)}`, baseCwd);
            } catch {
            }
          }
          await this.refresh();
          this._fastPoll();
          return { success: true };
        }
        for (const p of paths) {
          const full = path2.join(baseCwd, p);
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
          const { stdout } = await this._remoteExecutor(
            `cat -- ${shellEscapeArg(relPath)}`,
            baseCwd
          );
          const isBinary2 = stdout.includes("\0");
          return { content: isBinary2 ? "" : stdout, isBinary: isBinary2 };
        }
        const full = path2.join(baseCwd, relPath);
        const buf = fs2.readFileSync(full);
        const isBinary = buf.includes(0);
        return { content: isBinary ? "" : buf.toString("utf8"), isBinary };
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
        const { code, stdout, stderr } = await this._execGit(
          ["for-each-ref", "--format=%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(upstream:track)%09%(objectname)%09%(objectname:short)%09%(subject)%09%(authordate:unix)%09%(authorname)", "refs/heads"],
          {}
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
        const { code: rc, stdout: rOut } = await this._execGit(
          ["for-each-ref", "--format=%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(upstream:track)%09%(objectname)%09%(objectname:short)%09%(subject)%09%(authordate:unix)%09%(authorname)", "refs/remotes"],
          {}
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
        const { code, stdout } = await this._execGit(["remote", "-v"], {});
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
        const { code, stdout, stderr } = await this._execGit(
          ["log", `--pretty=format:${format}`, "-n", String(count)],
          {}
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
      /**
       * §获取指定文件的 commit 历史（时间线功能）。
       * 使用 --follow 跟踪文件重命名，返回该文件相关的所有提交。
       */
      async getFileLog(filePath, count = 50) {
        const format = "%H%x09%h%x09%s%x09%an%x09%ae%x09%at";
        const { code, stdout, stderr } = await this._execGit(
          ["log", `--pretty=format:${format}`, "-n", String(count), "--follow", "--", filePath],
          {}
        );
        if (code !== 0) {
          if (/does not have any commits/i.test(stderr)) return [];
          if (/fatal: bad default revision/i.test(stderr)) return [];
          if (/no such path/i.test(stderr)) return [];
          throw new GitError2(`file log failed: ${stderr}`);
        }
        const commits = [];
        for (const line of stdout.split("\n")) {
          if (!line) continue;
          const [hash, shortHash, subject, authorName, authorEmail, timestamp] = line.split("	");
          commits.push({ hash, shortHash, subject, authorName, authorEmail, timestamp: parseInt(timestamp, 10) * 1e3 });
        }
        return commits;
      }
      /**
       * §获取指定 commit 的文件列表 + 变更统计（时间线点击 commit 后展示）。
       * 使用 git show --numstat 同时获取 commit 元信息和每文件的 additions/deletions。
       * numstat 行格式：additions\tdeletions\tpath（二进制文件为 -\t-\tpath）
       */
      async getCommitFiles(hash) {
        const format = "%H%x09%h%x09%s%x09%an%x09%ae%x09%at";
        const { code, stdout, stderr } = await this._execGit(
          ["show", "--numstat", `--format=${format}`, hash],
          {}
        );
        if (code !== 0) {
          if (/bad object/i.test(stderr)) return null;
          throw new GitError2(`show failed: ${stderr}`);
        }
        const lines = stdout.split("\n");
        if (lines.length === 0) return null;
        const [fullHash, shortHash, subject, authorName, authorEmail, timestamp] = lines[0].split("	");
        const commit = {
          hash: fullHash,
          shortHash,
          subject,
          authorName,
          authorEmail,
          timestamp: parseInt(timestamp, 10) * 1e3,
          files: []
        };
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i];
          if (!line) continue;
          const parts = line.split("	");
          if (parts.length < 3) continue;
          const addStr = parts[0];
          const delStr = parts[1];
          const filePath = parts.slice(2).join("	");
          const isBinary = addStr === "-" || delStr === "-";
          const additions = isBinary ? 0 : parseInt(addStr, 10) || 0;
          const deletions = isBinary ? 0 : parseInt(delStr, 10) || 0;
          let status2;
          if (isBinary) {
            status2 = "modified";
          } else if (additions > 0 && deletions === 0) {
            status2 = "added";
          } else if (additions === 0 && deletions > 0) {
            status2 = "deleted";
          } else {
            status2 = "modified";
          }
          const fileName = filePath.split("/").pop() || filePath;
          commit.files.push({ path: filePath, fileName, status: status2, additions, deletions });
        }
        return commit;
      }
      /**
       * §获取指定 commit 中某个文件的新旧版本内容（用于 diff 对比）。
       * @param {string} hash commit hash
       * @param {string} filePath 文件相对路径
       * @returns {Promise<{original: string, modified: string}>}
       *   original: commit 之前的文件内容（新增文件为空字符串）
       *   modified: commit 之后的文件内容（删除文件为空字符串）
       */
      async getCommitFileDiff(hash, filePath) {
        const modResult = await this._execGit(["show", `${hash}:${filePath}`], {});
        const origResult = await this._execGit(["show", `${hash}^:${filePath}`], {});
        return {
          original: origResult.code === 0 ? origResult.stdout : "",
          modified: modResult.code === 0 ? modResult.stdout : "",
        };
      }
      async listStashes() {
        const { code, stdout } = await this._execGit(
          ["stash", "list", "--pretty=format:%gd%x09%s%x09%ct"],
          {}
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
      async getOriginalContent(filePath, cwd) {
        const { stdout } = await this._execGit(
          ["show", `HEAD:${filePath}`],
          { cwd, timeout: 1e4 }
        );
        return stdout;
      }
      async getDiff(filePath, staged = false, cwd) {
        const args = ["diff", "--no-color"];
        if (staged) args.push("--cached");
        if (filePath) args.push("--", filePath);
        const { code, stdout } = await this._execGit(args, { cwd, timeout: 15e3 });
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
        if (this._indexWatched) {
          try {
            fs2.unwatchFile(path2.join(this.rootPath, ".git", "index"));
          } catch {
          }
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
            this._maybeRefresh("poll");
          }, pollInterval);
        }
        this._maybeRefresh("resume");
      }
    };
    function findRepoRoot2(startPath) {
      const dir = path2.resolve(startPath);
      const gitPath = path2.join(dir, ".git");
      try {
        const stat = fs2.statSync(gitPath);
        if (stat.isDirectory() || stat.isFile()) {
          return dir;
        }
      } catch {
      }
      return null;
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
async function findRemoteRepoRoot(sshUri) {
  const match = sshUri.match(/^ssh:\/\/([^/]+)(.*)$/);
  if (!match) return null;
  const connId = match[1];
  const remotePath = match[2] || "/";
  try {
    const result = await vscode.commands.executeCommand(
      "ssh.executeRemote",
      { connectionId: connId, command: "git rev-parse --show-toplevel", cwd: remotePath }
    );
    if (!result || !result.success) return null;
    const stdout = (result.stdout || "").trim();
    if (!stdout) return null;
    return stdout;
  } catch (err) {
    console.error("[Git Extension] \u8FDC\u7A0B\u4ED3\u5E93\u68C0\u6D4B\u5931\u8D25:", err.message);
    return null;
  }
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
    lastError: currentRepo?._lastError || null,
    loading: false
    // 仓库加载完成，关闭 loading
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
function pushLoading(rootPath) {
  if (!webviewPanel) return;
  try {
    webviewPanel.webview.postMessage({
      type: "state",
      rootPath: rootPath || null,
      repoRoot: null,
      isRepo: false,
      gitAvailable,
      state: null,
      lastError: null,
      loading: true
    });
  } catch {
  }
}
function pushClear() {
  if (!webviewPanel) return;
  try {
    webviewPanel.webview.postMessage({
      type: "state",
      rootPath: null,
      repoRoot: null,
      isRepo: false,
      gitAvailable,
      state: null,
      lastError: null,
      loading: true
    });
  } catch {
  }
}
async function openRepository(rootPath) {
  if (!rootPath) {
    closeRepository();
    return;
  }
  if (currentRootPath === rootPath && currentRepo) {
    return;
  }
  pushLoading(rootPath);
  closeRepository();
  if (typeof rootPath === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(rootPath)) {
    if (!gitAvailable) {
      currentRootPath = rootPath;
      pushState();
      return;
    }
    pushLoading(rootPath);
    let remoteRepoRoot = null;
    let detectError = null;
    try {
      remoteRepoRoot = await findRemoteRepoRoot(rootPath);
    } catch (err) {
      detectError = err;
      console.error("[Git Extension] \u8FDC\u7A0B\u4ED3\u5E93\u68C0\u6D4B\u5931\u8D25\uFF08\u4FDD\u7559 currentRepo \u4E0D\u53D8\uFF09:", err.message);
    }
    if (remoteRepoRoot) {
      currentRootPath = rootPath;
      const sshMatch = rootPath.match(/^ssh:\/\/([^/]+)/);
      const connId = sshMatch ? sshMatch[1] : null;
      const remoteExecutor = connId ? async (command, cwd) => {
        const result = await vscode.commands.executeCommand("ssh.executeRemote", {
          connectionId: connId,
          command,
          cwd
        });
        return {
          stdout: result?.stdout || "",
          stderr: result?.stderr || "",
          code: result?.code ?? -1
        };
      } : null;
      currentRepo = new Repository(remoteRepoRoot, { remoteExecutor });
      currentRepo.onDidChange(() => {
        pushState();
        pushBranches();
        pushStashes();
      });
      pushState();
      try {
        await currentRepo.refresh();
        pushState();
        pushBranches();
        pushStashes();
      } catch (refreshErr) {
        console.warn("[Git Extension] \u8FDC\u7A0B\u4ED3\u5E93 refresh \u5931\u8D25:", refreshErr.message);
      }
    } else {
      if (!currentRepo) {
        currentRootPath = rootPath;
        pushState();
      } else {
        pushState();
      }
      if (detectError) {
        console.warn("[Git Extension] \u8FDC\u7A0B git \u68C0\u6D4B\u672A\u5B8C\u6210\uFF0C\u6CBF\u7528 currentRepo \u72B6\u6001");
      }
    }
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
async function syncWorkspace() {
  try {
    const rootPath = await getCurrentRootPath();
    if (rootPath && rootPath !== currentRootPath) {
      await openRepository(rootPath);
    } else if (!rootPath && currentRepo) {
      closeRepository();
    } else {
      pushState();
      pushBranches();
      pushLog();
      pushStashes();
    }
  } catch (e) {
    console.error("[Git Extension] sync workspace on ready failed:", e.message);
    pushState();
  }
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
        reply({ success: true });
        if (currentRepo) {
          currentRepo.dispose();
          currentRepo = null;
          currentRootPath = null;
        }
        pushClear();
        syncWorkspace();
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
        await currentRepo.stage(message.paths || [], message.repoPath);
        reply({ success: true });
        break;
      case "unstage":
        if (!currentRepo) return reply({ success: false, error: "\u6CA1\u6709\u6253\u5F00\u7684\u4ED3\u5E93" });
        await currentRepo.unstage(message.paths || [], message.repoPath);
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
        const repoPath = message.repoPath;
        await currentRepo.discard(discardPaths, repoPath);
        if (discardPaths.length > 0) {
          let notifyPaths = discardPaths;
          if (repoPath && repoPath !== currentRepo.rootPath) {
            const subRel = path.relative(currentRepo.rootPath, repoPath);
            notifyPaths = discardPaths.map((p) => path.join(subRel, p));
          }
          send("git.filesChanged", { paths: notifyPaths });
        }
        reply({ success: true });
        break;
      }
      case "discardAll": {
        if (!currentRepo) return reply({ success: false, error: "\u6CA1\u6709\u6253\u5F00\u7684\u4ED3\u5E93" });
        const pathsByRepo = /* @__PURE__ */ new Map();
        for (const c of currentRepo.state.changes) {
          const rp = c.repoPath || currentRepo.rootPath;
          if (!pathsByRepo.has(rp)) pathsByRepo.set(rp, []);
          pathsByRepo.get(rp).push(c.path);
        }
        const allNotifyPaths = [];
        for (const [repoPath, paths] of pathsByRepo) {
          await currentRepo.discard(paths, repoPath);
          if (repoPath !== currentRepo.rootPath) {
            const subRel = path.relative(currentRepo.rootPath, repoPath);
            allNotifyPaths.push(...paths.map((p) => path.join(subRel, p)));
          } else {
            allNotifyPaths.push(...paths);
          }
        }
        if (allNotifyPaths.length > 0) {
          send("git.filesChanged", { paths: allNotifyPaths });
        }
        reply({ success: true });
        break;
      }
      case "deleteUntracked":
        if (!currentRepo) return reply({ success: false, error: "\u6CA1\u6709\u6253\u5F00\u7684\u4ED3\u5E93" });
        await currentRepo.deleteUntracked(message.paths || [], message.repoPath);
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
        const diff = await currentRepo.getDiff(message.path, !!message.staged, message.repoPath);
        reply({ success: true, diff });
        break;
      case "getOriginalContent":
        if (!currentRepo) return reply({ success: true, content: "" });
        const content = await currentRepo.getOriginalContent(message.path, message.repoPath);
        reply({ success: true, content });
        break;
      case "openFile": {
        if (!message.path) return reply({ success: false, error: "\u7F3A\u5C11 path" });
        const repoPath = message.repoPath;
        try {
          let originalContent = "";
          if (currentRepo) {
            try {
              originalContent = await currentRepo.getOriginalContent(message.path, repoPath) || "";
            } catch (e) {
            }
          }
          let modifiedContent = "";
          let isBinary = false;
          try {
            if (currentRepo) {
              const result = await currentRepo.readFile(message.path, repoPath);
              modifiedContent = result.content;
              isBinary = result.isBinary;
            } else {
              const repoRoot = currentRootPath;
              const fullPath = path.join(repoRoot || "", message.path);
              const buf = fs.readFileSync(fullPath);
              isBinary = buf.includes(0);
              if (!isBinary) {
                modifiedContent = buf.toString("utf8");
              }
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
      case "associateRemote": {
        const { url } = message;
        if (!url) return reply({ success: false, error: "\u7F3A\u5C11\u8FDC\u7A0B\u4ED3\u5E93\u5730\u5740" });
        if (!currentRootPath) return reply({ success: false, error: "\u6CA1\u6709\u5DE5\u4F5C\u533A" });
        try {
          const { execGit } = require_gitCLI();
          if (!currentRepo) {
            await execInit(currentRootPath);
          }
          try {
            await execGit(["remote", "remove", "origin"], { cwd: currentRootPath });
          } catch {
          }
          const addRes = await execGit(["remote", "add", "origin", url], { cwd: currentRootPath });
          if (addRes.code !== 0) throw new Error(addRes.stderr || "git remote add \u5931\u8D25");
          try {
            await execGit(["fetch", "origin"], { cwd: currentRootPath, timeout: 6e4 });
          } catch {
          }
          await openRepository(currentRootPath);
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
  vscode.commands.registerCommand("git.onSshConnectionClosed", ({ connectionId }) => {
    if (currentRootPath && currentRootPath.startsWith(`ssh://${connectionId}/`)) {
      console.log("[Git Extension] SSH \u8FDE\u63A5\u5DF2\u5173\u95ED\uFF0C\u6E05\u7406\u8FDC\u7A0B\u4ED3\u5E93:", connectionId);
      closeRepository();
    }
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
  },
  // 供主应用 RPC 调用（如状态栏分支选择器），不依赖 webview 通道
  async getBranches() {
    if (!currentRepo) return [];
    return await currentRepo.listBranches();
  },
  /**
   * §获取 commit 历史（时间线功能）。
   * @param {object} opts
   * @param {string} [opts.filePath] 相对路径。传入时只返回该文件的提交历史（--follow）
   * @param {number} [opts.count=50] 最大条数
   * @returns {Promise<Array<{hash,shortHash,subject,authorName,authorEmail,timestamp}>>}
   */
  async getLog({ filePath, count } = {}) {
    if (!currentRepo) return [];
    const n = count || 50;
    if (filePath) {
      return await currentRepo.getFileLog(filePath, n);
    }
    return await currentRepo.getLog(n);
  },
  /**
   * §获取指定 commit 的文件列表 + 变更统计（时间线点击 commit 后展示）。
   * @param {string} hash commit hash
   * @returns {Promise<{hash,shortHash,subject,authorName,authorEmail,timestamp,files:Array<{path,fileName,status,additions,deletions}>}|null>}
   */
  async getCommitFiles({ hash } = {}) {
    if (!currentRepo || !hash) return null;
    return await currentRepo.getCommitFiles(hash);
  },
  /**
   * §获取指定 commit 中某个文件的新旧版本内容（用于 diff 对比）。
   * @param {string} hash commit hash
   * @param {string} filePath 文件相对路径
   * @returns {Promise<{original: string, modified: string}|null>}
   */
  async getCommitFileDiff({ hash, filePath } = {}) {
    if (!currentRepo || !hash || !filePath) return null;
    return await currentRepo.getCommitFileDiff(hash, filePath);
  },
  /**
   * §获取工作树文件与 HEAD 的对比内容（左 = HEAD，右 = 工作树）。
   * 供依赖可视化画布右键菜单「diff对比」使用。
   * @param {string} filePath 文件相对路径
   * @returns {Promise<{original: string, modified: string, isBinary: boolean}|null>}
   */
  async getWorkingTreeFileDiff({ filePath } = {}) {
    if (!currentRepo || !filePath) return null;
    let original = "";
    try {
      original = (await currentRepo.getOriginalContent(filePath)) || "";
    } catch (e) {
      // 文件在 HEAD 中不存在（新增/未跟踪），original 留空
    }
    let modified = "";
    let isBinary = false;
    try {
      const result = await currentRepo.readFile(filePath);
      modified = result.content;
      isBinary = result.isBinary;
    } catch (e) {
      // 文件在工作区不存在（如已删除），modified 留空
    }
    return { original, modified, isBinary };
  },
  async checkoutBranch({ name }) {
    if (!currentRepo) throw new Error("\u6CA1\u6709\u6253\u5F00\u7684\u4ED3\u5E93");
    await currentRepo.checkoutBranch(name);
    pushBranches();
    pushLog();
    return { success: true };
  },
  async createBranch({ name, startPoint }) {
    if (!currentRepo) throw new Error("\u6CA1\u6709\u6253\u5F00\u7684\u4ED3\u5E93");
    await currentRepo.createBranch(name, startPoint);
    pushBranches();
    return { success: true };
  },
  // 主应用打开文件夹后主动通知 git 扩展，消除 5 秒轮询延迟
  async openWorkspace({ path: rootPath }) {
    if (!rootPath) {
      closeRepository();
      return;
    }
    if (workspaceChangeTimer) {
      clearTimeout(workspaceChangeTimer);
      workspaceChangeTimer = null;
    }
    await openRepository(rootPath);
  },
  // §按需激活：源代码管理面板可见性变化时通知 Git 扩展
  // 面板不可见时 pause 远程仓库轮询（SSH execute 降为 0），
  // 面板恢复可见时 resume 轮询并立即刷新一次
  onScmPanelVisibilityChange({ visible }) {
    if (!currentRepo) return;
    if (visible) {
      currentRepo.resume();
    } else {
      currentRepo.pause();
    }
  }
};
