/* ─────────────────────────────────────────────────────────────────── */
/*  智能 Shell 命令检测（统一入口）                                    */
/* ─────────────────────────────────────────────────────────────────── */
/*  解决"被错误识别为 bash 的非 shell 代码被当成终端命令"的问题：
 *    - import/export/const 等 JS/TS 代码被 detectCodeLanguage 误识别为 bash
 *    - ShellSkill 的 languages 包含 'bash'，于是显示"执行"按钮
 *    - 点击后实际执行 npm/yarn 等命令会报错，或者把 JS 代码当 shell 执行
 *
 *  规则（强排除优先）：
 *  1. 强排除：一旦出现主流语言（JS/TS/Python/Go/Rust/Java/C/C++/C#/
 *     CSS/HTML/JSON/YAML/SQL）的强特征 → 不是 shell
 *  2. 强确认：shebang / 常见 shell 命令前缀 / $ 提示符 / 管道 / 串联 → 是 shell
 *  3. 中性：未匹配到任何特征 → 默认按 shell 处理
 *     （保守估计，宁可少误激活，不要把 shell 命令漏掉）
 *
 *  纯函数设计，无外部依赖：前端 ESM 和后端 CJS 可复用同一逻辑。   */

/* eslint-disable no-useless-escape */

/* ─── 强排除：出现这些特征就一定不是 shell 命令 ─────────────────── */

const NON_SHELL_FEATURES: Array<{ name: string; pattern: RegExp }> = [
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

  // JSON（仅当整体看起来是单个 JSON 对象/数组时）
  { name: 'json:object',        pattern: /^\s*\{[\s\S]*\}\s*$/ },
  { name: 'json:array',         pattern: /^\s*\[[\s\S]*\]\s*$/ },

  // YAML
  { name: 'yaml:key-value',     pattern: /^\w[\w-]*:\s+\S/m },

  // SQL
  { name: 'sql:statement',      pattern: /\b(?:SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+(?:TABLE|INDEX|VIEW|OR\s+REPLACE\s+FUNCTION))\b/i },
];

/* ─── 强确认：这些特征出现就一定是 shell 命令 ───────────────────── */

const SHELL_FEATURES: Array<{ name: string; pattern: RegExp }> = [
  // shebang 行（任何 #! 开头的行都视为可执行脚本，多为 shell）
  { name: 'shebang',            pattern: /^#!.*$/m },

  // 常见 shell 命令前缀（行首）
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
  // 注：上面 \[ 的转义是有意的——避免被某些 IDE / 格式化工具误删字符类开始符

  // 命令提示符 / 行继续符
  { name: 'prompt-dollar',      pattern: /^\s*\$\s+\S/m },
  { name: 'prompt-angle',       pattern: /^\s*>\s+\S/m },
  { name: 'line-continuation',  pattern: /\\\s*$/m },
  { name: 'pipe-chain',         pattern: /\|\s*(?:grep|sed|awk|head|tail|sort|uniq|wc|xargs|tee|cut|tr|less|more|rg|find|cat)\b/ },

  // 控制结构
  // 注：\[ 的转义是有意的——避免被某些 IDE / 格式化工具误删字符类开始符
  { name: 'shell-if',           pattern: /^\s*if\s+\[\s/m },
  { name: 'shell-for',          pattern: /^\s*for\s+\w+\s+in\s+/m },
  { name: 'shell-while',        pattern: /^\s*(?:while|until)\s+.+;\s*do\s*$/m },
  { name: 'shell-case',         pattern: /^\s*case\s+\$\w+\s+in\s*$/m },
  { name: 'shell-function',     pattern: /^\s*(?:function\s+)?\w+\s*\(\s*\)\s*\{/m },

  // 变量与重定向
  { name: 'shell-redirect',     pattern: /(?<![<>])>{1,2}\s*[\w./~$-]+/ },
  { name: 'shell-var',          pattern: /\$\{?\w+\}?(?:\s|;|$)/m },

  // 通用串联（&& || ; 链接多条命令，且没有 JS 强特征）
  { name: 'cmd-chain',          pattern: /\s*(?:&&|\|\|)\s*\S/ },
];

/* ─── 主检测函数 ──────────────────────────────────────────────────── */

/**
 * 智能检测一段代码是否是真正的 shell/终端命令。
 *
 * 算法：
 * 1. 强排除：扫描所有非 shell 语言特征，任一命中 → 不是 shell
 * 2. 强确认：扫描所有 shell 强特征，任一命中 → 是 shell
 * 3. 中性 fallback：默认按 shell 处理（保守估计）
 *
 * @param code 任意代码字符串
 * @returns true 表示代码看起来是 shell 命令，可激活 ShellSkill
 */
export function isShellCommand(code: string): boolean {
  const trimmed = code.trim();
  if (!trimmed) return false;

  // 1. 强排除：出现主流语言特征 → 不是 shell
  for (const { pattern } of NON_SHELL_FEATURES) {
    if (pattern.test(trimmed) || pattern.test(code)) {
      return false;
    }
  }

  // 2. 强确认：shebang / 命令前缀 / 提示符 / 控制结构 / 管道 → 是 shell
  for (const { pattern } of SHELL_FEATURES) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  // 3. 中性 fallback：未匹配到任何特征 → 保守估计按 shell 处理
  // 场景：单行无换行的命令（如 `ls -la`），或纯注释/空行。
  // 这种情况下宁可激活"执行"按钮让用户主动确认，也不要把真 shell 命令漏掉。
  return true;
}

/**
 * 判断代码是否包含 shell 命令链（多行连续命令）。
 * 与 isShellCommand 的区别：仅返回 true 表示至少有一条命令通过强确认。
 */
export function hasShellCommand(code: string): boolean {
  const trimmed = code.trim();
  if (!trimmed) return false;

  // 任何主流语言强特征 → 一定不是纯 shell
  for (const { pattern } of NON_SHELL_FEATURES) {
    if (pattern.test(trimmed) || pattern.test(code)) {
      return false;
    }
  }

  // 任一 shell 强特征命中
  for (const { pattern } of SHELL_FEATURES) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  return false;
}

/**
 * 提取可执行命令的简短描述（用于 ShellSkill 工具提示）。
 * @example describeShellCommand('npm install --save-dev vitest')
 *   → 'npm install'
 */
export function describeShellCommand(code: string): string {
  const lines = code.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';
  const first = lines[0].replace(/^[>$]\s*/, '').replace(/\s*\\$/, '').trim();
  // 截取前两个 token（命令 + 子命令）作为简短描述
  const tokens = first.split(/\s+/).slice(0, 3);
  return tokens.join(' ');
}
