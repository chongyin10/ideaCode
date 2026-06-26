/**
 * 扩展管理适配器
 *
 * 处理扩展生命周期相关请求（安装、卸载、启用、禁用）
 * 以及 Git 扩展专用 API。
 *
 * 替代原 ExtensionBridge 中的 extension.* / git.* RPC handlers。
 */

import type { IServiceBus } from '@ideacode/kernel';
import type { ServiceAdapter } from './ServiceAdapter.js';

export interface ExtensionMgmtProvider {
  disableExtension(extId: string): Promise<{ success: boolean; error?: string }>;
  enableExtension(extId: string): Promise<{ success: boolean; error?: string }>;
  uninstallExtension(extId: string): Promise<{ success: boolean; error?: string }>;
  getExtensionBridge(): { invokeExtension(extId: string, method: string, args?: unknown[]): Promise<unknown> };
}

export interface GitStateProvider {
  dispatchGitStatus(status: Record<string, string>): void;
  dispatchGitBranch(branch: string | null): void;
  getWorkspaceRoot(): string | null;
}

export class ExtensionMgmtAdapter implements ServiceAdapter {
  readonly id = 'extensionMgmt';

  private extProvider: ExtensionMgmtProvider | null = null;
  private gitProvider: GitStateProvider | null = null;

  setExtensionProvider(provider: ExtensionMgmtProvider): void {
    this.extProvider = provider;
  }

  setGitProvider(provider: GitStateProvider): void {
    this.gitProvider = provider;
  }

  register(bus: IServiceBus): void {
    // 扩展生命周期
    bus.handle('extension.disable', async (params) => {
      const { extId } = params as { extId: string };
      return this.extProvider?.disableExtension(extId) ?? { success: false, error: '不可用' };
    });

    bus.handle('extension.enable', async (params) => {
      const { extId } = params as { extId: string };
      return this.extProvider?.enableExtension(extId) ?? { success: false, error: '不可用' };
    });

    bus.handle('extension.uninstall', async (params) => {
      const { extId } = params as { extId: string };
      return this.extProvider?.uninstallExtension(extId) ?? { success: false, error: '不可用' };
    });

    // Git 状态推送
    bus.handle('git.statusChanged', (params) => {
      const { status } = (params || {}) as { status?: Record<string, string> };
      if (status) this.gitProvider?.dispatchGitStatus(status);
      return { updated: true };
    });

    bus.handle('git.branchChanged', (params) => {
      const { branch } = (params || {}) as { branch?: string };
      this.gitProvider?.dispatchGitBranch(branch || null);
      return { updated: true };
    });

    // Git 打开文件
    bus.handle('git.openFile', async (params) => {
      const { path, original = '', modified = '', isBinary = false } = params as {
        path: string;
        staged?: boolean;
        original?: string;
        modified?: string;
        isBinary?: boolean;
      };

      if (!path) return { success: false, error: '缺少 path 参数' };

      const root = this.gitProvider?.getWorkspaceRoot();
      if (!root) return { success: false, error: '没有打开的工作区' };

      const base = String(root).replace(/\/$/, '');
      const fullPath = `${base}/${path}`;
      const fileName = path.split('/').pop() || path;

      // 通知 Redux 打开文件
      if (isBinary || (!original && !modified)) {
        // 普通打开
        return { success: true, filePath: fullPath, fileName };
      }

      // Diff 视图
      return {
        success: true,
        filePath: fullPath,
        fileName,
        original,
        modified,
        isDiff: true,
      };
    });

    // Git 加载目录
    bus.handle('git.loadDirectory', (params) => {
      const { path: dirPath } = params as { path: string };
      const name = dirPath.split(/[\\/]/).pop() || dirPath;
      return { success: true, dirPath, name };
    });

    // Git 打开仓库对话框
    bus.handle('git.openRepositoryDialog', async () => {
      return null; // 由调用的 Electron API 处理
    });

    // Git 克隆
    bus.handle('git.clone', (params) => {
      const { url, targetPath } = params as { url: string; targetPath: string };
      return { success: true, url, targetPath };
    });

    // 批量 status 推送
    bus.handle('git.pushState', (params) => {
      const { status, branch } = (params || {}) as { status?: Record<string, string>; branch?: string };
      if (status) this.gitProvider?.dispatchGitStatus(status);
      if (branch !== undefined) this.gitProvider?.dispatchGitBranch(branch ?? null);
      return { pushed: true };
    });

    console.log('[ExtensionMgmtAdapter] 已注册 10 个处理器');
  }
}
