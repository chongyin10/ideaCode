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

/**
 * §需求：检测远程 SSH 路径是否为 Git 仓库根。
 * 之前 git 扩展对 ssh:// 路径直接返回 null，资源管理器一直显示"当前文件夹不是 Git 仓库"。
 * 这里通过 host 的 commands.execute 通道调用 SSH 扩展的 executeRemote，
 * 在远程主机上跑 `git rev-parse --show-toplevel`，拿到仓库根就返回。
 *
 * @param {string} sshUri 形如 ssh://<connId>/path/to/repo
 * @returns {Promise<string|null>} 远程 Git 仓库根绝对路径；非仓库返回 null
 */
async function findRemoteRepoRoot(sshUri) {
  // 解析 ssh://<authority><path> 格式
  const match = sshUri.match(/^ssh:\/\/([^/]+)(.*)$/);
  if (!match) return null;
  const connId = match[1];
  const remotePath = match[2] || '/';
  try {
    // §通过跨扩展命令路由调用 SSH 扩展的 ssh.executeRemote
    // ssh.executeRemote 接收 { connectionId, command, cwd }，自动解析 connectionId → session
    const result = await vscode.commands.executeCommand(
      'ssh.executeRemote',
      { connectionId: connId, command: 'git rev-parse --show-toplevel', cwd: remotePath }
    );
    if (!result || !result.success) return null;
    const stdout = (result.stdout || '').trim();
    if (!stdout) return null;
    return stdout;
  } catch (err) {
    console.error('[Git Extension] 远程仓库检测失败:', err.message);
    return null;
  }
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
    loading: false, // 仓库加载完成，关闭 loading
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

/**
 * 推送 loading 状态：仓库正在加载时让 webview 显示 loading icon + 文案。
 * 在 openRepository 开始时调用，pushState 完成后会用 loading: false 覆盖。
 */
function pushLoading(rootPath) {
  if (!webviewPanel) return;
  try {
    webviewPanel.webview.postMessage({
      type: 'state',
      rootPath: rootPath || null,
      repoRoot: null,
      isRepo: false,
      gitAvailable,
      state: null,
      lastError: null,
      loading: true,
    });
  } catch { /* ignore */ }
}

/**
 * 推送清空状态：WebView（重新）挂载时立即清空旧数据。
 *
 * 场景：IDE 重启 / 窗口重开后 webview 重建，此时 gitStore 已重置（无持久化），
 * 但 syncWorkspace 是异步的（含 getCurrentRootPath RPC + openRepository），
 * 在其完成前若 Extension Host 残留的定时器/事件推送了旧项目的 state，
 * webview 会短暂显示旧数据。先推送清空状态可避免这一窗口期。
 */
function pushClear() {
  if (!webviewPanel) return;
  try {
    webviewPanel.webview.postMessage({
      type: 'state',
      rootPath: null,
      repoRoot: null,
      isRepo: false,
      gitAvailable,
      state: null,
      lastError: null,
      loading: true,
    });
  } catch { /* ignore */ }
}

async function openRepository(rootPath) {
  if (!rootPath) {
    closeRepository();
    return;
  }
  if (currentRootPath === rootPath && currentRepo) {
    return; // 已打开
  }

  // 推送 loading 状态，让 webview 立即显示加载中（消除用户感知延迟）
  pushLoading(rootPath);

  closeRepository();

  // §需求：SSH 远程工作区（已通过 SshFileTreePanel "添加到资源管理器" 加载到资源管理器）
  // 现在也支持 Git 检测：findRemoteRepoRoot 通过 SSH 远程执行 `git rev-parse --show-toplevel`
  // 真正检测远程目录是否为 Git 仓库。下方不再对 ssh:// 提前 bail-out——
  // 否则资源管理器会一直显示"当前文件夹不是 Git 仓库"，与实际不符。
  if (typeof rootPath === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(rootPath)) {
    if (!gitAvailable) {
      currentRootPath = rootPath;
      pushState();
      return;
    }
    // 异步在远程执行 git 检测；同步先 push 一次 loading 状态
    pushLoading(rootPath);
    let remoteRepoRoot = null;
    let detectError = null;
    try {
      remoteRepoRoot = await findRemoteRepoRoot(rootPath);
    } catch (err) {
      // §关键：findRemoteRepoRoot 失败时【不要】清空 currentRepo。
      //   之前 catch 块会重置 currentRepo=null 再 pushState，导致 isRepo: false。
      //   这里把错误吞下但保留 currentRepo 引用，让 UI 仍按"是 Git 仓库"显示。
      //   检测失败（连接问题、路径错误）只是说明无法远程确认，UI 不应该撒谎。
      detectError = err;
      console.error('[Git Extension] 远程仓库检测失败（保留 currentRepo 不变）:', err.message);
    }
    if (remoteRepoRoot) {
      // 找到 Git 仓库根目录
      currentRootPath = rootPath;
      // §创建远程执行器：所有 git 命令通过 SSH 在远程主机执行
      const sshMatch = rootPath.match(/^ssh:\/\/([^/]+)/);
      const connId = sshMatch ? sshMatch[1] : null;
      const remoteExecutor = connId ? async (command, cwd) => {
        const result = await vscode.commands.executeCommand('ssh.executeRemote', {
          connectionId: connId, command, cwd,
        });
        return {
          stdout: result?.stdout || '',
          stderr: result?.stderr || '',
          code: result?.code ?? -1,
        };
      } : null;
      currentRepo = new Repository(remoteRepoRoot, { remoteExecutor });
      currentRepo.onDidChange(() => {
        pushState();
        pushBranches();
        pushStashes();
      });
      // 先 push 一次 isRepo: true（即使后续 refresh 失败，UI 仍正确显示"是仓库"）
      pushState();
      // 刷新远程仓库状态（通过 SSH 执行 git status）
      try {
        await currentRepo.refresh();
        pushState();
        pushBranches();
        pushStashes();
      } catch (refreshErr) {
        console.warn('[Git Extension] 远程仓库 refresh 失败:', refreshErr.message);
      }
    } else {
      // 远程目录不是 Git 仓库，或检测失败但路径仍是 ssh://
      // 上一轮的 currentRepo 保留——我们不在 catch 里把它清空，避免 UI 把"是仓库"误判为"否"
      if (!currentRepo) {
        currentRootPath = rootPath;
        pushState();
      } else {
        // 已经有 currentRepo（例如先前会话的），保持不变
        pushState();
      }
      if (detectError) {
        // 静默记录，不影响 UI（isRepo 仍按 currentRepo 状态显示）
        // 之前会清空 currentRepo=false 让用户看不到"是 Git 仓库"——现在改用真实状态
        console.warn('[Git Extension] 远程 git 检测未完成，沿用 currentRepo 状态');
      }
    }
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

/**
 * 重新同步当前工作区并推送状态。
 *
 * 用于 WebView（重新）挂载（ready）时，避免推送过时的 currentRepo 缓存。
 *
 * 场景：IDE 重启 / 窗口重开后 webview 重建，此时 currentRepo 可能是上次会话
 * 残留（例如 macOS 关闭窗口不退出应用、Extension Host 持续运行），直接 pushState
 * 会让源代码管理面板显示旧项目的 git 数据。必须以当前实际工作区为准重新加载。
 *
 * 逻辑：
 *   - 工作区路径已变更 → openRepository 重新加载（内部会先 closeRepository 清理旧状态）
 *   - 工作区已清空但 currentRepo 仍残留 → closeRepository 清理
 *   - 工作区未变 → 推送当前状态
 */
async function syncWorkspace() {
  try {
    const rootPath = await getCurrentRootPath();
    if (rootPath && rootPath !== currentRootPath) {
      await openRepository(rootPath);
    } else if (!rootPath && currentRepo) {
      closeRepository();
    } else {
      pushState();
      pushBranches();
      pushLog();
      pushStashes();
    }
  } catch (e) {
    console.error('[Git Extension] sync workspace on ready failed:', e.message);
    pushState();
  }
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
        // WebView（重新）挂载：先同步清理残留 Repository，再以当前实际工作区为准重新加载。
        //
        // 根因：macOS 关闭窗口不退出应用、Extension Host 持续运行时，currentRepo 可能是
        // 上次会话的残留（A 项目）。syncWorkspace 是异步的（含 getCurrentRootPath RPC +
        // openRepository），在其 await 期间，残留 Repository 的 fs.watch / 兜底轮询定时器
        // 可能触发 onDidChange → pushState，把 A 项目的 git 数据推送给 webview，
        // 覆盖掉 pushClear 的清空状态——这就是「git 工作区记录与当前加载项目不一致」的源头。
        //
        // 修复：先同步 dispose 残留 Repository（停止其所有定时器/watcher），
        // 再 pushClear 推送清空状态，最后 syncWorkspace 以当前 rootSource 为准重新加载。
        reply({ success: true });
        if (currentRepo) {
          currentRepo.dispose();
          currentRepo = null;
          currentRootPath = null;
        }
        pushClear();
        syncWorkspace();
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
            // §优先使用 Repository.readFile（支持远程 SSH 仓库通过 cat 读取）
            if (currentRepo) {
              const result = await currentRepo.readFile(message.path);
              modifiedContent = result.content;
              isBinary = result.isBinary;
            } else {
              const repoRoot = currentRootPath;
              const fullPath = path.join(repoRoot || '', message.path);
              const buf = fs.readFileSync(fullPath);
              isBinary = buf.includes(0);
              if (!isBinary) {
                modifiedContent = buf.toString('utf8');
              }
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

      case 'associateRemote': {
        // 关联远程仓库：本地项目（可能未 init）→ git init → git remote add origin <url> → fetch
        // 适用于"本地已有项目，想推送到已存在的远程仓库"场景。
        const { url } = message;
        if (!url) return reply({ success: false, error: '缺少远程仓库地址' });
        if (!currentRootPath) return reply({ success: false, error: '没有工作区' });
        try {
          const { execGit } = require('./gitCLI');
          // 1. 若还不是 git 仓库，先初始化
          if (!currentRepo) {
            await execInit(currentRootPath);
          }
          // 2. 添加远程地址：若 origin 已存在先移除，避免 "remote origin already exists" 错误
          try {
            await execGit(['remote', 'remove', 'origin'], { cwd: currentRootPath });
          } catch { /* origin 可能不存在，忽略 */ }
          const addRes = await execGit(['remote', 'add', 'origin', url], { cwd: currentRootPath });
          if (addRes.code !== 0) throw new Error(addRes.stderr || 'git remote add 失败');
          // 3. 拉取远程信息（让远程分支可见）；失败不阻塞关联（私有仓库可能需要认证）
          try {
            await execGit(['fetch', 'origin'], { cwd: currentRootPath, timeout: 60000 });
          } catch { /* fetch 失败：关联已成功，用户可稍后手动 fetch */ }
          // 4. 重新加载仓库，刷新 UI 状态
          await openRepository(currentRootPath);
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
  // 主应用打开文件夹后主动通知 git 扩展，消除 5 秒轮询延迟
  async openWorkspace({ path: rootPath }) {
    if (!rootPath) {
      closeRepository();
      return;
    }
    // 取消等待中的防抖定时器，立即加载
    if (workspaceChangeTimer) {
      clearTimeout(workspaceChangeTimer);
      workspaceChangeTimer = null;
    }
    await openRepository(rootPath);
  },
};