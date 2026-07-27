const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { ipcMain, BrowserWindow, shell, app } = require('electron');
const { Channels } = require('../../shared/channels.cjs');

/**
 * 解析 ripgrep 可执行文件路径。
 *
 * 优先级：
 *   1. 项目依赖 @vscode/ripgrep 的平台子包（1.18+ 拆分为 optionalDependencies，
 *      二进制在 @vscode/ripgrep-<platform>-<arch>/bin/rg；打包后稳定可用，跨平台）
 *   2. 系统 PATH 中的 rg（开发环境兜底）
 *
 * 注意：@vscode/ripgrep 1.18+ 的入口 index.js 是 ESM，CommonJS 不能直接 require。
 * 这里用 require.resolve 直接解析平台子包的二进制路径，绕开 ESM 限制。
 *
 * 解析结果缓存，避免每次搜索都 require.resolve + which。
 */
let cachedRgPath = null;
function getRipgrepPath() {
  if (cachedRgPath !== null) return cachedRgPath;
  // 1. 项目依赖的平台子包二进制
  try {
    const arch = process.env.npm_config_arch || process.arch;
    const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const platformPkg = `@vscode/ripgrep-${process.platform}-${arch}`;
    const rgPath = require.resolve(`${platformPkg}/bin/${binaryName}`);
    if (rgPath && fsSync.existsSync(rgPath)) {
      cachedRgPath = rgPath;
      return rgPath;
    }
  } catch { /* 平台子包未安装，继续兜底 */ }
  // 2. 系统 PATH（开发环境 rg 已安装时）
  try {
    const which = require('child_process').execSync('which rg', { encoding: 'utf-8' }).trim();
    if (which) {
      cachedRgPath = which;
      return which;
    }
  } catch { /* 系统 PATH 无 rg */ }
  cachedRgPath = false; // 标记为不可用，避免重复探测
  return false;
}

/**
 * 文件系统 IPC 处理器
 *
 * 职责：为渲染进程提供受控的本地文件系统访问能力。
 *
 * 安全设计：
 * 1. 所有路径由用户通过系统对话框主动选择，非任意路径访问
 * 2. 不暴露 rm、chmod 等危险操作
 * 3. 文件监听在后台模式持续运行，独立于窗口焦点状态
 */

/**
 * 向上查找 Git 仓库根目录
 * @param {string} startPath
 * @returns {string | null}
 */
function findGitRoot(startPath) {
  let dir = startPath;
  while (dir !== path.dirname(dir)) {
    if (fsSync.existsSync(path.join(dir, '.git'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * watchPath → gitRoot 缓存。
 *
 * fs.watch 回调在大目录变更（如 npm install、git checkout）时会触发数十次事件，
 * 每次都调用 findGitRoot 同步向上遍历查找 .git，会阻塞主进程。
 * 同一 watchPath 下所有文件的 git root 相同，缓存后只首次查找，后续命中。
 * watchPath 取消监听时清理对应缓存。
 */
const gitRootCache = new Map();

/**
 * 带缓存的 findGitRoot
 * @param {string} watchPath
 * @returns {string | null}
 */
function findGitRootCached(watchPath) {
  if (gitRootCache.has(watchPath)) return gitRootCache.get(watchPath);
  const root = findGitRoot(watchPath);
  gitRootCache.set(watchPath, root);
  return root;
}

function registerFsHandlers() {
  /* ── 读取目录 ── */
  // §修复 EISDIR：Dirent.isDirectory()/isFile() 不会跟随符号链接，指向目录的符号链接
  // （pnpm node_modules、.bin 等）会被误判为非目录，后续 readFile 会抛 EISDIR。
  // 对符号链接用 fs.stat 跟随一次，拿到真实类型。
  ipcMain.handle(Channels.FS_READ_DIR, async (_event, dirPath) => {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const result = [];
    for (const e of entries) {
      let isDirectory = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try {
          const realStat = await fs.stat(path.join(dirPath, e.name));
          isDirectory = realStat.isDirectory();
          isFile = realStat.isFile();
        } catch {
          // 断裂符号链接：保留原始类型（isDirectory=false, isFile=false）
        }
      }
      result.push({ name: e.name, isDirectory, isFile });
    }
    return result;
  });

  /* ── 读取文件 ── */
  // 大文件保护：V8 字符串上限约 256MB 字符，超大文件（source map、minified bundle、
  // 大日志）在 readFile + toString + IPC 序列化阶段会触发 RangeError: Invalid string length。
  // 超过 MAX_READ_SIZE 的文件直接拒绝，由渲染层提示用户文件过大。
  // §修复 EISDIR：fs.stat 能成功返回目录信息，但 fs.readFile 对目录会抛 EISDIR。
  // 在此提前拦截目录，避免触发 EISDIR 错误（防御性：即使上层误传目录路径也不会卡）。
  const MAX_READ_SIZE = 128 * 1024 * 1024; // 128MB
  ipcMain.handle(Channels.FS_READ_FILE, async (_event, filePath) => {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      throw new Error(`EISDIR: 无法读取目录: ${filePath}`);
    }
    if (stat.size > MAX_READ_SIZE) {
      throw new Error(`文件过大（${(stat.size / 1024 / 1024).toFixed(1)}MB），超过 ${MAX_READ_SIZE / 1024 / 1024}MB 读取上限`);
    }
    return fs.readFile(filePath, 'utf-8');
  });

  /* ── 读取二进制文件（base64）── */
  // 用于 PDF 等二进制文件预览：渲染层拿到 base64 后构造 Blob URL，
  // 交给 Chromium 内置 PDF 查看器渲染，避免 utf-8 读取产生乱码。
  ipcMain.handle(Channels.FS_READ_FILE_BASE64, async (_event, filePath) => {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      throw new Error(`EISDIR: 无法读取目录: ${filePath}`);
    }
    if (stat.size > MAX_READ_SIZE) {
      throw new Error(`文件过大（${(stat.size / 1024 / 1024).toFixed(1)}MB），超过 ${MAX_READ_SIZE / 1024 / 1024}MB 读取上限`);
    }
    const buf = await fs.readFile(filePath);
    return buf.toString('base64');
  });

  /* ── 写入文件 ── */
  // §AI 创建新文件（如 agent 模式下 write_file）可能落在尚未存在的目录里，
  // 直接 fs.writeFile 会抛 ENOENT。这里先 mkdir -p 父目录（已存在时为 no-op），
  // 让 AI 生成全新文件路径时不再因目录缺失而失败。
  ipcMain.handle(Channels.FS_WRITE_FILE, async (_event, filePath, content) => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
    return true;
  });

  /* ── 文件状态 ── */
  ipcMain.handle(Channels.FS_STAT, async (_event, filePath) => {
    try {
      const stat = await fs.stat(filePath);
      return {
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      };
    } catch {
      return null;
    }
  });

  /* ── 新建文件 ── */
  ipcMain.handle(Channels.FS_CREATE_FILE, async (_event, filePath) => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '', 'utf-8');
    return true;
  });

  /* ── 新建文件夹 ── */
  ipcMain.handle(Channels.FS_CREATE_DIR, async (_event, dirPath) => {
    await fs.mkdir(dirPath, { recursive: true });
    return true;
  });

  /* ── 删除文件/文件夹 ── */
  ipcMain.handle(Channels.FS_DELETE, async (_event, targetPath) => {
    const stat = await fs.stat(targetPath);
    if (stat.isDirectory()) {
      try {
        // maxRetries 处理文件被短暂占用（watcher / Spotlight 索引）导致的 ENOTEMPTY
        await fs.rm(targetPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch (err) {
        // fs.rm 在 macOS 上可能因 .app 包内的符号链接/只读权限/扩展属性而失败。
        // 回退到系统 rm -rf，能正确处理这些边缘情况。
        if (err.code === 'ENOTEMPTY' || err.code === 'EPERM' || err.code === 'EACCES') {
          await execFileAsync('rm', ['-rf', targetPath]);
        } else {
          throw err;
        }
      }
    } else {
      await fs.unlink(targetPath);
    }
    return true;
  });

  /* ── 重命名 ── */
  ipcMain.handle(Channels.FS_RENAME, async (_event, oldPath, newPath) => {
    await fs.rename(oldPath, newPath);
    return true;
  });

  /* ── 复制 ── */
  ipcMain.handle(Channels.FS_COPY, async (_event, srcPath, destPath) => {
    await fs.cp(srcPath, destPath, { recursive: true, force: true });
    return true;
  });

  /* ── 在资源管理器/Finder 中显示 ── */
  ipcMain.handle(Channels.FS_REVEAL, async (_event, filePath) => {
    await shell.showItemInFolder(filePath);
    return true;
  });

  /* ── 文件监听（支持后台模式持续运行） ── */
  const watchers = new Map();
  const gitRefreshTimers = new Map();

  /**
   * 触发 Git 状态刷新（防抖）
   * @param {string} watchPath 被监听的根目录（用于查找 git root）
   */
  function triggerGitRefresh(watchPath) {
    const gitRoot = findGitRootCached(watchPath);
    if (!gitRoot) return;

    const existing = gitRefreshTimers.get(gitRoot);
    if (existing) clearTimeout(existing);

    gitRefreshTimers.set(
      gitRoot,
      setTimeout(() => {
        gitRefreshTimers.delete(gitRoot);
        BrowserWindow.getAllWindows().forEach((win) => {
          if (!win.isDestroyed()) {
            win.webContents.send(Channels.GIT_STATUS_CHANGED, { cwd: gitRoot });
          }
        });
      }, 150)
    );
  }

  // 应用退出时清理所有防抖定时器，避免定时器在 app 销毁后仍触发
  app.on('before-quit', () => {
    for (const timer of gitRefreshTimers.values()) clearTimeout(timer);
    gitRefreshTimers.clear();
    gitRootCache.clear();
  });

  ipcMain.handle(Channels.FS_WATCH, async (_event, watchPath) => {
    if (watchers.has(watchPath)) {
      return { success: true, alreadyWatching: true };
    }

    // 目标路径不存在时直接返回错误，避免 FSWatcher 抛 ENOENT
    if (!fsSync.existsSync(watchPath)) {
      console.warn(`[FS_WATCH] 路径不存在，跳过监听: ${watchPath}`);
      return { success: false, reason: '路径不存在', error: '路径不存在' };
    }

    try {
      const watcher = fsSync.watch(
        watchPath,
        { recursive: true },
        (eventType, filename) => {
          // filename 在某些平台/事件下可能为 undefined，统一转换为 null/字符串
          const safeFilename = filename === undefined ? null : filename;
          // 向所有窗口推送文件变更通知（后台模式也能收到）
          BrowserWindow.getAllWindows().forEach((win) => {
            if (!win.isDestroyed() && win.webContents) {
              win.webContents.send(Channels.FS_CHANGE, {
                eventType,
                filename: safeFilename,
                path: watchPath,
                timestamp: Date.now(),
              });
            }
          });

          // 若变更发生在 Git 仓库内，触发 Source Control 刷新
          // 用 watchPath 而非 changedPath 查找 git root，命中缓存避免同步阻塞
          triggerGitRefresh(watchPath);
        }
      );

      watchers.set(watchPath, watcher);
      return { success: true };
    } catch (err) {
      console.error(`[FS_WATCH] 监听失败 ${watchPath}:`, err.message);
      return { success: false, reason: err.message, error: err.message };
    }
  });

  ipcMain.handle(Channels.FS_UNWATCH, async (_event, watchPath) => {
    const watcher = watchers.get(watchPath);
    if (watcher) {
      watcher.close();
      watchers.delete(watchPath);
      // 清理 gitRoot 缓存：取消监听后该 watchPath 不再产生事件
      gitRootCache.delete(watchPath);
      return { success: true };
    }
    return { success: false, reason: '未找到监听器' };
  });

  /* ── 内容搜索（ripgrep）──
   *
   * §对标 VSCode：主进程 spawn rg --json，rg 在 Rust 端流式扫描文件，
   * 只把匹配行通过 stdout 返回，避免把整个大文件读到 V8（旧实现因 readFile
   * 362MB minified bundle 触发 128MB 上限报错）。
   *
   * rg 自动处理：
   *   - 二进制文件（前 8KB 检测 NUL 字节，自动跳过）
   *   - .gitignore（默认遵守，无需硬编码 skipDirs）
   *   - 大文件（--max-filesize 跳过，不会 OOM）
   *   - 隐藏文件（默认不搜）
   *   - 多线程并行
   *
   * 流式推送：stdout 按行解析 JSON，节流（80ms）批量 send 给渲染进程，
   * 避免每条匹配都触发一次 IPC。
   */
  let currentSearch = null; // { proc, cancelled, searchId }

  function killCurrentSearch() {
    if (!currentSearch) return;
    currentSearch.cancelled = true;
    try { currentSearch.proc?.kill('SIGTERM'); } catch { /* 已退出 */ }
    currentSearch = null;
  }

  app.on('before-quit', killCurrentSearch);

  ipcMain.handle(Channels.FS_SEARCH, async (event, params) => {
    const { rootPath, query, options = {}, searchId } = params;
    const {
      caseSensitive = false,
      wholeWord = false,
      useRegex = false,
      includePattern = '',
      excludePattern = '',
      maxResults = 1000,
    } = options;

    const sender = event.sender;
    const rgPath = getRipgrepPath();
    if (!rgPath) {
      if (!sender.isDestroyed()) {
        sender.send(Channels.FS_SEARCH_DONE, {
          searchId, results: [], totalMatches: 0, isTruncated: false,
          error: '未找到 ripgrep，请安装 @vscode/ripgrep 或系统 rg',
        });
      }
      return { started: false, error: 'ripgrep unavailable' };
    }

    // 启动新搜索前取消上一次（单实例简化模型）
    killCurrentSearch();

    const args = [
      '--json',
      // §每文件最多匹配数：避免单个文件（如 minified bundle）爆量占用结果配额
      '--max-count', String(Math.min(100, Math.ceil(maxResults / 10) || 10)),
      // §跳过超大文件：rg 会直接 skip，不会 OOM 也不会报错
      '--max-filesize', '50M',
      '--color', 'never',
      '--no-heading',
      '--line-number',
    ];
    if (!caseSensitive) args.push('-i');
    if (wholeWord) args.push('-w');
    // 非正则模式用字面量匹配，避免查询词中的正则元字符引发错误
    if (!useRegex) args.push('--fixed-strings');

    // 排除/包含 glob（rg -g 可重复指定）
    if (excludePattern) {
      String(excludePattern).split(',').forEach((p) => {
        const trimmed = p.trim();
        if (trimmed) args.push('-g', `!${trimmed}`);
      });
    }
    if (includePattern) {
      String(includePattern).split(',').forEach((p) => {
        const trimmed = p.trim();
        if (trimmed) args.push('-g', trimmed);
      });
    }

    args.push(query, rootPath);

    let proc;
    try {
      proc = spawn(rgPath, args, { cwd: rootPath, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      if (!sender.isDestroyed()) {
        sender.send(Channels.FS_SEARCH_DONE, {
          searchId, results: [], totalMatches: 0, isTruncated: false, error: err.message,
        });
      }
      return { started: false, error: err.message };
    }

    currentSearch = { proc, cancelled: false, searchId };

    // §结果聚合：按文件路径聚合 matches，避免同一文件被拆成多条推送
    const results = new Map(); // relativePath -> { filePath, fileName, matches }
    let totalMatches = 0;
    let isTruncated = false;
    let buffer = '';

    // 节流推送：每 80ms 最多一次，避免高频 IPC 淹没渲染进程
    let flushTimer = null;
    let dirty = false;
    const FLUSH_INTERVAL = 80;
    const flush = () => {
      flushTimer = null;
      if (dirty && !sender.isDestroyed() && !currentSearch?.cancelled) {
        dirty = false;
        sender.send(Channels.FS_SEARCH_PROGRESS, {
          searchId,
          results: Array.from(results.values()),
          totalMatches,
          isTruncated: false,
        });
      }
    };
    const scheduleFlush = () => {
      dirty = true;
      if (flushTimer === null) flushTimer = setTimeout(flush, FLUSH_INTERVAL);
    };

    proc.stdout.on('data', (chunk) => {
      if (currentSearch?.cancelled) return;
      buffer += chunk.toString('utf-8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 保留最后不完整的行

      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type !== 'match') continue;

        const absPath = msg.data.path.text;
        const relativePath = path.relative(rootPath, absPath) || absPath;
        const fileName = path.basename(absPath);
        // §rg 的 lines.text 末尾带换行，需裁剪；submatches 给出本次匹配的起止
        const lineText = String(msg.data.lines.text).replace(/\r?\n$/, '');

        if (!results.has(relativePath)) {
          results.set(relativePath, { filePath: relativePath, fileName, matches: [] });
        }
        const fileEntry = results.get(relativePath);

        for (const sub of msg.data.submatches || []) {
          if (totalMatches >= maxResults) {
            isTruncated = true;
            break;
          }
          fileEntry.matches.push({
            line: msg.data.line_number,
            column: sub.start + 1,
            text: lineText,
            match: {
              index: sub.start,
              length: sub.end - sub.start,
              matched: sub.match?.text ?? '',
            },
          });
          totalMatches++;
        }

        if (isTruncated) {
          scheduleFlush();
          // 命中上限，主动终止 rg
          // §currentSearch 可能已被 cancelCurrentSearch() 置为 null（用户快速切换搜索）
          if (currentSearch) currentSearch.cancelled = true;
          try { proc.kill('SIGTERM'); } catch { /* 已退出 */ }
          return;
        }
        scheduleFlush();
      }
    });

    proc.stderr.on('data', (chunk) => {
      // rg 在某些非零退出场景（如无匹配、路径不存在）会写 stderr，记录但不中断
      const text = chunk.toString('utf-8').trim();
      if (text) console.warn(`[FS_SEARCH] rg stderr: ${text}`);
    });

    proc.on('error', (err) => {
      console.error('[FS_SEARCH] rg 进程错误:', err.message);
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (!sender.isDestroyed()) {
        sender.send(Channels.FS_SEARCH_DONE, {
          searchId,
          results: Array.from(results.values()),
          totalMatches,
          isTruncated,
          error: err.message,
        });
      }
      currentSearch = null;
    });

    proc.on('close', () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      // 最后一次强制 flush（确保尾部的 dirty 数据被推送）
      if (dirty && !sender.isDestroyed()) {
        dirty = false;
        sender.send(Channels.FS_SEARCH_PROGRESS, {
          searchId,
          results: Array.from(results.values()),
          totalMatches,
          isTruncated,
        });
      }
      if (!sender.isDestroyed()) {
        sender.send(Channels.FS_SEARCH_DONE, {
          searchId,
          results: Array.from(results.values()),
          totalMatches,
          isTruncated,
        });
      }
      currentSearch = null;
    });

    return { started: true, searchId };
  });

  ipcMain.handle(Channels.FS_SEARCH_CANCEL, async () => {
    killCurrentSearch();
    return { success: true };
  });
}

module.exports = { registerFsHandlers, findGitRoot };
