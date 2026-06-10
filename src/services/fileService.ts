import { FileContentCache } from '../utils/algorithms';


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
