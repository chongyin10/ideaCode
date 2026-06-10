/**
 * 搜索 Worker
 *
 * 运行在独立线程中，负责 CPU 密集型的字符串搜索。
 * 主线程负责文件 IO（读取内容），Worker 负责在内容中搜索关键词。
 *
 * 通信协议：
 * 主线程 → Worker: { type: 'search', files: SearchFile[], query, options }
 *   Worker → 主线程: { type: 'progress', results, totalMatches }
 *   Worker → 主线程: { type: 'done', results, totalMatches, isTruncated }
 *
 * 内存优化：
 * - 缓存上一次的 query + options 对应的 searcher，避免重复构建 shift table
 * - 搜索完成后释放文件内容引用，帮助主线程 GC
 */

import { searchInText } from '../utils/algorithms';
import type { SearchOptions, MatchResult } from '../utils/algorithms';

interface SearchFile {
  path: string;
  content: string;
}

interface SearchMatch {
  line: number;
  column: number;
  text: string;
  match: MatchResult;
}

interface FileSearchResult {
  filePath: string;
  fileName: string;
  matches: SearchMatch[];
  expanded: boolean;
}

/** 缓存上一次的 searcher，避免重复构建 shift table */
let cachedQuery = '';
let cachedOptionsKey = '';
let cachedSearch: ((text: string) => MatchResult[]) | null = null;

function optionsKey(options: SearchOptions): string {
  return `${options.caseSensitive ?? true}:${options.wholeWord ?? false}:${options.regex ?? false}`;
}

function getSearcher(query: string, options: SearchOptions): (text: string) => MatchResult[] {
  const ok = optionsKey(options);
  if (cachedSearch && cachedQuery === query && cachedOptionsKey === ok) {
    return cachedSearch;
  }
  cachedQuery = query;
  cachedOptionsKey = ok;
  cachedSearch = (text: string) => searchInText(text, query, options);
  return cachedSearch;
}

/**
 * 在 Worker 中执行搜索
 */
function doSearch(
  files: SearchFile[],
  query: string,
  options: SearchOptions,
  totalMatchesSoFar: number,
  maxTotalMatches: number
): { results: FileSearchResult[]; totalMatches: number; isTruncated: boolean } {
  const results: FileSearchResult[] = [];
  let totalMatches = totalMatchesSoFar;
  let isTruncated = false;

  // 复用已缓存的 searcher，避免重复构建 shift table
  const searcher = getSearcher(query, options);

  for (const file of files) {
    if (totalMatches >= maxTotalMatches) {
      isTruncated = true;
      break;
    }

    const fileMatches: SearchMatch[] = [];

    // 只搜文件内容，不搜文件名
    const contentMatches = searcher(file.content);

    for (const match of contentMatches) {
      if (totalMatches >= maxTotalMatches) {
        isTruncated = true;
        break;
      }

      const before = file.content.substring(0, match.index);
      const line = before.split('\n').length;
      const lastNewline = before.lastIndexOf('\n');
      const lineStart = lastNewline >= 0 ? lastNewline + 1 : 0;
      const nextNewline = file.content.indexOf('\n', match.index);
      const lineEnd = nextNewline >= 0 ? nextNewline : file.content.length;
      const lineContent = file.content.substring(lineStart, lineEnd);
      const matchIndexInLine = match.index - lineStart;

      fileMatches.push({
        line,
        column: matchIndexInLine + 1,
        text: lineContent,
        match: {
          index: matchIndexInLine,
          length: match.length,
          matched: match.matched,
        },
      });
      totalMatches++;
    }

    if (fileMatches.length > 0) {
      results.push({
        filePath: file.path,
        fileName: file.path.split('/').pop() || file.path,
        matches: fileMatches,
        expanded: true,
      });
    }

    // 释放文件内容引用，帮助主线程 GC（Worker 中的 postMessage 是结构化克隆，
    // 但这里文件内容已经处理完毕，可以释放本地引用）
    (file as { content?: string }).content = '';
  }

  return { results, totalMatches, isTruncated };
}

/* ─── Worker 消息处理 ─── */

self.onmessage = (event: MessageEvent) => {
  const { type, files, query, options, totalMatchesSoFar, maxTotalMatches, searchId } =
    event.data;

  if (type === 'search') {
    const { results, totalMatches, isTruncated } = doSearch(
      files as SearchFile[],
      query as string,
      options as SearchOptions,
      (totalMatchesSoFar as number) || 0,
      (maxTotalMatches as number) || 500
    );

    self.postMessage({
      type: 'progress',
      results,
      totalMatches,
      isTruncated,
      searchId: searchId as number,
    });
  }
};

export {};
