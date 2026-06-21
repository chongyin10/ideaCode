import { useState, useEffect, useRef, useMemo } from 'react';
import type { SshConnection, SshSession, WebviewMessage } from './types';

const STORAGE_KEY = 'ideacode_ssh_connections';

function loadConnections(): SshConnection[] {
  const vscode = getVsCodeApi();
  if (vscode) {
    const state = vscode.getState() as { connections?: SshConnection[] } | undefined;
    if (state?.connections) return state.connections;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveConnections(connections: SshConnection[]) {
  const vscode = getVsCodeApi();
  if (vscode) {
    vscode.setState({ connections });
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(connections));
  } catch { /* ignore */ }
}

function getVsCodeApi() {
  if (typeof window !== 'undefined' && window.acquireVsCodeApi) {
    return window.acquireVsCodeApi();
  }
  return null;
}

function generateId() {
  return `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function App() {
  const [connections, setConnections] = useState<SshConnection[]>(loadConnections);
  const [sessions, setSessions] = useState<SshSession[]>([]);
  const [expandedSessions, setExpandedSessions] = useState<Record<string, boolean>>({});
  const [expandedSections, setExpandedSections] = useState({
    connections: true,
    addForm: false,
    sessions: true,
  });
  const [form, setForm] = useState({
    name: '',
    host: '',
    port: '22',
    username: '',
    password: '',
    authType: 'password' as 'password' | 'key',
    privateKey: '',
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const terminalRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const formRef = useRef<HTMLDivElement>(null);
  const hasMountedRef = useRef(false);
  const prevSessionCountRef = useRef(0);

  useEffect(() => {
    saveConnections(connections);
  }, [connections]);

  useEffect(() => {
    for (const session of sessions) {
      const ref = terminalRefs.current[session.id];
      if (ref) ref.scrollTop = ref.scrollHeight;
    }
  }, [sessions]);

  // 初始化/内容变化时自动调整展开状态
  useEffect(() => {
    if (!hasMountedRef.current) {
      // 首次挂载：有内容展开，空则折叠；无连接时默认展开添加表单
      setExpandedSections({
        connections: connections.length > 0,
        addForm: connections.length === 0,
        sessions: sessions.length > 0,
      });
      hasMountedRef.current = true;
      prevSessionCountRef.current = sessions.length;
      return;
    }

    // 活动会话从 0 变成 >0 时自动展开
    if (sessions.length > 0 && prevSessionCountRef.current === 0) {
      setExpandedSections((prev) => ({ ...prev, sessions: true }));
    }
    prevSessionCountRef.current = sessions.length;
  }, [connections.length, sessions.length]);

  // 进入编辑模式时自动展开添加/编辑表单
  useEffect(() => {
    if (editingId) {
      setExpandedSections((prev) => ({ ...prev, addForm: true }));
    }
  }, [editingId]);

  useEffect(() => {
    const vscode = getVsCodeApi();
    if (!vscode) return;

    const handleMessage = (event: MessageEvent) => {
      const message = event.data as WebviewMessage;
      if (message.type === 'connections') {
        setConnections(message.connections as SshConnection[]);
      } else if (message.type === 'sessions') {
        setSessions(message.sessions as SshSession[]);
      } else if (message.type === 'output') {
        const { sessionId, line } = message;
        setSessions((prev) =>
          prev.map((s) =>
            s.id === sessionId ? { ...s, output: [...s.output, line as string] } : s
          )
        );
      }
    };

    window.addEventListener('message', handleMessage);
    vscode.postMessage({ command: 'loadConnections' });
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const toggleSection = (section: keyof typeof expandedSections) => {
    setExpandedSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  const resetForm = () => {
    setForm({ name: '', host: '', port: '22', username: '', password: '', authType: 'password', privateKey: '' });
    setEditingId(null);
  };

  const handleSave = () => {
    if (!form.host.trim() || !form.username.trim()) return;

    const conn: SshConnection = {
      id: editingId || generateId(),
      name: form.name.trim() || `${form.username}@${form.host}`,
      host: form.host.trim(),
      port: parseInt(form.port, 10) || 22,
      username: form.username.trim(),
      password: form.authType === 'password' ? form.password : undefined,
      privateKey: form.authType === 'key' ? form.privateKey : undefined,
      authType: form.authType,
    };

    if (editingId) {
      setConnections((prev) => prev.map((c) => (c.id === editingId ? conn : c)));
    } else {
      setConnections((prev) => [...prev, conn]);
    }

    resetForm();

    const vscode = getVsCodeApi();
    if (vscode) {
      vscode.postMessage({
        command: editingId ? 'updateConnection' : 'addConnection',
        connection: conn,
      });
    }
  };

  const handleDelete = (id: string) => {
    if (!confirm('确定要删除此连接吗？')) return;
    setConnections((prev) => prev.filter((c) => c.id !== id));
    setSessions((prev) => prev.filter((s) => s.connectionId !== id));
    if (editingId === id) resetForm();
    const vscode = getVsCodeApi();
    if (vscode) vscode.postMessage({ command: 'deleteConnection', connectionId: id });
  };

  const handleEdit = (conn: SshConnection) => {
    setForm({
      name: conn.name,
      host: conn.host,
      port: conn.port.toString(),
      username: conn.username,
      password: conn.password || '',
      authType: conn.authType,
      privateKey: conn.privateKey || '',
    });
    setEditingId(conn.id);
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const handleConnect = (conn: SshConnection) => {
    const vscode = getVsCodeApi();
    if (vscode) vscode.postMessage({ command: 'connect', connectionId: conn.id });
  };

  const handleDisconnect = (sessionId: string) => {
    const vscode = getVsCodeApi();
    if (vscode) vscode.postMessage({ command: 'disconnect', sessionId });
  };

  const handleCloseSession = (sessionId: string) => {
    handleDisconnect(sessionId);
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    const vscode = getVsCodeApi();
    if (vscode) vscode.postMessage({ command: 'closeSession', sessionId });
  };

  const handleExecute = (sessionId: string, command: string) => {
    if (!command.trim()) return;
    const vscode = getVsCodeApi();
    if (vscode) vscode.postMessage({ command: 'execute', sessionId, cmd: command.trim() });
  };

  const getConnectionName = (connectionId: string) => {
    return connections.find((c) => c.id === connectionId)?.name || connectionId;
  };

  const connectionSessions = useMemo(() => {
    const map: Record<string, SshSession[]> = {};
    for (const session of sessions) {
      if (!map[session.connectionId]) map[session.connectionId] = [];
      map[session.connectionId].push(session);
    }
    return map;
  }, [sessions]);

  const isConnected = (connectionId: string) =>
    connectionSessions[connectionId]?.some((s) => s.status === 'connected');

  const hasConnecting = (connectionId: string) =>
    connectionSessions[connectionId]?.some((s) => s.status === 'connecting');

  const toggleConnection = (conn: SshConnection) => {
    const activeSessions = connectionSessions[conn.id]?.filter((s) => s.status === 'connected') || [];
    if (activeSessions.length > 0) {
      for (const session of activeSessions) {
        handleDisconnect(session.id);
      }
    } else {
      handleConnect(conn);
    }
  };

  return (
    <div className="ssh-panel">
      <div className="section">
        <div className="section-header section-header--collapsible" onClick={() => toggleSection('connections')}>
          <span className={`section-chevron ${expandedSections.connections ? 'expanded' : ''}`}>▶</span>
          <span>SSH 连接</span>
          <span className="count-badge">{connections.length}</span>
        </div>
        {expandedSections.connections && (
        <div className="connection-grid">
          {connections.length === 0 ? (
            <div className="empty-state">
              <p>暂无 SSH 连接</p>
              <p className="empty-state__hint">在下方表单中添加第一个连接</p>
            </div>
          ) : (
            connections.map((conn) => {
              const connected = isConnected(conn.id);
              const connecting = hasConnecting(conn.id);
              return (
                <div key={conn.id} className={`connection-card ${editingId === conn.id ? 'is-editing' : ''}`}>
                  <div className="connection-card__header">
                    <span className="connection-card__name" title={conn.name}>
                      {conn.name}
                    </span>
                    <span className={`connection-card__status ${connected ? 'connected' : connecting ? 'connecting' : 'disconnected'}`}>
                      {connected ? '已连接' : connecting ? '连接中' : '未连接'}
                    </span>
                  </div>
                  <div className="connection-card__meta" title={`${conn.username}@${conn.host}:${conn.port}`}>
                    {conn.username}@{conn.host}:{conn.port}
                  </div>
                  <div className="connection-card__auth">
                    认证：{conn.authType === 'password' ? '密码' : '私钥'}
                  </div>
                  <div className="connection-card__actions">
                    <button
                      className={`btn btn-sm ${connected ? 'btn-secondary' : ''}`}
                      onClick={() => toggleConnection(conn)}
                      disabled={connecting}
                    >
                      {connected ? '断开' : connecting ? '连接中' : '连接'}
                    </button>
                    <button className="btn btn-sm btn-secondary" onClick={() => handleEdit(conn)}>
                      编辑
                    </button>
                    <button className="btn btn-sm btn-danger" onClick={() => handleDelete(conn.id)}>
                      删除
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
        )}
      </div>

      <div className="section" ref={formRef}>
        <div className="section-header section-header--collapsible" onClick={() => toggleSection('addForm')}>
          <span className={`section-chevron ${expandedSections.addForm ? 'expanded' : ''}`}>▶</span>
          <span>{editingId ? '编辑连接' : '添加连接'}</span>
          {editingId && (
            <button
              className="btn btn-sm btn-link section-header__action"
              onClick={(e) => { e.stopPropagation(); resetForm(); }}
            >
              取消编辑
            </button>
          )}
        </div>
        {expandedSections.addForm && (
        <div className="form">
          <div className="form-row">
            <label>名称</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="例如：生产服务器"
            />
          </div>
          <div className="form-row-half">
            <div className="form-row">
              <label>主机地址 *</label>
              <input
                type="text"
                value={form.host}
                onChange={(e) => setForm({ ...form, host: e.target.value })}
                placeholder="192.168.1.1"
              />
            </div>
            <div className="form-row">
              <label>端口</label>
              <input
                type="number"
                value={form.port}
                onChange={(e) => setForm({ ...form, port: e.target.value })}
                placeholder="22"
              />
            </div>
          </div>
          <div className="form-row">
            <label>用户名 *</label>
            <input
              type="text"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              placeholder="root"
            />
          </div>
          <div className="form-row">
            <label>认证方式</label>
            <div className="radio-group">
              <label className={form.authType === 'password' ? 'active' : ''}>
                <input
                  type="radio"
                  value="password"
                  checked={form.authType === 'password'}
                  onChange={() => setForm({ ...form, authType: 'password' })}
                />
                密码
              </label>
              <label className={form.authType === 'key' ? 'active' : ''}>
                <input
                  type="radio"
                  value="key"
                  checked={form.authType === 'key'}
                  onChange={() => setForm({ ...form, authType: 'key' })}
                />
                私钥
              </label>
            </div>
          </div>
          {form.authType === 'password' ? (
            <div className="form-row">
              <label>密码</label>
              <input
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder="输入密码"
              />
            </div>
          ) : (
            <div className="form-row">
              <label>私钥</label>
              <textarea
                value={form.privateKey}
                onChange={(e) => setForm({ ...form, privateKey: e.target.value })}
                placeholder="粘贴私钥内容（PEM 格式）"
                rows={4}
              />
            </div>
          )}
          <div className="form-actions">
            <button className="btn" onClick={handleSave}>
              {editingId ? '更新' : '保存'}
            </button>
            <button className="btn btn-secondary" onClick={resetForm}>
              取消
            </button>
          </div>
        </div>
        )}
      </div>

      <div className="section">
        <div className="section-header section-header--collapsible" onClick={() => toggleSection('sessions')}>
          <span className={`section-chevron ${expandedSections.sessions ? 'expanded' : ''}`}>▶</span>
          <span>活动会话</span>
          <span className="count-badge">{sessions.length}</span>
        </div>
        {expandedSections.sessions && sessions.length > 0 && (
        <div className="session-list">
            {sessions.map((session) => {
              const expanded = expandedSessions[session.id] || false;
              return (
                <div key={session.id} className="session">
                  <div className="session-header" onClick={() => setExpandedSessions((prev) => ({ ...prev, [session.id]: !prev[session.id] }))}>
                    <span>{expanded ? '▼' : '▶'}</span>
                    <span className={`session-status ${session.status}`} />
                    <span className="session-name">{getConnectionName(session.connectionId)}</span>
                    <div className="session-actions">
                      {session.status === 'connected' && (
                        <button className="icon-btn" title="断开" onClick={(e) => { e.stopPropagation(); handleDisconnect(session.id); }}>■</button>
                      )}
                      <button className="icon-btn" title="关闭" onClick={(e) => { e.stopPropagation(); handleCloseSession(session.id); }}>✕</button>
                    </div>
                  </div>
                  {expanded && (
                    <div className="session-body">
                      <div className="terminal" ref={(el) => { terminalRefs.current[session.id] = el; }}>
                        {session.output.map((line, idx) => (
                          <pre key={idx} className="terminal-line">{line}</pre>
                        ))}
                      </div>
                      {session.status === 'connected' && (
                        <div className="command-bar">
                          <input
                            type="text"
                            className="command-input"
                            placeholder="输入命令..."
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                handleExecute(session.id, e.currentTarget.value);
                                e.currentTarget.value = '';
                              }
                            }}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
