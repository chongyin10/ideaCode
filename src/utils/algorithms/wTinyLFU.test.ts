import { describe, it, expect } from 'vitest';
import { WTinyLFU } from './wTinyLFU';

describe('WTinyLFU', () => {
  it('set/get 基本行为', () => {
    const cache = new WTinyLFU<string, number>({ maxSize: 100 });
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    expect(cache.has('a')).toBe(true);
    expect(cache.size).toBe(1);
  });

  it('未命中返回 null', () => {
    const cache = new WTinyLFU<string, number>({ maxSize: 100 });
    expect(cache.get('missing')).toBeNull();
  });

  it('delete 移除键', () => {
    const cache = new WTinyLFU<string, number>({ maxSize: 100 });
    cache.set('a', 1);
    expect(cache.delete('a')).toBe(true);
    expect(cache.has('a')).toBe(false);
    expect(cache.size).toBe(0);
  });

  it('超过容量后淘汰（高频访问的键保留）', () => {
    // 小容量放大淘汰行为
    const cache = new WTinyLFU<string, number>({ maxSize: 10 });
    for (let i = 0; i < 10; i++) cache.set(`k${i}`, i);
    // 高频访问 k0（部分键高频）会提升其保留概率
    for (let i = 0; i < 50; i++) cache.get('k0');
    cache.set('overflow', 999);
    // 容量不超限
    expect(cache.size).toBeLessThanOrEqual(10);
    // 高频键大概率仍存在
    expect(cache.get('k0')).toBe(0);
  });

  it('clear 清空全部', () => {
    const cache = new WTinyLFU<string, number>({ maxSize: 100 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeNull();
  });

  it('getStats 统计命中', () => {
    const cache = new WTinyLFU<string, number>({ maxSize: 100 });
    cache.set('a', 1);
    cache.get('a');
    cache.get('a');
    cache.get('zz');
    const stats = cache.getStats();
    expect(stats.hitCount).toBe(2);
    expect(stats.missCount).toBe(1);
  });
});
