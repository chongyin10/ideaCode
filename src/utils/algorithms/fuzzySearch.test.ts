import { describe, it, expect } from 'vitest';
import { fuzzySearch, fuzzyScore, FuzzySearchEngine } from './fuzzySearch';

describe('fuzzyScore', () => {
  it('完全匹配得到最高分且 isExact', () => {
    const r = fuzzyScore('hello', 'hello');
    expect(r).not.toBeNull();
    expect(r!.isExact).toBe(true);
  });

  it('不匹配返回 null', () => {
    expect(fuzzyScore('xyz', 'hello')).toBeNull();
  });

  it('空 query 返回低分结果（非 null）', () => {
    const r = fuzzyScore('', 'hello');
    expect(r).not.toBeNull();
    expect(r!.score).toBe(0);
    expect(r!.isExact).toBe(false);
  });

  it('顺序匹配优于乱序（乱序可能不匹配）', () => {
    const ordered = fuzzyScore('fbr', 'foo/bar');
    const reversed = fuzzyScore('rbf', 'foo/bar');
    expect(ordered).not.toBeNull();
    // 乱序若匹配，分数不高于顺序匹配；若不匹配则为 null
    if (reversed) {
      expect(ordered!.score).toBeGreaterThanOrEqual(reversed.score);
    }
  });

  it('前缀匹配得分高于后置匹配', () => {
    const prefix = fuzzyScore('app', 'App.tsx');
    const suffix = fuzzyScore('tsx', 'App.tsx');
    expect(prefix!.score).toBeGreaterThan(suffix!.score);
  });
});

describe('fuzzySearch', () => {
  it('返回按分数降序的匹配结果', () => {
    const results = fuzzySearch('ap', ['App.tsx', 'utils/api.ts', 'components/Button.tsx', 'README.md']);
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    expect(results[0].target).toBe('App.tsx');
  });

  it('无匹配返回空数组', () => {
    expect(fuzzySearch('zzz', ['foo', 'bar'])).toEqual([]);
  });
});

describe('FuzzySearchEngine', () => {
  it('indexCorpus 缓存后 search 结果一致', () => {
    const engine = new FuzzySearchEngine();
    const targets = ['src/main.ts', 'src/utils/helpers.ts', 'README.md'];
    engine.indexCorpus(targets);
    const results = engine.search('main', targets);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].target).toBe('src/main.ts');
  });

  it('getStats 返回缓存统计', () => {
    const engine = new FuzzySearchEngine();
    const stats = engine.getStats();
    expect(typeof stats.size).toBe('number');
    engine.clearCache();
    expect(engine.getStats().size).toBe(0);
  });
});
