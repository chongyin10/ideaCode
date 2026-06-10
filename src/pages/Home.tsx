import { useState, useEffect, useCallback, useMemo } from 'react';
import { FolderOpen, Search, Clock, X, Folder } from 'lucide-react';
import { useAppSelector, useAppDispatch } from '../store/hooks';
import {
  loadDirectory,
  closeFile,
  activateFile,
  setFileContent,
  saveFile,
  fetchRecentProjects,
  removeRecentProjectThunk,
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

function Home() {
  const dispatch = useAppDispatch();
  const { openedFiles, activeFileId, recentProjects } = useAppSelector(
    (state) => state.workspace
  );
  const [quickOpenVisible, setQuickOpenVisible] = useState(false);

  useEffect(() => {
    dispatch(fetchRecentProjects());
  }, [dispatch]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (activeFileId) {
          dispatch(saveFile(activeFileId));
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [dispatch, activeFileId]);

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

  const handleEditorChange = useCallback(
    (value: string) => {
      if (activeFileId) {
        dispatch(setFileContent({ id: activeFileId, content: value }));
      }
    },
    [dispatch, activeFileId]
  );

  return (
    <div className="home-page">
      {quickOpenVisible && <QuickOpen onClose={() => setQuickOpenVisible(false)} />}

      {openedFiles.length === 0 ? (
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

          {/* 最近打开的项目 */}
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
                      <span className="recent-project-item__name">
                        {project.name}
                      </span>
                      <span className="recent-project-item__path">
                        {project.path}
                      </span>
                    </div>
                    <div className="recent-project-item__meta">
                      <span className="recent-project-item__time">
                        {formatTime(project.timestamp)}
                      </span>
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
            <div className="shortcut">
              <span>快速打开文件</span> <kbd>Ctrl+P</kbd>
            </div>
            <div className="shortcut">
              <span>命令面板</span> <kbd>Ctrl+Shift+P</kbd>
            </div>
          </div>
        </div>
      ) : (
        <div className="editor-workspace">
          <TabBar
            tabs={openedFiles.map((f) => ({ id: f.id, name: f.name, isDirty: f.isDirty }))}
            activeId={activeFileId}
            onActivate={(id) => dispatch(activateFile(id))}
            onClose={(id) => dispatch(closeFile(id))}
          />
          <div className="editor-area">
            {activeFile ? (
              <MonacoEditor
                key={activeFile.id}
                value={activeFile.content}
                language={activeFile.language}
                onChange={handleEditorChange}
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
          </div>
        </div>
      )}
    </div>
  );
}

export default Home;
