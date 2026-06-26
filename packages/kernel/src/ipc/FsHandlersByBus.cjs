/**
 * 文件系统处理器 - ServiceBus 版
 *
 * 替代 electron/main/ipcHandlers/fsHandler.cjs
 * 将所有 FS 操作注册到 ServiceBus。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/**
 * @param {object} bus - ServiceBus 实例
 */
function registerFsHandlersByBus(bus) {
  // 读取目录
  bus.handle('fs:readDir', async (params) => {
    const dirPath = typeof params === 'string' ? params : params?.path;
    if (!dirPath) throw new Error('缺少目录路径');

    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file',
    }));
  });

  // 读取文件
  bus.handle('fs:readFile', async (params) => {
    const filePath = typeof params === 'string' ? params : params?.path;
    if (!filePath) throw new Error('缺少文件路径');
    return await fsp.readFile(filePath, 'utf-8');
  });

  // 写入文件
  bus.handle('fs:writeFile', async (params) => {
    const { path: filePath, content } = params || {};
    if (!filePath) throw new Error('缺少文件路径');
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, content || '', 'utf-8');
    return true;
  });

  // 文件状态
  bus.handle('fs:stat', async (params) => {
    const filePath = typeof params === 'string' ? params : params?.path;
    if (!filePath) throw new Error('缺少文件路径');
    const stat = await fsp.stat(filePath);
    return {
      name: path.basename(filePath),
      kind: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file',
      size: stat.size,
      modifiedTime: stat.mtimeMs,
    };
  });

  // 创建文件
  bus.handle('fs:createFile', async (params) => {
    const filePath = typeof params === 'string' ? params : params?.path;
    if (!filePath) throw new Error('缺少文件路径');
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, '', 'utf-8');
    return true;
  });

  // 创建目录
  bus.handle('fs:createDir', async (params) => {
    const dirPath = typeof params === 'string' ? params : params?.path;
    if (!dirPath) throw new Error('缺少目录路径');
    await fsp.mkdir(dirPath, { recursive: true });
    return true;
  });

  // 删除
  bus.handle('fs:delete', async (params) => {
    const targetPath = typeof params === 'string' ? params : params?.path;
    const recursive = typeof params === 'object' ? params?.recursive : false;
    if (!targetPath) throw new Error('缺少路径');
    await fsp.rm(targetPath, { recursive: !!recursive, force: true });
    return true;
  });

  // 重命名
  bus.handle('fs:rename', async (params) => {
    const { oldPath, newPath, overwrite } = params || {};
    if (!oldPath || !newPath) throw new Error('缺少路径参数');
    if (overwrite) {
      try { await fsp.rm(newPath, { force: true }); } catch { /* ignore */ }
    }
    await fsp.rename(oldPath, newPath);
    return true;
  });

  // 复制
  bus.handle('fs:copy', async (params) => {
    const { srcPath, destPath } = params || {};
    if (!srcPath || !destPath) throw new Error('缺少路径参数');
    await fsp.cp(srcPath, destPath, { recursive: true });
    return true;
  });

  // 在文件管理器中显示
  bus.handle('fs:reveal', async (params) => {
    const filePath = typeof params === 'string' ? params : params?.path;
    if (!filePath) throw new Error('缺少文件路径');
    const { shell } = require('electron');
    shell.showItemInFolder(filePath);
    return true;
  });

  // 文件监听
  const watchers = new Map();
  bus.handle('fs:watch', async (params) => {
    const watchPath = typeof params === 'string' ? params : params?.path;
    if (!watchPath) throw new Error('缺少监听路径');
    if (watchers.has(watchPath)) return true;

    const watcher = fs.watch(watchPath, { recursive: true }, (eventType, filename) => {
      if (filename) {
        bus.publish('fs:change', {
          path: path.join(watchPath, filename),
          type: eventType === 'rename' ? 'deleted' : 'changed',
        });
      }
    });
    watchers.set(watchPath, watcher);
    return true;
  });

  bus.handle('fs:unwatch', async (params) => {
    const watchPath = typeof params === 'string' ? params : params?.path;
    if (!watchPath) return false;
    const watcher = watchers.get(watchPath);
    if (watcher) {
      watcher.close();
      watchers.delete(watchPath);
      return true;
    }
    return false;
  });

  console.log('[FsHandlersByBus] 已注册 11 个 FS 处理器');
}

module.exports = { registerFsHandlersByBus };
