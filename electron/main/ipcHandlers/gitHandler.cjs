const { ipcMain } = require('electron');
const { exec } = require('child_process');
const { Channels } = require('../../shared/channels.cjs');

/**
 * Git IPC 处理器
 *
 * 职责：为渲染进程提供当前工作目录的 Git 状态查询能力。
 *
 * 实现说明：
 * - 使用 `git status --porcelain` (porcelain v1) 获取机器可读的 Git 状态
 * - 解析每行的 `XY filename` 格式，X=index status, Y=working tree status
 * - 优先使用 working tree status (Y)，若为空则使用 index status (X)
 * - 只返回关心的状态：M(Modified), A(Added), D(Deleted), R(Renamed), U(Untracked)
 * - 非 Git 仓库或 git 命令失败时返回空对象，不抛错
 */
function registerGitHandlers() {
  ipcMain.handle(Channels.GIT_GET_STATUS, async (_event, dirPath) => {
    return new Promise((resolve) => {
      exec(
        'git status --porcelain',
        { cwd: dirPath, timeout: 5000 },
        (error, stdout) => {
          if (error) {
            // 不是 Git 仓库或 git 不可用，静默返回空
            resolve({});
            return;
          }

          const statusMap = {};
          const lines = stdout.split('\n').filter((line) => line.length > 3);

          for (const line of lines) {
            // porcelain v1 格式: "XY filename" 或 "XY orig -> renamed"
            const indexStatus = line[0];      // X: staged status
            const workTreeStatus = line[1];   // Y: working tree status
            const rest = line.slice(3);       // filename part

            // 解析文件名（处理重命名 "orig -> renamed" 格式）
            let filePath = rest;
            if (workTreeStatus === 'R' || indexStatus === 'R') {
              const arrowIdx = rest.indexOf(' -> ');
              if (arrowIdx >= 0) {
                filePath = rest.slice(arrowIdx + 4);
              }
            }

            // 优先使用 working tree 状态，其次是 index 状态
            const status = workTreeStatus !== ' ' ? workTreeStatus : indexStatus;

            // 只保留关心的状态码
            if (['M', 'A', 'D', 'R', 'U', '?'].includes(status)) {
              statusMap[filePath] = status === '?' ? 'U' : status;
            }
          }

          resolve(statusMap);
        }
      );
    });
  });
}

module.exports = { registerGitHandlers };
