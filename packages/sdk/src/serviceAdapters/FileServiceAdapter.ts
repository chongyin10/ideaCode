/**
 * 文件服务适配器
 *
 * 处理扩展对文件系统的访问请求，通过 ServiceBus 桥接到 Electron 主进程的 FsHandler。
 * 替代原 ExtensionBridge 中的 fs.* RPC handlers。
 */

import type { IServiceBus } from '@ideacode/kernel';
import type { ServiceAdapter } from './ServiceAdapter.js';

export class FileServiceAdapter implements ServiceAdapter {
  readonly id = 'fileService';

  /**
   * 数据获取器 - 由宿主环境注入
   * Electron 环境: window.electronAPI.fs.*
   */
  private fileApi: FileApiProvider | null = null;

  setFileApi(api: FileApiProvider): void {
    this.fileApi = api;
  }

  register(bus: IServiceBus): void {
    bus.handle('fs.readDir', async (params) => {
      const { path } = params as { path: string };
      return this.fileApi?.readDir(path) ?? [];
    });

    bus.handle('fs.readFile', async (params) => {
      const { path } = params as { path: string };
      return this.fileApi?.readFile(path) ?? '';
    });

    bus.handle('fs.writeFile', async (params) => {
      const { path, content } = params as { path: string; content: string };
      return await this.fileApi?.writeFile(path, content) ?? false;
    });

    bus.handle('fs.stat', async (params) => {
      const { path } = params as { path: string };
      return this.fileApi?.stat(path) ?? null;
    });

    bus.handle('fs.createFile', async (params) => {
      const { path } = params as { path: string };
      return await this.fileApi?.createFile(path) ?? false;
    });

    bus.handle('fs.createDir', async (params) => {
      const { path } = params as { path: string };
      return await this.fileApi?.createDir(path) ?? false;
    });

    bus.handle('fs.delete', async (params) => {
      const { path, recursive } = params as { path: string; recursive?: boolean };
      return await this.fileApi?.delete(path, recursive) ?? false;
    });

    bus.handle('fs.rename', async (params) => {
      const { oldPath, newPath, overwrite } = params as { oldPath: string; newPath: string; overwrite?: boolean };
      return await this.fileApi?.rename(oldPath, newPath, overwrite) ?? false;
    });

    bus.handle('fs.copy', async (params) => {
      const { srcPath, destPath } = params as { srcPath: string; destPath: string };
      return await this.fileApi?.copy(srcPath, destPath) ?? false;
    });

    bus.handle('fs.reveal', async (params) => {
      const { path } = params as { path: string };
      return await this.fileApi?.reveal(path) ?? false;
    });

    bus.handle('fs.search', async (params) => {
      const { rootPath, query, maxResults } = params as { rootPath: string; query: string; maxResults?: number };
      // 委托给 Extension Host 的搜索能力
      return { forwarded: true, rootPath, query, maxResults };
    });

    console.log('[FileServiceAdapter] 已注册 12 个处理器');
  }
}

export interface FileApiProvider {
  readDir(dirPath: string): Promise<unknown[]>;
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<boolean>;
  stat(filePath: string): Promise<unknown>;
  createFile(filePath: string): Promise<boolean>;
  createDir(dirPath: string): Promise<boolean>;
  delete(targetPath: string, recursive?: boolean): Promise<boolean>;
  rename(oldPath: string, newPath: string, overwrite?: boolean): Promise<boolean>;
  copy(srcPath: string, destPath: string): Promise<boolean>;
  reveal(filePath: string): Promise<boolean>;
}
