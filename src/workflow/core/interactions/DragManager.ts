import { Node } from '../Node';
import { Edge } from '../Edge';
import { EVENT_NAMES } from '../EventManager';
import type { Graph, Point } from '../Graph';

/**
 * DragManager - 拖拽状态机
 *
 * 负责三类拖拽交互：
 * - 节点拖拽（node:dragstart / node:drag / node:dragend，含延迟的 node:unselected 触发）
 * - 边拖拽（调整边的偏移量）
 * - 画布平移拖拽（修改视口偏移，结束时触发 onDragEnd 回调）
 *
 * 通过 Graph 的公开 API 与少量 @internal 方法与 Graph 交互，
 * 行为与重构前 Graph 内的实现完全一致。
 */
export class DragManager {
    // 节点拖拽状态
    private draggedNode: Node | null = null;
    private isDraggingNode: boolean = false;
    private dragStartPosition: Point = { x: 0, y: 0 };
    private dragNodeStartPosition: Point = { x: 0, y: 0 };

    // 边拖拽状态
    private isDraggingEdge: boolean = false;
    private draggedEdge: Edge | null = null;
    private dragEdgeStartOffset: Point = { x: 0, y: 0 };

    // 画布平移状态
    private isPanning: boolean = false;
    private lastPanPosition: Point | null = null;

    constructor(private graph: Graph) {}

    // ==================== 状态查询 ====================

    /**
     * 是否正在拖拽节点
     */
    isNodeDragging(): boolean {
        return this.isDraggingNode;
    }

    /**
     * 是否正在拖拽边
     */
    isEdgeDragging(): boolean {
        return this.isDraggingEdge;
    }

    /**
     * 是否正在平移画布
     */
    isPanningActive(): boolean {
        return this.isPanning;
    }

    // ==================== 节点拖拽 ====================

    /**
     * 开始拖拽节点
     */
    startNodeDrag(node: Node, screenPoint: Point, worldPoint: Point, e: globalThis.MouseEvent): void {
        this.draggedNode = node;
        this.isDraggingNode = true;
        this.dragStartPosition = { ...screenPoint };
        const nodePos = node.getPosition();
        this.dragNodeStartPosition = { ...nodePos };

        // 选中节点（延迟触发 node:unselected 事件，在 mouseup 时触发）
        this.graph.selectNode(node.getId(), false);

        // 触发 node:dragstart 事件
        node.triggerNodeEvent('dragstart', e, { x: worldPoint.x, y: worldPoint.y });
        this.graph.emitGraphEvent(EVENT_NAMES.NODE_DRAGSTART, {
            type: 'node',
            target: node,
            node: node,
            originalEvent: e,
            x: worldPoint.x,
            y: worldPoint.y,
        });

        this.graph.getCanvas().style.cursor = 'grabbing';
    }

    /**
     * 更新节点拖拽
     */
    updateNodeDrag(screenPoint: Point, e: globalThis.MouseEvent): void {
        if (!this.isDraggingNode || !this.draggedNode) return;
        const node = this.draggedNode;

        // 计算鼠标移动的差值（屏幕坐标）
        const scale = this.graph.getViewportState().scale;
        const deltaX = (screenPoint.x - this.dragStartPosition.x) / scale;
        const deltaY = (screenPoint.y - this.dragStartPosition.y) / scale;

        // 更新节点位置
        const newX = this.dragNodeStartPosition.x + deltaX;
        const newY = this.dragNodeStartPosition.y + deltaY;
        node.setPosition(newX, newY);

        // 触发 node:drag 事件
        node.triggerNodeEvent('drag', e, { x: newX, y: newY });
        this.graph.emitGraphEvent(EVENT_NAMES.NODE_DRAG, {
            type: 'node',
            target: node,
            node: node,
            originalEvent: e,
            x: newX,
            y: newY,
        });

        this.graph.scheduleRender();
    }

    /**
     * 完成节点拖拽
     * @returns 是否处理了节点拖拽结束（对应原来的 isDraggingNode && draggedNode 分支）
     */
    completeNodeDrag(e: globalThis.MouseEvent, worldPoint: Point): boolean {
        if (!this.isDraggingNode || !this.draggedNode) return false;
        const node = this.draggedNode;

        // 触发 node:dragend 事件
        const finalPosition = node.getPosition();
        const oldPosition = { ...this.dragNodeStartPosition };
        node.triggerNodeEvent('dragend', e, { x: finalPosition.x, y: finalPosition.y });
        this.graph.emitGraphEvent(EVENT_NAMES.NODE_DRAGEND, {
            type: 'node',
            target: node,
            node: node,
            originalEvent: e,
            x: finalPosition.x,
            y: finalPosition.y,
            oldPosition: oldPosition,
            newPosition: finalPosition,
        });

        // 触发延迟的 node:unselected 事件（如果有）
        this.graph.flushPendingNodeUnselected(worldPoint.x, worldPoint.y, e);

        this.isDraggingNode = false;
        this.draggedNode = null;
        // 恢复光标：如果在节点上显示 grab，否则显示 default
        this.graph.getCanvas().style.cursor = this.graph.hasHoveredNode() ? 'grab' : 'default';
        return true;
    }

    // ==================== 边拖拽 ====================

    /**
     * 开始拖拽边
     */
    startEdgeDrag(edge: Edge, screenPoint: Point): void {
        this.isDraggingEdge = true;
        this.draggedEdge = edge;
        this.dragStartPosition = { ...screenPoint };
        this.dragEdgeStartOffset = edge.getOffset();

        // 选中边
        this.graph.selectEdge(edge.getId());

        this.graph.getCanvas().style.cursor = 'move';

        this.graph.scheduleRender();
    }

    /**
     * 更新边拖拽
     */
    updateEdgeDrag(screenPoint: Point): void {
        if (!this.isDraggingEdge || !this.draggedEdge) return;

        // 计算鼠标移动的差值（世界坐标）
        const scale = this.graph.getViewportState().scale;
        const deltaX = (screenPoint.x - this.dragStartPosition.x) / scale;
        const deltaY = (screenPoint.y - this.dragStartPosition.y) / scale;

        // 更新边的偏移量
        const newOffsetX = this.dragEdgeStartOffset.x + deltaX;
        const newOffsetY = this.dragEdgeStartOffset.y + deltaY;
        this.draggedEdge.setOffset(newOffsetX, newOffsetY);

        this.graph.scheduleRender();
    }

    /**
     * 完成边拖拽
     */
    completeEdgeDrag(): void {
        if (!this.isDraggingEdge || !this.draggedEdge) return;

        this.isDraggingEdge = false;
        this.draggedEdge = null;
        this.dragStartPosition = { x: 0, y: 0 };
        this.dragEdgeStartOffset = { x: 0, y: 0 };

        this.graph.getCanvas().style.cursor = 'default';

        this.graph.scheduleRender();
    }

    // ==================== 画布平移 ====================

    /**
     * 开始画布平移拖拽
     */
    startPan(clientX: number, clientY: number): void {
        this.isPanning = true;
        this.lastPanPosition = {
            x: clientX,
            y: clientY,
        };
        this.graph.getCanvas().style.cursor = this.graph.getDraggingCursor();
    }

    /**
     * 更新画布平移
     * @returns 是否处理了画布平移（对应原来的 state.isDragging && lastMousePosition 分支）
     */
    updatePan(clientX: number, clientY: number): boolean {
        if (!this.isPanning || !this.lastPanPosition) return false;

        const deltaX = clientX - this.lastPanPosition.x;
        const deltaY = clientY - this.lastPanPosition.y;

        const viewport = this.graph.getViewportState();
        viewport.offset.x += deltaX;
        viewport.offset.y += deltaY;

        this.lastPanPosition = {
            x: clientX,
            y: clientY,
        };

        this.graph.scheduleRender();
        return true;
    }

    /**
     * 完成画布平移
     */
    completePan(): void {
        this.isPanning = false;
        this.lastPanPosition = null;
        this.graph.getCanvas().style.cursor = 'default';

        // 触发拖拽完成回调
        this.graph.notifyDragEnd();
    }
}
