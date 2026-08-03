import { describe, it, expect } from 'vitest';
import { levenshteinDistance, levenshteinSimilarity, jaroWinkler } from './levenshtein';

describe('levenshteinDistance', () => {
  it('相同字符串距离为 0', () => {
    expect(levenshteinDistance('hello', 'hello')).toBe(0);
    expect(levenshteinDistance('', '')).toBe(0);
  });

  it('经典例子 kitten → sitting 距离为 3', () => {
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
  });

  it('插入/删除各计 1', () => {
    expect(levenshteinDistance('a', '')).toBe(1);
    expect(levenshteinDistance('', 'a')).toBe(1);
  });

  it('替换计 1', () => {
    expect(levenshteinDistance('cat', 'cut')).toBe(1);
  });
});

describe('levenshteinSimilarity', () => {
  it('相同字符串相似度为 1', () => {
    expect(levenshteinSimilarity('hello', 'hello')).toBe(1);
    expect(levenshteinSimilarity('', '')).toBe(1);
  });

  it('完全不同的字符串相似度低', () => {
    expect(levenshteinSimilarity('abc', 'xyz')).toBeCloseTo(0);
  });

  it('相似字符串相似度高', () => {
    expect(levenshteinSimilarity('type', 'typed')).toBeGreaterThan(0.5);
  });
});

describe('jaroWinkler', () => {
  it('空字符串对相似度为 1', () => {
    expect(jaroWinkler('', '')).toBe(1);
  });

  it('一方为空时相似度为 0', () => {
    expect(jaroWinkler('abc', '')).toBe(0);
  });

  it('完全不同的字符串相似度为 0', () => {
    expect(jaroWinkler('abc', 'xyz')).toBe(0);
  });

  it('经典例子 martha/marhta 相似度高', () => {
    expect(jaroWinkler('martha', 'marhta')).toBeGreaterThan(0.9);
  });

  it('相同字符串为 1', () => {
    expect(jaroWinkler('same', 'same')).toBe(1);
  });
});
