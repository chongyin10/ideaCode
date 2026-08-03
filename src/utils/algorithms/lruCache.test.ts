import { describe, it, expect } from 'vitest';
import { LRUCache, FileContentCache } from './lruCache';

describe('LRUCache', () => {
  it('get 未命中返回 null', () => {
    const cache = new LRUCache<string, number>(3);
    expect(cache.get('missing')).toBeNull();
  });

  it('set/get 命中返回值与命中标记', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    const entry = cache.get('a');
    expect(entry).not.toBeNull();
    expect(entry!.value).toBe(1);
    expect(entry!.hit).toBe(true);
    expect(entry!.hits).toBe(1);
  });

  it('超过容量淘汰最久未使用（LRU 顺序）', () => {
    const cache = new LRUCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    // 访问 a，使 b 成为最久未使用
    cache.get('a');
    const result = cache.set('c', 3);
    expect(result.evicted).toBe(true);
    expect(result.evictedKey).toBe('b');
    expect(cache.get('a')).not.toBeNull();
    expect(cache.get('b')).toBeNull();
    expect(cache.get('c')).not.toBeNull();
  });

  it('has/delete/clear 基本行为', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    expect(cache.has('a')).toBe(true);
    expect(cache.delete('a')).toBe(true);
    expect(cache.has('a')).toBe(false);
    cache.set('b', 2);
    cache.clear();
    expect(cache.has('b')).toBe(false);
  });

  it('getStats 统计命中与未命中', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    cache.get('a'); // 命中
    cache.get('a'); // 命中
    cache.get('zz'); // 未命中
    const stats = cache.getStats();
    expect(stats.hitCount).toBe(2);
    expect(stats.missCount).toBe(1);
  });

  it('容量至少为 1', () => {
    const cache = new LRUCache<string, number>(0);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.keys().length).toBeLessThanOrEqual(1);
  });
});

describe('FileContentCache', () => {
  it('getValid 在 mtime 匹配时命中', () => {
    const cache = new FileContentCache(5);
    cache.setContent('/a.ts', 'content', 100);
    const r = cache.getValid('/a.ts', 100);
    expect(r).not.toBeNull();
    expect(r!.hit).toBe(true);
    expect(r!.content).toBe('content');
  });

  it('mtime 变化视为失效', () => {
    const cache = new FileContentCache(5);
    cache.setContent('/a.ts', 'content', 100);
    expect(cache.getValid('/a.ts', 200)).toBeNull();
  });

  it('未缓存文件未命中', () => {
    const cache = new FileContentCache(5);
    expect(cache.getValid('/missing.ts', 0)).toBeNull();
  });
});
