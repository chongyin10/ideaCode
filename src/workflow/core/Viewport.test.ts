import { describe, it, expect } from 'vitest';
import { Viewport } from './Viewport';

describe('Viewport', () => {
    it('默认偏移为原点、缩放为 1', () => {
        const vp = new Viewport();
        expect(vp.offset).toEqual({ x: 0, y: 0 });
        expect(vp.scale).toBe(1);
    });

    it('构造函数复制初始偏移（不共享引用）', () => {
        const offset = { x: 10, y: 20 };
        const vp = new Viewport(offset);
        offset.x = 999;
        expect(vp.offset).toEqual({ x: 10, y: 20 });
    });

    it('screenToWorld：应用偏移与缩放', () => {
        const vp = new Viewport({ x: 100, y: 50 }, 2);
        expect(vp.screenToWorld({ x: 200, y: 150 })).toEqual({ x: 50, y: 50 });
    });

    it('worldToScreen：screenToWorld 的逆变换', () => {
        const vp = new Viewport({ x: -30, y: 70 }, 1.5);
        const world = { x: 40, y: -20 };
        const screen = vp.worldToScreen(world);
        expect(vp.screenToWorld(screen).x).toBeCloseTo(world.x);
        expect(vp.screenToWorld(screen).y).toBeCloseTo(world.y);
    });

    it('reset：恢复指定偏移与缩放', () => {
        const vp = new Viewport({ x: 5, y: 6 }, 3);
        vp.reset();
        expect(vp.offset).toEqual({ x: 0, y: 0 });
        expect(vp.scale).toBe(1);
    });

    it('eventToScreenPoint：换算相对画布的坐标', () => {
        const vp = new Viewport();
        const canvas = {
            getBoundingClientRect: () => ({ left: 10, top: 20 }),
        } as HTMLCanvasElement;
        expect(vp.eventToScreenPoint(canvas, { clientX: 35, clientY: 60 }))
            .toEqual({ x: 25, y: 40 });
    });

    it('eventToWorldPoint：屏幕坐标再转世界坐标', () => {
        const vp = new Viewport({ x: 100, y: 0 }, 2);
        const canvas = {
            getBoundingClientRect: () => ({ left: 0, top: 0 }),
        } as HTMLCanvasElement;
        expect(vp.eventToWorldPoint(canvas, { clientX: 300, clientY: 100 }))
            .toEqual({ x: 100, y: 50 });
    });
});
