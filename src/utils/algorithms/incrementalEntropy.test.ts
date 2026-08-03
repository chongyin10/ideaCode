import { describe, it, expect } from 'vitest';
import { IncrementalEntropy, SlidingWindowEntropy } from './incrementalEntropy';

describe('IncrementalEntropy', () => {
  it('初始熵为 0', () => {
    const ie = new IncrementalEntropy();
    expect(ie.getEntropy()).toBe(0);
  });

  it('重复文本熵低（趋于 0）', () => {
    const ie = new IncrementalEntropy();
    for (let i = 0; i < 100; i++) ie.append('aaaa');
    expect(ie.getEntropy()).toBeLessThan(0.1);
  });

  it('多样文本熵高', () => {
    const ie = new IncrementalEntropy();
    // 4 种字符均匀分布 → 熵接近 log2(4)=2
    const chars = ['a', 'b', 'c', 'd'];
    for (let i = 0; i < 200; i++) ie.append(chars[i % 4]);
    const e = ie.getEntropy();
    expect(e).toBeGreaterThan(1.5);
    expect(e).toBeLessThanOrEqual(2.01);
  });

  it('refreshEntropy 与 getEntropy 一致', () => {
    const ie = new IncrementalEntropy();
    ie.append('ab');
    ie.append('cd');
    expect(ie.refreshEntropy()).toBeCloseTo(ie.getEntropy());
  });

  it('reset 清空计数', () => {
    const ie = new IncrementalEntropy();
    ie.append('a');
    ie.append('b');
    expect(ie.getEntropy()).toBeGreaterThan(0);
    ie.reset();
    expect(ie.getEntropy()).toBe(0);
  });

  it('clone 独立副本', () => {
    const ie = new IncrementalEntropy();
    ie.append('hello');
    const clone = ie.clone();
    clone.append('world');
    expect(clone.getEntropy()).not.toBe(ie.getEntropy());
  });
});

describe('SlidingWindowEntropy', () => {
  it('push 返回当前熵', () => {
    const swe = new SlidingWindowEntropy(64);
    const e = swe.push(97); // 'a'
    expect(typeof e).toBe('number');
    expect(e).toBeGreaterThanOrEqual(0);
  });

  it('相同字符熵为 0', () => {
    const swe = new SlidingWindowEntropy(32);
    for (let i = 0; i < 30; i++) swe.push(97);
    expect(swe.getEntropy()).toBeLessThan(0.01);
  });

  it('多样字符熵大于 0', () => {
    const swe = new SlidingWindowEntropy(64);
    let last = 0;
    for (let i = 0; i < 60; i++) last = swe.push(97 + (i % 4));
    expect(last).toBeGreaterThan(0.5);
  });
});
