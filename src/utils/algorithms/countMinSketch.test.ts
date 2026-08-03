import { describe, it, expect } from 'vitest';
import { CountMinSketch } from './countMinSketch';

describe('CountMinSketch', () => {
  it('estimate 不低估已添加的计数', () => {
    const cms = new CountMinSketch();
    cms.add('apple', 5);
    cms.add('banana', 3);
    expect(cms.estimate('apple')).toBeGreaterThanOrEqual(5);
    expect(cms.estimate('banana')).toBeGreaterThanOrEqual(3);
  });

  it('默认 add 计数为 1', () => {
    const cms = new CountMinSketch();
    cms.add('x');
    expect(cms.estimate('x')).toBeGreaterThanOrEqual(1);
  });

  it('clear 后计数归零', () => {
    const cms = new CountMinSketch();
    cms.add('apple', 10);
    expect(cms.estimate('apple')).toBeGreaterThanOrEqual(10);
    cms.clear();
    expect(cms.estimate('apple')).toBeLessThan(10);
  });

  it('getParams 返回结构信息', () => {
    const cms = new CountMinSketch();
    const params = cms.getParams();
    expect(params.width).toBeGreaterThan(0);
    expect(params.depth).toBeGreaterThan(0);
    expect(params.memoryBytes).toBeGreaterThan(0);
  });

  it('高频项估计值大于低频项', () => {
    const cms = new CountMinSketch();
    for (let i = 0; i < 100; i++) cms.add('hot');
    cms.add('cold');
    expect(cms.estimate('hot')).toBeGreaterThanOrEqual(cms.estimate('cold'));
  });
});
