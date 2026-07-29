import { Cell, CellOptions, CellData, type CellEvent } from './Cell';
import { EVENT_NAMES } from './EventManager';

/**
 * Edge 事件对象接口
 */
export interface EdgeEvent extends CellEvent {
    /** Edge 实例 */
    edge: Edge;
    /** 源节点 ID */
    sourceId: string;
    /** 目标节点 ID */
    targetId: string;
}

/**
 * 边样式接口
 */
export interface EdgeStyle {
    /** 线条颜色 */
    stroke: string;
    /** 线条宽度 */
    strokeWidth: number;
    /** 是否为虚线 */
    dashed: boolean;
    /** 虚线模式 [实线长度, 间隔长度] */
    dashPattern: [number, number];
    /** 箭头大小（0 表示无箭头） */
    arrowSize: number;
    /** 箭头颜色 */
    arrowColor: string;
    /** 选中状态颜色 */
    selectedStroke: string;
    /** 选中状态宽度 */
    selectedStrokeWidth: number;
    /** 悬停状态颜色 */
    hoverStroke: string;
    /** 圆角半径（用于折线） */
    cornerRadius: number;
    /** 是否启用流动波浪效果 */
    animated: boolean;
    /** 波浪颜色 */
    waveColor: string;
    /** 波浪宽度 */
    waveWidth: number;
    /** 波浪长度 */
    waveLength: number;
    /** 波浪流动速度（像素/帧） */
    waveSpeed: number;
    /** 波浪透明度 */
    waveOpacity: number;
    /** 跳线高度（用于跳线类型的边） */
    jumpHeight: number;
    /** 跳线宽度（用于跳线类型的边） */
    jumpWidth: number;
}

/**
 * 边类型枚举
 */
export enum EdgeType {
    /** 直线 */
    Straight = 'straight',
    /** 水平折线 */
    Horizontal = 'horizontal',
    /** 垂直折线 */
    Vertical = 'vertical',
    /** 贝塞尔曲线 */
    Bezier = 'bezier',
    /** 弧度曲线 */
    Arc = 'arc',
    /** 阶梯折线（先水平后垂直） */
    StepRight = 'stepRight',
    /** 阶梯折线（先垂直后水平） */
    StepDown = 'stepDown',
    /** 圆角阶梯折线（先水平后垂直） */
    RoundedStepRight = 'roundedStepRight',
    /** 圆角阶梯折线（先垂直后水平） */
    RoundedStepDown = 'roundedStepDown',
    /** 平滑 L 型折线（正交圆角） */
    SmoothStep = 'smoothStep',
    /** 正交折线（智能路由） */
    Orthogonal = 'orthogonal',
    /** 虚线阶梯折线 */
    DashedStep = 'dashedStep',
    /** 虚线圆角折线 */
    DashedRounded = 'dashedRounded',
    /** 跳线（带交叉跳线效果的直线） */
    JumpLine = 'jumpLine',
}

/**
 * 边连接点位置
 */
export interface EdgeAnchor {
    nodeId: string;
    /** 连接桩 ID（优先使用）或位置 */
    portId?: string;
    /** 位置（当 portId 未指定时使用） */
    position?: 'top' | 'right' | 'bottom' | 'left';
}

/**
 * 边配置选项
 */
export interface EdgeOptions extends CellOptions {
    source: string | EdgeAnchor;
    target: string | EdgeAnchor;
    type?: EdgeType;
    style?: Partial<EdgeStyle>;
    /** 断开连接时的回调 */
    onDisconnect?: (edge: Edge) => void;
}

/**
 * 边数据接口
 */
export interface EdgeData extends CellData {
    source: EdgeAnchor;
    target: EdgeAnchor;
    type: EdgeType;
    /** 是否处于连接状态 */
    connected?: boolean;
    /** 边的偏移量 */
    offset?: Point;
}

/**
 * 点坐标
 */
interface Point {
    x: number;
    y: number;
}

/**
 * Edge - 边类（节点之间的连接线）
 *
 * 继承自 Cell 基类，提供：
 * - 支持多种连接类型（直线、水平折线、垂直折线、贝塞尔曲线、弧度曲线）
 * - 支持虚线/实线
 * - 支持箭头
 * - 支持标签
 */
export class Edge extends Cell {
    private source: EdgeAnchor;
    private target: EdgeAnchor;
    private type: EdgeType;
    private style: EdgeStyle;
    private onDisconnect?: (edge: Edge) => void;
    private connected: boolean = true;

    // 用于碰撞检测的点
    private lastSourcePoint: Point = { x: 0, y: 0 };
    private lastTargetPoint: Point = { x: 0, y: 0 };
    // 用于折线的中间点（已废弃，保留向后兼容）
    private lastMidPoint: Point | null = null;
    // 用于保存实际路径点（用于波浪动画）
    private pathPoints: Point[] = [];
    
    // 边的偏移量（用于移动边而不改变连接的节点）
    private offset: Point = { x: 0, y: 0 };

    // 默认样式
    private static readonly DEFAULT_STYLE: EdgeStyle = {
        stroke: '#94a3b8',
        strokeWidth: 2,
        dashed: false,
        dashPattern: [5, 5],
        arrowSize: 10,
        arrowColor: '#94a3b8',
        selectedStroke: '#f59e0b',
        selectedStrokeWidth: 3,
        hoverStroke: '#64748b',
        cornerRadius: 10,
        animated: false,
        waveColor: '#3b82f6',
        waveWidth: 2,
        waveLength: 15,
        waveSpeed: 1.5,
        waveOpacity: 0.6,
        jumpHeight: 8,
        jumpWidth: 12,
    };

    // 动画状态
    private isAnimating: boolean = false;

    /**
     * 各类型边的路径绘制策略表
     * DashedStep / DashedRounded 分别复用 StepDown / RoundedStepDown 的路径形状
     */
    private static readonly DRAW_STRATEGIES: Record<
        EdgeType,
        (this: Edge, ctx: CanvasRenderingContext2D, source: Point, target: Point) => void
    > = {
        [EdgeType.Straight]: Edge.prototype.drawStraight,
        [EdgeType.Horizontal]: Edge.prototype.drawHorizontal,
        [EdgeType.Vertical]: Edge.prototype.drawVertical,
        [EdgeType.Bezier]: Edge.prototype.drawBezier,
        [EdgeType.Arc]: Edge.prototype.drawArc,
        [EdgeType.StepRight]: Edge.prototype.drawStepRight,
        [EdgeType.StepDown]: Edge.prototype.drawStepDown,
        [EdgeType.RoundedStepRight]: Edge.prototype.drawRoundedStepRight,
        [EdgeType.RoundedStepDown]: Edge.prototype.drawRoundedStepDown,
        [EdgeType.SmoothStep]: Edge.prototype.drawSmoothStep,
        [EdgeType.Orthogonal]: Edge.prototype.drawOrthogonal,
        [EdgeType.DashedStep]: Edge.prototype.drawStepDown,
        [EdgeType.DashedRounded]: Edge.prototype.drawRoundedStepDown,
        [EdgeType.JumpLine]: Edge.prototype.drawJumpLine,
    };

    /** 圆角类边类型集合（路径长度近似时乘以 1.05 系数） */
    private static readonly ROUNDED_TYPES: ReadonlySet<EdgeType> = new Set([
        EdgeType.RoundedStepRight,
        EdgeType.RoundedStepDown,
        EdgeType.SmoothStep,
        EdgeType.DashedRounded,
    ]);

    // 跳线交叉点位置（用于 JumpLine 类型）
    private jumpPoints: Point[] = [];

    /**
     * CSS 样式字符串 - 可用于外部容器
     */
    static readonly CSS_STYLES = `
        ${Cell.BASE_CSS_STYLES}
        
        .edge-container {
            position: relative;
        }
        
        .edge {
            cursor: pointer;
            transition: stroke 0.2s ease;
        }
        
        .edge:hover {
            stroke: #64748b;
        }
        
        .edge.selected {
            stroke: #f59e0b;
            stroke-width: 3;
        }
        
        .edge-label {
            font-size: 12px;
            fill: #475569;
            text-anchor: middle;
            dominant-baseline: middle;
            pointer-events: none;
            background: white;
            padding: 2px 6px;
            border-radius: 4px;
        }
        
        .edge-arrow {
            fill: #94a3b8;
        }
        
        .edge.selected .edge-arrow {
            fill: #f59e0b;
        }
    `;

    constructor(options: EdgeOptions) {
        super(options);
        this.type = options.type || EdgeType.Straight;
        this.style = { ...Edge.DEFAULT_STYLE, ...options.style };
        this.onDisconnect = options.onDisconnect;

        // 解析 source 和 target
        this.source = this.parseAnchor(options.source);
        this.target = this.parseAnchor(options.target);

        // 如果样式中设置了 animated: true，自动启动动画
        if (this.style.animated) {
            this.isAnimating = true;
        }
    }

    /**
     * 解析连接点配置
     */
    private parseAnchor(anchor: string | EdgeAnchor): EdgeAnchor {
        if (typeof anchor === 'string') {
            return { nodeId: anchor, position: 'center' as any };
        }
        return anchor;
    }

    /**
     * 获取源节点 ID
     */
    getSourceId(): string {
        return this.source.nodeId;
    }

    /**
     * 获取目标节点 ID
     */
    getTargetId(): string {
        return this.target.nodeId;
    }

    /**
     * 获取源连接点配置
     */
    getSourceAnchor(): EdgeAnchor {
        return { ...this.source };
    }

    /**
     * 获取目标连接点配置
     */
    getTargetAnchor(): EdgeAnchor {
        return { ...this.target };
    }

    /**
     * 获取源连接点（同 getSourceAnchor）
     */
    getSource(): EdgeAnchor {
        return { ...this.source };
    }

    /**
     * 获取目标连接点（同 getTargetAnchor）
     */
    getTarget(): EdgeAnchor {
        return { ...this.target };
    }

    /**
     * 获取边类型
     */
    getType(): EdgeType {
        return this.type;
    }

    /**
     * 设置边类型
     */
    setType(type: EdgeType): void {
        this.type = type;
    }

    /**
     * 获取边的偏移量
     */
    getOffset(): Point {
        return { ...this.offset };
    }

    /**
     * 设置边的偏移量
     * @param x - X 方向偏移
     * @param y - Y 方向偏移
     */
    setOffset(x: number, y: number): void {
        this.offset = { x, y };
    }

    /**
     * 更新边的偏移量（相对当前偏移）
     * @param deltaX - X 方向变化量
     * @param deltaY - Y 方向变化量
     */
    updateOffset(deltaX: number, deltaY: number): void {
        this.offset.x += deltaX;
        this.offset.y += deltaY;
    }

    /**
     * 重置边的偏移量
     */
    resetOffset(): void {
        this.offset = { x: 0, y: 0 };
    }

    /**
     * 获取样式
     */
    getStyle(): EdgeStyle {
        return { ...this.style };
    }

    /**
     * 更新样式
     */
    updateStyle(style: Partial<EdgeStyle>): void {
        this.style = { ...this.style, ...style };
    }

    /**
     * 设置边样式（updateStyle 的别名）
     * @deprecated 请使用 updateStyle 方法
     */
    setStyle(style: Partial<EdgeStyle>): void {
        this.updateStyle(style);
    }

    /**
     * 获取当前线条颜色
     */
    private getStrokeColor(): string {
        if (this.isSelected) return this.style.selectedStroke;
        if (this.isHovered) return this.style.hoverStroke;
        return this.style.stroke;
    }

    /**
     * 获取当前线条宽度
     */
    private getStrokeWidth(): number {
        return this.isSelected ? this.style.selectedStrokeWidth : this.style.strokeWidth;
    }

    private lastSegmentAngle: number = 0;

    /**
     * 获取最后一段线的角度（用于箭头方向）
     */
    private getLastSegmentAngle(): number {
        return this.lastSegmentAngle;
    }

    /**
     * 绘制边
     * @param ctx - Canvas 2D 上下文
     * @param sourcePoint - 起点坐标
     * @param targetPoint - 终点坐标
     * @param time - 当前时间戳（用于动画）
     */
    draw(ctx: CanvasRenderingContext2D, sourcePoint: Point, targetPoint: Point, time?: number): void {
        // 如果边已断开，不绘制
        if (!this.connected) {
            return;
        }

        // 端点保持连接到节点，不应用偏移量
        // 偏移量只影响边的中间部分（在各个绘制方法中处理）
        this.lastSourcePoint = sourcePoint;
        this.lastTargetPoint = targetPoint;

        ctx.save();

        // 设置线条样式
        ctx.strokeStyle = this.getStrokeColor();
        ctx.lineWidth = this.getStrokeWidth();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // 设置虚线
        if (this.style.dashed) {
            ctx.setLineDash(this.style.dashPattern);
        }

        // 根据类型绘制路径（用于碰撞检测和波浪动画路径计算）
        ctx.beginPath();
        Edge.DRAW_STRATEGIES[this.type].call(this, ctx, sourcePoint, targetPoint);

        // 如果启用了波浪动画，先绘制虚线轨道，再绘制波浪效果
        // 使用 isAnimating 判断，确保动画状态一致
        // 当 time 未定义时使用 performance.now() 获取当前时间，确保动画持续播放
        if (this.isAnimating) {
            // 先绘制虚线轨道（保留虚线样式）
            ctx.save();
            if (this.style.dashed) {
                ctx.setLineDash(this.style.dashPattern);
            }
            ctx.stroke();
            ctx.restore();
            
            // 再绘制流动波浪动画
            const animationTime = time !== undefined ? time : performance.now();
            this.drawFlowingWave(ctx, sourcePoint, targetPoint, animationTime);
        } else {
            // 没有波浪动画时，绘制实线/虚线轨道
            ctx.stroke();
        }

        // 绘制箭头
        if (this.style.arrowSize > 0) {
            this.drawArrow(ctx, targetPoint, this.getLastSegmentAngle());
        }

        // 绘制标签
        if (this.label) {
            this.drawLabel(ctx, sourcePoint, targetPoint);
        }

        ctx.restore();
    }

    /**
     * 绘制直线
     * 当有偏移量时，将直线的中点偏移形成弧线效果
     * 偏移量直接应用到控制点，端点保持连接到节点
     */
    private drawStraight(ctx: CanvasRenderingContext2D, source: Point, target: Point): void {
        // 如果有偏移量，将中点偏移形成弧线效果
        if (this.offset.x !== 0 || this.offset.y !== 0) {
            // 计算直线中点
            const midX = (source.x + target.x) / 2;
            const midY = (source.y + target.y) / 2;
            
            // 控制点 = 中点 + 偏移量
            const controlX = midX + this.offset.x;
            const controlY = midY + this.offset.y;
            
            // 保存路径点（用于波浪动画）- 使用采样点近似弧线
            this.pathPoints = this.sampleQuadraticCurve(source, { x: controlX, y: controlY }, target, 20);
            
            // 绘制二次贝塞尔曲线（弧线）
            ctx.moveTo(source.x, source.y);
            ctx.quadraticCurveTo(controlX, controlY, target.x, target.y);
            
            // 计算终点处的切线角度
            this.lastSegmentAngle = Math.atan2(target.y - controlY, target.x - controlX);
        } else {
            // 无偏移量，绘制普通直线
            this.pathPoints = [source, target];
            
            ctx.moveTo(source.x, source.y);
            ctx.lineTo(target.x, target.y);
            this.lastSegmentAngle = Math.atan2(target.y - source.y, target.x - source.x);
        }
    }

    /**
     * 绘制跳线（带跳线效果的直线）
     * 直线类型不支持偏移量，因为只有两个端点
     */
    private drawJumpLine(ctx: CanvasRenderingContext2D, source: Point, target: Point): void {
        const { jumpHeight, jumpWidth } = this.style;
        
        // 计算线段角度和长度
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const angle = Math.atan2(dy, dx);
        const length = Math.sqrt(dx * dx + dy * dy);
        
        // 如果线段太短，直接画直线
        if (length < jumpWidth * 2) {
            this.pathPoints = [source, target];
            ctx.moveTo(source.x, source.y);
            ctx.lineTo(target.x, target.y);
            this.lastSegmentAngle = angle;
            return;
        }

        // 计算沿线条方向的单位向量
        const dirX = dx / length;
        const dirY = dy / length;
        
        // 计算垂直于线段的单位向量（向上）
        const perpX = -dirY;
        const perpY = dirX;
        
        // 计算跳线位置：使用实际的交叉点或均匀分布
        let jumpDistances: number[] = [];
        const halfWidth = jumpWidth / 2;
        
        if (this.jumpPoints.length > 0) {
            // 使用实际的交叉点位置
            jumpDistances = this.jumpPoints.map(point => {
                // 计算交叉点在线段上的投影距离
                const px = point.x - source.x;
                const py = point.y - source.y;
                // 投影到线段方向上的距离
                return px * dirX + py * dirY;
            }).filter(dist => dist > halfWidth && dist < length - halfWidth)
              .sort((a, b) => a - b);
        } else {
            // 没有交叉点信息时，均匀分布多个跳线标记
            const spacing = 120;
            const numJumps = Math.max(1, Math.floor(length / spacing));
            const actualSpacing = length / (numJumps + 1);
            for (let i = 1; i <= numJumps; i++) {
                jumpDistances.push(actualSpacing * i);
            }
        }
        
        const pathPoints: Point[] = [source];
        
        // 如果没有跳线点，直接画直线
        if (jumpDistances.length === 0) {
            ctx.moveTo(source.x, source.y);
            ctx.lineTo(target.x, target.y);
            this.pathPoints = [source, target];
            this.lastSegmentAngle = angle;
            return;
        }
        
        // 绘制跳线
        // 确保每个跳线拱形有足够的采样点（至少 20 个点）
        const minSegmentsPerJump = 20;
        const segments = Math.max(jumpDistances.length * minSegmentsPerJump + 20, Math.ceil(length / 2));
        
        for (let s = 0; s <= segments; s++) {
            const t = s / segments; // 0 到 1
            const dist = t * length;
            
            // 基础位置（在线段上）
            let baseX = source.x + dirX * dist;
            let baseY = source.y + dirY * dist;
            
            // 计算偏移量（跳线效果）
            let offset = 0;
            
            for (const jumpCenter of jumpDistances) {
                // 检查是否在当前跳线范围内
                if (dist >= jumpCenter - halfWidth && dist <= jumpCenter + halfWidth) {
                    // 计算在跳线范围内的位置（-1 到 1）
                    const localPos = (dist - jumpCenter) / halfWidth;
                    // 使用抛物线创建平滑轻微的拱形凸起
                    // 1 - localPos² 在 localPos=0 时为 1，在 localPos=±1 时为 0
                    // 这种形状比余弦函数更平缓，凸起更轻微
                    const arch = 1 - localPos * localPos;
                    offset = Math.max(offset, arch * jumpHeight);
                }
            }
            
            // 应用垂直偏移
            const x = baseX + perpX * offset;
            const y = baseY + perpY * offset;
            
            if (s === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
            
            // 记录路径点（用于碰撞检测）
            if (s % 5 === 0) {
                pathPoints.push({ x, y });
            }
        }
        
        pathPoints.push(target);
        this.pathPoints = pathPoints;
        this.lastSegmentAngle = angle;
    }

    /**
     * 绘制水平折线
     * 偏移量只影响转折点，端点保持连接到节点
     */
    private drawHorizontal(ctx: CanvasRenderingContext2D, source: Point, target: Point): void {
        // 转折点应用偏移量，端点不应用偏移量
        const midX = (source.x + target.x) / 2 + this.offset.x;
        const midY = source.y + this.offset.y;
        const r = this.style.cornerRadius;

        // 保存路径点（用于波浪动画）
        // 注意：路径点也包含偏移量，因为这是边的实际形状
        const cornerY = target.y + this.offset.y;
        this.pathPoints = [
            source,
            { x: midX, y: midY },
            { x: midX, y: cornerY },
            target
        ];

        // 保存中间点用于碰撞检测（向后兼容）
        this.lastMidPoint = { x: midX, y: cornerY };

        ctx.moveTo(source.x, source.y);

        // 水平段到转折点附近
        if (Math.abs(target.x - source.x) > 2 * r) {
            // 有足够的空间绘制圆角
            if (source.x < target.x) {
                ctx.lineTo(midX - r, midY);
                ctx.quadraticCurveTo(midX, midY, midX, midY + (cornerY > midY ? r : -r));
            } else {
                ctx.lineTo(midX + r, midY);
                ctx.quadraticCurveTo(midX, midY, midX, midY + (cornerY > midY ? r : -r));
            }
            ctx.lineTo(midX, cornerY - (cornerY > midY ? r : -r));
            ctx.quadraticCurveTo(midX, cornerY, midX + (target.x > midX ? r : -r), cornerY);
        } else {
            ctx.lineTo(midX, midY);
            ctx.lineTo(midX, cornerY);
        }

        ctx.lineTo(target.x, target.y);

        // 计算最后一段的角度
        this.lastSegmentAngle = Math.atan2(target.y - cornerY, target.x - midX);
    }

    /**
     * 绘制垂直折线
     * 偏移量只影响转折点，端点保持连接到节点
     */
    private drawVertical(ctx: CanvasRenderingContext2D, source: Point, target: Point): void {
        // 转折点应用偏移量，端点不应用偏移量
        const midY = (source.y + target.y) / 2 + this.offset.y;
        const midX = source.x + this.offset.x;
        const r = this.style.cornerRadius;

        // 保存路径点
        const cornerX = target.x + this.offset.x;
        this.pathPoints = [
            source,
            { x: midX, y: midY },
            { x: cornerX, y: midY },
            target
        ];

        // 保存中间点用于碰撞检测（向后兼容）
        this.lastMidPoint = { x: cornerX, y: midY };

        ctx.moveTo(source.x, source.y);

        if (Math.abs(target.y - source.y) > 2 * r) {
            // 有足够的空间绘制圆角
            if (source.y < target.y) {
                ctx.lineTo(source.x, midY - r);
                ctx.quadraticCurveTo(source.x, midY, midX + (cornerX > midX ? r : -r), midY);
            } else {
                ctx.lineTo(source.x, midY + r);
                ctx.quadraticCurveTo(source.x, midY, midX + (cornerX > midX ? r : -r), midY);
            }
            ctx.lineTo(cornerX - (cornerX > midX ? r : -r), midY);
            ctx.quadraticCurveTo(cornerX, midY, cornerX, midY + (target.y > midY ? r : -r));
        } else {
            ctx.lineTo(source.x, midY);
            ctx.lineTo(cornerX, midY);
        }

        ctx.lineTo(target.x, target.y);

        // 计算最后一段的角度
        this.lastSegmentAngle = Math.atan2(target.y - midY, target.x - cornerX);
    }

    /**
     * 绘制贝塞尔曲线
     */
    private drawBezier(ctx: CanvasRenderingContext2D, source: Point, target: Point): void {
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // 控制点距离 - 增加最小距离确保曲线效果
        const minControlDist = Math.max(dist * 0.5, 50); // 最小控制点距离为50像素

        // 根据连接点位置确定控制点方向
        // 对于垂直排列的节点（x 坐标接近），使用固定的水平偏移来产生曲线效果
        const isVertical = Math.abs(dx) < 20; // x 坐标差小于20视为垂直排列
        
        let sourceDirX: number;
        let sourceDirY: number;
        let targetDirX: number;
        let targetDirY: number;
        
        if (isVertical) {
            // 垂直排列时，使用固定的水平偏移产生S形曲线
            sourceDirX = 0.5;  // 向右偏移
            sourceDirY = 0.866; // 向下约60度
            targetDirX = -0.5; // 向左偏移
            targetDirY = -0.866; // 向上约60度
        } else {
            // 正常情况：根据相对位置自动计算
            sourceDirX = this.getDirectionX(this.source.position) ?? (Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : -1) : 0);
            sourceDirY = this.getDirectionY(this.source.position) ?? (Math.abs(dy) >= Math.abs(dx) ? (dy > 0 ? 1 : -1) : 0);
            targetDirX = this.getDirectionX(this.target.position) ?? (Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? -1 : 1) : 0);
            targetDirY = this.getDirectionY(this.target.position) ?? (Math.abs(dy) >= Math.abs(dx) ? (dy > 0 ? -1 : 1) : 0);
        }

        const cp1x = source.x + sourceDirX * minControlDist;
        const cp1y = source.y + sourceDirY * minControlDist;
        const cp2x = target.x + targetDirX * minControlDist;
        const cp2y = target.y + targetDirY * minControlDist;

        // 保存路径点（用于波浪动画）- 贝塞尔曲线使用采样点
        this.pathPoints = this.sampleBezierCurve(source, { x: cp1x, y: cp1y }, { x: cp2x, y: cp2y }, target, 20);

        ctx.moveTo(source.x, source.y);
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, target.x, target.y);

        // 计算终点处的切线角度
        const t = 0.95; // 接近终点的位置
        const mt = 1 - t;
        const x = mt * mt * mt * source.x + 3 * mt * mt * t * cp1x + 3 * mt * t * t * cp2x + t * t * t * target.x;
        const y = mt * mt * mt * source.y + 3 * mt * mt * t * cp1y + 3 * mt * t * t * cp2y + t * t * t * target.y;
        this.lastSegmentAngle = Math.atan2(target.y - y, target.x - x);
    }

    /**
     * 绘制弧度曲线
     * 偏移量影响弧线的控制点，端点保持连接到节点
     */
    private drawArc(ctx: CanvasRenderingContext2D, source: Point, target: Point): void {
        const midX = (source.x + target.x) / 2;
        const midY = (source.y + target.y) / 2;

        // 计算弧度控制点
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const arcHeight = dist * 0.2;

        // 垂直于连线方向的偏移
        const perpX = -dy / dist * arcHeight;
        const perpY = dx / dist * arcHeight;

        // 控制点应用偏移量
        const controlX = midX + perpX + this.offset.x;
        const controlY = midY + perpY + this.offset.y;

        // 保存路径点（用于波浪动画）- 弧线使用采样点
        this.pathPoints = this.sampleQuadraticCurve(source, { x: controlX, y: controlY }, target, 20);

        ctx.moveTo(source.x, source.y);
        ctx.quadraticCurveTo(controlX, controlY, target.x, target.y);

        // 计算终点处的切线角度
        this.lastSegmentAngle = Math.atan2(target.y - controlY, target.x - controlX);
    }

    /**
     * 绘制阶梯折线（先水平后垂直）
     * 类似于 drawHorizontal，但从 source.x 水平延伸到 target.x，再垂直到 target.y
     */
    private drawStepRight(ctx: CanvasRenderingContext2D, source: Point, target: Point): void {
        // 阶梯路径：source -> (target.x, source.y) -> target
        this.pathPoints = [source, { x: target.x, y: source.y }, target];
        this.lastMidPoint = { x: target.x, y: source.y };

        ctx.moveTo(source.x, source.y);
        ctx.lineTo(target.x, source.y);
        ctx.lineTo(target.x, target.y);

        // 计算最后一段的角度（垂直段）
        this.lastSegmentAngle = Math.atan2(target.y - source.y, 0);
    }

    /**
     * 绘制阶梯折线（先垂直后水平）
     * 偏移量影响转折点位置，端点保持连接到节点
     */
    private drawStepDown(ctx: CanvasRenderingContext2D, source: Point, target: Point): void {
        // 转折点应用偏移量
        const cornerX = source.x + this.offset.x;
        const cornerY = target.y + this.offset.y;
        
        this.pathPoints = [source, { x: cornerX, y: cornerY }, target];
        this.lastMidPoint = { x: cornerX, y: cornerY };

        ctx.moveTo(source.x, source.y);
        ctx.lineTo(cornerX, cornerY);
        ctx.lineTo(target.x, target.y);

        // 计算最后一段的角度（水平段）
        this.lastSegmentAngle = Math.atan2(target.y - cornerY, target.x - cornerX);
    }

    /**
     * 绘制圆角阶梯折线（先水平后垂直）
     * 与 drawStepRight 类似但带有圆角
     */
    private drawRoundedStepRight(ctx: CanvasRenderingContext2D, source: Point, target: Point): void {
        const cornerX = target.x;
        const cornerY = source.y;
        const r = this.style.cornerRadius;

        // 路径点
        this.pathPoints = [source, { x: cornerX, y: cornerY }, target];
        this.lastMidPoint = { x: cornerX, y: cornerY };

        ctx.moveTo(source.x, source.y);

        // 判断拐角方向
        const goRight = target.x > source.x;
        const goDown = target.y > source.y;

        // 计算拐角处的圆角
        if (Math.abs(target.x - source.x) > r && Math.abs(target.y - source.y) > r) {
            // 水平线到圆角起点
            const arcStartX = goRight ? cornerX - r : cornerX + r;
            ctx.lineTo(arcStartX, cornerY);

            // 绘制四分之一圆弧
            const arcEndY = goDown ? cornerY + r : cornerY - r;
            ctx.quadraticCurveTo(cornerX, cornerY, cornerX, arcEndY);

            // 垂直线到目标
            ctx.lineTo(target.x, target.y);

            // 计算最后一段角度
            this.lastSegmentAngle = Math.atan2(target.y - arcEndY, 0);
        } else {
            // 空间不足，直接绘制直角
            ctx.lineTo(cornerX, cornerY);
            ctx.lineTo(target.x, target.y);
            this.lastSegmentAngle = Math.atan2(target.y - cornerY, 0);
        }
    }

    /**
     * 绘制圆角阶梯折线（先垂直后水平）
     * 偏移量影响转折点位置，端点保持连接到节点
     */
    private drawRoundedStepDown(ctx: CanvasRenderingContext2D, source: Point, target: Point): void {
        // 转折点应用偏移量
        const cornerX = source.x + this.offset.x;
        const cornerY = target.y + this.offset.y;
        const r = this.style.cornerRadius;

        // 路径点
        this.pathPoints = [source, { x: cornerX, y: cornerY }, target];
        this.lastMidPoint = { x: cornerX, y: cornerY };

        ctx.moveTo(source.x, source.y);

        // 判断拐角方向（基于偏移后的转折点）
        const goRight = target.x > cornerX;
        const goDown = cornerY > source.y;

        // 计算拐角处的圆角
        if (Math.abs(cornerY - source.y) > r && Math.abs(target.x - cornerX) > r) {
            // 垂直线到圆角起点
            const arcStartY = goDown ? cornerY - r : cornerY + r;
            ctx.lineTo(cornerX, arcStartY);

            // 绘制四分之一圆弧
            const arcEndX = goRight ? cornerX + r : cornerX - r;
            ctx.quadraticCurveTo(cornerX, cornerY, arcEndX, cornerY);

            // 水平线到目标
            ctx.lineTo(target.x, target.y);

            // 计算最后一段角度
            this.lastSegmentAngle = Math.atan2(target.y - cornerY, target.x - arcEndX);
        } else {
            // 空间不足，直接绘制直角
            ctx.lineTo(cornerX, cornerY);
            ctx.lineTo(target.x, target.y);
            this.lastSegmentAngle = Math.atan2(target.y - cornerY, target.x - cornerX);
        }
    }

    /**
     * 绘制平滑 L 型折线（正交圆角）
     * 偏移量影响转折点位置，端点保持连接到节点
     */
    private drawSmoothStep(ctx: CanvasRenderingContext2D, source: Point, target: Point): void {
        // 转折点应用偏移量
        const midX = target.x + this.offset.x;
        const midY = source.y + this.offset.y;
        
        const r = Math.min(this.style.cornerRadius, Math.abs(midX - source.x) / 2, Math.abs(target.y - midY) / 2);

        // 判断方向（基于偏移后的转折点）
        const goRight = midX > source.x;
        const goDown = target.y > midY;

        // 路径点 - 使用采样点来近似曲线
        this.pathPoints = [source];

        ctx.moveTo(source.x, source.y);

        if (Math.abs(midX - source.x) > 2 * r && Math.abs(target.y - midY) > 2 * r) {
            // 先水平线
            const hLineEndX = goRight ? midX - r : midX + r;
            ctx.lineTo(hLineEndX, midY);

            // 添加路径点
            this.pathPoints.push({ x: hLineEndX, y: midY });

            // 平滑曲线拐角
            const cp1x = hLineEndX + (goRight ? r * 0.5 : -r * 0.5);
            const cp1y = midY;
            const cp2x = midX;
            const cp2y = goDown ? midY + r * 0.5 : midY - r * 0.5;
            const arcEndY = goDown ? midY + r : midY - r;

            ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, midX, arcEndY);

            // 添加曲线采样点
            this.pathPoints.push({ x: midX, y: arcEndY });

            // 垂直线到目标
            ctx.lineTo(target.x, target.y);
            this.pathPoints.push(target);

            // 计算最后一段角度
            this.lastSegmentAngle = Math.atan2(target.y - arcEndY, target.x - midX);
        } else {
            // 空间不足，简化为直角
            ctx.lineTo(midX, midY);
            ctx.lineTo(target.x, target.y);
            this.pathPoints.push({ x: midX, y: midY }, target);
            this.lastSegmentAngle = Math.atan2(target.y - midY, target.x - midX);
        }

        this.lastMidPoint = { x: midX, y: midY };
    }

    /**
     * 绘制正交折线（智能路由）
     * 偏移量影响转折点位置，端点保持连接到节点
     */
    private drawOrthogonal(ctx: CanvasRenderingContext2D, source: Point, target: Point): void {
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const r = this.style.cornerRadius;

        // 根据距离决定是先水平还是先垂直
        // 如果水平距离更大，先水平后垂直；否则先垂直后水平
        const goHorizontalFirst = Math.abs(dx) >= Math.abs(dy);

        if (goHorizontalFirst) {
            // 类似 StepRight，转折点应用偏移量
            const midX = target.x + this.offset.x;
            const midY = source.y + this.offset.y;

            this.pathPoints = [source, { x: midX, y: midY }, target];
            this.lastMidPoint = { x: midX, y: midY };

            ctx.moveTo(source.x, source.y);

            if (Math.abs(midX - source.x) > 2 * r && Math.abs(target.y - midY) > 2 * r) {
                const goRight = midX > source.x;
                const goDown = target.y > midY;

                ctx.lineTo(goRight ? midX - r : midX + r, midY);
                ctx.quadraticCurveTo(
                    midX, midY,
                    midX,
                    goDown ? midY + r : midY - r
                );
                ctx.lineTo(target.x, target.y);
            } else {
                ctx.lineTo(midX, midY);
                ctx.lineTo(target.x, target.y);
            }

            this.lastSegmentAngle = Math.atan2(target.y - midY, target.x - midX);
        } else {
            // 类似 StepDown，转折点应用偏移量
            const midX = source.x + this.offset.x;
            const midY = target.y + this.offset.y;

            this.pathPoints = [source, { x: midX, y: midY }, target];
            this.lastMidPoint = { x: midX, y: midY };

            ctx.moveTo(source.x, source.y);

            if (Math.abs(target.x - midX) > 2 * r && Math.abs(midY - source.y) > 2 * r) {
                const goRight = target.x > midX;
                const goDown = midY > source.y;

                ctx.lineTo(midX, goDown ? midY - r : midY + r);
                ctx.quadraticCurveTo(
                    midX, midY,
                    goRight ? midX + r : midX - r,
                    midY
                );
                ctx.lineTo(target.x, target.y);
            } else {
                ctx.lineTo(midX, midY);
                ctx.lineTo(target.x, target.y);
            }

            this.lastSegmentAngle = Math.atan2(target.y - midY, target.x - midX);
        }
    }

    /**
     * 绘制流动波浪效果
     * @param ctx - Canvas 2D 上下文
     * @param source - 起点坐标
     * @param target - 终点坐标
     * @param time - 当前时间戳
     */
    private drawFlowingWave(ctx: CanvasRenderingContext2D, source: Point, target: Point, time: number): void {
        const { waveColor, waveWidth, waveLength, waveSpeed, waveOpacity } = this.style;
        
        // 计算动画偏移（波浪流动的距离）
        // 使用负号使波浪从 source（末端）流向 target（箭头端）
        const offset = (time * waveSpeed / 50) % (waveLength * 2);
        
        ctx.save();
        ctx.strokeStyle = waveColor;
        ctx.lineWidth = waveWidth;
        ctx.lineCap = 'round';
        ctx.globalAlpha = waveOpacity;
        
        // 计算路径总长度
        const totalLength = this.calculatePathLength(source, target);
        if (totalLength === 0) {
            ctx.restore();
            return;
        }

        // 绘制多个波浪段，覆盖整个路径
        // 波浪周期为 waveLength * 2（一个波浪 + 一个间隔）
        const wavePeriod = waveLength * 2;
        
        // 从正偏移开始，使波浪从起点（source）向终点（target/箭头端）流动
        for (let pos = offset - wavePeriod; pos < totalLength; pos += wavePeriod) {
            const waveStart = pos;
            const waveEnd = pos + waveLength;
            
            // 只绘制在路径范围内的波浪
            if (waveEnd > 0 && waveStart < totalLength) {
                const startDist = Math.max(0, waveStart);
                const endDist = Math.min(totalLength, waveEnd);
                
                // 计算渐变透明度（波浪头部和尾部渐隐）
                const waveProgress = (waveStart + waveLength / 2) / totalLength;
                const fadeAlpha = Math.sin(waveProgress * Math.PI) * waveOpacity;
                
                ctx.globalAlpha = Math.min(fadeAlpha, waveOpacity);
                ctx.beginPath();
                this.drawPathSegment(ctx, source, target, startDist, endDist);
                ctx.stroke();
            }
        }
        
        ctx.restore();
    }

    /**
     * 计算路径长度
     */
    private calculatePathLength(source: Point, target: Point): number {
        // 如果有路径点，使用路径点计算精确长度
        if (this.pathPoints.length >= 2) {
            let length = 0;
            for (let i = 1; i < this.pathPoints.length; i++) {
                const dx = this.pathPoints[i].x - this.pathPoints[i - 1].x;
                const dy = this.pathPoints[i].y - this.pathPoints[i - 1].y;
                length += Math.sqrt(dx * dx + dy * dy);
            }
            return length;
        }
        
        // 回退到简单计算
        switch (this.type) {
            case EdgeType.Straight:
                return Math.sqrt(Math.pow(target.x - source.x, 2) + Math.pow(target.y - source.y, 2));
            
            case EdgeType.Horizontal:
            case EdgeType.Vertical:
                // 折线路径长度
                if (this.lastMidPoint) {
                    const seg1 = Math.sqrt(Math.pow(this.lastMidPoint.x - source.x, 2) + Math.pow(this.lastMidPoint.y - source.y, 2));
                    const seg2 = Math.sqrt(Math.pow(target.x - this.lastMidPoint.x, 2) + Math.pow(target.y - this.lastMidPoint.y, 2));
                    return seg1 + seg2;
                }
                return Math.sqrt(Math.pow(target.x - source.x, 2) + Math.pow(target.y - source.y, 2));
            
            case EdgeType.Bezier:
            case EdgeType.Arc:
                // 使用近似长度（控制点距离的平均值）
                const midX = (source.x + target.x) / 2;
                const midY = (source.y + target.y) / 2;
                const dist1 = Math.sqrt(Math.pow(midX - source.x, 2) + Math.pow(midY - source.y, 2));
                const dist2 = Math.sqrt(Math.pow(target.x - midX, 2) + Math.pow(target.y - midY, 2));
                return (dist1 + dist2) * 1.2; // 曲线比直线稍长
            
            case EdgeType.StepRight:
            case EdgeType.StepDown:
            case EdgeType.RoundedStepRight:
            case EdgeType.RoundedStepDown:
            case EdgeType.SmoothStep:
            case EdgeType.Orthogonal:
            case EdgeType.DashedStep:
            case EdgeType.DashedRounded:
                // 阶梯折线类型，两段直线之和
                if (this.lastMidPoint) {
                    const seg1 = Math.sqrt(Math.pow(this.lastMidPoint.x - source.x, 2) + Math.pow(this.lastMidPoint.y - source.y, 2));
                    const seg2 = Math.sqrt(Math.pow(target.x - this.lastMidPoint.x, 2) + Math.pow(target.y - this.lastMidPoint.y, 2));
                    // 圆角版本稍微长一点
                    const isRounded = Edge.ROUNDED_TYPES.has(this.type);
                    return isRounded ? (seg1 + seg2) * 1.05 : seg1 + seg2;
                }
                return Math.sqrt(Math.pow(target.x - source.x, 2) + Math.pow(target.y - source.y, 2));
            
            default:
                return Math.sqrt(Math.pow(target.x - source.x, 2) + Math.pow(target.y - source.y, 2));
        }
    }

    /**
     * 绘制路径的一段（使用路径点数组）
     */
    private drawPathSegment(ctx: CanvasRenderingContext2D, source: Point, target: Point, startDist: number, endDist: number): void {
        const totalLength = this.calculatePathLength(source, target);
        if (totalLength === 0) return;

        const startRatio = Math.max(0, Math.min(1, startDist / totalLength));
        const endRatio = Math.max(0, Math.min(1, endDist / totalLength));

        // 使用路径点数组绘制
        if (this.pathPoints.length >= 2) {
            this.drawPathSegmentByPoints(ctx, startRatio, endRatio);
            return;
        }

        // 回退到旧的绘制逻辑
        const startPoint = this.getPointOnPath(source, target, startRatio);
        const endPoint = this.getPointOnPath(source, target, endRatio);

        if (!startPoint || !endPoint) return;

        // 对于曲线类型（贝塞尔曲线和弧线），使用采样点绘制以确保沿曲线
        if (this.type === EdgeType.Bezier || this.type === EdgeType.Arc) {
            this.drawCurveSegment(ctx, source, target, startRatio, endRatio);
            return;
        }

        // 对于直线，直接绘制
        if (this.type === EdgeType.Straight) {
            ctx.moveTo(startPoint.x, startPoint.y);
            ctx.lineTo(endPoint.x, endPoint.y);
            return;
        }

        // 对于折线，需要处理中间点
        if ((this.type === EdgeType.Horizontal || this.type === EdgeType.Vertical) && this.lastMidPoint) {
            const midDistRatio = this.calculatePathLength(source, this.lastMidPoint) / totalLength;
            
            if (endRatio <= midDistRatio) {
                // 完全在第一段
                const segStart = this.getPointOnLine(source, this.lastMidPoint, startRatio / midDistRatio);
                const segEnd = this.getPointOnLine(source, this.lastMidPoint, endRatio / midDistRatio);
                ctx.moveTo(segStart.x, segStart.y);
                ctx.lineTo(segEnd.x, segEnd.y);
            } else if (startRatio >= midDistRatio) {
                // 完全在第二段
                const segStart = this.getPointOnLine(this.lastMidPoint, target, (startRatio - midDistRatio) / (1 - midDistRatio));
                const segEnd = this.getPointOnLine(this.lastMidPoint, target, (endRatio - midDistRatio) / (1 - midDistRatio));
                ctx.moveTo(segStart.x, segStart.y);
                ctx.lineTo(segEnd.x, segEnd.y);
            } else {
                // 跨越中间点
                ctx.moveTo(startPoint.x, startPoint.y);
                ctx.lineTo(this.lastMidPoint.x, this.lastMidPoint.y);
                ctx.lineTo(endPoint.x, endPoint.y);
            }
        }
    }

    /**
     * 使用路径点数组绘制路径段
     */
    private drawPathSegmentByPoints(ctx: CanvasRenderingContext2D, startRatio: number, endRatio: number): void {
        if (this.pathPoints.length < 2) return;

        // 计算每个点的累积距离
        const distances: number[] = [0];
        let totalLength = 0;
        for (let i = 1; i < this.pathPoints.length; i++) {
            const dx = this.pathPoints[i].x - this.pathPoints[i - 1].x;
            const dy = this.pathPoints[i].y - this.pathPoints[i - 1].y;
            totalLength += Math.sqrt(dx * dx + dy * dy);
            distances.push(totalLength);
        }

        if (totalLength === 0) return;

        const startDist = startRatio * totalLength;
        const endDist = endRatio * totalLength;

        // 找到起点和终点位置
        const points: Point[] = [];
        let started = false;

        for (let i = 0; i < this.pathPoints.length - 1; i++) {
            const segStart = distances[i];
            const segEnd = distances[i + 1];

            // 检查这一段是否在绘制范围内
            if (segEnd < startDist) continue;
            if (segStart > endDist) break;

            const p1 = this.pathPoints[i];
            const p2 = this.pathPoints[i + 1];
            const segLength = segEnd - segStart;

            if (segLength === 0) continue;

            // 计算这一段的起点
            let drawStart: Point;
            if (segStart < startDist) {
                const ratio = (startDist - segStart) / segLength;
                drawStart = {
                    x: p1.x + (p2.x - p1.x) * ratio,
                    y: p1.y + (p2.y - p1.y) * ratio
                };
            } else {
                drawStart = p1;
            }

            // 计算这一段的终点
            let drawEnd: Point;
            if (segEnd > endDist) {
                const ratio = (endDist - segStart) / segLength;
                drawEnd = {
                    x: p1.x + (p2.x - p1.x) * ratio,
                    y: p1.y + (p2.y - p1.y) * ratio
                };
            } else {
                drawEnd = p2;
            }

            if (!started) {
                points.push(drawStart);
                started = true;
            }
            points.push(drawEnd);
        }

        // 绘制路径
        if (points.length >= 2) {
            ctx.moveTo(points[0].x, points[0].y);
            for (let i = 1; i < points.length; i++) {
                ctx.lineTo(points[i].x, points[i].y);
            }
        }
    }

    /**
     * 绘制曲线段（贝塞尔曲线或弧线）
     * 使用采样点确保波浪沿着实际曲线路径绘制
     */
    private drawCurveSegment(ctx: CanvasRenderingContext2D, source: Point, target: Point, startRatio: number, endRatio: number): void {
        const numSamples = Math.max(2, Math.ceil((endRatio - startRatio) * 20)); // 根据段长度决定采样点数
        
        const points: Point[] = [];
        for (let i = 0; i <= numSamples; i++) {
            const ratio = startRatio + (endRatio - startRatio) * (i / numSamples);
            const point = this.getPointOnCurve(source, target, ratio);
            if (point) {
                points.push(point);
            }
        }

        if (points.length < 2) return;

        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
            ctx.lineTo(points[i].x, points[i].y);
        }
    }

    /**
     * 获取曲线（贝塞尔或弧线）上某比例的点的精确坐标
     * 控制点应用偏移量
     */
    private getPointOnCurve(source: Point, target: Point, ratio: number): Point | null {
        if (ratio <= 0) return { ...source };
        if (ratio >= 1) return { ...target };

        if (this.type === EdgeType.Bezier) {
            const dx = target.x - source.x;
            const dy = target.y - source.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const controlDist = dist * 0.5;

            // 根据连接点位置确定控制点方向，如果没有指定位置，则根据两点的相对位置自动计算
            const sourceDirX = this.getDirectionX(this.source.position) ?? (Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : -1) : 0);
            const sourceDirY = this.getDirectionY(this.source.position) ?? (Math.abs(dy) >= Math.abs(dx) ? (dy > 0 ? 1 : -1) : 0);
            const targetDirX = this.getDirectionX(this.target.position) ?? (Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? -1 : 1) : 0);
            const targetDirY = this.getDirectionY(this.target.position) ?? (Math.abs(dy) >= Math.abs(dx) ? (dy > 0 ? -1 : 1) : 0);

            // 控制点应用偏移量
            const cp1x = source.x + sourceDirX * controlDist + this.offset.x;
            const cp1y = source.y + sourceDirY * controlDist + this.offset.y;
            const cp2x = target.x + targetDirX * controlDist + this.offset.x;
            const cp2y = target.y + targetDirY * controlDist + this.offset.y;

            // 三次贝塞尔曲线公式
            const t = ratio;
            const mt = 1 - t;
            const x = mt * mt * mt * source.x + 3 * mt * mt * t * cp1x + 3 * mt * t * t * cp2x + t * t * t * target.x;
            const y = mt * mt * mt * source.y + 3 * mt * mt * t * cp1y + 3 * mt * t * t * cp2y + t * t * t * target.y;
            
            return { x, y };
        }

        if (this.type === EdgeType.Arc) {
            const midX = (source.x + target.x) / 2;
            const midY = (source.y + target.y) / 2;
            const dx = target.x - source.x;
            const dy = target.y - source.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const arcHeight = dist * 0.2;
            const perpX = -dy / dist * arcHeight;
            const perpY = dx / dist * arcHeight;
            // 控制点应用偏移量
            const controlX = midX + perpX + this.offset.x;
            const controlY = midY + perpY + this.offset.y;

            // 二次贝塞尔曲线公式
            const t = ratio;
            const mt = 1 - t;
            const x = mt * mt * source.x + 2 * mt * t * controlX + t * t * target.x;
            const y = mt * mt * source.y + 2 * mt * t * controlY + t * t * target.y;
            
            return { x, y };
        }

        return null;
    }

    /**
     * 获取路径上某比例的点的坐标
     */
    private getPointOnPath(source: Point, target: Point, ratio: number): Point | null {
        if (ratio <= 0) return { ...source };
        if (ratio >= 1) return { ...target };

        switch (this.type) {
            case EdgeType.Straight:
                return {
                    x: source.x + (target.x - source.x) * ratio,
                    y: source.y + (target.y - source.y) * ratio
                };

            case EdgeType.Horizontal:
            case EdgeType.Vertical:
                if (this.lastMidPoint) {
                    const seg1Length = this.calculatePathLength(source, this.lastMidPoint);
                    const totalLength = this.calculatePathLength(source, target);
                    const midRatio = seg1Length / totalLength;
                    
                    if (ratio <= midRatio) {
                        return this.getPointOnLine(source, this.lastMidPoint, ratio / midRatio);
                    } else {
                        return this.getPointOnLine(this.lastMidPoint, target, (ratio - midRatio) / (1 - midRatio));
                    }
                }
                return {
                    x: source.x + (target.x - source.x) * ratio,
                    y: source.y + (target.y - source.y) * ratio
                };

            case EdgeType.Bezier:
            case EdgeType.Arc:
                // 简化处理，使用线性插值
                return {
                    x: source.x + (target.x - source.x) * ratio,
                    y: source.y + (target.y - source.y) * ratio
                };

            case EdgeType.StepRight:
            case EdgeType.StepDown:
            case EdgeType.RoundedStepRight:
            case EdgeType.RoundedStepDown:
            case EdgeType.SmoothStep:
            case EdgeType.Orthogonal:
            case EdgeType.DashedStep:
            case EdgeType.DashedRounded:
                // 阶梯折线类型，使用 pathPoints
                if (this.pathPoints.length >= 2) {
                    return this.getPointOnPathByPoints(ratio);
                }
                // 回退到 lastMidPoint 检测
                if (this.lastMidPoint) {
                    const seg1Length = this.calculatePathLength(source, this.lastMidPoint);
                    const totalLength = this.calculatePathLength(source, target);
                    const midRatio = seg1Length / totalLength;
                    
                    if (ratio <= midRatio) {
                        return this.getPointOnLine(source, this.lastMidPoint, ratio / midRatio);
                    } else {
                        return this.getPointOnLine(this.lastMidPoint, target, (ratio - midRatio) / (1 - midRatio));
                    }
                }
                return {
                    x: source.x + (target.x - source.x) * ratio,
                    y: source.y + (target.y - source.y) * ratio
                };

            default:
                return {
                    x: source.x + (target.x - source.x) * ratio,
                    y: source.y + (target.y - source.y) * ratio
                };
        }
    }

    /**
     * 获取线段上某比例的点的坐标
     */
    private getPointOnLine(start: Point, end: Point, ratio: number): Point {
        return {
            x: start.x + (end.x - start.x) * ratio,
            y: start.y + (end.y - start.y) * ratio
        };
    }

    /**
     * 使用 pathPoints 数组获取路径上某比例的点的坐标
     */
    private getPointOnPathByPoints(ratio: number): Point | null {
        if (this.pathPoints.length < 2) return null;
        if (ratio <= 0) return { ...this.pathPoints[0] };
        if (ratio >= 1) return { ...this.pathPoints[this.pathPoints.length - 1] };

        // 计算每个点的累积距离
        const distances: number[] = [0];
        let totalLength = 0;
        for (let i = 1; i < this.pathPoints.length; i++) {
            const dx = this.pathPoints[i].x - this.pathPoints[i - 1].x;
            const dy = this.pathPoints[i].y - this.pathPoints[i - 1].y;
            totalLength += Math.sqrt(dx * dx + dy * dy);
            distances.push(totalLength);
        }

        if (totalLength === 0) return { ...this.pathPoints[0] };

        const targetDist = ratio * totalLength;

        // 找到目标距离所在的段
        for (let i = 0; i < this.pathPoints.length - 1; i++) {
            const segStart = distances[i];
            const segEnd = distances[i + 1];

            if (targetDist >= segStart && targetDist <= segEnd) {
                const segLength = segEnd - segStart;
                if (segLength === 0) continue;

                const segRatio = (targetDist - segStart) / segLength;
                return this.getPointOnLine(this.pathPoints[i], this.pathPoints[i + 1], segRatio);
            }
        }

        return { ...this.pathPoints[this.pathPoints.length - 1] };
    }

    /**
     * 采样三次贝塞尔曲线点
     */
    private sampleBezierCurve(p0: Point, p1: Point, p2: Point, p3: Point, numSamples: number): Point[] {
        const points: Point[] = [];
        for (let i = 0; i <= numSamples; i++) {
            const t = i / numSamples;
            const mt = 1 - t;
            const x = mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x;
            const y = mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y;
            points.push({ x, y });
        }
        return points;
    }

    /**
     * 采样二次贝塞尔曲线点（弧线）
     */
    private sampleQuadraticCurve(p0: Point, p1: Point, p2: Point, numSamples: number): Point[] {
        const points: Point[] = [];
        for (let i = 0; i <= numSamples; i++) {
            const t = i / numSamples;
            const mt = 1 - t;
            const x = mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x;
            const y = mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y;
            points.push({ x, y });
        }
        return points;
    }

    /**
     * 获取方向 X 分量
     * @returns 返回 -1（左）、1（右）或 null（未指定方向）
     */
    private getDirectionX(position: string | undefined): number | null {
        switch (position) {
            case 'left':
                return -1;
            case 'right':
                return 1;
            default:
                return null;
        }
    }

    /**
     * 获取方向 Y 分量
     * @returns 返回 -1（上）、1（下）或 null（未指定方向）
     */
    private getDirectionY(position: string | undefined): number | null {
        switch (position) {
            case 'top':
                return -1;
            case 'bottom':
                return 1;
            default:
                return null;
        }
    }

    /**
     * 绘制箭头
     */
    private drawArrow(ctx: CanvasRenderingContext2D, point: Point, angle: number): void {
        const size = this.style.arrowSize;
        const color = this.isSelected ? this.style.selectedStroke : this.style.arrowColor;

        ctx.save();
        ctx.translate(point.x, point.y);
        ctx.rotate(angle);

        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(-size, -size / 2);
        ctx.lineTo(-size, size / 2);
        ctx.closePath();

        ctx.fillStyle = color;
        ctx.fill();

        ctx.restore();
    }

    /**
     * 绘制标签
     */
    private drawLabel(ctx: CanvasRenderingContext2D, source: Point, target: Point): void {
        const midX = (source.x + target.x) / 2;
        const midY = (source.y + target.y) / 2;

        ctx.save();

        // 绘制标签背景
        ctx.font = '12px system-ui, -apple-system, sans-serif';
        const textMetrics = ctx.measureText(this.label);
        const padding = 4;
        const bgWidth = textMetrics.width + padding * 2;
        const bgHeight = 20;

        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.beginPath();
        this.roundRect(
            ctx,
            midX - bgWidth / 2,
            midY - bgHeight / 2,
            bgWidth,
            bgHeight,
            4
        );
        ctx.fill();

        // 绘制标签文字
        ctx.fillStyle = '#475569';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(this.label, midX, midY);

        ctx.restore();
    }

    /**
     * 绘制圆角矩形
     */
    private roundRect(
        ctx: CanvasRenderingContext2D,
        x: number,
        y: number,
        width: number,
        height: number,
        radius: number
    ): void {
        const r = Math.min(radius, width / 2, height / 2);
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + width - r, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + r);
        ctx.lineTo(x + width, y + height - r);
        ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
        ctx.lineTo(x + r, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    /**
     * 序列化为 JSON
     */
    toJSON(): EdgeData {
        return {
            id: this.id,
            label: this.label,
            source: { ...this.source },
            target: { ...this.target },
            type: this.type,
            data: { ...this.data },
            connected: this.connected,
            offset: { ...this.offset },
        };
    }

    /**
     * 从 JSON 创建边
     */
    static fromJSON(data: EdgeData): Edge {
        const edge = new Edge({
            id: data.id,
            source: data.source,
            target: data.target,
            type: data.type,
            label: data.label,
            data: data.data,
        });
        if (data.connected === false) {
            edge.disconnect();
        }
        if (data.offset) {
            edge.setOffset(data.offset.x, data.offset.y);
        }
        return edge;
    }

    /**
     * 克隆边
     */
    clone(newId?: string): Edge {
        const edge = new Edge({
            id: newId || `${this.id}_clone`,
            source: { ...this.source },
            target: { ...this.target },
            type: this.type,
            label: this.label,
            style: { ...this.style },
            data: { ...this.data },
        });
        edge.setOffset(this.offset.x, this.offset.y);
        return edge;
    }

    /**
     * 启动流动波浪动画
     * @param waveOptions - 可选的波浪配置，不传则使用当前样式配置
     * @returns 是否成功启动
     */
    startAnimation(waveOptions?: Partial<Pick<EdgeStyle, 'waveColor' | 'waveWidth' | 'waveLength' | 'waveSpeed' | 'waveOpacity'>>): boolean {
        if (this.isAnimating) {
            // 如果已经在动画中，更新配置
            if (waveOptions) {
                this.style = { ...this.style, ...waveOptions };
            }
            return false;
        }
        
        this.isAnimating = true;
        
        // 如果有传入配置，更新样式
        if (waveOptions) {
            this.style = {
                ...this.style,
                animated: true,
                ...waveOptions
            };
        } else {
            this.style.animated = true;
        }
        
        return true;
    }

    /**
     * 停止流动波浪动画
     * @returns 是否成功停止
     */
    stopAnimation(): boolean {
        if (!this.isAnimating) {
            return false;
        }
        this.isAnimating = false;
        this.style.animated = false;
        return true;
    }

    /**
     * 检查边是否正在播放流动动画
     * @returns 是否正在动画
     */
    isAnimationPlaying(): boolean {
        return this.isAnimating;
    }

    /**
     * 断开连接（消除连接线）
     * @returns 是否成功断开
     */
    disconnect(): boolean {
        if (!this.connected) {
            return false;
        }
        this.connected = false;
        this.onDisconnect?.(this);
        return true;
    }

    /**
     * 检查边是否处于连接状态
     * @returns 是否已连接
     */
    isConnected(): boolean {
        return this.connected;
    }

    /**
     * 设置跳线交叉点位置（用于 JumpLine 类型）
     * @param points - 交叉点位置数组
     */
    setJumpPoints(points: Point[]): void {
        this.jumpPoints = points;
    }

    /**
     * 获取跳线交叉点位置
     * @returns 交叉点位置数组
     */
    getJumpPoints(): Point[] {
        return [...this.jumpPoints];
    }

    /**
     * 重新连接（恢复连接线）
     * @returns 是否成功重连
     */
    reconnect(): boolean {
        if (this.connected) {
            return false;
        }
        this.connected = true;
        return true;
    }

    /**
     * 检测点是否在线上
     * @param point - 待检测的点
     * @param tolerance - 容差（默认 5 像素）
     * @returns 是否在线上
     */
    containsPoint(point: Point, tolerance: number = 1): boolean {
        if (!this.connected) {
            return false;
        }

        // 对于所有类型，优先使用 pathPoints 进行精确检测
        // pathPoints 包含了偏移后的路径形状
        if (this.pathPoints.length >= 2) {
            for (let i = 0; i < this.pathPoints.length - 1; i++) {
                if (this.isPointOnLineSegment(point, this.pathPoints[i], this.pathPoints[i + 1], tolerance)) {
                    return true;
                }
            }
            // 对于有多个路径点的类型（折线、曲线等），已经检测完成
            if (this.pathPoints.length > 2) {
                return false;
            }
        }

        // 回退到简单检测（用于直线或 pathPoints 不可用的情况）
        const source = this.lastSourcePoint;
        const target = this.lastTargetPoint;

        switch (this.type) {
            case EdgeType.Straight:
            case EdgeType.JumpLine:
                return this.isPointOnLineSegment(point, source, target, tolerance);
            case EdgeType.Horizontal:
            case EdgeType.Vertical:
                if (this.lastMidPoint) {
                    // 折线有两段：source -> mid -> target
                    return this.isPointOnLineSegment(point, source, this.lastMidPoint, tolerance) ||
                           this.isPointOnLineSegment(point, this.lastMidPoint, target, tolerance);
                }
                return this.isPointOnLineSegment(point, source, target, tolerance);
            case EdgeType.Bezier:
            case EdgeType.Arc:
                // 对于贝塞尔曲线和弧线，使用近似检测（点到起止点的距离）
                return this.isPointNearCurve(point, source, target, tolerance);
            case EdgeType.StepRight:
            case EdgeType.StepDown:
            case EdgeType.RoundedStepRight:
            case EdgeType.RoundedStepDown:
            case EdgeType.SmoothStep:
            case EdgeType.Orthogonal:
            case EdgeType.DashedStep:
            case EdgeType.DashedRounded:
                // 回退到 lastMidPoint 检测
                if (this.lastMidPoint) {
                    return this.isPointOnLineSegment(point, source, this.lastMidPoint, tolerance) ||
                           this.isPointOnLineSegment(point, this.lastMidPoint, target, tolerance);
                }
                return this.isPointOnLineSegment(point, source, target, tolerance);
            default:
                return false;
        }
    }

    /**
     * 检测点是否在线段上
     */
    private isPointOnLineSegment(
        point: Point,
        start: Point,
        end: Point,
        tolerance: number
    ): boolean {
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const lenSquared = dx * dx + dy * dy;

        if (lenSquared === 0) {
            // 起点和终点重合
            const dist = Math.sqrt(
                (point.x - start.x) ** 2 + (point.y - start.y) ** 2
            );
            return dist <= tolerance;
        }

        // 计算投影参数 t
        let t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lenSquared;
        t = Math.max(0, Math.min(1, t));

        // 计算最近点
        const closestX = start.x + t * dx;
        const closestY = start.y + t * dy;

        // 计算距离
        const dist = Math.sqrt(
            (point.x - closestX) ** 2 + (point.y - closestY) ** 2
        );

        return dist <= tolerance;
    }

    /**
     * 检测点是否靠近曲线（近似检测）
     */
    private isPointNearCurve(
        point: Point,
        source: Point,
        target: Point,
        tolerance: number
    ): boolean {
        // 简化检测：检查点是否在曲线的包围盒内
        const minX = Math.min(source.x, target.x) - tolerance;
        const maxX = Math.max(source.x, target.x) + tolerance;
        const minY = Math.min(source.y, target.y) - tolerance;
        const maxY = Math.max(source.y, target.y) + tolerance;

        if (point.x < minX || point.x > maxX || point.y < minY || point.y > maxY) {
            return false;
        }

        // 进一步检测：点到线段的距离
        return this.isPointOnLineSegment(point, source, target, tolerance * 2);
    }

    // ==================== 事件处理 ====================

    /**
     * 触发 Edge 相关事件
     * @param eventType - 事件类型（click, dblclick, contextmenu, mousedown, mousemove, mouseup, mousewheel, mouseenter, mouseleave）
     * @param originalEvent - 原始 DOM 事件
     * @param extraData - 额外的事件数据
     * @returns 是否未阻止默认行为
     */
    triggerEdgeEvent(
        eventType: string,
        originalEvent: Event,
        extraData: Partial<EdgeEvent> = {}
    ): boolean {
        const edgeEventName = `edge:${eventType}`;

        // 创建事件对象
        const eventData = this.createEdgeEvent(originalEvent, extraData);

        // 同时触发 cell:xxx 和 edge:xxx 事件
        const cellResult = this.triggerCellEvent(eventType, originalEvent, extraData);
        const edgeResult = this.emit(edgeEventName, eventData);

        return cellResult && edgeResult;
    }

    /**
     * 创建 Edge 事件对象
     */
    protected createEdgeEvent(
        originalEvent: Event,
        extraData: Partial<EdgeEvent> = {}
    ): EdgeEvent {
        const baseEvent = this.createCellEvent(originalEvent, extraData);

        return {
            ...baseEvent,
            type: 'edge',
            target: this,
            edge: this,
            sourceId: this.source.nodeId,
            targetId: this.target.nodeId,
            ...extraData,
        } as EdgeEvent;
    }

    /**
     * 获取事件名称映射
     */
    protected override getEventNameMap(): Record<string, string> {
        return {
            click: EVENT_NAMES.EDGE_CLICK,
            dblclick: EVENT_NAMES.EDGE_DBLCLICK,
            contextmenu: EVENT_NAMES.EDGE_CONTEXTMENU,
            mousedown: EVENT_NAMES.EDGE_MOUSEDOWN,
            mousemove: EVENT_NAMES.EDGE_MOUSEMOVE,
            mouseup: EVENT_NAMES.EDGE_MOUSEUP,
            mousewheel: EVENT_NAMES.EDGE_MOUSEWHEEL,
            mouseenter: EVENT_NAMES.EDGE_MOUSEENTER,
            mouseleave: EVENT_NAMES.EDGE_MOUSELEAVE,
        };
    }
}

export default Edge;
