const { ipcMain } = require('electron');
const { exec, spawn } = require('child_process');
const { Channels } = require('../../shared/channels.cjs');

/**
 * Git IPC 处理器
 *
 * 职责：为渲染进程提供完整的 Git 操作能力。
 */
function execGit(command, cwd, timeout = 10000) {
  return new Promise((resolve, reject) => {
    exec(command, { cwd, timeout }, (error, stdout, stderr) => {
      if (error) {
        reject(stderr || error.message);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/** 不 trim 的版本 — git status 需要保留每行前导空格供列解析 */
function execGitRaw(command, cwd, timeout = 10000) {
  return new Promise((resolve, reject) => {
    exec(command, { cwd, timeout }, (error, stdout, stderr) => {
      if (error) {
        reject(stderr || error.message);
        return;
      }
      resolve(stdout);
    });
  });
}

function registerGitHandlers() {
  /* ─── 仓库状态 ─── */
  ipcMain.handle(Channels.GIT_GET_STATUS, async (_event, dirPath) => {
    try {
      const stdout = await execGitRaw('git status --porcelain', dirPath, 5000);
      const lines = stdout.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length >= 3);
      const staged = {};    // 暂存区 (index)
      const changes = {};   // 工作区 修改/删除
      const merge = {};     // 合并冲突
      const untracked = {}; // 未跟踪
      for (const line of lines) {
        const indexStatus = line[0];
        const workTreeStatus = line[1];
        let filePath = line.slice(3);
        if (workTreeStatus === 'R' || indexStatus === 'R') {
          const arrowIdx = filePath.indexOf(' -> ');
          if (arrowIdx >= 0) filePath = filePath.slice(arrowIdx + 4);
        }

        // 合并冲突
        if (workTreeStatus === 'U' || indexStatus === 'U') {
          merge[filePath] = 'U';
          continue;
        }
        // 未跟踪
        if (workTreeStatus === '?' || indexStatus === '?') {
          untracked[filePath] = 'U';
          continue;
        }

        const valid = ['M', 'A', 'D', 'R', 'C'];
        if (indexStatus !== ' ' && valid.includes(indexStatus)) {
          staged[filePath] = indexStatus;
        }
        if (workTreeStatus !== ' ' && valid.includes(workTreeStatus)) {
          changes[filePath] = workTreeStatus;
        }
      }
      return { staged, changes, merge, untracked };
    } catch {
      return { staged: {}, changes: {}, merge: {}, untracked: {} };
    }
  });

  /* ─── 分支相关 ─── */
  ipcMain.handle(Channels.GIT_GET_BRANCH, async (_event, dirPath) => {
    try {
      return await execGit('git rev-parse --abbrev-ref HEAD', dirPath);
    } catch {
      return '';
    }
  });

  ipcMain.handle(Channels.GIT_LIST_BRANCHES, async (_event, dirPath) => {
    try {
      const stdout = await execGit('git branch -a --format="%(refname:short)|%(HEAD)"', dirPath);
      return stdout.split('\n').map((line) => {
        const [name, head] = line.split('|');
        return { name: name.trim(), current: head === '*' };
      }).filter((b) => b.name);
    } catch {
      return [];
    }
  });

  ipcMain.handle(Channels.GIT_CHECKOUT, async (_event, dirPath, branch) => {
    const safe = branch.replace(/['"\\;|&`$]/g, '');
    await execGit(`git checkout ${safe}`, dirPath);
    return true;
  });

  ipcMain.handle(Channels.GIT_CREATE_BRANCH, async (_event, dirPath, branch) => {
    const safe = branch.replace(/['"\\;|&`$]/g, '');
    await execGit(`git checkout -b ${safe}`, dirPath);
    return true;
  });

  /* ─── 暂存/提交 ─── */
  ipcMain.handle(Channels.GIT_STAGE, async (_event, dirPath, files) => {
    const fileList = (Array.isArray(files) ? files : [files])
      .map((f) => `"${f.replace(/"/g, '\\"')}"`)
      .join(' ');
    await execGit(`git add ${fileList}`, dirPath);
    return true;
  });

  ipcMain.handle(Channels.GIT_UNSTAGE, async (_event, dirPath, files) => {
    const fileList = (Array.isArray(files) ? files : [files])
      .map((f) => `"${f.replace(/"/g, '\\"')}"`)
      .join(' ');
    await execGit(`git reset HEAD ${fileList}`, dirPath);
    return true;
  });

  ipcMain.handle(Channels.GIT_COMMIT, async (_event, dirPath, message) => {
    const escaped = message.replace(/"/g, '\\"');
    // -a 自动暂存已跟踪文件的修改，未跟踪文件仍需手动 add
    const stdout = await execGit(`git commit -a -m "${escaped}"`, dirPath);
    return stdout;
  });

  /* ─── 差异 ─── */
  ipcMain.handle(Channels.GIT_GET_DIFF, async (_event, dirPath, staged) => {
    try {
      const args = staged ? '--cached' : '';
      return await execGit(`git diff ${args}`, dirPath);
    } catch {
      return '';
    }
  });

  /** 获取 HEAD 版本的文件内容（用于 diff 对比） */
  ipcMain.handle(Channels.GIT_SHOW, async (_event, dirPath, filePath) => {
    try {
      return await execGit(`git show HEAD:${filePath}`, dirPath);
    } catch {
      // 文件在 HEAD 中不存在（新文件），返回空
      return '';
    }
  });

  /* ─── 拉取/推送/获取 ─── */
  ipcMain.handle(Channels.GIT_PULL, async (_event, dirPath) => {
    const stdout = await execGit('git pull', dirPath);
    return stdout;
  });

  ipcMain.handle(Channels.GIT_PUSH, async (_event, dirPath) => {
    const stdout = await execGit('git push', dirPath);
    return stdout;
  });

  ipcMain.handle(Channels.GIT_FETCH, async (_event, dirPath) => {
    await execGit('git fetch --all', dirPath);
    return true;
  });

  /* ─── 远程 ─── */
  ipcMain.handle(Channels.GIT_LIST_REMOTES, async (_event, dirPath) => {
    try {
      const stdout = await execGit('git remote -v', dirPath);
      return stdout.split('\n').map((line) => {
        const parts = line.split(/\s+/);
        return { name: parts[0], url: parts[1], type: parts[2]?.replace(/[()]/g, '') };
      }).filter((r) => r.name);
    } catch {
      return [];
    }
  });

  /* ─── 日志 ─── */
  ipcMain.handle(Channels.GIT_GET_LOG, async (_event, dirPath, count = 20) => {
    try {
      const stdout = await execGit(`git log --oneline -n ${count}`, dirPath);
      return stdout.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  });

  /* ─── Stash ─── */
  ipcMain.handle(Channels.GIT_STASH_LIST, async (_event, dirPath) => {
    try {
      const stdout = await execGit('git stash list', dirPath);
      return stdout.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  });

  ipcMain.handle(Channels.GIT_STASH_PUSH, async (_event, dirPath, message) => {
    const msg = message ? `-m "${message.replace(/"/g, '\\"')}"` : '';
    await execGit(`git stash push ${msg}`, dirPath);
    return true;
  });

  ipcMain.handle(Channels.GIT_STASH_POP, async (_event, dirPath) => {
    await execGit('git stash pop', dirPath);
    return true;
  });

  /* ─── 高级功能 ─── */
  ipcMain.handle(Channels.GIT_GET_BEHIND_AHEAD, async (_event, dirPath) => {
    try {
      const stdout = await execGit('git rev-list --left-right --count @{upstream}...HEAD', dirPath, 5000);
      const [behind, ahead] = stdout.split('\t').map(Number);
      return { ahead: ahead || 0, behind: behind || 0 };
    } catch {
      return { ahead: 0, behind: 0 };
    }
  });

  ipcMain.handle(Channels.GIT_DISCARD, async (_event, dirPath, file) => {
    const safe = `"${file.replace(/"/g, '\\"')}"`;
    await execGit(`git checkout -- ${safe}`, dirPath);
    return true;
  });

  /* ─── 仓库初始化/克隆 ─── */
  ipcMain.handle(Channels.GIT_INIT, async (_event, dirPath) => {
    await execGit('git init', dirPath);
    return true;
  });

  ipcMain.handle(Channels.GIT_CLONE, async (event, repoUrl, targetPath) => {
    const safeUrl = repoUrl.replace(/['"\\;|&`$!]/g, '');
    const safePath = targetPath.replace(/['"\\;|&`$!]/g, '');
    const sender = event.sender;

    return new Promise((resolve, reject) => {
      const child = spawn('git', ['clone', '--progress', safeUrl, safePath], {
        cwd: process.cwd(),
      });

      let resolved = false;

      // #3 自适应超时: 初始 120s，进度 >30% 时用 sigmoid 扩展到 max 900s
      const BASE_TIMEOUT = 120000;
      const MAX_TIMEOUT = 900000;
      let currentTimeout = BASE_TIMEOUT;
      let timer = null;
      let lastPercent = 0;
      // #2 ETA: 记录进度采样
      const samples = [];

      const scheduleTimeout = (pct) => {
        if (timer) clearTimeout(timer);
        // sigmoid 扩展: 进度越高超时越大
        if (pct > 10) {
          currentTimeout = Math.min(
            BASE_TIMEOUT + 180000 * (1 / (1 + Math.exp(-0.08 * (pct - 35)))),
            MAX_TIMEOUT
          );
        }
        timer = setTimeout(() => {
          done(`克隆超时（超过 ${Math.round(currentTimeout / 1000)} 秒，进度 ${pct}%）`, null);
        }, currentTimeout);
      };
      scheduleTimeout(0);

      const done = (err, result) => {
        if (resolved) return;
        resolved = true;
        if (timer) clearTimeout(timer);
        child.kill('SIGTERM');
        err ? reject(err) : resolve(result);
      };

      let lastProgress = '';
      const sendProgress = (text) => {
        if (text && text !== lastProgress) {
          lastProgress = text;
          try { sender.send(Channels.GIT_CLONE_PROGRESS, text); } catch {}
        }
      };

      child.stderr.on('data', (data) => {
        const text = data.toString().trim();
        const lines = text.split('\n').filter(Boolean);
        for (const line of lines) {
          sendProgress(line);
          const pct = line.match(/(\d+)%/)
            || line.match(/Resolving deltas:\s+(\d+)%/)
            || line.match(/Compressing objects:\s+(\d+)%/);
          if (pct) {
            const val = parseInt(pct[1], 10);
            lastPercent = val;
            samples.push({ time: Date.now(), pct: val });
            if (samples.length > 8) samples.shift();
            try { sender.send(Channels.GIT_CLONE_PROGRESS, `percent:${val}`); } catch {}
            scheduleTimeout(val);
            // #2 ETA: 用最近 3+ 个样本做线性回归预测
            if (samples.length >= 3) {
              const n = samples.length;
              let sx = 0, sy = 0, sxx = 0, sxy = 0;
              for (const s of samples) { sx += s.time; sy += s.pct; sxx += s.time * s.time; sxy += s.time * s.pct; }
              const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
              if (slope > 0) {
                const eta = Math.round((100 - val) / slope / 1000);
                if (eta > 0) {
                  try { sender.send(Channels.GIT_CLONE_PROGRESS, `eta:${eta}`); } catch {}
                }
              }
            }
          }
        }
      });

      child.stdout.on('data', (data) => {
        sendProgress(data.toString().trim());
      });

      child.on('error', (err) => {
        done(err.message, null);
      });

      child.on('close', (code) => {
        if (code === 0) {
          done(null, '克隆完成');
        } else {
          done(`git clone 失败 (exit code ${code})`, null);
        }
      });
    });
  });

  ipcMain.handle(Channels.GIT_IS_REPO, async (_event, dirPath) => {
    try {
      await execGit('git rev-parse --git-dir', dirPath, 3000);
      return true;
    } catch {
      return false;
    }
  });
}

module.exports = { registerGitHandlers };
