const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { ipcMain, BrowserWindow, shell, app } = require('electron');
const { Channels } = require('../../shared/channels.cjs');

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
  ipcMain.handle(Channels.FS_READ_DIR, async (_event, dirPath) => {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isFile: e.isFile(),
    }));
  });

  /* ── 读取文件 ── */
  // 大文件保护：V8 字符串上限约 256MB 字符，超大文件（source map、minified bundle、
  // 大日志）在 readFile + toString + IPC 序列化阶段会触发 RangeError: Invalid string length。
  // 超过 MAX_READ_SIZE 的文件直接拒绝，由渲染层提示用户文件过大。
  const MAX_READ_SIZE = 128 * 1024 * 1024; // 128MB
  ipcMain.handle(Channels.FS_READ_FILE, async (_event, filePath) => {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_READ_SIZE) {
      throw new Error(`文件过大（${(stat.size / 1024 / 1024).toFixed(1)}MB），超过 ${MAX_READ_SIZE / 1024 / 1024}MB 读取上限`);
    }
    return fs.readFile(filePath, 'utf-8');
  });

  /* ── 写入文件 ── */
  ipcMain.handle(Channels.FS_WRITE_FILE, async (_event, filePath, content) => {
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
}

module.exports = { registerFsHandlers, findGitRoot };
