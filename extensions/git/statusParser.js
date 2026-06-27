/**
 * Git Status Parser (Porcelain v2)
 *
 * 解析 `git status --porcelain=v2 --branch --untracked-files=normal` 的输出。
 *
 * Porcelain v2 格式：
 *   分支头：
 *     # branch.oid <commit> | (initial)
 *     # branch.head <branch> | (detached)
 *     # branch.upstream <upstream> | (none)
 *     # branch.ab +<ahead> -<behind>
 *
 *   普通改动（1 表示 changed）：
 *     1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>\0<origPath>
 *
 *   未跟踪（?）：
 *     ? <path>
 *
 *   忽略（!）：跳过
 */

const INDEX_STATUS = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  U: 'unmerged',
  T: 'type-changed',
};

const WORKING_STATUS = {
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  U: 'unmerged',
  T: 'type-changed',
};

/**
 * 默认忽略的目录（第三方依赖、构建产物、缓存等）。
 *
 * 即使项目缺少 .gitignore（或 .gitignore 不完整），这些目录也不会作为未跟踪文件
 * 加载到源代码管理面板——避免 node_modules 这类目录刷出几万条 ? 条目卡死 IDE。
 * 仅判断路径的顶层目录，不误伤 src/node_modules 这类罕见路径。
 */
const DEFAULT_IGNORE_DIRS = new Set([
  // JS/TS 生态
  'node_modules', '.parcel-cache', '.turbo', '.next', '.nuxt', '.svelte-kit', '.astro',
  // 通用构建产物
  'dist', 'build', 'out', 'bin', 'obj', 'target', 'release',
  // 缓存/覆盖率
  '.cache', 'coverage', '.nyc_output',
  // 编辑器/IDE
  '.vscode', '.idea',
  // Python
  '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache',
  // JVM
  '.gradle', '.mvn', '.classpath',
  // Go/Rust/其他
  'vendor', 'pkg',
]);

/**
 * 判断路径是否位于默认忽略目录下。
 * @param {string} p 相对仓库根的路径，如 "node_modules/foo" 或 "node_modules/"
 * @returns {boolean}
 */
function isDefaultIgnored(p) {
  if (!p) return false;
  const top = p.split('/')[0];
  return DEFAULT_IGNORE_DIRS.has(top);
}

/**
 * @typedef {Object} GitStatusChange
 * @property {string} path        工作区路径（相对仓库根）
 * @property {string} originalPath 重命名/复制前的原始路径（如果有）
 * @property {string} indexStatus  index 中的状态
 * @property {string} workingStatus 工作区状态
 */

/**
 * @typedef {Object} GitStatus
 * @property {GitStatusChange[]} staged   已暂存
 * @property {GitStatusChange[]} changes  工作区修改
 * @property {GitStatusChange[]} merge    合并冲突
 * @property {GitStatusChange[]} untracked 未跟踪
 * @property {string} branch
 * @property {string|null} upstream
 * @property {number} ahead
 * @property {number} behind
 */

/**
 * 解析 porcelain v2 输出
 * @param {string} output
 * @returns {GitStatus}
 */
function parseStatus(output) {
  const status = {
    staged: [],
    changes: [],
    merge: [],
    untracked: [],
    branch: '',
    upstream: null,
    ahead: 0,
    behind: 0,
  };

  const lines = output.split('\n');
  let i = 0;

  // 跳过 header 注释（# 开头的行，可能有 NUL 分隔的额外行）
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('#')) break;

    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim();
      status.branch = head === '(detached)' ? '' : head;
    } else if (line.startsWith('# branch.upstream ')) {
      const upstream = line.slice('# branch.upstream '.length).trim();
      status.upstream = upstream === '(none)' ? null : upstream;
    } else if (line.startsWith('# branch.ab ')) {
      const ab = line.slice('# branch.ab '.length).trim();
      const m = ab.match(/^([+-])(\d+)\s+([+-])(\d+)/);
      if (m) {
        status.ahead = parseInt(m[2], 10);
        status.behind = parseInt(m[4], 10);
      }
    }
  }

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('? ')) {
      const untrackedPath = line.slice(2);
      // 排除第三方依赖与构建产物目录（node_modules 等），避免几万文件刷爆 UI / 卡死 IDE。
      // 即使项目缺少 .gitignore，也默认不跟踪这些目录。
      if (isDefaultIgnored(untrackedPath)) continue;
      // 未跟踪的目录（以 / 结尾）不加入列表，因为点击后无法在编辑器中打开
      if (untrackedPath.endsWith('/')) continue;
      status.untracked.push({
        path: untrackedPath,
        originalPath: null,
        indexStatus: 'untracked',
        workingStatus: 'untracked',
      });
      continue;
    }

    if (line.startsWith('! ')) continue; // ignored

    if (line.startsWith('1 ')) {
      // 普通改动：1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const parts = line.split(' ');
      if (parts.length < 9) continue;
      const xy = parts[1];
      const path = parts.slice(8).join(' ');
      // porcelain v2 中未修改的状态字符是 '.'，统一归一化为 ' ' 以保持后续判断
      const indexChar = xy[0] === '.' ? ' ' : xy[0];
      const workingChar = xy[1] === '.' ? ' ' : xy[1];

      // R/C 可能包含 NUL 分隔的 origPath
      let originalPath = null;
      const next = lines[i + 1];
      if (next && next.startsWith('2 ')) {
        // 这是普通行 2，下一行处理
      }

      const indexStatus = INDEX_STATUS[indexChar];
      const workingStatus = WORKING_STATUS[workingChar];

      // 冲突
      if (indexChar === 'U' || workingChar === 'U' ||
          (indexChar === 'A' && workingChar === 'A') ||
          (indexChar === 'D' && workingChar === 'D')) {
        status.merge.push({
          path,
          originalPath: null,
          indexStatus: indexChar,
          workingStatus: workingChar,
        });
        continue;
      }

      const change = {
        path,
        originalPath: null,
        indexStatus: indexChar,
        workingStatus: workingChar,
      };

      if (indexChar !== ' ' && indexChar !== '?') {
        status.staged.push(change);
      }
      if (workingChar !== ' ' && workingChar !== '?') {
        status.changes.push(change);
      }
    } else if (line.startsWith('2 ')) {
      // 重命名/复制：2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
      const parts = line.split(' ');
      if (parts.length < 10) continue;
      const xy = parts[1];
      // porcelain v2 中未修改的状态字符是 '.'，统一归一化为 ' ' 以保持后续判断
      const indexChar = xy[0] === '.' ? ' ' : xy[0];
      const workingChar = xy[1] === '.' ? ' ' : xy[1];
      const path = parts.slice(9).join(' ');

      // 重命名/复制时，origPath 通过 NUL 分隔（v2 格式）
      // 但按行分割后会丢失 NUL 信息；这里用 idx 中的路径字段作为原始路径
      // 真实实现需要按 NUL 重新解析。简化方案：用 porcelain v1 的旧格式处理重命名。
      const originalPath = null; // 简化：暂不处理 origPath

      const change = {
        path,
        originalPath,
        indexStatus: indexChar,
        workingStatus: workingChar,
      };

      if (indexChar !== ' ') {
        status.staged.push(change);
      }
      if (workingChar !== ' ') {
        status.changes.push(change);
      }
    }
  }

  return status;
}

/**
 * 把 GitStatus 转为 UI 友好的简易形式
 * （保留向后兼容旧的 SourceControlPanel 字段）
 */
function toLegacyShape(status) {
  const staged = {};
  const changes = {};
  const merge = {};
  const untracked = {};

  for (const c of status.staged) {
    staged[c.path] = statusToCode(c.indexStatus);
  }
  for (const c of status.changes) {
    changes[c.path] = statusToCode(c.workingStatus);
  }
  for (const c of status.merge) {
    merge[c.path] = 'U';
  }
  for (const c of status.untracked) {
    untracked[c.path] = 'U';
  }

  return { staged, changes, merge, untracked };
}

function statusToCode(s) {
  // M, A, D, R, C, U
  return s[0]?.toUpperCase() || 'M';
}

module.exports = { parseStatus, toLegacyShape };