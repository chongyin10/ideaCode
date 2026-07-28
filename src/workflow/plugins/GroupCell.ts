import { Graph, Point } from '../core/Graph';
import { Node } from '../core/Node';
import { Edge } from '../core/Edge';

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
 * GroupCell 配置选项
 */
export interface GroupCellOptions {
    /** 是否启用群组功能 */
    enabled?: boolean;
    /** 是否递归移动子节点（移动父节点时） */
    recursiveMove?: boolean;
    /** 是否同步移动边 */
    syncEdgeMove?: boolean;
    /** 是否自动嵌入（节点移动到 group 内部时自动成为子节点） */
    autoEmbed?: boolean;
    /** 父节点调整大小时是否同步调整子节点位置（保持相对位置比例） */
    syncChildResize?: boolean;
    /**
     * Group resize 后是否自动嵌入被包含的节点
     * - 当 Group resize 后包含了之前在外部的节点时，自动将其设为子节点
     * - 默认 false（保持原有逻辑）
     */
    autoEmbedOnResize?: boolean;
    /** 父节点移动前回调 */
    onBeforeParentMove?: (parentNode: Node, delta: Point) => boolean | void;
    /** 父节点移动后回调 */
    onAfterParentMove?: (parentNode: Node, delta: Point) => void;
    /** 子节点移入父节点时回调 */
    onChildEmbed?: (childNode: Node, parentNode: Node) => void;
    /** 子节点移出父节点时回调 */
    onChildUnembed?: (childNode: Node, parentNode: Node) => void;
}

/**
 * 节点关系数据
 */
interface NodeRelation {
    /** 父节点 ID */
    parentId: string | null;
    /** 子节点 ID 列表 */
    childrenIds: Set<string>;
    /** 是否是嵌入状态（在父节点内部） */
    isEmbedded: boolean;
}

/**
 * GroupCell - 群组单元格插件
 *
 * 通过父子关系实现群组功能：
 * - 移动父节点时，子节点会跟随移动
 * - 即使子节点位于父节点外部，也会跟随移动
 * - 边的起点和终点的共同父节点被视为边的父节点
 * - 移动父节点时，边的路径点会跟随移动
 * - 支持子节点嵌入/非嵌入两种状态
 *
 * 使用示例：
 * ```typescript
 * const groupCell = new GroupCell({
 *   enabled: true,
 *   recursiveMove: true,
 * });
 * graph.use(groupCell);
 *
 * // 设置父子关系
 * groupCell.setParent(childNode, parentNode);
 *
 * // 获取父节点
 * const parent = groupCell.getParent(childNode);
 *
 * // 获取子节点
 * const children = groupCell.getChildren(parentNode);
 *
 * // 检查是否是嵌入状态
 * const isEmbedded = groupCell.isEmbedded(childNode);
 * ```
 */
export class GroupCell implements Plugin {
    name = 'GroupCell';

    private graph: Graph | null = null;
    private options: Required<GroupCellOptions>;
    private nodeRelations: Map<string, NodeRelation> = new Map();
    private isMoving: boolean = false;
    private moveStartPositions: Map<string, Point> = new Map();

    // 默认配置
    private static readonly DEFAULT_OPTIONS: Required<GroupCellOptions> = {
        enabled: true,
        recursiveMove: true,
        syncEdgeMove: true,
        autoEmbed: true,
        syncChildResize: true,
        autoEmbedOnResize: false,
        onBeforeParentMove: () => {},
        onAfterParentMove: () => {},
        onChildEmbed: () => {},
        onChildUnembed: () => {},
    };

    // resize 状态
    private isResizing: boolean = false;
    private resizeStartBounds: Map<string, { x: number; y: number; width: number; height: number }> = new Map();
    private resizeChildRelativePositions: Map<string, Map<string, { x: number; y: number }>> = new Map();

    constructor(options: GroupCellOptions = {}) {
        this.options = { ...GroupCell.DEFAULT_OPTIONS, ...options };
    }

    /**
     * 安装插件到 Graph
     */
    install(graph: Graph): void {
        this.graph = graph;

        // 监听节点移动事件
        graph.on('node:dragstart', this.handleNodeDragStart.bind(this));
        graph.on('node:drag', this.handleNodeDrag.bind(this));
        graph.on('node:dragend', this.handleNodeDragEnd.bind(this));

        // 监听节点添加事件，自动检查是否需要嵌入 group
        graph.on('node:add', this.handleNodeAdd.bind(this));

        // 监听节点 resize 事件
        graph.on('node:resizestart', this.handleNodeResizeStart.bind(this));
        graph.on('node:resize', this.handleNodeResize.bind(this));
        graph.on('node:resizeend', this.handleNodeResizeEnd.bind(this));

        console.log('✅ GroupCell 插件已安装');
    }

    /**
     * 卸载插件
     */
    uninstall(): void {
        if (this.graph) {
            this.graph.off('node:dragstart', this.handleNodeDragStart.bind(this));
            this.graph.off('node:drag', this.handleNodeDrag.bind(this));
            this.graph.off('node:dragend', this.handleNodeDragEnd.bind(this));
            this.graph.off('node:add', this.handleNodeAdd.bind(this));
            this.graph.off('node:resizestart', this.handleNodeResizeStart.bind(this));
            this.graph.off('node:resize', this.handleNodeResize.bind(this));
            this.graph.off('node:resizeend', this.handleNodeResizeEnd.bind(this));
        }
        this.graph = null;
        this.nodeRelations.clear();
        this.resizeStartBounds.clear();
        this.resizeChildRelativePositions.clear();
        console.log('❌ GroupCell 插件已卸载');
    }

    /**
     * 处理节点添加事件
     * 如果启用了自动嵌入，检查新节点是否在某个 group 内部
     */
    private handleNodeAdd(e: { node: Node }): void {
        if (!this.options.enabled || !this.options.autoEmbed) return;

        const node = e.node;
        // 延迟检查，确保节点已经完全添加到画布
        setTimeout(() => {
            this.checkAndAutoEmbed(node);
        }, 0);
    }

    /**
     * 处理节点拖拽开始
     */
    private handleNodeDragStart(e: { node: Node }): void {
        if (!this.options.enabled) return;

        const node = e.node;
        this.isMoving = true;

        // 记录开始位置
        this.moveStartPositions.set(node.getId(), node.getPosition());

        // 递归记录所有相关子节点的开始位置
        if (this.options.recursiveMove) {
            this.recordChildrenStartPositions(node.getId());
        }
    }

    /**
     * 递归记录子节点的开始位置
     */
    private recordChildrenStartPositions(parentId: string): void {
        const relation = this.nodeRelations.get(parentId);
        if (!relation) return;

        for (const childId of relation.childrenIds) {
            const child = this.graph?.getNode(childId);
            if (child) {
                this.moveStartPositions.set(childId, child.getPosition());
                // 递归记录
                this.recordChildrenStartPositions(childId);
            }
        }
    }

    /**
     * 处理节点拖拽中
     */
    private handleNodeDrag(e: { node: Node; x: number; y: number; dx: number; dy: number }): void {
        if (!this.options.enabled || !this.isMoving) return;

        const node = e.node;
        const nodeId = node.getId();

        // 检查是否有父节点，防止重复移动
        const parentId = this.getParentId(nodeId);
        if (parentId && this.isMoving) {
            // 如果节点有父节点且正在被拖拽，不在这里处理
            // 父节点的移动会自动带动子节点
            return;
        }

        // 计算移动增量
        const startPos = this.moveStartPositions.get(nodeId);
        if (!startPos) return;

        const currentPos = node.getPosition();
        const deltaX = currentPos.x - startPos.x;
        const deltaY = currentPos.y - startPos.y;

        // 触发移动前回调
        const shouldMove = this.options.onBeforeParentMove(node, { x: deltaX, y: deltaY });
        if (shouldMove === false) return;

        // 移动子节点
        if (this.options.recursiveMove) {
            this.moveChildren(nodeId, deltaX, deltaY);
        }

        // 同步移动相关边
        if (this.options.syncEdgeMove) {
            this.syncRelatedEdges(nodeId, deltaX, deltaY);
        }
    }

    /**
     * 递归移动子节点（移动所有子节点，包括嵌入和非嵌入状态的）
     */
    private moveChildren(parentId: string, deltaX: number, deltaY: number): void {
        const relation = this.nodeRelations.get(parentId);
        if (!relation) return;

        for (const childId of relation.childrenIds) {
            const child = this.graph?.getNode(childId);
            if (child) {
                // 获取子节点相对于父节点的偏移
                const startPos = this.moveStartPositions.get(childId);
                if (startPos) {
                    child.setPosition(startPos.x + deltaX, startPos.y + deltaY);
                }

                // 递归移动孙节点
                this.moveChildren(childId, deltaX, deltaY);
            }
        }
    }

    /**
     * 同步移动与节点相关的边
     */
    private syncRelatedEdges(nodeId: string, deltaX: number, deltaY: number): void {
        if (!this.graph) return;

        const edges = this.graph.getAllEdges();

        for (const edge of edges) {
            const sourceId = edge.getSourceId();
            const targetId = edge.getTargetId();

            // 检查边的起点或终点是否是我们正在移动的节点或其子节点
            const isSourceRelated = this.isNodeOrChild(nodeId, sourceId);
            const isTargetRelated = this.isNodeOrChild(nodeId, targetId);

            // 如果边的两端都在移动的节点集合中，移动整个边（包括路径点）
            if (isSourceRelated && isTargetRelated) {
                this.moveEdgeWaypoints(edge, deltaX, deltaY);
            }
        }
    }

    /**
     * 检查 targetId 是否是 sourceId 或其子节点
     */
    private isNodeOrChild(sourceId: string, targetId: string): boolean {
        if (sourceId === targetId) return true;

        const relation = this.nodeRelations.get(sourceId);
        if (!relation) return false;

        for (const childId of relation.childrenIds) {
            if (this.isNodeOrChild(childId, targetId)) {
                return true;
            }
        }

        return false;
    }

    /**
     * 移动边的路径点
     */
    private moveEdgeWaypoints(edge: Edge, deltaX: number, deltaY: number): void {
        // 获取边的路径点（如果存在）
        const waypoints = (edge as any).getWaypoints?.();
        if (waypoints && Array.isArray(waypoints)) {
            const newWaypoints = waypoints.map((point: Point) => ({
                x: point.x + deltaX,
                y: point.y + deltaY,
            }));
            (edge as any).setWaypoints?.(newWaypoints);
        }
    }

    /**
     * 处理节点 resize 开始
     */
    private handleNodeResizeStart(e: { node: Node }): void {
        if (!this.options.enabled) return;

        const node = e.node;

        // 检查是否是 group 类型的节点
        if (node.getType?.() !== 'group') return;

        this.isResizing = true;

        const parentId = node.getId();
        const parentBounds = node.getBounds();

        // 记录父节点初始边界
        this.resizeStartBounds.set(parentId, { ...parentBounds });

        // 记录所有子节点相对于父节点的位置比例
        const childRelativePositions = new Map<string, { x: number; y: number }>();
        this.recordChildRelativePositions(parentId, parentBounds, childRelativePositions);
        this.resizeChildRelativePositions.set(parentId, childRelativePositions);
    }

    /**
     * 递归记录子节点相对于父节点的位置比例
     */
    private recordChildRelativePositions(
        parentId: string,
        parentBounds: { x: number; y: number; width: number; height: number },
        result: Map<string, { x: number; y: number }>
    ): void {
        const relation = this.nodeRelations.get(parentId);
        if (!relation) return;

        for (const childId of relation.childrenIds) {
            const child = this.graph?.getNode(childId);
            if (child) {
                const childPos = child.getPosition();
                // 计算相对于父节点边界的比例位置 (0-1)
                const relativeX = (childPos.x - parentBounds.x) / parentBounds.width;
                const relativeY = (childPos.y - parentBounds.y) / parentBounds.height;
                result.set(childId, { x: relativeX, y: relativeY });

                // 递归记录孙节点
                this.recordChildRelativePositions(childId, parentBounds, result);
            }
        }
    }

    /**
     * 处理节点 resize 中
     */
    private handleNodeResize(e: { node: Node; bounds: { x: number; y: number; width: number; height: number } }): void {
        if (!this.options.enabled || !this.isResizing) return;

        const parentNode = e.node;
        const parentId = parentNode.getId();

        // 只处理 group 类型的节点
        if (parentNode.getType?.() !== 'group') return;

        const newBounds = e.bounds;
        const startBounds = this.resizeStartBounds.get(parentId);
        const childRelativePositions = this.resizeChildRelativePositions.get(parentId);

        if (!startBounds || !childRelativePositions) return;

        // 同步调整子节点位置
        if (this.options.syncChildResize) {
            this.syncChildrenPosition(parentId, startBounds, newBounds, childRelativePositions);
        }

        // 同步调整相关边的路径点
        if (this.options.syncEdgeMove) {
            const deltaX = newBounds.x - startBounds.x;
            const deltaY = newBounds.y - startBounds.y;
            this.syncRelatedEdgesOnResize(parentId, startBounds, newBounds, deltaX, deltaY);
        }
    }

    /**
     * 同步子节点位置（保持相对位置比例）
     */
    private syncChildrenPosition(
        parentId: string,
        startBounds: { x: number; y: number; width: number; height: number },
        newBounds: { x: number; y: number; width: number; height: number },
        relativePositions: Map<string, { x: number; y: number }>
    ): void {
        const relation = this.nodeRelations.get(parentId);
        if (!relation) return;

        for (const childId of relation.childrenIds) {
            const child = this.graph?.getNode(childId);
            const relativePos = relativePositions.get(childId);

            if (child && relativePos) {
                // 根据新的父节点边界和相对比例计算新位置
                const newX = newBounds.x + relativePos.x * newBounds.width;
                const newY = newBounds.y + relativePos.y * newBounds.height;
                child.setPosition(newX, newY);

                // 递归同步孙节点
                this.syncChildrenPosition(childId, startBounds, newBounds, relativePositions);
            }
        }
    }

    /**
     * 同步调整与节点相关的边的路径点
     */
    private syncRelatedEdgesOnResize(
        nodeId: string,
        startBounds: { x: number; y: number; width: number; height: number },
        newBounds: { x: number; y: number; width: number; height: number },
        _deltaX: number,
        _deltaY: number
    ): void {
        if (!this.graph) return;

        const edges = this.graph.getAllEdges();

        for (const edge of edges) {
            const sourceId = edge.getSourceId();
            const targetId = edge.getTargetId();

            // 检查边的起点或终点是否是我们正在 resize 的节点或其子节点
            const isSourceRelated = this.isNodeOrChild(nodeId, sourceId);
            const isTargetRelated = this.isNodeOrChild(nodeId, targetId);

            // 如果边的两端都在移动的节点集合中，按比例调整路径点
            if (isSourceRelated && isTargetRelated) {
                this.resizeEdgeWaypoints(edge, startBounds, newBounds);
            }
        }
    }

    /**
     * 按比例调整边的路径点
     */
    private resizeEdgeWaypoints(
        edge: Edge,
        startBounds: { x: number; y: number; width: number; height: number },
        newBounds: { x: number; y: number; width: number; height: number }
    ): void {
        const waypoints = (edge as any).getWaypoints?.();
        if (!waypoints || !Array.isArray(waypoints) || waypoints.length === 0) return;

        const newWaypoints = waypoints.map((point: Point) => {
            // 计算相对于起始边界的位置比例
            const relativeX = (point.x - startBounds.x) / startBounds.width;
            const relativeY = (point.y - startBounds.y) / startBounds.height;

            // 应用到新的边界
            return {
                x: newBounds.x + relativeX * newBounds.width,
                y: newBounds.y + relativeY * newBounds.height,
            };
        });

        (edge as any).setWaypoints?.(newWaypoints);
    }

    /**
     * 处理节点 resize 结束
     */
    private handleNodeResizeEnd(e: { node: Node }): void {
        if (!this.options.enabled) return;

        const node = e.node;
        const nodeId = node.getId();

        // 清理 resize 状态
        this.isResizing = false;
        this.resizeStartBounds.delete(nodeId);
        this.resizeChildRelativePositions.delete(nodeId);

        // 检查子节点是否仍在父节点内
        this.checkChildrenAfterResize(node);

        // 如果启用了 autoEmbedOnResize，检查是否有外部节点被包含进来
        if (this.options.autoEmbedOnResize && node.getType?.() === 'group') {
            this.checkAndEmbedNodesOnResize(node);
        }
    }

    /**
     * Group resize 后检查并自动嵌入被包含的节点
     */
    private checkAndEmbedNodesOnResize(groupNode: Node): void {
        if (!this.graph) return;

        const groupId = groupNode.getId();

        // 获取所有非 group 类型的节点
        const allNodes = this.graph.getAllNodes();

        for (const node of allNodes) {
            const nodeId = node.getId();

            // 跳过自己
            if (nodeId === groupId) continue;

            // 跳过 group 类型节点（避免嵌套问题）
            if (node.getType?.() === 'group') continue;

            // 跳过已经是子节点的节点
            const currentParent = this.getParent(node);
            if (currentParent?.getId() === groupId) continue;

            // 检查节点当前位置是否在 Group 内部
            if (this.isNodeInsideParent(node, groupNode)) {
                // 检查是否形成循环依赖
                if (!this.isAncestor(nodeId, groupId)) {
                    // 自动设置为子节点
                    this.setParent(node, groupNode, true);
                    console.log(`📦 Resize 后自动嵌入: ${nodeId} -> ${groupId}`);
                }
            }
        }
    }

    /**
     * resize 后检查子节点状态
     */
    private checkChildrenAfterResize(parentNode: Node): void {
        const children = this.getChildren(parentNode);

        for (const child of children) {
            const isInside = this.isNodeInsideParent(child, parentNode);
            const isEmbedded = this.isEmbedded(child);

            // 如果节点在父节点内部但当前不是嵌入状态，设置为嵌入
            if (isInside && !isEmbedded) {
                this.setEmbedded(child, true);
            }
            // 如果节点移出了父节点但当前是嵌入状态，取消嵌入
            else if (!isInside && isEmbedded) {
                this.setEmbedded(child, false);
            }
        }
    }

    /**
     * 处理节点拖拽结束
     */
    private handleNodeDragEnd(e: { node: Node }): void {
        if (!this.options.enabled) return;

        const node = e.node;
        const nodeId = node.getId();
        const startPos = this.moveStartPositions.get(nodeId);

        if (startPos) {
            const currentPos = node.getPosition();
            const deltaX = currentPos.x - startPos.x;
            const deltaY = currentPos.y - startPos.y;

            this.options.onAfterParentMove(node, { x: deltaX, y: deltaY });
        }

        // 清理
        this.isMoving = false;
        this.moveStartPositions.clear();

        // 检查子节点是否需要更新嵌入状态
        this.handleChildDragEnd(e);
    }

    /**
     * 处理子节点拖拽结束，检查是否需要更新嵌入状态或自动绑定
     */
    private handleChildDragEnd(e: { node: Node }): void {
        if (!this.options.enabled) return;

        const node = e.node;

        // 如果启用了自动嵌入，检查是否需要自动绑定到 group 节点
        if (this.options.autoEmbed) {
            this.checkAndAutoEmbed(node);
        }

        // 检查已有父关系的嵌入状态
        const parent = this.getParent(node);
        if (parent) {
            const isInside = this.isNodeInsideParent(node, parent);
            const isEmbedded = this.isEmbedded(node);

            // 如果节点在父节点内部但当前不是嵌入状态，设置为嵌入
            if (isInside && !isEmbedded) {
                this.setEmbedded(node, true);
            }
            // 如果节点移出了父节点但当前是嵌入状态，取消嵌入
            else if (!isInside && isEmbedded) {
                this.setEmbedded(node, false);
            }
        }
    }

    /**
     * 检查并自动嵌入节点到 group 节点
     * 当节点移动到 group 类型节点内部时，自动建立父子关系
     */
    private checkAndAutoEmbed(node: Node): void {
        if (!this.graph) return;

        const nodeId = node.getId();
        const currentParent = this.getParent(node);

        // 获取所有 group 类型的节点
        const allNodes = this.graph.getAllNodes();
        const groupNodes = allNodes.filter(n => n.getType?.() === 'group' && n.getId() !== nodeId);

        // 查找节点当前位于哪个 group 内部
        let newParent: Node | null = null;
        for (const groupNode of groupNodes) {
            if (this.isNodeInsideParent(node, groupNode)) {
                // 检查是否形成循环依赖
                if (!this.isAncestor(nodeId, groupNode.getId())) {
                    newParent = groupNode;
                    break;
                }
            }
        }

        // 如果找到了新的父节点
        if (newParent) {
            // 如果已经有父节点且是同一个，不做处理
            if (currentParent?.getId() === newParent.getId()) {
                return;
            }
            // 设置新的父子关系（自动嵌入）
            this.setParent(node, newParent, true);
        } else if (currentParent) {
            // 如果移出了所有 group 区域，取消父子关系
            const isInsideCurrentParent = this.isNodeInsideParent(node, currentParent);
            if (!isInsideCurrentParent) {
                this.removeFromParent(node);
            }
        }
    }

    /**
     * 检查子节点是否在父节点内部
     */
    private isNodeInsideParent(node: Node, parent: Node): boolean {
        const nodeBounds = node.getBounds();
        const parentBounds = parent.getBounds();

        // 检查节点是否完全在父节点内部
        return (
            nodeBounds.x >= parentBounds.x &&
            nodeBounds.y >= parentBounds.y &&
            nodeBounds.x + nodeBounds.width <= parentBounds.x + parentBounds.width &&
            nodeBounds.y + nodeBounds.height <= parentBounds.y + parentBounds.height
        );
    }

    /**
     * 设置节点的父节点
     * @param childNode - 子节点
     * @param parentNode - 父节点（null 表示移除父节点）
     * @param embed - 是否嵌入（影响视觉效果）
     */
    setParent(childNode: Node, parentNode: Node | null, embed: boolean = false): void {
        const childId = childNode.getId();

        // 先移除现有的父关系
        this.removeFromParent(childNode);

        if (parentNode) {
            const parentId = parentNode.getId();

            // 确保不形成循环依赖
            if (this.isAncestor(childId, parentId)) {
                console.warn('Cannot set parent: would create circular dependency');
                return;
            }

            // 设置子节点的父节点
            let childRelation = this.nodeRelations.get(childId);
            if (!childRelation) {
                childRelation = { parentId: null, childrenIds: new Set(), isEmbedded: false };
                this.nodeRelations.set(childId, childRelation);
            }
            childRelation.parentId = parentId;
            childRelation.isEmbedded = embed;

            // 更新父节点的子节点列表
            let parentRelation = this.nodeRelations.get(parentId);
            if (!parentRelation) {
                parentRelation = { parentId: null, childrenIds: new Set(), isEmbedded: false };
                this.nodeRelations.set(parentId, parentRelation);
            }
            parentRelation.childrenIds.add(childId);

            // 触发回调
            if (embed) {
                this.options.onChildEmbed(childNode, parentNode);
            }

            console.log(`🔗 设置父子关系: ${childId} -> ${parentId}, 嵌入: ${embed}`);
        }
    }

    /**
     * 移除节点的父节点关系
     */
    removeFromParent(childNode: Node): void {
        const childId = childNode.getId();
        const childRelation = this.nodeRelations.get(childId);

        if (childRelation && childRelation.parentId) {
            const oldParentId = childRelation.parentId;
            const wasEmbedded = childRelation.isEmbedded;

            // 从旧父节点的子节点列表中移除
            const parentRelation = this.nodeRelations.get(oldParentId);
            if (parentRelation) {
                parentRelation.childrenIds.delete(childId);
            }

            // 清除子节点的父节点
            childRelation.parentId = null;
            childRelation.isEmbedded = false;

            // 触发回调
            if (wasEmbedded) {
                const oldParent = this.graph?.getNode(oldParentId);
                if (oldParent) {
                    this.options.onChildUnembed(childNode, oldParent);
                }
            }

            console.log(`🔗 移除父子关系: ${childId} -> ${oldParentId}`);
        }
    }

    /**
     * 获取节点的父节点
     */
    getParent(childNode: Node): Node | null {
        const parentId = this.getParentId(childNode.getId());
        if (parentId && this.graph) {
            return this.graph.getNode(parentId) || null;
        }
        return null;
    }

    /**
     * 获取节点的父节点 ID
     */
    getParentId(nodeId: string): string | null {
        const relation = this.nodeRelations.get(nodeId);
        return relation?.parentId || null;
    }

    /**
     * 获取节点的子节点列表
     */
    getChildren(parentNode: Node): Node[] {
        const children: Node[] = [];
        const relation = this.nodeRelations.get(parentNode.getId());

        if (relation && this.graph) {
            for (const childId of relation.childrenIds) {
                const child = this.graph.getNode(childId);
                if (child) {
                    children.push(child);
                }
            }
        }

        return children;
    }

    /**
     * 获取节点的子节点 ID 列表
     */
    getChildrenIds(parentId: string): string[] {
        const relation = this.nodeRelations.get(parentId);
        return relation ? Array.from(relation.childrenIds) : [];
    }

    /**
     * 检查节点是否是嵌入状态（在父节点内部）
     */
    isEmbedded(node: Node): boolean {
        const relation = this.nodeRelations.get(node.getId());
        return relation?.isEmbedded || false;
    }

    /**
     * 设置节点的嵌入状态
     */
    setEmbedded(node: Node, embedded: boolean): void {
        const relation = this.nodeRelations.get(node.getId());
        if (relation && relation.parentId) {
            const oldEmbedded = relation.isEmbedded;
            relation.isEmbedded = embedded;

            // 触发回调
            if (!oldEmbedded && embedded) {
                const parent = this.graph?.getNode(relation.parentId);
                if (parent) {
                    this.options.onChildEmbed(node, parent);
                }
            } else if (oldEmbedded && !embedded) {
                const parent = this.graph?.getNode(relation.parentId);
                if (parent) {
                    this.options.onChildUnembed(node, parent);
                }
            }
        }
    }

    /**
     * 获取边的父节点（起点和终点的共同父节点）
     */
    getEdgeParent(edge: Edge): Node | null {
        const sourceId = edge.getSourceId();
        const targetId = edge.getTargetId();

        const sourceParentId = this.getParentId(sourceId);
        const targetParentId = this.getParentId(targetId);

        // 如果起点和终点有相同的父节点，返回该父节点
        if (sourceParentId && sourceParentId === targetParentId && this.graph) {
            return this.graph.getNode(sourceParentId) || null;
        }

        return null;
    }

    /**
     * 检查一个节点是否是另一个节点的祖先
     */
    isAncestor(ancestorId: string, descendantId: string): boolean {
        if (ancestorId === descendantId) return false;

        const relation = this.nodeRelations.get(descendantId);
        if (!relation || !relation.parentId) return false;

        if (relation.parentId === ancestorId) return true;

        return this.isAncestor(ancestorId, relation.parentId);
    }

    /**
     * 获取节点的所有祖先节点
     */
    getAncestors(node: Node): Node[] {
        const ancestors: Node[] = [];
        let currentId: string | null = node.getId();

        while (currentId) {
            const parentId = this.getParentId(currentId);
            if (parentId && this.graph) {
                const parent = this.graph.getNode(parentId);
                if (parent) {
                    ancestors.push(parent);
                }
                currentId = parentId;
            } else {
                break;
            }
        }

        return ancestors;
    }

    /**
     * 获取节点的所有后代节点（递归）
     */
    getDescendants(node: Node): Node[] {
        const descendants: Node[] = [];
        this.collectDescendants(node.getId(), descendants);
        return descendants;
    }

    /**
     * 递归收集后代节点
     */
    private collectDescendants(parentId: string, result: Node[]): void {
        const children = this.getChildrenIds(parentId);

        for (const childId of children) {
            const child = this.graph?.getNode(childId);
            if (child) {
                result.push(child);
                this.collectDescendants(childId, result);
            }
        }
    }

    /**
     * 取消节点的父子关系
     */
    ungroup(parentNode: Node): void {
        const children = this.getChildren(parentNode);

        for (const child of children) {
            this.removeFromParent(child);
        }

        console.log(`📦 取消群组: ${parentNode.getId()}`);
    }

    /**
     * 获取所有根节点（没有父节点的节点）
     */
    getRootNodes(): Node[] {
        if (!this.graph) return [];

        const allNodes = this.graph.getAllNodes();
        return allNodes.filter(node => !this.getParentId(node.getId()));
    }

    /**
     * 获取群组的所有节点（包括父节点和递归子节点）
     */
    getGroupNodes(parentNode: Node): Node[] {
        const groupNodes: Node[] = [parentNode];
        const descendants = this.getDescendants(parentNode);
        groupNodes.push(...descendants);
        return groupNodes;
    }

    /**
     * 更新插件配置
     */
    setOptions(options: Partial<GroupCellOptions>): void {
        this.options = { ...this.options, ...options };
    }

    /**
     * 获取当前配置
     */
    getOptions(): GroupCellOptions {
        return { ...this.options };
    }

    /**
     * 启用插件
     */
    enable(): void {
        this.options.enabled = true;
    }

    /**
     * 禁用插件
     */
    disable(): void {
        this.options.enabled = false;
    }

    /**
     * 检查是否启用
     */
    isEnabled(): boolean {
        return this.options.enabled;
    }

    /**
     * 清空所有父子关系
     */
    clear(): void {
        this.nodeRelations.clear();
        console.log('🧹 已清空所有群组关系');
    }

    /**
     * 获取关系统计信息
     */
    getStats(): { totalNodes: number; rootNodes: number; groups: number } {
        const totalNodes = this.nodeRelations.size;
        const rootNodes = this.getRootNodes().length;

        let groups = 0;
        for (const [_, relation] of this.nodeRelations) {
            if (relation.childrenIds.size > 0) {
                groups++;
            }
        }

        return { totalNodes, rootNodes, groups };
    }
}

export default GroupCell;
