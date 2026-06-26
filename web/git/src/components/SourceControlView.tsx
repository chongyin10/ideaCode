import { useEffect, useState } from 'react';
import {
  GitBranch,
  GitPullRequest,
  RefreshCw,
  Download,
  FolderOpen,
  GitMerge,
} from 'lucide-react';
import { useGitStore } from '../store/gitStore';
import { sendRpc } from '../api';
import type { GitChange } from '../types';
import RepositoryHeader from './RepositoryHeader';
import CommitBox from './CommitBox';
import ChangesSection from './ChangesSection';
import EmptyState from './EmptyState';
import InitState from './InitState';
import GitUnavailableState from './GitUnavailableState';

export default function SourceControlView() {
  const rootPath = useGitStore((s) => s.rootPath);
  const isRepo = useGitStore((s) => s.isRepo);
  const gitAvailable = useGitStore((s) => s.gitAvailable);
  const status = useGitStore((s) => s.status);
  const lastError = useGitStore((s) => s.lastError);
  const activeFile = useGitStore((s) => s.activeFile);

  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // 错误显示 5 秒后自动清除
  useEffect(() => {
    if (actionError) {
      const t = setTimeout(() => setActionError(null), 5000);
      return () => clearTimeout(t);
    }
  }, [actionError]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await sendRpc('refresh');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };

  const handleOpenRepo = async () => {
    setBusy(true);
    try {
      await sendRpc('openRepositoryDialog');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleStage = async (paths: string[]) => {
    setBusy(true);
    try {
      await sendRpc('stage', { paths });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleUnstage = async (paths: string[]) => {
    setBusy(true);
    try {
      await sendRpc('unstage', { paths });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleStageAll = async () => {
    setBusy(true);
    try {
      await sendRpc('stageAll');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleUnstageAll = async () => {
    setBusy(true);
    try {
      await sendRpc('unstageAll');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDiscard = async (paths: string[]) => {
    if (!window.confirm(`确定要放弃 ${paths.length} 个文件的本地修改吗？`)) return;
    setBusy(true);
    try {
      await sendRpc('discard', { paths });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDiscardAllChanges = async () => {
    if (!status) return;
    if (!window.confirm(`确定要放弃全部 ${status.changes.length} 个工作区修改吗？`)) return;
    setBusy(true);
    try {
      await sendRpc('discardAll');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteUntracked = async (paths: string[]) => {
    if (!window.confirm(`确定要删除 ${paths.length} 个未跟踪的文件吗？`)) return;
    setBusy(true);
    try {
      await sendRpc('deleteUntracked', { paths });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleCommit = async (message: string, opts: { amend?: boolean; noVerify?: boolean }) => {
    if (!message.trim()) return;
    setBusy(true);
    try {
      await sendRpc('commit', { message, ...opts });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handlePush = async () => {
    setBusy(true);
    try {
      await sendRpc('push');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handlePull = async () => {
    setBusy(true);
    try {
      await sendRpc('pull');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleFetch = async () => {
    setBusy(true);
    try {
      await sendRpc('fetch');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleCheckout = async (name: string) => {
    setBusy(true);
    try {
      await sendRpc('checkoutBranch', { name });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleCreateBranch = async (name: string) => {
    setBusy(true);
    try {
      await sendRpc('createBranch', { name });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleInit = async () => {
    setBusy(true);
    try {
      await sendRpc('initRepository');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleOpenFile = (path: string, staged = false) => {
    sendRpc('openFile', { path, staged }).catch((e) =>
      setActionError(e instanceof Error ? e.message : String(e))
    );
  };

  /* ─── 渲染逻辑 ─── */

  if (!gitAvailable) {
    return <GitUnavailableState />;
  }

  if (!rootPath) {
    return (
      <EmptyState
        icon={<Download size={36} strokeWidth={1} />}
        title="Source Control"
        description="打开一个 Git 仓库或克隆远程仓库开始使用"
        primaryAction={{ label: '打开文件夹', icon: <FolderOpen size={14} />, onClick: handleOpenRepo }}
      />
    );
  }

  if (!isRepo) {
    return <InitState rootPath={rootPath} onInit={handleInit} onOpenRepo={handleOpenRepo} busy={busy} />;
  }

  if (!status) {
    return (
      <div className="git-sc__loading">
        <RefreshCw size={20} className="git-spin" />
        <span>加载仓库状态…</span>
      </div>
    );
  }

  return (
    <div className="git-sc">
      <RepositoryHeader status={status} rootPath={rootPath} onCheckout={handleCheckout} onCreateBranch={handleCreateBranch} />

      {(actionError || lastError) && (
        <div className="git-sc__error" onClick={() => { setActionError(null); }}>
          {actionError || lastError}
        </div>
      )}

      <div className="git-sc__toolbar">
        <button className="git-btn" onClick={handleRefresh} disabled={refreshing} title="刷新">
          <RefreshCw size={14} className={refreshing ? 'git-spin' : ''} />
        </button>
        <button className="git-btn" onClick={handlePull} title="拉取">
          <GitPullRequest size={14} />
        </button>
        <button className="git-btn" onClick={handlePush} title="推送">
          <GitBranch size={14} />
        </button>
        <button className="git-btn" onClick={handleFetch} title="获取">
          <GitMerge size={14} />
        </button>
      </div>

      <CommitBox onCommit={handleCommit} disabled={busy || status.staged.length === 0} />

      <ChangesSection
        title="已暂存的更改"
        badge={status.staged.length}
        items={status.staged}
        kind="staged"
        collapsible
        defaultOpen
        emptyText="没有已暂存的更改"
        activeFile={activeFile}
        actions={[
          { label: '全部取消暂存', handler: handleUnstageAll, disabled: status.staged.length === 0 },
        ]}
        onUnstage={(p) => handleUnstage(p)}
        onDiscard={(p) => handleDiscard(p)}
        onOpen={(p) => handleOpenFile(p, true)}
      />

      <ChangesSection
        title="更改"
        badge={status.changes.length}
        items={status.changes}
        kind="changes"
        collapsible
        defaultOpen
        emptyText="工作区干净"
        activeFile={activeFile}
        actions={[
          { label: '全部暂存', handler: handleStageAll, disabled: status.changes.length === 0 },
          { label: '全部放弃', handler: handleDiscardAllChanges, disabled: status.changes.length === 0 },
        ]}
        onStage={(p) => handleStage(p)}
        onDiscard={(p) => handleDiscard(p)}
        onOpen={(p) => handleOpenFile(p, false)}
      />

      {status.merge.length > 0 && (
        <ChangesSection
          title="合并冲突"
          badge={status.merge.length}
          items={status.merge}
          kind="merge"
          collapsible
          defaultOpen
          emptyText="无合并冲突"
          activeFile={activeFile}
          onOpen={(p) => handleOpenFile(p)}
        />
      )}

      {status.untracked.length > 0 && (
        <ChangesSection
          title="未跟踪的文件"
          badge={status.untracked.length}
          items={status.untracked}
          kind="untracked"
          collapsible
          defaultOpen={false}
          emptyText="没有未跟踪的文件"
          actions={[
            { label: '全部暂存', handler: handleStageAll, disabled: status.untracked.length === 0 },
            {
              label: '全部删除',
              handler: () => handleDeleteUntracked(status.untracked.map((c: GitChange) => c.path)),
              disabled: status.untracked.length === 0,
            },
          ]}
          onStage={(p) => handleStage(p)}
          onDelete={(p) => handleDeleteUntracked(p)}
          onOpen={(p) => handleOpenFile(p)}
        />
      )}


    </div>
  );
}