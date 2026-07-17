/**
 * §Commit 详情面板（时间线点击 commit 后展示）
 *
 * 在编辑区域以 tab 形式展示某个 commit 的文件列表：
 *   - 顶部：commit 元信息（hash、subject、作者、时间）
 *   - 列表：每行显示文件名、状态、修改者、修改时间、+additions -deletions
 *   - 点击文件行：创建 diff 对比 tab + 在资源管理器中定位文件
 */

import { memo, useCallback } from 'react';
import { useAppDispatch } from '../../store/hooks';
import { openDiffView, expandToFile, type CommitDetailData } from '../../store/slices/workspaceSlice';
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
}

function CommitDetailPanel({ data }: CommitDetailPanelProps) {
  const dispatch = useAppDispatch();

  const totalAdditions = data.files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = data.files.reduce((sum, f) => sum + f.deletions, 0);

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
        <div className="commit-detail__file-list-header">
          <span className="commit-detail__col-status">状态</span>
          <span className="commit-detail__col-name">文件</span>
          <span className="commit-detail__col-author">修改者</span>
          <span className="commit-detail__col-time">修改时间</span>
          <span className="commit-detail__col-diff">变更</span>
        </div>
        {data.files.map((file, idx) => {
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
        })}
      </div>
    </div>
  );
}

export default memo(CommitDetailPanel);
