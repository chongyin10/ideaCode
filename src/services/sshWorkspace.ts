/**
 * §SSH 工作区检测工具（Skill）
 *
 * 统一管理 SSH 远程工作区的状态判断与连接信息获取。
 * 在此之前，SSH 检测逻辑以 5 种不同形式散落在 BottomPanel、ExplorerContent、
 * SearchPanel、extensionBridge 等多处，存在重复代码与隐式依赖。
 *
 * 使用方式：
 *   import { isSshWorkspace, getCurrentSshConfig, buildSshTerminalArgs } from '../services/sshWorkspace';
 *
 *   // 终端创建前先检测
 *   const sshConfig = getCurrentSshConfig();
 *   if (sshConfig) {
 *     const { executable, args, name } = buildSshTerminalArgs(sshConfig.conn, sshConfig.remotePath);
 *     // 创建 SSH 终端...
 *   } else {
 *     // 创建本地终端...
 *   }
 *
 *   // 搜索结果点击前先检测
 *   if (isSshWorkspace()) {
 *     const entry = { source: buildSshUri(...), ... };
 *   }
 */

import { store } from '../store';
import type { SshConnectionInfo } from '../store/slices/workspaceSlice';
import { parseRemoteUri } from './fileSystemProvider';
import { isRemoteUri, type FileSource } from './fileService';

/**
 * 判断给定 source 是否为 SSH 远程 URI（ssh:// 前缀）。
 * @param source 文件源（FileSystemHandle 或路径字符串）
 */
export function isSshSource(source: FileSource): boolean {
  if (!isRemoteUri(source)) return false;
  const parts = parseRemoteUri(String(source));
  return parts?.scheme === 'ssh';
}

/**
 * 当前工作区的 rootSource 是否为 SSH 远程工作区。
 * 直接从 Redux store 读取 rootSource 判断。
 */
export function isSshWorkspace(): boolean {
  const { rootSource } = store.getState().workspace;
  return typeof rootSource === 'string' && isSshSource(rootSource);
}

/**
 * 从 source 中解析出 SSH 连接 ID（即 URI 的 authority 部分）。
 * @returns 连接 ID；非 SSH source 返回 null
 */
export function getSshConnectionId(source: FileSource): string | null {
  if (!isRemoteUri(source)) return null;
  const parts = parseRemoteUri(String(source));
  if (!parts || parts.scheme !== 'ssh') return null;
  return parts.authority;
}

/**
 * 从 source 中解析出远程路径（不含 ssh://<connId> 前缀）。
 * @returns 远程路径如 "/home/user/project"；非 SSH source 返回 null
 */
export function getSshRemotePath(source: FileSource): string | null {
  if (!isRemoteUri(source)) return null;
  const parts = parseRemoteUri(String(source));
  if (!parts || parts.scheme !== 'ssh') return null;
  return parts.path || '/';
}

/**
 * 从 Redux store 中查找给定 source 对应的 SSH 连接信息。
 * @returns 连接信息；未找到或非 SSH source 返回 null
 */
export function getSshConnection(source: FileSource): SshConnectionInfo | null {
  const connId = getSshConnectionId(source);
  if (!connId) return null;
  const { sshConnections } = store.getState().workspace;
  return sshConnections[connId] || null;
}

/**
 * 获取当前工作区的 SSH 配置（连接信息 + 远程路径）。
 *
 * 这是终端、全局搜索等功能的前置检测入口：
 *   - 返回非 null → 当前是 SSH 远程工作区，应创建 SSH 终端 / 构造远程 URI
 *   - 返回 null → 当前是本地工作区，走本地逻辑
 *
 * @returns { conn, remotePath, connectionId } 或 null
 */
export function getCurrentSshConfig(): {
  conn: SshConnectionInfo;
  remotePath: string;
  connectionId: string;
} | null {
  const { rootSource, sshConnections } = store.getState().workspace;
  if (typeof rootSource !== 'string') return null;

  const parts = parseRemoteUri(rootSource);
  if (!parts || parts.scheme !== 'ssh') return null;

  const conn = sshConnections[parts.authority];
  if (!conn) return null;

  return {
    conn,
    remotePath: parts.path || '/',
    connectionId: parts.authority,
  };
}

/**
 * 构造 SSH 终端启动参数。
 *
 * 统一了 BottomPanel.handleCreateTab、BottomPanel.handleSplitTab、
 * ExplorerContent.handleOpenInTerminal 三处的 ssh 命令构造逻辑。
 *
 * 生成的命令：ssh -p <port> -t <user>@<host> "cd '<remotePath>' && exec $SHELL -l"
 *
 * @param conn SSH 连接信息
 * @param remotePath 远程工作目录（绝对路径）
 * @returns { executable, args, name } 可直接传给 createTerminal / terminalSDK.createTab
 */
export function buildSshTerminalArgs(
  conn: SshConnectionInfo,
  remotePath: string,
): {
  executable: 'ssh';
  args: string[];
  name: string;
} {
  const dir = remotePath || '/';
  // 单引号转义：路径中可能含单引号，用 '\'' 中断单引号字符串再重新开始
  const escapedDir = `'${dir.replace(/'/g, "'\\''")}'`;
  return {
    executable: 'ssh',
    args: [
      '-p', String(conn.port || 22),
      '-t',
      `${conn.username}@${conn.host}`,
      `cd ${escapedDir} && exec $SHELL -l`,
    ],
    name: `${conn.name} · ${conn.username}@${conn.host}`,
  };
}

/**
 * 构造 SSH URI（ssh://<connId><path>）。
 * 用于全局搜索等场景下拼接文件 URI。
 *
 * @param connectionId 连接 ID
 * @param remotePath 远程路径（相对于仓库根的路径，如 "src/index.ts"）
 * @param basePath 仓库根的远程路径（如 "/home/user/project"），用于拼接完整路径
 */
export function buildSshUri(connectionId: string, remotePath: string, basePath?: string): string {
  let fullPath: string;
  if (basePath) {
    // 拼接 basePath + remotePath
    const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
    const rel = remotePath.startsWith('/') ? remotePath : '/' + remotePath;
    fullPath = base + rel;
  } else {
    fullPath = remotePath.startsWith('/') ? remotePath : '/' + remotePath;
  }
  return `ssh://${connectionId}${fullPath}`;
}
