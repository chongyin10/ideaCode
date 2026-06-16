/**
 * Git 服务抽象层
 *
 * 封装所有 Git IPC 调用，提供类型安全的 Promise API。
 * 浏览器环境自动降级为空操作。
 */

import type { GitStatusResult, GitBranch, GitRemote, GitBehindAhead } from '../types/electron';

export type { GitBranch, GitRemote, GitBehindAhead };

function gitApi() {
  return window.electronAPI?.git;
}

export const gitService = {
  /** 获取文件状态映射 */
  async getStatus(dirPath: string): Promise<GitStatusResult> {
    return gitApi()?.getStatus(dirPath) ?? { staged: {}, changes: {}, merge: {}, untracked: {} };
  },

  /** 获取当前分支名 */
  async getBranch(dirPath: string): Promise<string> {
    return gitApi()?.getBranch(dirPath) ?? '';
  },

  /** 获取所有分支列表 */
  async listBranches(dirPath: string): Promise<GitBranch[]> {
    return gitApi()?.listBranches(dirPath) ?? [];
  },

  /** 切换到指定分支 */
  async checkout(dirPath: string, branch: string): Promise<void> {
    await gitApi()?.checkout(dirPath, branch);
  },

  /** 创建并切换到新分支，可指定起始点（如远程分支） */
  async createBranch(dirPath: string, branch: string, startPoint?: string): Promise<void> {
    await gitApi()?.createBranch(dirPath, branch, startPoint);
  },

  /** 暂存文件 */
  async stage(dirPath: string, files: string[]): Promise<void> {
    await gitApi()?.stage(dirPath, files);
  },

  /** 取消暂存文件 */
  async unstage(dirPath: string, files: string[]): Promise<void> {
    await gitApi()?.unstage(dirPath, files);
  },

  /** 提交 */
  async commit(dirPath: string, message: string): Promise<string> {
    return gitApi()?.commit(dirPath, message) ?? '';
  },

  /** 获取差异文本 */
  async getDiff(dirPath: string, staged?: boolean): Promise<string> {
    return gitApi()?.getDiff(dirPath, staged) ?? '';
  },

  /** 获取 HEAD 版本文件内容（用于 diff 对比） */
  async getOriginalContent(dirPath: string, filePath: string): Promise<string> {
    return gitApi()?.show(dirPath, filePath) ?? '';
  },

  /** 拉取 */
  async pull(dirPath: string): Promise<string> {
    return gitApi()?.pull(dirPath) ?? '';
  },

  /** 推送 */
  async push(dirPath: string): Promise<string> {
    return gitApi()?.push(dirPath) ?? '';
  },

  /** 获取所有远程 */
  async fetch(dirPath: string): Promise<void> {
    await gitApi()?.fetch(dirPath);
  },

  /** 获取远程仓库列表 */
  async listRemotes(dirPath: string): Promise<GitRemote[]> {
    return gitApi()?.listRemotes(dirPath) ?? [];
  },

  /** 获取提交日志 */
  async getLog(dirPath: string, count = 20): Promise<string[]> {
    return gitApi()?.getLog(dirPath, count) ?? [];
  },

  /** 获取 stash 列表 */
  async stashList(dirPath: string): Promise<string[]> {
    return gitApi()?.stashList(dirPath) ?? [];
  },

  /** 暂存工作区 */
  async stashPush(dirPath: string, message?: string): Promise<void> {
    await gitApi()?.stashPush(dirPath, message);
  },

  /** 恢复最近 stash */
  async stashPop(dirPath: string): Promise<void> {
    await gitApi()?.stashPop(dirPath);
  },

  /** 获取超前/落后提交数 */
  async getBehindAhead(dirPath: string): Promise<GitBehindAhead> {
    return gitApi()?.getBehindAhead(dirPath) ?? { ahead: 0, behind: 0 };
  },

  /** 丢弃文件更改 */
  async discard(dirPath: string, file: string): Promise<void> {
    await gitApi()?.discard(dirPath, file);
  },

  /** 初始化 Git 仓库 */
  async init(dirPath: string): Promise<void> {
    await gitApi()?.init(dirPath);
  },

  /** 克隆仓库 */
  async clone(repoUrl: string, targetPath: string): Promise<string> {
    return gitApi()?.clone(repoUrl, targetPath) ?? '';
  },

  /** 检查是否为 Git 仓库 */
  async isRepo(dirPath: string): Promise<boolean> {
    return gitApi()?.isRepo(dirPath) ?? false;
  },
};
