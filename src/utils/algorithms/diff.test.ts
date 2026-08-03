import { describe, it, expect } from 'vitest';
import {
  computeDiff,
  computeDiffFast,
  formatUnifiedDiff,
  inlineDiff,
} from './diff';

describe('computeDiff', () => {
  it('相同文本无差异', () => {
    const r = computeDiff('hello\nworld', 'hello\nworld');
    expect(r.stats.insertions).toBe(0);
    expect(r.stats.deletions).toBe(0);
    expect(r.stats.unchanged).toBeGreaterThan(0);
  });

  it('新增行计入 insertions', () => {
    const r = computeDiff('a\nb', 'a\nb\nc');
    expect(r.stats.insertions).toBe(1);
    expect(r.stats.deletions).toBe(0);
  });

  it('删除行计入 deletions', () => {
    const r = computeDiff('a\nb\nc', 'a\nb');
    expect(r.stats.deletions).toBe(1);
    expect(r.stats.insertions).toBe(0);
  });

  it('全部替换时 insertions 与 deletions 对称', () => {
    const r = computeDiff('old', 'new');
    expect(r.stats.deletions).toBe(1);
    expect(r.stats.insertions).toBe(1);
  });

  it('替换中间行生成正确的变更序列', () => {
    const r = computeDiff('a\nb\nc', 'a\nX\nc');
    expect(r.chunks.map((c) => c.content)).toEqual(['a', 'b', 'X', 'c']);
    expect(r.chunks.map((c) => c.type)).toEqual(['equal', 'delete', 'insert', 'equal']);
  });
});

describe('computeDiffFast', () => {
  it('与 computeDiff 在简单场景结果一致', () => {
    const a = 'line1\nline2\nline3';
    const b = 'line1\nchanged\nline3';
    const slow = computeDiff(a, b);
    const fast = computeDiffFast(a, b);
    expect(fast.stats.insertions).toBe(slow.stats.insertions);
    expect(fast.stats.deletions).toBe(slow.stats.deletions);
  });
});

describe('formatUnifiedDiff', () => {
  it('生成包含 +/- 标记的统一 diff 文本', () => {
    const text = formatUnifiedDiff('old line', 'new line', 'file.txt', 'file.txt');
    expect(text).toContain('-old line');
    expect(text).toContain('+new line');
    expect(text).toContain('--- file.txt');
  });
});

describe('inlineDiff', () => {
  it('返回行内差异片段数组（包含 insert/delete）', () => {
    const result = inlineDiff('const x = 1;', 'const y = 1;');
    expect(Array.isArray(result)).toBe(true);
    expect(result.some((s) => s.type === 'insert')).toBe(true);
    expect(result.some((s) => s.type === 'delete')).toBe(true);
    // 公共部分保留为 equal
    const equalText = result.filter((s) => s.type === 'equal').map((s) => s.text).join('');
    expect(equalText).toContain('const ');
    expect(equalText).toContain(' = 1;');
  });

  it('相同行全部为 equal', () => {
    const result = inlineDiff('same line', 'same line');
    expect(result.every((s) => s.type === 'equal')).toBe(true);
  });
});
