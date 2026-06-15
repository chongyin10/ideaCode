import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { FolderOpen, Search, Clock, X, Folder } from 'lucide-react';
import { useAppSelector, useAppDispatch } from '../store/hooks';
import type { OpenedFile, EditorSnapshot } from '../store/slices/workspaceSlice';
import {
  loadDirectory,
  openFile,
  closeFile,
  activateFile,
  setFileContent,
  setMirrorFileContent,
  saveFile,
  pinPreviewFile,
  fetchRecentProjects,
  removeRecentProjectThunk,
  toggleSplitView,
  setActiveGroup,
  navigateTabHistory,
  saveEditorSnapshot,
  setGroupRatio,
  equalizeGroupRatios,
} from '../store/slices/workspaceSlice';
import { openDirectory, warmupFileCache } from '../services/fileService';
import TabBar from '../components/TabBar';
import MonacoEditor from '../components/MonacoEditor';
import ConfirmDialog, { type ConfirmResult } from '../components/ConfirmDialog';
import QuickOpen from '../components/QuickOpen';
import GitSetupPanel from '../components/GitSetupPanel';
import DiffEditorPanel from '../components/DiffEditorPanel';
import SettingsPanel from '../components/SettingsPanel';
import { BCMTabManager } from '../utils/algorithms/neuralTabManager';
import { EntropyFilePrefetcher } from '../utils/algorithms/filePrediction';
import { eventBus } from '../utils/eventBus';
import './Home.css';

const DAY_MS = 24 * 60 * 60 * 1000;
const pad = (n: number) => n.toString().padStart(2, '0');

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  if (diff < DAY_MS && date.getDate() === now.getDate()) {
    return `今天 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  if (diff < 2 * DAY_MS) {
    return `昨天 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/* ─── Hebbian 协同文件学习 ─── */

const COOC_KEY = 'ideacode_split_cooccurrence';
const COOC_DECAY = 0.98;

interface CoocMatrix { [fileA: string]: { [fileB: string]: number } }

function loadCooc(): CoocMatrix {
  try { const raw = localStorage.getItem(COOC_KEY); return raw ? JSON.parse(raw) : {}; }
  catch { return {}; }
}
function saveCooc(m: CoocMatrix) {
  try { localStorage.setItem(COOC_KEY, JSON.stringify(m)); } catch { /* 忽略 */ }
}
function recordCooccurrence(fileA: string, fileB: string) {
  if (!fileA || !fileB || fileA === fileB) return;
  const m = loadCooc();
  for (const key of Object.keys(m)) {
    for (const k2 of Object.keys(m[key])) {
      m[key][k2] *= COOC_DECAY;
      if (m[key][k2] < 0.01) delete m[key][k2];
    }
    if (Object.keys(m[key]).length === 0) delete m[key];
  }
  if (!m[fileA]) m[fileA] = {};
  if (!m[fileB]) m[fileB] = {};
  m[fileA][fileB] = (m[fileA][fileB] || 0) + 0.15;
  m[fileB][fileA] = (m[fileB][fileA] || 0) + 0.15;
  saveCooc(m);
}
/* ─── 主组件 ─── */

function Home() {
  const dispatch = useAppDispatch();
  const workspace = useAppSelector((state) => state.workspace);
  const { openedFiles, recentProjects, editorGroups, activeGroupIndex, allFilePaths, mirrorContent, splitPhase, editorSnapshots: snapshots } = workspace;
  const splitView = editorGroups.length > 1;
  const showCloneForm = useAppSelector((state) => state.git.showCloneForm);
  const diffView = useAppSelector((state) => state.workspace.diffView);
  const settingsVisible = useAppSelector((state) => state.workspace.settingsVisible);
  const rootSource = useAppSelector((state) => state.workspace.rootSource);
  const rootPath = typeof rootSource === 'string' ? rootSource : '';
  const gitStaged = useAppSelector((s) => s.git.staged);
  const gitChanges = useAppSelector((s) => s.git.changes);
  const gitMerge = useAppSelector((s) => s.git.merge);
  const gitUntracked = useAppSelector((s) => s.git.untracked);
  const gitStatus = useMemo(() => ({ ...gitStaged, ...gitChanges, ...gitMerge, ...gitUntracked }), [gitStaged, gitChanges, gitMerge, gitUntracked]);

  /* ═══ BCM 神经启发 Tab 管理器 ═══ */
  const bcmRef = useRef(new BCMTabManager({
    learningRate: 0.05,
    decayRate: 0.001,
    evictionThreshold: 0.15,
    softMaxTabs: 15,
  }));

  /* ═══ 条件熵文件预取器 ═══ */
  const prefetcherRef = useRef(new EntropyFilePrefetcher());

  const [quickOpenVisible, setQuickOpenVisible] = useState(false);
  const [closeConfirm, setCloseConfirm] = useState<{ id: string; groupIndex: number } | null>(null);
  const [loadingFiles, setLoadingFiles] = useState<Set<string>>(new Set());
  const loadingTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Tab 加载就绪回调（tsserver 返回诊断时）
  const handleTabReady = useCallback((fileId: string) => {
    const timer = loadingTimersRef.current.get(fileId);
    if (timer) { clearTimeout(timer); loadingTimersRef.current.delete(fileId); }
    setLoadingFiles((prev) => {
      if (!prev.has(fileId)) return prev;
      const next = new Set(prev);
      next.delete(fileId);
      return next;
    });
  }, []);

  // 监听新打开文件，标记加载中 + 3秒保底超时
  const prevFileIdsRef = useRef<string[]>([]);
  // 用字符串 key 替代整个 editorGroups 数组，避免无关 workspace action 触发重计算
  const fileIdKey = useMemo(
    () => editorGroups.flatMap((g) => g.fileIds).join(','),
    [editorGroups]
  );
  useEffect(() => {
    const currentIds = editorGroups.flatMap((g) => g.fileIds);
    const newIds = currentIds.filter((id) => !prevFileIdsRef.current.includes(id));
    const removedIds = prevFileIdsRef.current.filter((id) => !currentIds.includes(id));

    // 清理已关闭文件的超时
    removedIds.forEach((id) => {
      const timer = loadingTimersRef.current.get(id);
      if (timer) { clearTimeout(timer); loadingTimersRef.current.delete(id); }
    });

    if (newIds.length > 0) {
      setLoadingFiles((prev) => {
        const next = new Set(prev);
        newIds.forEach((id) => {
          next.add(id);
          // 3 秒保底：即使 tsserver 无响应也停止动画
          const timer = setTimeout(() => handleTabReady(id), 3000);
          loadingTimersRef.current.set(id, timer);
        });
        return next;
      });
    }
    prevFileIdsRef.current = currentIds;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileIdKey]);

  // 预构建 openedFiles 查找表
  const openedFileMap = useMemo(
    () => new Map(openedFiles.map((f) => [f.id, f])),
    [openedFiles]
  );

  // 计算各组 tabs
  const groupTabs = useMemo(
    () => editorGroups.map((g) =>
      g.fileIds.map((id) => openedFileMap.get(id)).filter((f): f is OpenedFile => !!f)
    ),
    [editorGroups, openedFileMap]
  );

  // 所有打开的文件 ID 集合
  const allFileIds = useMemo(() => {
    const set = new Set<string>();
    editorGroups.forEach((g) => g.fileIds.forEach((id) => set.add(id)));
    return Array.from(set);
  }, [editorGroups]);

  useEffect(() => { dispatch(fetchRecentProjects()); }, [dispatch]);

  /* ═══ BCM Tab 生命周期管理 ═══ */
  // 当 Tab 激活时：注册/更新 BCM 状态，记录条件熵转移
  const activeFileIdRef = useRef<string | null>(null);
  useEffect(() => {
    const g = editorGroups[activeGroupIndex];
    if (!g) return;
    const newActiveId = g.activeFileId;
    const oldActiveId = activeFileIdRef.current;

    if (newActiveId && newActiveId !== oldActiveId) {
      const tabInfo = openedFiles.find(f => f.id === newActiveId);

      // 注册/切换 BCM Tab
      if (oldActiveId) {
        bcmRef.current.switchTab(oldActiveId, newActiveId, 1);
      } else {
        bcmRef.current.registerTab(newActiveId, true);
        bcmRef.current.recordActivity(newActiveId, 1, false);
      }

      // 记录条件熵转移
      if (oldActiveId && tabInfo) {
        prefetcherRef.current.recordTransition(
          openedFiles.find(f => f.id === oldActiveId)?.name || oldActiveId,
          tabInfo.name
        );
      }

      // EventBus 发布
      eventBus.emit('tab:activated', { fileId: newActiveId, groupIndex: activeGroupIndex });

      activeFileIdRef.current = newActiveId;
    }
  }, [editorGroups, activeGroupIndex, openedFiles]);

  // Tab 关闭时：从 BCM 移除
  const prevFileIdsRef2 = useRef<string[]>([]);
  useEffect(() => {
    // 用 file.id (完整路径) 作为标识，避免同名文件碰撞
    const currentIds = editorGroups.flatMap(g => g.fileIds);
    const prevIds = prevFileIdsRef2.current;

    const closed = prevIds.filter(id => !currentIds.includes(id));
    for (const closedId of closed) {
      bcmRef.current.closeTab(closedId);
      eventBus.emit('tab:closed', { fileId: closedId, groupIndex: activeGroupIndex });
    }

    prevFileIdsRef2.current = currentIds;
  }, [editorGroups, activeGroupIndex]);

  // 项目打开后预热文件缓存（仅执行一次）
  const cacheWarmedRef = useRef(false);
  useEffect(() => {
    if (!cacheWarmedRef.current && rootPath && allFilePaths.length > 0) {
      cacheWarmedRef.current = true;
      warmupFileCache(rootPath, allFilePaths.slice(0, 10)).catch(() => {});
    }
  }, [rootPath, allFilePaths]);

  /* ─── Cmd+Click 跳转到定义 ─── */
  useEffect(() => {
    const handler = (e: CustomEvent<{ path: string }>) => {
      let filePath = e.detail.path;
      if (!filePath) return;
      // 确保绝对路径以 / 开头
      if (!filePath.startsWith('/')) filePath = '/' + filePath;
      const fileName = filePath.split('/').pop();
      if (fileName) {
        dispatch(openFile({ name: fileName, kind: 'file', source: filePath }));
      }
    };
    window.addEventListener('ideacode:openDefinition', handler as EventListener);
    return () => window.removeEventListener('ideacode:openDefinition', handler as EventListener);
  }, [dispatch]);

  /* ─── 键盘快捷键（用 ref 避免 deps 变化） ─── */

  const wsRef = useRef(workspace);
  wsRef.current = workspace;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const ws = wsRef.current;
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        const g = ws.editorGroups[ws.activeGroupIndex];
        if (g?.activeFileId) {
          dispatch(saveFile({ id: g.activeFileId, groupIndex: ws.activeGroupIndex }));
        }
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'Tab') {
        e.preventDefault();
        dispatch(navigateTabHistory('backward'));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [dispatch]);

  /* ─── 协同学习 ─── */

  const coocRecordedRef = useRef('');
  useEffect(() => {
    if (editorGroups.length <= 1) return;
    const names = editorGroups
      .map((g) => g.activeFileId ? (openedFiles.find((f) => f.id === g.activeFileId)?.name || g.activeFileId) : null)
      .filter(Boolean) as string[];
    const key = names.sort().join('|');
    if (!key || key === coocRecordedRef.current) return;
    coocRecordedRef.current = key;
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        recordCooccurrence(names[i], names[j]);
      }
    }
  }, [editorGroups, openedFiles]);

  /* ─── 事件处理 ─── */

  const handleOpenFolder = async () => {
    const dir = await openDirectory();
    if (dir) dispatch(loadDirectory({ source: dir.source, name: dir.name }));
  };

  const handleOpenRecent = useCallback(
    (projectPath: string, name: string) => dispatch(loadDirectory({ source: projectPath, name })),
    [dispatch]
  );

  const handleRemoveRecent = useCallback(
    (e: React.MouseEvent, projectPath: string) => {
      e.stopPropagation();
      dispatch(removeRecentProjectThunk(projectPath));
    },
    [dispatch]
  );

  const handleOpenQuickOpen = useCallback(() => setQuickOpenVisible(true), []);

  /* ─── 面板内容获取 ─── */

  const mirrorRef = useRef(mirrorContent);
  mirrorRef.current = mirrorContent;
  const openedFilesRef = useRef(openedFiles);
  openedFilesRef.current = openedFiles;

  const getPanelContent = useCallback((fileId: string | null, groupIndex: number): string | undefined => {
    if (!fileId) return undefined;
    const mc = mirrorRef.current[`${fileId}::${groupIndex}`];
    if (mc !== undefined) return mc;
    return openedFilesRef.current.find((f) => f.id === fileId)?.content;
  }, []);

  /* ─── 编辑器变更 ─── */

  const egRef = useRef(editorGroups);
  egRef.current = editorGroups;

  const handleEditorChange = useCallback(
    (fileId: string | null, groupIndex: number) => (value: string) => {
      if (!fileId) return;
      const groupsWithFile = egRef.current.filter((g) => g.fileIds.includes(fileId));
      if (groupsWithFile.length > 1) {
        dispatch(setMirrorFileContent({ fileId, groupIndex, content: value }));
      } else {
        dispatch(setFileContent({ id: fileId, content: value }));
      }
    },
    [dispatch]
  );

  /* ─── 关闭 Tab ─── */

  const handleCloseTab = useCallback(
    (id: string, groupIndex: number) => {
      const file = openedFilesRef.current.find((f) => f.id === id);
      if (file?.isDirty) {
        setCloseConfirm({ id, groupIndex });
        return;
      }
      dispatch(closeFile({ id, groupIndex }));
    },
    [dispatch]
  );

  const handleCloseConfirm = useCallback(
    async (result: ConfirmResult) => {
      if (!closeConfirm) return;
      const { id, groupIndex } = closeConfirm;
      setCloseConfirm(null);
      if (result === 'cancel') return;
      if (result === 'save') {
        try {
          await dispatch(saveFile({ id, groupIndex })).unwrap();
        } catch (err) {
          console.error('保存失败', err);
          return;
        }
      }
      dispatch(closeFile({ id, groupIndex }));
    },
    [closeConfirm, dispatch]
  );

  /* ─── 拖拽调整列宽 ─── */

  const splitRef = useRef<HTMLDivElement>(null);
  const [draggingIdx, setDraggingIdx] = useState(-1);
  const egDragRef = useRef(editorGroups);
  egDragRef.current = editorGroups;

  useEffect(() => {
    if (draggingIdx < 0) return;
    const handleMouseMove = (e: MouseEvent) => {
      if (!splitRef.current) return;
      const rect = splitRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const totalWidth = rect.width;
      const groups = egDragRef.current;
      const leftGroup = groups[draggingIdx];
      const rightGroup = groups[draggingIdx + 1];
      if (!leftGroup || !rightGroup) return;
      const totalRatio = groups.reduce((s, g) => s + g.ratio, 0);
      const newLeft = (x / totalWidth) * totalRatio;
      const newRight = leftGroup.ratio + rightGroup.ratio - newLeft;
      if (newLeft > 0.3 && newRight > 0.3) {
        dispatch(setGroupRatio({ groupIndex: draggingIdx, ratio: newLeft }));
        dispatch(setGroupRatio({ groupIndex: draggingIdx + 1, ratio: newRight }));
      }
    };
    const handleMouseUp = () => setDraggingIdx(-1);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
    // draggingIdx is the only real dep; egDragRef is stable ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draggingIdx]);

  const handleDragStart = useCallback((dividerIndex: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    setDraggingIdx(dividerIndex);
  }, []);

  // Cmd/Ctrl+Click 跳转文件：已存在则激活，不存在以预览态打开
  const handleOpenFileByPath = useCallback((filePath: string) => {
    const existing = openedFiles.find((f) => typeof f.source === 'string' && f.source === filePath);
    if (existing) {
      dispatch(activateFile(existing.id));
      return;
    }
    const name = filePath.split('/').pop() || filePath;
    dispatch(openFile({ name, kind: 'file', source: filePath }));
  }, [openedFiles, dispatch]);

  /* ─── 编辑器快照 ─── */

  const snapshotsRef = useRef(snapshots);
  snapshotsRef.current = snapshots;

  const getGroupSnapshot = useCallback((fileId: string | null, groupIndex: number): EditorSnapshot | undefined => {
    return snapshotsRef.current[`${fileId ?? ''}::${groupIndex}`];
  }, []);

  const getSnapshotSaver = useCallback(
    (fileId: string | null, groupIndex: number) => (snap: EditorSnapshot) => {
      if (fileId) dispatch(saveEditorSnapshot({ fileId, groupIndex, snapshot: snap }));
    },
    [dispatch]
  );

  /* ─── 渲染面板 ─── */

  const renderEditorPanel = useCallback(
    (options: {
      groupIndex: number;
      tabs: OpenedFile[];
      group: { id: string; fileIds: string[]; activeFileId: string | null; tabHistory: string[]; ratio: number };
      focused: boolean;
      snapshot: EditorSnapshot | undefined;
      saveSnapshot: (s: EditorSnapshot) => void;
    }) => {
      const { groupIndex, tabs, group, focused, snapshot, saveSnapshot } = options;
      const panelContent = getPanelContent(group.activeFileId, groupIndex);
      const file = openedFilesRef.current.find((f) => f.id === group.activeFileId);
      return (
        <>
          <TabBar
            tabs={tabs.map((f) => {
              const relPath = typeof f.source === 'string' && rootPath
                ? f.source.replace(rootPath + '/', '')
                : '';
              const gitCode = relPath ? gitStatus[relPath] : '';
              return {
                id: f.id,
                name: f.name,
                isDirty: f.isDirty,
                isPreview: f.isPreview,
                gitStatus: gitCode,
              };
            })}
            activeId={group.activeFileId}
            onActivate={(id) => dispatch(activateFile(id))}
            onClose={(id) => handleCloseTab(id, groupIndex)}
            onPin={() => dispatch(pinPreviewFile())}
            onSplitView={() => dispatch(toggleSplitView())}
            splitActive={splitView}
            focused={focused}
            loadingFiles={loadingFiles}
          />
          <div className="editor-area">
            {file ? (
                <MonacoEditor
                key={`${file.id}-${group.id}`}
                value={panelContent ?? file.content}
                language={file.language}
                path={typeof file.source === 'string' ? file.source : file.name}
                modelPath={`ideacode://${group.id}/${file.id}`}
                onChange={handleEditorChange(group.activeFileId, groupIndex)}
                snapshot={snapshot}
                onSnapshot={saveSnapshot}
                focused={focused}
                onOpenFileByPath={handleOpenFileByPath}
                onReady={() => handleTabReady(file?.id || '')}
              />
            ) : (
              <div className="no-active-file">
                <button className="open-folder-btn secondary" onClick={handleOpenQuickOpen}>
                  <Search size={16} strokeWidth={1.5} />
                  快速打开文件 (Ctrl+P)
                </button>
              </div>
            )}
          </div>
        </>
      );
    },
    [dispatch, handleCloseTab, handleEditorChange, handleOpenQuickOpen, splitView, getPanelContent, rootPath, gitStatus, handleTabReady, handleOpenFileByPath, loadingFiles]
  );

  return (
    <div className="home-page">
      {quickOpenVisible && (
        <QuickOpen onClose={() => setQuickOpenVisible(false)} files={allFilePaths} />
      )}

      {closeConfirm && (
        <ConfirmDialog
          title="文件有未保存的更改"
          message="是否保存对当前文件的更改？"
          onResult={handleCloseConfirm}
        />
      )}

      {settingsVisible ? (
        <SettingsPanel />
      ) : diffView ? (
        <DiffEditorPanel />
      ) : showCloneForm ? (
        <GitSetupPanel />
      ) : allFileIds.length === 0 ? (
        <div className="welcome-screen">
          <h2>欢迎使用 IDEACODE</h2>
          <p>基于 Monaco Editor 的轻量级 IDE</p>
          <div className="welcome-actions">
            <button className="open-folder-btn" onClick={handleOpenFolder}>
              <FolderOpen size={16} strokeWidth={1.5} /> 打开文件夹
            </button>
            <button className="open-folder-btn secondary" onClick={handleOpenQuickOpen}>
              <Search size={16} strokeWidth={1.5} /> 快速打开文件 (Ctrl+P)
            </button>
          </div>
          {recentProjects.length > 0 && (
            <div className="recent-projects">
              <div className="recent-projects__header">
                <Clock size={14} strokeWidth={1.5} /> <span>最近打开的项目</span>
              </div>
              <div className="recent-projects__list">
                {recentProjects.map((project) => (
                  <div key={project.path} className="recent-project-item"
                    onClick={() => handleOpenRecent(project.path, project.name)} title={project.path}>
                    <span className="recent-project-item__icon"><Folder size={16} strokeWidth={1.5} /></span>
                    <div className="recent-project-item__info">
                      <span className="recent-project-item__name">{project.name}</span>
                      <span className="recent-project-item__path">{project.path}</span>
                    </div>
                    <div className="recent-project-item__meta">
                      <span className="recent-project-item__time">{formatTime(project.timestamp)}</span>
                      <button className="recent-project-item__remove" onClick={(e) => handleRemoveRecent(e, project.path)} title="从历史记录中移除">
                        <X size={12} strokeWidth={1.5} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="shortcuts">
            <div className="shortcut"><span>快速打开文件</span> <kbd>Ctrl+P</kbd></div>
            <div className="shortcut"><span>分屏编辑</span> <kbd>点击 Columns 图标</kbd></div>
            <div className="shortcut"><span>切换 Tab (MRU)</span> <kbd>Ctrl+Tab</kbd></div>
          </div>
        </div>
      ) : (
        <div className="editor-workspace">
          <div
            ref={splitRef}
            className={`editor-split ${draggingIdx >= 0 ? 'editor-split--dragging' : ''} ${splitPhase === 'opening' ? 'editor-split--opening' : ''}`}
          >
            {editorGroups.map((group, idx) => {
              const tabs = groupTabs[idx] || [];
              const focused = idx === activeGroupIndex;
              const snap = getGroupSnapshot(group.activeFileId, idx);
              const saveSnap = getSnapshotSaver(group.activeFileId, idx);
              const isLast = idx === editorGroups.length - 1;
              return (
                <div key={group.id} style={{ display: 'contents' }}>
                  <div
                    className={`editor-split__panel ${!focused ? 'editor-split__panel--dimmed' : ''}`}
                    style={{ flex: group.ratio }}
                    onClick={() => { if (idx !== activeGroupIndex) dispatch(setActiveGroup(idx)); }}
                  >
                    {renderEditorPanel({ groupIndex: idx, tabs, group, focused, snapshot: snap, saveSnapshot: saveSnap })}
                  </div>
                  {!isLast && (
                    <div className="editor-split__divider" onMouseDown={handleDragStart(idx)} />
                  )}
                </div>
              );
            })}
          </div>
          {splitView && (
            <div className="editor-split__toolbar">
              <button className="editor-split__toolbar-btn" onClick={() => dispatch(equalizeGroupRatios())} title="均匀分布列宽">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
                </svg>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default Home;
