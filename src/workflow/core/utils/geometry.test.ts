import { describe, it, expect } from 'vitest';
import { getLineSegmentIntersection, resolveEdgeEndpoints, type Point } from './geometry';
import type { Node } from '../Node';
import type { Edge, EdgeAnchor } from '../Edge';

describe('getLineSegmentIntersection', () => {
    it('返回两条相交线段的交叉点', () => {
        // 水平线段 (0,1)-(2,1) 与垂直线段 (1,0)-(1,2)
        const p = getLineSegmentIntersection(
            { x: 0, y: 1 }, { x: 2, y: 1 },
            { x: 1, y: 0 }, { x: 1, y: 2 }
        );
        expect(p).not.toBeNull();
        expect(p!.x).toBeCloseTo(1);
        expect(p!.y).toBeCloseTo(1);
    });

    it('平行线段返回 null', () => {
        expect(
            getLineSegmentIntersection(
                { x: 0, y: 0 }, { x: 2, y: 0 },
                { x: 0, y: 1 }, { x: 2, y: 1 }
            )
        ).toBeNull();
    });

    it('共线线段返回 null', () => {
        expect(
            getLineSegmentIntersection(
                { x: 0, y: 0 }, { x: 2, y: 0 },
                { x: 1, y: 0 }, { x: 3, y: 0 }
            )
        ).toBeNull();
    });

    it('延长线相交但线段不相交时返回 null', () => {
        // 线段 (0,0)-(1,0) 与 (2,-1)-(2,1)：延长线在 (2,0) 相交，但不在第一条线段上
        expect(
            getLineSegmentIntersection(
                { x: 0, y: 0 }, { x: 1, y: 0 },
                { x: 2, y: -1 }, { x: 2, y: 1 }
            )
        ).toBeNull();
    });

    it('仅在端点处接触时返回 null（端点被排除）', () => {
        expect(
            getLineSegmentIntersection(
                { x: 0, y: 0 }, { x: 2, y: 0 },
                { x: 0, y: 0 }, { x: 0, y: 2 }
            )
        ).toBeNull();
    });

    it('斜线相交', () => {
        // (0,0)-(4,4) 与 (0,4)-(4,0)，交点 (2,2)
        const p = getLineSegmentIntersection(
            { x: 0, y: 0 }, { x: 4, y: 4 },
            { x: 0, y: 4 }, { x: 4, y: 0 }
        );
        expect(p).not.toBeNull();
        expect(p!.x).toBeCloseTo(2);
        expect(p!.y).toBeCloseTo(2);
    });
});

// ---- resolveEdgeEndpoints 测试桩 ----

interface StubNodeOptions {
    x: number;
    y: number;
    width: number;
    height: number;
    ports?: Record<string, Point>;
}

function createStubNode(options: StubNodeOptions): Node {
    const { x, y, width, height, ports = {} } = options;
    return {
        getPosition: () => ({ x, y }),
        getStyle: () => ({ width, height }),
        getPort: (portId: string) => {
            const point = ports[portId];
            if (!point) return undefined;
            return { getConnectionPoint: () => ({ ...point }) };
        },
        getAnchorPoint: (position: string) => {
            switch (position) {
                case 'top': return { x: x + width / 2, y };
                case 'bottom': return { x: x + width / 2, y: y + height };
                case 'left': return { x, y: y + height / 2 };
                case 'right': return { x: x + width, y: y + height / 2 };
                default: return { x, y };
            }
        },
    } as unknown as Node;
}

function createStubEdge(
    sourceId: string,
    targetId: string,
    sourceAnchor: Partial<EdgeAnchor> = {},
    targetAnchor: Partial<EdgeAnchor> = {}
): Edge {
    const source: EdgeAnchor = { nodeId: sourceId, ...sourceAnchor };
    const target: EdgeAnchor = { nodeId: targetId, ...targetAnchor };
    return {
        getSourceId: () => source.nodeId,
        getTargetId: () => target.nodeId,
        getSourceAnchor: () => ({ ...source }),
        getTargetAnchor: () => ({ ...target }),
    } as unknown as Edge;
}

describe('resolveEdgeEndpoints', () => {
    const nodeA = createStubNode({
        x: 0, y: 0, width: 100, height: 50,
        ports: { out: { x: 100, y: 25 } },
    });
    const nodeB = createStubNode({
        x: 200, y: 100, width: 100, height: 50,
        ports: { in: { x: 200, y: 125 } },
    });
    const nodes = new Map<string, Node>([
        ['a', nodeA],
        ['b', nodeB],
    ]);

    it('指定连接桩时使用连接桩的连接点', () => {
        const edge = createStubEdge('a', 'b', { portId: 'out' }, { portId: 'in' });
        const endpoints = resolveEdgeEndpoints(edge, nodes);
        expect(endpoints).toEqual({
            sourcePoint: { x: 100, y: 25 },
            targetPoint: { x: 200, y: 125 },
        });
    });

    it('未指定连接桩时回退到节点锚点', () => {
        const edge = createStubEdge('a', 'b', { position: 'right' }, { position: 'left' });
        const endpoints = resolveEdgeEndpoints(edge, nodes);
        expect(endpoints).toEqual({
            sourcePoint: { x: 100, y: 25 },
            targetPoint: { x: 200, y: 125 },
        });
    });

    it('连接桩不存在时回退到节点锚点', () => {
        const edge = createStubEdge('a', 'b', { portId: 'missing', position: 'bottom' });
        const endpoints = resolveEdgeEndpoints(edge, nodes);
        expect(endpoints!.sourcePoint).toEqual({ x: 50, y: 50 });
    });

    it('未指定位置时默认使用 center', () => {
        const edge = createStubEdge('a', 'b');
        const endpoints = resolveEdgeEndpoints(edge, nodes);
        expect(endpoints!.sourcePoint).toEqual({ x: 0, y: 0 });
        expect(endpoints!.targetPoint).toEqual({ x: 200, y: 100 });
    });

    it('任一节点不存在时返回 null', () => {
        expect(resolveEdgeEndpoints(createStubEdge('a', 'ghost'), nodes)).toBeNull();
        expect(resolveEdgeEndpoints(createStubEdge('ghost', 'b'), nodes)).toBeNull();
    });
});
