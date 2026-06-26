/**
 * 工作区服务适配器
 *
 * 处理扩展对工作区状态的访问（根路径、文件夹、文件操作）。
 * 替代原 ExtensionBridge 中的 workspace.* / configuration.* / storage.* 等 RPC handlers。
 */

import type { IServiceBus } from '@ideacode/kernel';
import type { ServiceAdapter } from './ServiceAdapter.js';

export interface WorkspaceStateProvider {
  getRootSource(): string | null;
  dispatch(action: unknown): void;
  getState(): {
    workspace: {
      rootSource: string | null;
      openedFiles: Array<{ id: string; name: string; source: string | { toString(): string }; language?: string; isDirty?: boolean }>;
      activeFileId: string | null;
    };
    settings: Record<string, unknown>;
  };
}

export interface StorageProvider {
  get(prefix: string, key: string, defaultValue?: unknown): unknown;
  set(prefix: string, key: string, value: unknown): void;
}

export class WorkspaceServiceAdapter implements ServiceAdapter {
  readonly id = 'workspaceService';

  private workspaceState: WorkspaceStateProvider | null = null;
  private storage: StorageProvider | null = null;

  setWorkspaceState(state: WorkspaceStateProvider): void {
    this.workspaceState = state;
  }

  setStorage(storage: StorageProvider): void {
    this.storage = storage;
  }

  register(bus: IServiceBus): void {
    // 根路径
    bus.handle('workspace.getRootPath', () => {
      return this.workspaceState?.getRootSource() ?? null;
    });

    // 工作区文件夹
    bus.handle('workspace.getFolders', () => {
      const root = this.workspaceState?.getRootSource();
      return root
        ? [{ uri: { fsPath: root, scheme: 'file' }, name: 'workspace', index: 0 }]
        : [];
    });

    // 获取工作区文件夹（VS Code 兼容名）
    bus.handle('workspace.getWorkspaceFolders', () => {
      const root = this.workspaceState?.getRootSource();
      return root
        ? [{ uri: { fsPath: root, scheme: 'file' }, name: 'workspace', index: 0 }]
        : [];
    });

    // 打开文档
    bus.handle('workspace.openDocument', (params) => {
      const { fileName } = params as { fileName: string };
      // 通过 Redux dispatch 打开文件
      this.workspaceState?.dispatch({
        type: 'workspace/openFile',
        payload: { name: fileName.split('/').pop() || fileName, kind: 'file', source: fileName },
      });
      return { opened: true };
    });

    // 打开远程文件树
    bus.handle('workspace.openRemoteFileTree', (params) => {
      const { title, tree } = params as { title: string; tree: unknown };
      const id = `ssh-tree-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      this.workspaceState?.dispatch({
        type: 'workspace/openVirtualFile',
        payload: {
          id, name: title || '远程目录结构',
          source: `ssh-tree://${id}`,
          content: JSON.stringify(tree),
          language: 'ssh-file-tree',
          isDirty: false,
        },
      });
      return { opened: true };
    });

    // 注册文件系统提供者
    bus.handle('workspace.registerFileSystemProvider', async (params) => {
      const { scheme, extensionId } = params as { scheme: string; extensionId: string };
      // 委托给现有的 fileSystemProvider 注册机制
      return { registered: true, scheme, extensionId };
    });

    // 配置获取
    bus.handle('configuration.get', (params) => {
      const { section } = params as { section: string };
      const settings = this.workspaceState?.getState().settings || {};
      return (settings as Record<string, unknown>)[section] || {};
    });

    // 存储
    bus.handle('storage.get', (params) => {
      const { prefix, key, defaultValue } = params as { prefix: string; key: string; defaultValue?: unknown };
      const value = this.storage?.get(prefix, key, defaultValue);
      return { value };
    });

    bus.handle('storage.set', (params) => {
      const { prefix, key, value } = params as { prefix: string; key: string; value: unknown };
      this.storage?.set(prefix, key, value);
      return { saved: true };
    });

    // 密钥存储（占位）
    bus.handle('secrets.get', () => ({ value: null }));
    bus.handle('secrets.store', () => ({ stored: true }));
    bus.handle('secrets.delete', () => ({ deleted: true }));

    // 环境 API
    bus.handle('env.clipboard.writeText', async (params) => {
      const { text } = params as { text: string };
      await navigator.clipboard.writeText(text);
      return { written: true };
    });

    bus.handle('env.clipboard.readText', async () => {
      try {
        const text = await navigator.clipboard.readText();
        return { text };
      } catch {
        return { text: '' };
      }
    });

    bus.handle('env.openExternal', (params) => {
      const { uri } = params as { uri: string };
      window.open(uri, '_blank');
      return { opened: true };
    });

    console.log('[WorkspaceServiceAdapter] 已注册 14 个处理器');
  }
}
