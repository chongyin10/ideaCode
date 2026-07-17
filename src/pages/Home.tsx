import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Search, Clock, X, Folder, FilePlus, GitBranch, Link2 } from 'lucide-react';
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
  toggleFileReadOnly,
  fetchRecentProjects,
  removeRecentProjectThunk,
  toggleSplitView,
  setActiveGroup,
  navigateTabHistory,
  saveEditorSnapshot,
  setGroupRatio,
  equalizeGroupRatios,
  reorderTab,
} from '../store/slices/workspaceSlice';
import { removeEditorTerminal } from '../store/slices/terminalSlice';

import { warmupFileCache, openFileDialog } from '../services/fileService';
import { terminalSDK } from '../services/terminalSDK';
import TabBar, { type TabType } from '../components/TabBar';
import MonacoEditor from '../components/MonacoEditor';
import ConfirmDialog, { type ConfirmResult } from '../components/ConfirmDialog';
import ContextMenu, { type MenuItem } from '../components/ContextMenu';
import { findFileReferences, type FileSearchResult } from '../services/searchService';
import { revealInExplorer } from '../services/fileOperations';
import { notifyPanelResizeStart, notifyPanelResizeEnd } from '../services/panelResizeNotifier';
import { BCMTabManager } from '../utils/algorithms/neuralTabManager';
import { EntropyFilePrefetcher } from '../utils/algorithms/filePrediction';
import { eventBus } from '../utils/eventBus';
import './Home.css';

// ─── 按需加载组件（React.lazy + Suspense）───
// 这些组件仅在特定操作时才需要（查看 diff / 扩展详情 / SSH / 终端 / 设置 / 模态框），
// 不在首屏 bundle 中加载，减少首屏体积。
const DiffEditorPanel = lazy(() => import('../components/DiffEditorPanel'));
const CommitDetailPanel = lazy(() => import('../components/CommitDetailPanel'));
const ExtensionDetail = lazy(() => import('../components/ExtensionDetail'));
const SshFileTreePanel = lazy(() => import('../components/SshFileTreePanel'));
const TerminalEditorView = lazy(() => import('../components/TerminalEditorView'));
const ConnectToModal = lazy(() => import('../components/ConnectToModal'));
const CloneRepoModal = lazy(() => import('../components/CloneRepoModal'));
const QuickOpen = lazy(() => import('../components/QuickOpen'));
const SettingsPanel = lazy(() => import('../components/SettingsPanel'));
const FileReferencesModal = lazy(() => import('../components/FileReferencesModal'));

const DAY_MS = 24 * 60 * 60 * 1000;
const pad = (n: number) => n.toString().padStart(2, '0');

const formatTime = (timestamp: number, translate: (key: string, options?: Record<string, unknown>) => string): string => {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (diff < DAY_MS && date.getDate() === now.getDate()) {
    return translate('home.time.today', { time });
  }
  if (diff < 2 * DAY_MS) {
    return translate('home.time.yesterday', { time });
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** 根据 openedFile 判断 Tab 类型，用于控制标签页是否显示只读锁图标 */
function getTabType(file: { language: string; name: string }): TabType {
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  const imageExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg']);
  switch (file.language) {
    case 'ssh-file-tree':
      return 'structure';
    case 'terminal':
      return 'terminal';
    case 'extension':
      return 'extension';
    default:
      if (imageExts.has(ext)) return 'image';
      return 'file';
  }
}

/* ─── Hebbian 协同文件学习 ─── */

const COOC_KEY = 'ideacode_split_cooccurrence';
const COOC_DECAY = 0.98;
const COOC_FLUSH_INTERVAL = 30000; // 30s 批量持久化，避免每次记录都全量序列化

interface CoocMatrix { [fileA: string]: { [fileB: string]: number } }

// 内存化矩阵：避免每次记录都 localStorage.getItem + JSON.parse 全量加载。
// 启动时懒加载一次，之后只读写内存；30s 批量 flush 到 localStorage。
let coocMatrix: CoocMatrix | null = null;
let coocDirty = false;
let coocFlushTimer: ReturnType<typeof setTimeout> | null = null;

function getCoocMatrix(): CoocMatrix {
  if (coocMatrix === null) {
    try {
      const raw = localStorage.getItem(COOC_KEY);
      coocMatrix = raw ? JSON.parse(raw) : {};
    } catch {
      coocMatrix = {};
    }
  }
  return coocMatrix!;
}

function scheduleCoocFlush() {
  if (coocFlushTimer) return;
  coocDirty = true;
  coocFlushTimer = setTimeout(() => {
    coocFlushTimer = null;
    if (coocDirty && coocMatrix) {
      coocDirty = false;
      try { localStorage.setItem(COOC_KEY, JSON.stringify(coocMatrix)); } catch { /* 忽略 */ }
    }
  }, COOC_FLUSH_INTERVAL);
}

/** 惰性衰减：仅衰减指定行，避免每次记录都全表 O(N²) 扫描 */
function decayRow(m: CoocMatrix, key: string) {
  const row = m[key];
  if (!row) return;
  for (const k2 of Object.keys(row)) {
    row[k2] *= COOC_DECAY;
    if (row[k2] < 0.01) delete row[k2];
  }
  if (Object.keys(row).length === 0) delete m[key];
}

function recordCooccurrence(fileA: string, fileB: string) {
  if (!fileA || !fileB || fileA === fileB) return;
  const m = getCoocMatrix();
  // 仅衰减涉及的两行（O(N) 而非 O(N²)），未访问的行保持原值
  decayRow(m, fileA);
  decayRow(m, fileB);
  if (!m[fileA]) m[fileA] = {};
  if (!m[fileB]) m[fileB] = {};
  m[fileA][fileB] = (m[fileA][fileB] || 0) + 0.15;
  m[fileB][fileA] = (m[fileB][fileA] || 0) + 0.15;
  scheduleCoocFlush();
}
/* ─── 主组件 ─── */

function Home() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  // 按字段拆分细粒度 selector，避免任一 workspace 字段变化（高频的 setMirrorFileContent /
  // gitStatus / searchHighlight 等）都触发 Home 全量重渲染，进而级联所有 TabBar/MonacoEditor。
  // useAppSelector 用 Object.is 比较返回值，Immer 仅对真正变化的字段产生新引用。
  const openedFiles = useAppSelector((state) => state.workspace.openedFiles);
  const recentProjects = useAppSelector((state) => state.workspace.recentProjects);
  const editorGroups = useAppSelector((state) => state.workspace.editorGroups);
  const activeGroupIndex = useAppSelector((state) => state.workspace.activeGroupIndex);
  const allFilePaths = useAppSelector((state) => state.workspace.allFilePaths);
  const mirrorContent = useAppSelector((state) => state.workspace.mirrorContent);
  const splitPhase = useAppSelector((state) => state.workspace.splitPhase);
  const snapshots = useAppSelector((state) => state.workspace.editorSnapshots);
  const missingFileIds = useAppSelector((state) => state.workspace.missingFileIds);
  const splitView = editorGroups.length > 1;
  const settingsVisible = useAppSelector((state) => state.workspace.settingsVisible);
  const rootSource = useAppSelector((state) => state.workspace.rootSource);
  const rootPath = typeof rootSource === 'string' ? rootSource : '';
  // Git 文件状态由 web/git 扩展通过 extension bridge 推送到 Redux
  const gitStatus = useAppSelector((state) => state.workspace.gitStatus);

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
  const [pendingClose, setPendingClose] = useState<{ id: string; groupIndex: number }[] | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; fileId: string; groupIndex: number } | null>(null);
  const [referencesModal, setReferencesModal] = useState<{ fileId: string; results: FileSearchResult[] } | null>(null);
  const [loadingFiles, setLoadingFiles] = useState<Set<string>>(new Set());
  // §需求："连接到..." Modal 的开关状态
  const [connectToOpen, setConnectToOpen] = useState(false);
  const [cloneRepoOpen, setCloneRepoOpen] = useState(false);

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

  // 预构建缺失文件 ID 集合
  const missingFileIdsSet = useMemo(
    () => new Set(missingFileIds),
    [missingFileIds]
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

  // 仅跟踪快捷键需要的两个字段，避免引用整个 workspace 切片
  const wsRef = useRef({ editorGroups, activeGroupIndex });
  wsRef.current = { editorGroups, activeGroupIndex };

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

  // §打开本地文件（只能选择文件类型）
  const handleOpenFile = useCallback(async () => {
    const file = await openFileDialog();
    if (!file) return;
    dispatch(openFile({ name: file.name, source: file.source, kind: 'file' }));
  }, [dispatch]);

  // §新建无标题文本文件，默认名 unknown-1.txt，依此类推
  const handleNewFile = useCallback(() => {
    let n = 1;
    const base = 'unknown';
    while (openedFiles.some((f) => f.name === `${base}-${n}.txt`)) {
      n += 1;
    }
    const name = `${base}-${n}.txt`;
    dispatch(openFile({
      name,
      source: `untitled://${Date.now()}-${n}`,
      kind: 'file',
    }));
  }, [dispatch, openedFiles]);

  // §克隆 Git 仓库
  const handleOpenClone = useCallback(() => {
    setCloneRepoOpen(true);
  }, []);

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
        setPendingClose([{ id, groupIndex }]);
        return;
      }
      // 终端标签关闭时需要同步清理 terminal 状态与底层进程
      if (file?.language === 'terminal') {
        dispatch(closeFile({ id, groupIndex }));
        dispatch(removeEditorTerminal(id));
        terminalSDK.disposeTab(id).catch(() => {});
        return;
      }
      // Diff 文件和普通文件一样按组关闭：closeFile 只从指定组移除，
      // 当文件不再被任何组引用时自动从 openedFiles 清理。
      // 避免使用 closeDiffView（它会从所有组中移除，导致多面板时全部关闭）。
      dispatch(closeFile({ id, groupIndex }));
    },
    [dispatch]
  );

  const closeTargetsWithConfirm = useCallback(
    (targets: { id: string; groupIndex: number }[]) => {
      if (targets.length === 0) return;
      const hasDirty = targets.some((t) => {
        const file = openedFilesRef.current.find((f) => f.id === t.id);
        return file?.isDirty;
      });
      if (hasDirty) {
        setPendingClose(targets);
        return;
      }
      targets
        .slice()
        .sort((a, b) => b.groupIndex - a.groupIndex)
        .forEach((t) => {
          const file = openedFilesRef.current.find((f) => f.id === t.id);
          if (file?.language === 'terminal') {
            dispatch(closeFile(t));
            dispatch(removeEditorTerminal(t.id));
            terminalSDK.disposeTab(t.id).catch(() => {});
          } else {
            dispatch(closeFile(t));
          }
        });
    },
    [dispatch]
  );

  const handleCloseConfirm = useCallback(
    async (result: ConfirmResult) => {
      if (!pendingClose) return;
      const targets = pendingClose;
      setPendingClose(null);
      if (result === 'cancel') return;

      if (result === 'save') {
        for (const { id, groupIndex } of targets) {
          const file = openedFilesRef.current.find((f) => f.id === id);
          if (!file?.isDirty) continue;
          try {
            await dispatch(saveFile({ id, groupIndex })).unwrap();
          } catch (err) {
            console.error('保存失败', err);
            return;
          }
        }
      }

      targets
        .slice()
        .sort((a, b) => b.groupIndex - a.groupIndex)
        .forEach((t) => {
          const file = openedFilesRef.current.find((f) => f.id === t.id);
          if (file?.language === 'terminal') {
            dispatch(closeFile(t));
            dispatch(removeEditorTerminal(t.id));
            terminalSDK.disposeTab(t.id).catch(() => {});
          } else {
            dispatch(closeFile(t));
          }
        });
    },
    [pendingClose, dispatch]
  );

  /* ─── 拖拽调整列宽 ─── */

  const splitRef = useRef<HTMLDivElement>(null);
  const [draggingIdx, setDraggingIdx] = useState(-1);
  const egDragRef = useRef(editorGroups);
  egDragRef.current = editorGroups;

  useEffect(() => {
    if (draggingIdx < 0) return;
    // §rAF 节流：mousemove 高频触发，若每次都同步 dispatch 两次 Redux + 重渲染，
    // 多个 DiffEditor 会同时 layout() 重新计算 diff，阻塞主线程导致拖动延迟/不同步。
    // 用 rAF 合并：每帧最多 dispatch 一次，保证视觉与光标同步。
    let rafId: number | null = null;
    let lastEvent: MouseEvent | null = null;

    const applyResize = () => {
      rafId = null;
      const e = lastEvent;
      if (!e || !splitRef.current) return;
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

    const handleMouseMove = (e: MouseEvent) => {
      lastEvent = e;
      if (rafId === null) {
        rafId = requestAnimationFrame(applyResize);
      }
    };
    const handleMouseUp = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      setDraggingIdx(-1);
      // 通知 DiffEditor/MonacoEditor 恢复 automaticLayout 并统一 layout
      notifyPanelResizeEnd();
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
    // draggingIdx is the only real dep; egDragRef is stable ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draggingIdx]);

  const handleDragStart = useCallback((dividerIndex: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    // 通知 DiffEditor/MonacoEditor 暂停 automaticLayout，避免拖动期间高频 layout() 阻塞主线程
    notifyPanelResizeStart();
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

  /* ─── Tab 右键菜单 ─── */

  const handleTabContextMenu = useCallback(
    (e: React.MouseEvent, fileId: string, groupIndex: number) => {
      setContextMenu({ x: e.clientX, y: e.clientY, fileId, groupIndex });
    },
    []
  );

  const handleCopyPath = useCallback(
    (fileId: string) => {
      const file = openedFileMap.get(fileId);
      if (file && typeof file.source === 'string') {
        navigator.clipboard.writeText(file.source).catch(() => {});
      }
    },
    [openedFileMap]
  );

  const handleCopyRelativePath = useCallback(
    (fileId: string) => {
      const file = openedFileMap.get(fileId);
      if (file && typeof file.source === 'string' && rootPath) {
        const rel = file.source.startsWith(rootPath + '/') ? file.source.slice(rootPath.length + 1) : file.source;
        navigator.clipboard.writeText(rel).catch(() => {});
      }
    },
    [openedFileMap, rootPath]
  );

  const handleRevealFile = useCallback(
    (fileId: string) => {
      const file = openedFileMap.get(fileId);
      if (file) revealInExplorer(file.source).catch(() => {});
    },
    [openedFileMap]
  );

  const handleFindReferences = useCallback(
    async (fileId: string) => {
      const file = openedFileMap.get(fileId);
      if (!file || typeof file.source !== 'string' || !rootPath) return;
      const results = await findFileReferences(rootPath, file.source, allFilePaths);
      setReferencesModal({ fileId, results });
    },
    [openedFileMap, rootPath, allFilePaths]
  );

  const contextMenuItems: MenuItem[] = useMemo(() => {
    if (!contextMenu) return [];
    const { fileId, groupIndex } = contextMenu;
    const group = editorGroups[groupIndex];
    const fileIds = group?.fileIds ?? [];
    const index = fileIds.indexOf(fileId);

    return [
      {
        id: 'close',
        label: t('tabBar.contextMenu.close'),
        group: '1_close',
        onClick: () => handleCloseTab(fileId, groupIndex),
      },
      {
        id: 'closeOthers',
        label: t('tabBar.contextMenu.closeOthers'),
        group: '1_close',
        onClick: () => {
          const targets = fileIds.filter((id) => id !== fileId).map((id) => ({ id, groupIndex }));
          closeTargetsWithConfirm(targets);
        },
      },
      {
        id: 'closeRight',
        label: t('tabBar.contextMenu.closeRight'),
        group: '1_close',
        disabled: index < 0 || index === fileIds.length - 1,
        onClick: () => {
          if (index < 0) return;
          const targets = fileIds.slice(index + 1).map((id) => ({ id, groupIndex }));
          closeTargetsWithConfirm(targets);
        },
      },
      {
        id: 'closeLeft',
        label: t('tabBar.contextMenu.closeLeft'),
        group: '1_close',
        disabled: index < 0 || index === 0,
        onClick: () => {
          if (index < 0) return;
          const targets = fileIds.slice(0, index).map((id) => ({ id, groupIndex }));
          closeTargetsWithConfirm(targets);
        },
      },
      {
        id: 'closeAll',
        label: t('tabBar.contextMenu.closeAll'),
        group: '1_close',
        onClick: () => {
          const targets = editorGroups.flatMap((g, gi) => g.fileIds.map((id) => ({ id, groupIndex: gi })));
          closeTargetsWithConfirm(targets);
        },
      },
      {
        id: 'copyPath',
        label: t('tabBar.contextMenu.copyPath'),
        group: '2_path',
        onClick: () => handleCopyPath(fileId),
      },
      {
        id: 'copyRelativePath',
        label: t('tabBar.contextMenu.copyRelativePath'),
        group: '2_path',
        onClick: () => handleCopyRelativePath(fileId),
      },
      {
        id: 'reveal',
        label: t('tabBar.contextMenu.reveal'),
        group: '3_reveal',
        onClick: () => handleRevealFile(fileId),
      },
      {
        id: 'findReferences',
        label: t('tabBar.contextMenu.findReferences'),
        group: '4_refs',
        onClick: () => handleFindReferences(fileId),
      },
    ];
  }, [contextMenu, editorGroups, t, handleCloseTab, closeTargetsWithConfirm, handleCopyPath, handleCopyRelativePath, handleRevealFile, handleFindReferences]);

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
                readOnly: f.readOnly,
                gitStatus: gitCode,
                type: getTabType(f),
              };
            })}
            activeId={group.activeFileId}
            onActivate={(id) => dispatch(activateFile(id))}
            onClose={(id) => handleCloseTab(id, groupIndex)}
            onContextMenu={(e, id) => handleTabContextMenu(e, id, groupIndex)}
            onPin={() => dispatch(pinPreviewFile())}
            onToggleReadOnly={(id) => dispatch(toggleFileReadOnly(id))}
            onReorder={(fromId, toId, position) => dispatch(reorderTab({ fromId, toId, position }))}
            onSplitView={file?.language === 'extension' || file?.language === 'ssh-file-tree' || file?.language === 'terminal' ? undefined : () => dispatch(toggleSplitView())}
            splitActive={splitView}
            focused={focused}
            loadingFiles={loadingFiles}
            missingFileIds={missingFileIdsSet}
          />
          <div className="editor-area">
            <Suspense fallback={<div className="editor-loading" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>{t('loading')}</div>}>
            {file ? (
              file.language === 'extension' ? (
                <ExtensionDetail key={`ext-${file.id}-${group.id}`} extensionId={file.id.replace('extension://', '')} />
              ) : file.language === 'ssh-file-tree' ? (
                <SshFileTreePanel key={`ssh-tree-${file.id}-${group.id}`} content={file.content} fileId={file.id} />
              ) : file.language === 'terminal' ? (
                <TerminalEditorView
                  key={`terminal-${file.id}-${group.id}`}
                  terminalId={file.id}
                  title={file.name}
                  active={focused && group.activeFileId === file.id}
                />
              ) : file.language === 'commit-detail' && file.commitDetailData ? (
                <CommitDetailPanel key={`commit-${file.id}-${group.id}`} data={file.commitDetailData} fileId={file.id} />
              ) : file.isDiff && file.diffData ? (
                <DiffEditorPanel key={`diff-${file.id}-${group.id}`} diffData={file.diffData} groupId={group.id} />
              ) : (
                <MonacoEditor
                  key={`${file.id}-${group.id}`}
                  value={panelContent ?? file.content}
                  language={file.language}
                  path={typeof file.source === 'string' ? file.source : file.name}
                  modelPath={`file:///__ideacode_group/${group.id}/${file.id.replace(/^\//, '')}`}
                  onChange={handleEditorChange(group.activeFileId, groupIndex)}
                  snapshot={snapshot}
                  onSnapshot={saveSnapshot}
                  focused={focused}
                  onOpenFileByPath={handleOpenFileByPath}
                  onReady={() => handleTabReady(file?.id || '')}
                  readOnly={file.readOnly}
                />
              )
            ) : (
              <div className="no-active-file">
                <button className="open-folder-btn secondary" onClick={handleOpenQuickOpen}>
                  <Search size={16} strokeWidth={1.5} />
                  {t('home.openQuickOpen')}
                </button>
              </div>
            )}
            </Suspense>
          </div>
        </>
      );
    },
    [dispatch, handleCloseTab, handleTabContextMenu, handleEditorChange, handleOpenQuickOpen, splitView, getPanelContent, rootPath, gitStatus, handleTabReady, handleOpenFileByPath, loadingFiles, missingFileIdsSet, t]
  );

  return (
    <div className="home-page">
      {quickOpenVisible && (
        <Suspense fallback={null}>
          <QuickOpen onClose={() => setQuickOpenVisible(false)} files={allFilePaths} />
        </Suspense>
      )}

      {pendingClose && (
        <ConfirmDialog
          title={t('home.unsavedChanges.title')}
          message={t('home.unsavedChanges.message')}
          onResult={handleCloseConfirm}
        />
      )}

      {contextMenu && (
        <ContextMenu
          items={contextMenuItems}
          x={contextMenu.x}
          y={contextMenu.y}
          visible={!!contextMenu}
          onClose={() => setContextMenu(null)}
        />
      )}

      {referencesModal && (
        <Suspense fallback={null}>
          <FileReferencesModal
            results={referencesModal.results}
            onClose={() => setReferencesModal(null)}
            onOpenResult={(relativePath) => {
              const source = rootPath ? `${rootPath}/${relativePath}` : relativePath;
              const name = relativePath.split('/').pop() || relativePath;
              dispatch(openFile({ name, kind: 'file', source }));
              setReferencesModal(null);
            }}
          />
        </Suspense>
      )}

      {/* §需求："连接到..." Modal —— SSH 远程连接 + 目录浏览 + 加载到资源管理器 */}
      {connectToOpen && (
        <Suspense fallback={null}>
          <ConnectToModal onClose={() => setConnectToOpen(false)} />
        </Suspense>
      )}
      {cloneRepoOpen && (
        <Suspense fallback={null}>
          <CloneRepoModal onClose={() => setCloneRepoOpen(false)} />
        </Suspense>
      )}

      {settingsVisible ? (
        <Suspense fallback={<div className="editor-loading" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>{t('loading')}</div>}>
          <SettingsPanel />
        </Suspense>
      ) : allFileIds.length === 0 ? (
        <div className="welcome-screen">
          <h2>{t('home.welcome.title')}</h2>
          <p>{t('home.welcome.subtitle')}</p>
          <div className="welcome-actions">
            {/* 按图 2 中列出的"启动"操作：新建 / 打开 / 克隆 / 连接到 */}
            <button className="open-folder-btn secondary" onClick={handleNewFile}>
              <FilePlus size={16} strokeWidth={1.5} /> {t('home.welcome.newFile')}
            </button>
            <button className="open-folder-btn secondary" onClick={handleOpenFile}>
              <FolderOpen size={16} strokeWidth={1.5} /> {t('home.welcome.openFile')}
            </button>
            <button className="open-folder-btn secondary" onClick={handleOpenClone}>
              <GitBranch size={16} strokeWidth={1.5} /> {t('home.welcome.cloneRepo')}
            </button>
            {/* §需求：SSH "连接到..." Modal 入口——点击后弹 ConnectToModal */}
            <button className="open-folder-btn secondary" onClick={() => setConnectToOpen(true)}>
              <Link2 size={16} strokeWidth={1.5} /> {t('home.welcome.connectTo')}
            </button>
          </div>
          {recentProjects.length > 0 && (
            <div className="recent-projects">
              <div className="recent-projects__header">
                <Clock size={14} strokeWidth={1.5} /> <span>{t('home.recentProjects.title')}</span>
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
                      <span className="recent-project-item__time">{formatTime(project.timestamp, t)}</span>
                      <button className="recent-project-item__remove" onClick={(e) => handleRemoveRecent(e, project.path)} title={t('home.recentProjects.removeTooltip')}>
                        <X size={12} strokeWidth={1.5} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="shortcuts">
            <div className="shortcut"><span>{t('home.shortcuts.openFile')}</span> <kbd>Ctrl+P</kbd></div>
            <div className="shortcut"><span>{t('home.shortcuts.splitView')}</span> <kbd>{t('home.shortcuts.splitViewKey')}</kbd></div>
            <div className="shortcut"><span>{t('home.shortcuts.switchTab')}</span> <kbd>Ctrl+Tab</kbd></div>
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
              <button className="editor-split__toolbar-btn" onClick={() => dispatch(equalizeGroupRatios())} title={t('home.split.equalizeWidths')}>
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
