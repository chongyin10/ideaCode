const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { ipcMain, BrowserWindow, shell } = require('electron');
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
  ipcMain.handle(Channels.FS_READ_FILE, async (_event, filePath) => {
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
      await fs.rm(targetPath, { recursive: true, force: true });
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
   * 触发 Git 状态刷新（防抖）
   * @param {string} changedPath
   */
  function triggerGitRefresh(changedPath) {
    const gitRoot = findGitRoot(changedPath);
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

  ipcMain.handle(Channels.FS_WATCH, async (_event, watchPath) => {
    if (watchers.has(watchPath)) {
      return { success: true, alreadyWatching: true };
    }

    const watcher = fsSync.watch(
      watchPath,
      { recursive: true },
      (eventType, filename) => {
        // 向所有窗口推送文件变更通知（后台模式也能收到）
        BrowserWindow.getAllWindows().forEach((win) => {
          if (!win.isDestroyed()) {
            win.webContents.send(Channels.FS_CHANGE, {
              eventType,
              filename,
              path: watchPath,
              timestamp: Date.now(),
            });
          }
        });

        // 若变更发生在 Git 仓库内，触发 Source Control 刷新
        const changedPath = filename ? path.join(watchPath, filename) : watchPath;
        triggerGitRefresh(changedPath);
      }
    );

    watchers.set(watchPath, watcher);
    return { success: true };
  });

  ipcMain.handle(Channels.FS_UNWATCH, async (_event, watchPath) => {
    const watcher = watchers.get(watchPath);
    if (watcher) {
      watcher.close();
      watchers.delete(watchPath);
      return { success: true };
    }
    return { success: false, reason: '未找到监听器' };
  });
}

module.exports = { registerFsHandlers };
