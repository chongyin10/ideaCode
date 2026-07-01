const { ipcMain } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Channels } = require('../../shared/channels.cjs');

/**
 * Git IPC 处理器
 *
 * 渲染进程无法直接调用系统 git 命令，
 * 通过主进程 spawn git 完成克隆等操作。
 */
function registerGitHandlers() {
  ipcMain.handle(Channels.GIT_CLONE, async (event, url, targetPath) => {
    if (!url || !targetPath) {
      return { success: false, error: '缺少仓库地址或目标路径' };
    }

    // 确保父目录存在
    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    } catch (err) {
      return { success: false, error: `创建目标目录失败: ${err.message}` };
    }

    return new Promise((resolve) => {
      const proc = spawn('git', ['clone', '--progress', url, targetPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';

      proc.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        event.sender.send(Channels.GIT_CLONE_PROGRESS, { message: chunk.trim() });
      });

      proc.stdout.on('data', (data) => {
        event.sender.send(Channels.GIT_CLONE_PROGRESS, { message: data.toString().trim() });
      });

      proc.on('error', (err) => {
        resolve({ success: false, error: err.message });
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ success: true });
        } else {
          resolve({ success: false, error: stderr || `git clone 退出码 ${code}` });
        }
      });
    });
  });
}

module.exports = { registerGitHandlers };
