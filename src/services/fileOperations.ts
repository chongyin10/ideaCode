import type { FileSource, FileEntry } from './fileService';
import { isElectron, isPath, isHandle, isRemoteUri } from './fileService';
import { getFileSystemProvider } from './fileSystemProvider';

function joinChildSource(parentSource: string, name: string): string {
  return parentSource.replace(/\/+$/, '') + '/' + name;
}

export async function exists(parentSource: FileSource, name: string): Promise<boolean> {
  if (isRemoteUri(parentSource)) {
    const provider = getFileSystemProvider(parentSource);
    if (!provider) return false;
    const stat = await provider.stat(joinChildSource(parentSource, name));
    return stat !== null;
  }

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
  if (isRemoteUri(parentSource)) {
    const provider = getFileSystemProvider(parentSource);
    if (!provider) throw new Error('无法创建文件：未找到远程 provider');
    const source = joinChildSource(parentSource, name);
    await provider.writeFile(source, '');
    return { name, kind: 'file', source };
  }

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
  if (isRemoteUri(parentSource)) {
    const provider = getFileSystemProvider(parentSource);
    if (!provider) throw new Error('无法创建目录：未找到远程 provider');
    const source = joinChildSource(parentSource, name);
    await provider.createDirectory(source);
    return { name, kind: 'directory', source };
  }

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
  if (isRemoteUri(parentSource)) {
    const provider = getFileSystemProvider(parentSource);
    if (!provider) return false;
    await provider.delete(joinChildSource(parentSource, name), { recursive: kind === 'directory' });
    return true;
  }

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
  if (isRemoteUri(parentSource)) {
    const provider = getFileSystemProvider(parentSource);
    if (!provider) throw new Error('无法重命名：未找到远程 provider');
    await provider.rename(
      joinChildSource(parentSource, oldName),
      joinChildSource(parentSource, newName)
    );
    return true;
  }

  if (isElectron() && isPath(parentSource)) {
    const oldPath = parentSource + '/' + oldName;
    const newPath = parentSource + '/' + newName;
    return window.electronAPI!.fs.rename(oldPath, newPath);
  }
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
  if (isRemoteUri(srcParent) || isRemoteUri(destParent)) {
    if (!isRemoteUri(srcParent) || !isRemoteUri(destParent)) {
      throw new Error('暂不支持本地与远程之间的文件复制');
    }
    const provider = getFileSystemProvider(srcParent);
    if (!provider) throw new Error('无法复制：未找到远程 provider');
    const srcUri = joinChildSource(srcParent, srcName);
    const destUri = joinChildSource(destParent, destName);
    const stat = await provider.stat(srcUri);
    if (!stat) throw new Error('无法复制：源不存在');
    if (stat.isDirectory) throw new Error('远程目录复制暂不支持');
    const content = await provider.readFile(srcUri);
    await provider.writeFile(destUri, content);
    return true;
  }

  if (isElectron() && isPath(srcParent) && isPath(destParent)) {
    const srcPath = srcParent + '/' + srcName;
    const destPath = destParent + '/' + destName;
    return window.electronAPI!.fs.copy(srcPath, destPath);
  }
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
  console.warn('[fileService] revealInExplorer 仅在 Electron 中可用');
  return false;
}
