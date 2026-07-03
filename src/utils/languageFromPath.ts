/**
 * 根据文件路径推断 Monaco Editor 的语言 ID
 *
 * 设计原则：
 * - 单点维护扩展名 → 语言 ID 的映射，避免在多处复制粘贴漏掉分支
 * - 大小写不敏感
 * - 支持多语言项目常见扩展（含 .mts/.cts 等 TS 变体）
 * - 对特殊文件名（如 Dockerfile、tsconfig.json）走完整名匹配
 * - 兼容正反斜杠路径
 *
 * 返回 Monaco 支持的语言 ID（如 'typescript'、'javascript'、'json'），
 * 未识别时返回 'plaintext'。
 */

/** 文件扩展名 → Monaco 语言 ID（大小写不敏感） */
const EXT_LANG_MAP: Record<string, string> = {
  // TypeScript 系列（含 ESM/CJS 变体）
  ts: 'typescript',
  tsx: 'typescript',  // §统一 typescript：Monarch tokenizer 提供同步基础高亮，JSX 由 buildJsxDecorations 补色
  mts: 'typescript',
  cts: 'typescript',

  // JavaScript 系列
  js: 'javascript',
  jsx: 'javascript',  // §同上：Monarch tokenizer + buildJsxDecorations
  mjs: 'javascript',
  cjs: 'javascript',

  // 样式
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  styl: 'stylus',

  // 模板 / 标记
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  vue: 'html',
  svelte: 'html',
  md: 'markdown',
  markdown: 'markdown',

  // 数据 / 配置
  json: 'json',
  json5: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  env: 'shell',

  // 后端 / 系统
  py: 'python',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  cs: 'csharp',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  php: 'php',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  sql: 'sql',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  dart: 'dart',
  lua: 'lua',
  r: 'r',
  pl: 'perl',
  perl: 'perl',
};

/** 完整文件名 → Monaco 语言 ID（精确匹配，区分大小写以匹配 Unix 习惯） */
const FILENAME_LANG_MAP: Record<string, string> = {
  // Unix 约定首字母大写的构建脚本
  Dockerfile: 'dockerfile',
  Containerfile: 'dockerfile',
  Makefile: 'makefile',
  GNUmakefile: 'makefile',
  Rakefile: 'ruby',
  Gemfile: 'ruby',
  Vagrantfile: 'ruby',
  Procfile: 'ruby',
  Brewfile: 'ruby',
  CMakeLists: 'cpp',
  // JS/TS 生态的 JSON 配置文件
  'tsconfig.json': 'json',
  'tsconfig.base.json': 'json',
  'tsconfig.build.json': 'json',
  'jsconfig.json': 'json',
  'package.json': 'json',
  'package-lock.json': 'json',
  'composer.json': 'json',
  '.eslintrc': 'json',
  '.eslintrc.json': 'json',
  '.prettierrc': 'json',
  '.babelrc': 'json',
};

/**
 * 从完整路径中提取不带路径分隔符的文件名。
 * 支持 / 与 \ 两种分隔符（兼容 Windows 路径字符串）。
 */
function getBaseName(p: string): string {
  if (!p) return '';
  // 反斜杠先转成正斜杠，再取最后一段
  const normalized = p.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

/**
 * 从文件名中提取扩展名（小写，不含点）。
 * - 'App.TSX' → 'tsx'
 * - '.eslintrc' → ''（隐藏文件无扩展名）
 * - 'foo.bar.baz' → 'baz'
 */
function getExtension(name: string): string {
  if (!name) return '';
  // 跳过以点开头的隐藏文件名（如 .eslintrc）的第一个段
  const dotIdx = name.lastIndexOf('.');
  if (dotIdx <= 0) return '';
  return name.slice(dotIdx + 1).toLowerCase();
}

/**
 * 推断文件的 Monaco 语言 ID
 *
 * @param filePath 完整文件路径或纯文件名
 * @returns Monaco 支持的语言 ID，未识别返回 'plaintext'
 */
export function getLanguageFromPath(filePath: string | null | undefined): string {
  if (!filePath || typeof filePath !== 'string') return 'plaintext';

  const baseName = getBaseName(filePath);
  if (!baseName) return 'plaintext';

  // 1. 优先按完整文件名匹配（处理 Dockerfile、tsconfig.json 等）
  if (FILENAME_LANG_MAP[baseName] !== undefined) {
    return FILENAME_LANG_MAP[baseName];
  }
  // 同时兼容小写文件名（部分项目使用全小写 makefile/dockerfile）
  const lower = baseName.toLowerCase();
  if (FILENAME_LANG_MAP[lower] !== undefined) {
    return FILENAME_LANG_MAP[lower];
  }

  // 2. 按扩展名匹配
  const ext = getExtension(baseName);
  if (ext && EXT_LANG_MAP[ext] !== undefined) {
    return EXT_LANG_MAP[ext];
  }

  return 'plaintext';
}