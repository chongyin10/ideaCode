import type { Node } from '../Node';
import type { Edge, EdgeAnchor } from '../Edge';

export interface Point {
    x: number;
    y: number;
}

/**
 * 计算两条线段的交叉点
 * @param p1 - 第一条线段起点
 * @param p2 - 第一条线段终点
 * @param p3 - 第二条线段起点
 * @param p4 - 第二条线段终点
 * @returns 交叉点坐标，如果不相交则返回 null
 */
export function getLineSegmentIntersection(
    p1: Point, p2: Point,
    p3: Point, p4: Point
): Point | null {
    const d1x = p2.x - p1.x;
    const d1y = p2.y - p1.y;
    const d2x = p4.x - p3.x;
    const d2y = p4.y - p3.y;

    const cross = d1x * d2y - d1y * d2x;

    // 平行或重合
    if (Math.abs(cross) < 1e-10) {
        return null;
    }

    const dx = p3.x - p1.x;
    const dy = p3.y - p1.y;

    const t1 = (dx * d2y - dy * d2x) / cross;
    const t2 = (dx * d1y - dy * d1x) / cross;

    // 检查交叉点是否在两条线段上（不包括端点）
    const epsilon = 0.01;
    if (t1 > epsilon && t1 < 1 - epsilon && t2 > epsilon && t2 < 1 - epsilon) {
        return {
            x: p1.x + t1 * d1x,
            y: p1.y + t1 * d1y
        };
    }

    return null;
}

/**
 * 解析单个锚点的连接点坐标
 * 优先使用连接桩（port）的连接点，否则回退到节点锚点
 */
function resolveAnchorPoint(node: Node, anchor: EdgeAnchor): Point {
    if (anchor.portId) {
        const port = node.getPort(anchor.portId);
        if (port) {
            return port.getConnectionPoint(
                node.getPosition().x,
                node.getPosition().y,
                node.getStyle().width,
                node.getStyle().height
            );
        }
    }
    return node.getAnchorPoint(anchor.position || 'center');
}

/**
 * 解析一条边的源/目标连接点坐标
 * @param edge - 目标边
 * @param nodes - 节点表（nodeId -> Node）
 * @returns 端点坐标；若任一节点不存在则返回 null
 */
export function resolveEdgeEndpoints(
    edge: Edge,
    nodes: Map<string, Node>
): { sourcePoint: Point; targetPoint: Point } | null {
    const sourceNode = nodes.get(edge.getSourceId());
    const targetNode = nodes.get(edge.getTargetId());
    if (!sourceNode || !targetNode) {
        return null;
    }
    return {
        sourcePoint: resolveAnchorPoint(sourceNode, edge.getSourceAnchor()),
        targetPoint: resolveAnchorPoint(targetNode, edge.getTargetAnchor()),
    };
}
