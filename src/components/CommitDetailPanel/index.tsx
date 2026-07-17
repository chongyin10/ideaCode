/**
 * §Commit 详情面板（时间线点击 commit 后展示）
 *
 * 在编辑区域以 tab 形式展示某个 commit 的文件列表：
 *   - 顶部：commit 元信息（hash、subject、作者、时间）
 *   - 列表：每行显示文件名、状态、修改者、修改时间、+additions -deletions
 *   - 点击文件行：创建 diff 对比 tab + 在资源管理器中定位文件
 */

import { memo, useCallback, useMemo } from 'react';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { openDiffView, expandToFile, setCommitDetailSearch, type CommitDetailData } from '../../store/slices/workspaceSlice';
import { getLanguageFromPath } from '../../utils/languageFromPath';
import './CommitDetailPanel.css';

/** §相对时间格式化（与 ExplorerContent 一致） */
function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (seconds < 60) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (hours < 24) return `${hours} 小时前`;
  if (days < 7) return `${days} 天前`;
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

/** §绝对时间格式化 */
function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** §文件状态配置：图标 + 颜色 + 标签 */
const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  added: { label: 'A', color: '#73c991', bg: 'rgba(115, 201, 145, 0.15)' },
  modified: { label: 'M', color: '#e2c08d', bg: 'rgba(226, 192, 141, 0.15)' },
  deleted: { label: 'D', color: '#f48771', bg: 'rgba(244, 135, 113, 0.15)' },
  renamed: { label: 'R', color: '#69a4ff', bg: 'rgba(105, 164, 255, 0.15)' },
};

interface CommitDetailPanelProps {
  data: CommitDetailData;
  /** §当前 tab 的 fileId，用于持久化搜索值到 store（切换 tab 不丢失） */
  fileId: string;
}

function CommitDetailPanel({ data, fileId }: CommitDetailPanelProps) {
  const dispatch = useAppDispatch();
  // §搜索值持久化到 store（OpenedFile.commitDetailSearchQuery），切换 tab 回来后不丢失
  const searchQuery = useAppSelector(
    (state) => {
      const f = state.workspace.openedFiles.find((of) => of.id === fileId);
      return f?.commitDetailSearchQuery ?? '';
    },
  );
  const setSearchQuery = useCallback(
    (q: string) => dispatch(setCommitDetailSearch({ fileId, query: q })),
    [dispatch, fileId],
  );

  const totalAdditions = data.files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = data.files.reduce((sum, f) => sum + f.deletions, 0);

  // §过滤后的文件列表
  const filteredFiles = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return data.files;
    return data.files.filter(
      (f) => f.path.toLowerCase().includes(q) || f.fileName.toLowerCase().includes(q),
    );
  }, [data.files, searchQuery]);

  // §点击文件行：获取该 commit 中该文件的新旧内容，创建 diff tab，
  //   同时在 IDE 资源管理器结构树中展开到该文件所在目录（不打开文件本身）
  const handleFileClick = useCallback(async (filePath: string, fileName: string) => {
    // 1. 获取 diff 内容（异步并行）
    const diffPromise = (async () => {
      try {
        const api = window.electronAPI;
        if (!api?.extension?.rpc) return null;
        const res = (await api.extension.rpc('ext.invoke', {
          extId: 'ideacode-git',
          method: 'getCommitFileDiff',
          args: [{ hash: data.hash, filePath }],
        })) as { success?: boolean; result?: { original: string; modified: string } | null } | undefined;

        if (res?.success && res.result) {
          return res.result;
        }
      } catch (e) {
        console.error('[CommitDetail] 获取文件 diff 失败:', e);
      }
      return null;
    })();

    // 2. 在资源管理器结构树中展开定位到该文件（filePath 为相对项目根的路径）
    //    expandToFile 会自动展开所有父目录，文件本身会通过 FileTree 的 expandPaths 逻辑高亮
    dispatch(expandToFile(filePath));

    // 3. 等待 diff 内容后创建 diff tab
    const diff = await diffPromise;
    if (diff) {
      dispatch(openDiffView({
        filePath,
        fileName,
        original: diff.original,
        modified: diff.modified,
        language: getLanguageFromPath(fileName),
      }));
    }
  }, [data.hash, dispatch]);

  return (
    <div className="commit-detail-panel">
      {/* ─── commit 元信息 ─── */}
      <div className="commit-detail__header">
        <div className="commit-detail__header-top">
          <span className="commit-detail__hash">{data.shortHash}</span>
          <span className="commit-detail__subject">{data.subject}</span>
        </div>
        <div className="commit-detail__header-meta">
          <span className="commit-detail__author">{data.authorName}</span>
          <span className="commit-detail__sep">·</span>
          <span className="commit-detail__time" title={formatDateTime(data.timestamp)}>
            {formatRelativeTime(data.timestamp)}
          </span>
          <span className="commit-detail__sep">·</span>
          <span className="commit-detail__stats">
            <span className="commit-detail__additions">+{totalAdditions}</span>{' '}
            <span className="commit-detail__deletions">-{totalDeletions}</span>
          </span>
        </div>
      </div>

      {/* ─── 文件列表 ─── */}
      <div className="commit-detail__file-list">
        {/* §搜索框：sticky 跟随滚动，输入值实时过滤文件列表 */}
        <div className="commit-detail__search">
          <svg className="commit-detail__search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            className="commit-detail__search-input"
            placeholder="筛选文件（支持文件名或路径）"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            spellCheck={false}
          />
          {searchQuery && (
            <button
              className="commit-detail__search-clear"
              title="清除"
              onClick={() => setSearchQuery('')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
          <span className="commit-detail__search-count">
            {searchQuery ? `${filteredFiles.length}/${data.files.length}` : `${data.files.length}`}
          </span>
        </div>
        <div className="commit-detail__file-list-header">
          <span className="commit-detail__col-status">状态</span>
          <span className="commit-detail__col-name">文件</span>
          <span className="commit-detail__col-author">修改者</span>
          <span className="commit-detail__col-time">修改时间</span>
          <span className="commit-detail__col-diff">变更</span>
        </div>
        {filteredFiles.length === 0 ? (
          <div className="commit-detail__empty">
            {searchQuery ? `没有匹配 "${searchQuery}" 的文件` : '该 commit 没有文件变更'}
          </div>
        ) : (
          filteredFiles.map((file, idx) => {
          const cfg = STATUS_CONFIG[file.status] || STATUS_CONFIG.modified;
          return (
            <div
              key={`${file.path}-${idx}`}
              className="commit-detail__file-item"
              style={{ cursor: 'pointer' }}
              title={file.path}
              onClick={() => handleFileClick(file.path, file.fileName)}
            >
              <span className="commit-detail__col-status">
                <span
                  className="commit-detail__status-badge"
                  style={{ color: cfg.color, backgroundColor: cfg.bg }}
                >
                  {cfg.label}
                </span>
              </span>
              <span className="commit-detail__col-name">
                <span className="commit-detail__file-name">{file.fileName}</span>
                <span className="commit-detail__file-path">{file.path}</span>
              </span>
              <span className="commit-detail__col-author">{data.authorName}</span>
              <span className="commit-detail__col-time" title={formatDateTime(data.timestamp)}>
                {formatRelativeTime(data.timestamp)}
              </span>
              <span className="commit-detail__col-diff">
                <span className="commit-detail__additions">+{file.additions}</span>{' '}
                <span className="commit-detail__deletions">-{file.deletions}</span>
              </span>
            </div>
          );
          })
        )}
      </div>
    </div>
  );
}

export default memo(CommitDetailPanel);
