import { Graph, Point } from '../core/Graph';
import { Node } from '../core/Node';
import { Edge } from '../core/Edge';
import { EventManager } from '../core/EventManager';

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
 * 力导向布局配置选项
 */
export interface ForceDirectedOptions {
    /** 是否启用力导向布局 */
    enabled?: boolean;
    /** 斥力系数（节点之间的排斥力） */
    repulsion?: number;
    /** 引力系数（边连接的节点之间的吸引力） */
    attraction?: number;
    /** 中心引力（将节点拉向画布中心的力） */
    centerGravity?: number;
    /** 最大迭代次数 */
    maxIterations?: number;
    /** 最小移动阈值（当节点移动小于此值时停止迭代） */
    minMovement?: number;
    /** 动画帧间隔（毫秒） */
    animationInterval?: number;
    /** 阻尼系数（速度衰减） */
    damping?: number;
    /** 最大速度限制 */
    maxSpeed?: number;
    /** 是否自动开始布局 */
    autoStart?: boolean;
    /** 布局完成回调 */
    onLayoutComplete?: () => void;
    /** 节点质量计算函数（影响斥力大小） */
    getNodeMass?: (node: Node) => number;
    /** 边长度计算函数（影响引力大小） */
    getEdgeLength?: (edge: Edge) => number;
    /** 画布中心点，默认使用画布中心 */
    center?: Point;
}

/**
 * 节点物理状态
 */
interface NodePhysics {
    /** 节点 ID */
    nodeId: string;
    /** 节点实例 */
    node: Node;
    /** 质量 */
    mass: number;
    /** 位置 X */
    x: number;
    /** 位置 Y */
    y: number;
    /** 速度 X */
    vx: number;
    /** 速度 Y */
    vy: number;
    /** 力 X */
    fx: number;
    /** 力 Y */
    fy: number;
    /** 是否固定 */
    fixed: boolean;
}

/**
 * 边物理连接
 */
interface EdgePhysics {
    /** 源节点 ID */
    sourceId: string;
    /** 目标节点 ID */
    targetId: string;
    /** 理想长度 */
    length: number;
    /** 边强度 */
    strength: number;
}

/**
 * ForceDirected - 力导向布局插件
 *
 * 使用物理模拟算法自动布局节点和边，模拟节点间的引力和斥力：
 * - 节点间存在斥力（防止重叠）
 * - 边连接的节点间存在引力（保持连接）
 * - 存在中心引力（防止节点飞散）
 * - 支持动态布局和拖拽交互
 *
 * 使用示例：
 * ```typescript
 * const forceDirected = new ForceDirected({
 *     enabled: true,
 *     repulsion: 1000,
 *     attraction: 0.01,
 *     centerGravity: 0.05,
 * });
 * graph.use(forceDirected);
 *
 * // 手动触发布局
 * forceDirected.layout();
 *
 * // 停止布局
 * forceDirected.stop();
 * ```
 */
export class ForceDirected implements Plugin {
    readonly name = 'ForceDirected';

    private graph: Graph | null = null;
    private options: Required<ForceDirectedOptions>;
    private nodes: Map<string, NodePhysics> = new Map();
    private edges: EdgePhysics[] = [];
    private isRunning: boolean = false;
    private animationId: number | null = null;
    private cleanupFns: (() => void)[] = [];
    private iterationCount: number = 0;

    // 默认配置
    private static readonly DEFAULT_OPTIONS: Required<ForceDirectedOptions> = {
        enabled: true,
        repulsion: 1000,
        attraction: 0.01,
        centerGravity: 0.05,
        maxIterations: 300,
        minMovement: 0.1,
        animationInterval: 16,
        damping: 0.9,
        maxSpeed: 10,
        autoStart: true,
        onLayoutComplete: () => {},
        getNodeMass: (node: Node) => {
            const style = node.getStyle();
            // 根据节点面积计算质量
            return Math.sqrt(style.width * style.height) / 10;
        },
        getEdgeLength: () => 100,
        center: { x: 0, y: 0 },
    };

    constructor(options: ForceDirectedOptions = {}) {
        this.options = { ...ForceDirected.DEFAULT_OPTIONS, ...options } as Required<ForceDirectedOptions>;
    }

    /**
     * 安装插件
     */
    install(graph: Graph): void {
        this.graph = graph;
        this.bindEvents();

        if (this.options.autoStart) {
            // 延迟启动，确保节点和边已添加
            setTimeout(() => {
                this.layout();
            }, 100);
        }
    }

    /**
     * 卸载插件
     */
    uninstall(): void {
        this.stop();
        this.unbindEvents();
        this.graph = null;
    }

    /**
     * 更新配置
     */
    setOptions(options: Partial<ForceDirectedOptions>): void {
        this.options = { ...this.options, ...options } as Required<ForceDirectedOptions>;
    }

    /**
     * 获取当前配置
     */
    getOptions(): Required<ForceDirectedOptions> {
        return { ...this.options };
    }

    /**
     * 启用力导向布局
     */
    enable(): void {
        this.options.enabled = true;
    }

    /**
     * 禁用力导向布局
     */
    disable(): void {
        this.options.enabled = false;
        this.stop();
    }

    /**
     * 是否已启用
     */
    isEnabled(): boolean {
        return this.options.enabled;
    }

    /**
     * 是否正在运行
     */
    isLayoutRunning(): boolean {
        return this.isRunning;
    }

    /**
     * 开始力导向布局
     */
    layout(): void {
        if (!this.graph || !this.options.enabled) return;

        this.stop();
        this.initializePhysics();
        this.startSimulation();
    }

    /**
     * 停止布局动画
     */
    stop(): void {
        this.isRunning = false;
        if (this.animationId !== null) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    /**
     * 重置布局（清除物理状态）
     */
    reset(): void {
        this.stop();
        this.nodes.clear();
        this.edges = [];
        this.iterationCount = 0;
    }

    /**
     * 初始化物理模型
     */
    private initializePhysics(): void {
        if (!this.graph) return;

        this.nodes.clear();
        this.edges = [];
        this.iterationCount = 0;

        // 获取画布中心
        const container = this.graph['container'];
        const rect = container.getBoundingClientRect();
        const centerX = this.options.center.x || rect.width / 2;
        const centerY = this.options.center.y || rect.height / 2;

        // 获取所有节点
        const allNodes = this.graph.getAllNodes();
        const nodeIds = new Set<string>();

        allNodes.forEach((node) => {
            const nodeId = node.getId();
            const position = node.getPosition();

            // 如果节点没有位置，随机分布在中心附近
            const x = position.x !== 0 ? position.x : centerX + (Math.random() - 0.5) * 200;
            const y = position.y !== 0 ? position.y : centerY + (Math.random() - 0.5) * 200;

            this.nodes.set(nodeId, {
                nodeId,
                node,
                mass: this.options.getNodeMass(node),
                x,
                y,
                vx: 0,
                vy: 0,
                fx: 0,
                fy: 0,
                fixed: false,
            });

            nodeIds.add(nodeId);
        });

        // 获取所有边
        const allEdges = this.graph.getAllEdges();
        allEdges.forEach((edge) => {
            const sourceId = edge.getSourceId();
            const targetId = edge.getTargetId();

            if (nodeIds.has(sourceId) && nodeIds.has(targetId)) {
                this.edges.push({
                    sourceId,
                    targetId,
                    length: this.options.getEdgeLength(edge),
                    strength: 1,
                });
            }
        });
    }

    /**
     * 开始物理模拟
     */
    private startSimulation(): void {
        this.isRunning = true;
        this.iterationCount = 0;
        this.step();
    }

    /**
     * 模拟步进
     */
    private step(): void {
        if (!this.isRunning || !this.graph) return;

        this.calculateForces();
        const totalMovement = this.updatePositions();
        this.iterationCount++;

        // 检查是否满足停止条件
        if (this.iterationCount >= this.options.maxIterations || totalMovement < this.options.minMovement) {
            this.isRunning = false;
            this.options.onLayoutComplete();
            return;
        }

        // 应用位置更新到节点
        this.applyPositions();

        // 继续下一帧
        this.animationId = requestAnimationFrame(() => this.step());
    }

    /**
     * 计算所有力
     */
    private calculateForces(): void {
        // 重置力
        this.nodes.forEach((node) => {
            node.fx = 0;
            node.fy = 0;
        });

        // 计算斥力（节点之间）
        this.calculateRepulsion();

        // 计算引力（边连接）
        this.calculateAttraction();

        // 计算中心引力
        this.calculateCenterGravity();
    }

    /**
     * 计算节点间斥力
     */
    private calculateRepulsion(): void {
        const nodes = Array.from(this.nodes.values());
        const repulsion = this.options.repulsion;

        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const nodeA = nodes[i];
                const nodeB = nodes[j];

                const dx = nodeB.x - nodeA.x;
                const dy = nodeB.y - nodeA.y;
                const distance = Math.sqrt(dx * dx + dy * dy) || 1;

                // 计算斥力大小（与距离平方成反比）
                const force = (repulsion * nodeA.mass * nodeB.mass) / (distance * distance);

                // 归一化方向
                const fx = (dx / distance) * force;
                const fy = (dy / distance) * force;

                // 应用到两个节点（方向相反）
                nodeA.fx -= fx;
                nodeA.fy -= fy;
                nodeB.fx += fx;
                nodeB.fy += fy;
            }
        }
    }

    /**
     * 计算边引力
     */
    private calculateAttraction(): void {
        const attraction = this.options.attraction;

        this.edges.forEach((edge) => {
            const source = this.nodes.get(edge.sourceId);
            const target = this.nodes.get(edge.targetId);

            if (!source || !target) return;

            const dx = target.x - source.x;
            const dy = target.y - source.y;
            const distance = Math.sqrt(dx * dx + dy * dy) || 1;

            // 计算引力（胡克定律）
            const displacement = distance - edge.length;
            const force = displacement * attraction * edge.strength;

            // 归一化方向
            const fx = (dx / distance) * force;
            const fy = (dy / distance) * force;

            source.fx += fx;
            source.fy += fy;
            target.fx -= fx;
            target.fy -= fy;
        });
    }

    /**
     * 计算中心引力
     */
    private calculateCenterGravity(): void {
        if (!this.graph) return;

        // 获取画布中心
        const container = this.graph['container'];
        const rect = container.getBoundingClientRect();
        const centerX = this.options.center.x || rect.width / 2;
        const centerY = this.options.center.y || rect.height / 2;

        const gravity = this.options.centerGravity;

        this.nodes.forEach((node) => {
            const dx = centerX - node.x;
            const dy = centerY - node.y;

            node.fx += dx * gravity;
            node.fy += dy * gravity;
        });
    }

    /**
     * 更新位置
     * @returns 总移动距离
     */
    private updatePositions(): number {
        let totalMovement = 0;
        const damping = this.options.damping;
        const maxSpeed = this.options.maxSpeed;

        this.nodes.forEach((node) => {
            if (node.fixed) return;

            // 计算加速度
            const ax = node.fx / node.mass;
            const ay = node.fy / node.mass;

            // 更新速度（应用阻尼）
            node.vx = (node.vx + ax) * damping;
            node.vy = (node.vy + ay) * damping;

            // 限制最大速度
            const speed = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
            if (speed > maxSpeed) {
                node.vx = (node.vx / speed) * maxSpeed;
                node.vy = (node.vy / speed) * maxSpeed;
            }

            // 更新位置
            const dx = node.vx;
            const dy = node.vy;

            node.x += dx;
            node.y += dy;

            totalMovement += Math.sqrt(dx * dx + dy * dy);
        });

        return totalMovement;
    }

    /**
     * 将物理位置应用到节点
     */
    private applyPositions(): void {
        this.nodes.forEach((physics) => {
            if (!physics.fixed) {
                physics.node.setPosition(physics.x, physics.y);
            }
        });

        // 重绘画布
        if (this.graph) {
            (this.graph as any).scheduleRender?.();
        }
    }

    /**
     * 固定节点位置
     */
    fixNode(nodeId: string, fixed: boolean = true): void {
        const node = this.nodes.get(nodeId);
        if (node) {
            node.fixed = fixed;
            if (fixed) {
                node.vx = 0;
                node.vy = 0;
            }
        }
    }

    /**
     * 获取节点物理状态
     */
    getNodePhysics(nodeId: string): NodePhysics | undefined {
        return this.nodes.get(nodeId);
    }

    /**
     * 绑定事件
     */
    private bindEvents(): void {
        if (!this.graph) return;

        const eventManager = this.graph['eventManager'] as EventManager;

        // 监听节点添加
        const handleNodeAdd = () => {
            if (this.options.autoStart && this.options.enabled) {
                this.layout();
            }
        };

        // 监听边添加
        const handleEdgeAdd = () => {
            if (this.options.autoStart && this.options.enabled) {
                this.layout();
            }
        };

        // 监听拖拽开始 - 固定节点
        const handleNodeDragStart = (e: any) => {
            const node = e.node as Node;
            this.fixNode(node.getId(), true);
        };

        // 监听拖拽中 - 碰撞检测与排斥
        const handleNodeDrag = (e: any) => {
            if (!this.graph) return;
            
            const draggedNode = e.node as Node;
            const draggedId = draggedNode.getId();
            
            const draggedPos = draggedNode.getPosition();
            const draggedBounds = draggedNode.getBounds();
            const draggedRadius = Math.max(draggedBounds.width, draggedBounds.height) / 2;

            // 检测与其他节点的碰撞 - 直接从 graph 获取所有节点
            let hasCollision = false;
            let totalRepulsionX = 0;
            let totalRepulsionY = 0;

            const allNodes = this.graph.getAllNodes();
            for (const otherNode of allNodes) {
                const otherId = otherNode.getId();
                if (otherId === draggedId) continue;

                const otherPos = otherNode.getPosition();
                const otherBounds = otherNode.getBounds();
                const otherRadius = Math.max(otherBounds.width, otherBounds.height) / 2;

                // 计算两节点中心距离
                const dx = draggedPos.x - otherPos.x;
                const dy = draggedPos.y - otherPos.y;
                const distance = Math.sqrt(dx * dx + dy * dy);

                // 最小安全距离（两节点半径之和 + 缓冲距离）
                const minDistance = draggedRadius + otherRadius + 10;

                if (distance < minDistance && distance > 0) {
                    hasCollision = true;
                    
                    // 计算排斥力方向（从其他节点指向被拖拽节点）
                    const force = (minDistance - distance) / minDistance;
                    const repulsionX = (dx / distance) * force * minDistance * 0.5;
                    const repulsionY = (dy / distance) * force * minDistance * 0.5;

                    totalRepulsionX += repulsionX;
                    totalRepulsionY += repulsionY;
                }
            }

            // 如果有碰撞，调整被拖拽节点位置
            if (hasCollision) {
                const newX = draggedPos.x + totalRepulsionX;
                const newY = draggedPos.y + totalRepulsionY;
                
                draggedNode.setPosition(newX, newY);
                
                // 更新物理状态（如果存在）
                const draggedPhysics = this.nodes.get(draggedId);
                if (draggedPhysics) {
                    draggedPhysics.x = newX;
                    draggedPhysics.y = newY;
                }

                // 触发重渲染
                (this.graph as any).scheduleRender();
            }
        };

        // 监听拖拽结束 - 释放节点
        const handleNodeDragEnd = (e: any) => {
            const node = e.node as Node;
            this.fixNode(node.getId(), false);

            // 更新物理位置
            const physics = this.nodes.get(node.getId());
            if (physics) {
                const pos = node.getPosition();
                physics.x = pos.x;
                physics.y = pos.y;
            }
        };

        eventManager.on('node:add', handleNodeAdd);
        eventManager.on('edge:add', handleEdgeAdd);
        eventManager.on('node:dragstart', handleNodeDragStart);
        eventManager.on('node:drag', handleNodeDrag);
        eventManager.on('node:dragend', handleNodeDragEnd);

        this.cleanupFns.push(() => {
            eventManager.off('node:add', handleNodeAdd);
            eventManager.off('edge:add', handleEdgeAdd);
            eventManager.off('node:dragstart', handleNodeDragStart);
            eventManager.off('node:drag', handleNodeDrag);
            eventManager.off('node:dragend', handleNodeDragEnd);
        });
    }

    /**
     * 解绑事件
     */
    private unbindEvents(): void {
        this.cleanupFns.forEach((fn) => fn());
        this.cleanupFns = [];
    }

    /**
     * 根据层级结构创建树状布局数据
     * @param rootNodeId 根节点 ID
     * @param getChildren 获取子节点的函数
     * @returns 层级深度和节点列表
     */
    createTreeLayout(
        rootNodeId: string,
        getChildren: (nodeId: string) => string[]
    ): { depth: number; nodes: Array<{ id: string; depth: number; parentId?: string }> } {
        const visited = new Set<string>();
        const result: Array<{ id: string; depth: number; parentId?: string }> = [];
        let maxDepth = 0;

        const traverse = (nodeId: string, depth: number, parentId?: string) => {
            if (visited.has(nodeId)) return;
            visited.add(nodeId);

            result.push({ id: nodeId, depth, parentId });
            maxDepth = Math.max(maxDepth, depth);

            const children = getChildren(nodeId);
            children.forEach((childId) => {
                traverse(childId, depth + 1, nodeId);
            });
        };

        traverse(rootNodeId, 0);

        return { depth: maxDepth, nodes: result };
    }
}

export type { NodePhysics, EdgePhysics };
