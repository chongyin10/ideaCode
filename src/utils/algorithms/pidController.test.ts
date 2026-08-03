import { describe, it, expect } from 'vitest';
import { PIDController } from './pidController';

describe('PIDController', () => {
  it('纯比例项：输出 = Kp × 误差', () => {
    const pid = new PIDController({ Kp: 2, Ki: 0, Kd: 0 });
    // setpoint=0, measurement=10 → error = -10 → output = -20
    expect(pid.update(0, 10)).toBeCloseTo(-20);
  });

  it('无误差时输出为 0', () => {
    const pid = new PIDController({ Kp: 1, Ki: 0, Kd: 0 });
    expect(pid.update(5, 5)).toBeCloseTo(0);
  });

  it('输出限幅生效', () => {
    const pid = new PIDController({ Kp: 100, Ki: 0, Kd: 0, outMin: -10, outMax: 10 });
    expect(pid.update(0, 100)).toBeCloseTo(-10);
    expect(pid.update(100, 0)).toBeCloseTo(10);
  });

  it('积分项消除稳态误差', () => {
    const pid = new PIDController({ Kp: 0.5, Ki: 0.2, Kd: 0 });
    // 持续大误差累积积分，使输出幅度随时间增长
    const first = pid.update(0, 10);
    const second = pid.update(0, 10);
    expect(Math.abs(second)).toBeGreaterThan(Math.abs(first));
  });

  it('reset 清零积分与历史', () => {
    const pid = new PIDController({ Kp: 0, Ki: 1, Kd: 0 });
    pid.update(0, 10);
    pid.update(0, 10);
    // 误差为负，积分项为负值累积
    expect(pid.getIntegral()).not.toBeCloseTo(0);
    pid.reset();
    expect(pid.getIntegral()).toBeCloseTo(0);
    expect(pid.getOutput()).toBeCloseTo(0);
  });

  it('getOutput 返回最近输出', () => {
    const pid = new PIDController({ Kp: 1, Ki: 0, Kd: 0 });
    pid.update(10, 0); // error=10 → output=10
    expect(pid.getOutput()).toBeCloseTo(10);
  });
});
