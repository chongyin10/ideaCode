import { Graph, Point } from '../core/Graph';
import { Plugin } from './Snapline';
import { EventHandler } from '../core/EventManager';

/**
 * 小地图位置配置
 */
export type MiniMapPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/**
 * MiniMap 配置选项
 */
export interface MiniMapOptions {
    /** 是否启用小地图 */
    enabled?: boolean;
    /** 小地图宽度 */
    width?: number;
    /** 小地图高度 */
    height?: number;
    /** 小地图位置 */
    position?: MiniMapPosition;
    /** 自定义左边距（仅当 position 为自定义时有效） */
    left?: number | string;
    /** 自定义上边距（仅当 position 为自定义时有效） */
    top?: number | string;
    /** 自定义右边距（仅当 position 为自定义时有效） */
    right?: number | string;
    /** 自定义下边距（仅当 position 为自定义时有效） */
    bottom?: number | string;
    /** 小地图背景颜色 */
    backgroundColor?: string;
    /** 小地图边框颜色 */
    borderColor?: string;
    /** 小地图边框宽度 */
    borderWidth?: number;
    /** 小地图圆角 */
    borderRadius?: number;
    /** 视口矩形填充颜色 */
    viewportFillColor?: string;
    /** 视口矩形边框颜色 */
    viewportBorderColor?: string;
    /** 视口矩形边框宽度 */
    viewportBorderWidth?: number;
    /** 节点在小地图中的颜色 */
    nodeColor?: string;
    /** 边在地图中的颜色 */
    edgeColor?: string;
    /** 小地图缩放比例（相对于主画布的额外缩放） */
    minScale?: number;
    /** 小地图最大缩放比例 */
    maxScale?: number;
    /** 是否显示视口矩形 */
    showViewport?: boolean;
    /** 是否允许通过拖拽视口来移动画布 */
    draggable?: boolean;
    /** 是否允许通过滚轮缩放画布 */
    scalable?: boolean;
    /** 小地图内边距 */
    padding?: number;
    /** 小地图透明度 */
    opacity?: number;
    /** 小地图层级 */
    zIndex?: number;
    /** 视口变化回调 */
    onViewportChange?: (transform: { offset: Point; scale: number }) => void;
}

/**
 * MiniMap - 小地图插件
 *
 * 在画布上显示一个小地图，用于快速导航：
 * - 显示所有节点的缩略图
 * - 显示当前视口位置
 * - 支持拖拽视口来移动画布
 * - 支持滚轮缩放画布
 * - 支持自定义位置和样式
 *
 * 使用示例：
 * ```typescript
 * const graph = new Graph({
 *     container: document.getElementById('canvas'),
 * });
 *
 * // 使用默认配置
 * const miniMap = new MiniMap();
 * graph.use(miniMap);
 *
 * // 使用自定义配置
 * const miniMap = new MiniMap({
 *     width: 200,
 *     height: 150,
 *     position: 'bottom-right',
 *     backgroundColor: '#f5f5f5',
 *     viewportFillColor: 'rgba(0, 123, 255, 0.1)',
 *     viewportBorderColor: '#007bff',
 * });
 * graph.use(miniMap);
 * ```
 */
export class MiniMap implements Plugin {
    name = 'minimap';

    private graph: Graph | null = null;
    private options: Required<MiniMapOptions>;
    private container: HTMLDivElement | null = null;
    private canvas: HTMLCanvasElement | null = null;
    private ctx: CanvasRenderingContext2D | null = null;
    private eventHandler: EventHandler | null = null;

    // 视口拖拽状态
    private isDraggingViewport: boolean = false;
    private dragStartPoint: Point = { x: 0, y: 0 };
    private dragStartOffset: Point = { x: 0, y: 0 };

    // 缩放状态
    private miniMapScale: number = 1;
    private miniMapOffset: Point = { x: 0, y: 0 };

    // 默认配置
    private static readonly DEFAULT_OPTIONS: Required<MiniMapOptions> = {
        enabled: true,
        width: 200,
        height: 150,
        position: 'bottom-right',
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        backgroundColor: '#ffffff',
        borderColor: '#e5e7eb',
        borderWidth: 1,
        borderRadius: 4,
        viewportFillColor: 'rgba(0, 123, 255, 0.1)',
        viewportBorderColor: '#007bff',
        viewportBorderWidth: 2,
        nodeColor: '#4b5563',
        edgeColor: '#9ca3af',
        minScale: 0.01,
        maxScale: 1,
        showViewport: true,
        draggable: true,
        scalable: true,
        padding: 20,
        opacity: 0.9,
        zIndex: 1000,
        onViewportChange: () => {},
    };

    constructor(options: MiniMapOptions = {}) {
        this.options = {
            ...MiniMap.DEFAULT_OPTIONS,
            ...options,
        };
    }

    /**
     * 安装插件
     */
    install(graph: Graph): void {
        this.graph = graph;
        this.createMiniMap();
        this.bindEvents();
        // 延迟渲染，确保 Graph 已经初始化完成
        requestAnimationFrame(() => {
            this.render();
        });
    }

    /**
     * 卸载插件
     */
    uninstall(): void {
        this.unbindEvents();
        this.destroyMiniMap();
        this.graph = null;
    }

    /**
     * 创建小地图元素
     */
    private createMiniMap(): void {
        if (!this.graph) return;

        const graphContainer = this.graph.getCanvas().parentElement;
        if (!graphContainer) return;

        // 确保父容器有定位
        const computedStyle = window.getComputedStyle(graphContainer);
        if (computedStyle.position === 'static') {
            graphContainer.style.position = 'relative';
        }

        // 创建小地图容器
        this.container = document.createElement('div');
        this.container.className = 'graph-minimap';
        this.container.style.cssText = `
            position: absolute;
            width: ${this.options.width}px;
            height: ${this.options.height}px;
            background-color: ${this.options.backgroundColor};
            border: ${this.options.borderWidth}px solid ${this.options.borderColor};
            border-radius: ${this.options.borderRadius}px;
            overflow: hidden;
            opacity: ${this.options.opacity};
            z-index: ${this.options.zIndex};
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
            cursor: default;
            user-select: none;
        `;

        // 设置位置
        this.updatePosition();

        // 创建画布
        this.canvas = document.createElement('canvas');
        this.canvas.width = this.options.width;
        this.canvas.height = this.options.height;
        this.canvas.style.cssText = `
            display: block;
            width: 100%;
            height: 100%;
        `;

        this.ctx = this.canvas.getContext('2d');

        this.container.appendChild(this.canvas);
        graphContainer.appendChild(this.container);
    }

    /**
     * 更新小地图位置
     */
    private updatePosition(): void {
        if (!this.container) return;

        const { position, left, top, right, bottom } = this.options;
        const gap = 10; // 与画布边缘的间距

        // 重置所有位置样式
        this.container.style.left = 'auto';
        this.container.style.top = 'auto';
        this.container.style.right = 'auto';
        this.container.style.bottom = 'auto';

        switch (position) {
            case 'top-left':
                this.container.style.left = typeof left === 'number' ? `${left}px` : String(left || `${gap}px`);
                this.container.style.top = typeof top === 'number' ? `${top}px` : String(top || `${gap}px`);
                break;
            case 'top-right':
                this.container.style.right = typeof right === 'number' ? `${right}px` : String(right || `${gap}px`);
                this.container.style.top = typeof top === 'number' ? `${top}px` : String(top || `${gap}px`);
                break;
            case 'bottom-left':
                this.container.style.left = typeof left === 'number' ? `${left}px` : String(left || `${gap}px`);
                this.container.style.bottom = typeof bottom === 'number' ? `${bottom}px` : String(bottom || `${gap}px`);
                break;
            case 'bottom-right':
            default:
                this.container.style.right = typeof right === 'number' ? `${right}px` : String(right || `${gap}px`);
                this.container.style.bottom = typeof bottom === 'number' ? `${bottom}px` : String(bottom || `${gap}px`);
                break;
        }
    }

    /**
     * 绑定事件
     */
    private bindEvents(): void {
        if (!this.graph || !this.canvas) return;

        // 监听画布变化 - 使用正确的事件名称
        this.eventHandler = () => {
            this.render();
        };

        // 注册事件监听 - 使用 Graph 中实际存在的事件
        const eventManager = (this.graph as any).eventManager;
        if (eventManager) {
            // 节点相关事件
            eventManager.on('node:drag', this.eventHandler);
            eventManager.on('node:dragend', this.eventHandler);
            eventManager.on('node:resize', this.eventHandler);
            
            // 画布拖拽和缩放通过鼠标事件监听
        }

        // 绑定小地图交互事件
        this.canvas.addEventListener('mousedown', this.handleMouseDown);
        this.canvas.addEventListener('mousemove', this.handleMouseMove);
        this.canvas.addEventListener('mouseup', this.handleMouseUp);
        this.canvas.addEventListener('mouseenter', this.handleMouseEnter);
        this.canvas.addEventListener('mouseleave', this.handleMouseLeave);
        this.canvas.addEventListener('wheel', this.handleWheel, { passive: false });
        this.canvas.addEventListener('click', this.handleClick);

        // 监听主画布的鼠标事件来更新小地图
        const mainCanvas = this.graph.getCanvas();
        if (mainCanvas) {
            mainCanvas.addEventListener('mousemove', this.handleMainCanvasChange);
            mainCanvas.addEventListener('mouseup', this.handleMainCanvasChange);
            mainCanvas.addEventListener('wheel', this.handleMainCanvasChange);
        }
    }

    /**
     * 处理主画布变化
     */
    private handleMainCanvasChange = (): void => {
        this.render();
    };

    /**
     * 解绑事件
     */
    private unbindEvents(): void {
        if (!this.graph) return;

        // 移除事件监听
        const eventManager = (this.graph as any).eventManager;
        if (eventManager && this.eventHandler) {
            eventManager.off('node:drag', this.eventHandler);
            eventManager.off('node:dragend', this.eventHandler);
            eventManager.off('node:resize', this.eventHandler);
        }

        // 移除小地图交互事件
        if (this.canvas) {
            this.canvas.removeEventListener('mousedown', this.handleMouseDown);
            this.canvas.removeEventListener('mousemove', this.handleMouseMove);
            this.canvas.removeEventListener('mouseup', this.handleMouseUp);
            this.canvas.removeEventListener('mouseenter', this.handleMouseEnter);
            this.canvas.removeEventListener('mouseleave', this.handleMouseLeave);
            this.canvas.removeEventListener('wheel', this.handleWheel);
            this.canvas.removeEventListener('click', this.handleClick);
        }

        // 移除主画布事件监听
        const mainCanvas = this.graph.getCanvas();
        if (mainCanvas) {
            mainCanvas.removeEventListener('mousemove', this.handleMainCanvasChange);
            mainCanvas.removeEventListener('mouseup', this.handleMainCanvasChange);
            mainCanvas.removeEventListener('wheel', this.handleMainCanvasChange);
        }
    }

    /**
     * 销毁小地图元素
     */
    private destroyMiniMap(): void {
        if (this.container && this.container.parentElement) {
            this.container.parentElement.removeChild(this.container);
        }
        this.container = null;
        this.canvas = null;
        this.ctx = null;
    }

    /**
     * 计算内容边界
     */
    private calculateContentBounds(): { x: number; y: number; width: number; height: number } {
        if (!this.graph) {
            return { x: 0, y: 0, width: 100, height: 100 };
        }

        const nodes = this.graph.getAllNodes();
        if (nodes.length === 0) {
            return { x: 0, y: 0, width: 100, height: 100 };
        }

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        nodes.forEach((node) => {
            const pos = node.getPosition();
            const style = node.getStyle();
            const x = pos.x;
            const y = pos.y;
            const width = style.width;
            const height = style.height;

            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x + width);
            maxY = Math.max(maxY, y + height);
        });

        return {
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY,
        };
    }

    /**
     * 计算小地图缩放比例
     */
    private calculateMiniMapScale(): void {
        if (!this.canvas) return;

        const bounds = this.calculateContentBounds();

        const padding = this.options.padding;
        const availableWidth = this.canvas.width - padding * 2;
        const availableHeight = this.canvas.height - padding * 2;

        if (bounds.width === 0 || bounds.height === 0) {
            this.miniMapScale = 1;
            this.miniMapOffset = { x: padding, y: padding };
            return;
        }

        const scaleX = availableWidth / bounds.width;
        const scaleY = availableHeight / bounds.height;
        this.miniMapScale = Math.min(scaleX, scaleY, this.options.maxScale);
        this.miniMapScale = Math.max(this.miniMapScale, this.options.minScale);

        // 计算偏移，使内容居中
        const scaledWidth = bounds.width * this.miniMapScale;
        const scaledHeight = bounds.height * this.miniMapScale;
        this.miniMapOffset = {
            x: padding + (availableWidth - scaledWidth) / 2 - bounds.x * this.miniMapScale,
            y: padding + (availableHeight - scaledHeight) / 2 - bounds.y * this.miniMapScale,
        };
    }

    /**
     * 世界坐标转小地图坐标
     */
    private worldToMiniMap(worldPoint: Point): Point {
        return {
            x: worldPoint.x * this.miniMapScale + this.miniMapOffset.x,
            y: worldPoint.y * this.miniMapScale + this.miniMapOffset.y,
        };
    }

    /**
     * 小地图坐标转世界坐标
     */
    private miniMapToWorld(miniMapPoint: Point): Point {
        return {
            x: (miniMapPoint.x - this.miniMapOffset.x) / this.miniMapScale,
            y: (miniMapPoint.y - this.miniMapOffset.y) / this.miniMapScale,
        };
    }

    /**
     * 渲染小地图
     */
    render(): void {
        if (!this.ctx || !this.canvas || !this.graph || !this.options.enabled) return;

        // 清除画布
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // 计算缩放比例
        this.calculateMiniMapScale();

        // 绘制边
        this.renderEdges();

        // 绘制节点
        this.renderNodes();

        // 绘制视口
        if (this.options.showViewport) {
            this.renderViewport();
        }
    }

    /**
     * 绘制节点
     */
    private renderNodes(): void {
        if (!this.ctx || !this.graph) return;

        const nodes = this.graph.getAllNodes();
        
        // 如果没有节点，绘制提示文字
        if (nodes.length === 0) {
            this.ctx.fillStyle = '#94a3b8';
            this.ctx.font = '12px system-ui, -apple-system, sans-serif';
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'middle';
            this.ctx.fillText('无节点', this.canvas!.width / 2, this.canvas!.height / 2);
            return;
        }

        this.ctx.fillStyle = this.options.nodeColor;

        nodes.forEach((node) => {
            const pos = node.getPosition();
            const style = node.getStyle();
            const miniMapPos = this.worldToMiniMap(pos);
            const width = style.width * this.miniMapScale;
            const height = style.height * this.miniMapScale;

            // 绘制节点矩形
            this.ctx!.fillRect(miniMapPos.x, miniMapPos.y, width, height);
        });
    }

    /**
     * 绘制边
     */
    private renderEdges(): void {
        if (!this.ctx || !this.graph) return;

        const edges = this.graph.getAllEdges();
        
        // 如果没有边，直接返回
        if (edges.length === 0) return;

        this.ctx.strokeStyle = this.options.edgeColor;
        this.ctx.lineWidth = Math.max(1, this.miniMapScale * 2);

        edges.forEach((edge) => {
            const sourceNode = this.graph!.getNode(edge.getSourceId());
            const targetNode = this.graph!.getNode(edge.getTargetId());

            if (!sourceNode || !targetNode) return;

            const sourcePos = sourceNode.getPosition();
            const sourceStyle = sourceNode.getStyle();
            const targetPos = targetNode.getPosition();
            const targetStyle = targetNode.getStyle();

            const sourceCenter = this.worldToMiniMap({
                x: sourcePos.x + sourceStyle.width / 2,
                y: sourcePos.y + sourceStyle.height / 2,
            });
            const targetCenter = this.worldToMiniMap({
                x: targetPos.x + targetStyle.width / 2,
                y: targetPos.y + targetStyle.height / 2,
            });

            this.ctx!.beginPath();
            this.ctx!.moveTo(sourceCenter.x, sourceCenter.y);
            this.ctx!.lineTo(targetCenter.x, targetCenter.y);
            this.ctx!.stroke();
        });
    }

    /**
     * 绘制视口矩形
     */
    private renderViewport(): void {
        if (!this.ctx || !this.graph || !this.canvas) return;

        const { width: canvasWidth, height: canvasHeight } = this.graph.getCanvas().getBoundingClientRect();

        // 计算视口在世界坐标中的位置
        const viewportWorldTopLeft = this.graph.screenToWorld({ x: 0, y: 0 });
        const viewportWorldBottomRight = this.graph.screenToWorld({ x: canvasWidth, y: canvasHeight });

        // 转换为小地图坐标
        const viewportTopLeft = this.worldToMiniMap(viewportWorldTopLeft);
        const viewportBottomRight = this.worldToMiniMap(viewportWorldBottomRight);

        const viewportWidth = viewportBottomRight.x - viewportTopLeft.x;
        const viewportHeight = viewportBottomRight.y - viewportTopLeft.y;

        // 绘制视口填充
        this.ctx.fillStyle = this.options.viewportFillColor;
        this.ctx.fillRect(viewportTopLeft.x, viewportTopLeft.y, viewportWidth, viewportHeight);

        // 绘制视口边框
        this.ctx.strokeStyle = this.options.viewportBorderColor;
        this.ctx.lineWidth = this.options.viewportBorderWidth;
        this.ctx.strokeRect(viewportTopLeft.x, viewportTopLeft.y, viewportWidth, viewportHeight);
    }

    /**
     * 获取鼠标在小地图上的位置
     */
    private getMousePosition(e: MouseEvent): Point {
        if (!this.canvas) return { x: 0, y: 0 };

        const rect = this.canvas.getBoundingClientRect();
        return {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
        };
    }

    /**
     * 获取视口在小地图中的矩形区域
     */
    private getViewportRect(): { x: number; y: number; width: number; height: number } | null {
        if (!this.graph) return null;

        const { width: canvasWidth, height: canvasHeight } = this.graph.getCanvas().getBoundingClientRect();
        const viewportWorldTopLeft = this.graph.screenToWorld({ x: 0, y: 0 });
        const viewportWorldBottomRight = this.graph.screenToWorld({ x: canvasWidth, y: canvasHeight });

        const viewportTopLeft = this.worldToMiniMap(viewportWorldTopLeft);
        const viewportBottomRight = this.worldToMiniMap(viewportWorldBottomRight);

        return {
            x: viewportTopLeft.x,
            y: viewportTopLeft.y,
            width: viewportBottomRight.x - viewportTopLeft.x,
            height: viewportBottomRight.y - viewportTopLeft.y,
        };
    }

    /**
     * 检查点是否在视口内
     */
    private isPointInViewport(point: Point): boolean {
        const rect = this.getViewportRect();
        if (!rect) return false;

        return (
            point.x >= rect.x &&
            point.x <= rect.x + rect.width &&
            point.y >= rect.y &&
            point.y <= rect.y + rect.height
        );
    }

    /**
     * 处理鼠标按下事件
     */
    private handleMouseDown = (e: MouseEvent): void => {
        if (!this.options.draggable || !this.graph) return;

        const point = this.getMousePosition(e);

        // 任何位置都可以开始拖动，不限于视口内
        this.isDraggingViewport = true;
        this.dragStartPoint = point;
        
        // 记录当前画布的偏移量
        this.dragStartOffset = { ...this.graph.getTransform().offset };

        if (this.container) {
            this.container.style.cursor = 'grabbing';
        }
    };

    /**
     * 处理鼠标移动事件
     */
    private handleMouseMove = (e: MouseEvent): void => {
        if (!this.graph || !this.container) return;

        const point = this.getMousePosition(e);

        // 如果正在拖拽，更新画布位置
        if (this.isDraggingViewport) {
            // 计算鼠标在小地图上的移动距离
            const deltaMiniMapX = point.x - this.dragStartPoint.x;
            const deltaMiniMapY = point.y - this.dragStartPoint.y;

            // 将小地图移动距离转换为主画布的移动距离
            // 小地图的 miniMapScale 是世界坐标到小地图的缩放比例
            // 所以要先将小地图像素转换回世界坐标，再乘以主画布缩放得到屏幕偏移
            const transform = this.graph.getTransform();
            
            // 小地图移动距离 / miniMapScale = 世界坐标移动距离
            // 世界坐标移动距离 * 主画布scale = 屏幕像素移动距离
            const deltaScreenX = (deltaMiniMapX / this.miniMapScale) * transform.scale;
            const deltaScreenY = (deltaMiniMapY / this.miniMapScale) * transform.scale;

            // 计算新的偏移量
            const newOffset = {
                x: this.dragStartOffset.x - deltaScreenX,
                y: this.dragStartOffset.y - deltaScreenY,
            };

            this.graph.setOffset(newOffset);

            // 触发回调
            this.options.onViewportChange({
                offset: newOffset,
                scale: transform.scale,
            });

            // 实时重新渲染小地图，更新视口位置
            this.render();
        } else {
            // 根据是否在视口内改变鼠标样式（仅当鼠标在视口内时才改变为 grab）
            const isInViewport = this.isPointInViewport(point);
            this.container.style.cursor = isInViewport ? 'grab' : 'default';
        }
    };

    /**
     * 处理鼠标松开事件
     */
    private handleMouseUp = (e: MouseEvent): void => {
        this.isDraggingViewport = false;

        if (this.container && this.graph) {
            // 恢复鼠标样式，根据是否在视口内
            const point = this.getMousePosition(e);
            const isInViewport = this.isPointInViewport(point);
            this.container.style.cursor = isInViewport ? 'grab' : 'default';
        }
    };

    /**
     * 处理鼠标进入事件
     */
    private handleMouseEnter = (e: MouseEvent): void => {
        if (this.container) {
            // 根据是否在视口内设置鼠标样式
            const point = this.getMousePosition(e);
            const isInViewport = this.isPointInViewport(point);
            this.container.style.cursor = isInViewport ? 'grab' : 'default';
        }
    };

    /**
     * 处理鼠标离开事件
     */
    private handleMouseLeave = (): void => {
        this.isDraggingViewport = false;
        if (this.container) {
            this.container.style.cursor = 'default';
        }
    };

    /**
     * 处理滚轮事件
     */
    private handleWheel = (e: WheelEvent): void => {
        if (!this.options.scalable || !this.graph) return;

        e.preventDefault();
        e.stopPropagation();

        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        const currentScale = this.graph.getZoom();
        const newScale = Math.max(
            (this.graph as any).options.minZoom,
            Math.min((this.graph as any).options.maxZoom, currentScale * delta)
        );

        this.graph.setScale(newScale);

        // 触发回调
        this.options.onViewportChange({
            offset: this.graph.getTransform().offset,
            scale: newScale,
        });
    };

    /**
     * 处理点击事件 - 将视口中心移动到点击位置
     */
    private handleClick = (e: MouseEvent): void => {
        // 如果刚刚进行了拖拽，不处理点击
        if (this.isDraggingViewport) return;

        if (!this.graph) return;

        const point = this.getMousePosition(e);

        // 如果点击在视口内，不处理
        if (this.isPointInViewport(point)) return;

        // 将点击位置转换为世界坐标
        const worldPoint = this.miniMapToWorld(point);

        // 计算新的偏移量，使点击位置成为视口中心
        const { width: canvasWidth, height: canvasHeight } = this.graph.getCanvas().getBoundingClientRect();
        const transform = this.graph.getTransform();

        const newOffset = {
            x: canvasWidth / 2 - worldPoint.x * transform.scale,
            y: canvasHeight / 2 - worldPoint.y * transform.scale,
        };

        this.graph.setOffset(newOffset);

        // 触发回调
        this.options.onViewportChange({
            offset: newOffset,
            scale: transform.scale,
        });
    };

    /**
     * 更新配置
     */
    setOptions(options: Partial<MiniMapOptions>): void {
        this.options = {
            ...this.options,
            ...options,
        };

        // 更新容器样式
        if (this.container) {
            this.container.style.width = `${this.options.width}px`;
            this.container.style.height = `${this.options.height}px`;
            this.container.style.backgroundColor = this.options.backgroundColor;
            this.container.style.borderColor = this.options.borderColor;
            this.container.style.borderWidth = `${this.options.borderWidth}px`;
            this.container.style.borderRadius = `${this.options.borderRadius}px`;
            this.container.style.opacity = `${this.options.opacity}`;
            this.container.style.zIndex = `${this.options.zIndex}`;
        }

        // 更新画布尺寸
        if (this.canvas) {
            this.canvas.width = this.options.width;
            this.canvas.height = this.options.height;
        }

        // 更新位置
        this.updatePosition();

        // 重新渲染
        this.render();
    }

    /**
     * 显示小地图
     */
    show(): void {
        if (this.container) {
            this.container.style.display = 'block';
        }
    }

    /**
     * 隐藏小地图
     */
    hide(): void {
        if (this.container) {
            this.container.style.display = 'none';
        }
    }

    /**
     * 获取小地图容器元素
     */
    getContainer(): HTMLDivElement | null {
        return this.container;
    }

    /**
     * 获取小地图画布元素
     */
    getCanvas(): HTMLCanvasElement | null {
        return this.canvas;
    }
}
