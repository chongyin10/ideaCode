import type { SearchHit } from './algorithms';
import { LRUCache } from './algorithms/lruCache';

export interface SearchMatch {
  line: number;
  column: number;
  text: string;
  match: { index: number; length: number; matched: string };
}

export interface FileSearchResult {
  filePath: string;
  fileName: string;
  matches: SearchMatch[];
  expanded: boolean;
}

export const MAX_TOTAL_MATCHES = 500;
export const READ_BATCH_SIZE = 8;

const NON_WORD_RE = /[^\p{L}\p{N}_]/u;

export function hasNonWordChars(query: string): boolean {
  return NON_WORD_RE.test(query);
}

/** Glob 正则缓存（使用正式 LRUCache） */
const globRegexCache = new LRUCache<string, RegExp>(100);

function getGlobRegex(pattern: string): RegExp {
  const cached = globRegexCache.get(pattern);
  if (cached) {
    return cached.value;
  }

  const regex = new RegExp(
    '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
  );

  globRegexCache.set(pattern, regex);
  return regex;
}

export function matchGlob(filePath: string, pattern: string): boolean {
  const patterns = pattern.split(',').map((p) => p.trim());
  return patterns.some((p) => {
    if (!p) return false;
    const regex = getGlobRegex(p);
    const fileName = filePath.slice(filePath.lastIndexOf('/') + 1);
    return regex.test(filePath) || regex.test(fileName);
  });
}

export function hitsToResults(hits: SearchHit[], query: string): FileSearchResult[] {
  const lowerQuery = query.toLowerCase();
  return hits.map((hit) => ({
    filePath: hit.filePath,
    fileName: hit.fileName,
    matches: hit.entries.map((e) => {
      const lowerContext = e.context.toLowerCase();
      const idx = lowerContext.indexOf(lowerQuery);
      return {
        line: e.line,
        column: e.column,
        text: e.context,
        match: {
          index: idx >= 0 ? idx : Math.max(0, e.column - 1),
          length: idx >= 0 ? query.length : 0,
          matched: idx >= 0 ? e.context.substring(idx, idx + query.length) : '',
        },
      };
    }),
    expanded: true,
  }));
}
