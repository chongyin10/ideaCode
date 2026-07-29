import { Node } from '../Node';
import { Port } from '../Port';
import { EdgeType } from '../Edge';
import type { Graph, Point } from '../Graph';

/**
 * ConnectionManager - 连接拖拽状态机
 *
 * 负责从连接桩拖出临时连线到完成连接的完整流程：
 * - 开始连接（设置光标、禁用 HTML 节点事件捕获）
 * - 更新连接目标（连接桩命中检测与吸附）
 * - 完成连接（校验并创建边）
 * - 取消/重置连接
 * - 渲染连接中的临时连线
 *
 * 通过 Graph 的公开 API 与少量 @internal 方法与 Graph 交互，
 * 行为与重构前 Graph 内的实现完全一致。
 */
export class ConnectionManager {
    private isConnecting: boolean = false;
    private connectSourceNode: Node | null = null;
    private connectSourcePort: Port | null = null;
    private connectTargetNode: Node | null = null;
    private connectTargetPort: Port | null = null;
    private connectCurrentPoint: Point = { x: 0, y: 0 };

    constructor(private graph: Graph) {}

    /**
     * 是否正在进行连接拖拽
     */
    isActive(): boolean {
        return this.isConnecting;
    }

    /**
     * 开始连接拖拽
     */
    start(sourceNode: Node, sourcePort: Port, startPoint: Point): void {
        this.isConnecting = true;
        this.connectSourceNode = sourceNode;
        this.connectSourcePort = sourcePort;
        this.connectCurrentPoint = startPoint;
        this.connectTargetNode = null;
        this.connectTargetPort = null;

        this.graph.getCanvas().style.cursor = 'crosshair';

        // 禁用所有 HTML 节点的鼠标事件捕获，使鼠标事件能够穿透到 overlay 层
        // 这样在连接拖拽时，鼠标经过 HTML 节点也不会中断连接线的更新
        this.graph.setHtmlNodesPointerEvents(false);

        this.graph.scheduleRender();
    }

    /**
     * 更新连接目标
     */
    updateTarget(worldPoint: Point): void {
        if (!this.isConnecting) return;

        this.connectCurrentPoint = worldPoint;

        // 查找当前鼠标下的连接桩
        let targetPort: Port | null = null;
        let targetNode: Node | null = null;

        const nodes = this.graph.getAllNodes();
        for (let i = nodes.length - 1; i >= 0; i--) {
            const node = nodes[i];
            // 跳过源节点
            if (node === this.connectSourceNode) continue;

            const port = node.getPortAtPoint(worldPoint);
            if (port) {
                targetPort = port;
                targetNode = node;
                break;
            }
        }

        // 吸附逻辑：如果鼠标不在连接桩上，检查是否在吸附范围内
        if (!targetPort) {
            let closestPort: Port | null = null;
            let closestNode: Node | null = null;
            let minDistance = Infinity;

            for (const node of nodes) {
                // 跳过源节点
                if (node === this.connectSourceNode) continue;

                const nodePos = node.getPosition();
                const nodeStyle = node.getStyle();

                // 获取节点的所有连接桩
                const ports = node.getAllPorts ? node.getAllPorts() : [];

                for (const port of ports) {
                    const distance = port.getDistanceToPoint(
                        worldPoint,
                        nodePos.x,
                        nodePos.y,
                        nodeStyle.width,
                        nodeStyle.height
                    );
                    const snapDistance = port.getSnapDistance();

                    // 如果距离小于吸附距离且比之前找到的更近
                    if (distance <= snapDistance && distance < minDistance) {
                        minDistance = distance;
                        closestPort = port;
                        closestNode = node;
                    }
                }
            }

            if (closestPort && closestNode) {
                targetPort = closestPort;
                targetNode = closestNode;
                // 吸附时，将当前点设置为连接桩的位置
                const nodePos = targetNode.getPosition();
                const nodeStyle = targetNode.getStyle();
                this.connectCurrentPoint = targetPort.getConnectionPoint(
                    nodePos.x,
                    nodePos.y,
                    nodeStyle.width,
                    nodeStyle.height
                );
            }
        }

        // 如果目标变化，更新状态
        if (targetPort !== this.connectTargetPort) {
            this.connectTargetPort = targetPort;
            this.connectTargetNode = targetNode;
        }

        this.graph.scheduleRender();
    }

    /**
     * 完成连接
     */
    complete(): void {
        if (!this.isConnecting) return;

        // 如果有有效的目标连接桩，创建边
        if (this.connectSourceNode && this.connectSourcePort &&
            this.connectTargetNode && this.connectTargetPort) {

            // 调用连接验证函数
            const validateResult = this.graph.runValidateConnection({
                sourceNode: this.connectSourceNode,
                sourcePort: this.connectSourcePort,
                targetNode: this.connectTargetNode,
                targetPort: this.connectTargetPort,
            });

            // 如果验证失败，不创建边
            if (!validateResult) {
                this.reset();
                return;
            }

            this.graph.addEdge({
                id: `edge-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                source: {
                    nodeId: this.connectSourceNode.getId(),
                    portId: this.connectSourcePort.getId(),
                },
                target: {
                    nodeId: this.connectTargetNode.getId(),
                    portId: this.connectTargetPort.getId(),
                },
                type: EdgeType.Straight,
            });
        }

        this.reset();
    }

    /**
     * 取消连接
     */
    cancel(): void {
        this.reset();
    }

    /**
     * 重置连接状态
     */
    private reset(): void {
        this.isConnecting = false;
        this.connectSourceNode = null;
        this.connectSourcePort = null;
        this.connectTargetNode = null;
        this.connectTargetPort = null;
        this.connectCurrentPoint = { x: 0, y: 0 };
        this.graph.getCanvas().style.cursor = 'default';

        // 恢复所有 HTML 节点的鼠标事件捕获
        this.graph.setHtmlNodesPointerEvents(true);

        this.graph.scheduleRender();
    }

    /**
     * 绘制连接中的临时连线
     */
    renderConnectingEdge(edgeCtx: CanvasRenderingContext2D): void {
        if (!this.isConnecting || !this.connectSourceNode || !this.connectSourcePort) {
            return;
        }

        const sourcePoint = this.connectSourcePort.getConnectionPoint(
            this.connectSourceNode.getPosition().x,
            this.connectSourceNode.getPosition().y,
            this.connectSourceNode.getStyle().width,
            this.connectSourceNode.getStyle().height
        );

        const targetPoint = this.connectCurrentPoint;

        // 使用边线层画布绘制临时连线
        edgeCtx.save();

        // 设置虚线样式
        edgeCtx.strokeStyle = this.connectTargetPort ? '#3b82f6' : '#94a3b8';
        edgeCtx.lineWidth = 2;
        edgeCtx.lineCap = 'round';
        edgeCtx.setLineDash([5, 5]);

        // 绘制直线
        edgeCtx.beginPath();
        edgeCtx.moveTo(sourcePoint.x, sourcePoint.y);
        edgeCtx.lineTo(targetPoint.x, targetPoint.y);
        edgeCtx.stroke();

        // 如果有目标连接桩，高亮显示
        if (this.connectTargetPort && this.connectTargetNode) {
            const portPos = this.connectTargetPort.getConnectionPoint(
                this.connectTargetNode.getPosition().x,
                this.connectTargetNode.getPosition().y,
                this.connectTargetNode.getStyle().width,
                this.connectTargetNode.getStyle().height
            );

            // 绘制目标点高亮圈
            edgeCtx.beginPath();
            edgeCtx.arc(portPos.x, portPos.y, 8, 0, Math.PI * 2);
            edgeCtx.fillStyle = 'rgba(59, 130, 246, 0.2)';
            edgeCtx.fill();
            edgeCtx.strokeStyle = '#3b82f6';
            edgeCtx.lineWidth = 2;
            edgeCtx.setLineDash([]);
            edgeCtx.stroke();
        }

        edgeCtx.restore();
    }
}
