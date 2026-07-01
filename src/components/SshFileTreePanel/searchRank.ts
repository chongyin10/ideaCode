import type { FileTreeNode } from './types';

export interface RankedEntry {
  node: FileTreeNode;
  score: number;
  /** 高亮区间（原始 path 中的 [start, end)） */
  ranges: [number, number][];
}

const MAX_RESULTS = 50;
const MAX_PATH_LEN = 128;
const MAX_EDIT_DIST_RATIO = 0.5;

const WEIGHTS = {
  prefix: 1.0,
  substring: 0.6,
  acronym: 0.5,
  edit: 0.3,
  tfidf: 0.2,
  directory: 0.05,
  depthPenalty: 0.02,
};

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** 计算有上限的 Levenshtein 距离，避免长字符串过度消耗 */
function boundedLevenshtein(a: string, b: string, max: number): number {
  if (a.length < b.length) [a, b] = [b, a];
  if (a.length - b.length > max) return max + 1;

  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    const curr = new Array(b.length + 1);
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      rowMin = Math.min(rowMin, curr[j]);
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[b.length];
}

function findOccurrences(path: string, q: string): [number, number][] {
  if (!q) return [];
  const lowerPath = path.toLowerCase();
  const ranges: [number, number][] = [];
  let idx = 0;
  while ((idx = lowerPath.indexOf(q, idx)) !== -1) {
    ranges.push([idx, idx + q.length]);
    idx += Math.max(1, q.length);
  }
  return ranges;
}

function mergeRanges(ranges: [number, number][]): [number, number][] {
  if (ranges.length === 0) return [];
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur[0] <= last[1]) {
      last[1] = Math.max(last[1], cur[1]);
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

function segmentAcronymRanges(path: string, q: string): [number, number][] | null {
  const segments = path.split('/').filter(Boolean);
  if (q.length > segments.length) return null;
  const initials = segments.map((s) => s[0]?.toLowerCase() || '').join('');
  if (!initials.startsWith(q)) return null;
  const ranges: [number, number][] = [];
  let pos = 0;
  for (let i = 0; i < q.length; i++) {
    const seg = segments[i];
    const start = path.indexOf(seg, pos);
    if (start === -1) return null;
    ranges.push([start, start + 1]);
    pos = start + 1;
  }
  return ranges;
}

function innerAcronymRanges(name: string, q: string): [number, number][] | null {
  const parts = name.split(/[-_]/).filter(Boolean);
  if (q.length > parts.length) return null;
  const initials = parts.map((p) => p[0]?.toLowerCase() || '').join('');
  if (!initials.startsWith(q)) return null;
  const ranges: [number, number][] = [];
  let pos = 0;
  for (let i = 0; i < q.length; i++) {
    const part = parts[i];
    const start = name.indexOf(part, pos);
    if (start === -1) return null;
    ranges.push([start, start + 1]);
    pos = start + part.length;
  }
  return ranges;
}

export function buildIdfIndex(entries: FileTreeNode[]): Map<string, number> {
  const N = entries.length || 1;
  const df = new Map<string, number>();
  for (const entry of entries) {
    const tokens = new Set(tokenize(entry.path));
    for (const t of tokens) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const [t, count] of df) {
    idf.set(t, Math.log(N / (count + 1)) + 1);
  }
  return idf;
}

export function rankEntries(
  entries: FileTreeNode[],
  query: string,
  idf: Map<string, number>
): RankedEntry[] {
  const q = query.trim().toLowerCase();
  if (!q || entries.length === 0) return [];

  const qTokens = tokenize(q);
  const maxEditDist = Math.max(1, Math.floor(q.length * MAX_EDIT_DIST_RATIO));
  const results: RankedEntry[] = [];

  for (const node of entries) {
    const path = node.path.slice(0, MAX_PATH_LEN);
    const segments = path.split('/').filter(Boolean);
    const name = segments[segments.length - 1] || '';
    const lowerName = name.toLowerCase();

    let score = 0;
    const ranges: [number, number][] = [];

    // 1. 段首前缀匹配
    for (const seg of segments) {
      const lowerSeg = seg.toLowerCase();
      if (lowerSeg.startsWith(q)) {
        score += WEIGHTS.prefix;
        const start = path.toLowerCase().indexOf(lowerSeg);
        if (start !== -1) ranges.push([start, start + q.length]);
        break; // 只算一次
      }
    }

    // 2. 子串匹配
    const occurrences = findOccurrences(path, q);
    if (occurrences.length > 0) {
      score += WEIGHTS.substring;
      ranges.push(...occurrences);
    }

    // 3. 首字母缩写匹配（路径段 / 段内连字符）
    const segAcronym = segmentAcronymRanges(path, q);
    if (segAcronym) {
      score += WEIGHTS.acronym;
      ranges.push(...segAcronym);
    } else if (name) {
      const innerAcronym = innerAcronymRanges(name, q);
      if (innerAcronym) {
        // 将 name 内的偏移映射到 path 中的偏移
        const nameStart = path.lastIndexOf(name);
        if (nameStart !== -1) {
          score += WEIGHTS.acronym * 0.8;
          ranges.push(...innerAcronym.map(([s, e]) => [s + nameStart, e + nameStart] as [number, number]));
        }
      }
    }

    // 4. 编辑距离容错（只对文件名或每段计算，避免长路径爆炸）
    let minDist = Infinity;
    const candidates = [lowerName, ...segments.map((s) => s.toLowerCase())];
    for (const cand of candidates) {
      if (Math.abs(cand.length - q.length) > maxEditDist) continue;
      const dist = boundedLevenshtein(q, cand, maxEditDist);
      if (dist < minDist) minDist = dist;
    }
    if (minDist <= maxEditDist && minDist !== Infinity) {
      const len = Math.max(q.length, lowerName.length || 1);
      score += WEIGHTS.edit * (1 - minDist / len);
    }

    // 5. TF-IDF：查询 token 命中罕见路径 token 时加分
    if (qTokens.length > 0) {
      const entryTokens = tokenize(path);
      let tfidf = 0;
      for (const qt of qTokens) {
        if (entryTokens.some((t) => t === qt || t.startsWith(qt))) {
          tfidf += idf.get(qt) || 0;
          // 高亮命中 token
          for (const t of entryTokens) {
            if (t === qt || t.startsWith(qt)) {
              const lowerPathFull = path.toLowerCase();
              let pos = 0;
              while ((pos = lowerPathFull.indexOf(t, pos)) !== -1) {
                ranges.push([pos, pos + t.length]);
                pos += t.length;
              }
            }
          }
        }
      }
      score += WEIGHTS.tfidf * (tfidf / qTokens.length);
    }

    // 6. 目录类型奖励
    if (node.type === 'directory') {
      score += WEIGHTS.directory;
    }

    // 7. 路径深度惩罚
    const depth = Math.max(0, segments.length - 1);
    score -= depth * WEIGHTS.depthPenalty;

    if (score > 0) {
      results.push({ node, score, ranges: mergeRanges(ranges) });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, MAX_RESULTS);
}
