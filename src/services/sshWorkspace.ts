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
import type { SshChannelConfig } from '../types/electron';
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
 * §优先读 Redux 中显式存储的 projectType 字段（loadDirectory 时自动判断写入），
 * 避免每次解析 rootSource URI；projectType 为 null 时 fallback 到 URI 解析。
 */
export function isSshWorkspace(): boolean {
  const { projectType, rootSource } = store.getState().workspace;
  if (projectType) return projectType === 'ssh';
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

/**
 * §从指定 SSH 连接获取完整凭据（含密码/密钥），供 ExplorerContent 等场景使用。
 * 凭据不缓存在 Redux 中，每次实时从 SSH 扩展查询。
 */
export async function getSshCredentials(connectionId: string): Promise<{
  password?: string;
  privateKey?: string;
  passphrase?: string;
}> {
  try {
    const api = window.electronAPI;
    if (!api?.extension?.rpc) return {};
    const res = (await api.extension.rpc('commands.execute', {
      command: 'ssh.getConnection',
      args: [connectionId],
    })) as
      | { success?: boolean; result?: { executed?: boolean; result?: SshConnectionInfo & { password?: string; privateKey?: string; passphrase?: string } } }
      | undefined;

    if (res?.success && res.result?.executed && res.result.result) {
      return {
        password: res.result.result.password,
        privateKey: res.result.result.privateKey,
        passphrase: res.result.result.passphrase,
      };
    }
  } catch (e) {
    console.error('[sshWorkspace] 获取 SSH 凭据失败:', e);
  }
  return {};
}

/**
 * §终端通道解析：统一检测当前工作区环境，返回通道配置。
 *
 * - SSH 远程项目：返回 channel='ssh' + sshConfig（含凭据），主进程自动处理认证
 * - 本地项目：返回 channel='local' + cwd
 *
 * 凭据（密码/密钥）通过 SSH 扩展 RPC 实时获取，不缓存在 Redux 中。
 * 通道配置传递给主进程后，认证自动化在主进程完成，不经过渲染进程。
 */
export async function resolveTerminalChannel(): Promise<{
  channel: 'local' | 'ssh';
  sshConfig?: SshChannelConfig;
  tabName?: string;
  cwd?: string;
}> {
  // §优先读显式存储的 projectType，本地项目快速分流，跳过 SSH 配置检测
  const { projectType, rootSource } = store.getState().workspace;
  if (projectType === 'local') {
    const cwd = typeof rootSource === 'string' ? rootSource : undefined;
    return { channel: 'local', cwd };
  }

  // projectType === 'ssh' 或 null（fallback）：尝试获取 SSH 配置
  const sshConfig = getCurrentSshConfig();

  if (sshConfig) {
    // §异步从 SSH 扩展获取完整凭据（含密码/密钥），不在渲染进程缓存
    let password: string | undefined;
    let privateKey: string | undefined;
    let passphrase: string | undefined;

    try {
      const api = window.electronAPI;
      if (api?.extension?.rpc) {
        const res = (await api.extension.rpc('commands.execute', {
          command: 'ssh.getConnection',
          args: [sshConfig.connectionId],
        })) as
          | { success?: boolean; result?: { executed?: boolean; result?: SshConnectionInfo & { password?: string; privateKey?: string; passphrase?: string } } }
          | undefined;

        if (res?.success && res.result?.executed && res.result.result) {
          password = res.result.result.password;
          privateKey = res.result.result.privateKey;
          passphrase = res.result.result.passphrase;
        }
      }
    } catch (e) {
      console.error('[sshWorkspace] 获取 SSH 凭据失败:', e);
    }

    return {
      channel: 'ssh',
      sshConfig: {
        host: sshConfig.conn.host,
        port: sshConfig.conn.port,
        username: sshConfig.conn.username,
        password,
        privateKey,
        passphrase,
        remotePath: sshConfig.remotePath,
      },
      tabName: `${sshConfig.conn.name} · ${sshConfig.conn.username}@${sshConfig.conn.host}`,
    };
  }

  // §fallback 本地通道：projectType 为 null 且无 SSH 配置时走到这里
  // rootSource 已在函数开头解构，直接复用
  const cwd = typeof rootSource === 'string' ? rootSource : undefined;
  return { channel: 'local', cwd };
}
