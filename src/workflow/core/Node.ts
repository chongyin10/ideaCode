import { Cell, CellOptions, CellData, type CellEvent } from './Cell';
import { Shape, ShapeConfig, ShapeRenderer } from './Shape';
import { Port, PortOptions, PortPosition, PortManager, PortGroupOptions, PortLayoutConfig } from './Port';
import { EVENT_NAMES } from './EventManager';

/**
 * Resize handle 位置类型
 */
export type ResizeHandlePosition = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/**
 * Resize handle 配置
 */
export interface ResizeHandleConfig {
    /** handle 位置 */
    position: ResizeHandlePosition;
    /** handle 尺寸 */
    size: number;
    /** handle 颜色 */
    fillColor: string;
    /** handle 边框颜色 */
    strokeColor: string;
    /** handle 边框宽度 */
    strokeWidth: number;
}

/**
 * Resize handle 默认配置
 */
export const DEFAULT_RESIZE_HANDLE_CONFIG: ResizeHandleConfig = {
    position: 'se',
    size: 8,
    fillColor: '#ffffff',
    strokeColor: '#3b82f6',
    strokeWidth: 2,
};

/**
 * Node 事件对象接口
 */
export interface NodeEvent extends CellEvent {
    /** Node 实例 */
    node: Node;
}

// 重新导出类型，方便用户使用
export type { PortGroupOptions, PortLayoutConfig } from './Port';

/**
 * 节点边框样式
 * - 'solid': 实线（默认）
 * - 'dashed': 虚线
 * - 'animated': 波浪流动（蚂蚁线动画）
 */
export type BorderStyle = 'solid' | 'dashed' | 'animated';

/**
 * 节点样式接口
 */
export interface NodeStyle {
    /** 节点宽度 */
    width: number;
    /** 节点高度 */
    height: number;
    /** 背景颜色 */
    backgroundColor: string;
    /** 边框颜色 */
    borderColor: string;
    /** 边框宽度 */
    borderWidth: number;
    /** 边框圆角 */
    borderRadius: number;
    /** 边框样式：实线、虚线、波浪流动 */
    borderStyle: BorderStyle;
    /** 虚线模式 [实线长度, 间隔长度]，仅 borderStyle 为 'dashed' 时有效 */
    dashPattern: [number, number];
    /** 波浪流动颜色，仅 borderStyle 为 'animated' 时有效 */
    animatedBorderColor: string;
    /** 波浪流动虚线模式，仅 borderStyle 为 'animated' 时有效 */
    animatedDashPattern: [number, number];
    /** 波浪流动速度（像素/帧），仅 borderStyle 为 'animated' 时有效 */
    animatedBorderSpeed: number;
    /** 文字颜色 */
    textColor: string;
    /** 字体大小 */
    fontSize: number;
    /** 字体 */
    fontFamily: string;
    /** 阴影颜色 */
    shadowColor: string;
    /** 阴影模糊度 */
    shadowBlur: number;
    /** 阴影偏移 X */
    shadowOffsetX: number;
    /** 阴影偏移 Y */
    shadowOffsetY: number;
    /** 选中状态边框颜色 */
    selectedBorderColor: string;
    /** 选中状态边框宽度 */
    selectedBorderWidth: number;
    /** 悬停状态背景色 */
    hoverBackgroundColor: string;
    /** 形状配置 */
    shape?: ShapeConfig;
}

/**
 * 节点位置接口
 */
export interface NodePosition {
    x: number;
    y: number;
}

/**
 * 节点数据接口
 */
export interface NodeData extends CellData {
    position: NodePosition;
}

/**
 * 节点配置选项
 */
export interface NodeOptions extends CellOptions {
    x: number;
    y: number;
    shape?: Shape | ShapeConfig;
    style?: Partial<NodeStyle>;
    /** 是否允许拉伸缩小，默认为 false */
    resizable?: boolean;
    /**
     * 连接桩是否始终可见
     * - true: 始终显示连接桩（默认）
     * - false: 仅在鼠标悬停到节点时显示连接桩
     */
    portsAlwaysVisible?: boolean;
    /**
     * 节点类型
     * - 'node': 普通节点（默认）
     * - 'group': 群组节点，可以作为其他节点的容器
     */
    type?: 'node' | 'group';
}

/**
 * Node - 流程图节点类
 *
 * 继承自 Cell 基类，提供：
 * - 支持自定义位置和标签
 * - 支持自定义样式
 * - 支持多种形状
 * - 提供绘制方法和碰撞检测
 */
export class Node extends Cell {
    private position: NodePosition;
    private style: NodeStyle;
    private shapeConfig: ShapeConfig;
    private ports: Map<string, Port> = new Map();
    private portManager: PortManager;
    private _resizable: boolean = false;
    private _portsAlwaysVisible: boolean = true;
    private _type: 'node' | 'group';

    // HTML 节点相关
    private htmlElement: HTMLElement | null = null;
    private graph: any = null;

    // 默认样式
    private static readonly DEFAULT_STYLE: NodeStyle = {
        width: 200,
        height: 80,
        backgroundColor: '#ffffff',
        borderColor: '#3b82f6',
        borderWidth: 1,
        borderRadius: 12,
        borderStyle: 'solid',
        dashPattern: [6, 4],
        animatedBorderColor: '#3b82f6',
        animatedDashPattern: [8, 4],
        animatedBorderSpeed: 1,
        textColor: '#1f2937',
        fontSize: 14,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        shadowColor: 'rgba(0, 0, 0, 0.08)',
        shadowBlur: 8,
        shadowOffsetX: 0,
        shadowOffsetY: 2,
        selectedBorderColor: '#3b82f6',
        selectedBorderWidth: 2,
        hoverBackgroundColor: '#f8fafc',
        shape: { type: Shape.Rect, borderRadius: 12 },
    };

    /**
     * 可用的形状类型
     */
    static readonly Shape = Shape;

    /**
     * CSS 样式字符串 - 可用于外部容器
     */
    static readonly CSS_STYLES = `
        ${Cell.BASE_CSS_STYLES}
        
        .node-container {
            position: relative;
            user-select: none;
            -webkit-user-select: none;
        }
        
        .node {
            position: absolute;
            display: flex;
            flex-direction: column;
            padding: 12px 16px;
            cursor: grab;
            transition: all 0.2s ease;
            box-shadow:
                0 2px 8px rgba(0, 0, 0, 0.06),
                0 1px 2px rgba(0, 0, 0, 0.04);
        }
        
        .node:hover {
            box-shadow:
                0 8px 16px rgba(59, 130, 246, 0.12),
                0 4px 8px rgba(59, 130, 246, 0.08);
            transform: translateY(-1px);
        }
        
        .node:active {
            cursor: grabbing;
            box-shadow:
                0 2px 4px rgba(0, 0, 0, 0.06);
            transform: translateY(0);
        }
        
        .node.selected {
            box-shadow:
                0 0 0 2px rgba(59, 130, 246, 0.3),
                0 4px 12px rgba(59, 130, 246, 0.15);
        }
        
        .node-header {
            display: flex;
            align-items: center;
            gap: 10px;
            width: 100%;
        }
        
        .node-icon {
            width: 28px;
            height: 28px;
            border-radius: 6px;
            background: linear-gradient(135deg, #e0f2fe 0%, #bae6fd 100%);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            font-weight: 600;
            color: #0284c7;
            flex-shrink: 0;
        }
        
        .node-title {
            flex: 1;
            font-size: 15px;
            font-weight: 600;
            color: #1f2937;
        }
        
        .node-tag {
            font-size: 11px;
            color: #6b7280;
            background: #f3f4f6;
            padding: 2px 8px;
            border-radius: 4px;
        }
        
        .node-desc {
            font-size: 12px;
            color: #6b7280;
            margin-top: 6px;
            margin-left: 38px;
        }
        
        .node-label {
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            pointer-events: none;
        }
    `;

    constructor(options: NodeOptions) {
        super(options);
        this.position = { x: options.x, y: options.y };
        this.style = { ...Node.DEFAULT_STYLE, ...options.style };
        this._resizable = options.resizable ?? false;
        this._portsAlwaysVisible = options.portsAlwaysVisible ?? true;
        this._type = options.type ?? 'node';
        
        // 解析 shape 配置
        if (options.shape) {
            if (typeof options.shape === 'string') {
                this.shapeConfig = { type: options.shape as Shape };
            } else {
                this.shapeConfig = options.shape;
            }
        } else {
            this.shapeConfig = { type: Shape.Rect, borderRadius: this.style.borderRadius };
        }

        // 初始化连接桩管理器
        this.portManager = new PortManager(
            this.id,
            this.style.width,
            this.style.height
        );
    }

    /**
     * 获取节点位置
     */
    getPosition(): NodePosition {
        return { ...this.position };
    }

    /**
     * 设置节点位置
     */
    setPosition(x: number, y: number): void {
        this.position.x = x;
        this.position.y = y;
    }

    /**
     * 移动节点（相对位置）
     */
    move(deltaX: number, deltaY: number): void {
        this.position.x += deltaX;
        this.position.y += deltaY;
    }

    /**
     * 获取节点是否可拉伸缩小
     */
    get resizable(): boolean {
        return this._resizable;
    }

    /**
     * 设置节点是否可拉伸缩小
     */
    setResizable(resizable: boolean): void {
        this._resizable = resizable;
    }

    /**
     * 获取节点类型
     * @returns 'node' | 'group'
     */
    getType(): 'node' | 'group' {
        return this._type;
    }

    /**
     * 设置节点类型
     * @param type - 'node' 普通节点 或 'group' 群组节点
     */
    setType(type: 'node' | 'group'): void {
        this._type = type;
    }

    /**
     * 检查节点是否为群组类型
     * @returns true 如果是群组节点
     */
    isGroup(): boolean {
        return this._type === 'group';
    }

    /**
     * 获取连接桩是否始终可见
     * @returns true 表示始终可见，false 表示仅在悬停时可见
     */
    get portsAlwaysVisible(): boolean {
        return this._portsAlwaysVisible;
    }

    /**
     * 设置连接桩是否始终可见
     * @param visible - true 表示始终可见，false 表示仅在悬停时可见
     */
    setPortsAlwaysVisible(visible: boolean): void {
        this._portsAlwaysVisible = visible;
    }

    /**
     * 获取节点样式
     */
    getStyle(): NodeStyle {
        return { ...this.style };
    }

    /**
     * 更新节点样式
     */
    updateStyle(style: Partial<NodeStyle>): void {
        this.style = { ...this.style, ...style };
        // 更新连接桩管理器的尺寸
        this.portManager.updateNodeSize(this.style.width, this.style.height);
    }

    /**
     * 设置节点样式（updateStyle 的别名）
     * @deprecated 请使用 updateStyle 方法
     */
    setStyle(style: Partial<NodeStyle>): void {
        this.updateStyle(style);
    }

    /**
     * 获取节点边界框
     */
    getBounds(): { x: number; y: number; width: number; height: number } {
        return {
            x: this.position.x - this.style.width / 2,
            y: this.position.y - this.style.height / 2,
            width: this.style.width,
            height: this.style.height,
        };
    }

    /**
     * 检查点是否在节点内
     */
    containsPoint(point: { x: number; y: number }): boolean {
        return ShapeRenderer.containsPoint(
            this.shapeConfig,
            point.x,
            point.y,
            this.position.x,
            this.position.y,
            this.style.width,
            this.style.height
        );
    }

    /**
     * 绘制节点
     * @param ctx - Canvas 2D 上下文
     * @param time - 当前时间戳（用于动画）
     */
    draw(ctx: CanvasRenderingContext2D, time?: number): void {
        const style = this.style;

        // HTML 节点在 Canvas 中绘制占位符，真实 DOM 元素由 Graph 管理
        if (this.isHtmlNode()) {
            this.drawHtmlPlaceholder(ctx);
            // 注意：连接桩不再在节点绘制时绘制，由 Graph 在边线层统一管理绘制
            return;
        }

        ctx.save();

        // 绘制阴影
        if (style.shadowBlur > 0) {
            ctx.shadowColor = style.shadowColor;
            ctx.shadowBlur = style.shadowBlur;
            ctx.shadowOffsetX = style.shadowOffsetX;
            ctx.shadowOffsetY = style.shadowOffsetY;
        }

        // 更新 shapeConfig 的圆角（如果是矩形）
        if (this.shapeConfig.type === Shape.Rect && !this.shapeConfig.borderRadius) {
            this.shapeConfig.borderRadius = style.borderRadius;
        }

        // 绘制形状背景
        ShapeRenderer.draw(
            ctx,
            this.shapeConfig,
            this.position.x,
            this.position.y,
            style.width,
            style.height
        );

        // 根据状态设置背景色
        if (this.isHovered) {
            ctx.fillStyle = style.hoverBackgroundColor;
        } else {
            ctx.fillStyle = style.backgroundColor;
        }
        ctx.fill();

        // 绘制边框
        ctx.shadowColor = 'transparent';
        ctx.lineWidth = this.isSelected ? style.selectedBorderWidth : style.borderWidth;

        if (style.borderStyle === 'dashed') {
            // 虚线边框
            ctx.strokeStyle = this.isSelected ? style.selectedBorderColor : style.borderColor;
            ctx.setLineDash(style.dashPattern);
            ctx.stroke();
        } else if (style.borderStyle === 'animated') {
            // 波浪流动边框（蚂蚁线动画）
            const animTime = time !== undefined ? time : performance.now();
            // 底层虚线轨道
            ctx.strokeStyle = style.borderColor;
            ctx.setLineDash(style.animatedDashPattern);
            ctx.globalAlpha = 0.3;
            ctx.stroke();
            ctx.globalAlpha = 1;
            // 流动波浪层
            const offset = (animTime * style.animatedBorderSpeed / 50) % (style.animatedDashPattern[0] + style.animatedDashPattern[1]);
            ctx.lineDashOffset = -offset;
            ctx.strokeStyle = style.animatedBorderColor;
            ctx.stroke();
            ctx.lineDashOffset = 0;
        } else {
            // 实线边框（默认）
            ctx.strokeStyle = this.isSelected ? style.selectedBorderColor : style.borderColor;
            ctx.stroke();
        }

        ctx.setLineDash([]);

        // 绘制文字
        ctx.fillStyle = style.textColor;
        ctx.font = `${style.fontSize}px ${style.fontFamily}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        // 处理文字截断
        const maxTextWidth = style.width - 20;
        let displayLabel = this.label;
        const textMetrics = ctx.measureText(displayLabel);
        
        if (textMetrics.width > maxTextWidth) {
            let truncated = displayLabel;
            while (ctx.measureText(truncated + '...').width > maxTextWidth && truncated.length > 0) {
                truncated = truncated.slice(0, -1);
            }
            displayLabel = truncated + '...';
        }
        
        ctx.fillText(displayLabel, this.position.x, this.position.y);

        ctx.restore();
        // 注意：连接桩不再在节点绘制时绘制，由 Graph 在边线层统一管理绘制
        // 这样可以实现连接桩和边线的 zIndex 交互
    }

    /**
     * 绘制 HTML 节点的占位符
     * @param ctx - Canvas 2D 上下文
     */
    private drawHtmlPlaceholder(ctx: CanvasRenderingContext2D): void {
        const style = this.style;

        ctx.save();

        // 绘制阴影
        ctx.shadowColor = 'rgba(0, 0, 0, 0.1)';
        ctx.shadowBlur = 8;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 2;

        // 绘制圆角矩形占位框 (border-radius: 8px)
        ctx.beginPath();
        const left = this.position.x - style.width / 2;
        const top = this.position.y - style.height / 2;
        const radius = 8;
        ctx.roundRect(left, top, style.width, style.height, radius);

        // 填充白色背景
        ctx.fillStyle = '#fff';
        ctx.fill();

        ctx.restore();
    }

    /**
     * 判断是否为 HTML 节点
     */
    isHtmlNode(): boolean {
        return this.shapeConfig.type === Shape.HTML;
    }

    /**
     * 创建 HTML 节点的 DOM 元素
     * @param graph - Graph 实例
     */
    createHtmlElement(graph: any): HTMLElement {
        if (!this.isHtmlNode() || this.htmlElement) {
            return this.htmlElement!;
        }

        this.graph = graph;

        // 创建容器元素
        const element = document.createElement('div');
        element.style.cssText = `
            position: absolute;
            width: ${this.style.width}px;
            height: ${this.style.height}px;
            left: 0;
            top: 0;
            pointer-events: auto;
            z-index: ${this.zIndex};
            transform-origin: center center;
            display: flex;
            align-items: center;
            justify-content: center;
            background: transparent;
            overflow: hidden;
            border-radius: 8px;
        `;

        // 设置 HTML 内容
        const htmlContent = this.shapeConfig.html || '';
        element.innerHTML = htmlContent;

        // 添加 mousedown 事件处理，支持拖拽
        element.addEventListener('mousedown', (e) => {
            // 如果点击的是 input、textarea、select 等表单元素，不触发拖拽
            const target = e.target as HTMLElement;
            const isFormElement = ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName) ||
                                  target.isContentEditable;
            
            if (isFormElement) {
                // 阻止事件冒泡到 overlay，让表单获得焦点，不进行拖拽
                e.stopPropagation();
                return;
            }

            // 非表单元素：不阻止冒泡，让事件传播到 overlay 进行拖拽处理
            // Graph 会给 overlay 添加 mousedown 监听器来处理拖拽
        });

        this.htmlElement = element;

        // 添加到 Graph 的 overlay 层
        graph.addHtmlNodeElement(this.id, element);

        return element;
    }

    /**
     * 移除 HTML 节点的 DOM 元素
     */
    removeHtmlElement(): void {
        if (this.htmlElement && this.graph) {
            this.graph.removeHtmlNodeElement(this.id);
            this.htmlElement = null;
            this.graph = null;
        }
    }

    /**
     * 更新 HTML 节点的 DOM 内容
     */
    updateHtmlContent(html: string): void {
        this.shapeConfig.html = html;
        if (this.htmlElement) {
            this.htmlElement.innerHTML = html;
        }
    }

    /**
     * 获取 HTML 元素
     */
    getHtmlElement(): HTMLElement | null {
        return this.htmlElement;
    }

    /**
     * 设置层级索引（重写父类方法，同步更新 HTML 元素）
     * @param zIndex - 层级值，数值越高显示越在上层
     */
    setZIndex(zIndex: number): void {
        super.setZIndex(zIndex);
        // 同步更新 HTML 元素的 z-index
        if (this.htmlElement) {
            this.htmlElement.style.zIndex = String(zIndex);
        }
    }

    /**
     * 绘制节点连接点（锚点）
     * @param ctx - Canvas 2D 上下文
     * @param position - 连接点位置：'top' | 'right' | 'bottom' | 'left'
     */
    drawAnchor(
        ctx: CanvasRenderingContext2D,
        position: 'top' | 'right' | 'bottom' | 'left'
    ): void {
        const anchorSize = 6;
        let anchorX = this.position.x;
        let anchorY = this.position.y;

        switch (position) {
            case 'top':
                anchorY = this.position.y - this.style.height / 2;
                break;
            case 'right':
                anchorX = this.position.x + this.style.width / 2;
                break;
            case 'bottom':
                anchorY = this.position.y + this.style.height / 2;
                break;
            case 'left':
                anchorX = this.position.x - this.style.width / 2;
                break;
        }

        ctx.save();
        ctx.beginPath();
        ctx.arc(anchorX, anchorY, anchorSize, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = this.style.borderColor;
        ctx.lineWidth = 2;
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

    /**
     * 获取连接点坐标
     * @param position - 连接点位置
     */
    getAnchorPoint(position: 'top' | 'right' | 'bottom' | 'left' | 'center'): { x: number; y: number } {
        if (position === 'center') {
            return { x: this.position.x, y: this.position.y };
        }
        return ShapeRenderer.getAnchorPoint(
            this.shapeConfig,
            position,
            this.position.x,
            this.position.y,
            this.style.width,
            this.style.height
        );
    }

    /**
     * 获取形状配置
     */
    getShapeConfig(): ShapeConfig {
        return { ...this.shapeConfig };
    }

    /**
     * 设置形状配置
     */
    setShapeConfig(shape: Shape | ShapeConfig): void {
        if (typeof shape === 'string') {
            this.shapeConfig = { type: shape as Shape };
        } else {
            this.shapeConfig = shape;
        }
    }

    /**
     * 绘制所有连接点
     * @param ctx - Canvas 2D 上下文
     */
    drawAllAnchors(ctx: CanvasRenderingContext2D): void {
        this.drawAnchor(ctx, 'top');
        this.drawAnchor(ctx, 'right');
        this.drawAnchor(ctx, 'bottom');
        this.drawAnchor(ctx, 'left');
    }

    // ==================== 连接桩 (Port) 管理方法 ====================

    /**
     * 获取连接桩管理器
     * @returns PortManager 实例
     */
    getPortManager(): PortManager {
        return this.portManager;
    }

    /**
     * 批量添加连接桩组（支持自适应布局）
     * @param options - 连接桩组配置
     * @returns 创建的连接桩数组
     * @example
     * ```typescript
     * // 添加3个顶部连接桩，自动均匀分布
     * node.addPortGroup({
     *     id: 'top-inputs',
     *     position: 'top',
     *     count: 3
     * });
     *
     * // 自定义每个连接桩
     * node.addPortGroup({
     *     id: 'right-outputs',
     *     position: 'right',
     *     count: 4,
     *     portConfig: (index) => ({
     *         id: `output-${index}`,
     *         label: `输出 ${index + 1}`,
     *         style: { fillColor: '#3b82f6' }
     *     })
     * });
     * ```
     */
    addPortGroup(options: PortGroupOptions): Port[] {
        return this.portManager.addPortGroup(options);
    }

    /**
     * 移除连接桩组
     * @param groupId - 组ID
     * @returns 是否成功移除
     */
    removePortGroup(groupId: string): boolean {
        return this.portManager.removePortGroup(groupId);
    }

    /**
     * 更新连接桩组
     * @param groupId - 组ID
     * @param newCount - 新的连接桩数量
     * @returns 是否更新成功
     */
    updatePortGroup(groupId: string, newCount: number): boolean {
        return this.portManager.updatePortGroup(groupId, newCount);
    }

    /**
     * 获取某侧的所有连接桩
     * @param position - 边侧位置
     * @returns 连接桩数组
     */
    getPortsBySide(position: 'top' | 'right' | 'bottom' | 'left'): Port[] {
        return this.portManager.getPortsBySide(position);
    }

    /**
     * 设置某侧的布局配置
     * @param position - 边侧位置
     * @param config - 布局配置
     */
    setSideLayoutConfig(
        position: 'top' | 'right' | 'bottom' | 'left',
        config: Partial<PortLayoutConfig>
    ): void {
        this.portManager.setSideLayoutConfig(position, config);
    }

    /**
     * 获取某侧连接桩的数量
     * @param position - 边侧位置
     * @returns 连接桩数量
     */
    getPortCountBySide(position: 'top' | 'right' | 'bottom' | 'left'): number {
        return this.portManager.getPortCountBySide(position);
    }

    // ==================== 向后兼容的 Port 管理方法 ====================

    /**
     * 添加连接桩（支持自适应布局）
     * @param options - 连接桩配置
     * @param layoutConfig - 可选的布局配置（当位置为边侧时生效）
     * @returns 创建的连接桩实例
     */
    addPort(
        options: Omit<PortOptions, 'nodeId'>,
        layoutConfig?: Partial<PortLayoutConfig>
    ): Port {
        // 如果位置是边侧，使用 PortManager 进行自适应布局
        if (typeof options.position === 'string' &&
            ['top', 'right', 'bottom', 'left'].includes(options.position)) {
            return this.portManager.addPort(options, layoutConfig);
        }
        
        // 否则使用传统方式添加
        const port = new Port({
            ...options,
            nodeId: this.id,
        });
        this.ports.set(port.getId(), port);
        return port;
    }

    /**
     * 移除连接桩
     * @param portId - 连接桩 ID
     * @returns 是否成功移除
     */
    removePort(portId: string): boolean {
        // 先尝试从 PortManager 移除
        if (this.portManager.hasPort(portId)) {
            return this.portManager.removePort(portId);
        }
        // 否则从传统 Map 移除
        return this.ports.delete(portId);
    }

    /**
     * 获取连接桩
     * @param portId - 连接桩 ID
     * @returns 连接桩实例或 undefined
     */
    getPort(portId: string): Port | undefined {
        // 先尝试从 PortManager 获取
        const portFromManager = this.portManager.getPort(portId);
        if (portFromManager) return portFromManager;
        // 否则从传统 Map 获取
        return this.ports.get(portId);
    }

    /**
     * 获取所有连接桩（包括 PortManager 和传统方式添加的）
     * @returns 连接桩数组
     */
    getAllPorts(): Port[] {
        const managerPorts = this.portManager.getAllPorts();
        const legacyPorts = Array.from(this.ports.values());
        return [...managerPorts, ...legacyPorts];
    }

    /**
     * 根据位置获取连接桩
     * @param position - 连接桩位置
     * @returns 连接桩实例或 undefined
     */
    getPortByPosition(position: PortPosition): Port | undefined {
        // 先检查 PortManager 中的连接桩
        const managerPort = this.portManager.getAllPorts().find(port => {
            const portPos = port.getPosition();
            if (typeof position === 'object' && typeof portPos === 'object') {
                return position.x === portPos.x && position.y === portPos.y;
            }
            return position === portPos;
        });
        if (managerPort) return managerPort;

        // 再检查传统方式添加的连接桩
        for (const port of this.ports.values()) {
            const portPos = port.getPosition();
            if (typeof position === 'object' && typeof portPos === 'object') {
                if (position.x === portPos.x && position.y === portPos.y) {
                    return port;
                }
            } else if (position === portPos) {
                return port;
            }
        }
        return undefined;
    }

    /**
     * 清除所有连接桩
     */
    clearPorts(): void {
        this.portManager.clearPorts();
        this.ports.clear();
    }

    /**
     * 绘制所有连接桩
     * @param ctx - Canvas 2D 上下文
     */
    drawAllPorts(ctx: CanvasRenderingContext2D): void {
        // 获取所有连接桩并合并
        const allPorts = [
            ...this.portManager.getAllPorts(),
            ...Array.from(this.ports.values())
        ];
        
        // 按 zIndex 排序后绘制（zIndex 小的先绘制，大的在上面）
        allPorts.sort((a, b) => a.getZIndex() - b.getZIndex()).forEach((port) => {
            port.draw(ctx, this.position.x, this.position.y, this.style.width, this.style.height);
        });
    }

    /**
     * 获取连接桩的连接点坐标
     * @param portId - 连接桩 ID
     * @returns 连接点坐标或 null
     */
    getPortConnectionPoint(portId: string): { x: number; y: number } | null {
        // 先尝试从 PortManager 获取
        const port = this.portManager.getPort(portId);
        if (port) {
            return port.getConnectionPoint(this.position.x, this.position.y, this.style.width, this.style.height);
        }
        
        // 否则从传统 Map 获取
        const legacyPort = this.ports.get(portId);
        if (legacyPort) {
            return legacyPort.getConnectionPoint(this.position.x, this.position.y, this.style.width, this.style.height);
        }
        return null;
    }

    /**
     * 检查点是否在连接桩上
     * @param point - 要检查的点
     * @returns 连接桩实例或 null
     */
    getPortAtPoint(point: { x: number; y: number }): Port | null {
        // 先检查 PortManager 管理的连接桩
        for (const port of this.portManager.getAllPorts()) {
            if (port.containsPoint(point, this.position.x, this.position.y, this.style.width, this.style.height)) {
                return port;
            }
        }
        
        // 再检查传统方式添加的连接桩
        for (const port of this.ports.values()) {
            if (port.containsPoint(point, this.position.x, this.position.y, this.style.width, this.style.height)) {
                return port;
            }
        }
        return null;
    }

    /**
     * 序列化为 JSON
     */
    toJSON(): NodeData {
        return {
            id: this.id,
            label: this.label,
            position: { ...this.position },
            data: { ...this.data },
        };
    }

    /**
     * 从 JSON 创建节点
     */
    static fromJSON(data: NodeData): Node {
        return new Node({
            id: data.id,
            label: data.label,
            x: data.position.x,
            y: data.position.y,
            data: data.data,
        });
    }

    /**
     * 克隆节点
     */
    clone(newId?: string): Node {
        return new Node({
            id: newId || `${this.id}_clone`,
            label: this.label,
            x: this.position.x + 20,
            y: this.position.y + 20,
            style: { ...this.style },
            data: { ...this.data },
        });
    }

    // ==================== 事件处理 ====================

    /**
     * 触发 Node 相关事件
     * @param eventType - 事件类型（click, dblclick, contextmenu, mousedown, mousemove, mouseup, mousewheel, mouseenter, mouseleave）
     * @param originalEvent - 原始 DOM 事件
     * @param extraData - 额外的事件数据
     * @returns 是否未阻止默认行为
     */
    triggerNodeEvent(
        eventType: string,
        originalEvent: Event,
        extraData: Partial<NodeEvent> = {}
    ): boolean {
        const nodeEventName = `node:${eventType}`;

        // 创建事件对象
        const eventData = this.createNodeEvent(originalEvent, extraData);

        // 同时触发 cell:xxx 和 node:xxx 事件
        const cellResult = this.triggerCellEvent(eventType, originalEvent, extraData);
        const nodeResult = this.emit(nodeEventName, eventData);

        return cellResult && nodeResult;
    }

    /**
     * 创建 Node 事件对象
     */
    protected createNodeEvent(
        originalEvent: Event,
        extraData: Partial<NodeEvent> = {}
    ): NodeEvent {
        const baseEvent = this.createCellEvent(originalEvent, extraData);

        return {
            ...baseEvent,
            type: 'node',
            target: this,
            node: this,
            ...extraData,
        } as NodeEvent;
    }

    /**
     * 触发连接桩事件（从 Port 转发）
     * @param eventType - 事件类型
     * @param port - 触发事件的 Port 实例
     * @param originalEvent - 原始 DOM 事件
     */
    triggerPortEvent(
        eventType: string,
        port: Port,
        originalEvent: Event
    ): boolean {
        // 在 Node 层转发 port 事件
        const portEventName = `node:port:${eventType}`;
        const nodeEvent = this.createNodeEvent(originalEvent);

        const portEventData = {
            ...nodeEvent,
            type: 'port',
            port,
            portId: port.getId(),
        };

        return this.emit(portEventName, portEventData);
    }

    /**
     * 获取事件名称映射
     */
    protected override getEventNameMap(): Record<string, string> {
        return {
            click: EVENT_NAMES.NODE_CLICK,
            dblclick: EVENT_NAMES.NODE_DBLCLICK,
            contextmenu: EVENT_NAMES.NODE_CONTEXTMENU,
            mousedown: EVENT_NAMES.NODE_MOUSEDOWN,
            mousemove: EVENT_NAMES.NODE_MOUSEMOVE,
            mouseup: EVENT_NAMES.NODE_MOUSEUP,
            mousewheel: EVENT_NAMES.NODE_MOUSEWHEEL,
            mouseenter: EVENT_NAMES.NODE_MOUSEENTER,
            mouseleave: EVENT_NAMES.NODE_MOUSELEAVE,
            dragstart: EVENT_NAMES.NODE_DRAGSTART,
            drag: EVENT_NAMES.NODE_DRAG,
            dragend: EVENT_NAMES.NODE_DRAGEND,
        };
    }

    /**
     * 检查点是否在节点上（包含连接桩检测）
     * @param point - 检查的点
     * @returns 检测结果
     */
    hitTest(point: { x: number; y: number }): {
        hit: boolean;
        target: 'node' | 'port' | null;
        port?: Port;
    } {
        // 首先检查是否在连接桩上
        const port = this.getPortAtPoint(point);
        if (port) {
            return { hit: true, target: 'port', port };
        }

        // 然后检查是否在节点主体上
        if (this.containsPoint(point)) {
            return { hit: true, target: 'node' };
        }

        return { hit: false, target: null };
    }

    // ==================== Resize Handles 方法 ====================

    /**
     * 获取所有 resize handle 的位置
     * @returns handle 位置数组
     */
    getResizeHandlePositions(): ResizeHandlePosition[] {
        return ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    }

    /**
     * 获取指定位置 resize handle 的坐标
     * @param position - handle 位置
     * @param handleSize - handle 尺寸
     * @returns handle 中心坐标
     */
    getResizeHandlePoint(position: ResizeHandlePosition, handleSize: number = 8): { x: number; y: number } {
        const bounds = this.getBounds();
        const halfSize = handleSize / 2;

        switch (position) {
            case 'nw':
                return { x: bounds.x - halfSize, y: bounds.y - halfSize };
            case 'n':
                return { x: bounds.x + bounds.width / 2 - halfSize, y: bounds.y - halfSize };
            case 'ne':
                return { x: bounds.x + bounds.width - halfSize, y: bounds.y - halfSize };
            case 'e':
                return { x: bounds.x + bounds.width - halfSize, y: bounds.y + bounds.height / 2 - halfSize };
            case 'se':
                return { x: bounds.x + bounds.width - halfSize, y: bounds.y + bounds.height - halfSize };
            case 's':
                return { x: bounds.x + bounds.width / 2 - halfSize, y: bounds.y + bounds.height - halfSize };
            case 'sw':
                return { x: bounds.x - halfSize, y: bounds.y + bounds.height - halfSize };
            case 'w':
                return { x: bounds.x - halfSize, y: bounds.y + bounds.height / 2 - halfSize };
            default:
                return { x: this.position.x, y: this.position.y };
        }
    }

    /**
     * 绘制 resize handles
     * @param ctx - Canvas 2D 上下文
     * @param config - handle 配置（可选）
     */
    drawResizeHandles(ctx: CanvasRenderingContext2D, config?: Partial<ResizeHandleConfig>): void {
        if (!this.isSelected || !this._resizable) return;

        const handleConfig = { ...DEFAULT_RESIZE_HANDLE_CONFIG, ...config };
        const positions = this.getResizeHandlePositions();
        const radius = handleConfig.size / 2;

        ctx.save();

        positions.forEach((position) => {
            const point = this.getResizeHandlePoint(position, handleConfig.size);
            // 计算圆心坐标（getResizeHandlePoint 返回的是左上角，需要转换为圆心）
            const centerX = point.x + radius;
            const centerY = point.y + radius;

            // 绘制阴影
            ctx.shadowColor = 'rgba(0, 0, 0, 0.15)';
            ctx.shadowBlur = 4;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 2;

            ctx.beginPath();
            ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);

            // 填充
            ctx.fillStyle = handleConfig.fillColor;
            ctx.fill();

            // 清除阴影再绘制边框，避免边框也有阴影
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;

            // 边框
            ctx.strokeStyle = handleConfig.strokeColor;
            ctx.lineWidth = handleConfig.strokeWidth;
            ctx.stroke();
        });

        ctx.restore();
    }

    /**
     * 检查点是否在 resize handle 上
     * @param point - 检查的点
     * @param handleSize - handle 尺寸
     * @returns handle 位置或 null
     */
    getResizeHandleAtPoint(
        point: { x: number; y: number },
        handleSize: number = 8
    ): ResizeHandlePosition | null {
        if (!this.isSelected || !this._resizable) return null;

        const positions = this.getResizeHandlePositions();
        const hitSize = handleSize + 4; // 增加一点点击区域，更易命中

        for (const position of positions) {
            const handlePoint = this.getResizeHandlePoint(position, handleSize);

            if (
                point.x >= handlePoint.x &&
                point.x <= handlePoint.x + hitSize &&
                point.y >= handlePoint.y &&
                point.y <= handlePoint.y + hitSize
            ) {
                return position;
            }
        }

        return null;
    }

    /**
     * 根据 resize handle 位置和鼠标移动计算新的节点尺寸和位置
     * @param handlePosition - 被拖拽的 handle 位置
     * @param deltaX - X 方向移动距离
     * @param deltaY - Y 方向移动距离
     * @param minWidth - 最小宽度
     * @param minHeight - 最小高度
     * @param startBounds - 可选的起始边界框，如果不提供则使用当前边界框
     * @returns 新的位置、尺寸和是否需要更新
     */
    calculateResize(
        handlePosition: ResizeHandlePosition,
        deltaX: number,
        deltaY: number,
        minWidth: number = 50,
        minHeight: number = 30,
        startBounds?: { x: number; y: number; width: number; height: number }
    ): {
        x: number;
        y: number;
        width: number;
        height: number;
        changed: boolean;
    } {
        // 使用传入的起始边界框，如果没有则使用当前边界框
        const bounds = startBounds || this.getBounds();
        let newX = bounds.x;
        let newY = bounds.y;
        let newWidth = bounds.width;
        let newHeight = bounds.height;

        switch (handlePosition) {
            case 'se':
                newWidth = Math.max(minWidth, bounds.width + deltaX);
                newHeight = Math.max(minHeight, bounds.height + deltaY);
                break;
            case 'nw':
                newWidth = Math.max(minWidth, bounds.width - deltaX);
                newHeight = Math.max(minHeight, bounds.height - deltaY);
                newX = bounds.x + bounds.width - newWidth;
                newY = bounds.y + bounds.height - newHeight;
                break;
            case 'ne':
                newWidth = Math.max(minWidth, bounds.width + deltaX);
                newHeight = Math.max(minHeight, bounds.height - deltaY);
                newY = bounds.y + bounds.height - newHeight;
                break;
            case 'sw':
                newWidth = Math.max(minWidth, bounds.width - deltaX);
                newHeight = Math.max(minHeight, bounds.height + deltaY);
                newX = bounds.x + bounds.width - newWidth;
                break;
            case 'e':
                newWidth = Math.max(minWidth, bounds.width + deltaX);
                break;
            case 'w':
                newWidth = Math.max(minWidth, bounds.width - deltaX);
                newX = bounds.x + bounds.width - newWidth;
                break;
            case 's':
                newHeight = Math.max(minHeight, bounds.height + deltaY);
                break;
            case 'n':
                newHeight = Math.max(minHeight, bounds.height - deltaY);
                newY = bounds.y + bounds.height - newHeight;
                break;
        }

        const changed = newWidth !== bounds.width || newHeight !== bounds.height ||
                        newX !== bounds.x || newY !== bounds.y;

        // 转换回中心点坐标
        return {
            x: newX + newWidth / 2,
            y: newY + newHeight / 2,
            width: newWidth,
            height: newHeight,
            changed,
        };
    }
}

/**
 * 支持行级悬停能力的节点接口
 * 实现该接口的节点（如 DynamicHeightNode）可响应行级鼠标悬停
 */
export interface RowHoverable {
    /** 获取指定世界坐标点所在的行索引，未命中返回 -1 */
    getRowIndexAtPoint(point: { x: number; y: number }): number;
    /** 设置当前悬停的行索引，-1 表示清除悬停 */
    setHoveredRow(index: number): void;
}

/**
 * 判断节点是否支持行级悬停
 */
export function isRowHoverable(node: Node): node is Node & RowHoverable {
    const candidate = node as unknown as Partial<RowHoverable>;
    return (
        typeof candidate.getRowIndexAtPoint === 'function' &&
        typeof candidate.setHoveredRow === 'function'
    );
}

export default Node;
