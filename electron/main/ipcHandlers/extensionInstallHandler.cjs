const { ipcMain } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const { Channels } = require('../../shared/channels.cjs');

const EXTENSIONS_DIR = path.resolve(__dirname, '..', '..', '..', 'extensions');

/**
 * 注册扩展安装 IPC 处理器
 * 在指定扩展目录执行 npm install，安装 package.json 中的依赖
 */
function registerExtensionInstallHandlers() {
  ipcMain.handle(Channels.EXTENSION_INSTALL, async (_event, extPath) => {
    return new Promise((resolve) => {
      console.log(`[ExtensionInstall] 开始安装扩展依赖: ${extPath}`);
      const child = spawn('npm', ['install'], {
        cwd: extPath,
        shell: true,
        env: { ...process.env, npm_config_registry: process.env.npm_config_registry || 'https://registry.npmjs.org/' },
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        console.log(`[ExtensionInstall] ${chunk.trim()}`);
      });

      child.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        console.error(`[ExtensionInstall] ${chunk.trim()}`);
      });

      child.on('close', (code) => {
        console.log(`[ExtensionInstall] 安装完成，exit code: ${code}`);
        if (code === 0) {
          resolve({ success: true, stdout });
        } else {
          resolve({ success: false, code, stderr, stdout });
        }
      });

      child.on('error', (err) => {
        console.error('[ExtensionInstall] 启动失败:', err.message);
        resolve({ success: false, error: err.message });
      });
    });
  });

  ipcMain.handle(Channels.EXTENSION_UNINSTALL, async (_event, extPath) => {
    try {
      if (!extPath || typeof extPath !== 'string') {
        return { success: false, error: '无效的扩展路径' };
      }
      const resolved = path.resolve(extPath);
      console.log(`[ExtensionUninstall] 目标: ${resolved}, 允许目录: ${EXTENSIONS_DIR}`);
      // 安全检查：只能删除 extensions 目录下的文件夹
      if (!resolved.startsWith(EXTENSIONS_DIR + path.sep)) {
        return { success: false, error: `只能卸载 extensions 目录下的扩展 (${resolved} 不在 ${EXTENSIONS_DIR} 下)` };
      }
      await fs.rm(resolved, { recursive: true, force: true });
      console.log(`[ExtensionUninstall] 已卸载扩展目录: ${resolved}`);
      return { success: true };
    } catch (err) {
      console.error('[ExtensionUninstall] 卸载失败:', err.message);
      return { success: false, error: err.message };
    }
  });
}

module.exports = { registerExtensionInstallHandlers };
