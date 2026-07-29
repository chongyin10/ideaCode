import { Node, type ResizeHandlePosition } from '../Node';
import type { Graph, Point } from '../Graph';

/** resize 手柄位置对应的光标样式 */
const RESIZE_CURSOR_MAP: Record<ResizeHandlePosition, string> = {
    'nw': 'nw-resize',
    'n': 'n-resize',
    'ne': 'ne-resize',
    'e': 'e-resize',
    'se': 'se-resize',
    's': 's-resize',
    'sw': 'sw-resize',
    'w': 'w-resize',
};

/**
 * ResizeManager - 节点缩放（resize）状态机
 *
 * 负责选中节点 resize 手柄的拖拽缩放流程：
 * - 开始 resize（记录起始边界、设置光标、触发 node:resizestart）
 * - 更新 resize（实时调整节点位置与尺寸，触发 node:resize）
 * - 完成 resize（触发 node:resizeend）
 * - 重置/取消 resize
 * - resize 手柄悬停时的光标变化
 *
 * 通过 Graph 的公开 API 与少量 @internal 方法与 Graph 交互，
 * 行为与重构前 Graph 内的实现完全一致。
 */
export class ResizeManager {
    private isResizing: boolean = false;
    private resizingNode: Node | null = null;
    private resizingHandle: ResizeHandlePosition | null = null;
    private resizeStartPoint: Point = { x: 0, y: 0 };
    private resizeStartBounds: { x: number; y: number; width: number; height: number } | null = null;

    constructor(private graph: Graph) {}

    /**
     * 是否正在进行 resize
     */
    isActive(): boolean {
        return this.isResizing;
    }

    /**
     * 开始 resize
     */
    start(node: Node, handle: ResizeHandlePosition, startPoint: Point): void {
        this.isResizing = true;
        this.resizingNode = node;
        this.resizingHandle = handle;
        this.resizeStartPoint = startPoint;
        this.resizeStartBounds = node.getBounds();

        // 根据 handle 位置设置光标样式
        this.graph.getCanvas().style.cursor = RESIZE_CURSOR_MAP[handle];

        // 触发 resize 开始事件
        this.graph.emitGraphEvent('node:resizestart', {
            type: 'node',
            target: node,
            node: node,
            handle: handle,
            startPoint: startPoint,
        });

        this.graph.scheduleRender();
    }

    /**
     * 更新 resize
     */
    update(worldPoint: Point): void {
        if (!this.isResizing || !this.resizingNode || !this.resizingHandle || !this.resizeStartBounds) return;

        // 计算鼠标移动的差值（世界坐标）
        // worldPoint 和 resizeStartPoint 已经是世界坐标，直接相减得到世界坐标系的移动距离
        // 这样节点在屏幕上的尺寸变化与鼠标移动的屏幕距离成正比
        const deltaX = worldPoint.x - this.resizeStartPoint.x;
        const deltaY = worldPoint.y - this.resizeStartPoint.y;

        // 计算新的节点尺寸和位置，传入起始边界框以确保计算正确
        const result = this.resizingNode.calculateResize(
            this.resizingHandle,
            deltaX,
            deltaY,
            50,  // minWidth
            30,  // minHeight
            this.resizeStartBounds  // 传入起始边界框，避免累积误差
        );

        if (result.changed) {
            // 更新节点位置和尺寸
            this.resizingNode.setPosition(result.x, result.y);
            this.resizingNode.updateStyle({
                width: result.width,
                height: result.height,
            });

            // 触发 resize 事件（resize 过程中持续触发）
            this.graph.emitGraphEvent('node:resize', {
                type: 'node',
                target: this.resizingNode,
                node: this.resizingNode,
                bounds: this.resizingNode.getBounds(),
            });

            // 立即渲染，使 handles 跟随节点实时更新
            this.graph.renderNow();
        }
    }

    /**
     * 完成 resize
     */
    complete(): void {
        if (this.isResizing && this.resizingNode) {
            // 触发 resize 完成事件
            const bounds = this.resizingNode.getBounds();
            this.graph.emitGraphEvent('node:resizeend', {
                type: 'node',
                target: this.resizingNode,
                node: this.resizingNode,
                bounds,
            });
        }

        this.reset();
    }

    /**
     * 重置 resize 状态
     */
    reset(): void {
        this.isResizing = false;
        this.resizingNode = null;
        this.resizingHandle = null;
        this.resizeStartPoint = { x: 0, y: 0 };
        this.resizeStartBounds = null;
        this.graph.getCanvas().style.cursor = 'default';

        this.graph.scheduleRender();
    }

    /**
     * 处理 resize handle 悬停时的光标变化
     */
    handleHover(e: globalThis.MouseEvent): void {
        const rect = this.graph.getCanvas().getBoundingClientRect();
        const worldPoint = this.graph.screenToWorld({
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
        });

        // 检查是否悬停在选中节点的 resize handle 上
        const selectedNode = this.graph.getSelectedNode();
        if (selectedNode && !selectedNode.isHtmlNode()) {
            const resizeHandle = selectedNode.getResizeHandleAtPoint(worldPoint);
            if (resizeHandle) {
                this.graph.getCanvas().style.cursor = RESIZE_CURSOR_MAP[resizeHandle];
                return;
            }
        }

        // 恢复光标：如果在节点上显示 grab，否则显示 default
        // 注意：这里不处理，由 handleMouseEnterLeave 方法处理节点/端口/边的光标
    }
}
