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
