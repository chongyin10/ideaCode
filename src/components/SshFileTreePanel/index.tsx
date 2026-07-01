import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search, ChevronsDownUp } from 'lucide-react';
import { useAppDispatch } from '../../store/hooks';
import { setFileContent, openFile, loadDirectory, clearWorkspaceFolders, setSshConnection } from '../../store/slices/workspaceSlice';
import { terminalSDK } from '../../services/terminalSDK';
import { getExtensionBridge } from '../../plugin/extensionBridge';
import ContextMenu, { type MenuItem } from '../ContextMenu';
import type { FileTreeNode } from './types';
import { buildIdfIndex, rankEntries } from './searchRank';
import './SshFileTreePanel.css';

const FolderIcon = ({ expanded }: { expanded: boolean }) => (
  <svg className="ssh-file-tree__icon ssh-file-tree__icon--folder" viewBox="0 0 24 24" fill="currentColor">
    {expanded ? (
      <path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z" />
    ) : (
      <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
    )}
  </svg>
);

const FileIcon = () => (
  <svg className="ssh-file-tree__icon ssh-file-tree__icon--file" viewBox="0 0 24 24" fill="currentColor">
    <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z" />
  </svg>
);

const ChevronIcon = ({ expanded }: { expanded: boolean }) => (
  <svg
    className={`ssh-file-tree__chevron ${expanded ? 'ssh-file-tree__chevron--expanded' : ''}`}
    viewBox="0 0 24 24"
    fill="currentColor"
  >
    <path d="M9.29 6.71c-.39.39-.39 1.02 0 1.41L13.17 12l-3.88 3.88c-.39.39-.39 1.02 0 1.41.39.39 1.02.39 1.41 0l4.59-4.59c.39-.39.39-1.02 0-1.41L10.7 6.71c-.38-.38-1.02-.38-1.41.01z" />
  </svg>
);

export interface SshConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  authType: 'password' | 'key';
}

interface TreeData {
  connectionId: string;
  rootPath: string;
  connection: SshConnection;
  tree: FileTreeNode;
}

interface ClipboardItem {
  operation: 'move' | 'copy';
  path: string;
  name: string;
}

let remoteClipboard: ClipboardItem | null = null;

function parentDir(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx > 0 ? p.slice(0, idx) : p;
}

function relativePath(root: string, p: string): string {
  if (p === root) return '~';
  if (p.startsWith(root + '/')) return '~/' + p.slice(root.length + 1);
  return p;
}

interface SshFileTreePanelProps {
  content: string;
  fileId: string;
}

interface TreeNodeItemProps {
  node: FileTreeNode;
  depth?: number;
  expandedPaths: Set<string>;
  highlightedPath: string | null;
  onToggleExpanded: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, node: FileTreeNode) => void;
  registerRowRef: (path: string, el: HTMLDivElement | null) => void;
}

function TreeNodeItem({
  node,
  depth = 0,
  expandedPaths,
  highlightedPath,
  onToggleExpanded,
  onContextMenu,
  registerRowRef,
}: TreeNodeItemProps) {
  const isDir = node.type === 'directory';
  const hasChildren = isDir && (node.children?.length ?? 0) > 0;
  const expanded = expandedPaths.has(node.path);
  const isHighlighted = highlightedPath === node.path;

  return (
    <div className="ssh-file-tree__node">
      <div
        ref={(el) => registerRowRef(node.path, el)}
        className={`ssh-file-tree__row ${isHighlighted ? 'ssh-file-tree__row--highlight' : ''}`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => hasChildren && onToggleExpanded(node.path)}
        onContextMenu={(e) => onContextMenu(e, node)}
        title={node.path}
        data-path={node.path}
      >
        {hasChildren && <ChevronIcon expanded={expanded} />}
        {!hasChildren && <span className="ssh-file-tree__chevron-placeholder" />}
        {isDir ? <FolderIcon expanded={expanded} /> : <FileIcon />}
        <span className="ssh-file-tree__label">{node.name}</span>
      </div>
      {isDir && expanded && node.children && (
        <div className="ssh-file-tree__children">
          {node.children.map((child) => (
            <TreeNodeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              expandedPaths={expandedPaths}
              highlightedPath={highlightedPath}
              onToggleExpanded={onToggleExpanded}
              onContextMenu={onContextMenu}
              registerRowRef={registerRowRef}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// 收集树中所有节点（目录 + 文件，用于搜索下拉）
function collectAllEntries(node: FileTreeNode): FileTreeNode[] {
  const result: FileTreeNode[] = [node];
  node.children?.forEach((child) => {
    result.push(...collectAllEntries(child));
  });
  return result;
}

function findNode(root: FileTreeNode, path: string): FileTreeNode | undefined {
  if (root.path === path) return root;
  if (!root.children) return undefined;
  for (const child of root.children) {
    const found = findNode(child, path);
    if (found) return found;
  }
  return undefined;
}

function getUniqueName(parent: FileTreeNode, name: string): string {
  if (!parent.children || parent.children.length === 0) return name;
  const names = new Set(parent.children.map((c) => c.name));
  if (!names.has(name)) return name;
  const dotIndex = name.lastIndexOf('.');
  const hasExtension = dotIndex > 0;
  const base = hasExtension ? name.slice(0, dotIndex) : name;
  const ext = hasExtension ? name.slice(dotIndex) : '';
  let i = 1;
  while (names.has(`${base} (${i})${ext}`)) i++;
  return `${base} (${i})${ext}`;
}

export default function SshFileTreePanel({ content, fileId }: SshFileTreePanelProps) {
  const dispatch = useAppDispatch();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: FileTreeNode } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [inputDialog, setInputDialog] = useState<{
    type: 'rename' | 'newFile' | 'newFolder';
    node: FileTreeNode;
    value: string;
  } | null>(null);
  // 已展开目录路径集合（受控树）
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  // 目录搜索
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [highlightedPath, setHighlightedPath] = useState<string | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const data = useMemo<TreeData | null>(() => {
    try {
      const parsed = JSON.parse(content);
      const emptyConnection: SshConnection = {
        id: '',
        name: '',
        host: '',
        port: 22,
        username: '',
        authType: 'password',
      };
      if (parsed && parsed.tree) {
        return {
          connectionId: parsed.connectionId || '',
          rootPath: parsed.rootPath || parsed.tree.path || '~',
          connection: parsed.connection || emptyConnection,
          tree: parsed.tree as FileTreeNode,
        };
      }
      // 兼容旧格式：直接是树对象
      if (parsed && parsed.type) {
        return {
          connectionId: '',
          rootPath: parsed.path || '~',
          connection: emptyConnection,
          tree: parsed as FileTreeNode,
        };
      }
      return null;
    } catch {
      return null;
    }
  }, [content]);

  // 当树数据变化时，默认展开一级目录，并保留已有的展开状态
  useEffect(() => {
    if (!data?.tree) return;
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      const expandRootLevel = (node: FileTreeNode) => {
        node.children?.forEach((child) => {
          if (child.type === 'directory') next.add(child.path);
        });
      };
      expandRootLevel(data.tree);
      return next;
    });
  }, [data?.tree?.path]);

  const showNotice = (text: string) => {
    setNotice(text);
    setTimeout(() => setNotice(null), 2500);
  };

  const registerRowRef = (path: string, el: HTMLDivElement | null) => {
    if (el) rowRefs.current.set(path, el);
    else rowRefs.current.delete(path);
  };

  const toggleExpanded = (path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const collapseAll = () => {
    setExpandedPaths(new Set());
  };

  const expandToPath = (targetPath: string) => {
    if (!data) return;
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      let p = targetPath;
      while (p && p !== data.rootPath && p !== '/') {
        const node = findNode(data.tree, p);
        if (node && node.type === 'directory') next.add(p);
        p = parentDir(p);
      }
      return next;
    });
  };

  const handleSearchSelect = (path: string) => {
    expandToPath(path);
    setHighlightedPath(path);
    setSearchQuery('');
    setSearchOpen(false);
    setTimeout(() => {
      rowRefs.current.get(path)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 50);
  };

  // 搜索高亮后，点击任意位置取消高亮
  useEffect(() => {
    if (!highlightedPath) return;
    const clear = () => setHighlightedPath(null);
    document.addEventListener('mousedown', clear);
    return () => document.removeEventListener('mousedown', clear);
  }, [highlightedPath]);

  const handleContextMenu = (e: React.MouseEvent, node: FileTreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  };

  const closeContextMenu = () => setContextMenu(null);

  const refreshTree = async () => {
    if (!data?.connectionId) return;
    const bridge = getExtensionBridge();
    if (!bridge) return;
    try {
      const result = (await bridge.invokeExtension('ideacode-ssh', 'getRemoteFileTree', [
        data.connectionId,
      ])) as { rootPath?: string; tree?: FileTreeNode } | undefined;
      console.log('[SshFileTreePanel] 刷新结果:', result);
      if (!result?.tree) {
        showNotice('刷新失败：未获取到目录数据');
        return;
      }
      dispatch(
        setFileContent({
          id: fileId,
          content: JSON.stringify({
            connectionId: data.connectionId,
            rootPath: result.rootPath || data.rootPath,
            connection: data.connection,
            tree: result.tree,
          }),
        })
      );
    } catch (err) {
      console.error('[SshFileTreePanel] 刷新失败:', err);
      showNotice('刷新失败');
    }
  };

  const invokeOperation = async (operation: string, params: Record<string, unknown>) => {
    if (!data?.connectionId) return;
    const bridge = getExtensionBridge();
    if (!bridge) {
      showNotice('扩展桥接未就绪');
      return;
    }
    try {
      const opResult = await bridge.invokeExtension('ideacode-ssh', 'handleFileOperation', [
        { operation, connectionId: data.connectionId, ...params },
      ]);
      console.log('[SshFileTreePanel] 操作结果:', opResult);
      // 留一点时间让远程文件系统落盘
      await new Promise((resolve) => setTimeout(resolve, 500));
      await refreshTree();
    } catch (err) {
      console.error('[SshFileTreePanel] 操作失败:', err);
      showNotice(`操作失败: ${(err as Error).message}`);
    }
  };

  const handleCut = (node: FileTreeNode) => {
    remoteClipboard = { operation: 'move', path: node.path, name: node.name };
    showNotice('已剪切');
  };

  const handleCopy = (node: FileTreeNode) => {
    remoteClipboard = { operation: 'copy', path: node.path, name: node.name };
    showNotice('已复制');
  };

  const handlePaste = async (node: FileTreeNode) => {
    if (!remoteClipboard || !data?.tree) return;
    const destDir = node.type === 'directory' ? node.path : parentDir(node.path);
    const parentNode = findNode(data.tree, destDir) || node;
    const uniqueName = getUniqueName(parentNode, remoteClipboard.name);
    const target = `${destDir}/${uniqueName}`;
    if (target === remoteClipboard.path) {
      showNotice('源路径和目标路径相同');
      return;
    }
    await invokeOperation(remoteClipboard.operation, { path: remoteClipboard.path, target });
    if (remoteClipboard.operation === 'move') {
      remoteClipboard = null;
    }
  };

  const handleDelete = async (node: FileTreeNode) => {
    if (!window.confirm(`确定要删除 ${node.name} 吗？`)) return;
    await invokeOperation('delete', { path: node.path });
  };

  const handleRename = (node: FileTreeNode) => {
    setInputDialog({ type: 'rename', node, value: node.name });
  };

  const handleNewFile = (node: FileTreeNode) => {
    setInputDialog({ type: 'newFile', node, value: '' });
  };

  const handleNewFolder = (node: FileTreeNode) => {
    setInputDialog({ type: 'newFolder', node, value: '' });
  };

  const handleRefresh = () => {
    refreshTree();
  };

  const confirmInputDialog = async () => {
    if (!inputDialog || !data?.tree) return;
    const { type, node, value } = inputDialog;
    const name = value.trim();
    setInputDialog(null);
    if (!name) return;

    if (type === 'rename') {
      if (name === node.name) return;
      await invokeOperation('rename', { path: node.path, newName: name });
      return;
    }

    const dirPath = node.type === 'directory' ? node.path : parentDir(node.path);
    const parentNode = findNode(data.tree, dirPath) || node;
    const uniqueName = getUniqueName(parentNode, name);
    const targetPath = `${dirPath}/${uniqueName}`;

    if (type === 'newFile') {
      await invokeOperation('createFile', { path: targetPath });
    } else if (type === 'newFolder') {
      await invokeOperation('createFolder', { path: targetPath });
    }
  };

  const handleCopyPath = (node: FileTreeNode) => {
    navigator.clipboard.writeText(node.path).then(() => showNotice('路径已复制'));
  };

  const handleCopyRelativePath = (node: FileTreeNode) => {
    const text = relativePath(data?.rootPath || node.path, node.path);
    navigator.clipboard.writeText(text).then(() => showNotice('相对路径已复制'));
  };

  const handleOpenInTerminal = (node: FileTreeNode) => {
    if (!data?.connection?.host) return;
    const conn = data.connection;
    const dirPath = node.type === 'directory' ? node.path : parentDir(node.path);
    const escaped = `'${dirPath.replace(/'/g, "'\"'\"'")}'`;
    const options: Record<string, unknown> = {
      name: `${conn.name} ${conn.host}`,
      executable: 'ssh',
      args: [
        '-p',
        String(conn.port || 22),
        '-t',
        `${conn.username}@${conn.host}`,
        `cd ${escaped} && exec $SHELL -l`,
      ],
      // §需求：标识为 SSH 远程终端——不进 BottomPanel tab 列表，modal 关闭时
      //   也不创建底部 tab / editor tab。SSH 终端的归宿只在 SSH 面板。
      isSSH: true,
    };
    if (conn.authType === 'password' && conn.password) {
      options.input = conn.password;
      options.outputFilter = '[^\\r\\n]*password:\\s*\\r?\\n?';
    }
    terminalSDK
      .createTab(options)
      .catch((err) => {
        console.error('[SshFileTreePanel] 打开终端失败:', err);
        showNotice('打开终端失败');
      });
  };

  const handleAddToExplorer = (node: FileTreeNode) => {
    if (!data || node.type !== 'directory') return;
    const uri = `ssh://${data.connectionId}${node.path}`;
    // 重新初始化目录结构：清空现有远程根目录与 Git 状态，并将选中目录加载为主工作区
    dispatch(clearWorkspaceFolders());
    // §需求：把 SSH 连接信息写入 Redux，让后续"在终端中打开"右键菜单能取出
    //  连接信息构造 ssh 命令（authority 是 connectionId，从 connection 还原 host/user）。
    dispatch(setSshConnection({
      id: data.connectionId,
      name: data.connection.name,
      host: data.connection.host,
      port: data.connection.port,
      username: data.connection.username,
      authType: data.connection.authType,
    }));
    dispatch(
      loadDirectory({
        source: uri,
        name: `${data.connection.name} · ${node.name}`,
      })
    );
    // §之前这里会主动向 Git WebView 推送 isRepo: false（用来"清空旧仓库"），
    // 但这会覆盖 git 扩展对自己检测结果的推送——即使 git 扩展通过 SSH 在远程
    // 检测出是仓库并 pushState(isRepo: true)，我们的强制 false 也会随后把它
    // 覆盖回 false，导致用户看到"当前文件夹不是 Git 仓库"。
    // 修复：完全去掉这里的强制推送。git 扩展的 _subscribeWorkspaceRoot 在 rootSource
    // 变化时已经自动调用 ext.invoke('ideacode-git', 'openWorkspace', ...)，由 git
    // 扩展自己负责推送正确的 isRepo 状态（SSH 路径走 findRemoteRepoRoot 真正
    // 远程检测 git rev-parse --show-toplevel，命中后 isRepo=true）。
    showNotice('已重新加载目录结构');
  };

  const handleViewFileContent = (node: FileTreeNode) => {
    if (!data) return;
    if (node.type !== 'file') {
      showNotice('只有文件可以查看内容');
      return;
    }
    const uri = `ssh://${data.connectionId}${node.path}`;
    dispatch(
      openFile({
        name: node.name,
        kind: 'file',
        source: uri,
        readOnly: true,
      })
    );
  };

  const menuItems: MenuItem[] = useMemo(() => {
    if (!contextMenu) return [];
    const node = contextMenu.node;
    const canOperate = !!data?.connectionId && !!data?.connection?.host;
    return [
      {
        id: 'newFile',
        label: '新建文件',
        group: 'new',
        disabled: !canOperate,
        onClick: () => handleNewFile(node),
      },
      {
        id: 'newFolder',
        label: '新建文件夹',
        group: 'new',
        disabled: !canOperate,
        onClick: () => handleNewFolder(node),
      },
      { id: 'refresh', label: '刷新', group: 'new', onClick: () => handleRefresh() },
      { id: 'cut', label: '剪切', group: 'op', disabled: !canOperate, onClick: () => handleCut(node) },
      { id: 'copy', label: '复制', group: 'op', disabled: !canOperate, onClick: () => handleCopy(node) },
      {
        id: 'paste',
        label: '粘贴',
        group: 'op',
        disabled: !canOperate || !remoteClipboard,
        onClick: () => handlePaste(node),
      },
      { id: 'delete', label: '删除', group: 'op', disabled: !canOperate, onClick: () => handleDelete(node) },
      { id: 'rename', label: '重命名', group: 'op', disabled: !canOperate, onClick: () => handleRename(node) },
      { id: 'copyPath', label: '复制路径', group: 'path', onClick: () => handleCopyPath(node) },
      {
        id: 'copyRelativePath',
        label: '复制相对路径',
        group: 'path',
        onClick: () => handleCopyRelativePath(node),
      },
      {
        id: 'openInTerminal',
        label: '在终端中打开',
        group: 'term',
        disabled: !canOperate,
        onClick: () => handleOpenInTerminal(node),
      },
      {
        id: 'viewFileContent',
        label: '查看文件内容',
        group: 'view',
        disabled: !canOperate,
        onClick: () => handleViewFileContent(node),
      },
      {
        id: 'addToExplorer',
        label: '添加到资源管理器',
        group: 'explorer',
        disabled: !canOperate || node.type !== 'directory',
        onClick: () => handleAddToExplorer(node),
      },
    ];
  }, [contextMenu, data?.connectionId, data?.connection?.host, data?.rootPath]);

  const allEntries = useMemo(() => (data?.tree ? collectAllEntries(data.tree) : []), [data?.tree]);
  const idfIndex = useMemo(() => buildIdfIndex(allEntries), [allEntries]);
  const filteredEntries = useMemo(
    () => rankEntries(allEntries, searchQuery, idfIndex),
    [allEntries, searchQuery, idfIndex]
  );

  if (!data) {
    return (
      <div className="ssh-file-tree ssh-file-tree--empty">
        <p>无法解析远程目录结构</p>
      </div>
    );
  }

  const { tree, rootPath, connection } = data;

  const renderHighlightedPath = (path: string, ranges: [number, number][]) => {
    if (ranges.length === 0) return path;
    const nodes: ReactNode[] = [];
    let last = 0;
    ranges.forEach(([start, end], idx) => {
      if (start > last) {
        nodes.push(<span key={`${last}-${idx}-pre`}>{path.slice(last, start)}</span>);
      }
      nodes.push(
        <span key={`${start}-${idx}`} className="ssh-file-tree__search-match">
          {path.slice(start, end)}
        </span>
      );
      last = end;
    });
    if (last < path.length) {
      nodes.push(<span key="tail">{path.slice(last)}</span>);
    }
    return nodes;
  };

  return (
    <div className="ssh-file-tree">
      <div className="ssh-file-tree__header">
        <div className="ssh-file-tree__header-left">
          {/* 全部折叠 */}
          <button
            className="ssh-file-tree__action-btn"
            title="全部折叠"
            onClick={collapseAll}
          >
            <ChevronsDownUp size={14} />
          </button>
          <FolderIcon expanded />
          <div className="ssh-file-tree__heading">
            <span className="ssh-file-tree__title" title={tree.name}>{tree.name}</span>
            <span className="ssh-file-tree__path" title={rootPath}>
              {connection?.host ? `${connection.username}@${connection.host}:${connection.port}` : rootPath}
            </span>
          </div>
        </div>
        <div className="ssh-file-tree__header-actions">
          {/* 目录搜索 */}
          <div className="ssh-file-tree__search-wrap">
            <Search size={14} className="ssh-file-tree__search-icon" />
            <input
              className="ssh-file-tree__search-input"
              type="text"
              placeholder="搜索目录..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setSearchOpen(true);
              }}
              onFocus={() => setSearchOpen(true)}
              onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setSearchQuery('');
                  setSearchOpen(false);
                }
              }}
            />
            {searchOpen && filteredEntries.length > 0 && (
              <div className="ssh-file-tree__search-dropdown">
                {filteredEntries.map(({ node, ranges }) => (
                  <button
                    key={node.path}
                    className="ssh-file-tree__search-item"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => handleSearchSelect(node.path)}
                    title={node.path}
                  >
                    <span className={`ssh-file-tree__search-type ${node.type === 'directory' ? 'ssh-file-tree__search-type--dir' : ''}`}>
                      {node.type === 'directory' ? '📁' : '📄'}
                    </span>
                    {renderHighlightedPath(node.path, ranges)}
                  </button>
                ))}
              </div>
            )}
            {searchOpen && searchQuery.trim() && filteredEntries.length === 0 && (
              <div className="ssh-file-tree__search-dropdown ssh-file-tree__search-dropdown--empty">
                无匹配结果
              </div>
            )}
          </div>

        </div>
      </div>
      {notice && <div className="ssh-file-tree__notice">{notice}</div>}
      <div className="ssh-file-tree__body" onContextMenu={(e) => handleContextMenu(e, tree)}>
        {tree.children?.map((child) => (
          <TreeNodeItem
            key={child.path}
            node={child}
            depth={0}
            expandedPaths={expandedPaths}
            highlightedPath={highlightedPath}
            onToggleExpanded={toggleExpanded}
            onContextMenu={handleContextMenu}
            registerRowRef={registerRowRef}
          />
        ))}
      </div>
      {contextMenu && (
        <ContextMenu
          items={menuItems}
          x={contextMenu.x}
          y={contextMenu.y}
          visible={!!contextMenu}
          onClose={closeContextMenu}
        />
      )}
      {inputDialog && (
        <div className="ssh-file-tree__modal-overlay" onClick={() => setInputDialog(null)}>
          <div className="ssh-file-tree__modal" onClick={(e) => e.stopPropagation()}>
            <div className="ssh-file-tree__modal-title">
              {inputDialog.type === 'rename' ? '重命名' : inputDialog.type === 'newFile' ? '新建文件' : '新建文件夹'}
            </div>
            <input
              className="ssh-file-tree__modal-input"
              type="text"
              value={inputDialog.value}
              autoFocus
              placeholder={
                inputDialog.type === 'rename'
                  ? '新名称'
                  : inputDialog.type === 'newFile'
                    ? '文件名称'
                    : '文件夹名称'
              }
              onChange={(e) => setInputDialog({ ...inputDialog, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmInputDialog();
                if (e.key === 'Escape') setInputDialog(null);
              }}
            />
            <div className="ssh-file-tree__modal-actions">
              <button className="btn btn-sm" onClick={confirmInputDialog}>确定</button>
              <button className="btn btn-sm btn-secondary" onClick={() => setInputDialog(null)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
