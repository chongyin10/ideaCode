/**
 * 文件系统 Provider 抽象层
 *
 * 允许扩展（如 SSH 扩展）注册自定义 scheme 的远程文件系统，
 * IDE 资源管理器通过统一的 provider 接口访问目录和文件。
 */

export interface FileSystemEntry {
  name: string;
  kind: 'file' | 'directory';
  uri: string;
}

export interface FileStat {
  isDirectory: boolean;
  size?: number;
}

export interface FileSystemProvider {
  scheme: string;
  readDirectory(uri: string): Promise<FileSystemEntry[]>;
  readFile(uri: string): Promise<string>;
  writeFile(uri: string, content: string): Promise<void>;
  createDirectory(uri: string): Promise<void>;
  delete(uri: string, options?: { recursive?: boolean }): Promise<void>;
  rename(oldUri: string, newUri: string): Promise<void>;
  stat(uri: string): Promise<FileStat | null>;
}

const providers = new Map<string, FileSystemProvider>();

export function registerFileSystemProvider(scheme: string, provider: FileSystemProvider): void {
  if (providers.has(scheme)) {
    console.warn(`[FileSystemProvider] scheme '${scheme}' 已被注册，将被覆盖`);
  }
  providers.set(scheme, provider);
}

export function getFileSystemProvider(uri: string): FileSystemProvider | null {
  const scheme = getUriScheme(uri);
  if (!scheme) return null;
  return providers.get(scheme) || null;
}

export function hasFileSystemProvider(scheme: string): boolean {
  return providers.has(scheme);
}

export function getUriScheme(uri: string): string | null {
  const idx = uri.indexOf('://');
  if (idx <= 0) return null;
  return uri.slice(0, idx);
}

export function parseRemoteUri(uri: string): { scheme: string; authority: string; path: string } | null {
  const scheme = getUriScheme(uri);
  if (!scheme) return null;
  const rest = uri.slice(scheme.length + 3);
  const pathIdx = rest.indexOf('/');
  if (pathIdx < 0) {
    return { scheme, authority: rest, path: '/' };
  }
  return {
    scheme,
    authority: rest.slice(0, pathIdx),
    path: rest.slice(pathIdx),
  };
}

export function joinRemoteUri(scheme: string, authority: string, path: string): string {
  const normalizedPath = path.startsWith('/') ? path : '/' + path;
  return `${scheme}://${authority}${normalizedPath}`;
}
