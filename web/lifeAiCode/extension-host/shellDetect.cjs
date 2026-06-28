/**
 * 智能 Shell 命令检测（CJS 版，与 webview/src/components/codeblock/shellDetect.ts 保持同源）
 *
 * 为什么单独维护一份：
 *   1. extension-host 运行在 CommonJS 子进程（Node.js），没有 TS 编译。
 *   2. 不能直接 require 同位置的 TS 文件。
 *   3. 双份实现保持逻辑完全一致，便于后续 Agent/工具调用复用同一判断。
 *
 * 同步规则（修改时务必与 TS 版同步）：
 *   - 强排除特征 NON_SHELL_FEATURES
 *   - 强确认特征 SHELL_FEATURES
 *   - 检测顺序：先排除后确认
 *   - 中性 fallback 默认按 shell 处理
 */

/* ─── 强排除：出现这些特征就一定不是 shell 命令 ─────────────────── */

const NON_SHELL_FEATURES = [
  // JavaScript / TypeScript
  { name: 'js:import',          pattern: /^\s*(?:import|export)\s+(?:\{[^}]*\}|[^'"]+|\*\s+as)\s*(?:from\s+)?['"][^'"]+['"]/m },
  { name: 'js:export-default',  pattern: /^\s*export\s+default\s+/m },
  { name: 'js:const-let-var',   pattern: /^\s*(?:const|let|var)\s+[\w$]+\s*(?::\s*[\w<>,\[\]\s.|"']+)?\s*=\s*(?!.{0,3}$)/m },
  { name: 'js:function',        pattern: /^\s*(?:async\s+)?(?:function\s+\w+|class\s+\w+|\(\s*\)\s*=>)/m },
  { name: 'js:arrow-obj',       pattern: /^\s*[\w$]+\s*:\s*(?:\([^)]*\)|async\s*\([^)]*\)|[\w$]+)\s*=>/m },
  { name: 'js:require',         pattern: /\brequire\s*\(\s*['"][^'"]+['"]\s*\)/ },
  { name: 'ts:interface',       pattern: /^\s*(?:export\s+)?interface\s+\w+/m },
  { name: 'ts:type-alias',      pattern: /^\s*(?:export\s+)?type\s+\w+\s*=/m },
  { name: 'ts:enum',            pattern: /^\s*(?:export\s+)?enum\s+\w+/m },
  { name: 'ts:type-annotation', pattern: /:\s*(?:string|number|boolean|void|any|never|unknown|object|bigint|symbol)\s*[,;)=]|:\s*(?:string|number|boolean|void|any|never|unknown|object|bigint|symbol)\s*\|/ },
  { name: 'ts:as-cast',         pattern: /\bas\s+(?:const|[A-Z]\w*(?:<[^>]+>)?)\b/ },

  // JSX / TSX
  { name: 'jsx:component-tag',  pattern: /<[A-Z]\w*(?:\s+[^>]*)?>/ },
  { name: 'jsx:fragment',       pattern: /<>\s*[\s\S]*?<\/>/ },
  { name: 'tsx:react-import',   pattern: /from\s+['"]react['"]/ },

  // Python
  { name: 'py:def',             pattern: /^\s*def\s+\w+\s*\([^)]*\)\s*(?:->\s*[\w\[\],.\s]+)?:/m },
  { name: 'py:class',           pattern: /^\s*class\s+\w+(?:\([^)]*\))?\s*:/m },
  { name: 'py:from-import',     pattern: /^\s*from\s+[\w.]+\s+import\s+/m },
  { name: 'py:elif',            pattern: /^\s*elif\s+.+:/m },
  { name: 'py:except',          pattern: /^\s*(?:except|finally)\s*.+:/m },
  { name: 'py:dunder',          pattern: /if\s+__name__\s*==\s*['"]__main__['"]/ },
  { name: 'py:print',           pattern: /\bprint\s*\(/ },
  { name: 'py:self',            pattern: /\bself\.\w+/ },

  // Go
  { name: 'go:package',         pattern: /^\s*package\s+\w+/m },
  { name: 'go:func',            pattern: /^\s*func\s+(?:\([^)]+\)\s+)?\w+\s*\(/m },
  { name: 'go:import-block',    pattern: /^\s*import\s+\(/m },
  { name: 'go:defer-go',        pattern: /\bdefer\s+(?:go\s+)?\w+/ },

  // Rust
  { name: 'rust:fn',            pattern: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+\w+/m },
  { name: 'rust:let-mut',       pattern: /\blet\s+mut\s+\w+/ },
  { name: 'rust:use',           pattern: /^\s*(?:pub\s+)?use\s+[\w:]+(?:::\{[^}]*\})?;/m },
  { name: 'rust:impl',          pattern: /^\s*impl(?:<[^>]+>)?\s+\w+/m },
  { name: 'rust:macro',         pattern: /!\s*\([^)]*\)\s*[;{]/ },

  // C / C++
  { name: 'cpp:include',        pattern: /#include\s*[<"][^>"]+[>"]/ },
  { name: 'cpp:std',            pattern: /\bstd::/ },
  { name: 'cpp:main',           pattern: /\bint\s+main\s*\(/ },
  { name: 'cpp:cout',           pattern: /\bstd::cout\b|\bprintf\s*\(/ },

  // Java
  { name: 'java:system-out',    pattern: /System\.out\.print/ },
  { name: 'java:public-class',  pattern: /^\s*public\s+(?:static\s+)?(?:class|interface|enum)\s+\w+/m },
  { name: 'java:annotation',    pattern: /^\s*@\w+(?:\([^)]*\))?\s*$/m },

  // C#
  { name: 'cs:using-system',    pattern: /^\s*using\s+System(?:\.\w+)*;/m },
  { name: 'cs:console',         pattern: /Console\.Write(?:Line)?\s*\(/ },
  { name: 'cs:namespace',       pattern: /^\s*namespace\s+[\w.]+\s*\{/m },

  // CSS
  { name: 'css:rule-block',     pattern: /[#.\w-][\w-]*\s*\{[^}]*:[^}]*;[^}]*\}/ },
  { name: 'css:at-rule',        pattern: /^\s*@(?:media|keyframes|import|charset|font-face|supports|layer)\s/m },

  // HTML
  { name: 'html:doctype',       pattern: /<!DOCTYPE\s+html/i },
  { name: 'html:paired-tag',    pattern: /<\/?(?:html|head|body|div|span|p|a|script|style|link|meta)[^>]*>/i },

  // JSON
  { name: 'json:object',        pattern: /^\s*\{[\s\S]*\}\s*$/ },
  { name: 'json:array',         pattern: /^\s*\[[\s\S]*\]\s*$/ },

  // YAML
  { name: 'yaml:key-value',     pattern: /^\w[\w-]*:\s+\S/m },

  // SQL
  { name: 'sql:statement',      pattern: /\b(?:SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+(?:TABLE|INDEX|VIEW|OR\s+REPLACE\s+FUNCTION))\b/i },
];

/* ─── 强确认：这些特征出现就一定是 shell 命令 ───────────────────── */

const SHELL_FEATURES = [
  { name: 'shebang',            pattern: /^#!.*$/m },
  { name: 'pkg-manager',        pattern: /^\s*(?:npm|pnpm|yarn|bun|npx|yarnpnp)\s+(?:install|i|add|remove|rm|run|exec|create|init|update|test|build|dev|start|ci|publish|pack|uninstall|ls|list|outdated|audit|fund|version)\s/m },
  { name: 'vcs-git',            pattern: /^\s*git\s+(?:clone|pull|push|fetch|checkout|branch|status|add|commit|log|diff|merge|rebase|reset|stash|tag|init|remote|config|rm|mv|restore|switch)\s/m },
  { name: 'net-curl-wget',      pattern: /^\s*(?:curl|wget|fetch|http|https)\s/m },
  { name: 'file-ops',           pattern: /^\s*(?:cd|ls|cat|head|tail|less|more|file|mkdir|touch|rm|cp|mv|chmod|chown|ln|pwd|echo|printf|basename|dirname|realpath|stat|find|grep|egrep|fgrep|rg|fd|ag)\s/m },
  { name: 'system',             pattern: /^\s*(?:sudo|apt|apt-get|brew|dnf|yum|pacman|zypper|apk|systemctl|service|journalctl|export|source|eval|exec|env|set|unset|alias)\s/m },
  { name: 'runtime',            pattern: /^\s*(?:node|deno|bun|tsx|ts-node|tsc|eslint|prettier|jest|vitest|mocha|webpack|vite|rollup|parcel|esbuild|swc|babel)\s/m },
  { name: 'runtime-scripting',  pattern: /^\s*(?:python|python3|py|pip|pip3|conda|poetry|uv|ruby|rbenv|gem|rails|php|composer|go|rustc|cargo|java|javac|mvn|gradle|scala|perl|lua|swift)\s/m },
  { name: 'container',          pattern: /^\s*(?:docker|docker-compose|podman|kubectl|helm|terraform|ansible|vagrant|nomad|consul)\s/m },
  { name: 'archive',            pattern: /^\s*(?:tar|zip|unzip|gzip|gunzip|bzip2|xz|7z|rar)\s/m },
  { name: 'process',            pattern: /^\s*(?:ps|kill|killall|pkill|top|htop|jobs|nohup|watch|crontab|at|bg|fg|wait|trap|shift|read|true|false|test|\[)\s/m },
  { name: 'prompt-dollar',      pattern: /^\s*\$\s+\S/m },
  { name: 'prompt-angle',       pattern: /^\s*>\s+\S/m },
  { name: 'line-continuation',  pattern: /\\\s*$/m },
  { name: 'pipe-chain',         pattern: /\|\s*(?:grep|sed|awk|head|tail|sort|uniq|wc|xargs|tee|cut|tr|less|more|rg|find|cat)\b/ },
  { name: 'shell-if',           pattern: /^\s*if\s+\[\s/m },
  { name: 'shell-for',          pattern: /^\s*for\s+\w+\s+in\s+/m },
  { name: 'shell-while',        pattern: /^\s*(?:while|until)\s+.+;\s*do\s*$/m },
  { name: 'shell-case',         pattern: /^\s*case\s+\$\w+\s+in\s*$/m },
  { name: 'shell-function',     pattern: /^\s*(?:function\s+)?\w+\s*\(\s*\)\s*\{/m },
  { name: 'shell-redirect',     pattern: /(?<![<>])>{1,2}\s*[\w./~$-]+/ },
  { name: 'shell-var',          pattern: /\$\{?\w+\}?(?:\s|;|$)/m },
  { name: 'cmd-chain',          pattern: /\s*(?:&&|\|\|)\s*\S/ },
];

/**
 * 智能检测一段代码是否是真正的 shell/终端命令。
 *
 * 算法：
 * 1. 强排除：扫描所有非 shell 语言特征，任一命中 → 不是 shell
 * 2. 强确认：扫描所有 shell 强特征，任一命中 → 是 shell
 * 3. 中性 fallback：默认按 shell 处理（保守估计）
 *
 * @param {string} code 任意代码字符串
 * @returns {boolean} true 表示代码看起来是 shell 命令
 */
function isShellCommand(code) {
  const trimmed = String(code || '').trim();
  if (!trimmed) return false;

  // 1. 强排除
  for (const { pattern } of NON_SHELL_FEATURES) {
    if (pattern.test(trimmed) || pattern.test(code)) {
      return false;
    }
  }

  // 2. 强确认
  for (const { pattern } of SHELL_FEATURES) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  // 3. 中性 fallback：保守估计按 shell 处理
  return true;
}

/**
 * 提取可执行命令的简短描述（用于 ShellSkill 工具提示）。
 * @param {string} code
 * @returns {string} 截取前 3 个 token 作为描述
 */
function describeShellCommand(code) {
  const lines = String(code || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';
  const first = lines[0].replace(/^[>$]\s*/, '').replace(/\s*\\$/, '').trim();
  const tokens = first.split(/\s+/).slice(0, 3);
  return tokens.join(' ');
}

module.exports = { isShellCommand, describeShellCommand, NON_SHELL_FEATURES, SHELL_FEATURES };
