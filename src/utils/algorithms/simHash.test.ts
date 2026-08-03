import { describe, it, expect } from 'vitest';
import { computeSimHash, hammingDistance, hammingDistanceFast } from './simHash';

describe('computeSimHash', () => {
  it('返回 bigint', () => {
    expect(typeof computeSimHash('hello')).toBe('bigint');
  });

  it('相同文本哈希相同', () => {
    expect(computeSimHash('hello world')).toBe(computeSimHash('hello world'));
  });

  it('空文本可计算', () => {
    expect(typeof computeSimHash('')).toBe('bigint');
  });
});

describe('hammingDistance', () => {
  it('相同哈希距离为 0', () => {
    const h = computeSimHash('same text');
    expect(hammingDistance(h, h)).toBe(0);
    expect(hammingDistanceFast(h, h)).toBe(0);
  });

  it('差异文本距离大于 0', () => {
    const a = computeSimHash('the quick brown fox jumps over the lazy dog');
    const b = computeSimHash('the quick brown cat jumps over the lazy dog');
    const c = computeSimHash('completely different unrelated content here');
    expect(hammingDistance(a, b)).toBeGreaterThan(0);
    // 语义更近的文本距离应小于完全不同的文本
    expect(hammingDistance(a, b)).toBeLessThan(hammingDistance(a, c));
  });

  it('hammingDistanceFast 与 hammingDistance 一致', () => {
    const a = computeSimHash('some content');
    const b = computeSimHash('some other content');
    expect(hammingDistanceFast(a, b)).toBe(hammingDistance(a, b));
  });
});
