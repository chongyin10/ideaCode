import { FileContentCache } from '../utils/algorithms';
import { WTinyLFU } from '../utils/algorithms/wTinyLFU';
import {
  getFileSystemProvider,
  getUriScheme,
  parseRemoteUri,
  joinRemoteUri,
  type FileSystemEntry,
} from './fileSystemProvider';

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

export function isRemoteUri(source: FileSource): source is string {
  return typeof source === 'string' && !!getUriScheme(source);
}

export function toRemoteUri(scheme: string, authority: string, path: string): string {
  return joinRemoteUri(scheme, authority, path);
}

export function remoteUriParts(source: string): { scheme: string; authority: string; path: string } | null {
  return parseRemoteUri(source);
}

/* ─── 文件内容缓存（双模式：LRU + W-TinyLFU）─── */

const fileCache = new FileContentCache(30);
const wtinyCache = new WTinyLFU<string, { content: string; mtime: number }>({
  maxSize: 50,
});

/** 使用哪个缓存（默认 W-TinyLFU） */
let useWTinyLFU = true;

export function setCacheStrategy(strategy: 'lru' | 'wtiny'): void {
  useWTinyLFU = strategy === 'wtiny';
}

function getCached(path: string, mtime: number): { content: string; hit: boolean } | null {
  if (useWTinyLFU) {
    const entry = wtinyCache.get(path);
    if (!entry) return null;
    if (entry.mtime !== mtime) {
      wtinyCache.delete(path);
      return null;
    }
    return { content: entry.content, hit: true };
  }
  return fileCache.getValid(path, mtime);
}

function setCached(path: string, content: string, mtime: number): void {
  if (useWTinyLFU) {
    wtinyCache.set(path, { content, mtime });
  } else {
    fileCache.setContent(path, content, mtime);
  }
}

/* ─── 文件系统抽象层 ─── */

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

export async function openFileDialog(): Promise<{ source: FileSource; name: string } | null> {
  if (isElectron()) {
    const filePath = await window.electronAPI!.dialog.openFile();
    if (!filePath) return null;
    const name = filePath.split(/[\\/]/).pop() || filePath;
    return { source: filePath, name };
  }
  try {
    const [fileHandle] = await window.showOpenFilePicker();
    return { source: fileHandle, name: fileHandle.name };
  } catch {
    return null;
  }
}

export async function readDirectory(parentSource: FileSource): Promise<FileEntry[]> {
  if (isRemoteUri(parentSource)) {
    const provider = getFileSystemProvider(parentSource);
    if (!provider) {
      throw new Error(`未找到远程文件系统 provider: ${parentSource}`);
    }
    const entries = await provider.readDirectory(parentSource);
    return entries
      .map((e: FileSystemEntry) => ({
        name: e.name,
        kind: e.kind,
        source: e.uri,
      }))
      .sort((a, b) => {
        if (a.kind === b.kind) return a.name.localeCompare(b.name);
        return a.kind === 'directory' ? -1 : 1;
      });
  }

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
  if (isRemoteUri(fileSource)) {
    const provider = getFileSystemProvider(fileSource);
    if (!provider) {
      throw new Error(`未找到远程文件系统 provider: ${fileSource}`);
    }
    return provider.readFile(fileSource);
  }

  if (isElectron() && isPath(fileSource)) {
    try {
      const stat = await window.electronAPI!.fs.stat(fileSource);
      if (!stat) throw new Error('文件不存在');
      // §修复 EISDIR 卡顿：fs.stat 对目录也能成功返回，但 fs.readFile 对目录会抛 EISDIR。
      // 此处提前识别目录并抛错，避免下方 readFile 触发 EISDIR 后被 catch 重复调用，
      // 导致每个符号链接目录触发 2 次 readFile + 2 次 IPC 错误打印，海量符号链接时雪崩卡顿。
      if (stat.isDirectory) throw new Error(`EISDIR: 无法读取目录: ${fileSource}`);
      const mtime = new Date(stat.mtime).getTime();
      const cached = getCached(fileSource, mtime);
      if (cached) return cached.content;
      const content = await window.electronAPI!.fs.readFile(fileSource);
      setCached(fileSource, content, mtime);
      return content;
    } catch (err) {
      // 目录或显式抛出的 EISDIR 直接向上抛，避免对目录重复 readFile
      if (err && typeof err.message === 'string' && err.message.startsWith('EISDIR')) throw err;
      // stat 不可用（权限/特殊文件）时降级：直接尝试 readFile
      return window.electronAPI!.fs.readFile(fileSource);
    }
  }
  if (isHandle(fileSource) && fileSource.kind === 'file') {
    const file = await (fileSource as FileSystemFileHandle).getFile();
    return file.text();
  }
  throw new Error('无法读取文件：不支持的文件源');
}

/**
 * 缓存预热：预加载最近项目中的关键文件
 * 在项目打开后调用，使用 requestIdleCallback 在后台渐进加载
 */
export async function warmupFileCache(
  rootPath: string,
  recentFilePaths: string[]
): Promise<void> {
  if (!isElectron()) return;

  const warmupBatch = async (paths: string[]) => {
    for (const filePath of paths) {
      try {
        const fullPath = rootPath + '/' + filePath;
        await readFile(fullPath);
      } catch {
        // 文件不可读，跳过
      }
    }
  };

  // 分批预加载，每批 3 个文件，避免阻塞主线程
  const batchSize = 3;
  for (let i = 0; i < recentFilePaths.length; i += batchSize) {
    const batch = recentFilePaths.slice(i, i + batchSize);
    await new Promise<void>((resolve) => {
      if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(() => {
          warmupBatch(batch).then(resolve);
        }, { timeout: 5000 });
      } else {
        setTimeout(() => {
          warmupBatch(batch).then(resolve);
        }, 50);
      }
    });
  }
}

export function isSameSource(a: FileSource, b: FileSource): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  if (typeof a !== 'string' && typeof b !== 'string') return a.name === b.name;
  return false;
}

export function getFileCacheStats() {
  if (useWTinyLFU) return wtinyCache.getStats();
  return fileCache.getStats();
}

export function clearFileCache() {
  if (useWTinyLFU) wtinyCache.clear();
  else fileCache.clear();
}

/* ─── 文件监听 ─── */

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

/* ─── 文件写入 ─── */

export async function writeFile(fileSource: FileSource, content: string): Promise<void> {
  if (isRemoteUri(fileSource)) {
    const provider = getFileSystemProvider(fileSource);
    if (!provider) {
      throw new Error(`未找到远程文件系统 provider: ${fileSource}`);
    }
    await provider.writeFile(fileSource, content);
    return;
  }

  if (isElectron() && isPath(fileSource)) {
    await window.electronAPI!.fs.writeFile(fileSource, content);
    // 写入后更新缓存（避免下次读取到旧内容）
    try {
      const stat = await window.electronAPI!.fs.stat(fileSource);
      if (stat) {
        setCached(fileSource, content, new Date(stat.mtime).getTime());
      }
    } catch { /* 忽略 */ }
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

/* ─── 扩展宿主 RPC ─── */

/* ─── 文件删除 ─── */

export async function deleteFile(fileSource: FileSource, options?: { recursive?: boolean }): Promise<void> {
  if (isRemoteUri(fileSource)) {
    const provider = getFileSystemProvider(fileSource);
    if (!provider) {
      throw new Error(`未找到远程文件系统 provider: ${fileSource}`);
    }
    await provider.delete(fileSource, options);
    return;
  }

  if (isElectron() && isPath(fileSource)) {
    const ok = await window.electronAPI!.fs.delete(fileSource);
    if (!ok) {
      throw new Error('删除文件失败（文件可能不存在或无权限）');
    }
    return;
  }

  if (isHandle(fileSource) && fileSource.kind === 'file') {
    // FileSystemFileHandle 没有标准删除方法，清空内容作为近似删除
    const writable = await (fileSource as FileSystemFileHandle).createWritable();
    await writable.write('');
    await writable.close();
    return;
  }
  throw new Error('无法删除文件：不支持的文件源');
}

/* ─── 扩展宿主 RPC ─── */

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

/* ─── 内容搜索（ripgrep，对标 VSCode）───
 *
 * §架构差异：旧实现把整文件 readFile 到渲染进程再 JS 搜索，362MB 大文件触发
 * 128MB 上限报错。此处改为调用主进程 spawn rg，rg 在 Rust 端流式扫描，
 * 只把匹配行通过 IPC 事件推送给渲染进程，内存压力与文件大小解耦。
 *
 * 用法：调用方传入 searchId 用于过滤并发搜索的事件，onProgress 增量更新 UI，
 * onDone 标记结束。返回 cancel 函数用于中止搜索。
 */
export interface SearchContentMatch {
  line: number;
  column: number;
  text: string;
  match: { index: number; length: number; matched: string };
}

export interface SearchContentResult {
  filePath: string;
  fileName: string;
  matches: SearchContentMatch[];
}

export interface SearchContentOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  useRegex?: boolean;
  includePattern?: string;
  excludePattern?: string;
  maxResults?: number;
}

export interface SearchContentCallbacks {
  onProgress?: (data: { results: SearchContentResult[]; totalMatches: number; isTruncated: boolean }) => void;
  onDone?: (data: { results: SearchContentResult[]; totalMatches: number; isTruncated: boolean; error?: string }) => void;
}

export async function searchContent(
  rootPath: string,
  query: string,
  options: SearchContentOptions,
  callbacks: SearchContentCallbacks,
  searchId: number
): Promise<{ started: boolean; error?: string; cancel: () => void }> {
  if (!isElectron()) {
    return { started: false, error: 'ripgrep 搜索仅在 Electron 环境可用', cancel: () => {} };
  }

  // §事件监听用 searchId 过滤：多个并发搜索（或旧搜索的尾包）不会串扰
  const onProgressUnsub = window.electronAPI!.fs.onSearchProgress((data: { searchId: number; results: SearchContentResult[]; totalMatches: number; isTruncated: boolean }) => {
    if (data.searchId !== searchId) return;
    callbacks.onProgress?.(data);
  });

  const onDoneUnsub = window.electronAPI!.fs.onSearchDone((data: { searchId: number; results: SearchContentResult[]; totalMatches: number; isTruncated: boolean; error?: string }) => {
    if (data.searchId !== searchId) return;
    // 收到 done 后立即解绑，避免监听器堆积
    onProgressUnsub();
    onDoneUnsub();
    callbacks.onDone?.(data);
  });

  const startResult = await window.electronAPI!.fs.search({ rootPath, query, options, searchId });

  const cancel = () => {
    onProgressUnsub();
    onDoneUnsub();
    void window.electronAPI!.fs.searchCancel();
  };

  if (!startResult?.started) {
    // 启动失败：done 事件不会触发，需手动清理监听并回调
    onProgressUnsub();
    onDoneUnsub();
    return { started: false, error: startResult?.error || '启动失败', cancel };
  }

  return { started: true, cancel };
}
