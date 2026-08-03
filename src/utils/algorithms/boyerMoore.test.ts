import { describe, it, expect } from 'vitest';
import {
  horspoolSearch,
  horspoolSearchIgnoreCase,
  horspoolSearchWholeWord,
  AhoCorasick,
  multiPatternSearch,
} from './boyerMoore';

describe('horspoolSearch', () => {
  it('找到所有匹配位置', () => {
    const results = horspoolSearch('hello world hello', 'hello');
    expect(results).toHaveLength(2);
    expect(results[0].index).toBe(0);
    expect(results[0].matched).toBe('hello');
    expect(results[1].index).toBe(12);
  });

  it('未找到返回空数组', () => {
    expect(horspoolSearch('hello world', 'xyz')).toEqual([]);
  });

  it('空模式/空文本返回空数组', () => {
    expect(horspoolSearch('', 'a')).toEqual([]);
    expect(horspoolSearch('abc', '')).toEqual([]);
  });

  it('模式长于文本返回空数组', () => {
    expect(horspoolSearch('abc', 'abcdef')).toEqual([]);
  });
});

describe('horspoolSearchIgnoreCase', () => {
  it('忽略大小写匹配', () => {
    const results = horspoolSearchIgnoreCase('Hello World', 'hello');
    expect(results).toHaveLength(1);
    expect(results[0].index).toBe(0);
  });
});

describe('horspoolSearchWholeWord', () => {
  it('只匹配完整单词', () => {
    // 'cat' 是 'concatenate' 的一部分，不应整词匹配
    const results = horspoolSearchWholeWord('a cat concatenate category', 'cat');
    expect(results).toHaveLength(1);
    expect(results[0].index).toBe(2);
  });
});

describe('AhoCorasick', () => {
  it('多模式同时匹配', () => {
    const ac = new AhoCorasick(['he', 'she', 'his', 'hers']);
    const result = ac.search('ushers');
    // ushers 中：he@1, she@1, hers@1
    expect(result.get('he')).toBeTruthy();
    expect(result.get('she')).toBeTruthy();
    expect(result.get('hers')).toBeTruthy();
  });

  it('不存在的模式无结果', () => {
    const ac = new AhoCorasick(['foo']);
    const result = ac.search('bar');
    expect(result.get('foo')).toBeUndefined();
  });

  it('空模式列表', () => {
    const ac = new AhoCorasick([]);
    expect(ac.search('anything').size).toBe(0);
  });
});

describe('multiPatternSearch', () => {
  it('批量搜索返回各模式匹配', () => {
    const result = multiPatternSearch('hello world', ['hello', 'world', 'nope']);
    expect(result.get('hello')).toBeTruthy();
    expect(result.get('world')).toBeTruthy();
    expect(result.get('nope')).toBeUndefined();
  });
});
