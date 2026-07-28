import { Graph, Point } from '../core/Graph';
import { Node } from '../core/Node';

/**
 * Selection 事件对象
 */
export interface SelectionEvent {
    /** 事件类型 */
    type: 'selection:start' | 'selection:move' | 'selection:end';
    /** 选中的节点 */
    selectedNodes: Node[];
    /** 选择框的边界 */
    bounds?: { x: number; y: number; width: number; height: number };
    /** 鼠标位置（世界坐标） */
    position?: Point;
}

/**
 * Selection 配置选项
 */
export interface SelectionOptions {
    /** 是否启用框选 */
    enabled?: boolean;
    /** 选择框样式 */
    selectionBoxStyle?: {
        strokeColor?: string;
        strokeWidth?: number;
        fillColor?: string;
    };
    /** 是否允许多选 */
    multiple?: boolean;
    /** 框选开始回调 */
    onSelectionStart?: (e: SelectionEvent) => void;
    /** 框选中回调 */
    onSelectionMove?: (e: SelectionEvent) => void;
    /** 框选结束回调 */
    onSelectionEnd?: (e: SelectionEvent) => void;
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
 * 单个选择框的数据结构
 */
interface SelectionBoxData {
    /** 选择框元素 */
    element: HTMLDivElement;
    /** 选中的节点ID集合 */
    nodeIds: Set<string>;
    /** 选择框的边界（世界坐标） */
    bounds: { x: number; y: number; width: number; height: number };
    /** 是否正在拖拽 */
    isDragging: boolean;
    /** 拖拽起始点 */
    dragStartPoint: Point | null;
    /** 节点初始位置 */
    nodeStartPositions: Map<string, Point>;
}

/**
 * Selection - 框选插件
 *
 * 功能特性：
 * - 按住 Alt键 + 鼠标左键在画布空白处拖动进行框选
 * - 显示蓝色虚线选择框
 * - 支持与选择框相交或包含在内的节点被选中
 * - 支持多选模式
 * - 支持多个选择框，重叠区域按优先级保留第一个选中的
 *
 * 使用示例：
 * ```typescript
 * const selection = new Selection({
 *     enabled: true,
 *     multiple: true,
 *     onSelectionEnd: (e) => console.log('选中节点:', e.selectedNodes),
 * });
 *
 * // 通过 graph.use 注册插件
 * graph.use(selection);
 * ```
 *
 * 操作说明：
 * - 按住 Alt + 鼠标左键拖动：开始框选
 * - 按住 Ctrl/Cmd + Alt + 鼠标左键拖动：追加选择（新选择框）
 */
export class Selection implements Plugin {
    readonly name = 'selection';

    private graph: Graph | null = null;
    private options: SelectionOptions;
    private isSelecting: boolean = false;
    private selectionStartPoint: Point | null = null;
    private selectionCurrentPoint: Point | null = null;
    private tempSelectionBox: HTMLDivElement | null = null;

    // 多个选择框的管理
    private selectionBoxes: Map<string, SelectionBoxData> = new Map();
    private selectionBoxCounter: number = 0;

    // 全局已选中的节点（所有选择框）
    private globallySelectedNodes: Set<string> = new Set();

    // 默认配置
    private static readonly DEFAULT_OPTIONS: SelectionOptions = {
        enabled: true,
        multiple: true,
        selectionBoxStyle: {
            strokeColor: '#3b82f6',
            strokeWidth: 2,
            fillColor: 'rgba(59, 130, 246, 0.1)',
        },
    };

    constructor(options: SelectionOptions = {}) {
        this.options = {
            ...Selection.DEFAULT_OPTIONS,
            ...options,
            selectionBoxStyle: {
                ...Selection.DEFAULT_OPTIONS.selectionBoxStyle,
                ...options.selectionBoxStyle,
            },
        };
    }

    /**
     * 安装插件（由 Graph.use 调用）
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
     * 启用框选
     */
    enable(): void {
        if (!this.graph) return;
        this.graph.on('blank:mousedown', this.handleBlankMouseDown);
        this.graph.on('blank:mousemove', this.handleBlankMouseMove);
        this.graph.on('blank:mouseup', this.handleBlankMouseUp);
    }

    /**
     * 禁用框选
     */
    disable(): void {
        if (!this.graph) return;
        this.graph.off('blank:mousedown', this.handleBlankMouseDown);
        this.graph.off('blank:mousemove', this.handleBlankMouseMove);
        this.graph.off('blank:mouseup', this.handleBlankMouseUp);
        this.removeGlobalListeners();
        this.clearAllSelections();
    }

    /**
     * 添加全局事件监听
     */
    private addGlobalListeners(): void {
        document.addEventListener('mousemove', this.handleGlobalMouseMove);
        document.addEventListener('mouseup', this.handleGlobalMouseUp);
    }

    /**
     * 移除全局事件监听
     */
    private removeGlobalListeners(): void {
        document.removeEventListener('mousemove', this.handleGlobalMouseMove);
        document.removeEventListener('mouseup', this.handleGlobalMouseUp);
    }

    /**
     * 设置是否启用
     */
    setEnabled(enabled: boolean): void {
        this.options.enabled = enabled;
        if (enabled) {
            this.enable();
        } else {
            this.disable();
        }
    }

    /**
     * 获取当前所有选中的节点
     */
    getSelectedNodes(): Node[] {
        if (!this.graph) return [];
        return this.graph.getAllNodes().filter(node => this.globallySelectedNodes.has(node.getId()));
    }

    /**
     * 获取特定选择框中的节点
     */
    getNodesInSelectionBox(boxId: string): Node[] {
        if (!this.graph) return [];
        const box = this.selectionBoxes.get(boxId);
        if (!box) return [];
        return this.graph.getAllNodes().filter(node => box.nodeIds.has(node.getId()));
    }

    /**
     * 清除所有选择
     */
    clearAllSelections(): void {
        // 移除所有选择框
        this.selectionBoxes.forEach((box, _boxId) => {
            this.removeSelectionBoxElement(box.element);
        });
        this.selectionBoxes.clear();

        // 清除全局选中状态
        this.globallySelectedNodes.clear();

        if (this.graph) {
            // 取消所有节点的选中状态
            this.graph.getAllNodes().forEach(node => {
                node.setSelected(false);
            });
            // 清除 Graph 的选中状态引用
            (this.graph as any).selectedNode = null;
            this.graph.scheduleRender?.();
        }

        // 移除临时选择框
        this.removeTempSelectionBox();
    }

    /**
     * 清除特定选择框
     */
    clearSelectionBox(boxId: string): void {
        const box = this.selectionBoxes.get(boxId);
        if (!box) return;

        // 从全局选中集合中移除该选择框的节点
        box.nodeIds.forEach(nodeId => {
            this.globallySelectedNodes.delete(nodeId);
            // 检查节点是否在其他选择框中
            let inOtherBox = false;
            this.selectionBoxes.forEach((otherBox, otherId) => {
                if (otherId !== boxId && otherBox.nodeIds.has(nodeId)) {
                    inOtherBox = true;
                }
            });
            // 如果节点不在其他任何选择框中，取消其选中状态
            if (!inOtherBox) {
                const node = this.graph?.getAllNodes().find(n => n.getId() === nodeId);
                node?.setSelected(false);
            }
        });

        // 移除选择框元素
        this.removeSelectionBoxElement(box.element);
        this.selectionBoxes.delete(boxId);

        this.graph?.scheduleRender?.();
    }

    /**
     * 处理画布鼠标按下事件
     */
    private handleBlankMouseDown = (e: { x: number; y: number; originalEvent: MouseEvent }): void => {
        // 如果不是左键点击，不开始框选
        if (e.originalEvent.button !== 0) return;

        // 必须按住 Alt键才能开始框选
        if (!e.originalEvent.altKey) return;

        // 阻止事件传播，防止触发其他默认行为
        e.originalEvent.stopPropagation();

        this.isSelecting = true;
        this.selectionStartPoint = { x: e.x, y: e.y };
        this.selectionCurrentPoint = { x: e.x, y: e.y };

        // 创建临时选择框元素
        this.createTempSelectionBox();

        // 绑定全局事件监听（确保鼠标移出画布也能正常框选）
        this.addGlobalListeners();

        // 触发选择开始事件
        this.options.onSelectionStart?.({
            type: 'selection:start',
            selectedNodes: this.getSelectedNodes(),
            position: this.selectionStartPoint,
        });
    };

    /**
     * 处理画布鼠标移动事件（Graph事件）
     */
    private handleBlankMouseMove = (e: { x: number; y: number; originalEvent: MouseEvent }): void => {
        // 只有正在进行框选时才处理
        if (!this.isSelecting) return;

        // 阻止事件传播
        e.originalEvent.stopPropagation();

        this.updateSelection(e.x, e.y);
    };

    /**
     * 处理画布鼠标抬起事件（Graph事件）
     */
    private handleBlankMouseUp = (e: { x: number; y: number; originalEvent: MouseEvent }): void => {
        // 只有正在进行框选时才处理
        if (!this.isSelecting) return;

        // 阻止事件传播，防止 Graph 的默认处理取消选中
        e.originalEvent.stopPropagation();

        // 结束选择
        this.endSelection();
    };

    /**
     * 全局鼠标移动处理
     */
    private handleGlobalMouseMove = (e: globalThis.MouseEvent): void => {
        if (!this.isSelecting || !this.graph) return;

        // 将屏幕坐标转换为世界坐标
        const rect = this.graph.getCanvas().getBoundingClientRect();
        const screenPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        const worldPoint = this.graph.screenToWorld(screenPoint);

        this.updateSelection(worldPoint.x, worldPoint.y);
    };

    /**
     * 全局鼠标抬起处理
     */
    private handleGlobalMouseUp = (): void => {
        // 结束选择
        this.endSelection();
        // 移除全局事件监听
        this.removeGlobalListeners();
    };

    /**
     * 更新选择状态
     */
    private updateSelection(x: number, y: number): void {
        if (!this.isSelecting || !this.selectionStartPoint) return;

        this.selectionCurrentPoint = { x, y };

        // 更新临时选择框显示
        this.updateTempSelectionBox();

        // 触发选择移动事件
        this.options.onSelectionMove?.({
            type: 'selection:move',
            selectedNodes: this.getSelectedNodes(),
            bounds: this.getSelectionBounds(),
            position: this.selectionCurrentPoint,
        });
    }

    /**
     * 结束选择
     */
    private endSelection(): void {
        if (!this.isSelecting) return;

        this.isSelecting = false;

        // 计算选择框内的节点（排除已被其他选择框选中的）
        const newSelectedNodes = this.calculateNewSelectedNodes();

        // 如果有选中的节点，创建永久选择框
        if (newSelectedNodes.length > 0) {
            this.createPermanentSelectionBox(newSelectedNodes);
        }

        // 移除临时选择框
        this.removeTempSelectionBox();

        // 触发选择结束事件
        this.options.onSelectionEnd?.({
            type: 'selection:end',
            selectedNodes: this.getSelectedNodes(),
            bounds: this.getSelectionBounds(),
            position: this.selectionCurrentPoint || this.selectionStartPoint!,
        });

        this.selectionStartPoint = null;
        this.selectionCurrentPoint = null;
    }

    /**
     * 计算新选中的节点（排除已被其他选择框选中的）
     */
    private calculateNewSelectedNodes(): Node[] {
        if (!this.graph || !this.selectionStartPoint || !this.selectionCurrentPoint) return [];

        const bounds = this.getSelectionBounds();
        if (!bounds) return [];

        const allNodes = this.graph.getAllNodes();
        const newSelectedNodes: Node[] = [];

        allNodes.forEach(node => {
            const nodeBounds = node.getBounds();
            const nodeId = node.getId();

            // 检查节点是否与选择框相交或包含在内
            if (this.isRectIntersect(bounds, nodeBounds)) {
                // 如果节点已被其他选择框选中，则跳过（优先级保留第一个）
                if (!this.globallySelectedNodes.has(nodeId)) {
                    newSelectedNodes.push(node);
                }
            }
        });

        return newSelectedNodes;
    }

    /**
     * 创建临时选择框元素
     */
    private createTempSelectionBox(): void {
        if (!this.graph) return;

        this.tempSelectionBox = document.createElement('div');
        this.tempSelectionBox.style.position = 'absolute';
        this.tempSelectionBox.style.pointerEvents = 'none';
        this.tempSelectionBox.style.zIndex = '1000';
        this.tempSelectionBox.style.borderStyle = 'dashed';

        const style = this.options.selectionBoxStyle;
        if (style) {
            this.tempSelectionBox.style.borderColor = style.strokeColor || '#3b82f6';
            this.tempSelectionBox.style.borderWidth = `${style.strokeWidth || 2}px`;
            this.tempSelectionBox.style.backgroundColor = style.fillColor || 'rgba(59, 130, 246, 0.1)';
        }

        const canvas = this.graph.getCanvas();
        const container = canvas?.parentElement;
        if (container) {
            container.appendChild(this.tempSelectionBox);
        }

        this.updateTempSelectionBox();
    }

    /**
     * 更新临时选择框位置和大小
     */
    private updateTempSelectionBox(): void {
        if (!this.tempSelectionBox || !this.selectionStartPoint || !this.selectionCurrentPoint || !this.graph) return;

        // 将世界坐标转换为屏幕坐标
        const startScreen = this.graph.worldToScreen(this.selectionStartPoint);
        const currentScreen = this.graph.worldToScreen(this.selectionCurrentPoint);

        const minX = Math.min(startScreen.x, currentScreen.x);
        const minY = Math.min(startScreen.y, currentScreen.y);
        const maxX = Math.max(startScreen.x, currentScreen.x);
        const maxY = Math.max(startScreen.y, currentScreen.y);

        this.tempSelectionBox.style.left = `${minX}px`;
        this.tempSelectionBox.style.top = `${minY}px`;
        this.tempSelectionBox.style.width = `${maxX - minX}px`;
        this.tempSelectionBox.style.height = `${maxY - minY}px`;
    }

    /**
     * 移除临时选择框元素
     */
    private removeTempSelectionBox(): void {
        if (this.tempSelectionBox && this.tempSelectionBox.parentNode) {
            this.tempSelectionBox.parentNode.removeChild(this.tempSelectionBox);
            this.tempSelectionBox = null;
        }
    }

    /**
     * 创建永久选择框
     */
    private createPermanentSelectionBox(nodes: Node[]): void {
        if (!this.graph || nodes.length === 0) return;

        const boxId = `selection-box-${++this.selectionBoxCounter}`;

        // 创建选择框元素
        const element = document.createElement('div');
        element.style.position = 'absolute';
        element.style.pointerEvents = 'auto';
        element.style.zIndex = '1000';
        element.style.borderStyle = 'dashed';
        element.style.cursor = 'move';

        const style = this.options.selectionBoxStyle;
        if (style) {
            element.style.borderColor = style.strokeColor || '#3b82f6';
            element.style.borderWidth = `${style.strokeWidth || 2}px`;
            element.style.backgroundColor = style.fillColor || 'rgba(59, 130, 246, 0.1)';
        }

        // 创建删除按钮
        const deleteButton = document.createElement('div');
        deleteButton.innerHTML = '×';
        deleteButton.style.cssText = `
            position: absolute;
            top: -12px;
            right: -12px;
            width: 20px;
            height: 20px;
            background: #ef4444;
            color: white;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            font-size: 16px;
            font-weight: bold;
            box-shadow: 0 2px 4px rgba(0,0,0,0.2);
            pointer-events: auto;
            user-select: none;
            line-height: 1;
            padding-bottom: 2px;
        `;
        deleteButton.addEventListener('click', (e) => this.handleDeleteButtonClick(e, boxId));
        deleteButton.addEventListener('mousedown', (e) => e.stopPropagation());
        element.appendChild(deleteButton);

        const canvas = this.graph.getCanvas();
        const container = canvas?.parentElement;
        if (container) {
            container.appendChild(element);
        }

        // 收集节点ID
        const nodeIds = new Set<string>();
        nodes.forEach(node => {
            nodeIds.add(node.getId());
            node.setSelected(true);
        });

        // 添加到全局选中集合
        nodeIds.forEach(id => this.globallySelectedNodes.add(id));

        // 计算边界
        const bounds = this.calculateBounds(nodes);

        // 创建选择框数据
        const boxData: SelectionBoxData = {
            element,
            nodeIds,
            bounds,
            isDragging: false,
            dragStartPoint: null,
            nodeStartPositions: new Map(),
        };

        this.selectionBoxes.set(boxId, boxData);

        // 更新选择框位置和大小
        this.updateSelectionBoxElement(boxId);

        // 绑定选择框的鼠标事件
        element.addEventListener('mousedown', (e) => this.handleSelectionBoxMouseDown(e, boxId));

        // 触发重新渲染
        this.graph.scheduleRender?.();
    }

    /**
     * 计算节点的边界框
     */
    private calculateBounds(nodes: Node[]): { x: number; y: number; width: number; height: number } {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        nodes.forEach(node => {
            const bounds = node.getBounds();
            minX = Math.min(minX, bounds.x);
            minY = Math.min(minY, bounds.y);
            maxX = Math.max(maxX, bounds.x + bounds.width);
            maxY = Math.max(maxY, bounds.y + bounds.height);
        });

        // 添加一些内边距
        const padding = 10;
        return {
            x: minX - padding,
            y: minY - padding,
            width: maxX - minX + padding * 2,
            height: maxY - minY + padding * 2,
        };
    }

    /**
     * 更新选择框元素位置和大小
     */
    private updateSelectionBoxElement(boxId: string): void {
        const box = this.selectionBoxes.get(boxId);
        if (!box || !this.graph) return;

        // 将世界坐标转换为屏幕坐标
        const topLeftScreen = this.graph.worldToScreen({ x: box.bounds.x, y: box.bounds.y });
        const bottomRightScreen = this.graph.worldToScreen({
            x: box.bounds.x + box.bounds.width,
            y: box.bounds.y + box.bounds.height,
        });

        // 更新选择框位置和大小
        box.element.style.left = `${topLeftScreen.x}px`;
        box.element.style.top = `${topLeftScreen.y}px`;
        box.element.style.width = `${bottomRightScreen.x - topLeftScreen.x}px`;
        box.element.style.height = `${bottomRightScreen.y - topLeftScreen.y}px`;
    }

    /**
     * 移除选择框元素
     */
    private removeSelectionBoxElement(element: HTMLDivElement): void {
        if (element && element.parentNode) {
            element.parentNode.removeChild(element);
        }
    }

    /**
     * 处理删除按钮点击事件
     */
    private handleDeleteButtonClick(e: MouseEvent, boxId: string): void {
        e.stopPropagation();
        e.preventDefault();

        // 只清除该选择框，不删除节点
        this.clearSelectionBox(boxId);
    }

    /**
     * 处理选择框鼠标按下事件
     */
    private handleSelectionBoxMouseDown(e: MouseEvent, boxId: string): void {
        if (!this.graph || e.button !== 0) return;

        e.stopPropagation();
        e.preventDefault();

        const box = this.selectionBoxes.get(boxId);
        if (!box) return;

        box.isDragging = true;

        // 将屏幕坐标转换为世界坐标
        const rect = this.graph.getCanvas().getBoundingClientRect();
        const screenPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        box.dragStartPoint = this.graph.screenToWorld(screenPoint);

        // 记录所有选中节点的初始位置
        box.nodeStartPositions.clear();
        box.nodeIds.forEach(nodeId => {
            const node = this.graph!.getAllNodes().find(n => n.getId() === nodeId);
            if (node) {
                const pos = node.getPosition();
                box.nodeStartPositions.set(nodeId, { ...pos });
            }
        });

        // 绑定拖拽事件
        const handleMove = (ev: MouseEvent) => this.handleSelectionBoxDragMove(ev, boxId);
        const handleUp = () => {
            this.handleSelectionBoxDragEnd(boxId);
            document.removeEventListener('mousemove', handleMove);
            document.removeEventListener('mouseup', handleUp);
        };

        document.addEventListener('mousemove', handleMove);
        document.addEventListener('mouseup', handleUp);
    }

    /**
     * 处理选择框拖拽移动
     */
    private handleSelectionBoxDragMove(e: MouseEvent, boxId: string): void {
        const box = this.selectionBoxes.get(boxId);
        if (!box || !box.isDragging || !this.graph || !box.dragStartPoint) return;

        // 将屏幕坐标转换为世界坐标
        const rect = this.graph.getCanvas().getBoundingClientRect();
        const screenPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        const currentPoint = this.graph.screenToWorld(screenPoint);

        // 计算偏移量
        const deltaX = currentPoint.x - box.dragStartPoint.x;
        const deltaY = currentPoint.y - box.dragStartPoint.y;

        // 移动所有选中的节点
        box.nodeIds.forEach(nodeId => {
            const node = this.graph!.getAllNodes().find(n => n.getId() === nodeId);
            const startPos = box.nodeStartPositions.get(nodeId);
            if (node && startPos) {
                node.setPosition(startPos.x + deltaX, startPos.y + deltaY);
            }
        });

        // 更新选择框边界
        box.bounds.x = box.bounds.x + deltaX;
        box.bounds.y = box.bounds.y + deltaY;

        // 更新拖拽起始点
        box.dragStartPoint = currentPoint;

        // 更新选择框位置
        this.updateSelectionBoxElement(boxId);

        // 触发重新渲染
        this.graph.scheduleRender?.();

        // 更新节点初始位置为当前位置
        box.nodeIds.forEach(nodeId => {
            const node = this.graph!.getAllNodes().find(n => n.getId() === nodeId);
            if (node) {
                const pos = node.getPosition();
                box.nodeStartPositions.set(nodeId, { ...pos });
            }
        });
    }

    /**
     * 处理选择框拖拽结束
     */
    private handleSelectionBoxDragEnd(boxId: string): void {
        const box = this.selectionBoxes.get(boxId);
        if (!box) return;

        box.isDragging = false;
        box.dragStartPoint = null;
        box.nodeStartPositions.clear();
    }

    /**
     * 获取选择框的边界（世界坐标）
     */
    private getSelectionBounds(): { x: number; y: number; width: number; height: number } | undefined {
        if (!this.selectionStartPoint || !this.selectionCurrentPoint) return undefined;

        const minX = Math.min(this.selectionStartPoint.x, this.selectionCurrentPoint.x);
        const minY = Math.min(this.selectionStartPoint.y, this.selectionCurrentPoint.y);
        const maxX = Math.max(this.selectionStartPoint.x, this.selectionCurrentPoint.x);
        const maxY = Math.max(this.selectionStartPoint.y, this.selectionCurrentPoint.y);

        return {
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY,
        };
    }

    /**
     * 检查两个矩形是否相交
     */
    private isRectIntersect(
        rect1: { x: number; y: number; width: number; height: number },
        rect2: { x: number; y: number; width: number; height: number }
    ): boolean {
        return !(
            rect1.x + rect1.width < rect2.x ||
            rect2.x + rect2.width < rect1.x ||
            rect1.y + rect1.height < rect2.y ||
            rect2.y + rect2.height < rect1.y
        );
    }

    /**
     * 获取所有选择框的ID
     */
    getSelectionBoxIds(): string[] {
        return Array.from(this.selectionBoxes.keys());
    }

    /**
     * 获取选择框数量
     */
    getSelectionBoxCount(): number {
        return this.selectionBoxes.size;
    }
}

export default Selection;
