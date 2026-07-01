/**
 * §需求："连接到..." Modal —— 当用户点击欢迎页或欢迎页菜单中的"连接到..."按钮时弹出。
 *
 * 功能：
 * 1. 用户输入 SSH 地址（user@host 或 ssh://user@host:port），左侧 input + 按钮
 * 2. 假设本地已经配置好 SSH（~/.ssh/config 或在 SSH 面板已添加），不需要再输入密码
 * 3. 点击"连接"按钮：调用 IDEACODE SSH 扩展的 listConnections 列出已配置连接，
 *    按 user@host 匹配，匹配成功则调用 getRemoteFileTree 拉取目录树
 * 4. 右侧显示目录树（复用 FileTreeNode 结构），点击文件夹更新顶部 breadcrumb
 * 5. 点击"确定"：把当前选中的目录 dispatch(loadDirectory({ source: 'ssh://...' }))，
 *    加载到主资源管理器，并自动关闭 Modal
 *
 * 复用原则（用户要求"动用目前已经部分实现的SDK API 功能，不用重复的实现"）：
 * - 列表：bridge.invokeExtension('ideacode-ssh', 'listConnections', [])
 * - 树：bridge.invokeExtension('ideacode-ssh', 'getRemoteFileTree', [connId, path])
 * - 路径加载：dispatch(loadDirectory({ source: 'ssh://<connId>/<path>' }))
 *   与 SshFileTreePanel.handleAddToExplorer 完全一致
 */
import { useEffect, useMemo, useState } from 'react';
import { useAppDispatch } from '../../store/hooks';
import { loadDirectory, clearWorkspaceFolders, setSshConnection } from '../../store/slices/workspaceSlice';
import { getExtensionBridge } from '../../plugin/extensionBridge';
import { FolderClosed, FolderOpen, Loader2, AlertCircle, ChevronRight, X, Key, Lock } from 'lucide-react';
import './ConnectToModal.css';

// §复用 SshFileTreePanel 的 FileTreeNode 结构（节点数据结构与 SshFileTreePanel 保持一致）
interface FileTreeNode {
  name: string;
  path: string;
  type: 'directory' | 'file';
  children?: FileTreeNode[];
}

interface ConnectionInfo {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: 'password' | 'key';
}

interface ConnectToModalProps {
  onClose: () => void;
}

export default function ConnectToModal({ onClose }: ConnectToModalProps) {
  const dispatch = useAppDispatch();
  // §可能为 null（极小概率，比如 webview 启动早期或卸载时）。
  // 在所有调用点都做了空值守卫（bridge?.invokeExtension / bridge && ...）
  const bridge = useMemo(() => getExtensionBridge(), []);

  // 没有 bridge 时的统一错误（极少数情况：扩展桥未挂载）
  const requireBridge = (): NonNullable<typeof bridge> => {
    if (!bridge) {
      throw new Error('ExtensionBridge 未挂载，无法连接 SSH');
    }
    return bridge;
  };

  // §本地状态 —— 完全在组件内自管理，不污染 Redux
  const [inputValue, setInputValue] = useState(''); // 用户输入的 user@host
  const [connections, setConnections] = useState<ConnectionInfo[] | null>(null); // 拉取的连接列表
  const [match, setMatch] = useState<ConnectionInfo | null>(null); // 输入匹配到的连接
  const [tree, setTree] = useState<FileTreeNode | null>(null); // getRemoteFileTree 结果
  const [error, setError] = useState<string | null>(null); // 连接/获取树错误
  const [loading, setLoading] = useState(false); // 连接中
  const [navigating, setNavigating] = useState(false); // 子目录导航中（不触发连接状态变化，避免闪动）
  // 当前选中的目录路径（默认根），显示在 header breadcrumb
  const [currentPath, setCurrentPath] = useState<string>('/');

  // ESC 关闭
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // 进入时立即拉取连接列表（用户在 SSH 面板已添加的）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!bridge) {
        setError('ExtensionBridge 未挂载，无法加载 SSH 连接');
        setConnections([]);
        return;
      }
      try {
        const list = await bridge.invokeExtension('ideacode-ssh', 'listConnections', []) as ConnectionInfo[];
        if (cancelled) return;
        setConnections(Array.isArray(list) ? list : []);
      } catch (err) {
        if (cancelled) return;
        setError('无法加载已配置 SSH 连接: ' + (err instanceof Error ? err.message : String(err)));
        setConnections([]);
      }
    })();
    return () => { cancelled = true; };
  }, [bridge]);

  // 把输入解析为 { username, host, port? }
  // 支持：user@host、user@host:port、ssh://user@host:port、ssh user@host、ssh user@host -p 2222
  const parseSshTarget = (raw: string): { username: string; host: string; port?: number } | null => {
    let trimmed = raw.trim();
    if (!trimmed) return null;

    // 去掉常见的命令行前缀 "ssh "（不区分大小写，支持多空格）
    trimmed = trimmed.replace(/^ssh\s+/i, '');

    // 支持 ssh://user@host:port/
    const m1 = trimmed.match(/^ssh:\/\/([^@]+)@([^:/]+)(?::(\d+))?\/?/i);
    if (m1) return { username: m1[1], host: m1[2], port: m1[3] ? Number(m1[3]) : undefined };

    // 支持 user@host:port（或 user@host）
    const m2 = trimmed.match(/^([^@]+)@([^:\s]+)(?::(\d+))?$/);
    if (m2) return { username: m2[1], host: m2[2], port: m2[3] ? Number(m2[3]) : undefined };

    // 支持 user@host -p port 命令行风格
    const m3 = trimmed.match(/^([^@]+)@([^:\s]+)\s+-p\s+(\d+)$/i);
    if (m3) return { username: m3[1], host: m3[2], port: Number(m3[3]) };

    return null;
  };

  // 在已配置连接里按 username+host(+port) 匹配
  const matchConnection = (target: { username: string; host: string; port?: number }): ConnectionInfo | null => {
    if (!connections) return null;
    return connections.find((c) => {
      if (c.username !== target.username) return false;
      if (c.host !== target.host) return false;
      if (target.port && c.port !== target.port) return false;
      return true;
    }) || null;
  };

  // 真正发起连接：复用于手动输入和点击列表项
  const doConnect = async (conn: ConnectionInfo) => {
    setMatch(conn);
    setError(null);
    setLoading(true);
    try {
      const b = requireBridge();
      // 1) 先建立 SSH 会话（幂等：若已连接则直接返回）
      const openResult = await b.invokeExtension(
        'ideacode-ssh', 'openConnection', [conn.id]
      ) as { sessionId: string; status: string; error?: string } | undefined;
      if (!openResult || openResult.status !== 'connected') {
        // §真正的连接失败：清空所有状态，提示用户
        throw new Error(openResult?.error || 'SSH 连接失败');
      }
      // §此时连接已成功，setMatch 已让用户能看到卡片为"已连接"
      // 即便后面拉目录树失败，也【不要】抹掉"已连接"状态，也不要回滚
      // ——用户可以重试或手动浏览。
    } catch (err) {
      setError('连接失败: ' + (err instanceof Error ? err.message : String(err)));
      setTree(null);
      setMatch(null);
      setLoading(false);
      return;
    }
    // 2) 连接已就绪，再拉取目录树。失败不抹掉 match，单独提示树加载失败
    try {
      const b2 = requireBridge();
      // §getRemoteFileTree 返回 { rootPath, tree }，需解包 .tree（与 SshFileTreePanel 一致）
      const remoteTree = await b2.invokeExtension(
        'ideacode-ssh', 'getRemoteFileTree', [conn.id]
      ) as { rootPath?: string; tree?: FileTreeNode } | undefined;
      setTree(remoteTree?.tree ?? null);
      setCurrentPath('/');
    } catch (err) {
      setError('加载目录结构失败: ' + (err instanceof Error ? err.message : String(err))
        + '（SSH 连接已建立，可重试或手动选择目录）');
      setTree(null);
    } finally {
      setLoading(false);
    }
  };

  const handleConnect = async () => {
    setError(null);
    const target = parseSshTarget(inputValue);
    if (!target) {
      setError('请输入合法的 SSH 地址，格式：user@host、user@host:port 或 ssh user@host');
      return;
    }
    if (connections === null) {
      setError('正在加载已配置 SSH 连接，请稍候');
      return;
    }
    const conn = matchConnection(target);
    if (!conn) {
      setError(
        `未找到匹配的 SSH 连接："${inputValue}"。\n` +
        '请先在 SSH 远程面板中添加此连接（或确认 ~/.ssh/config 已配置同名 Host）。'
      );
      return;
    }
    await doConnect(conn);
  };

  // 点击左侧已配置连接列表中的某一项：自动填充并连接
  const handleSelectConnection = (conn: ConnectionInfo) => {
    setInputValue(`${conn.username}@${conn.host}:${conn.port}`);
    doConnect(conn);
  };

  // §在树中点击文件夹：切换 currentPath 并重新拉取该子目录的树
  const handleSelectDir = async (dirNode: FileTreeNode) => {
    if (!match || navigating) return;
    setError(null);
    setNavigating(true);
    try {
      const b = requireBridge();
      const sub = await b.invokeExtension(
        'ideacode-ssh', 'getRemoteFileTree', [match.id, dirNode.path]
      ) as { rootPath?: string; tree?: FileTreeNode } | undefined;
      setTree(sub?.tree ?? null);
      setCurrentPath(dirNode.path);
    } catch (err) {
      setError('加载目录失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setNavigating(false);
    }
  };

  // 顶部 breadcrumb：把 currentPath 切成可点击段
  const breadcrumb = useMemo(() => {
    if (!currentPath || currentPath === '/') {
      return [{ path: '/', label: '~' }];
    }
    const parts = currentPath.split('/').filter(Boolean);
    const acc: Array<{ path: string; label: string }> = [{ path: '/', label: '~' }];
    let p = '';
    for (const part of parts) {
      p += '/' + part;
      acc.push({ path: p, label: part });
    }
    return acc;
  }, [currentPath]);

  // 跳到 breadcrumb 某段（重新拉取该子目录的树）
  const handleBreadcrumbJump = async (path: string) => {
    if (!match || path === currentPath || navigating) return;
    setError(null);
    setNavigating(true);
    try {
      const b = requireBridge();
      const sub = await b.invokeExtension(
        'ideacode-ssh', 'getRemoteFileTree', [match.id, path]
      ) as { rootPath?: string; tree?: FileTreeNode } | undefined;
      setTree(sub?.tree ?? null);
      setCurrentPath(path);
    } catch (err) {
      setError('加载目录失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setNavigating(false);
    }
  };

  // §点击"确定"——把当前选中目录加载到资源管理器
  // 完全复用 SshFileTreePanel.handleAddToExplorer 的方式：
  //   1. setSshConnection 写入 Redux（让"在终端中打开"等右键菜单能拿到 conn 信息）
  //   2. clearWorkspaceFolders 清空旧远程根
  //   3. loadDirectory 加载 ssh://<connId><path> 作为主工作区
  //   4. 关闭 Modal
  const handleConfirm = () => {
    if (!match) return;
    dispatch(clearWorkspaceFolders());
    dispatch(setSshConnection({
      id: match.id,
      name: match.name,
      host: match.host,
      port: match.port,
      username: match.username,
      authType: match.authType,
    }));
    const uri = `ssh://${match.id}${currentPath}`;
    dispatch(loadDirectory({
      source: uri,
      name: `${match.name} · ${currentPath === '/' ? '~' : currentPath.split('/').pop() || '~'}`,
    }));
    onClose();
  };

  const hasTree = !!match && !!tree;

  return (
    <div className="connect-to-modal__overlay" onClick={onClose}>
      <div className={`connect-to-modal ${hasTree ? 'has-tree' : ''}`} onClick={(e) => e.stopPropagation()}>
        {/* 标题栏 */}
        <div className="connect-to-modal__header">
          <span className="connect-to-modal__title">连接到 SSH</span>
          <button className="connect-to-modal__close" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>

        {/* 初始状态只有左侧面板；连接成功后展开右侧目录树 */}
        <div className={`connect-to-modal__body ${hasTree ? 'has-tree' : ''}`}>
          <div className="connect-to-modal__left">
            <div className="connect-to-modal__form">
              <label className="connect-to-modal__label">SSH 地址</label>
              <div className="connect-to-modal__input-row">
                <input
                  className="connect-to-modal__input"
                  type="text"
                  placeholder="user@host、ssh://user@host:22 或 ssh user@host"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !loading) handleConnect();
                  }}
                  disabled={loading}
                  autoFocus
                />
              </div>
              <p className="connect-to-modal__hint">
                已通过 SSH 远程面板配置好的连接会自动匹配；本地 <code>~/.ssh/config</code> 也可直接复用。
              </p>

              {/* 已配置连接列表：默认显示在左侧，点击直接连接 */}
              <div className="connect-to-modal__connections">
                {connections === null ? (
                  <div className="connect-to-modal__connections-state">
                    <Loader2 size={14} className="connect-to-modal__spin" />
                    正在加载已配置的 SSH 连接…
                  </div>
                ) : connections.length === 0 ? (
                  <div className="connect-to-modal__connections-state">
                    尚未配置任何 SSH 连接。<br />
                    请先在"SSH 远程"面板中添加一个连接。
                  </div>
                ) : (
                  <>
                    <div className="connect-to-modal__connections-title">
                      已配置 {connections.length} 个连接，点击即可连接
                    </div>
                    {connections.map((conn) => {
                      const isKey = conn.authType === 'key';
                      // §连接状态：match 命中且 loading=连接中；match 命中且非 loading=已连接；
                      // 连接失败时 match 会被重置为 null，故自动回退为"未连接"
                      const isActive = match?.id === conn.id;
                      const statusText = isActive ? (loading ? '连接中…' : '已连接') : '未连接';
                      const statusCls = isActive ? (loading ? 'is-connecting' : 'is-connected') : '';
                      return (
                        <button
                          key={conn.id}
                          className="connect-to-modal__connection"
                          onClick={() => handleSelectConnection(conn)}
                          disabled={loading}
                          title={`${conn.username}@${conn.host}:${conn.port}`}
                        >
                          <div className="connect-to-modal__connection-main">
                            <div className={`connect-to-modal__connection-icon ${isKey ? 'is-key' : 'is-password'}`}>
                              {isKey ? <Key size={16} /> : <Lock size={16} />}
                            </div>
                            <div className="connect-to-modal__connection-info">
                              <div className="connect-to-modal__connection-name-row">
                                <span className="connect-to-modal__connection-name">{conn.name}</span>
                                <span className={`connect-to-modal__connection-status ${statusCls}`}>{statusText}</span>
                              </div>
                              <div className="connect-to-modal__connection-addr">
                                {conn.username}@{conn.host}:{conn.port}
                              </div>
                            </div>
                          </div>
                          <div className="connect-to-modal__connection-auth">
                            认证：{isKey ? '密钥' : conn.authType === 'password' ? '密码' : conn.authType || '未知'}
                          </div>
                        </button>
                      );
                    })}
                  </>
                )}
              </div>

              {error && (
                <div className="connect-to-modal__error">
                  <AlertCircle size={14} />
                  <span style={{ whiteSpace: 'pre-line' }}>{error}</span>
                </div>
              )}
              <div className="connect-to-modal__actions">
                <button
                  className="connect-to-modal__btn connect-to-modal__btn--primary"
                  onClick={handleConnect}
                  disabled={loading || !inputValue.trim()}
                >
                  {loading ? <Loader2 size={14} className="connect-to-modal__spin" /> : null}
                  <span>{loading ? '连接中…' : '连接'}</span>
                </button>
                <button
                  className="connect-to-modal__btn"
                  onClick={onClose}
                  disabled={loading}
                >
                  取消
                </button>
              </div>
            </div>
          </div>

          {hasTree && (
            <div className="connect-to-modal__right">
              {/* 顶部 breadcrumb：显示当前所在目录路径，点击跳到对应层 */}
              <div className="connect-to-modal__breadcrumb">
                {breadcrumb.map((seg, idx) => (
                  <span key={seg.path} className="connect-to-modal__breadcrumb-item">
                    <button
                      className="connect-to-modal__breadcrumb-link"
                      onClick={() => handleBreadcrumbJump(seg.path)}
                      disabled={loading || navigating || seg.path === currentPath}
                    >
                      {seg.label}
                    </button>
                    {idx < breadcrumb.length - 1 && (
                      <ChevronRight size={12} className="connect-to-modal__breadcrumb-sep" />
                    )}
                  </span>
                ))}
              </div>
              {/* 目录树：仅目录可点击，文件只展示 */}
              <div className={`connect-to-modal__tree ${navigating ? 'is-navigating' : ''}`}>
                {loading && !tree && (
                  <div className="connect-to-modal__tree-loading">
                    <Loader2 size={16} className="connect-to-modal__spin" /> 加载中…
                  </div>
                )}
                {!loading && !navigating && tree.children?.length === 0 && (
                  <div className="connect-to-modal__tree-empty">空目录</div>
                )}
                {tree?.children?.map((child) => (
                  <button
                    key={child.path}
                    className={`connect-to-modal__tree-item ${child.type === 'directory' ? 'is-dir' : 'is-file'}`}
                    onClick={() => child.type === 'directory' && handleSelectDir(child)}
                    disabled={child.type === 'file' || navigating}
                    title={child.path}
                  >
                    {child.type === 'directory'
                      ? <FolderOpen size={14} />
                      : <FolderClosed size={14} />}
                    <span className="connect-to-modal__tree-item-name">{child.name}</span>
                  </button>
                ))}
              </div>
              <div className="connect-to-modal__footer">
                <span className="connect-to-modal__selected">
                  当前选择：<code>{currentPath}</code>
                </span>
                <button
                  className="connect-to-modal__btn connect-to-modal__btn--primary"
                  onClick={handleConfirm}
                  disabled={loading || navigating}
                >
                  确定
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
