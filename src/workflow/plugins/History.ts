import { Graph, Point } from '../core/Graph';
import { Node } from '../core/Node';
import { Edge } from '../core/Edge';

/**
 * 历史记录操作类型
 */
export type HistoryActionType = 
    | 'node:add' 
    | 'node:remove' 
    | 'node:move' 
    | 'node:update'
    | 'edge:add' 
    | 'edge:remove'
    | 'edge:update'
    | 'batch';

/**
 * 单个历史记录动作
 */
export interface HistoryAction {
    /** 动作类型 */
    type: HistoryActionType;
    /** 动作描述（用于调试） */
    description?: string;
    /** 撤销函数 */
    undo: () => void;
    /** 重做函数 */
    redo: () => void;
}

/**
 * 批量历史记录动作
 */
export interface BatchHistoryAction extends HistoryAction {
    type: 'batch';
    /** 子动作列表 */
    actions: HistoryAction[];
}

/**
 * 节点数据快照
 */
export interface NodeSnapshot {
    id: string;
    x: number;
    y: number;
    label?: string;
    style?: any;
    data?: any;
    shape?: any;
}

/**
 * 边数据快照
 */
export interface EdgeSnapshot {
    id: string;
    source: string | { nodeId: string; portId?: string };
    target: string | { nodeId: string; portId?: string };
    type?: any;
    style?: any;
    label?: string;
}

/**
 * 历史状态
 */
export interface HistoryState {
    /** 节点快照 */
    nodes: NodeSnapshot[];
    /** 边快照 */
    edges: EdgeSnapshot[];
}

/**
 * History 配置选项
 */
export interface HistoryOptions {
    /** 是否启用历史记录 */
    enabled?: boolean;
    /** 最大历史记录数量 */
    maxStackSize?: number;
    /** 是否启用键盘快捷键 */
    keyboardShortcuts?: boolean;
    /** 是否忽略属性变化 */
    ignorePropertyChanges?: boolean;
    /** 历史记录变化回调 */
    onChange?: (canUndo: boolean, canRedo: boolean) => void;
    /** 撤销前回调 */
    onBeforeUndo?: () => boolean | void;
    /** 撤销后回调 */
    onUndo?: () => void;
    /** 重做前回调 */
    onBeforeRedo?: () => boolean | void;
    /** 重做后回调 */
    onRedo?: () => void;
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
 * History - 撤销重做插件
 *
 * 提供撤销和重做功能，支持以下操作的历史记录：
 * - 添加/删除节点
 * - 添加/删除边
 * - 移动节点
 * - 更新节点/边属性
 * - 批量操作
 *
 * 使用示例：
 * ```typescript
 * const history = new History({
 *     enabled: true,
 *     maxStackSize: 50,
 *     keyboardShortcuts: true,
 * });
 * graph.use(history);
 *
 * // 手动撤销/重做
 * history.undo();
 * history.redo();
 *
 * // 检查状态
 * if (history.canUndo()) console.log('可以撤销');
 * if (history.canRedo()) console.log('可以重做');
 *
 * // 批量操作（只产生一条历史记录）
 * history.batch(() => {
 *     graph.addNode({ x: 100, y: 100, label: '节点1' });
 *     graph.addNode({ x: 200, y: 200, label: '节点2' });
 *     graph.addEdge({ source: 'node-1', target: 'node-2' });
 * });
 * ```
 */
export class History implements Plugin {
    readonly name = 'History';

    private graph: Graph | null = null;
    private options: Required<HistoryOptions>;
    private undoStack: HistoryAction[] = [];
    private redoStack: HistoryAction[] = [];
    private cleanupFns: (() => void)[] = [];
    private isExecuting: boolean = false;
    private isBatching: boolean = false;
    private currentBatchActions: HistoryAction[] = [];

    // 默认配置
    private static readonly DEFAULT_OPTIONS: Required<HistoryOptions> = {
        enabled: true,
        maxStackSize: 50,
        keyboardShortcuts: true,
        ignorePropertyChanges: false,
        onChange: () => {},
        onBeforeUndo: () => {},
        onUndo: () => {},
        onBeforeRedo: () => {},
        onRedo: () => {},
    };

    constructor(options: HistoryOptions = {}) {
        this.options = { ...History.DEFAULT_OPTIONS, ...options } as Required<HistoryOptions>;
    }

    /**
     * 安装插件
     */
    install(graph: Graph): void {
        this.graph = graph;
        if (this.options.enabled) {
            this.enable();
        }
    }

    /**
     * 卸载插件
     */
    uninstall(): void {
        this.disable();
        this.graph = null;
    }

    /**
     * 启用历史记录
     */
    enable(): void {
        this.options.enabled = true;
        this.bindEvents();
    }

    /**
     * 禁用历史记录
     */
    disable(): void {
        this.options.enabled = false;
        this.unbindEvents();
    }

    /**
     * 是否已启用
     */
    isEnabled(): boolean {
        return this.options.enabled;
    }

    /**
     * 更新配置
     */
    setOptions(options: Partial<HistoryOptions>): void {
        this.options = { ...this.options, ...options } as Required<HistoryOptions>;
    }

    /**
     * 获取当前配置
     */
    getOptions(): Required<HistoryOptions> {
        return { ...this.options };
    }

    /**
     * 绑定事件
     */
    private bindEvents(): void {
        if (typeof document === 'undefined' || !this.graph) return;

        const handleKeyDown = this.handleKeyDown.bind(this);
        document.addEventListener('keydown', handleKeyDown);
        this.cleanupFns.push(() => document.removeEventListener('keydown', handleKeyDown));

        // 监听节点添加事件
        const handleNodeAdd = (e: any) => {
            if (this.isExecuting || !this.options.enabled) return;
            const node = e.node as Node;
            // 立即捕获节点数据快照
            const nodeId = node.getId();
            const nodeData = {
                id: nodeId,
                x: node.getPosition().x,
                y: node.getPosition().y,
                label: node.getLabel(),
                style: { ...node.getStyle() },
                data: node.getData(),
            };
            
            this.addAction({
                type: 'node:add',
                description: `添加节点 ${nodeId}`,
                undo: () => {
                    this.graph?.removeNode(nodeId);
                },
                redo: () => {
                    this.graph?.addNode({ ...nodeData });
                },
            });
        };
        this.graph.on('node:add', handleNodeAdd);
        this.cleanupFns.push(() => this.graph?.off('node:add', handleNodeAdd));

        // 监听节点删除事件
        const handleNodeRemove = (e: any) => {
            if (this.isExecuting || !this.options.enabled) return;
            const node = e.node as Node;
            // 立即捕获节点和边的数据快照
            const nodeId = node.getId();
            const nodeData = {
                id: nodeId,
                x: node.getPosition().x,
                y: node.getPosition().y,
                label: node.getLabel(),
                style: { ...node.getStyle() },
                data: node.getData(),
            };
            const connectedEdges = (e.connectedEdges as Edge[]).map(edge => ({
                id: edge.getId(),
                source: edge.getSourceAnchor(),
                target: edge.getTargetAnchor(),
                type: edge.getType(),
                style: { ...edge.getStyle() },
            }));
            
            this.addAction({
                type: 'node:remove',
                description: `删除节点 ${nodeId}`,
                undo: () => {
                    // 恢复节点
                    this.graph?.addNode({ ...nodeData });
                    // 恢复相关的边
                    connectedEdges?.forEach((edgeData) => {
                        this.graph?.addEdge({ ...edgeData });
                    });
                },
                redo: () => {
                    this.graph?.removeNode(nodeId);
                },
            });
        };
        this.graph.on('node:remove', handleNodeRemove);
        this.cleanupFns.push(() => this.graph?.off('node:remove', handleNodeRemove));

        // 监听节点移动事件
        const handleNodeMove = (e: any) => {
            if (this.isExecuting || !this.options.enabled) return;
            const node = e.node as Node;
            // 必须克隆位置对象，避免闭包引用问题
            const oldPosition: Point = { x: e.oldPosition.x, y: e.oldPosition.y };
            const newPosition: Point = { x: e.newPosition.x, y: e.newPosition.y };
            const nodeId = node.getId();

            // 避免记录微小的移动（防抖）
            const dx = Math.abs(newPosition.x - oldPosition.x);
            const dy = Math.abs(newPosition.y - oldPosition.y);
            if (dx < 0.5 && dy < 0.5) return;

            this.addAction({
                type: 'node:move',
                description: `移动节点 ${nodeId}`,
                undo: () => {
                    const n = this.graph?.getNode(nodeId);
                    if (n) {
                        n.setPosition(oldPosition.x, oldPosition.y);
                        // 触发重新渲染
                        (this.graph as any).scheduleRender();
                    }
                },
                redo: () => {
                    const n = this.graph?.getNode(nodeId);
                    if (n) {
                        n.setPosition(newPosition.x, newPosition.y);
                        // 触发重新渲染
                        (this.graph as any).scheduleRender();
                    }
                },
            });
        };
        this.graph.on('node:dragend', handleNodeMove);
        this.cleanupFns.push(() => this.graph?.off('node:dragend', handleNodeMove));

        // 监听边添加事件
        const handleEdgeAdd = (e: any) => {
            if (this.isExecuting || !this.options.enabled) return;
            const edge = e.edge as Edge;
            // 立即捕获边的数据快照
            const edgeId = edge.getId();
            const edgeData = {
                id: edgeId,
                source: edge.getSourceAnchor(),
                target: edge.getTargetAnchor(),
                type: edge.getType(),
                style: { ...edge.getStyle() },
            };
            
            this.addAction({
                type: 'edge:add',
                description: `添加边 ${edgeId}`,
                undo: () => {
                    this.graph?.removeEdge(edgeId);
                },
                redo: () => {
                    this.graph?.addEdge({ ...edgeData });
                },
            });
        };
        this.graph.on('edge:add', handleEdgeAdd);
        this.cleanupFns.push(() => this.graph?.off('edge:add', handleEdgeAdd));

        // 监听边删除事件
        const handleEdgeRemove = (e: any) => {
            if (this.isExecuting || !this.options.enabled) return;
            const edge = e.edge as Edge;
            // 立即捕获边的数据快照
            const edgeId = edge.getId();
            const edgeData = {
                id: edgeId,
                source: edge.getSourceAnchor(),
                target: edge.getTargetAnchor(),
                type: edge.getType(),
                style: { ...edge.getStyle() },
            };
            
            this.addAction({
                type: 'edge:remove',
                description: `删除边 ${edgeId}`,
                undo: () => {
                    this.graph?.addEdge({ ...edgeData });
                },
                redo: () => {
                    this.graph?.removeEdge(edgeId);
                },
            });
        };
        this.graph.on('edge:remove', handleEdgeRemove);
        this.cleanupFns.push(() => this.graph?.off('edge:remove', handleEdgeRemove));
    }

    /**
     * 解绑事件
     */
    private unbindEvents(): void {
        this.cleanupFns.forEach(fn => fn());
        this.cleanupFns = [];
    }

    /**
     * 处理键盘事件
     */
    private handleKeyDown(e: KeyboardEvent): void {
        if (!this.options.enabled || !this.options.keyboardShortcuts) return;

        // Ctrl+Z 或 Cmd+Z - 撤销
        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
            e.preventDefault();
            this.undo();
        }

        // Ctrl+Y 或 Cmd+Shift+Z - 重做
        if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
            e.preventDefault();
            this.redo();
        }
    }

    /**
     * 添加历史记录动作
     */
    private addAction(action: HistoryAction): void {
        if (this.isBatching) {
            this.currentBatchActions.push(action);
            return;
        }

        // 清空重做栈
        this.redoStack = [];

        // 添加到撤销栈
        this.undoStack.push(action);

        // 限制历史记录数量
        if (this.undoStack.length > this.options.maxStackSize) {
            this.undoStack.shift();
        }

        // 触发变化回调
        this.options.onChange(this.canUndo(), this.canRedo());
    }

    /**
     * 撤销操作
     */
    undo(): boolean {
        if (!this.canUndo() || !this.options.enabled) return false;

        // 调用撤销前回调
        const shouldProceed = this.options.onBeforeUndo();
        if (shouldProceed === false) return false;

        this.isExecuting = true;

        const action = this.undoStack.pop()!;

        try {
            if (action.type === 'batch') {
                // 批量操作：逆序撤销所有子操作
                const batchAction = action as BatchHistoryAction;
                for (let i = batchAction.actions.length - 1; i >= 0; i--) {
                    batchAction.actions[i].undo();
                }
            } else {
                action.undo();
            }
            this.redoStack.push(action);
        } catch (error) {
            console.error('撤销操作失败:', error);
            this.undoStack.push(action);
            this.isExecuting = false;
            return false;
        }

        this.isExecuting = false;
        this.options.onChange(this.canUndo(), this.canRedo());
        this.options.onUndo();

        return true;
    }

    /**
     * 重做操作
     */
    redo(): boolean {
        if (!this.canRedo() || !this.options.enabled) return false;

        // 调用重做前回调
        const shouldProceed = this.options.onBeforeRedo();
        if (shouldProceed === false) return false;

        this.isExecuting = true;

        const action = this.redoStack.pop()!;

        try {
            if (action.type === 'batch') {
                // 批量操作：顺序重做所有子操作
                const batchAction = action as BatchHistoryAction;
                batchAction.actions.forEach(subAction => subAction.redo());
            } else {
                action.redo();
            }
            this.undoStack.push(action);
        } catch (error) {
            console.error('重做操作失败:', error);
            this.redoStack.push(action);
            this.isExecuting = false;
            return false;
        }

        this.isExecuting = false;
        this.options.onChange(this.canUndo(), this.canRedo());
        this.options.onRedo();

        return true;
    }

    /**
     * 是否可以撤销
     */
    canUndo(): boolean {
        return this.undoStack.length > 0;
    }

    /**
     * 是否可以重做
     */
    canRedo(): boolean {
        return this.redoStack.length > 0;
    }

    /**
     * 获取撤销栈大小
     */
    getUndoStackSize(): number {
        return this.undoStack.length;
    }

    /**
     * 获取重做栈大小
     */
    getRedoStackSize(): number {
        return this.redoStack.length;
    }

    /**
     * 清空历史记录
     */
    clear(): void {
        this.undoStack = [];
        this.redoStack = [];
        this.options.onChange(false, false);
    }

    /**
     * 批量操作（只产生一条历史记录）
     * @param fn - 批量执行的函数
     * @param description - 操作描述
     */
    batch(fn: () => void, description?: string): void {
        if (!this.options.enabled) {
            fn();
            return;
        }

        this.isBatching = true;
        this.currentBatchActions = [];

        try {
            fn();
        } finally {
            this.isBatching = false;

            if (this.currentBatchActions.length > 0) {
                const batchAction: BatchHistoryAction = {
                    type: 'batch',
                    description: description || `批量操作 (${this.currentBatchActions.length} 个动作)`,
                    actions: [...this.currentBatchActions],
                    undo: () => {},
                    redo: () => {},
                };

                // 清空重做栈
                this.redoStack = [];

                // 添加到撤销栈
                this.undoStack.push(batchAction);

                // 限制历史记录数量
                if (this.undoStack.length > this.options.maxStackSize) {
                    this.undoStack.shift();
                }

                this.options.onChange(this.canUndo(), this.canRedo());
            }

            this.currentBatchActions = [];
        }
    }

    /**
     * 获取当前历史状态（用于保存/恢复）
     */
    getState(): { undo: HistoryAction[]; redo: HistoryAction[] } {
        return {
            undo: [...this.undoStack],
            redo: [...this.redoStack],
        };
    }

    /**
     * 恢复到指定历史状态
     */
    restoreState(state: { undo: HistoryAction[]; redo: HistoryAction[] }): void {
        this.undoStack = [...state.undo];
        this.redoStack = [...state.redo];
        this.options.onChange(this.canUndo(), this.canRedo());
    }
}

export default History;
