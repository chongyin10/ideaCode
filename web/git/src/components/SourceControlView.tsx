import { useEffect, useRef, useState } from 'react';
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
import type { GitChange, GitRemote } from '../types';
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
  const loading = useGitStore((s) => s.loading);

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

  /* ─── 远程仓库检测：无 remote 时屏蔽批量操作（避免未关联远程就 stage 产生暂存） ─── */
  const [remotes, setRemotes] = useState<GitRemote[]>([]);
  const prevBusyRef = useRef(false);

  const loadRemotes = async () => {
    try {
      const res = (await sendRpc('getRemotes')) as { success?: boolean; remotes?: GitRemote[] } | undefined;
      if (res && Array.isArray(res.remotes)) {
        setRemotes(res.remotes);
      }
    } catch {
      // 忽略：remotes 检测失败不影响主流程
    }
  };

  // isRepo 变化（初始化仓库/关联远程后）及挂载时获取 remotes
  useEffect(() => {
    if (isRepo) {
      loadRemotes();
    } else {
      setRemotes([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRepo]);

  // busy 结束（操作完成，尤其 associateRemote 后）刷新 remotes
  useEffect(() => {
    if (prevBusyRef.current && !busy) {
      loadRemotes();
    }
    prevBusyRef.current = busy;
  }, [busy]);

  const hasRemote = remotes.length > 0;
  // 未关联远程时屏蔽所有批量/单文件改动操作，避免产生暂存或数据变更
  const actionsDisabled = !hasRemote;

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

  const handleStage = async (paths: string[], repoPath?: string) => {
    setBusy(true);
    try {
      await sendRpc('stage', { paths, repoPath });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleUnstage = async (paths: string[], repoPath?: string) => {
    setBusy(true);
    try {
      await sendRpc('unstage', { paths, repoPath });
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

  const handleDiscard = async (paths: string[], repoPath?: string) => {
    if (!window.confirm(`确定要放弃 ${paths.length} 个文件的本地修改吗？`)) return;
    setBusy(true);
    try {
      await sendRpc('discard', { paths, repoPath });
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

  const handleDeleteUntracked = async (paths: string[], repoPath?: string) => {
    if (!window.confirm(`确定要删除 ${paths.length} 个未跟踪的文件吗？`)) return;
    setBusy(true);
    try {
      await sendRpc('deleteUntracked', { paths, repoPath });
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

  const handleAssociateRemote = async (url: string) => {
    setBusy(true);
    try {
      await sendRpc('associateRemote', { url });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleOpenFile = (path: string, staged = false, repoPath?: string) => {
    sendRpc('openFile', { path, staged, repoPath }).catch((e) =>
      setActionError(e instanceof Error ? e.message : String(e))
    );
  };

  /* ─── 渲染逻辑 ─── */

  if (!gitAvailable) {
    return <GitUnavailableState />;
  }

  // 仓库正在加载（用户刚打开文件夹，git 扩展正在初始化仓库）
  if (loading) {
    return (
      <div className="git-sc__loading">
        <RefreshCw size={20} className="git-spin" />
        <span>正在加载源代码管理…</span>
      </div>
    );
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
    return <InitState rootPath={rootPath} onInit={handleInit} onOpenRepo={handleOpenRepo} onAssociateRemote={handleAssociateRemote} busy={busy} />;
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
      <RepositoryHeader status={status} rootPath={rootPath} onCheckout={handleCheckout} onCreateBranch={handleCreateBranch} onAssociateRemote={handleAssociateRemote} remotes={remotes} busy={busy} />

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
        actionsDisabled={actionsDisabled}
        collapsible
        defaultOpen
        emptyText="没有已暂存的更改"
        activeFile={activeFile}
        actions={[
          { label: '全部取消暂存', handler: handleUnstageAll, disabled: status.staged.length === 0 },
        ]}
        onUnstage={(p, rp) => handleUnstage(p, rp)}
        onDiscard={(p, rp) => handleDiscard(p, rp)}
        onOpen={(p, rp) => handleOpenFile(p, true, rp)}
      />

      <ChangesSection
        title="更改"
        badge={status.changes.length}
        items={status.changes}
        kind="changes"
        actionsDisabled={actionsDisabled}
        collapsible
        defaultOpen
        emptyText="工作区干净"
        activeFile={activeFile}
        actions={[
          { label: '全部暂存', handler: handleStageAll, disabled: status.changes.length === 0 },
          { label: '全部放弃', handler: handleDiscardAllChanges, disabled: status.changes.length === 0 },
        ]}
        onStage={(p, rp) => handleStage(p, rp)}
        onDiscard={(p, rp) => handleDiscard(p, rp)}
        onOpen={(p, rp) => handleOpenFile(p, false, rp)}
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
          onOpen={(p, rp) => handleOpenFile(p, false, rp)}
        />
      )}

      {status.untracked.length > 0 && (
        <ChangesSection
          title="未跟踪的文件"
          badge={status.untracked.length}
          items={status.untracked}
          kind="untracked"
          actionsDisabled={actionsDisabled}
          collapsible
          defaultOpen
          emptyText="没有未跟踪的文件"
          actions={[
            { label: '全部暂存', handler: handleStageAll, disabled: status.untracked.length === 0 },
            {
              label: '全部删除',
              // §子模块场景下未跟踪文件分属不同仓库，需按 repoPath 分组逐个仓库删除
              handler: async () => {
                if (!window.confirm(`确定要删除全部 ${status.untracked.length} 个未跟踪的文件吗？`)) return;
                setBusy(true);
                try {
                  const byRepo = new Map<string, string[]>();
                  for (const c of status.untracked) {
                    const rp = c.repoPath || '';
                    if (!byRepo.has(rp)) byRepo.set(rp, []);
                    byRepo.get(rp)!.push(c.path);
                  }
                  for (const [repoPath, paths] of byRepo) {
                    await sendRpc('deleteUntracked', { paths, repoPath: repoPath || undefined });
                  }
                } catch (e) {
                  setActionError(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(false);
                }
              },
              disabled: status.untracked.length === 0,
            },
          ]}
          onStage={(p, rp) => handleStage(p, rp)}
          onDelete={(p, rp) => handleDeleteUntracked(p, rp)}
          onOpen={(p, rp) => handleOpenFile(p, false, rp)}
        />
      )}


    </div>
  );
}