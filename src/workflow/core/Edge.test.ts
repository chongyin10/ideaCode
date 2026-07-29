import { describe, it, expect } from 'vitest';
import { Edge, EdgeType } from './Edge';

/** 记录所有方法调用的 mock 2D 上下文 */
function createMockCtx() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const ctx = new Proxy({}, {
        get: (_target, prop) => {
            if (prop === 'measureText') return () => ({ width: 0 });
            if (typeof prop === 'string') {
                return (...args: unknown[]) => {
                    calls.push({ method: prop, args });
                };
            }
            return undefined;
        },
        set: () => true,
    });
    return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

function createEdge(type: EdgeType): Edge {
    return new Edge({
        id: 'e1',
        source: { nodeId: 'a' },
        target: { nodeId: 'b' },
        type,
        style: { arrowSize: 0 },
    });
}

const SOURCE = { x: 0, y: 0 };
const TARGET = { x: 100, y: 100 };

/** 只保留路径绘制调用，便于跨类型比较 */
function pathCalls(calls: Array<{ method: string; args: unknown[] }>) {
    return calls
        .filter((c) => ['moveTo', 'lineTo', 'quadraticCurveTo', 'bezierCurveTo', 'arcTo', 'arc'].includes(c.method))
        .map((c) => `${c.method}(${c.args.join(',')})`);
}

describe('Edge 绘制策略分发', () => {
    it('直线：moveTo + lineTo 直达终点', () => {
        const { ctx, calls } = createMockCtx();
        createEdge(EdgeType.Straight).draw(ctx, SOURCE, TARGET);
        const path = pathCalls(calls);
        expect(path).toEqual(['moveTo(0,0)', 'lineTo(100,100)']);
    });

    it('水平/垂直折线：经过中间点，至少两段', () => {
        for (const type of [EdgeType.Horizontal, EdgeType.Vertical]) {
            const { ctx, calls } = createMockCtx();
            createEdge(type).draw(ctx, SOURCE, TARGET);
            const lineTos = calls.filter((c) => c.method === 'lineTo');
            expect(lineTos.length).toBeGreaterThanOrEqual(2);
        }
    });

    it('DashedStep 复用 StepDown 的路径', () => {
        const step = createMockCtx();
        createEdge(EdgeType.StepDown).draw(step.ctx, SOURCE, TARGET);
        const dashed = createMockCtx();
        createEdge(EdgeType.DashedStep).draw(dashed.ctx, SOURCE, TARGET);
        expect(pathCalls(dashed.calls)).toEqual(pathCalls(step.calls));
    });

    it('DashedRounded 复用 RoundedStepDown 的路径', () => {
        const rounded = createMockCtx();
        createEdge(EdgeType.RoundedStepDown).draw(rounded.ctx, SOURCE, TARGET);
        const dashed = createMockCtx();
        createEdge(EdgeType.DashedRounded).draw(dashed.ctx, SOURCE, TARGET);
        expect(pathCalls(dashed.calls)).toEqual(pathCalls(rounded.calls));
    });

    it('所有类型都有对应的绘制策略', () => {
        for (const type of Object.values(EdgeType)) {
            const { ctx } = createMockCtx();
            expect(() => createEdge(type).draw(ctx, SOURCE, TARGET)).not.toThrow();
        }
    });
});

describe('Edge.containsPoint', () => {
    it('直线：线上命中，线外不命中', () => {
        const { ctx } = createMockCtx();
        const edge = createEdge(EdgeType.Straight);
        edge.draw(ctx, SOURCE, TARGET);
        expect(edge.containsPoint({ x: 50, y: 50 })).toBe(true);
        expect(edge.containsPoint({ x: 50, y: 60 }, 1)).toBe(false);
    });

    it('水平折线：三段路径均可命中', () => {
        const { ctx } = createMockCtx();
        const edge = createEdge(EdgeType.Horizontal);
        edge.draw(ctx, SOURCE, TARGET);
        // 路径：(0,0) -> (50,0) -> (50,100) -> (100,100)
        expect(edge.containsPoint({ x: 25, y: 0 })).toBe(true);
        expect(edge.containsPoint({ x: 50, y: 50 })).toBe(true);
        expect(edge.containsPoint({ x: 75, y: 100 })).toBe(true);
        // 远离路径的点不命中
        expect(edge.containsPoint({ x: 10, y: 90 }, 1)).toBe(false);
    });

    it('未绘制的边不命中远端点', () => {
        const edge = createEdge(EdgeType.Straight);
        expect(edge.containsPoint({ x: 500, y: 500 }, 1)).toBe(false);
    });
});
