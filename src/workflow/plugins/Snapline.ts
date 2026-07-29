import { Graph } from '../core/Graph';
import { Node } from '../core/Node';
import { type EventHandler } from '../core/EventManager';

/**
 * 对齐线类型
 */
export type SnaplineType = 'horizontal' | 'vertical';

/**
 * 对齐线数据
 */
export interface SnaplineData {
    /** 对齐线类型 */
    type: SnaplineType;
    /** 对齐线位置坐标 */
    position: number;
    /** 起始点 */
    start: number;
    /** 结束点 */
    end: number;
}

/**
 * 对齐点信息
 */
export interface SnapPoint {
    /** 对齐线类型 */
    type: SnaplineType;
    /** 对齐位置 */
    position: number;
    /** 偏移量 */
    offset: number;
}

/**
 * Snapline 配置选项
 */
export interface SnaplineOptions {
    /** 是否启用对齐线 */
    enabled?: boolean;
    /** 对齐容差（像素） */
    tolerance?: number;
    /** 对齐线颜色 */
    lineColor?: string;
    /** 对齐线宽度 */
    lineWidth?: number;
    /** 对齐线样式 */
    lineDash?: number[];
    /** 是否显示居中对齐线 */
    showCenter?: boolean;
    /** 是否显示边缘对齐线 */
    showEdge?: boolean;
    /** 对齐时是否吸附 */
    snap?: boolean;
    /** 吸附强度（像素） */
    snapStrength?: number;
    /** 对齐线过滤函数，返回 false 则不显示该对齐线 */
    filter?: (snapline: SnaplineData) => boolean;
    /** 对齐线显示回调 */
    onSnaplineShow?: (snaplines: SnaplineData[]) => void;
    /** 对齐线隐藏回调 */
    onSnaplineHide?: () => void;
}

/**
 * 节点对齐信息
 */
interface NodeAlignmentInfo {
    /** 左边缘 X 坐标 */
    left: number;
    /** 水平中心 X 坐标 */
    centerX: number;
    /** 右边缘 X 坐标 */
    right: number;
    /** 上边缘 Y 坐标 */
    top: number;
    /** 垂直中心 Y 坐标 */
    centerY: number;
    /** 下边缘 Y 坐标 */
    bottom: number;
}

/**
 * 插件接口
 */
export interface Plugin {
    /** 插件名称 */
    name: string;
    /** 安装插件 */
    install(graph: Graph): void;
    /** 卸载插件 */
    uninstall(): void;
}

/**
 * Snapline - 对齐线插件
 *
 * 在移动节点时显示对齐辅助线，帮助用户对齐节点：
 * - 水平对齐线（顶部、居中、底部）
 * - 垂直对齐线（左侧、居中、右侧）
 * - 自动吸附功能
 *
 * 使用示例：
 * ```typescript
 * const snapline = new Snapline({
 *     enabled: true,
 *     tolerance: 10,
 *     lineColor: '#3b82f6',
 *     snap: true,
 * });
 * graph.use(snapline);
 * ```
 */
export class Snapline implements Plugin {
    readonly name = 'Snapline';
    
    private graph: Graph | null = null;
    private options: Required<SnaplineOptions>;
    private snaplines: SnaplineData[] = [];
    private isActive: boolean = false;
    private canvas: HTMLCanvasElement | null = null;
    private ctx: CanvasRenderingContext2D | null = null;
    private cleanupFns: (() => void)[] = [];
    
    // 默认配置
    private static readonly DEFAULT_OPTIONS: Required<SnaplineOptions> = {
        enabled: true,
        tolerance: 10,
        lineColor: '#3b82f6',
        lineWidth: 1,
        lineDash: [4, 4],
        showCenter: true,
        showEdge: true,
        snap: false,
        snapStrength: 5,
        filter: () => true,
        onSnaplineShow: () => {},
        onSnaplineHide: () => {},
    };
    
    constructor(options: SnaplineOptions = {}) {
        this.options = { ...Snapline.DEFAULT_OPTIONS, ...options } as Required<SnaplineOptions>;
    }
    
    /**
     * 安装插件
     */
    install(graph: Graph): void {
        this.graph = graph;
        this.createCanvas();
        this.bindEvents();
    }
    
    /**
     * 卸载插件
     */
    uninstall(): void {
        this.hideSnaplines();
        this.unbindEvents();
        this.removeCanvas();
        this.graph = null;
    }
    
    /**
     * 更新配置
     */
    setOptions(options: Partial<SnaplineOptions>): void {
        this.options = { ...this.options, ...options } as Required<SnaplineOptions>;
    }
    
    /**
     * 获取当前配置
     */
    getOptions(): Required<SnaplineOptions> {
        return { ...this.options };
    }
    
    /**
     * 启用对齐线
     */
    enable(): void {
        this.options.enabled = true;
    }
    
    /**
     * 禁用对齐线
     */
    disable(): void {
        this.options.enabled = false;
        this.hideSnaplines();
    }
    
    /**
     * 是否已启用
     */
    isEnabled(): boolean {
        return this.options.enabled;
    }
    
    /**
     * 创建对齐线绘制层
     */
    private createCanvas(): void {
        if (!this.graph) return;
        
        // 获取 Graph 的容器
        const container = this.graph['container'];
        
        // 创建对齐线 Canvas
        this.canvas = document.createElement('canvas');
        this.canvas.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            pointer-events: none;
            z-index: 1000;
        `;
        this.canvas.className = 'snapline-canvas';
        
        // 获取 2D 上下文
        this.ctx = this.canvas.getContext('2d');
        
        // 插入到容器中
        container.appendChild(this.canvas);
        
        // 监听容器尺寸变化
        this.resizeCanvas();
        const resizeObserver = new ResizeObserver(() => {
            this.resizeCanvas();
        });
        resizeObserver.observe(container);
        this.cleanupFns.push(() => resizeObserver.disconnect());
    }
    
    /**
     * 调整 Canvas 尺寸
     */
    private resizeCanvas(): void {
        if (!this.canvas || !this.graph) return;
        
        const container = this.graph['container'];
        const rect = container.getBoundingClientRect();
        
        this.canvas.width = rect.width;
        this.canvas.height = rect.height;
        this.canvas.style.width = `${rect.width}px`;
        this.canvas.style.height = `${rect.height}px`;
        
        // 如果有活动的对齐线，重新绘制
        if (this.isActive) {
            this.drawSnaplines();
        }
    }
    
    /**
     * 移除对齐线绘制层
     */
    private removeCanvas(): void {
        if (this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
        this.canvas = null;
        this.ctx = null;
    }
    
    /**
     * 绑定事件
     */
    private bindEvents(): void {
        if (!this.graph) return;
        
        // 监听节点拖拽开始
        const onDragStart: EventHandler = () => {
            if (!this.options.enabled) return;
            this.isActive = true;
        };
        
        // 监听节点拖拽
        const onDrag: EventHandler = (e) => {
            if (!this.options.enabled || !this.isActive) return;
            
            const draggedNode = e.node;
            if (!draggedNode) return;
            
            // 计算并显示对齐线
            this.calculateAndShowSnaplines(draggedNode);
        };
        
        // 监听节点拖拽结束
        const onDragEnd: EventHandler = () => {
            this.isActive = false;
            this.hideSnaplines();
        };
        
        this.graph.on('node:dragstart', onDragStart);
        this.graph.on('node:drag', onDrag);
        this.graph.on('node:dragend', onDragEnd);
        
        this.cleanupFns.push(
            () => {
                if (this.graph) {
                    this.graph['eventManager'].off('node:dragstart', onDragStart);
                    this.graph['eventManager'].off('node:drag', onDrag);
                    this.graph['eventManager'].off('node:dragend', onDragEnd);
                }
            }
        );
    }
    
    /**
     * 解绑事件
     */
    private unbindEvents(): void {
        this.cleanupFns.forEach(fn => fn());
        this.cleanupFns = [];
    }
    
    /**
     * 获取节点的对齐信息
     */
    private getNodeAlignmentInfo(node: Node): NodeAlignmentInfo {
        const pos = node.getPosition();
        const style = node.getStyle();
        const halfWidth = style.width / 2;
        const halfHeight = style.height / 2;
        
        return {
            left: pos.x - halfWidth,
            centerX: pos.x,
            right: pos.x + halfWidth,
            top: pos.y - halfHeight,
            centerY: pos.y,
            bottom: pos.y + halfHeight,
        };
    }
    
    /**
     * 计算并显示对齐线
     */
    private calculateAndShowSnaplines(draggedNode: Node): void {
        if (!this.graph) return;
        
        const dragInfo = this.getNodeAlignmentInfo(draggedNode);
        const allNodes = this.graph.getAllNodes().filter(n => n !== draggedNode);
        
        const snaplines: SnaplineData[] = [];
        const snapPoints: SnapPoint[] = [];
        const tolerance = this.options.tolerance;
        
        // 遍历所有其他节点，计算对齐线
        for (const node of allNodes) {
            const nodeInfo = this.getNodeAlignmentInfo(node);
            
            // 检测当前节点对的中心对齐状态
            const centerXAligned = this.options.showCenter && Math.abs(dragInfo.centerX - nodeInfo.centerX) <= tolerance;
            const centerYAligned = this.options.showCenter && Math.abs(dragInfo.centerY - nodeInfo.centerY) <= tolerance;
            
            // 垂直对齐线（水平方向）
            if (centerXAligned) {
                // 中心对齐优先：显示垂直居中对齐线
                const centerXOffset = dragInfo.centerX - nodeInfo.centerX;
                snaplines.push({
                    type: 'vertical',
                    position: nodeInfo.centerX,
                    start: Math.min(dragInfo.top, nodeInfo.top),
                    end: Math.max(dragInfo.bottom, nodeInfo.bottom),
                });
                snapPoints.push({ type: 'vertical', position: nodeInfo.centerX, offset: centerXOffset });
            } else if (this.options.showEdge) {
                // 无中心对齐：检查边缘对齐
                // 左边缘对齐
                const leftOffset = dragInfo.left - nodeInfo.left;
                if (Math.abs(leftOffset) <= tolerance) {
                    snaplines.push({
                        type: 'vertical',
                        position: nodeInfo.left,
                        start: Math.min(dragInfo.top, nodeInfo.top),
                        end: Math.max(dragInfo.bottom, nodeInfo.bottom),
                    });
                    snapPoints.push({ type: 'vertical', position: nodeInfo.left, offset: leftOffset });
                }
                
                // 右边缘对齐
                const rightOffset = dragInfo.right - nodeInfo.right;
                if (Math.abs(rightOffset) <= tolerance) {
                    snaplines.push({
                        type: 'vertical',
                        position: nodeInfo.right,
                        start: Math.min(dragInfo.top, nodeInfo.top),
                        end: Math.max(dragInfo.bottom, nodeInfo.bottom),
                    });
                    snapPoints.push({ type: 'vertical', position: nodeInfo.right, offset: rightOffset });
                }
            }
            
            // 水平对齐线（垂直方向）
            if (centerYAligned) {
                // 中心对齐优先：显示水平居中对齐线
                const centerYOffset = dragInfo.centerY - nodeInfo.centerY;
                snaplines.push({
                    type: 'horizontal',
                    position: nodeInfo.centerY,
                    start: Math.min(dragInfo.left, nodeInfo.left),
                    end: Math.max(dragInfo.right, nodeInfo.right),
                });
                snapPoints.push({ type: 'horizontal', position: nodeInfo.centerY, offset: centerYOffset });
            } else if (this.options.showEdge) {
                // 无中心对齐：检查边缘对齐
                // 上边缘对齐
                const topOffset = dragInfo.top - nodeInfo.top;
                if (Math.abs(topOffset) <= tolerance) {
                    snaplines.push({
                        type: 'horizontal',
                        position: nodeInfo.top,
                        start: Math.min(dragInfo.left, nodeInfo.left),
                        end: Math.max(dragInfo.right, nodeInfo.right),
                    });
                    snapPoints.push({ type: 'horizontal', position: nodeInfo.top, offset: topOffset });
                }
                
                // 下边缘对齐
                const bottomOffset = dragInfo.bottom - nodeInfo.bottom;
                if (Math.abs(bottomOffset) <= tolerance) {
                    snaplines.push({
                        type: 'horizontal',
                        position: nodeInfo.bottom,
                        start: Math.min(dragInfo.left, nodeInfo.left),
                        end: Math.max(dragInfo.right, nodeInfo.right),
                    });
                    snapPoints.push({ type: 'horizontal', position: nodeInfo.bottom, offset: bottomOffset });
                }
            }
        }
        
        // 应用过滤器
        const filteredSnaplines = snaplines.filter(this.options.filter);
        
        // 去重（同一位置只保留一条线）
        const uniqueSnaplines = this.deduplicateSnaplines(filteredSnaplines);
        
        // 吸附功能
        if (this.options.snap && uniqueSnaplines.length > 0) {
            this.applySnap(draggedNode, snapPoints);
        }
        
        // 显示对齐线
        this.snaplines = uniqueSnaplines;
        this.drawSnaplines();
        
        // 触发回调
        if (uniqueSnaplines.length > 0) {
            this.options.onSnaplineShow(uniqueSnaplines);
        } else {
            this.options.onSnaplineHide();
        }
    }
    
    /**
     * 去重对齐线
     */
    private deduplicateSnaplines(snaplines: SnaplineData[]): SnaplineData[] {
        const verticalMap = new Map<number, SnaplineData>();
        const horizontalMap = new Map<number, SnaplineData>();
        
        for (const line of snaplines) {
            const map = line.type === 'vertical' ? verticalMap : horizontalMap;
            const existing = map.get(line.position);
            
            if (!existing) {
                map.set(line.position, { ...line });
            } else {
                // 合并范围
                existing.start = Math.min(existing.start, line.start);
                existing.end = Math.max(existing.end, line.end);
            }
        }
        
        return [...verticalMap.values(), ...horizontalMap.values()];
    }
    
    /**
     * 应用吸附
     */
    private applySnap(node: Node, snapPoints: SnapPoint[]): void {
        if (snapPoints.length === 0) return;
        
        const pos = node.getPosition();
        let newX = pos.x;
        let newY = pos.y;
        
        // 找到最近的垂直吸附点
        const verticalSnaps = snapPoints.filter(s => s.type === 'vertical');
        if (verticalSnaps.length > 0) {
            const nearest = verticalSnaps.reduce((a, b) => 
                Math.abs(a.offset) < Math.abs(b.offset) ? a : b
            );
            if (Math.abs(nearest.offset) <= this.options.snapStrength) {
                newX = pos.x - nearest.offset;
            }
        }
        
        // 找到最近的水平吸附点
        const horizontalSnaps = snapPoints.filter(s => s.type === 'horizontal');
        if (horizontalSnaps.length > 0) {
            const nearest = horizontalSnaps.reduce((a, b) => 
                Math.abs(a.offset) < Math.abs(b.offset) ? a : b
            );
            if (Math.abs(nearest.offset) <= this.options.snapStrength) {
                newY = pos.y - nearest.offset;
            }
        }
        
        // 更新节点位置
        if (newX !== pos.x || newY !== pos.y) {
            node.setPosition(newX, newY);
        }
    }
    
    /**
     * 绘制对齐线
     */
    private drawSnaplines(): void {
        if (!this.ctx || !this.canvas || !this.graph) return;
        
        // 清除画布
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        if (this.snaplines.length === 0) return;
        
        const { offset, scale } = this.graph.getTransform();
        
        // 设置绘制样式
        this.ctx.strokeStyle = this.options.lineColor;
        this.ctx.lineWidth = this.options.lineWidth;
        this.ctx.setLineDash(this.options.lineDash);
        
        // 绘制每条对齐线
        for (const line of this.snaplines) {
            this.ctx.beginPath();
            
            if (line.type === 'vertical') {
                // 垂直线：从屏幕顶部延伸到底部
                const x = line.position * scale + offset.x;
                this.ctx.moveTo(x, 0);
                this.ctx.lineTo(x, this.canvas.height);
            } else {
                // 水平线：从屏幕左侧延伸到右侧
                const y = line.position * scale + offset.y;
                this.ctx.moveTo(0, y);
                this.ctx.lineTo(this.canvas.width, y);
            }
            
            this.ctx.stroke();
        }
        
        // 重置线条样式
        this.ctx.setLineDash([]);
    }
    
    /**
     * 隐藏对齐线
     */
    hideSnaplines(): void {
        this.snaplines = [];
        
        if (this.ctx && this.canvas) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }
        
        this.options.onSnaplineHide();
    }
    
    /**
     * 获取当前显示的对齐线
     */
    getSnaplines(): SnaplineData[] {
        return [...this.snaplines];
    }
    
    /**
     * 是否正在显示对齐线
     */
    isShowing(): boolean {
        return this.snaplines.length > 0;
    }
    
    /**
     * 手动触发对齐线计算（用于自定义拖拽场景）
     */
    update(node: Node): void {
        if (!this.options.enabled) return;
        this.calculateAndShowSnaplines(node);
    }
    
    /**
     * 清除对齐线
     */
    clear(): void {
        this.hideSnaplines();
    }
}

// 默认导出
export default Snapline;
