import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createSelector } from '@reduxjs/toolkit';
import { FolderOpen, Search, Clock, X, Folder } from 'lucide-react';
import { useAppSelector, useAppDispatch } from '../store/hooks';
import type { OpenedFile, EditorSnapshot } from '../store/slices/workspaceSlice';
import {
  loadDirectory,
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
  setSplitRatio,
} from '../store/slices/workspaceSlice';
import { openDirectory } from '../services/fileService';
import TabBar from '../components/TabBar';
import MonacoEditor from '../components/MonacoEditor';
import QuickOpen from '../components/QuickOpen';
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

interface CoocMatrix {
  [fileA: string]: { [fileB: string]: number };
}

function loadCooc(): CoocMatrix {
  try {
    const raw = localStorage.getItem(COOC_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveCooc(m: CoocMatrix) {
  try { localStorage.setItem(COOC_KEY, JSON.stringify(m)); } catch { /* 忽略 */ }
}

function recordCooccurrence(fileA: string, fileB: string) {
  if (!fileA || !fileB || fileA === fileB) return;
  const m = loadCooc();
  // Decay all
  for (const key of Object.keys(m)) {
    for (const k2 of Object.keys(m[key])) {
      m[key][k2] *= COOC_DECAY;
      if (m[key][k2] < 0.01) delete m[key][k2];
    }
    if (Object.keys(m[key]).length === 0) delete m[key];
  }
  // Boost current pair
  if (!m[fileA]) m[fileA] = {};
  if (!m[fileB]) m[fileB] = {};
  m[fileA][fileB] = (m[fileA][fileB] || 0) + 0.15;
  m[fileB][fileA] = (m[fileB][fileA] || 0) + 0.15;
  saveCooc(m);
}

function getCoocSuggestions(fileId: string, topK = 3): { name: string; score: number }[] {
  const m = loadCooc();
  const scores = m[fileId] || {};
  return Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([name, score]) => ({ name, score }));
}

/* ─── Redux Selectors ─── */

const selectOpenedFiles = (state: { workspace: { openedFiles: OpenedFile[] } }) => state.workspace.openedFiles;

const selectOpenedFileMap = createSelector(
  [selectOpenedFiles],
  (files) => new Map(files.map((f) => [f.id, f]))
);

const selectTabs = (fileIds: string[]) =>
  createSelector(
    [selectOpenedFileMap],
    (map) => fileIds.map((id) => map.get(id)!).filter(Boolean) as OpenedFile[]
  );

/* ─── 编辑器状态缓存 Hook ─── */

function useEditorSnapshot(fileId: string | null, groupIndex: number) {
  const dispatch = useAppDispatch();
  const snapshotKey = `${fileId ?? ''}::${groupIndex}`;
  const snapshot = useAppSelector(
    (state) => state.workspace.editorSnapshots[snapshotKey] as EditorSnapshot | undefined
  );

  const saveSnapshot = useCallback(
    (snap: EditorSnapshot) => {
      if (fileId) {
        dispatch(saveEditorSnapshot({ fileId, groupIndex, snapshot: snap }));
      }
    },
    [dispatch, fileId, groupIndex]
  );

  return { snapshot, saveSnapshot };
}

/* ─── 主组件 ─── */

function Home() {
  const dispatch = useAppDispatch();
  const {
    openedFiles, activeFileId, recentProjects,
    leftFileIds, rightFileIds, rightActiveFileId, activeGroupIndex,
    splitRatio, allFilePaths, mirrorContent, splitPhase,
  } = useAppSelector((state) => state.workspace);
  const splitView = rightFileIds.length > 0;

  const [quickOpenVisible, setQuickOpenVisible] = useState(false);

  const selectLeftTabs = useMemo(() => selectTabs(leftFileIds), [leftFileIds]);
  const selectRightTabs = useMemo(() => selectTabs(rightFileIds), [rightFileIds]);
  const leftTabs = useAppSelector(selectLeftTabs);
  const rightTabs = useAppSelector(selectRightTabs);

  useEffect(() => {
    dispatch(fetchRecentProjects());
  }, [dispatch]);

  // Ctrl+S / Ctrl+Tab 键盘处理
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        const targetId = activeGroupIndex === 0 ? activeFileId : rightActiveFileId;
        if (targetId) {
          dispatch(saveFile({ id: targetId, groupIndex: activeGroupIndex }));
        }
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'Tab') {
        e.preventDefault();
        dispatch(navigateTabHistory('backward'));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [dispatch, activeFileId, rightActiveFileId, activeGroupIndex]);

  // 分屏开启时记录协同关系
  const prevLeftActiveRef = useRef(activeFileId);
  const prevRightActiveRef = useRef(rightActiveFileId);
  useEffect(() => {
    if (splitView && rightActiveFileId) {
      const leftFile = activeFileId || prevLeftActiveRef.current;
      if (leftFile) {
        recordCooccurrence(openedFiles.find((f) => f.id === leftFile)?.name || leftFile,
          openedFiles.find((f) => f.id === rightActiveFileId)?.name || rightActiveFileId);
      }
    }
    prevLeftActiveRef.current = activeFileId;
    prevRightActiveRef.current = rightActiveFileId;
  }, [activeFileId, rightActiveFileId, splitView, openedFiles]);

  const handleOpenFolder = async () => {
    const dir = await openDirectory();
    if (dir) {
      dispatch(loadDirectory({ source: dir.source, name: dir.name }));
    }
  };

  const handleOpenRecent = useCallback(
    (projectPath: string, name: string) => {
      dispatch(loadDirectory({ source: projectPath, name }));
    },
    [dispatch]
  );

  const handleRemoveRecent = useCallback(
    (e: React.MouseEvent, projectPath: string) => {
      e.stopPropagation();
      dispatch(removeRecentProjectThunk(projectPath));
    },
    [dispatch]
  );

  const handleOpenQuickOpen = useCallback(() => {
    setQuickOpenVisible(true);
  }, []);

  const activeFile = useMemo(
    () => openedFiles.find((f) => f.id === activeFileId),
    [openedFiles, activeFileId]
  );

  const splitActiveFile = useMemo(
    () => openedFiles.find((f) => f.id === rightActiveFileId),
    [openedFiles, rightActiveFileId]
  );

  /** 获取面板的编辑内容（处理同文件镜像） */
  const getPanelContent = useCallback(
    (fileId: string | null, groupIndex: number): string | undefined => {
      if (!fileId) return undefined;
      const mirrorKey = `${fileId}::${groupIndex}`;
      if (mirrorContent[mirrorKey] !== undefined) {
        return mirrorContent[mirrorKey];
      }
      const file = openedFiles.find((f) => f.id === fileId);
      return file?.content;
    },
    [openedFiles, mirrorContent]
  );

  /** 发送编辑变更（处理同文件镜像） */
  const handleEditorChange = useCallback(
    (fileId: string | null, groupIndex: number) => (value: string) => {
      if (!fileId) return;
      const isMirrored = leftFileIds.includes(fileId) && rightFileIds.includes(fileId);
      if (isMirrored) {
        dispatch(setMirrorFileContent({ fileId, groupIndex, content: value }));
      } else {
        dispatch(setFileContent({ id: fileId, content: value }));
      }
    },
    [dispatch, leftFileIds, rightFileIds]
  );

  const handleCloseTab = useCallback(
    (id: string, groupIndex: number) => {
      const file = openedFiles.find((f) => f.id === id);
      if (file?.isDirty) {
        const choice = window.confirm('文件有未保存的更改，确定要关闭吗？');
        if (!choice) return;
      }
      dispatch(closeFile({ id, groupIndex }));
    },
    [dispatch, openedFiles]
  );

  // ─── 协同推荐 ───

  const suggestions = useMemo(() => {
    if (!splitView || !activeFileId) return [];
    const file = openedFiles.find((f) => f.id === activeFileId);
    if (!file) return [];
    const candidates = getCoocSuggestions(file.name, 3);
    return candidates.filter(
      (c) => !leftFileIds.includes(c.name) && !rightFileIds.includes(c.name)
    );
  }, [splitView, activeFileId, openedFiles, leftFileIds, rightFileIds]);

  const suggestionsRef = useRef(suggestions);
  suggestionsRef.current = suggestions;

  // ─── 拖拽调整面板比例 ───

  const splitRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [localRatio, setLocalRatio] = useState(splitRatio);

  useEffect(() => {
    setLocalRatio(splitRatio);
  }, [splitRatio]);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!splitRef.current) return;
      const rect = splitRef.current.getBoundingClientRect();
      const leftWidth = e.clientX - rect.left;
      const rightWidth = rect.width - leftWidth;
      if (leftWidth > 100 && rightWidth > 100) {
        const ratio = leftWidth / rightWidth;
        setLocalRatio(Math.max(0.5, Math.min(4.0, ratio)));
        dispatch(setSplitRatio(ratio));
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, dispatch]);

  // ─── 编辑器状态缓存 ───

  const leftSnapshot = useEditorSnapshot(activeFileId, 0);
  const rightSnapshot = useEditorSnapshot(rightActiveFileId, 1);

  // ─── 渲染编辑器面板 ───

  const renderEditorPanel = useCallback(
    (
      options: {
        groupIndex: number;
        tabs: OpenedFile[];
        activeId: string | null;
        file: OpenedFile | undefined;
        focused: boolean;
        snapshot: EditorSnapshot | undefined;
        saveSnapshot: (s: EditorSnapshot) => void;
      }
    ) => {
      const { groupIndex, tabs, activeId, file, focused, snapshot, saveSnapshot } = options;
      const panelContent = getPanelContent(activeId, groupIndex);
      return (
        <>
          <TabBar
            tabs={tabs.map((f) => ({
              id: f.id,
              name: f.name,
              isDirty: f.isDirty,
              isPreview: f.isPreview,
            }))}
            activeId={activeId}
            onActivate={(id) => dispatch(activateFile(id))}
            onClose={(id) => handleCloseTab(id, groupIndex)}
            onPin={() => dispatch(pinPreviewFile())}
            onSplitView={() => dispatch(toggleSplitView())}
            splitActive={splitView}
            focused={focused}
          />
          <div className="editor-area">
            {file ? (
              <MonacoEditor
                key={`${file.id}-g${groupIndex}`}
                value={panelContent ?? file.content}
                language={file.language}
                onChange={handleEditorChange(activeId, groupIndex)}
                snapshot={snapshot}
                onSnapshot={saveSnapshot}
                focused={focused}
              />
            ) : (
              <div className="no-active-file">
                <button
                  className="open-folder-btn secondary"
                  onClick={handleOpenQuickOpen}
                >
                  <Search size={16} strokeWidth={1.5} />
                  快速打开文件 (Ctrl+P)
                </button>
              </div>
            )}
            {/* Hebbian 协同推荐提示 */}
            {focused && suggestionsRef.current.length > 0 && groupIndex === 0 && (
              <div className="cooc-suggestions">
                <span className="cooc-suggestions__label">推荐侧边打开:</span>
                {suggestionsRef.current.map((s) => (
                  <button
                    key={s.name}
                    className="cooc-suggestions__btn"
                    onClick={() => {
                      const existing = openedFiles.find((f) => f.name === s.name);
                      if (existing) {
                        dispatch(setActiveGroup(1));
                        dispatch(activateFile(existing.id));
                      }
                    }}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      );
    },
    [dispatch, handleCloseTab, handleEditorChange, handleOpenQuickOpen, splitView, getPanelContent, openedFiles]
  );

  return (
    <div className="home-page">
      {quickOpenVisible && (
        <QuickOpen
          onClose={() => setQuickOpenVisible(false)}
          files={allFilePaths}
        />
      )}

      {leftFileIds.length === 0 && rightFileIds.length === 0 ? (
        <div className="welcome-screen">
          <h2>欢迎使用 IDEACODE</h2>
          <p>基于 Monaco Editor 的轻量级 IDE</p>

          <div className="welcome-actions">
            <button className="open-folder-btn" onClick={handleOpenFolder}>
              <FolderOpen size={16} strokeWidth={1.5} />
              打开文件夹
            </button>
            <button
              className="open-folder-btn secondary"
              onClick={handleOpenQuickOpen}
            >
              <Search size={16} strokeWidth={1.5} />
              快速打开文件 (Ctrl+P)
            </button>
          </div>

          {recentProjects.length > 0 && (
            <div className="recent-projects">
              <div className="recent-projects__header">
                <Clock size={14} strokeWidth={1.5} />
                <span>最近打开的项目</span>
              </div>
              <div className="recent-projects__list">
                {recentProjects.map((project) => (
                  <div
                    key={project.path}
                    className="recent-project-item"
                    onClick={() => handleOpenRecent(project.path, project.name)}
                    title={project.path}
                  >
                    <span className="recent-project-item__icon">
                      <Folder size={16} strokeWidth={1.5} />
                    </span>
                    <div className="recent-project-item__info">
                      <span className="recent-project-item__name">{project.name}</span>
                      <span className="recent-project-item__path">{project.path}</span>
                    </div>
                    <div className="recent-project-item__meta">
                      <span className="recent-project-item__time">{formatTime(project.timestamp)}</span>
                      <button
                        className="recent-project-item__remove"
                        onClick={(e) => handleRemoveRecent(e, project.path)}
                        title="从历史记录中移除"
                      >
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
            <div className="shortcut"><span>命令面板</span> <kbd>Ctrl+Shift+P</kbd></div>
            <div className="shortcut"><span>分屏编辑</span> <kbd>点击 Columns 图标</kbd></div>
            <div className="shortcut"><span>切换 Tab (MRU)</span> <kbd>Ctrl+Tab</kbd></div>
          </div>
        </div>
      ) : (
        <div className="editor-workspace">
          {splitView ? (
            <div
              ref={splitRef}
              className={`editor-split ${isDragging ? 'editor-split--dragging' : ''} ${splitPhase === 'opening' ? 'editor-split--opening' : ''}`}
            >
              <div
                className={`editor-split__panel ${activeGroupIndex !== 0 ? 'editor-split__panel--dimmed' : ''}`}
                style={{ flex: localRatio }}
                onClick={() => dispatch(setActiveGroup(0))}
              >
                {renderEditorPanel({
                  groupIndex: 0,
                  tabs: leftTabs,
                  activeId: activeFileId,
                  file: activeFile,
                  focused: activeGroupIndex === 0,
                  snapshot: leftSnapshot.snapshot,
                  saveSnapshot: leftSnapshot.saveSnapshot,
                })}
              </div>
              <div
                className="editor-split__divider"
                onMouseDown={handleDragStart}
              />
              <div
                className={`editor-split__panel ${activeGroupIndex !== 1 ? 'editor-split__panel--dimmed' : ''}`}
                style={{ flex: 1 }}
                onClick={() => dispatch(setActiveGroup(1))}
              >
                {renderEditorPanel({
                  groupIndex: 1,
                  tabs: rightTabs,
                  activeId: rightActiveFileId,
                  file: splitActiveFile,
                  focused: activeGroupIndex === 1,
                  snapshot: rightSnapshot.snapshot,
                  saveSnapshot: rightSnapshot.saveSnapshot,
                })}
              </div>
            </div>
          ) : (
            renderEditorPanel({
              groupIndex: 0,
              tabs: leftTabs,
              activeId: activeFileId,
              file: activeFile,
              focused: activeGroupIndex === 0,
              snapshot: leftSnapshot.snapshot,
              saveSnapshot: leftSnapshot.saveSnapshot,
            })
          )}
        </div>
      )}
    </div>
  );
}

export default Home;
