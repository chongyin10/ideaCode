import { Node } from './Node';
import { Edge } from './Edge';
import { Port } from './Port';
import { EVENT_NAMES, type BaseEvent, type MouseEvent } from './EventManager';
import type { Graph, Point } from './Graph';

/**
 * GraphEventDispatcher - 图事件分发器
 *
 * 负责将 DOM 鼠标事件分发到对应的图元素（连接桩 > 节点 > 边 > 空白区域），
 * 并维护鼠标悬停状态（mouseenter/mouseleave 的跟踪）。
 * 通过 Graph 的公开 API 与少量 @internal 方法与 Graph 交互。
 */
export class GraphEventDispatcher {
    private lastMouseOverNode: Node | null = null;
    private lastMouseOverEdge: Edge | null = null;
    private lastMouseOverPort: Port | null = null;

    constructor(private graph: Graph) {}

    /**
     * 当前鼠标悬停的节点（Graph 渲染连接桩可见性时使用）
     */
    getHoveredNode(): Node | null {
        return this.lastMouseOverNode;
    }

    /**
     * 将鼠标事件位置转换为世界坐标
     */
    private eventToWorldPoint(e: { clientX: number; clientY: number }): Point {
        const rect = this.graph.getCanvas().getBoundingClientRect();
        return this.graph.screenToWorld({
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
        });
    }

    /**
     * 创建基础鼠标事件对象
     */
    private createMouseEvent(
        originalEvent: globalThis.MouseEvent | globalThis.WheelEvent,
        target: any,
        extraData: Partial<BaseEvent> = {}
    ): MouseEvent {
        const worldPoint = this.eventToWorldPoint(originalEvent);

        return {
            type: 'mouse',
            target,
            originalEvent,
            x: worldPoint.x,
            y: worldPoint.y,
            clientX: originalEvent.clientX,
            clientY: originalEvent.clientY,
            ctrlKey: originalEvent.ctrlKey,
            shiftKey: originalEvent.shiftKey,
            altKey: originalEvent.altKey,
            metaKey: originalEvent.metaKey,
            button: originalEvent.button,
            stopPropagation: () => originalEvent.stopPropagation(),
            preventDefault: () => originalEvent.preventDefault(),
            ...extraData,
        };
    }

    /**
     * 分发鼠标事件到对应的元素
     */
    dispatchMouseEvent(
        eventType: string,
        originalEvent: globalThis.MouseEvent
    ): void {
        const worldPoint = this.eventToWorldPoint(originalEvent);

        // 调用带目标检测的版本
        this.dispatchMouseEventWithTarget(eventType, originalEvent, worldPoint, null, null);
    }

    /**
     * 分发鼠标事件（带已知目标，避免重复遍历）
     */
    dispatchMouseEventWithTarget(
        eventType: string,
        originalEvent: globalThis.MouseEvent,
        worldPoint: Point,
        knownNode: Node | null,
        knownPort: Port | null
    ): void {
        // 创建基础事件数据
        const baseEventData = this.createMouseEvent(originalEvent, null);

        // 如果提供了已知的节点和连接桩，直接使用
        if (knownPort && knownNode) {
            const portEventData = {
                ...baseEventData,
                target: knownPort,
                port: knownPort,
                portId: knownPort.getId(),
                nodeId: knownNode.getId(),
            };
            knownPort.triggerPortEvent(eventType, originalEvent);
            this.graph.emitGraphEvent(EVENT_NAMES[`PORT_${eventType.toUpperCase()}` as keyof typeof EVENT_NAMES], portEventData);
            return;
        }

        if (knownNode) {
            const nodeEventData = {
                ...baseEventData,
                target: knownNode,
                node: knownNode,
            };
            knownNode.triggerNodeEvent(eventType, originalEvent, { x: worldPoint.x, y: worldPoint.y });
            this.graph.emitGraphEvent(EVENT_NAMES[`NODE_${eventType.toUpperCase()}` as keyof typeof EVENT_NAMES], nodeEventData);
            return;
        }

        // 没有已知目标，执行完整检测
        // 1. 检查节点和连接桩（一次遍历，优先级：连接桩 > 节点主体）
        const nodes = this.graph.getAllNodes();
        for (let i = nodes.length - 1; i >= 0; i--) {
            const node = nodes[i];

            // 先检查连接桩
            const port = node.getPortAtPoint(worldPoint);
            if (port) {
                const portEventData = {
                    ...baseEventData,
                    target: port,
                    port,
                    portId: port.getId(),
                    nodeId: node.getId(),
                };
                port.triggerPortEvent(eventType, originalEvent);
                this.graph.emitGraphEvent(EVENT_NAMES[`PORT_${eventType.toUpperCase()}` as keyof typeof EVENT_NAMES], portEventData);
                return;
            }

            // 再检查节点主体
            if (node.containsPoint(worldPoint)) {
                const nodeEventData = {
                    ...baseEventData,
                    target: node,
                    node,
                };
                node.triggerNodeEvent(eventType, originalEvent, { x: worldPoint.x, y: worldPoint.y });
                this.graph.emitGraphEvent(EVENT_NAMES[`NODE_${eventType.toUpperCase()}` as keyof typeof EVENT_NAMES], nodeEventData);
                return;
            }
        }

        // 2. 检查边
        const edges = this.graph.getAllEdges();
        for (let i = edges.length - 1; i >= 0; i--) {
            const edge = edges[i];
            if (edge.containsPoint(worldPoint)) {
                const edgeEventData = {
                    ...baseEventData,
                    target: edge,
                    edge,
                    sourceId: edge.getSourceId(),
                    targetId: edge.getTargetId(),
                };
                edge.triggerEdgeEvent(eventType, originalEvent, { x: worldPoint.x, y: worldPoint.y });
                this.graph.emitGraphEvent(EVENT_NAMES[`EDGE_${eventType.toUpperCase()}` as keyof typeof EVENT_NAMES], edgeEventData);
                return;
            }
        }

        // 3. 空白区域 - 触发 blank 事件并取消选中（由 Graph 处理，涉及其内部选中状态）
        this.graph.dispatchBlankAreaEvent(eventType, baseEventData, worldPoint);
    }

    /**
     * 处理鼠标进入/离开事件
     */
    handleMouseEnterLeave(originalEvent: globalThis.MouseEvent): void {
        const worldPoint = this.eventToWorldPoint(originalEvent);
        const baseEventData = this.createMouseEvent(originalEvent, null);
        const canvas = this.graph.getCanvas();

        // 检查当前鼠标下的元素
        let currentNode: Node | null = null;
        let currentEdge: Edge | null = null;
        let currentPort: Port | null = null;

        const nodes = this.graph.getAllNodes();
        for (let i = nodes.length - 1; i >= 0; i--) {
            const node = nodes[i];

            // 检查连接桩
            const port = node.getPortAtPoint(worldPoint);
            if (port) {
                currentPort = port;
                currentNode = node;
                break;
            }

            // 检查节点
            if (node.containsPoint(worldPoint)) {
                currentNode = node;
                break;
            }
        }

        // 如果没有在节点上，检查边
        if (!currentNode) {
            const edges = this.graph.getAllEdges();
            for (let i = edges.length - 1; i >= 0; i--) {
                if (edges[i].containsPoint(worldPoint)) {
                    currentEdge = edges[i];
                    break;
                }
            }
        }

        // 处理 Port 的 mouseenter/mouseleave
        if (currentPort !== this.lastMouseOverPort) {
            // mouseleave port
            if (this.lastMouseOverPort) {
                const eventData = {
                    ...baseEventData,
                    target: this.lastMouseOverPort,
                    port: this.lastMouseOverPort,
                    portId: this.lastMouseOverPort.getId(),
                    nodeId: this.lastMouseOverPort.getNodeId(),
                };
                this.lastMouseOverPort.emit(EVENT_NAMES.PORT_MOUSELEAVE, eventData);
                this.graph.emitGraphEvent(EVENT_NAMES.PORT_MOUSELEAVE, eventData);
                // 恢复光标：如果仍在节点上则显示 grab，否则显示 default
                canvas.style.cursor = currentNode ? 'grab' : 'default';
            }
            // mouseenter port
            if (currentPort) {
                const eventData = {
                    ...baseEventData,
                    target: currentPort,
                    port: currentPort,
                    portId: currentPort.getId(),
                    nodeId: currentNode?.getId() || '',
                };
                currentPort.emit(EVENT_NAMES.PORT_MOUSEENTER, eventData);
                this.graph.emitGraphEvent(EVENT_NAMES.PORT_MOUSEENTER, eventData);
                // 设置为十字光标
                canvas.style.cursor = 'crosshair';
            }
            this.lastMouseOverPort = currentPort;
        }

        // 处理 Node 的 mouseenter/mouseleave
        if (currentNode !== this.lastMouseOverNode) {
            // 鼠标离开上一个节点（无论是从节点移到空白，还是从节点A移到节点B，或者鼠标离开canvas）
            if (this.lastMouseOverNode) {
                // 使用 triggerNodeEvent 确保同时触发 cell:mouseleave 和 node:mouseleave
                this.lastMouseOverNode.triggerNodeEvent('mouseleave', originalEvent, { x: worldPoint.x, y: worldPoint.y });
                const eventData = { ...baseEventData, target: this.lastMouseOverNode, node: this.lastMouseOverNode };
                this.graph.emitGraphEvent(EVENT_NAMES.NODE_MOUSELEAVE, eventData);
                // 恢复默认光标（如果不在 Port 上）
                if (!currentPort) {
                    canvas.style.cursor = 'default';
                }
                // 如果节点设置了 portsAlwaysVisible 为 false，鼠标离开时需要重新渲染以隐藏连接桩
                if (!this.lastMouseOverNode.portsAlwaysVisible) {
                    this.graph.scheduleRender();
                }
            }
            // 鼠标进入新节点
            if (currentNode) {
                // 使用 triggerNodeEvent 确保同时触发 cell:mouseenter 和 node:mouseenter
                currentNode.triggerNodeEvent('mouseenter', originalEvent, { x: worldPoint.x, y: worldPoint.y });
                const eventData = { ...baseEventData, target: currentNode, node: currentNode };
                this.graph.emitGraphEvent(EVENT_NAMES.NODE_MOUSEENTER, eventData);
                // 设置为抓取光标（如果不在 Port 上）
                if (!currentPort) {
                    canvas.style.cursor = 'grab';
                }
                // 如果节点设置了 portsAlwaysVisible 为 false，鼠标进入时需要重新渲染以显示连接桩
                if (!currentNode.portsAlwaysVisible) {
                    this.graph.scheduleRender();
                }
            }
            this.lastMouseOverNode = currentNode;
        }

        // 处理 Edge 的 mouseenter/mouseleave
        if (currentEdge !== this.lastMouseOverEdge) {
            // mouseleave edge
            if (this.lastMouseOverEdge) {
                const eventData = { ...baseEventData, target: this.lastMouseOverEdge, edge: this.lastMouseOverEdge };
                this.lastMouseOverEdge.emit(EVENT_NAMES.EDGE_MOUSELEAVE, eventData);
                this.graph.emitGraphEvent(EVENT_NAMES.EDGE_MOUSELEAVE, eventData);
                // 恢复默认光标
                canvas.style.cursor = 'default';
            }
            // mouseenter edge
            if (currentEdge) {
                const eventData = { ...baseEventData, target: currentEdge, edge: currentEdge };
                currentEdge.emit(EVENT_NAMES.EDGE_MOUSEENTER, eventData);
                this.graph.emitGraphEvent(EVENT_NAMES.EDGE_MOUSEENTER, eventData);
                // 设置为移动光标，表示可以移动边
                canvas.style.cursor = 'move';
            }
            this.lastMouseOverEdge = currentEdge;
        }
    }
}
