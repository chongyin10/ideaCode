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
let activeFile = { path: null, staged: null };
let lastOpenedFile = { path: null, staged: null, time: 0 };

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

function pushActiveFile() {
  if (!webviewPanel) return;
  try {
    webviewPanel.webview.postMessage({ type: 'activeFile', path: activeFile.path, staged: activeFile.staged });
  } catch (e) {
    console.error('[Git Extension] push active file failed:', e.message);
  }
}

function resolveActiveFileStaged(path) {
  if (!currentRepo || !path) return null;
  const state = currentRepo.state;
  const inStaged = state.staged.some((c) => c.path === path);
  const inUnstaged = state.changes.some((c) => c.path === path) ||
    state.merge.some((c) => c.path === path) ||
    state.untracked.some((c) => c.path === path);
  if (inStaged && !inUnstaged) return true;
  if (!inStaged && inUnstaged) return false;
  // 暂存区和工作区同时存在该文件（部分暂存）时，优先采用最近一次打开 diff 时的分区
  if (lastOpenedFile.path === path && Date.now() - lastOpenedFile.time < 2000) {
    return lastOpenedFile.staged;
  }
  return null;
}

function pushState() {
  const state = currentRepo?.state || null;

  // 同步 Git 状态映射到主应用，供文件管理器 / Tab 栏着色
  try {
    send('git.statusChanged', { status: buildStatusMap(state) });
  } catch (e) {
    console.error('[Git Extension] push git status failed:', e.message);
  }

  // 同步当前分支到主应用状态栏
  try {
    send('git.branchChanged', { branch: state?.branch || '' });
  } catch (e) {
    console.error('[Git Extension] push branch failed:', e.message);
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

  // 状态变更后重新评估当前激活文件所在分区
  if (activeFile.path) {
    activeFile.staged = resolveActiveFileStaged(activeFile.path);
    pushActiveFile();
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

  // 远程 URI（ssh:// 等）不是本地文件系统路径，不能当作本地 Git 仓库处理，
  // 否则 path.resolve 会将其解析为当前工作目录下的相对路径，
  // 向上查找 .git 时可能错误地关联到 IDE 自身的本地仓库。
  if (typeof rootPath === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(rootPath)) {
    currentRootPath = rootPath;
    currentRepo = null;
    pushState();
    return;
  }

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

      case 'discard': {
        if (!currentRepo) return reply({ success: false, error: '没有打开的仓库' });
        const discardPaths = message.paths || [];
        await currentRepo.discard(discardPaths);
        // 通知前端文件被外部修改（discard 恢复了磁盘内容/恢复了被删文件），
        // 触发资源管理器刷新受影响目录 + 重载已打开编辑器内容
        if (discardPaths.length > 0) {
          send('git.filesChanged', { paths: discardPaths });
        }
        reply({ success: true });
        break;
      }

      case 'discardAll': {
        if (!currentRepo) return reply({ success: false, error: '没有打开的仓库' });
        const paths = currentRepo.state.changes.map((c) => c.path);
        await currentRepo.discard(paths);
        if (paths.length > 0) {
          send('git.filesChanged', { paths });
        }
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
          // 获取 HEAD 版本（原始）和工作树版本（修改后），供渲染进程展示 Diff
          let originalContent = '';
          if (currentRepo) {
            try {
              originalContent = (await currentRepo.getOriginalContent(message.path)) || '';
            } catch (e) {
              // 文件在 HEAD 中不存在（如新增/未跟踪文件），original 留空即可
            }
          }
          let modifiedContent = '';
          let isBinary = false;
          try {
            const repoRoot = currentRepo ? currentRepo.rootPath : currentRootPath;
            const fullPath = path.join(repoRoot || '', message.path);
            const buf = fs.readFileSync(fullPath);
            // 简易二进制检测：含 NUL 字节视为二进制
            isBinary = buf.includes(0);
            if (!isBinary) {
              modifiedContent = buf.toString('utf8');
            }
          } catch (e) {
            // 文件在工作区不存在（如删除），modified 留空
          }
          // 直接调用 git.openFile RPC（这个 handler 在 renderer 的 extensionBridge 中）
          await sendRpc('git.openFile', {
            path: message.path,
            staged: !!message.staged,
            original: originalContent,
            modified: modifiedContent,
            isBinary,
          });
          // 记录本次打开的文件分区，用于区分 staged / changes 高亮
          activeFile = { path: message.path, staged: !!message.staged };
          lastOpenedFile = { path: message.path, staged: !!message.staged, time: Date.now() };
          pushActiveFile();
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

  // 轮询工作区变更：检测用户切换项目根目录。
  // 间隔从 1s 放宽到 5s：切换项目是低频操作，1s 轮询浪费 IPC 带宽 + CPU。
  // fs.watch 已在主进程监听工作区变化，这里仅作兜底检测 root 切换。
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
  }, 5000);

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

module.exports = {
  activate,
  deactivate,
  setActiveFile({ path }) {
    activeFile = { path: path || null, staged: resolveActiveFileStaged(path) };
    pushActiveFile();
  },
  // 供主应用 RPC 调用（如状态栏分支选择器），不依赖 webview 通道
  async getBranches() {
    if (!currentRepo) return [];
    return await currentRepo.listBranches();
  },
  async checkoutBranch({ name }) {
    if (!currentRepo) throw new Error('没有打开的仓库');
    await currentRepo.checkoutBranch(name);
    pushBranches();
    pushLog();
    return { success: true };
  },
  async createBranch({ name, startPoint }) {
    if (!currentRepo) throw new Error('没有打开的仓库');
    await currentRepo.createBranch(name, startPoint);
    pushBranches();
    return { success: true };
  },
};