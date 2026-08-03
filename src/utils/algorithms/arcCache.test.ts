import { describe, it, expect } from 'vitest';
import { ARCCache } from './arcCache';

describe('ARCCache', () => {
  it('set/get 基本行为', () => {
    const cache = new ARCCache<string, number>(4);
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    expect(cache.has('a')).toBe(true);
  });

  it('未命中返回 null', () => {
    const cache = new ARCCache<string, number>(4);
    expect(cache.get('missing')).toBeNull();
  });

  it('超过容量淘汰最久未使用', () => {
    const cache = new ARCCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // a 变新，b 变最旧
    cache.set('c', 3);
    expect(cache.get('b')).toBeNull();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
  });

  it('delete/clear 基本行为', () => {
    const cache = new ARCCache<string, number>(4);
    cache.set('a', 1);
    expect(cache.delete('a')).toBe(true);
    expect(cache.has('a')).toBe(false);
    cache.set('b', 2);
    cache.clear();
    expect(cache.has('b')).toBe(false);
  });

  it('getStats 返回统计', () => {
    const cache = new ARCCache<string, number>(4);
    cache.set('a', 1);
    cache.get('a');
    cache.get('zz');
    const stats = cache.getStats();
    expect(stats.hitCount).toBe(1);
    expect(stats.missCount).toBe(1);
  });
});
