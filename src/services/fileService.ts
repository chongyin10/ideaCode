import { FileContentCache } from '../utils/algorithms';
import type { RecentProject } from '../types/electron';

export type FileSource = FileSystemHandle | string;

export interface FileEntry {
  name: string;
  kind: 'file' | 'directory';
  source: FileSource;
}

export function isPath(source: FileSource): source is string {
  return typeof source === 'string';
}

export function isHandle(source: FileSource): source is FileSystemHandle {
  return typeof source !== 'string';
}

export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI?.isElectron;
}

/* ────────────────────────────────────────────── */
/*  文件内容缓存（LRU 算法）                        */
/* ────────────────────────────────────────────── */

const fileCache = new FileContentCache(30);

/* ────────────────────────────────────────────── */
/*  文件系统抽象层：运行时自动检测浏览器或 Electron 环境  */
/*  浏览器 → File System Access API                  */
/*  Electron → IPC → Node.js 运行时 (fs)             */
/* ────────────────────────────────────────────── */

export async function openDirectory(): Promise<{ source: FileSource; name: string } | null> {
  if (isElectron()) {
    const dirPath = await window.electronAPI!.dialog.openDirectory();
    if (!dirPath) return null;
    const name = dirPath.split(/[\\/]/).pop() || dirPath;
    return { source: dirPath, name };
  }
  try {
    const dirHandle = await window.showDirectoryPicker();
    return { source: dirHandle, name: dirHandle.name };
  } catch {
    return null;
  }
}

export async function readDirectory(parentSource: FileSource): Promise<FileEntry[]> {
  if (isElectron() && isPath(parentSource)) {
    const entries = await window.electronAPI!.fs.readDir(parentSource);
    return entries
      .map((e) => ({
        name: e.name,
        kind: e.isDirectory ? ('directory' as const) : ('file' as const),
        source: parentSource + '/' + e.name,
      }))
      .sort((a, b) => {
        if (a.kind === b.kind) return a.name.localeCompare(b.name);
        return a.kind === 'directory' ? -1 : 1;
      });
  }

  if (isHandle(parentSource) && parentSource.kind === 'directory') {
    const handle = parentSource as FileSystemDirectoryHandle;
    const entries: FileEntry[] = [];
    for await (const entry of handle.values()) {
      entries.push({
        name: entry.name,
        kind: entry.kind,
        source: entry,
      });
    }
    entries.sort((a, b) => {
      if (a.kind === b.kind) return a.name.localeCompare(b.name);
      return a.kind === 'directory' ? -1 : 1;
    });
    return entries;
  }

  return [];
}

export async function readFile(fileSource: FileSource): Promise<string> {
  if (isElectron() && isPath(fileSource)) {
    // 先查缓存（带 mtime 验证）
    try {
      const stat = await window.electronAPI!.fs.stat(fileSource);
      if (!stat) throw new Error('文件不存在');
      const cached = fileCache.getValid(fileSource, new Date(stat.mtime).getTime());
      if (cached) {
        return cached.content;
      }
      // 缓存未命中或已过期，读取并缓存
      const content = await window.electronAPI!.fs.readFile(fileSource);
      fileCache.setContent(fileSource, content, new Date(stat.mtime).getTime());
      return content;
    } catch {
      // stat 失败时直接读取
      return window.electronAPI!.fs.readFile(fileSource);
    }
  }
  if (isHandle(fileSource) && fileSource.kind === 'file') {
    const file = await (fileSource as FileSystemFileHandle).getFile();
    return file.text();
  }
  throw new Error('无法读取文件：不支持的文件源');
}

export function isSameSource(a: FileSource, b: FileSource): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  if (typeof a !== 'string' && typeof b !== 'string') return a.name === b.name;
  return false;
}

/**
 * 获取缓存统计信息（用于调试和状态栏展示）
 */
export function getFileCacheStats() {
  return fileCache.getStats();
}

/**
 * 清除文件缓存
 */
export function clearFileCache() {
  fileCache.clear();
}

/* ────────────────────────────────────────────── */
/*  历史记录：最近打开的项目                         */
/* ────────────────────────────────────────────── */

/**
 * 获取最近打开的项目列表
 */
export async function getRecentProjects(): Promise<RecentProject[]> {
  if (!isElectron()) return [];
  return window.electronAPI!.history.getRecent();
}

/**
 * 添加项目到历史记录
 */
export async function addRecentProject(projectPath: string, name: string): Promise<void> {
  if (!isElectron()) return;
  await window.electronAPI!.history.addRecent(projectPath, name);
}

/**
 * 从历史记录中移除项目
 */
export async function removeRecentProject(projectPath: string): Promise<void> {
  if (!isElectron()) return;
  await window.electronAPI!.history.removeRecent(projectPath);
}

/**
 * 清空历史记录
 */
export async function clearAllRecentProjects(): Promise<void> {
  if (!isElectron()) return;
  await window.electronAPI!.history.clearAll();
}

/**
 * 获取历史记录存储文件路径（调试用）
 */
export async function getHistoryFilePath(): Promise<string | null> {
  if (!isElectron()) return null;
  return window.electronAPI!.history.getFilePath();
}

/* ────────────────────────────────────────────── */
/*  Electron 独占能力：文件监听（后台模式）            */
/* ────────────────────────────────────────────── */

/**
 * 启动文件监听（后台模式持续运行）
 * 即使窗口失焦，文件变更也会通过 IPC 推送过来
 */
export async function watchDirectory(
  watchPath: string,
  onChange: (event: { eventType: string; filename: string | null; path: string }) => void
): Promise<() => void> {
  if (!isElectron()) {
    console.warn('[fileService] 文件监听仅在 Electron 环境中可用');
    return () => {};
  }

  const result = await window.electronAPI!.fs.watch(watchPath);
  if (!result.success && !result.alreadyWatching) {
    throw new Error(`监听失败: ${result.reason}`);
  }

  const unsubscribe = window.electronAPI!.fs.onChange(onChange);
  return () => {
    unsubscribe();
    window.electronAPI!.fs.unwatch(watchPath);
  };
}

/* ────────────────────────────────────────────── */
/*  Electron 独占能力：扩展宿主 RPC                  */
/* ────────────────────────────────────────────── */

/* ────────────────────────────────────────────── */
/*  文件操作：新建 / 删除 / 重命名 / 复制 / 显示      */
/* ────────────────────────────────────────────── */

/**
 * 检查指定目录下是否存在给定名称的文件或文件夹
 */
export async function exists(parentSource: FileSource, name: string): Promise<boolean> {
  if (isElectron() && isPath(parentSource)) {
    const result = await window.electronAPI!.fs.stat(parentSource + '/' + name);
    return result !== null;
  }
  if (isHandle(parentSource) && parentSource.kind === 'directory') {
    const dirHandle = parentSource as FileSystemDirectoryHandle;
    try {
      await dirHandle.getFileHandle(name);
      return true;
    } catch {
      try {
        await dirHandle.getDirectoryHandle(name);
        return true;
      } catch {
        return false;
      }
    }
  }
  return false;
}

export async function createFile(parentSource: FileSource, name: string): Promise<FileEntry> {
  if (isElectron() && isPath(parentSource)) {
    const filePath = parentSource + '/' + name;
    await window.electronAPI!.fs.createFile(filePath);
    return { name, kind: 'file', source: filePath };
  }
  if (isHandle(parentSource) && parentSource.kind === 'directory') {
    const handle = await (parentSource as FileSystemDirectoryHandle).getFileHandle(name, { create: true });
    return { name, kind: 'file', source: handle };
  }
  throw new Error('无法创建文件：不支持的文件源');
}

export async function createDirectory(parentSource: FileSource, name: string): Promise<FileEntry> {
  if (isElectron() && isPath(parentSource)) {
    const dirPath = parentSource + '/' + name;
    await window.electronAPI!.fs.createDir(dirPath);
    return { name, kind: 'directory', source: dirPath };
  }
  if (isHandle(parentSource) && parentSource.kind === 'directory') {
    const handle = await (parentSource as FileSystemDirectoryHandle).getDirectoryHandle(name, { create: true });
    return { name, kind: 'directory', source: handle };
  }
  throw new Error('无法创建目录：不支持的文件源');
}

export async function deleteEntry(parentSource: FileSource, name: string, kind: 'file' | 'directory'): Promise<boolean> {
  if (isElectron() && isPath(parentSource)) {
    const targetPath = parentSource + '/' + name;
    return window.electronAPI!.fs.delete(targetPath);
  }
  if (isHandle(parentSource) && parentSource.kind === 'directory') {
    await (parentSource as FileSystemDirectoryHandle).removeEntry(name, { recursive: kind === 'directory' });
    return true;
  }
  return false;
}

export async function renameEntry(parentSource: FileSource, oldName: string, newName: string, kind: 'file' | 'directory'): Promise<boolean> {
  if (isElectron() && isPath(parentSource)) {
    const oldPath = parentSource + '/' + oldName;
    const newPath = parentSource + '/' + newName;
    return window.electronAPI!.fs.rename(oldPath, newPath);
  }
  // 浏览器环境不支持原生重命名，通过复制+删除模拟（仅限文件）
  if (isHandle(parentSource) && parentSource.kind === 'directory' && kind === 'file') {
    const dirHandle = parentSource as FileSystemDirectoryHandle;
    const oldFileHandle = await dirHandle.getFileHandle(oldName);
    const file = await oldFileHandle.getFile();
    const content = await file.text();
    const newFileHandle = await dirHandle.getFileHandle(newName, { create: true });
    const writable = await newFileHandle.createWritable();
    await writable.write(content);
    await writable.close();
    await dirHandle.removeEntry(oldName);
    return true;
  }
  throw new Error('无法重命名：不支持的文件源或类型');
}

export async function copyEntry(srcParent: FileSource, srcName: string, destParent: FileSource, destName: string): Promise<boolean> {
  if (isElectron() && isPath(srcParent) && isPath(destParent)) {
    const srcPath = srcParent + '/' + srcName;
    const destPath = destParent + '/' + destName;
    return window.electronAPI!.fs.copy(srcPath, destPath);
  }
  // 浏览器环境：读取内容后写入
  if (isHandle(srcParent) && isHandle(destParent) && srcParent.kind === 'directory' && destParent.kind === 'directory') {
    const srcFileHandle = await (srcParent as FileSystemDirectoryHandle).getFileHandle(srcName);
    const file = await srcFileHandle.getFile();
    const content = await file.text();
    const destFileHandle = await (destParent as FileSystemDirectoryHandle).getFileHandle(destName, { create: true });
    const writable = await destFileHandle.createWritable();
    await writable.write(content);
    await writable.close();
    return true;
  }
  throw new Error('无法复制：不支持的文件源');
}

/**
 * 生成不冲突的复制名称
 * 如 "text1.txt" → "text1 (1).txt" → "text1 (2).txt"
 */
export async function generateCopyName(
  parentSource: FileSource,
  name: string,
  kind: 'file' | 'directory'
): Promise<string> {
  if (kind === 'directory') {
    let seq = 1;
    let candidate = `${name} (${seq})`;
    while (await exists(parentSource, candidate)) {
      seq++;
      candidate = `${name} (${seq})`;
    }
    return candidate;
  }

  const dotIdx = name.lastIndexOf('.');
  const hasExt = dotIdx > 0;
  const base = hasExt ? name.substring(0, dotIdx) : name;
  const ext  = hasExt ? name.substring(dotIdx) : '';

  let seq = 1;
  let candidate = `${base} (${seq})${ext}`;
  while (await exists(parentSource, candidate)) {
    seq++;
    candidate = `${base} (${seq})${ext}`;
  }
  return candidate;
}

export async function revealInExplorer(source: FileSource): Promise<boolean> {
  if (isElectron() && isPath(source)) {
    return window.electronAPI!.fs.reveal(source);
  }
  // 浏览器环境无此能力
  console.warn('[fileService] revealInExplorer 仅在 Electron 中可用');
  return false;
}

/* ────────────────────────────────────────────── */
/*  剪贴板：用于文件树剪切/复制/粘贴               */
/*  不依赖系统剪贴板，用内存存储                   */
/* ────────────────────────────────────────────── */

export interface FileClipboardItem {
  source: FileSource;
  name: string;
  kind: 'file' | 'directory';
  parentSource: FileSource;
  action: 'cut' | 'copy';
}

let fileClipboard: FileClipboardItem | null = null;

export function setFileClipboard(item: FileClipboardItem | null) {
  fileClipboard = item;
}

export function getFileClipboard(): FileClipboardItem | null {
  return fileClipboard;
}

/**
 * 写入文件内容
 *
 * Electron 模式下通过 IPC 直接写入磁盘（无需弹窗授权）。
 * 浏览器模式下通过 File System Access API 的 WritableStream 写入。
 */
export async function writeFile(fileSource: FileSource, content: string): Promise<void> {
  if (isElectron() && isPath(fileSource)) {
    await window.electronAPI!.fs.writeFile(fileSource, content);
    return;
  }
  if (isHandle(fileSource) && fileSource.kind === 'file') {
    const writable = await (fileSource as FileSystemFileHandle).createWritable();
    await writable.write(content);
    await writable.close();
    return;
  }
  throw new Error('无法写入文件：不支持的文件源');
}

/**
 * 调用扩展宿主进程的 JSON-RPC 方法
 * 扩展在独立的 Node.js 子进程中运行，通过主进程代理通信
 */
export async function extensionRpc<T = unknown>(
  method: string,
  params: unknown
): Promise<T> {
  if (!isElectron()) {
    throw new Error('扩展宿主仅在 Electron 环境中可用');
  }
  const result = await window.electronAPI!.extension.rpc(method, params);
  if (!result.success) {
    throw new Error(result.error || '扩展宿主调用失败');
  }
  return result.result as T;
}
