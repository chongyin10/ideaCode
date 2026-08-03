import { Cell, CellOptions, CellData, type CellEvent } from './Cell';
import { Shape, ShapeConfig } from './Shape';
import { EVENT_NAMES } from './EventManager';

/**
 * Port 事件对象接口
 */
export interface PortEvent extends CellEvent {
    /** Port 实例 */
    port: Port;
    /** 所属节点 ID */
    nodeId: string;
    /** Port ID */
    portId: string;
}

/**
 * 连接桩位置类型
 */
export type PortPosition = 'top' | 'right' | 'bottom' | 'left' | 'center' | { x: number; y: number };

/**
 * 连接桩样式接口
 */
export interface PortStyle {
    /** 连接桩宽度/直径 */
    width: number;
    /** 连接桩高度（用于非圆形） */
    height: number;
    /** 填充颜色 */
    fillColor: string;
    /** 边框颜色 */
    strokeColor: string;
    /** 边框宽度 */
    strokeWidth: number;
    /** 悬停填充颜色 */
    hoverFillColor: string;
    /** 悬停边框颜色 */
    hoverStrokeColor: string;
    /** 选中填充颜色 */
    selectedFillColor: string;
    /** 选中边框颜色 */
    selectedStrokeColor: string;
    /** 背景色（用于透明连接桩） */
    backgroundColor: string;
    /** 吸附距离（像素），当鼠标靠近此距离时自动吸附到连接桩 */
    snapDistance: number;
}

/**
 * 连接桩数据接口
 */
export interface PortData extends CellData {
    nodeId: string;
    position: PortPosition;
}

/**
 * 连接桩配置选项
 */
export interface PortOptions extends CellOptions {
    /** 所属节点ID */
    nodeId: string;
    /** 连接桩位置 */
    position: PortPosition;
    /** 是否可见（false 表示直接连接到节点边缘，不显示连接桩图形） */
    visible?: boolean;
    /** 连接桩样式 */
    style?: Partial<PortStyle>;
    /** 形状配置 */
    shape?: Shape | ShapeConfig;
    /** 连接桩旁边显示的标签（位于连接桩外侧） */
    lable?: string;
    /** 连接桩标签的方位：'inside'内侧, 'outside'外侧, 'top'上面, 'bottom'下面。默认为'outside' */
    lablePosition?: 'inside' | 'outside' | 'top' | 'bottom';
    /** 吸附距离（像素），当鼠标靠近此距离时自动吸附到连接桩 */
    snapDistance?: number;
}

/**
 * 连接桩布局配置
 */
export interface PortLayoutConfig {
    /** 最小间距 */
    minSpacing: number;
    /** 最大间距 */
    maxSpacing: number;
    /** 距离边缘的偏移量 */
    edgeOffset: number;
    /** 是否均匀分布 */
    distributeEvenly: boolean;
}

/**
 * 连接桩组配置 - 用于批量添加同一侧的连接桩
 */
export interface PortGroupOptions {
    /** 组ID */
    id: string;
    /** 位置 */
    position: 'top' | 'right' | 'bottom' | 'left';
    /** 连接桩数量 */
    count: number;
    /** 自定义每个连接桩的配置 */
    portConfig?: Partial<PortOptions> | ((index: number) => Partial<PortOptions>);
    /** 布局配置 */
    layout?: Partial<PortLayoutConfig>;
}

/**
 * 端口布局信息
 */
interface PortLayoutInfo {
    port: Port;
    position: 'top' | 'right' | 'bottom' | 'left';
    index: number;
    total: number;
}

/**
 * 默认布局配置
 */
const DEFAULT_LAYOUT_CONFIG: PortLayoutConfig = {
    minSpacing: 24,
    maxSpacing: 60,
    edgeOffset: 8,
    distributeEvenly: true,
};

/**
 * Port - 连接桩类
 *
 * 连接桩是节点边缘的连接点，用于边与节点的连接：
 * - 支持预设位置（top/right/bottom/left/center）
 * - 支持自定义坐标位置
 * - 支持自定义样式（颜色、大小、边框）
 * - 支持自定义形状（圆形、矩形等）
 * - 支持隐藏（直接连接到节点边缘）
 * - 支持悬停和选中状态
 */
export class Port extends Cell {
    private nodeId: string;
    private position: PortPosition;
    private portVisible: boolean;
    private style: PortStyle;
    private shapeConfig: ShapeConfig;
    private portLabel?: string;
    private portLabelPosition: 'inside' | 'outside' | 'top' | 'bottom';

    // 默认样式
    private static readonly DEFAULT_STYLE: PortStyle = {
        width: 8,
        height: 8,
        fillColor: '#ffffff',
        strokeColor: '#64748b',
        strokeWidth: 2,
        hoverFillColor: '#e2e8f0',
        hoverStrokeColor: '#3b82f6',
        selectedFillColor: '#dbeafe',
        selectedStrokeColor: '#3b82f6',
        backgroundColor: 'transparent',
        snapDistance: 20,
    };

    /**
     * CSS 样式字符串
     */
    static readonly CSS_STYLES = `
        ${Cell.BASE_CSS_STYLES}
        
        .port {
            cursor: crosshair;
            transition: all 0.2s ease;
        }
        
        .port:hover {
            transform: scale(1.2);
        }
        
        .port.hidden {
            display: none;
        }
    `;

    constructor(options: PortOptions) {
        super(options);
        this.nodeId = options.nodeId;
        this.position = options.position;
        this.portVisible = options.visible !== false; // 默认可见
        this.style = { ...Port.DEFAULT_STYLE, ...options.style };
        this.portLabel = options.lable;
        this.portLabelPosition = options.lablePosition || 'outside';

        // 解析形状配置
        if (options.shape) {
            if (typeof options.shape === 'string') {
                this.shapeConfig = { type: options.shape as Shape };
            } else {
                this.shapeConfig = options.shape;
            }
        } else {
            this.shapeConfig = { type: Shape.Circle };
        }
    }

    /**
     * 获取所属节点ID
     */
    getNodeId(): string {
        return this.nodeId;
    }

    /**
     * 获取连接桩位置配置
     */
    getPosition(): PortPosition {
        return this.position;
    }

    /**
     * 设置连接桩位置
     */
    setPosition(position: PortPosition): void {
        this.position = position;
    }

    /**
     * 获取可见性状态
     */
    getVisible(): boolean {
        return this.portVisible;
    }

    /**
     * 设置可见性
     */
    setVisible(visible: boolean): void {
        this.portVisible = visible;
    }

    /**
     * 是否可见（Port 特有，用于端口可见性）
     */
    isPortVisible(): boolean {
        return this.portVisible;
    }

    /**
     * 获取连接桩标签
     */
    getPortLabel(): string | undefined {
        return this.portLabel;
    }

    /**
     * 设置连接桩标签
     */
    setPortLabel(label: string | undefined): void {
        this.portLabel = label;
    }

    /**
     * 获取连接桩标签方位
     */
    getPortLabelPosition(): 'inside' | 'outside' | 'top' | 'bottom' {
        return this.portLabelPosition;
    }

    /**
     * 设置连接桩标签方位
     */
    setPortLabelPosition(position: 'inside' | 'outside' | 'top' | 'bottom'): void {
        this.portLabelPosition = position;
    }

    /**
     * 获取样式
     */
    getStyle(): PortStyle {
        return { ...this.style };
    }

    /**
     * 更新样式
     */
    updateStyle(style: Partial<PortStyle>): void {
        this.style = { ...this.style, ...style };
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
     * 获取吸附距离
     */
    getSnapDistance(): number {
        return this.style.snapDistance ?? Port.DEFAULT_STYLE.snapDistance;
    }

    /**
     * 设置吸附距离
     */
    setSnapDistance(distance: number): void {
        this.style.snapDistance = distance;
    }

    /**
     * 计算连接桩在世界坐标系中的实际位置
     * @param nodeX - 节点中心 X 坐标
     * @param nodeY - 节点中心 Y 坐标
     * @param nodeWidth - 节点宽度
     * @param nodeHeight - 节点高度
     */
    calculatePosition(
        nodeX: number,
        nodeY: number,
        nodeWidth: number,
        nodeHeight: number
    ): { x: number; y: number } {
        const halfWidth = nodeWidth / 2;
        const halfHeight = nodeHeight / 2;

        if (typeof this.position === 'object' && 'x' in this.position) {
            // 自定义坐标位置（相对于节点中心的偏移）
            return {
                x: nodeX + this.position.x,
                y: nodeY + this.position.y,
            };
        }

        // 预设位置
        switch (this.position) {
            case 'top':
                return { x: nodeX, y: nodeY - halfHeight };
            case 'right':
                return { x: nodeX + halfWidth, y: nodeY };
            case 'bottom':
                return { x: nodeX, y: nodeY + halfHeight };
            case 'left':
                return { x: nodeX - halfWidth, y: nodeY };
            case 'center':
            default:
                return { x: nodeX, y: nodeY };
        }
    }

    /**
     * 计算点到连接桩的距离
     * @param point - 要计算的点
     * @param nodeX - 节点中心 X 坐标
     * @param nodeY - 节点中心 Y 坐标
     * @param nodeWidth - 节点宽度
     * @param nodeHeight - 节点高度
     * @returns 点到连接桩的距离
     */
    getDistanceToPoint(
        point: { x: number; y: number },
        nodeX: number,
        nodeY: number,
        nodeWidth: number,
        nodeHeight: number
    ): number {
        const portPos = this.calculatePosition(nodeX, nodeY, nodeWidth, nodeHeight);
        const dx = point.x - portPos.x;
        const dy = point.y - portPos.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    /**
     * 检查点是否在吸附范围内
     * @param point - 要检查的点
     * @param nodeX - 节点中心 X 坐标
     * @param nodeY - 节点中心 Y 坐标
     * @param nodeWidth - 节点宽度
     * @param nodeHeight - 节点高度
     * @returns 是否在吸附范围内
     */
    isInSnapRange(
        point: { x: number; y: number },
        nodeX: number,
        nodeY: number,
        nodeWidth: number,
        nodeHeight: number
    ): boolean {
        return this.getDistanceToPoint(point, nodeX, nodeY, nodeWidth, nodeHeight) <= this.getSnapDistance();
    }

    /**
     * 获取当前填充颜色
     */
    private getFillColor(): string {
        if (this.isSelected) return this.style.selectedFillColor;
        if (this.isHovered) return this.style.hoverFillColor;
        return this.style.fillColor;
    }

    /**
     * 获取当前边框颜色
     */
    private getStrokeColor(): string {
        if (this.isSelected) return this.style.selectedStrokeColor;
        if (this.isHovered) return this.style.hoverStrokeColor;
        return this.style.strokeColor;
    }

    /**
     * 绘制连接桩
     * @param ctx - Canvas 2D 上下文
     * @param nodeX - 节点中心 X 坐标
     * @param nodeY - 节点中心 Y 坐标
     * @param nodeWidth - 节点宽度
     * @param nodeHeight - 节点高度
     */
    draw(
        ctx: CanvasRenderingContext2D,
        nodeX: number,
        nodeY: number,
        nodeWidth: number,
        nodeHeight: number
    ): void {
        if (!this.portVisible) return;

        const pos = this.calculatePosition(nodeX, nodeY, nodeWidth, nodeHeight);

        ctx.save();

        // 绘制背景（如果设置）
        if (this.style.backgroundColor !== 'transparent') {
            ctx.fillStyle = this.style.backgroundColor;
            ctx.fillRect(
                pos.x - this.style.width / 2 - 2,
                pos.y - this.style.height / 2 - 2,
                this.style.width + 4,
                this.style.height + 4
            );
        }

        // 根据形状绘制
        ctx.beginPath();
        switch (this.shapeConfig.type) {
            case Shape.Rect:
                this.drawRect(ctx, pos.x, pos.y);
                break;
            case Shape.Circle:
            default:
                this.drawCircle(ctx, pos.x, pos.y);
                break;
        }

        // 填充
        ctx.fillStyle = this.getFillColor();
        ctx.fill();

        // 边框
        ctx.strokeStyle = this.getStrokeColor();
        ctx.lineWidth = this.style.strokeWidth;
        ctx.stroke();

        ctx.restore();
    }

    /**
     * 绘制圆形连接桩
     */
    private drawCircle(ctx: CanvasRenderingContext2D, x: number, y: number): void {
        const radius = Math.min(this.style.width, this.style.height) / 2;
        ctx.arc(x, y, radius, 0, Math.PI * 2);
    }

    /**
     * 绘制矩形连接桩
     */
    private drawRect(ctx: CanvasRenderingContext2D, x: number, y: number): void {
        const halfWidth = this.style.width / 2;
        const halfHeight = this.style.height / 2;
        ctx.rect(x - halfWidth, y - halfHeight, this.style.width, this.style.height);
    }

    /**
     * 检查点是否在连接桩内
     * @param point - 要检查的点
     * @param nodeX - 节点中心 X 坐标
     * @param nodeY - 节点中心 Y 坐标
     * @param nodeWidth - 节点宽度
     * @param nodeHeight - 节点高度
     */
    containsPoint(
        point: { x: number; y: number },
        nodeX: number,
        nodeY: number,
        nodeWidth: number,
        nodeHeight: number
    ): boolean {
        if (!this.portVisible) return false;

        const pos = this.calculatePosition(nodeX, nodeY, nodeWidth, nodeHeight);

        switch (this.shapeConfig.type) {
            case Shape.Rect:
                return (
                    point.x >= pos.x - this.style.width / 2 &&
                    point.x <= pos.x + this.style.width / 2 &&
                    point.y >= pos.y - this.style.height / 2 &&
                    point.y <= pos.y + this.style.height / 2
                );
            case Shape.Circle:
            default: {
                const radius = Math.min(this.style.width, this.style.height) / 2;
                const dx = point.x - pos.x;
                const dy = point.y - pos.y;
                return dx * dx + dy * dy <= radius * radius;
            }
        }
    }

    /**
     * 获取连接点坐标（供边使用）
     * @param nodeX - 节点中心 X 坐标
     * @param nodeY - 节点中心 Y 坐标
     * @param nodeWidth - 节点宽度
     * @param nodeHeight - 节点高度
     */
    getConnectionPoint(
        nodeX: number,
        nodeY: number,
        nodeWidth: number,
        nodeHeight: number
    ): { x: number; y: number } {
        return this.calculatePosition(nodeX, nodeY, nodeWidth, nodeHeight);
    }

    /**
     * 序列化为 JSON
     */
    toJSON(): PortData {
        return {
            id: this.id,
            label: this.label,
            nodeId: this.nodeId,
            position: this.position,
            data: { ...this.data },
        };
    }

    /**
     * 从 JSON 创建连接桩
     */
    static fromJSON(data: PortData): Port {
        return new Port({
            id: data.id,
            nodeId: data.nodeId,
            position: data.position,
            label: data.label,
            data: data.data,
        });
    }

    /**
     * 克隆连接桩
     */
    clone(newId?: string): Port {
        return new Port({
            id: newId || `${this.id}_clone`,
            nodeId: this.nodeId,
            position: this.position,
            visible: this.portVisible,
            style: { ...this.style },
            shape: { ...this.shapeConfig },
            label: this.label,
            data: { ...this.data },
        });
    }

    // ==================== 事件处理 ====================

    /**
     * 触发 Port 相关事件
     * @param eventType - 事件类型（click, dblclick, contextmenu, mousedown, mousemove, mouseup, mouseenter, mouseleave）
     * @param originalEvent - 原始 DOM 事件
     * @param extraData - 额外的事件数据
     * @returns 是否未阻止默认行为
     */
    triggerPortEvent(
        eventType: string,
        originalEvent: Event,
        extraData: Partial<PortEvent> = {}
    ): boolean {
        const portEventName = `node:port:${eventType}`;

        // 创建事件对象
        const eventData = this.createPortEvent(originalEvent, extraData);

        // 触发连接桩事件
        return this.emit(portEventName, eventData);
    }

    /**
     * 创建 Port 事件对象
     */
    protected createPortEvent(
        originalEvent: Event,
        extraData: Partial<PortEvent> = {}
    ): PortEvent {
        const baseEvent = this.createCellEvent(originalEvent, extraData);

        return {
            ...baseEvent,
            type: 'port',
            target: this,
            port: this,
            portId: this.id,
            nodeId: this.nodeId,
            ...extraData,
        } as PortEvent;
    }

    /**
     * 获取事件名称映射
     * 注意：Port 使用 node:port:xxx 前缀
     */
    protected override getEventNameMap(): Record<string, string> {
        return {
            click: EVENT_NAMES.PORT_CLICK,
            dblclick: EVENT_NAMES.PORT_DBLCLICK,
            contextmenu: EVENT_NAMES.PORT_CONTEXTMENU,
            mousedown: EVENT_NAMES.PORT_MOUSEDOWN,
            mousemove: EVENT_NAMES.PORT_MOUSEMOVE,
            mouseup: EVENT_NAMES.PORT_MOUSEUP,
            mouseenter: EVENT_NAMES.PORT_MOUSEENTER,
            mouseleave: EVENT_NAMES.PORT_MOUSELEAVE,
        };
    }
}

/**
 * PortManager - 连接桩管理器
 *
 * 负责管理节点上多个连接桩的自适应布局：
 * - 支持同一侧（top/right/bottom/left）多个连接桩
 * - 自动计算连接桩之间的间距
 * - 支持均匀分布或紧凑布局
 * - 支持批量添加连接桩组
 * - 当节点大小变化时自动重新布局
 *
 * @example
 * ```typescript
 * // 批量添加顶部连接桩
 * node.addPortGroup({
 *     id: 'top-ports',
 *     position: 'top',
 *     count: 3
 * });
 *
 * // 自定义每个连接桩
 * node.addPortGroup({
 *     id: 'right-ports',
 *     position: 'right',
 *     count: 4,
 *     portConfig: (index) => ({
 *         id: `port-${index}`,
 *         label: `输出 ${index + 1}`,
 *         style: { fillColor: index === 0 ? '#3b82f6' : '#ffffff' }
 *     })
 * });
 * ```
 */
export class PortManager {
    private nodeId: string;
    private nodeWidth: number;
    private nodeHeight: number;
    private ports: Map<string, Port> = new Map();
    private portGroups: Map<string, PortGroupOptions> = new Map();
    private portLayouts: Map<string, PortLayoutInfo> = new Map();
    private layoutConfigs: Map<string, PortLayoutConfig> = new Map();

    constructor(nodeId: string, nodeWidth: number, nodeHeight: number) {
        this.nodeId = nodeId;
        this.nodeWidth = nodeWidth;
        this.nodeHeight = nodeHeight;
    }

    /**
     * 更新节点尺寸（当节点大小变化时调用）
     */
    updateNodeSize(width: number, height: number): void {
        this.nodeWidth = width;
        this.nodeHeight = height;
        this.recalculateAllLayouts();
    }

    /**
     * 获取所有连接桩
     */
    getAllPorts(): Port[] {
        return Array.from(this.ports.values());
    }

    /**
     * 获取连接桩
     */
    getPort(portId: string): Port | undefined {
        return this.ports.get(portId);
    }

    /**
     * 检查是否存在连接桩
     */
    hasPort(portId: string): boolean {
        return this.ports.has(portId);
    }

    /**
     * 移除连接桩
     */
    removePort(portId: string): boolean {
        const port = this.ports.get(portId);
        if (!port) return false;

        this.ports.delete(portId);
        this.portLayouts.delete(portId);

        // 重新计算受影响的分组布局
        this.recalculateAllLayouts();
        return true;
    }

    /**
     * 清除所有连接桩
     */
    clearPorts(): void {
        this.ports.clear();
        this.portGroups.clear();
        this.portLayouts.clear();
        this.layoutConfigs.clear();
    }

    /**
     * 获取某侧的所有连接桩
     */
    getPortsBySide(position: 'top' | 'right' | 'bottom' | 'left'): Port[] {
        const result: Port[] = [];
        this.portLayouts.forEach((layout, portId) => {
            if (layout.position === position) {
                const port = this.ports.get(portId);
                if (port) result.push(port);
            }
        });
        return result.sort((a, b) => {
            const layoutA = this.portLayouts.get(a.getId())!;
            const layoutB = this.portLayouts.get(b.getId())!;
            return layoutA.index - layoutB.index;
        });
    }

    /**
     * 添加单个连接桩（使用自适应布局）
     * @param options - 连接桩配置
     * @param layoutConfig - 可选的布局配置
     * @returns 创建的连接桩
     */
    addPort(
        options: Omit<PortOptions, 'nodeId'>,
        layoutConfig?: Partial<PortLayoutConfig>
    ): Port {
        const port = new Port({
            ...options,
            nodeId: this.nodeId,
        });

        this.ports.set(port.getId(), port);

        // 如果位置是预设的边侧位置，则进行自适应布局
        if (typeof options.position === 'string' &&
            ['top', 'right', 'bottom', 'left'].includes(options.position)) {
            this.addPortToSide(port, options.position as 'top' | 'right' | 'bottom' | 'left', layoutConfig);
        }

        return port;
    }

    /**
     * 批量添加连接桩组
     * @param groupOptions - 连接桩组配置
     * @returns 创建的连接桩数组
     */
    addPortGroup(groupOptions: PortGroupOptions): Port[] {
        const { id, position, count, portConfig, layout } = groupOptions;

        if (count <= 0) return [];

        // 保存组配置
        this.portGroups.set(id, groupOptions);

        // 合并布局配置
        const layoutConfig: PortLayoutConfig = {
            ...DEFAULT_LAYOUT_CONFIG,
            ...layout,
        };
        this.layoutConfigs.set(id, layoutConfig);

        const ports: Port[] = [];

        for (let i = 0; i < count; i++) {
            // 生成连接桩配置
            let individualConfig: Partial<PortOptions> = {};
            if (typeof portConfig === 'function') {
                individualConfig = portConfig(i);
            } else if (portConfig) {
                individualConfig = { ...portConfig };
            }

            // 创建连接桩（暂不设置位置，稍后统一计算）
            const portId = individualConfig.id || `${id}-${i}`;
            const port = new Port({
                ...individualConfig,
                id: portId,
                nodeId: this.nodeId,
                position: position, // 临时位置，会被重新计算
            });

            this.ports.set(portId, port);
            ports.push(port);
        }

        // 计算该组连接桩的布局
        this.calculateGroupLayout(id, position, ports, layoutConfig);

        return ports;
    }

    /**
     * 更新连接桩组
     * @param groupId - 组ID
     * @param newCount - 新的连接桩数量
     * @returns 是否更新成功
     */
    updatePortGroup(groupId: string, newCount: number): boolean {
        const group = this.portGroups.get(groupId);
        if (!group) return false;

        const currentPorts = this.getPortsBySide(group.position)
            .filter(port => port.getId().startsWith(groupId));

        const currentCount = currentPorts.length;

        if (newCount > currentCount) {
            // 需要添加连接桩
            for (let i = currentCount; i < newCount; i++) {
                let individualConfig: Partial<PortOptions> = {};
                if (typeof group.portConfig === 'function') {
                    individualConfig = group.portConfig(i);
                } else if (group.portConfig) {
                    individualConfig = { ...group.portConfig };
                }

                const portId = individualConfig.id || `${groupId}-${i}`;
                const port = new Port({
                    ...individualConfig,
                    id: portId,
                    nodeId: this.nodeId,
                    position: group.position,
                });

                this.ports.set(portId, port);
            }
        } else if (newCount < currentCount) {
            // 需要移除连接桩
            for (let i = newCount; i < currentCount; i++) {
                const portId = `${groupId}-${i}`;
                this.ports.delete(portId);
                this.portLayouts.delete(portId);
            }
        }

        // 更新组配置
        group.count = newCount;
        this.portGroups.set(groupId, group);

        // 重新计算布局
        this.recalculateAllLayouts();
        return true;
    }

    /**
     * 移除连接桩组
     * @param groupId - 组ID
     * @returns 是否成功移除
     */
    removePortGroup(groupId: string): boolean {
        const group = this.portGroups.get(groupId);
        if (!group) return false;

        // 移除该组的所有连接桩
        for (let i = 0; i < group.count; i++) {
            const portId = `${groupId}-${i}`;
            this.ports.delete(portId);
            this.portLayouts.delete(portId);
        }

        this.portGroups.delete(groupId);
        this.layoutConfigs.delete(groupId);

        // 重新计算剩余连接桩的布局
        this.recalculateAllLayouts();
        return true;
    }

    /**
     * 将连接桩添加到指定边侧
     */
    private addPortToSide(
        port: Port,
        position: 'top' | 'right' | 'bottom' | 'left',
        layoutConfig?: Partial<PortLayoutConfig>
    ): void {
        const config: PortLayoutConfig = {
            ...DEFAULT_LAYOUT_CONFIG,
            ...layoutConfig,
        };

        // 获取该侧当前所有连接桩
        const sidePorts = this.getPortsBySide(position);
        const total = sidePorts.length + 1;
        const newIndex = sidePorts.length;

        // 记录布局信息
        this.portLayouts.set(port.getId(), {
            port,
            position,
            index: newIndex,
            total,
        });

        // 重新计算该侧所有连接桩的位置
        this.recalculateSideLayout(position, config);
    }

    /**
     * 计算连接桩组的布局
     */
    private calculateGroupLayout(
        _groupId: string,
        position: 'top' | 'right' | 'bottom' | 'left',
        ports: Port[],
        config: PortLayoutConfig
    ): void {
        const total = ports.length;

        // 记录每个连接桩的布局信息
        ports.forEach((port, index) => {
            this.portLayouts.set(port.getId(), {
                port,
                position,
                index,
                total,
            });
        });

        // 计算位置
        this.recalculateSideLayout(position, config);
    }

    /**
     * 重新计算所有布局
     */
    private recalculateAllLayouts(): void {
        const sides: ('top' | 'right' | 'bottom' | 'left')[] = ['top', 'right', 'bottom', 'left'];

        sides.forEach(side => {
            const ports = this.getPortsBySide(side);
            if (ports.length > 0) {
                // 使用第一个连接桩所属分组的布局配置，或默认配置
                const firstPortId = ports[0].getId();
                let config = DEFAULT_LAYOUT_CONFIG;

                // 查找该连接桩属于哪个组
                for (const [groupId] of this.portGroups) {
                    if (firstPortId.startsWith(groupId)) {
                        config = this.layoutConfigs.get(groupId) || DEFAULT_LAYOUT_CONFIG;
                        break;
                    }
                }

                this.recalculateSideLayout(side, config);
            }
        });
    }

    /**
     * 重新计算指定边侧的布局
     */
    private recalculateSideLayout(
        position: 'top' | 'right' | 'bottom' | 'left',
        config: PortLayoutConfig
    ): void {
        const ports = this.getPortsBySide(position);
        if (ports.length === 0) return;

        if (ports.length === 1) {
            // 只有一个连接桩，居中放置
            this.setPortPosition(ports[0], position, 0.5);
            return;
        }

        // 获取可用空间
        const availableSpace = this.getAvailableSpace(position, config.edgeOffset);

        if (config.distributeEvenly) {
            // 均匀分布
            this.distributeEvenly(ports, position, availableSpace, config);
        } else {
            // 紧凑布局
            this.distributeCompact(ports, position, availableSpace, config);
        }
    }

    /**
     * 获取可用空间大小
     */
    private getAvailableSpace(
        position: 'top' | 'right' | 'bottom' | 'left',
        edgeOffset: number
    ): number {
        switch (position) {
            case 'top':
            case 'bottom':
                return this.nodeWidth - edgeOffset * 2;
            case 'right':
            case 'left':
                return this.nodeHeight - edgeOffset * 2;
        }
    }

    /**
     * 均匀分布连接桩
     */
    private distributeEvenly(
        ports: Port[],
        position: 'top' | 'right' | 'bottom' | 'left',
        _availableSpace: number,
        _config: PortLayoutConfig
    ): void {
        const count = ports.length;

        ports.forEach((port, index) => {
            const ratio = (index + 1) / (count + 1);
            this.setPortPosition(port, position, ratio);
        });
    }

    /**
     * 紧凑分布连接桩
     */
    private distributeCompact(
        ports: Port[],
        position: 'top' | 'right' | 'bottom' | 'left',
        availableSpace: number,
        config: PortLayoutConfig
    ): void {
        const count = ports.length;

        // 计算需要的总空间
        const totalMinSpace = (count - 1) * config.minSpacing;

        if (totalMinSpace <= availableSpace) {
            // 空间充足，可以按最小间距分布
            const extraSpace = availableSpace - totalMinSpace;
            const startOffset = extraSpace / 2;

            ports.forEach((port, index) => {
                const offset = startOffset + index * config.minSpacing;
                const ratio = this.offsetToRatio(position, offset, availableSpace);
                this.setPortPosition(port, position, ratio);
            });
        } else {
            // 空间不足，使用最大间距或压缩
            const spacing = Math.max(
                availableSpace / (count - 1),
                availableSpace / count
            );

            ports.forEach((port, index) => {
                if (count === 1) {
                    this.setPortPosition(port, position, 0.5);
                } else {
                    const offset = index * spacing;
                    const ratio = this.offsetToRatio(position, offset, availableSpace);
                    this.setPortPosition(port, position, ratio);
                }
            });
        }
    }

    /**
     * 将偏移量转换为比例
     */
    private offsetToRatio(
        position: 'top' | 'right' | 'bottom' | 'left',
        offset: number,
        availableSpace: number
    ): number {
        const edgeOffset = (position === 'top' || position === 'bottom')
            ? (this.nodeWidth - availableSpace) / 2
            : (this.nodeHeight - availableSpace) / 2;
        return (offset + edgeOffset) / (availableSpace + edgeOffset * 2);
    }

    /**
     * 设置连接桩位置
     * @param port - 连接桩
     * @param position - 边侧位置
     * @param ratio - 在边侧上的比例位置 (0-1)
     */
    private setPortPosition(
        port: Port,
        position: 'top' | 'right' | 'bottom' | 'left',
        ratio: number
    ): void {
        let x: number, y: number;
        const halfWidth = this.nodeWidth / 2;
        const halfHeight = this.nodeHeight / 2;

        switch (position) {
            case 'top':
                // 从左到右: -halfWidth 到 +halfWidth
                x = -halfWidth + ratio * this.nodeWidth;
                y = -halfHeight;
                break;
            case 'bottom':
                // 从左到右: -halfWidth 到 +halfWidth
                x = -halfWidth + ratio * this.nodeWidth;
                y = halfHeight;
                break;
            case 'left':
                // 从上到下: -halfHeight 到 +halfHeight
                x = -halfWidth;
                y = -halfHeight + ratio * this.nodeHeight;
                break;
            case 'right':
                // 从上到下: -halfHeight 到 +halfHeight
                x = halfWidth;
                y = -halfHeight + ratio * this.nodeHeight;
                break;
        }

        // 更新连接桩位置为相对于节点中心的偏移
        port.setPosition({ x, y });
    }

    /**
     * 获取某侧连接桩的数量
     */
    getPortCountBySide(position: 'top' | 'right' | 'bottom' | 'left'): number {
        return this.getPortsBySide(position).length;
    }

    /**
     * 获取所有连接桩组ID
     */
    getPortGroupIds(): string[] {
        return Array.from(this.portGroups.keys());
    }

    /**
     * 获取连接桩组信息
     */
    getPortGroup(groupId: string): PortGroupOptions | undefined {
        return this.portGroups.get(groupId);
    }

    /**
     * 设置某侧的布局配置
     */
    setSideLayoutConfig(
        position: 'top' | 'right' | 'bottom' | 'left',
        config: Partial<PortLayoutConfig>
    ): void {
        const sideKey = `__side_${position}`;
        this.layoutConfigs.set(sideKey, { ...DEFAULT_LAYOUT_CONFIG, ...config });
        this.recalculateSideLayout(position, this.layoutConfigs.get(sideKey)!);
    }
}

export default Port;
