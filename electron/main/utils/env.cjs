const { execSync } = require('child_process');
const os = require('os');
const path = require('path');

/**
 * 展开路径中的 ~ 为用户主目录
 */
function expandHome(p) {
  if (!p || typeof p !== 'string') return p;
  if (p === '~' || p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(1));
  }
  if (p.startsWith('~')) {
    // ~name/path 形式，尝试解析
    try {
      const sepIdx = p.indexOf('/');
      const user = sepIdx === -1 ? p.slice(1) : p.slice(1, sepIdx);
      const rest = sepIdx === -1 ? '' : p.slice(sepIdx);
      const home = os.userInfo().homedir || os.homedir();
      // 简单处理：当前用户
      if (user === (os.userInfo().username || '')) return path.join(home, rest);
    } catch {
      // 忽略解析失败
    }
  }
  return p;
}

/**
 * 尝试从用户登录 shell 获取 PATH。
 * 用于修复 macOS 从 GUI 启动时 process.env.PATH 不完整，导致找不到 git 等问题。
 */
function getShellPath() {
  if (process.platform !== 'darwin') return '';
  const shells = [process.env.SHELL, '/bin/zsh', '/bin/bash'].filter(Boolean);
  for (const shell of shells) {
    try {
      const result = execSync(`${shell} -ilc 'echo "$PATH"'`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 3000,
      });
      const path = result.trim().split('\n').pop();
      if (path && path.includes('/')) return path;
    } catch {
      // 忽略单个 shell 的失败，继续尝试下一个
    }
  }
  return '';
}

/**
 * 补全主进程的 PATH 环境变量，确保能调用用户通过 Homebrew/MacPorts 等安装的 git。
 */
function fixPath() {
  if (process.platform === 'win32') return;

  const currentPath = process.env.PATH || '';
  const shellPath = getShellPath();
  const fallbackPaths = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/opt/local/bin',
    '/usr/local/git/bin',
    expandHome('~/bin'),
    expandHome('~/.local/bin'),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];

  const seen = new Set();
  const parts = [
    ...currentPath.split(':').filter(Boolean),
    ...shellPath.split(':').filter(Boolean),
    ...fallbackPaths,
  ].filter((p) => {
    if (!p || seen.has(p)) return false;
    seen.add(p);
    return true;
  });

  process.env.PATH = parts.join(':');
}

module.exports = { fixPath };
