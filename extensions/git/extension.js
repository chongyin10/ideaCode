/**
 * IDEACODE Git 扩展入口
 *
 * 设计参考 VS Code 的 vscode.git 内置扩展。
 *
 * 职责：
 * 1. 维护当前活动的 Repository 实例（每个工作区一个）
 * 2. 监听工作区变更，自动打开/关闭 Repository
 * 3. 注册一个 WebView 面板用于 Source Control UI
 * 4. 处理来自 WebView 的 RPC 命令
 * 5. 当 Repository 状态变化时，向 WebView 推送更新
 */

const fs = require('fs');
const path = require('path');
const vscode = require('./api');
const { Repository, findRepoRoot, GitError } = require('./repository');
const { isGitAvailable } = require('./gitCLI');
const { request: sendRpc, send } = require('./api');

// 全局状态
let currentRepo = null;
let currentRootPath = null;
let webviewPanel = null;
let gitAvailable = true;

// 防抖：工作区根变更时延迟一点再处理（避免快速切换）
let workspaceChangeTimer = null;

/* ─── HTML 加载 ─── */

function getWebviewHtml(extensionPath) {
  const htmlPath = path.join(extensionPath, 'webview', 'index.html');
  try {
    let html = fs.readFileSync(htmlPath, 'utf-8');

    // 内联 CSS（兼容相对路径 ./assets/ 和绝对路径 /assets/）
    html = html.replace(/<link[^>]*rel="stylesheet"[^>]*href="(?:\.\/|\/)assets\/([^"]+)"[^>]*>/g, (match, filename) => {
      const cssPath = path.join(extensionPath, 'webview', 'assets', filename);
      try {
        const css = fs.readFileSync(cssPath, 'utf-8');
        return `<style>${css}</style>`;
      } catch {
        return match;
      }
    });

    // 内联 JS（兼容相对路径 ./assets/ 和绝对路径 /assets/）
    html = html.replace(/<script[^>]*type="module"[^>]*src="(?:\.\/|\/)assets\/([^"]+)"[^>]*><\/script>/g, (match, filename) => {
      const jsPath = path.join(extensionPath, 'webview', 'assets', filename);
      try {
        const js = fs.readFileSync(jsPath, 'utf-8');
        return `<script type="module">${js}</script>`;
      } catch {
        return match;
      }
    });

    return html;
  } catch (err) {
    console.error('[Git Extension] 读取 WebView HTML 失败:', err.message);
    return `<html><body style="color:#fff;background:#1e1e1e;padding:20px;font-family:sans-serif;">
      <h1>Source Control</h1>
      <p>WebView 资源未找到。请运行：</p>
      <pre>cd web/git && npm run build</pre>
    </body></html>`;
  }
}

/* ─── 状态推送 ─── */

function statusToCode(s) {
  if (!s || s === ' ' || s === 'untracked') return '';
  const c = String(s)[0].toUpperCase();
  if (c === 'T') return 'M'; // type-change 按 modified 显示
  if (['M', 'A', 'D', 'R', 'C', 'U'].includes(c)) return c;
  return '';
}

function buildStatusMap(state) {
  if (!state) return {};
  const map = {};
  const add = (list, codeFn) => {
    for (const c of list || []) {
      const code = codeFn(c);
      if (code) map[c.path] = code;
    }
  };
  // 顺序靠后的会覆盖前者：工作区状态优先于暂存区
  add(state.staged, (c) => statusToCode(c.indexStatus));
  add(state.changes, (c) => statusToCode(c.workingStatus));
  add(state.merge, () => 'U');
  add(state.untracked, () => 'U');
  return map;
}

function pushState() {
  const state = currentRepo?.state || null;

  // 同步 Git 状态映射到主应用，供文件管理器 / Tab 栏着色
  try {
    send('git.statusChanged', { status: buildStatusMap(state) });
  } catch (e) {
    console.error('[Git Extension] push git status failed:', e.message);
  }

  if (!webviewPanel) return;
  const message = {
    type: 'state',
    rootPath: currentRootPath,
    repoRoot: currentRepo?.rootPath || null,
    isRepo: !!currentRepo,
    gitAvailable,
    state,
    lastError: currentRepo?._lastError || null,
  };
  try {
    webviewPanel.webview.postMessage(message);
  } catch (e) {
    console.error('[Git Extension] postMessage failed:', e.message);
  }

  // 同步活动栏徽标：暂存 + 工作区修改 + 冲突 + 未跟踪
  const badge = state
    ? (state.staged?.length || 0) +
      (state.changes?.length || 0) +
      (state.merge?.length || 0) +
      (state.untracked?.length || 0)
    : 0;
  try {
    send('ui.activityBar.setBadge', { id: 'workbench.scm', badge });
  } catch (e) {
    console.error('[Git Extension] setBadge failed:', e.message);
  }
}

function pushBranches() {
  if (!webviewPanel || !currentRepo) return;
  currentRepo.listBranches().then((branches) => {
    try {
      webviewPanel.webview.postMessage({ type: 'branches', branches });
    } catch { /* ignore */ }
  }).catch(() => {});
}

function pushLog() {
  if (!webviewPanel || !currentRepo) return;
  currentRepo.getLog(50).then((log) => {
    try {
      webviewPanel.webview.postMessage({ type: 'log', log });
    } catch { /* ignore */ }
  }).catch(() => {});
}

function pushStashes() {
  if (!webviewPanel || !currentRepo) return;
  currentRepo.listStashes().then((stashes) => {
    try {
      webviewPanel.webview.postMessage({ type: 'stashes', stashes });
    } catch { /* ignore */ }
  }).catch(() => {});
}

/* ─── 仓库管理 ─── */

async function openRepository(rootPath) {
  if (!rootPath) {
    closeRepository();
    return;
  }
  if (currentRootPath === rootPath && currentRepo) {
    return; // 已打开
  }

  closeRepository();

  if (!gitAvailable) {
    currentRootPath = rootPath;
    pushState();
    return;
  }

  const repoRoot = findRepoRoot(rootPath);
  if (!repoRoot) {
    currentRootPath = rootPath;
    currentRepo = null;
    pushState();
    return;
  }

  currentRootPath = rootPath;
  currentRepo = new Repository(repoRoot);

  // 订阅状态变更 → 推送给 WebView
  currentRepo.onDidChange(() => {
    pushState();
    pushBranches();
    pushStashes();
  });

  // 初始刷新
  await currentRepo.refresh();
  pushState();
  pushBranches();
  pushLog();
  pushStashes();
}

function closeRepository() {
  if (currentRepo) {
    currentRepo.dispose();
    currentRepo = null;
  }
  currentRootPath = null;
  pushState();
}

/* ─── 工作区变更监听 ─── */

function scheduleOpenForRoot(rootPath) {
  if (workspaceChangeTimer) clearTimeout(workspaceChangeTimer);
  workspaceChangeTimer = setTimeout(() => {
    openRepository(rootPath).catch((e) => {
      console.error('[Git Extension] openRepository failed:', e.message);
    });
  }, 200);
}

async function getCurrentRootPath() {
  // 通过直接 RPC 调用转发到渲染进程，查询 Redux state
  try {
    const result = await vscode.workspace.getRootPath();
    return typeof result === 'string' ? result : null;
  } catch {
    return null;
  }
}

/* ─── WebView 消息处理 ─── */

async function handleWebviewMessage(message) {
  if (!message || typeof message !== 'object') return;

  const reply = (payload) => {
    if (!webviewPanel) return;
    try {
      webviewPanel.webview.postMessage({ type: 'rpc:reply', id: message.id, ...payload });
    } catch { /* ignore */ }
  };

  try {
    switch (message.command) {
      case 'ready':
        // WebView 已挂载，推送当前状态
        pushState();
        pushBranches();
        pushLog();
        pushStashes();
        reply({ success: true });
        break;

      case 'refresh':
        if (currentRepo) {
          await currentRepo.refresh();
          pushState();
          pushBranches();
          pushStashes();
        }
        reply({ success: true });
        break;

      case 'stage':
        if (!currentRepo) return reply({ success: false, error: '没有打开的仓库' });
        await currentRepo.stage(message.paths || []);
        reply({ success: true });
        break;

      case 'unstage':
        if (!currentRepo) return reply({ success: false, error: '没有打开的仓库' });
        await currentRepo.unstage(message.paths || []);
        reply({ success: true });
        break;

      case 'stageAll':
        if (!currentRepo) return reply({ success: false, error: '没有打开的仓库' });
        await currentRepo.stageAll();
        reply({ success: true });
        break;

      case 'unstageAll':
        if (!currentRepo) return reply({ success: false, error: '没有打开的仓库' });
        await currentRepo.unstageAll();
        reply({ success: true });
        break;

      case 'commit': {
        if (!currentRepo) return reply({ success: false, error: '没有打开的仓库' });
        const result = await currentRepo.commit(message.message || '', {
          amend: !!message.amend,
          noVerify: !!message.noVerify,
          allowEmpty: !!message.allowEmpty,
        });
        reply({ success: true, output: result.message });
        break;
      }

      case 'discard':
        if (!currentRepo) return reply({ success: false, error: '没有打开的仓库' });
        await currentRepo.discard(message.paths || []);
        reply({ success: true });
        break;

      case 'discardAll': {
        if (!currentRepo) return reply({ success: false, error: '没有打开的仓库' });
        const paths = currentRepo.state.changes.map((c) => c.path);
        await currentRepo.discard(paths);
        reply({ success: true });
        break;
      }

      case 'deleteUntracked':
        if (!currentRepo) return reply({ success: false, error: '没有打开的仓库' });
        await currentRepo.deleteUntracked(message.paths || []);
        reply({ success: true });
        break;

      case 'checkoutBranch':
        if (!currentRepo) return reply({ success: false, error: '没有打开的仓库' });
        await currentRepo.checkoutBranch(message.name);
        pushBranches();
        pushLog();
        reply({ success: true });
        break;

      case 'createBranch':
        if (!currentRepo) return reply({ success: false, error: '没有打开的仓库' });
        await currentRepo.createBranch(message.name, message.startPoint);
        pushBranches();
        reply({ success: true });
        break;

      case 'deleteBranch':
        if (!currentRepo) return reply({ success: false, error: '没有打开的仓库' });
        await currentRepo.deleteBranch(message.name, !!message.force);
        pushBranches();
        reply({ success: true });
        break;

      case 'push':
        if (!currentRepo) return reply({ success: false, error: '没有打开的仓库' });
        const pushResult = await currentRepo.push(message.remote, message.branch);
        reply({ success: true, output: pushResult.output });
        break;

      case 'pull':
        if (!currentRepo) return reply({ success: false, error: '没有打开的仓库' });
        const pullResult = await currentRepo.pull(message.remote, message.branch);
        pushLog();
        reply({ success: true, output: pullResult.output });
        break;

      case 'fetch':
        if (!currentRepo) return reply({ success: false, error: '没有打开的仓库' });
        await currentRepo.fetch(message.remote);
        pushBranches();
        reply({ success: true });
        break;

      case 'getBranches':
        if (!currentRepo) return reply({ success: true, branches: [] });
        const branches = await currentRepo.listBranches();
        reply({ success: true, branches });
        break;

      case 'getRemotes':
        if (!currentRepo) return reply({ success: true, remotes: [] });
        const remotes = await currentRepo.listRemotes();
        reply({ success: true, remotes });
        break;

      case 'getLog':
        if (!currentRepo) return reply({ success: true, log: [] });
        const log = await currentRepo.getLog(message.count || 50);
        reply({ success: true, log });
        break;

      case 'getStashes':
        if (!currentRepo) return reply({ success: true, stashes: [] });
        const stashes = await currentRepo.listStashes();
        reply({ success: true, stashes });
        break;

      case 'getDiff':
        if (!currentRepo) return reply({ success: true, diff: '' });
        const diff = await currentRepo.getDiff(message.path, !!message.staged);
        reply({ success: true, diff });
        break;

      case 'getOriginalContent':
        if (!currentRepo) return reply({ success: true, content: '' });
        const content = await currentRepo.getOriginalContent(message.path);
        reply({ success: true, content });
        break;

      case 'openFile': {
        // 打开工作区中的文件
        if (!message.path) return reply({ success: false, error: '缺少 path' });
        try {
          // 直接调用 git.openFile RPC（这个 handler 在 renderer 的 extensionBridge 中）
          await sendRpc('git.openFile', {
            path: message.path,
            staged: !!message.staged,
          });
          reply({ success: true });
        } catch (e) {
          reply({ success: false, error: e.message });
        }
        break;
      }

      case 'openRepositoryDialog': {
        // 弹出原生目录选择对话框
        try {
          const result = await sendRpc('git.openRepositoryDialog');
          const selected = result?.selected || result || null;
          if (selected) {
            await sendRpc('git.loadDirectory', { path: selected });
          }
          reply({ success: true, selected });
        } catch (e) {
          reply({ success: false, error: e.message });
        }
        break;
      }

      case 'initRepository':
        if (!currentRootPath) return reply({ success: false, error: '没有工作区' });
        try {
          await execInit(currentRootPath);
          await openRepository(currentRootPath);
          reply({ success: true });
        } catch (e) {
          reply({ success: false, error: e.message });
        }
        break;

      case 'cloneRepository': {
        const { url, targetPath } = message;
        if (!url || !targetPath) return reply({ success: false, error: '缺少 url 或 targetPath' });
        try {
          await sendRpc('git.clone', { url, targetPath });
          await openRepository(targetPath);
          reply({ success: true });
        } catch (e) {
          reply({ success: false, error: e.message });
        }
        break;
      }
    }
  } catch (err) {
    reply({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

function execInit(rootPath) {
  const { execGit } = require('./gitCLI');
  return execGit(['init'], { cwd: rootPath }).then(({ code, stderr }) => {
    if (code !== 0) throw new Error(stderr || `git init failed (exit ${code})`);
  });
}

/* ─── 激活 ─── */

async function activate(context) {
  console.log('[Git Extension] 已激活');

  // 检查 git 是否可用
  gitAvailable = await isGitAvailable();
  if (!gitAvailable) {
    console.warn('[Git Extension] git 命令不可用，扩展将以受限模式运行');
  }

  // 创建 WebView 面板（用于 Source Control UI）
  // viewType 必须与 package.json contributes.views 中声明的 id 一致
  // 这样 DockableContent 在渲染 viewContainer 时能通过 viewType 找到这个 WebView
  webviewPanel = vscode.window.createWebviewPanel(
    'git.changesView',
    '源代码管理',
    { preserveFocus: true },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      extensionId: 'ideacode-git',
      extensionPath: context.extensionPath,
    }
  );
  webviewPanel.webview.html = getWebviewHtml(context.extensionPath);
  webviewPanel.webview.onDidReceiveMessage(handleWebviewMessage);

  context.subscriptions.push({
    dispose: () => {
      closeRepository();
      try { webviewPanel?.dispose(); } catch { /* ignore */ }
      webviewPanel = null;
    },
  });

  // 延迟一点再获取工作区路径并打开仓库（让 UI 先挂载）
  setTimeout(async () => {
    const rootPath = await getCurrentRootPath();
    if (rootPath) {
      await openRepository(rootPath);
    }
  }, 300);

  // 轮询工作区变更（每 1 秒检查一次，简单可靠）
  let lastKnownRoot = null;
  const pollTimer = setInterval(async () => {
    try {
      const root = await getCurrentRootPath();
      if (root !== lastKnownRoot) {
        lastKnownRoot = root;
        if (root) {
          scheduleOpenForRoot(root);
        } else {
          closeRepository();
        }
      }
    } catch {
      // ignore
    }
  }, 1000);

  context.subscriptions.push({
    dispose: () => clearInterval(pollTimer),
  });
}

function deactivate() {
  console.log('[Git Extension] 已停用');
  closeRepository();
  try { webviewPanel?.dispose(); } catch { /* ignore */ }
  webviewPanel = null;
}

module.exports = { activate, deactivate };