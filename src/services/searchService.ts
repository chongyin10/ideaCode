/**
 * 搜索服务层
 * 
 * 封装算法层，为 UI 组件提供高阶搜索能力：
 * - 文件快速打开 (QuickOpen)
 * - 当前文件内查找 (Find in File)
 * - 多文件全文搜索 (Search in Files)
 */

import {
  FuzzySearchEngine,
  PathTrie,
  searchInText,
  multiPatternSearch,
  type MatchResult,
  type SearchOptions,
} from '../utils/algorithms';
import type { FileEntry } from './fileService';
import { readFile } from './fileService';

/* ────────────────────────────────────────────── */
/*  QuickOpen：文件快速定位                        */
/* ────────────────────────────────────────────── */

export interface QuickOpenItem {
  path: string;
  name: string;
  score: number;
  /** 匹配位置高亮 */
  highlights: boolean[];
}

const fuzzyEngine = new FuzzySearchEngine();

/**
 * 在文件列表中快速定位
 * 
 * 使用 Fuzzy Search 算法，支持不连续字符匹配：
 * 输入 "apptsx" → 匹配 "src/App.tsx"
 */
export function quickOpenFiles(
  query: string,
  files: string[]
): QuickOpenItem[] {
  if (!query.trim()) {
    return files.slice(0, 20).map((path) => ({
      path,
      name: path.split('/').pop() || path,
      score: 0,
      highlights: new Array(path.length).fill(false),
    }));
  }

  const results = fuzzyEngine.search(query, files);

  return results.map((r) => ({
    path: r.target,
    name: r.target.split('/').pop() || r.target,
    score: r.score,
    highlights: r.matches,
  }));
}

/**
 * 构建文件路径前缀树（用于自动补全）
 */
export function buildFileTrie(files: string[]): PathTrie {
  const trie = new PathTrie();
  for (const file of files) {
    trie.insertPath(file, 0);
  }
  return trie;
}

/* ────────────────────────────────────────────── */
/*  Find in File：当前文件内查找                   */
/* ────────────────────────────────────────────── */

export interface FindResult {
  line: number;
  column: number;
  text: string;
  match: MatchResult;
}

/**
 * 在文件内容中查找关键字
 * 
 * 使用 Boyer-Moore-Horspool 算法，平均时间复杂度 O(n/m)
 */
export function findInFile(
  content: string,
  pattern: string,
  options: SearchOptions = {}
): FindResult[] {
  const matches = searchInText(content, pattern, options);
  const results: FindResult[] = [];

  for (const match of matches) {
    // 计算行号和列号
    const before = content.substring(0, match.index);
    const line = before.split('\n').length;
    const lastNewline = before.lastIndexOf('\n');
    const column = lastNewline >= 0 ? match.index - lastNewline : match.index + 1;

    // 提取上下文（前后各 30 字符）
    const contextStart = Math.max(0, match.index - 30);
    const contextEnd = Math.min(content.length, match.index + match.length + 30);
    const context = content.substring(contextStart, contextEnd);

    results.push({
      line,
      column,
      text: context,
      match,
    });
  }

  return results;
}

/**
 * 多关键字批量查找
 */
export function findMultiplePatterns(
  content: string,
  patterns: string[]
): Map<string, FindResult[]> {
  const raw = multiPatternSearch(content, patterns);
  const results = new Map<string, FindResult[]>();

  for (const [pattern, matches] of raw) {
    const finds: FindResult[] = [];
    for (const match of matches) {
      const before = content.substring(0, match.index);
      const line = before.split('\n').length;
      const lastNewline = before.lastIndexOf('\n');
      const column = lastNewline >= 0 ? match.index - lastNewline : match.index + 1;
      finds.push({
        line,
        column,
        text: content.substring(
          Math.max(0, match.index - 30),
          Math.min(content.length, match.index + match.length + 30)
        ),
        match,
      });
    }
    results.set(pattern, finds);
  }

  return results;
}

/* ────────────────────────────────────────────── */
/*  Search in Files：多文件全文搜索                */
/* ────────────────────────────────────────────── */

export interface FileSearchResult {
  filePath: string;
  fileName: string;
  matches: FindResult[];
  matchCount: number;
}

/**
 * 在多个文件中搜索关键字
 * 
 * 逐个文件使用 Boyer-Moore-Horspool 搜索，适合中等规模项目。
 * 大规模项目建议使用扩展宿主的 Worker 线程搜索（fs.search RPC）。
 */
export function searchInFiles(
  files: Map<string, string>, // filePath → content
  pattern: string,
  options: SearchOptions = {}
): FileSearchResult[] {
  const results: FileSearchResult[] = [];

  for (const [filePath, content] of files) {
    const matches = findInFile(content, pattern, options);
    if (matches.length > 0) {
      results.push({
        filePath,
        fileName: filePath.split('/').pop() || filePath,
        matches,
        matchCount: matches.length,
      });
    }
  }

  // 按匹配数量降序排列
  return results.sort((a, b) => b.matchCount - a.matchCount);
}

/* ────────────────────────────────────────────── */
/*  文件引用查找                                   */
/* ────────────────────────────────────────────── */

/**
 * 查找项目中引用了目标文件的其他文件
 *
 * 根据目标文件的相对路径、文件名、无扩展名文件名等生成匹配模式，
 * 使用 Aho-Corasick 多模式匹配在项目中搜索。
 */
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte',
  'py', 'java', 'rb', 'php', 'go', 'rs', 'cpp', 'c', 'h', 'hpp', 'cs',
  'swift', 'kt', 'scala', 'html', 'css', 'scss', 'less', 'json', 'md',
  'yaml', 'yml', 'xml', 'sql', 'sh', 'bash', 'zsh',
]);

function getFileExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export async function findFileReferences(
  rootPath: string,
  targetAbsolutePath: string,
  allFilePaths: string[]
): Promise<FileSearchResult[]> {
  if (!rootPath) return [];

  const targetRelativePath = targetAbsolutePath.startsWith(rootPath + '/')
    ? targetAbsolutePath.slice(rootPath.length + 1)
    : targetAbsolutePath;

  const parts = targetRelativePath.split('/');
  const basename = parts.pop() || '';
  const lastDot = basename.lastIndexOf('.');
  const basenameNoExt = lastDot > 0 ? basename.slice(0, lastDot) : basename;
  const relDir = parts.join('/');
  const dirName = parts.length > 0 ? parts[parts.length - 1] : '';

  // 对 index.ts/index.tsx 等文件，外部引用通常是目录名（即父文件夹名），
  // 而不是文件名 index；避免用 index 这种高频词导致大量误匹配。
  const isIndex = basenameNoExt === 'index';
  const patterns = new Set<string>();
  if (isIndex) {
    if (relDir) patterns.add(relDir);               // src/components/FileReferencesModal
    if (dirName) patterns.add(dirName);             // FileReferencesModal
  } else {
    if (targetRelativePath) patterns.add(targetRelativePath);
    if (basename) patterns.add(basename);
    if (basenameNoExt) patterns.add(basenameNoExt);
    const relPathNoExt = lastDot > 0 ? targetRelativePath.slice(0, targetRelativePath.lastIndexOf('.')) : targetRelativePath;
    if (relPathNoExt) patterns.add(relPathNoExt);
  }

  const results: FileSearchResult[] = [];

  await Promise.all(
    allFilePaths.map(async (relPath) => {
      if (relPath === targetRelativePath) return;
      if (!CODE_EXTENSIONS.has(getFileExt(relPath))) return;

      let content: string;
      try {
        content = await readFile(rootPath + '/' + relPath);
      } catch {
        return;
      }

      // 使用整词匹配，避免 BottomPanel 命中 toggleBottomPanel 等子串
      const seen = new Set<number>();
      const matches: FindResult[] = [];

      for (const pattern of patterns) {
        for (const find of findInFile(content, pattern, { wholeWord: true })) {
          if (!seen.has(find.match.index)) {
            seen.add(find.match.index);
            matches.push(find);
          }
        }
      }

      if (matches.length === 0) return;

      matches.sort((a, b) => a.match.index - b.match.index);

      results.push({
        filePath: relPath,
        fileName: relPath.split('/').pop() || relPath,
        matches,
        matchCount: matches.length,
      });
    })
  );

  return results.sort((a, b) => b.matchCount - a.matchCount);
}

/* ────────────────────────────────────────────── */
/*  文件列表展平工具                               */
/* ────────────────────────────────────────────── */

/**
 * 将文件树展平为路径数组（用于 QuickOpen）
 */
export function flattenFileTree(
  entries: FileEntry[],
  prefix = ''
): string[] {
  const paths: string[] = [];

  for (const entry of entries) {
    const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === 'file') {
      paths.push(fullPath);
    } else {
      // 目录不加入，但递归处理子项
      // 注意：这里需要子目录的内容，但当前 FileEntry 不包含 children
      // 实际使用时应在 Redux store 中获取完整树结构
    }
  }

  return paths;
}
