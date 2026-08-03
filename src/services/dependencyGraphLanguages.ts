/**
 * 依赖图的多语言分析器注册表：
 * 每种语言实现 extractSpecifiers（从源码提取引入说明符）与
 * resolveSpecifier（把说明符解析为项目内相对路径），均为纯同步启发式正则解析，
 * 不引入 AST 依赖；解析失败一律返回 null（该说明符不参与构图）。
 */

/** posix 路径归一化（处理 ./ 与 ../） */
export function normalizePath(p: string): string {
  const parts = p.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

export interface LanguageAnalyzer {
  /** 语言标识（调试用） */
  id: string;
  /** 该语言参与依赖分析的文件扩展名（小写、带点） */
  extensions: string[];
  /** 提取文件中的引入说明符（模块名/相对路径，原始书写形式） */
  extractSpecifiers(content: string): string[];
  /**
   * 把说明符解析为项目内相对文件路径（posix 分隔符）。
   * fileSet 为项目内全部文件路径集合；解析不到（外部包、内置模块等）返回 null。
   */
  resolveSpecifier(spec: string, fromRel: string, fileSet: Set<string>): string | null;
}

/** 剔除块注释与行注释，减少引入语句的误匹配（行注释要求前导字符不是 `:`，避免误伤 http://） */
export function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript
// ---------------------------------------------------------------------------

const TS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
/** TS/JS 代码文件扩展名匹配（依赖图的重命名同步仅对 TS/JS 生效，故单独导出） */
export const TS_FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** import/require 说明符提取（在剔除注释后的内容上执行） */
const TS_SPECIFIER_PATTERNS = [
  // import ... from '...' / import '...'
  /\bimport\s+(?:[\w$*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g,
  // export ... from '...'
  /\bexport\s+(?:[\w$*{}\s,]+|\*)\s+from\s+['"]([^'"]+)['"]/g,
  // import('...')
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // require('...')
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** 提取 TS/JS 文件中的模块说明符 */
export function extractTsSpecifiers(content: string): string[] {
  const stripped = stripComments(content);
  const specifiers = new Set<string>();
  for (const pattern of TS_SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(stripped)) !== null) {
      specifiers.add(match[1]);
    }
  }
  return Array.from(specifiers);
}

/**
 * 把相对说明符解析为项目内的相对文件路径（TS 解析规则：补扩展名 / index 文件）。
 * 包名引用（非 ./ ../ 开头）返回 null。
 */
export function resolveTsSpecifier(
  spec: string,
  fromRel: string,
  fileSet: Set<string>
): string | null {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
  const fromDir = fromRel.includes('/') ? fromRel.slice(0, fromRel.lastIndexOf('/')) : '';
  const joined = normalizePath(fromDir ? `${fromDir}/${spec}` : spec);
  if (fileSet.has(joined) && TS_FILE_RE.test(joined)) return joined;
  for (const ext of TS_EXTENSIONS) {
    if (fileSet.has(joined + ext)) return joined + ext;
  }
  for (const ext of TS_EXTENSIONS) {
    if (fileSet.has(`${joined}/index${ext}`)) return `${joined}/index${ext}`;
  }
  return null;
}

const tsAnalyzer: LanguageAnalyzer = {
  id: 'typescript',
  extensions: TS_EXTENSIONS,
  extractSpecifiers: extractTsSpecifiers,
  resolveSpecifier: resolveTsSpecifier,
};

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

/**
 * 提取 Python 的引入说明符：
 * - `import a.b` / `import a.b as c` → 说明符 `a.b`
 * - `from a.b import x` → 说明符 `a.b`
 * - `from . import x` / `from .a import x` → 说明符 `.` / `.a`（保留相对层级点号）
 * - `from ..a import x` → 说明符 `..a`
 */
function extractPySpecifiers(content: string): string[] {
  // 先剔除 # 行注释（import 行尾注释会污染正则匹配）
  const stripped = content.replace(/#.*$/gm, '');
  const specifiers = new Set<string>();
  // from X import a, b（X 可为点号相对路径或点分模块名）
  const fromRe = /^\s*from\s+([.\w]+)\s+import\s+([^\n]+)$/gm;
  // import X（行内可逗号分隔多个，逐个提取；字符类不含 \n，防吞行）
  const importRe = /^\s*import\s+([\w., \t]+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = fromRe.exec(stripped)) !== null) {
    const base = match[1];
    specifiers.add(base);
    // a/b 可能是 X 包下的子模块（如 from . import sibling），合并发射候选，
    // 解析失败自然返回 null，不会产生误边
    for (const part of match[2].replace(/[()]/g, '').split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name && name !== '*' && /^\w+$/.test(name)) {
        // 点号结尾的相对前缀直接拼接（'.' + 'sibling' = '.sibling'，保持相对层级语义）
        specifiers.add(base.endsWith('.') ? `${base}${name}` : `${base}.${name}`);
      }
    }
  }
  while ((match = importRe.exec(stripped)) !== null) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) specifiers.add(name);
    }
  }
  return Array.from(specifiers);
}

/** 把点分模块名解析为候选相对路径（a.b → a/b.py、a/b/__init__.py 两种形态） */
function resolvePyModule(baseDir: string, modulePath: string, fileSet: Set<string>): string | null {
  const asFile = normalizePath(baseDir ? `${baseDir}/${modulePath}.py` : `${modulePath}.py`);
  if (fileSet.has(asFile)) return asFile;
  const asPkg = normalizePath(
    baseDir ? `${baseDir}/${modulePath}/__init__.py` : `${modulePath}/__init__.py`
  );
  if (fileSet.has(asPkg)) return asPkg;
  return null;
}

/**
 * 解析 Python 说明符：
 * - 相对引入（前导点号）：点号个数 = 上溯层数，其余部分为点分模块路径；
 * - 绝对引入：先按「当前文件同级目录」解析（常见扁平脚本布局，如 app.py import db_config），
 *   再按「项目根」解析（包式布局）。
 * 无法覆盖 sys.path 动态注入、site-packages 等运行时机制（返回 null）。
 */
function resolvePySpecifier(spec: string, fromRel: string, fileSet: Set<string>): string | null {
  const fromDir = fromRel.includes('/') ? fromRel.slice(0, fromRel.lastIndexOf('/')) : '';
  const dotMatch = /^(\.+)(.*)$/.exec(spec);
  if (dotMatch) {
    // 相对引入：上溯 dotMatch[1].length - 1 层
    let dir = fromDir;
    for (let i = 1; i < dotMatch[1].length; i++) {
      dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
    }
    const modulePath = dotMatch[2].replace(/\./g, '/');
    return resolvePyModule(dir, modulePath, fileSet);
  }
  const modulePath = spec.replace(/\./g, '/');
  return resolvePyModule(fromDir, modulePath, fileSet) ?? resolvePyModule('', modulePath, fileSet);
}

const pyAnalyzer: LanguageAnalyzer = {
  id: 'python',
  extensions: ['.py'],
  extractSpecifiers: extractPySpecifiers,
  resolveSpecifier: resolvePySpecifier,
};

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

/** 提取 Java 的 import 说明符（含 static import；跳过通配符 com.foo.*） */
function extractJavaSpecifiers(content: string): string[] {
  const stripped = stripComments(content);
  const specifiers = new Set<string>();
  const re = /^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped)) !== null) {
    if (!match[1].endsWith('.*')) specifiers.add(match[1]);
  }
  return Array.from(specifiers);
}

/**
 * 解析 Java 说明符：com.foo.Bar → com/foo/Bar.java，
 * 对项目文件集做 endsWith 后缀匹配，兼容 src/main/java 等任意源根前缀。
 * 同包类无需 import、JDK 类（java.* / javax.*）不在项目内，均解析不到返回 null。
 */
function resolveJavaSpecifier(spec: string, _fromRel: string, fileSet: Set<string>): string | null {
  const suffix = `/${spec.replace(/\./g, '/')}.java`;
  for (const file of fileSet) {
    if (file.endsWith(suffix)) return file;
  }
  return null;
}

const javaAnalyzer: LanguageAnalyzer = {
  id: 'java',
  extensions: ['.java'],
  extractSpecifiers: extractJavaSpecifiers,
  resolveSpecifier: resolveJavaSpecifier,
};

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

/**
 * 提取 Rust 的引入说明符（统一用 :: 路径表示，resolve 阶段再区分锚点）：
 * - `mod foo;` → `mod::foo`
 * - `use crate::a::b` / `use super::a` / `use self::a` → 原样路径
 * use 路径带花括号（use crate::a::{b, c}）时取花括号前缀，按模块级连线（不细化到项）。
 */
function extractRustSpecifiers(content: string): string[] {
  const stripped = stripComments(content);
  const specifiers = new Set<string>();
  const modRe = /^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm;
  const useRe = /\buse\s+((?:crate|super|self)::[\w:]+)/g;
  let match: RegExpExecArray | null;
  while ((match = modRe.exec(stripped)) !== null) {
    specifiers.add(`mod::${match[1]}`);
  }
  while ((match = useRe.exec(stripped)) !== null) {
    specifiers.add(match[1]);
  }
  return Array.from(specifiers);
}

/** 在 baseDir 下查找模块文件：base/name.rs 或 base/name/mod.rs */
function resolveRustModule(baseDir: string, name: string, fileSet: Set<string>): string | null {
  const asFile = normalizePath(baseDir ? `${baseDir}/${name}.rs` : `${name}.rs`);
  if (fileSet.has(asFile)) return asFile;
  const asMod = normalizePath(baseDir ? `${baseDir}/${name}/mod.rs` : `${name}/mod.rs`);
  if (fileSet.has(asMod)) return asMod;
  return null;
}

/**
 * 解析 Rust 说明符：
 * - `mod::foo`：相对当前文件目录（mod.rs/main.rs/lib.rs 的子模块在其同名目录下，
 *   此处统一按当前目录处理，foo/mod.rs 候选已覆盖目录式模块）；
 * - `crate::a::b`：以 src/ 为 crate 根（Cargo 惯例）逐级查找；
 * - `super::a`：上溯一层后逐级查找；`self::a`：当前目录逐级查找。
 * 宏生成模块、`#[path]` 属性、extern crate 不在启发式覆盖范围内（返回 null）。
 */
function resolveRustSpecifier(spec: string, fromRel: string, fileSet: Set<string>): string | null {
  const fromDir = fromRel.includes('/') ? fromRel.slice(0, fromRel.lastIndexOf('/')) : '';
  let baseDir: string;
  let segments: string[];
  if (spec.startsWith('mod::')) {
    return resolveRustModule(fromDir, spec.slice(5), fileSet);
  } else if (spec.startsWith('crate::')) {
    // crate 根按 src/ 惯例定位：取路径中最后一个 src 目录，找不到则按项目根
    const parts = fromRel.split('/');
    const srcIdx = parts.lastIndexOf('src');
    baseDir = srcIdx >= 0 ? parts.slice(0, srcIdx + 1).join('/') : '';
    segments = spec.slice(7).split('::');
  } else if (spec.startsWith('super::')) {
    baseDir = fromDir.includes('/') ? fromDir.slice(0, fromDir.lastIndexOf('/')) : '';
    segments = spec.slice(7).split('::');
  } else if (spec.startsWith('self::')) {
    baseDir = fromDir;
    segments = spec.slice(6).split('::');
  } else {
    return null;
  }
  // 逐级下探：
  // - seg 命中文件模块（seg.rs）：其后若还有段则是模块内的项，退化返回该文件（模块级连线）；
  // - seg 命中目录模块（seg/mod.rs）：下探进入该目录继续；
  // - 末段未命中：可能是当前目录模块内的项，退化到当前目录的 mod.rs。
  let dir = baseDir;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const last = i === segments.length - 1;
    const resolved = resolveRustModule(dir, seg, fileSet);
    if (resolved) {
      if (last || !resolved.endsWith('/mod.rs')) return resolved;
      dir = normalizePath(dir ? `${dir}/${seg}` : seg);
      continue;
    }
    if (last && dir !== baseDir) {
      const modFile = normalizePath(dir ? `${dir}/mod.rs` : 'mod.rs');
      if (fileSet.has(modFile)) return modFile;
    }
    return null;
  }
  return null;
}

const rustAnalyzer: LanguageAnalyzer = {
  id: 'rust',
  extensions: ['.rs'],
  extractSpecifiers: extractRustSpecifiers,
  resolveSpecifier: resolveRustSpecifier,
};

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

/**
 * 提取 Go 的 import 说明符：
 * - 单行：`import "fmt"` / `import alias "path"` / `import . "path"` / `import _ "path"`
 * - 块：`import ( "fmt" ... )`，提取块内全部字符串字面量
 */
function extractGoSpecifiers(content: string): string[] {
  const stripped = stripComments(content);
  const specifiers = new Set<string>();
  const blockRe = /\bimport\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(stripped)) !== null) {
    const strRe = /"([^"]+)"/g;
    let sm: RegExpExecArray | null;
    while ((sm = strRe.exec(match[1])) !== null) {
      specifiers.add(sm[1]);
    }
  }
  const lineRe = /^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm;
  while ((match = lineRe.exec(stripped)) !== null) {
    specifiers.add(match[1]);
  }
  return Array.from(specifiers);
}

/**
 * 解析 Go import 路径（包级引用，按目录后缀匹配）：
 * import 路径的最后若干段与项目内 .go 文件所在目录做后缀匹配
 * （模块路径 example.com/myapp/pkg/foo 可命中项目内 pkg/foo 目录），
 * 取能唯一命中的最长后缀；命中目录的代表文件作为连线目标
 * （优先 <末段>.go，否则目录内排序首个非 _test.go 文件）。
 * 标准库（fmt、encoding/json 等）与第三方包不在项目目录内，返回 null；
 * 后缀匹配出现多个候选目录时视为歧义，返回 null。
 */
function resolveGoSpecifier(spec: string, _fromRel: string, fileSet: Set<string>): string | null {
  const segs = spec.split('/');
  // 项目内全部包含非测试 .go 文件的目录（dir → 排序后的文件列表）
  const dirs = new Map<string, string[]>();
  for (const file of fileSet) {
    if (!file.endsWith('.go') || file.endsWith('_test.go')) continue;
    const slash = file.lastIndexOf('/');
    if (slash < 0) continue;
    const dir = file.slice(0, slash);
    const list = dirs.get(dir);
    if (list) list.push(file);
    else dirs.set(dir, [file]);
  }
  for (const list of dirs.values()) list.sort();
  for (let k = segs.length; k >= 1; k--) {
    const suffix = `/${segs.slice(-k).join('/')}`;
    const matched: string[] = [];
    for (const dir of dirs.keys()) {
      if (dir.endsWith(suffix)) matched.push(dir);
    }
    if (matched.length === 1) {
      const dir = matched[0];
      const files = dirs.get(dir)!;
      const primary = `${dir}/${segs[segs.length - 1]}.go`;
      return files.includes(primary) ? primary : files[0];
    }
    // 更短的后缀只会匹配更多目录，已歧义则不再下探
    if (matched.length > 1) return null;
  }
  return null;
}

const goAnalyzer: LanguageAnalyzer = {
  id: 'go',
  extensions: ['.go'],
  extractSpecifiers: extractGoSpecifiers,
  resolveSpecifier: resolveGoSpecifier,
};

// ---------------------------------------------------------------------------
// C / C++
// ---------------------------------------------------------------------------

/** 提取 C/C++ 的 #include "..." 引号包含（尖括号 <...> 为系统头，跳过） */
function extractCSpecifiers(content: string): string[] {
  const stripped = stripComments(content);
  const specifiers = new Set<string>();
  const re = /^\s*#\s*include\s+"([^"]+)"/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped)) !== null) {
    specifiers.add(match[1]);
  }
  return Array.from(specifiers);
}

/**
 * 解析 C/C++ 引号包含：先按当前文件目录相对解析，再按项目根解析。
 * 编译参数 -I 注入的 include 路径不在覆盖范围内（返回 null）。
 */
function resolveCSpecifier(spec: string, fromRel: string, fileSet: Set<string>): string | null {
  const fromDir = fromRel.includes('/') ? fromRel.slice(0, fromRel.lastIndexOf('/')) : '';
  const local = normalizePath(fromDir ? `${fromDir}/${spec}` : spec);
  if (fileSet.has(local)) return local;
  const rootRel = normalizePath(spec);
  if (fileSet.has(rootRel)) return rootRel;
  return null;
}

const cAnalyzer: LanguageAnalyzer = {
  id: 'c',
  extensions: ['.c', '.h', '.cpp', '.hpp', '.cc', '.hh'],
  extractSpecifiers: extractCSpecifiers,
  resolveSpecifier: resolveCSpecifier,
};

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

/** 全部语言分析器（TS/JS 必须在首位，保证重叠扩展名优先命中 TS 规则） */
export const LANGUAGE_ANALYZERS: LanguageAnalyzer[] = [
  tsAnalyzer,
  pyAnalyzer,
  javaAnalyzer,
  rustAnalyzer,
  goAnalyzer,
  cAnalyzer,
];

/** 扩展名 → 分析器索引（小写扩展名） */
const EXT_TO_ANALYZER = new Map<string, LanguageAnalyzer>();
for (const analyzer of LANGUAGE_ANALYZERS) {
  for (const ext of analyzer.extensions) {
    if (!EXT_TO_ANALYZER.has(ext)) EXT_TO_ANALYZER.set(ext, analyzer);
  }
}

/** 参与依赖分析的全部代码文件扩展名 */
export const CODE_EXTENSIONS = Array.from(EXT_TO_ANALYZER.keys());

/** 按文件名取对应语言分析器，无法分析返回 null */
export function getAnalyzerForFile(name: string): LanguageAnalyzer | null {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return EXT_TO_ANALYZER.get(name.slice(dot).toLowerCase()) ?? null;
}
