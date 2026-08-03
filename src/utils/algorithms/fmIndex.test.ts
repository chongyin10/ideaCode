import { describe, it, expect } from 'vitest';
import { FMIndex } from './fmIndex';

describe('FMIndex', () => {
  it('构建与整体匹配', () => {
    const fm = new FMIndex('banana');
    expect(fm.search('banana').count).toBe(1);
    expect(fm.contains('banana')).toBe(true);
  });

  it('重叠模式多次匹配（ana 在 banana 中出现 2 次）', () => {
    const fm = new FMIndex('banana');
    const r = fm.search('ana');
    expect(r.count).toBe(2);
  });

  it('不存在的模式匹配数为 0', () => {
    const fm = new FMIndex('banana');
    expect(fm.search('xyz').count).toBe(0);
    expect(fm.contains('xyz')).toBe(false);
  });

  it('空模式返回全文长度', () => {
    const fm = new FMIndex('banana');
    // textLength 包含哨兵字符
    expect(fm.search('').count).toBe('banana'.length + 1);
  });

  it('单字符匹配', () => {
    const fm = new FMIndex('hello world');
    // 'l' 出现 3 次
    expect(fm.search('l').count).toBe(3);
  });

  it('重复文本高压缩场景仍正确', () => {
    const text = 'aaaa'.repeat(100); // 400 个 'a'
    const fm = new FMIndex(text);
    expect(fm.search('aaa').count).toBe(400 - 2);
    expect(fm.search('aaaaa').count).toBe(400 - 4);
    expect(fm.search('b').count).toBe(0);
  });

  it('模式长于文本时匹配为 0', () => {
    const fm = new FMIndex('short');
    expect(fm.search('muchlongerpattern').count).toBe(0);
  });
});
