import { Node, NodeOptions, isRowHoverable, type RowHoverable, type ResizeHandlePosition, type NodeStyle } from './Node';
import { Edge, EdgeOptions, EdgeType } from './Edge';
import { Port } from './Port';
import { EventManager, EVENT_NAMES, type MouseEvent, type WheelEvent, type EventHandler } from './EventManager';
import { Plugin } from '../plugins';
import { Shape, ShapeConfig } from './Shape';
import { Viewport } from './Viewport';
import { GraphEventDispatcher } from './GraphEventDispatcher';
import { ConnectionManager } from './interactions/ConnectionManager';
import { ResizeManager } from './interactions/ResizeManager';
import { DragManager } from './interactions/DragManager';
import { getLineSegmentIntersection, resolveEdgeEndpoints } from './utils/geometry';

export interface Point {
    x: number;
    y: number;
}

/**
 * 连接验证上下文 - 提供给验证函数的连接信息
 */
export interface ConnectionValidateContext {
    /** 源节点 */
    sourceNode: Node;
    /** 源连接桩 */
    sourcePort: Port;
    /** 目标节点 */
    targetNode: Node;
    /** 目标连接桩 */
    targetPort: Port;
}

/**
 * 连接验证函数类型
 * @param context - 连接验证上下文
 * @returns 返回 true 允许连接，返回 false 阻止连接
 */
export type ConnectionValidator = (context: ConnectionValidateContext) => boolean;

import type { DropdownOptions } from '../plugins/Dropdown';

export interface GraphOptions {
    /** 容器元素 */
    container: HTMLElement;
    /** 画布宽度 */
    width?: number;
    /** 画布高度 */
    height?: number;
    /** 初始偏移 X */
    initialOffsetX?: number;
    /** 初始偏移 Y */
    initialOffsetY?: number;
    /** 最小缩放比例 */
    minZoom?: number;
    /** 最大缩放比例 */
    maxZoom?: number;
    /** 是否启用拖拽 */
    draggable?: boolean;
    /** 是否启用缩放 */
    scalable?: boolean;
    /** 拖拽时的光标样式 */
    draggingCursor?: string;
    /** 拖拽完成回调 */
    onDragEnd?: (offset: Point) => void;
    /** 缩放完成回调 */
    onZoom?: (scale: number, offset: Point) => void;
    /** 节点选中回调 */
    onNodeSelect?: (node: Node | null) => void;
    /** 背景颜色 */
    backgroundColor?: string;
    /** 网格配置 */
    grid?: {
        enabled: boolean;
        size?: number;
        color?: string;
        /** 网格类型：'mesh' 为线状网格（默认），'dot' 为点状网格 */
        type?: 'mesh' | 'dot';
    };
    /**
     * 连接验证函数
     * 当用户尝试连接两个连接桩时调用，返回 true 允许连接，返回 false 阻止连接
     * @example
     * ```typescript
     * const graph = new Graph({
     *     container: document.getElementById('canvas'),
     *     validateConnection: ({ sourceNode, sourcePort, targetNode, targetPort }) => {
     *         // 示例1: 不允许连接到同一个节点
     *         if (sourceNode.getId() === targetNode.getId()) {
     *             return false;
     *         }
     *         // 示例2: 只允许左侧连接桩连接到右侧连接桩
     *         const sourcePos = sourcePort.getPosition();
     *         const targetPos = targetPort.getPosition();
     *         if (sourcePos !== 'right' || targetPos !== 'left') {
     *             return false;
     *         }
     *         return true;
     *     }
     * });
     * ```
     */
    validateConnection?: ConnectionValidator;
    /**
     * 右键菜单配置
     * 配置后将自动创建并注册 Dropdown 插件
     * @example
     * ```typescript
     * const graph = new Graph({
     *     container: document.getElementById('canvas'),
     *     dropdown: {
     *         nodeMenu: [
     *             { label: '删除节点', icon: '🗑️', danger: true, action: (node) => graph.removeNode(node.getId()) },
     *         ],
     *         blankMenu: [
     *             { label: '添加节点', icon: '➕', action: (e) => graph.addNode({ x: e.x, y: e.y, label: '新节点' }) },
     *         ],
     *     },
     * });
     * ```
     */
    dropdown?: DropdownOptions;
}

/**
 * @deprecated 画布平移状态已迁移至 DragManager，此接口仅为兼容现有导出而保留
 */
export interface GraphState {
    isDragging: boolean;
    lastMousePosition: Point | null;
}

/**
 * Graph - 可拖拽、可缩放的画布组件
 *
 * 功能特性：
 * - 鼠标拖拽平移画布
 * - 鼠标滚轮缩放
 * - 支持设置边界限制
 * - 网格背景（可选）
 * - 流畅的动画效果
 */
/**
 * 生成 UUID v4 格式的字符串
 * @returns UUID 字符串
 */
function generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

export class Graph {
    private container: HTMLElement;
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private overlay: HTMLDivElement;
    private edgeCanvas: HTMLCanvasElement;
    private edgeCtx: CanvasRenderingContext2D;
    private options: Omit<Required<GraphOptions>, 'dropdown'> & { dropdown?: DropdownOptions };
    private viewport: Viewport;
    private nodes: Map<string, Node> = new Map();
    private edges: Map<string, Edge> = new Map();
    private selectedNode: Node | null = null;
    private selectedEdge: Edge | null = null;
    private hoveredNode: Node | null = null;
    private hoveredEdge: Edge | null = null;

    // 鼠标交互状态机（连接 / 缩放 / 拖拽，从 Graph 抽取）
    private connectionManager: ConnectionManager;
    private resizeManager: ResizeManager;
    private dragManager: DragManager;

    private rafId: number | null = null;

    // HTML 节点元素管理
    private htmlNodeElements: Map<string, HTMLElement> = new Map();
    private boundHandlers: {
        onMouseDown: (e: globalThis.MouseEvent) => void;
        onMouseMove: (e: globalThis.MouseEvent) => void;
        onMouseUp: (e: globalThis.MouseEvent) => void;
        onMouseLeave: (e: globalThis.MouseEvent) => void;
        onWheel: (e: globalThis.WheelEvent) => void;
        onResize: () => void;
        onClick: (e: globalThis.MouseEvent) => void;
        onDblClick: (e: globalThis.MouseEvent) => void;
        onContextMenu: (e: globalThis.MouseEvent) => void;
        onMouseEnter: (e: globalThis.MouseEvent) => void;
        onMouseLeaveCanvas: (e: globalThis.MouseEvent) => void;
    };

    // ResizeObserver 用于监听容器尺寸变化
    private resizeObserver: ResizeObserver | null = null;

    // 事件管理器
    private eventManager: EventManager;

    // 事件分发器（鼠标事件到图元素的路由与悬停跟踪）
    private eventDispatcher: GraphEventDispatcher;

    // 已注册的插件
    private plugins: Map<string, Plugin> = new Map();

    // 记录待取消选中的节点（用于延迟触发 node:unselected 事件）
    private nodeToUnselect: Node | null = null;

    // ==================== 静态形状注册表 ====================
    
    /**
     * 全局形状注册表
     * 存储已注册的自定义形状配置
     */
    private static shapeRegistry: Map<string, {
        width?: number;
        height?: number;
        shape?: ShapeConfig;
        style?: Partial<NodeStyle>;
        resizable?: boolean;
        component?: any; // React 组件或其他渲染组件
        ports?: any[];
        inheritStyle?: boolean;
        [key: string]: any;
    }> = new Map();

    /**
     * 注册自定义形状
     * @param config - 形状配置
     * @example
     * ```typescript
     * // 注册一个简单的矩形形状
     * Graph.register({
     *     shape: 'custom-rect',
     *     width: 100,
     *     height: 60,
     *     style: {
     *         backgroundColor: '#e0f2fe',
     *         borderColor: '#0ea5e9',
     *     }
     * });
     *
     * // 注册 React 组件形状（推荐直接使用 register() 函数）
     * Graph.register({
     *     shape: 'react-node',
     *     width: 200,
     *     height: 100,
     *     component: MyReactComponent,
     * });
     *
     * // 使用注册的形状
     * graph.addNode({
     *     shape: 'custom-rect',
     *     x: 100,
     *     y: 100,
     * });
     * ```
     *
     * @note 当配置中包含 `component` 属性时，会自动使用 ReactShape 插件进行注册。
     *       推荐直接使用 {@link register} 函数以获得更简洁的 API 体验。
     */
    static register(config: {
        shape: string;
        width?: number;
        height?: number;
        shapeConfig?: ShapeConfig;
        style?: Partial<NodeStyle>;
        resizable?: boolean;
        component?: any;
        ports?: any[];
        inheritStyle?: boolean;
        [key: string]: any;
    }): void {
        if (!config.shape) {
            console.error('Shape name is required for registration.');
            return;
        }
        
        if (Graph.shapeRegistry.has(config.shape)) {
            console.warn(`Shape "${config.shape}" is already registered. It will be overwritten.`);
        }
        
        const { shape: shapeName, shapeConfig, ...restConfig } = config;
        
        // 如果是 React 组件，使用 ReactShape 的全局注册
        if (config.component) {
            // 动态导入以避免循环依赖
            import('../plugins/ReactShape').then(({ registerReactShape }) => {
                registerReactShape({
                    shape: shapeName,
                    width: config.width ?? 200,
                    height: config.height ?? 100,
                    component: config.component,
                    style: config.style,
                    resizable: config.resizable ?? false,
                    ports: config.ports,
                    inheritStyle: config.inheritStyle,
                    ...restConfig,
                });
            });
            return;
        }
        
        Graph.shapeRegistry.set(shapeName, {
            width: config.width,
            height: config.height,
            shapeConfig: shapeConfig,
            style: config.style,
            resizable: config.resizable,
            component: config.component,
            ports: config.ports,
            inheritStyle: config.inheritStyle,
            ...restConfig,
        });
    }

    /**
     * 注销形状
     * @param shapeName - 形状名称
     * @returns 是否成功注销
     */
    static unregister(shapeName: string): boolean {
        return Graph.shapeRegistry.delete(shapeName);
    }

    /**
     * 获取已注册的形状配置
     * @param shapeName - 形状名称
     * @returns 形状配置或 undefined
     */
    static getRegisteredShape(shapeName: string): any {
        return Graph.shapeRegistry.get(shapeName);
    }

    /**
     * 检查形状是否已注册
     * @param shapeName - 形状名称
     * @returns 是否已注册
     */
    static hasRegisteredShape(shapeName: string): boolean {
        return Graph.shapeRegistry.has(shapeName);
    }

    /**
     * 获取所有已注册的形状名称
     * @returns 形状名称数组
     */
    static getRegisteredShapes(): string[] {
        return Array.from(Graph.shapeRegistry.keys());
    }

    /**
     * 清空所有已注册的形状
     */
    static clearRegisteredShapes(): void {
        Graph.shapeRegistry.clear();
    }

    // 默认配置
    private static readonly DEFAULT_OPTIONS: Omit<
        Required<GraphOptions>,
        'container' | 'dropdown'
    > = {
            width: 800,
            height: 600,
            initialOffsetX: 0,
            initialOffsetY: 0,
            minZoom: 0.1,
            maxZoom: 5,
            draggable: true,
            scalable: true,
            draggingCursor: 'grabbing',
            onDragEnd: () => { },
            onZoom: () => { },
            onNodeSelect: () => { },
            backgroundColor: '#ffffff',
            grid: {
                enabled: true,
                size: 20,
                color: '#e5e7eb',
                type: 'mesh',
            },
            validateConnection: () => true, // 默认允许所有连接
        };

    constructor(options: GraphOptions) {
        this.options = {
            ...Graph.DEFAULT_OPTIONS,
            ...options,
            grid: {
                ...Graph.DEFAULT_OPTIONS.grid,
                ...options.grid,
            },
        };

        this.container = options.container;
        this.viewport = new Viewport({
            x: this.options.initialOffsetX,
            y: this.options.initialOffsetY,
        });

        // 初始化事件管理器
        this.eventManager = new EventManager();

        // 初始化事件分发器
        this.eventDispatcher = new GraphEventDispatcher(this);

        // 初始化鼠标交互状态机
        this.connectionManager = new ConnectionManager(this);
        this.resizeManager = new ResizeManager(this);
        this.dragManager = new DragManager(this);

        // 创建画布元素
        this.canvas = this.createCanvas();
        this.ctx = this.canvas.getContext('2d')!;

        // 创建 overlay 层
        this.overlay = this.createOverlay();

        // 创建边线层（在 HTML 节点上方）
        this.edgeCanvas = this.createEdgeCanvas();
        this.edgeCtx = this.edgeCanvas.getContext('2d')!;

        // 绑定事件处理器
        this.boundHandlers = {
            onMouseDown: this.handleMouseDown.bind(this),
            onMouseMove: this.handleMouseMove.bind(this),
            onMouseUp: this.handleMouseUp.bind(this),
            onMouseLeave: this.handleMouseLeave.bind(this),
            onWheel: this.handleWheel.bind(this),
            onResize: this.handleResize.bind(this),
            onClick: this.handleClick.bind(this),
            onDblClick: this.handleDblClick.bind(this),
            onContextMenu: this.handleContextMenu.bind(this),
            onMouseEnter: (e: globalThis.MouseEvent) => this.eventDispatcher.handleMouseEnterLeave(e),
            onMouseLeaveCanvas: (e: globalThis.MouseEvent) => this.eventDispatcher.handleMouseEnterLeave(e),
        };

        this.init();
    }

    /**
     * 创建 Canvas 元素
     */
    private createCanvas(): HTMLCanvasElement {
        const canvas = document.createElement('canvas');
        canvas.style.cssText = `
      display: block;
      width: 100%;
      height: 100%;
      cursor: default;
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
      position: relative;
      z-index: 1;
    `;
        return canvas;
    }

    /**
     * 创建 Overlay 层用于放置 HTML 节点
     */
    private createOverlay(): HTMLDivElement {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      overflow: hidden;
      z-index: 2;
    `;
        return overlay;
    }

    /**
     * 创建边线层 Canvas（在 HTML 节点上方）
     */
    private createEdgeCanvas(): HTMLCanvasElement {
        const canvas = document.createElement('canvas');
        canvas.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 3;
    `;
        return canvas;
    }

    /**
     * 获取 Overlay 层
     */
    getOverlay(): HTMLDivElement {
        return this.overlay;
    }

    /**
     * 添加 HTML 节点元素到 Overlay
     */
    addHtmlNodeElement(nodeId: string, element: HTMLElement): void {
        this.htmlNodeElements.set(nodeId, element);
        // 确保 HTML 节点可以接收鼠标事件
        element.style.pointerEvents = 'auto';
        this.overlay.appendChild(element);
    }

    /**
     * 移除 HTML 节点元素
     */
    removeHtmlNodeElement(nodeId: string): void {
        const element = this.htmlNodeElements.get(nodeId);
        if (element && element.parentNode === this.overlay) {
            this.overlay.removeChild(element);
        }
        this.htmlNodeElements.delete(nodeId);
    }

    /**
     * 获取 HTML 节点元素
     */
    getHtmlNodeElement(nodeId: string): HTMLElement | undefined {
        return this.htmlNodeElements.get(nodeId);
    }

    /**
     * 更新 HTML 节点的位置和变换
     */
    updateHtmlNodeTransform(node: Node): void {
        const element = this.htmlNodeElements.get(node.getId());
        if (element) {
            const pos = node.getPosition();
            const { offset, scale } = this.viewport;
            // 计算屏幕坐标 = 世界坐标 * 缩放 + 偏移
            const screenX = pos.x * scale + offset.x;
            const screenY = pos.y * scale + offset.y;
            // CSS transform：位移 + 缩放，使 HTML 节点随画布同步缩放
            element.style.transform = `translate(${screenX}px, ${screenY}px) translate(-50%, -50%) scale(${scale})`;
        }
    }

    /**
     * 同步所有 HTML 节点的位置和变换
     */
    syncHtmlNodeTransforms(): void {
        // 只更新 HTML 节点的位置，而不是所有节点
        this.htmlNodeElements.forEach((_element, nodeId) => {
            const node = this.nodes.get(nodeId);
            if (node) {
                this.updateHtmlNodeTransform(node);
            }
        });
    }

    /**
     * 初始化组件
     */
    private init(): void {
        // 设置容器样式
        this.container.style.cssText = `
      position: relative;
      overflow: hidden;
      width: 100%;
      height: 100%;
    `;

        // 添加画布到容器（底层：网格和节点）
        this.container.appendChild(this.canvas);

        // 添加 overlay 层到容器（中层：HTML 节点）
        this.container.appendChild(this.overlay);

        // 添加边线层到容器（顶层：边线，在 HTML 节点上方）
        this.container.appendChild(this.edgeCanvas);

        // 设置画布尺寸
        this.resizeCanvas();

        // 绑定事件
        this.bindEvents();

        // 初始渲染
        this.render();

        // 自动注册 Dropdown 插件（如果配置了 dropdown 选项）
        if (this.options.dropdown) {
            // 动态导入以避免循环依赖
            import('../plugins/Dropdown').then(({ Dropdown }) => {
                this.use(new Dropdown(this.options.dropdown!));
            });
        }
    }

    /**
     * 调整画布尺寸
     */
    private resizeCanvas(): void {
        // 使用 requestAnimationFrame 避免 ResizeObserver loop 错误
        requestAnimationFrame(() => {
            if (!this.container || !this.canvas) return;
            
            const rect = this.container.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;

            // 调整主画布尺寸
            this.canvas.width = rect.width * dpr;
            this.canvas.height = rect.height * dpr;
            this.canvas.style.width = `${rect.width}px`;
            this.canvas.style.height = `${rect.height}px`;

            // 调整边线层画布尺寸
            this.edgeCanvas.width = rect.width * dpr;
            this.edgeCanvas.height = rect.height * dpr;
            this.edgeCanvas.style.width = `${rect.width}px`;
            this.edgeCanvas.style.height = `${rect.height}px`;

            // 重置变换矩阵并设置上下文缩放以适应 DPR
            this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            this.edgeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

            this.render();
        });
    }

    /**
     * 绑定事件
     */
    private bindEvents(): void {
        if (this.options.draggable) {
            this.canvas.addEventListener('mousedown', this.boundHandlers.onMouseDown);
            // 给 overlay 也添加 mousedown 监听，支持 HTML 节点拖拽
            this.overlay.addEventListener('mousedown', this.boundHandlers.onMouseDown);
            document.addEventListener('mousemove', this.boundHandlers.onMouseMove);
            document.addEventListener('mouseup', this.boundHandlers.onMouseUp);
            this.canvas.addEventListener(
                'mouseleave',
                this.boundHandlers.onMouseLeave
            );
            // 给 overlay 添加 mousemove 监听，确保在 HTML 节点上移动时也能更新连接预览线
            this.overlay.addEventListener('mousemove', this.boundHandlers.onMouseMove);
        }

        if (this.options.scalable) {
            this.canvas.addEventListener('wheel', this.boundHandlers.onWheel, {
                passive: false,
            });
        }

        // 添加 click、dblclick、contextmenu 事件监听
        this.canvas.addEventListener('click', this.boundHandlers.onClick);
        this.canvas.addEventListener('dblclick', this.boundHandlers.onDblClick);
        this.canvas.addEventListener('contextmenu', this.boundHandlers.onContextMenu);

        window.addEventListener('resize', this.boundHandlers.onResize);

        // 使用 ResizeObserver 监听容器尺寸变化（用于 Splitter 等场景）
        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => {
                this.handleResize();
            });
            this.resizeObserver.observe(this.container);
        }
    }

    /**
     * 解绑事件
     */
    private unbindEvents(): void {
        this.canvas.removeEventListener(
            'mousedown',
            this.boundHandlers.onMouseDown
        );
        this.overlay.removeEventListener(
            'mousedown',
            this.boundHandlers.onMouseDown
        );
        document.removeEventListener('mousemove', this.boundHandlers.onMouseMove);
        document.removeEventListener('mouseup', this.boundHandlers.onMouseUp);
        this.overlay.removeEventListener('mousemove', this.boundHandlers.onMouseMove);
        this.canvas.removeEventListener(
            'mouseleave',
            this.boundHandlers.onMouseLeave
        );
        this.canvas.removeEventListener('wheel', this.boundHandlers.onWheel);
        window.removeEventListener('resize', this.boundHandlers.onResize);

        // 移除 click、dblclick、contextmenu 监听器
        this.canvas.removeEventListener('click', this.boundHandlers.onClick);
        this.canvas.removeEventListener('dblclick', this.boundHandlers.onDblClick);
        this.canvas.removeEventListener('contextmenu', this.boundHandlers.onContextMenu);

        // 断开 ResizeObserver
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
    }

    /**
     * 鼠标按下处理
     */
    private handleMouseDown(e: globalThis.MouseEvent): void {
        if (!this.options.draggable) return;

        // 检查是否点击了表单元素，如果是则不拖拽
        const target = e.target as HTMLElement;
        const isFormElement = ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName) ||
                              target.isContentEditable;
        
        if (isFormElement) {
            // 点击表单元素时不拖拽，但允许事件继续传播
            return;
        }

        // 检查点击目标是否在当前 graph 容器内
        const targetElement = e.target as HTMLElement;
        if (!this.container.contains(targetElement) && targetElement !== this.container) {
            return;
        }

        e.preventDefault();

        // 将鼠标位置转换为世界坐标（使用容器的坐标系）
        const rect = this.container.getBoundingClientRect();
        const screenPoint: Point = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
        };
        const worldPoint = this.screenToWorld(screenPoint);

        // 检查点击目标（一次遍历）
        const nodes = this.getAllNodes();
        let clickedNode: Node | null = null;
        let clickedPort: Port | null = null;
        let clickedResizeHandle: ResizeHandlePosition | null = null;
        
        for (let i = nodes.length - 1; i >= 0; i--) {
            // 先检查是否点击了 resize handle（只对选中的节点）
            if (nodes[i].getSelected()) {
                const resizeHandle = nodes[i].getResizeHandleAtPoint(worldPoint);
                if (resizeHandle) {
                    clickedNode = nodes[i];
                    clickedResizeHandle = resizeHandle;
                    break;
                }
            }
            
            // 再检查连接桩
            const port = nodes[i].getPortAtPoint(worldPoint);
            if (port) {
                clickedPort = port;
                clickedNode = nodes[i];
                break;
            }
            
            // 再检查节点主体
            if (nodes[i].containsPoint(worldPoint)) {
                clickedNode = nodes[i];
                break;
            }
        }

        // 检查是否点击了边（只有在没有点击节点时才检查）
        let clickedEdge: Edge | null = null;
        if (!clickedNode) {
            const edges = this.getAllEdges();
            for (let i = edges.length - 1; i >= 0; i--) {
                if (edges[i].containsPoint(worldPoint)) {
                    clickedEdge = edges[i];
                    break;
                }
            }
        }

        // 分发 mousedown 事件（复用已检测的结果）
        this.eventDispatcher.dispatchMouseEventWithTarget('mousedown', e, worldPoint, clickedNode, clickedPort);

        // 如果点击了 resize handle，开始 resize
        if (clickedNode && clickedResizeHandle) {
            this.resizeManager.start(clickedNode, clickedResizeHandle, worldPoint);
            return;
        }

        // 如果点击了连接桩，开始连接拖拽
        if (clickedPort && clickedNode) {
            this.connectionManager.start(clickedNode, clickedPort, worldPoint);
            return;
        }

        // 如果点击了边，开始拖拽边
        if (clickedEdge) {
            this.dragManager.startEdgeDrag(clickedEdge, screenPoint);
            return;
        }

        if (clickedNode) {
            // 开始拖拽节点
            this.dragManager.startNodeDrag(clickedNode, screenPoint, worldPoint, e);
        } else {
            // 如果按住 Alt键，不启动画布拖拽（留给 Selection插件处理框选）
            if (e.altKey) {
                return;
            }
            // 拖拽画布
            this.dragManager.startPan(e.clientX, e.clientY);
        }
    }

    /**
     * 鼠标移动处理
     */
    private handleMouseMove(e: globalThis.MouseEvent): void {
        // 处理 resize
        if (this.resizeManager.isActive()) {
            const worldPoint = this.eventToWorldPoint(e);

            this.resizeManager.update(worldPoint);
            return;
        }

        // 处理连接拖拽
        if (this.connectionManager.isActive()) {
            const worldPoint = this.eventToWorldPoint(e);

            this.connectionManager.updateTarget(worldPoint);
            return;
        }

        // 处理边拖拽
        if (this.dragManager.isEdgeDragging()) {
            const screenPoint = this.eventToScreenPoint(e);

            this.dragManager.updateEdgeDrag(screenPoint);
            return;
        }

        // 处理节点拖拽
        if (this.dragManager.isNodeDragging()) {
            const screenPoint = this.eventToScreenPoint(e);

            this.dragManager.updateNodeDrag(screenPoint, e);
            return;
        }

        // 处理画布拖拽
        if (this.dragManager.updatePan(e.clientX, e.clientY)) {
            return;
        }

        // 处理鼠标悬停状态（非拖拽状态下）
        this.eventDispatcher.handleMouseEnterLeave(e);

        // 处理 resize handle 悬停时的光标变化
        if (!this.resizeManager.isActive() && !this.connectionManager.isActive() && !this.dragManager.isNodeDragging() && !this.dragManager.isPanningActive()) {
            this.resizeManager.handleHover(e);
        }

        // 处理行级悬停节点的行悬停状态
        this.handleDynamicNodeRowHover(e);
    }

    /**
     * 点击事件处理
     */
    private handleClick(e: globalThis.MouseEvent): void {
        this.eventDispatcher.dispatchMouseEvent('click', e);
    }

    /**
     * 双击事件处理
     */
    private handleDblClick(e: globalThis.MouseEvent): void {
        this.eventDispatcher.dispatchMouseEvent('dblclick', e);
    }

    /**
     * 右键菜单事件处理
     */
    private handleContextMenu(e: globalThis.MouseEvent): void {
        e.preventDefault();
        this.eventDispatcher.dispatchMouseEvent('contextmenu', e);
    }

    /**
     * 鼠标释放处理
     */
    private handleMouseUp(e: globalThis.MouseEvent): void {
        // 将鼠标位置转换为世界坐标
        const worldPoint = this.eventToWorldPoint(e);

        // 处理 resize 结束
        if (this.resizeManager.isActive()) {
            this.resizeManager.complete();
            return;
        }

        // 处理连接拖拽结束
        if (this.connectionManager.isActive()) {
            this.connectionManager.complete();
            return;
        }

        // 处理边拖拽结束
        if (this.dragManager.isEdgeDragging()) {
            this.dragManager.completeEdgeDrag();
            return;
        }

        // 处理节点拖拽结束
        if (this.dragManager.completeNodeDrag(e, worldPoint)) {
            return;
        }

        // 分发 mouseup 事件
        this.eventDispatcher.dispatchMouseEvent('mouseup', e);

        // 处理画布拖拽结束
        if (!this.dragManager.isPanningActive()) {
            return;
        }

        this.dragManager.completePan();
    }

    /**
     * 鼠标离开处理
     */
    private handleMouseLeave(e: globalThis.MouseEvent): void {
        // 如果正在 resize，取消 resize
        if (this.resizeManager.isActive()) {
            this.resizeManager.reset();
            return;
        }

        // 如果正在连接，取消连接
        if (this.connectionManager.isActive()) {
            this.connectionManager.cancel();
            return;
        }

        // 如果正在拖拽边，完成拖拽（保留偏移）
        if (this.dragManager.isEdgeDragging()) {
            this.dragManager.completeEdgeDrag();
            return;
        }

        if (this.dragManager.isPanningActive()) {
            this.handleMouseUp(e);
        }
        
        // 触发 mouseleave 事件
        this.eventDispatcher.handleMouseEnterLeave(e);
        
        // 清除所有悬停状态
        if (this.hoveredNode) {
            this.hoveredNode.setHovered(false);
            this.hoveredNode = null;
        }
        if (this.hoveredEdge) {
            this.hoveredEdge.setHovered(false);
            this.hoveredEdge = null;
            this.scheduleRender();
        }
    }

    /**
     * 滚轮缩放处理
     */
    private handleWheel(e: WheelEvent): void {
        if (!this.options.scalable) return;

        (e as globalThis.WheelEvent).preventDefault();

        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // 计算缩放前鼠标在世界坐标系中的位置
        const worldX = (mouseX - this.viewport.offset.x) / this.viewport.scale;
        const worldY = (mouseY - this.viewport.offset.y) / this.viewport.scale;

        // 检查鼠标是否在空白区域
        const worldPoint: Point = { x: worldX, y: worldY };
        let isOnElement = false;

        // 检查是否在节点上
        const nodes = this.getAllNodes();
        for (let i = nodes.length - 1; i >= 0; i--) {
            if (nodes[i].containsPoint(worldPoint)) {
                isOnElement = true;
                break;
            }
        }

        // 如果不在节点上，检查是否在边上
        if (!isOnElement) {
            const edges = this.getAllEdges();
            for (let i = edges.length - 1; i >= 0; i--) {
                if (edges[i].containsPoint(worldPoint)) {
                    isOnElement = true;
                    break;
                }
            }
        }

        // 如果在空白区域，触发 blank:mousewheel 事件
        if (!isOnElement) {
            this.eventDispatcher.dispatchMouseEvent('mousewheel', e as globalThis.WheelEvent);
        }

        // 计算新的缩放比例
        const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
        const newScale = Math.max(
            this.options.minZoom,
            Math.min(this.options.maxZoom, this.viewport.scale * zoomFactor)
        );

        // 计算新的偏移量，保持鼠标指向的世界坐标不变
        this.viewport.scale = newScale;
        this.viewport.offset.x = mouseX - worldX * newScale;
        this.viewport.offset.y = mouseY - worldY * newScale;

        this.scheduleRender();

        // 触发缩放回调
        this.options.onZoom(this.viewport.scale, { ...this.viewport.offset });
    }

    /**
     * 窗口大小变化处理
     */
    private handleResize(): void {
        this.resizeCanvas();
    }

    /**
     * 调度渲染（使用 requestAnimationFrame 优化性能）
     */
    scheduleRender(): void {
        if (this.rafId !== null) return;

        this.rafId = requestAnimationFrame(() => {
            this.rafId = null;
            this.render();
        });
    }

    /**
     * 渲染画布
     */
    private render(): void {
        // destroy 后 canvas/ctx 已置空：进行中的 panTo/zoomTo 等动画帧直接丢弃
        if (!this.canvas || !this.ctx || !this.edgeCtx) return;
        const { width, height } = this.canvas.getBoundingClientRect();

        // 清空主画布
        this.ctx.clearRect(0, 0, width, height);

        // 清空边线层画布
        this.edgeCtx.clearRect(0, 0, width, height);

        // 保存当前上下文状态
        this.ctx.save();
        this.edgeCtx.save();

        // 应用变换
        this.ctx.translate(this.viewport.offset.x, this.viewport.offset.y);
        this.ctx.scale(this.viewport.scale, this.viewport.scale);
        this.edgeCtx.translate(this.viewport.offset.x, this.viewport.offset.y);
        this.edgeCtx.scale(this.viewport.scale, this.viewport.scale);

        // 绘制背景
        this.drawBackground();

        // 绘制网格
        if (this.options.grid.enabled) {
            this.drawGrid(width, height);
        }

        // 绘制所有节点（在主画布上）
        this.renderNodes();

        // 绘制所有边和连接桩（在边线层上，按 zIndex 排序混合绘制）
        this.renderEdgesAndPorts();

        // 绘制连接中的临时连线（在边线层上）
        this.connectionManager.renderConnectingEdge(this.edgeCtx);

        // 恢复上下文状态
        this.ctx.restore();
        this.edgeCtx.restore();

        // 同步 HTML 节点的位置和缩放
        this.syncHtmlNodeTransforms();

        // 触发自定义绘制
        this.onRender();
    }

    /**
     * 绘制背景
     */
    private drawBackground(): void {
        // 背景色已经在 CSS 中设置，这里可以添加额外的背景效果
    }

    /**
     * 绘制网格
     */
    private drawGrid(viewWidth: number, viewHeight: number): void {
        const size = this.options.grid.size ?? 20;
        const color = this.options.grid.color ?? '#e5e7eb';
        const type = this.options.grid.type ?? 'mesh';
        const { offset, scale } = this.viewport;

        // 计算可见区域在世界坐标系中的范围
        const startX = -offset.x / scale;
        const startY = -offset.y / scale;
        const endX = startX + viewWidth / scale;
        const endY = startY + viewHeight / scale;

        // 计算网格线起点（对齐到网格）
        const gridStartX = Math.floor(startX / size) * size;
        const gridStartY = Math.floor(startY / size) * size;
        const gridEndX = Math.ceil(endX / size) * size;
        const gridEndY = Math.ceil(endY / size) * size;

        this.ctx.save();

        if (type === 'dot') {
            // 绘制点状网格
            this.ctx.fillStyle = color;
            const dotRadius = Math.max(1, 1 / scale);
            
            for (let x = gridStartX; x <= gridEndX; x += size) {
                for (let y = gridStartY; y <= gridEndY; y += size) {
                    this.ctx.beginPath();
                    this.ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
                    this.ctx.fill();
                }
            }
        } else {
            // 绘制线状网格（默认）
            this.ctx.strokeStyle = color;
            this.ctx.lineWidth = 1 / scale;

            this.ctx.beginPath();

            // 绘制垂直线
            for (let x = gridStartX; x <= gridEndX; x += size) {
                this.ctx.moveTo(x, gridStartY);
                this.ctx.lineTo(x, gridEndY);
            }

            // 绘制水平线
            for (let y = gridStartY; y <= gridEndY; y += size) {
                this.ctx.moveTo(gridStartX, y);
                this.ctx.lineTo(gridEndX, y);
            }

            this.ctx.stroke();
        }

        this.ctx.restore();
    }

    /**
     * 自定义渲染钩子（子类可重写）
     */
    protected onRender(): void {
        // 子类可以重写此方法添加自定义绘制逻辑
    }

    // ==================== 节点管理方法 ====================

    /**
     * 添加节点
     * @param nodeOrOptions - 节点配置或节点实例
     * @returns 节点实例
     *
     * @example
     * ```typescript
     * // 添加普通节点
     * graph.addNode({
     *     x: 100,
     *     y: 100,
     *     style: { width: 100, height: 60 },
     * });
     *
     * // 使用已注册的形状添加节点
     * graph.addNode({
     *     shape: 'custom-rect',
     *     x: 100,
     *     y: 100,
     * });
     *
     * // 使用 React 组件形状添加节点（自动识别）
     * // 需要先安装 ReactShape 插件: graph.use(new ReactShape())
     * graph.addNode({
     *     shape: 'react-node',
     *     x: 100,
     *     y: 100,
     *     data: { label: 'Node' },
     * });
     * ```
     *
     * @note 当使用 React 形状时，需要先安装 ReactShape 插件。
     *       如果检测到 shape 是已注册的 React 形状，会自动创建 ReactShapeNode。
     */
    addNode(nodeOrOptions: NodeOptions | Node): Node {
        let node: Node;
        if (nodeOrOptions instanceof Node) {
            node = nodeOrOptions;
        } else {
            // 检查是否使用了已注册的形状
            const options = nodeOrOptions as any;
            const shapeName = options.shape;
            // 如果没有提供 id，自动生成 node-{uuid} 格式的 ID
            if (!options.id) {
                options.id = `node-${generateUUID()}`;
            }
            
            if (typeof shapeName === 'string' && Graph.hasRegisteredShape(shapeName)) {
                // 使用已注册的形状配置创建节点
                const registeredConfig = Graph.getRegisteredShape(shapeName);
                const mergedOptions = this.mergeRegisteredConfig(options, registeredConfig);
                node = new Node(mergedOptions);
            } else {
                node = new Node(options);
            }
        }
        
        this.nodes.set(node.getId(), node);
        
        // 如果是 HTML 节点，创建 DOM 元素
        if (node.isHtmlNode()) {
            node.createHtmlElement(this);
            this.updateHtmlNodeTransform(node);
        }
        
        // 触发节点添加事件
        this.emit('node:add', {
            type: 'node',
            target: node,
            node: node,
        });
        
        this.scheduleRender();
        return node;
    }

    /**
     * 合并用户配置和已注册的形状配置
     * @private
     */
    private mergeRegisteredConfig(
        userOptions: NodeOptions,
        registeredConfig: any
    ): NodeOptions {
        const merged: any = { ...userOptions };
        
        // 合并尺寸
        if (registeredConfig.width !== undefined && userOptions.style?.width === undefined) {
            merged.style = merged.style || {};
            merged.style.width = registeredConfig.width;
        }
        if (registeredConfig.height !== undefined && userOptions.style?.height === undefined) {
            merged.style = merged.style || {};
            merged.style.height = registeredConfig.height;
        }
        
        // 合并样式
        if (registeredConfig.style) {
            merged.style = {
                ...registeredConfig.style,
                ...merged.style,
            };
        }
        
        // 合并形状配置
        if (registeredConfig.shapeConfig) {
            merged.shape = registeredConfig.shapeConfig;
        }
        
        // 合并 resizable
        if (registeredConfig.resizable !== undefined && userOptions.resizable === undefined) {
            merged.resizable = registeredConfig.resizable;
        }
        
        // 保存组件引用（用于 React 等框架）
        if (registeredConfig.component) {
            merged._registeredComponent = registeredConfig.component;
            // 如果有组件，设置为 HTML 节点
            if (!merged.shape || typeof merged.shape === 'string') {
                merged.shape = { type: Shape.HTML, html: '' };
            }
        }
        
        return merged;
    }

    /**
     * 添加 React 节点
     * @param options - React 节点配置
     * @returns React 节点实例或 null
     *
     * @example
     * ```typescript
     * // 需要先安装 ReactShape 插件
     * const reactShapePlugin = new ReactShape();
     * graph.use(reactShapePlugin);
     *
     * // 注册 React 形状
     * reactShapePlugin.register({
     *     shape: 'user-card',
     *     width: 200,
     *     height: 80,
     *     component: UserCard,
     * });
     *
     * // 添加 React 节点
     * graph.addReactNode({
     *     shape: 'user-card',
     *     id: 'user-1',
     *     x: 150,
     *     y: 120,
     *     data: { name: '张三', role: '前端工程师' },
     * });
     * ```
     *
     * @note 需要先安装 ReactShape 插件才能使用此方法。
     */
    addReactNode(options: {
        shape: string;
        x: number;
        y: number;
        id?: string;
        label?: string;
        data?: Record<string, any>;
        style?: any;
    }): any {
        // 动态导入 ReactShape 相关类型，避免循环依赖
        const plugin = this.getPlugin<any>('react-shape');
        
        if (!plugin) {
            console.error('ReactShape plugin is not installed. Please use graph.use(new ReactShape()) first.');
            return null;
        }

        // 检查插件是否有 hasShape 和 createNode 方法
        if (typeof plugin.hasShape !== 'function' || typeof plugin.createNode !== 'function') {
            console.error('Invalid ReactShape plugin. Missing required methods.');
            return null;
        }

        // 检查是否是插件内注册的形状
        let node: any = null;
        
        if (plugin.hasShape(options.shape)) {
            node = plugin.createNode(options);
        } else {
            // 检查全局注册的形状
            const hasGlobalShape = (Graph as any)._globalReactShapes?.has(options.shape);
            if (hasGlobalShape) {
                const config = (Graph as any)._globalReactShapes.get(options.shape);
                plugin.register(config);
                node = plugin.createNode(options);
            } else {
                console.warn(`Shape "${options.shape}" is not registered.`);
                return null;
            }
        }

        if (node) {
            this.addNode(node);
        }

        return node;
    }

    /**
     * 移除节点
     * @param nodeId - 节点 ID
     * @returns 是否成功移除
     */
    removeNode(nodeId: string): boolean {
        const node = this.nodes.get(nodeId);
        if (node) {
            // 收集与该节点相关的边
            const connectedEdges: Edge[] = [];
            this.edges.forEach(edge => {
                const source = edge.getSourceAnchor();
                const target = edge.getTargetAnchor();
                if (source.nodeId === nodeId || target.nodeId === nodeId) {
                    connectedEdges.push(edge);
                }
            });

            // 如果移除的是选中的节点，触发 unselected 事件并取消选中
            if (this.selectedNode === node) {
                this.triggerNodeUnselected(this.selectedNode);
                this.selectedNode = null;
                this.options.onNodeSelect(null);
            }
            // 如果是 HTML 节点，移除其 DOM 元素
            if (node.isHtmlNode()) {
                this.removeHtmlNodeElement(nodeId);
            }
            this.nodes.delete(nodeId);
            
            // 触发节点移除事件
            this.emit('node:remove', {
                type: 'node',
                target: node,
                node: node,
                connectedEdges: connectedEdges,
            });
            
            this.scheduleRender();
            return true;
        }
        return false;
    }

    /**
     * 获取节点
     * @param nodeId - 节点 ID
     * @returns 节点实例或 undefined
     */
    getNode(nodeId: string): Node | undefined {
        return this.nodes.get(nodeId);
    }

    /**
     * 获取所有节点
     * @returns 节点数组
     */
    getAllNodes(): Node[] {
        return Array.from(this.nodes.values());
    }

    /**
     * 获取选中的节点
     * @returns 选中的节点或 null
     */
    getSelectedNode(): Node | null {
        return this.selectedNode;
    }

    /**
     * 选中节点
     * @param nodeId - 节点 ID
     * @param triggerUnselectImmediately - 是否立即触发 node:unselected 事件，默认为 true
     *                                     如果为 false，则在鼠标松开时触发
     */
    selectNode(nodeId: string | null, triggerUnselectImmediately: boolean = true): void {
        // 取消之前的选中
        if (this.selectedNode) {
            this.selectedNode.setSelected(false);

            if (triggerUnselectImmediately) {
                // 立即触发 node:unselected 事件
                this.triggerNodeUnselected(this.selectedNode);
            } else {
                // 记录待取消选中的节点，延迟到鼠标松开时触发
                this.nodeToUnselect = this.selectedNode;
            }
        }

        if (nodeId) {
            const node = this.nodes.get(nodeId);
            if (node) {
                node.setSelected(true);
                this.selectedNode = node;
                // 触发 node:selected 事件
                node.emit(EVENT_NAMES.NODE_SELECTED, {
                    type: 'node',
                    target: node,
                    node: node,
                });
                this.emit(EVENT_NAMES.NODE_SELECTED, {
                    type: 'node',
                    target: node,
                    node: node,
                });
            }
        } else {
            this.selectedNode = null;
        }

        this.options.onNodeSelect(this.selectedNode);
        this.scheduleRender();
    }

    /**
     * 触发 node:unselected 事件（用于延迟触发）
     * @param node - 要触发 unselected 事件的节点
     */
    private triggerNodeUnselected(node: Node, x?: number, y?: number, originalEvent?: globalThis.MouseEvent): void {
        const eventData = {
            type: 'node',
            target: node,
            node: node,
            x,
            y,
            originalEvent,
        };
        node.emit(EVENT_NAMES.NODE_UNSELECTED, eventData);
        this.emit(EVENT_NAMES.NODE_UNSELECTED, eventData);
    }

    /**
     * 清除所有节点
     */
    clearNodes(): void {
        // 如果有选中的节点，触发 unselected 事件
        if (this.selectedNode) {
            this.triggerNodeUnselected(this.selectedNode);
            this.selectedNode = null;
        }
        // 清除所有 HTML 节点的 DOM 元素
        this.htmlNodeElements.forEach((element, _nodeId) => {
            if (element.parentNode === this.overlay) {
                this.overlay.removeChild(element);
            }
        });
        this.htmlNodeElements.clear();
        this.nodes.clear();
        this.scheduleRender();
    }

    // ==================== 边管理方法 ====================

    /**
     * 添加边
     * @param options - 边配置
     * @returns 创建的边实例，如果连接已存在则返回已存在的边
     */
    addEdge(options: EdgeOptions): Edge {
        // 解析 source 和 target，获取 nodeId 和 portId
        const getAnchorKey = (anchor: string | { nodeId: string; portId?: string }): { nodeId: string; portId?: string } => {
            if (typeof anchor === 'string') {
                return { nodeId: anchor };
            }
            return { nodeId: anchor.nodeId, portId: anchor.portId };
        };
        
        const sourceAnchor = getAnchorKey(options.source);
        const targetAnchor = getAnchorKey(options.target);
        
        // 检查是否已存在相同的连接
        for (const existingEdge of this.edges.values()) {
            const existingSource = existingEdge.getSourceAnchor();
            const existingTarget = existingEdge.getTargetAnchor();
            
            // 检查是否是相同的连接
            const sourceMatch = existingSource.nodeId === sourceAnchor.nodeId &&
                existingSource.portId === sourceAnchor.portId;
            const targetMatch = existingTarget.nodeId === targetAnchor.nodeId &&
                existingTarget.portId === targetAnchor.portId;
            
            // 也检查反向连接
            const reverseSourceMatch = existingSource.nodeId === targetAnchor.nodeId &&
                existingSource.portId === targetAnchor.portId;
            const reverseTargetMatch = existingTarget.nodeId === sourceAnchor.nodeId &&
                existingTarget.portId === sourceAnchor.portId;
            
            if ((sourceMatch && targetMatch) || (reverseSourceMatch && reverseTargetMatch)) {
                // 连接已存在，返回已存在的边
                return existingEdge;
            }
        }
        
        const edge = new Edge(options);
        this.edges.set(edge.getId(), edge);
        
        // 触发边添加事件
        this.emit('edge:add', {
            type: 'edge',
            target: edge,
            edge: edge,
        });
        
        this.scheduleRender();
        return edge;
    }

    /**
     * 移除边
     * @param edgeId - 边 ID
     * @returns 是否成功移除
     */
    removeEdge(edgeId: string): boolean {
        const edge = this.edges.get(edgeId);
        if (edge) {
            if (this.selectedEdge === edge) {
                this.selectedEdge = null;
            }
            this.edges.delete(edgeId);
            
            // 触发边移除事件
            this.emit('edge:remove', {
                type: 'edge',
                target: edge,
                edge: edge,
            });
            
            this.scheduleRender();
            return true;
        }
        return false;
    }

    /**
     * 获取边
     * @param edgeId - 边 ID
     * @returns 边实例或 undefined
     */
    getEdge(edgeId: string): Edge | undefined {
        return this.edges.get(edgeId);
    }

    /**
     * 获取所有边
     * @returns 边数组
     */
    getAllEdges(): Edge[] {
        return Array.from(this.edges.values());
    }

    /**
     * 获取选中的边
     * @returns 选中的边或 null
     */
    getSelectedEdge(): Edge | null {
        return this.selectedEdge;
    }

    /**
     * 选中边
     * @param edgeId - 边 ID
     */
    selectEdge(edgeId: string | null): void {
        // 取消之前的选中
        if (this.selectedEdge) {
            this.selectedEdge.setSelected(false);
        }

        if (edgeId) {
            const edge = this.edges.get(edgeId);
            if (edge) {
                edge.setSelected(true);
                this.selectedEdge = edge;
            }
        } else {
            this.selectedEdge = null;
        }

        this.scheduleRender();
    }

    /**
     * 清除所有边
     */
    clearEdges(): void {
        this.edges.clear();
        this.selectedEdge = null;
        this.scheduleRender();
    }

    // 动画时间戳
    private animationTime: number = 0;
    private edgeAnimationId: number | null = null;

    /**
     * 启动边动画循环
     */
    startEdgeAnimation(): void {
        if (this.edgeAnimationId !== null) return;
        
        const animate = (time: number) => {
            this.animationTime = time;
            this.scheduleRender();
            this.edgeAnimationId = requestAnimationFrame(animate);
        };
        
        this.edgeAnimationId = requestAnimationFrame(animate);
    }

    /**
     * 停止边动画循环
     */
    stopEdgeAnimation(): void {
        if (this.edgeAnimationId !== null) {
            cancelAnimationFrame(this.edgeAnimationId);
            this.edgeAnimationId = null;
        }
    }

    /**
     * 检查是否有带动画的边或节点
     */
    private checkAnimatedEdges(): boolean {
        for (const edge of this.edges.values()) {
            if (edge.isAnimationPlaying()) {
                return true;
            }
        }
        // 检查是否有边框动画的节点
        for (const node of this.nodes.values()) {
            if (!node.isHtmlNode() && node.getStyle().borderStyle === 'animated') {
                return true;
            }
        }
        return false;
    }

    /**
     * 更新跳线边的交叉点位置
     * 计算每条 JumpLine 类型边与其他边的交叉点，并设置跳线位置
     * @private
     */
    private updateJumpLineIntersections(): void {
        // 收集所有边的连接点信息
        interface EdgeInfo {
            edge: Edge;
            sourcePoint: Point;
            targetPoint: Point;
            isJumpLine: boolean;
        }
        
        const edgeInfos: EdgeInfo[] = [];
        
        this.edges.forEach((edge) => {
            const endpoints = resolveEdgeEndpoints(edge, this.nodes);
            if (endpoints) {
                edgeInfos.push({
                    edge,
                    sourcePoint: endpoints.sourcePoint,
                    targetPoint: endpoints.targetPoint,
                    isJumpLine: edge.getType() === EdgeType.JumpLine
                });
            }
        });
        
        // 为每条跳线边计算与其他边的交叉点
        edgeInfos.forEach((jumpLineInfo) => {
            if (!jumpLineInfo.isJumpLine) return;
            
            const intersections: Point[] = [];
            
            edgeInfos.forEach((otherInfo) => {
                // 跳过自己
                if (otherInfo.edge === jumpLineInfo.edge) return;
                // 跳过其他跳线边（跳线只与非跳线边交叉时才显示）
                if (otherInfo.isJumpLine) return;
                
                // 计算两条线段的交叉点
                const intersection = getLineSegmentIntersection(
                    jumpLineInfo.sourcePoint, jumpLineInfo.targetPoint,
                    otherInfo.sourcePoint, otherInfo.targetPoint
                );
                
                if (intersection) {
                    intersections.push(intersection);
                }
            });
            
            // 设置跳线位置
            jumpLineInfo.edge.setJumpPoints(intersections);
        });
    }

    /**
     * 渲染所有边和连接桩（按 zIndex 混合排序绘制）
     * @protected
     */
    protected renderEdgesAndPorts(): void {
        // 检查是否有带动画的边
        const hasAnimated = this.checkAnimatedEdges();
        
        // 如果有动画边但没有启动动画循环，启动它
        if (hasAnimated && this.edgeAnimationId === null) {
            this.startEdgeAnimation();
        } else if (!hasAnimated && this.edgeAnimationId !== null) {
            // 如果没有动画边但循环在运行，停止它
            this.stopEdgeAnimation();
        }

        // 计算跳线边的交叉点
        this.updateJumpLineIntersections();

        // 收集所有需要绘制的元素（边和连接桩）
        interface DrawItem {
            type: 'edge' | 'port';
            zIndex: number;
            draw: () => void;
        }

        const drawItems: DrawItem[] = [];

        // 收集所有边
        this.edges.forEach((edge) => {
            const endpoints = resolveEdgeEndpoints(edge, this.nodes);

            if (endpoints) {
                const { sourcePoint, targetPoint } = endpoints;
                drawItems.push({
                    type: 'edge',
                    zIndex: edge.getZIndex(),
                    draw: () => {
                        edge.draw(this.edgeCtx, sourcePoint, targetPoint, this.animationTime);
                    }
                });
            }
        });

        // 收集所有节点的连接桩
        this.nodes.forEach((node) => {
            const nodePos = node.getPosition();
            const nodeStyle = node.getStyle();
            
            // 判断是否应该显示连接桩：
            // 1. 如果 portsAlwaysVisible 为 true（默认），始终显示
            // 2. 如果 portsAlwaysVisible 为 false，仅在鼠标悬停在该节点上时显示
            const shouldShowPorts = node.portsAlwaysVisible || node === this.eventDispatcher.getHoveredNode();
            
            if (!shouldShowPorts) {
                return; // 跳过此节点的连接桩绘制
            }
            
            // 获取所有连接桩
            const allPorts = [
                ...(node as any).portManager?.getAllPorts() || [],
                ...Array.from((node as any).ports?.values() || [])
            ];

            allPorts.forEach((port: any) => {
                drawItems.push({
                    type: 'port',
                    zIndex: port.getZIndex(),
                    draw: () => {
                        port.draw(this.edgeCtx, nodePos.x, nodePos.y, nodeStyle.width, nodeStyle.height);
                    }
                });
            });
        });

        // 按 zIndex 排序后绘制（zIndex 小的先绘制，大的在上面）
        drawItems.sort((a, b) => a.zIndex - b.zIndex).forEach(item => {
            item.draw();
        });
    }

    /**
     * 清除所有节点和边
     */
    clear(): void {
        this.clearNodes();
        this.clearEdges();
    }

    /**
     * 渲染所有节点
     * @protected
     */
    protected renderNodes(): void {
        // 按 zIndex 排序后绘制（zIndex 小的先绘制，大的在上面）
        const sortedNodes = Array.from(this.nodes.values()).sort((a, b) => a.getZIndex() - b.getZIndex());
        sortedNodes.forEach((node) => {
            node.draw(this.ctx, this.animationTime);
        });

        // 在选中的节点上绘制 resize handles
        if (this.selectedNode && !this.selectedNode.isHtmlNode()) {
            this.selectedNode.drawResizeHandles(this.ctx);
        }
    }

    /**
     * 获取当前变换矩阵
     */
    getTransform(): { offset: Point; scale: number } {
        return {
            offset: { ...this.viewport.offset },
            scale: this.viewport.scale,
        };
    }

    /**
     * 设置偏移量
     */
    setOffset(offset: Point): void {
        this.viewport.offset = { ...offset };
        this.scheduleRender();
    }

    /**
     * 设置缩放比例
     */
    setScale(scale: number): void {
        this.viewport.scale = Math.max(
            this.options.minZoom,
            Math.min(this.options.maxZoom, scale)
        );
        this.scheduleRender();
    }

    /**
     * 平移到指定位置（带动画）
     */
    panTo(
        offset: Point,
        duration: number = 300,
        easing: (t: number) => number = (t) =>
            t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
    ): Promise<void> {
        return new Promise((resolve) => {
            const startOffset = { ...this.viewport.offset };
            const startTime = performance.now();

            const animate = (currentTime: number) => {
                const elapsed = currentTime - startTime;
                const progress = Math.min(elapsed / duration, 1);
                const easedProgress = easing(progress);

                this.viewport.offset.x =
                    startOffset.x + (offset.x - startOffset.x) * easedProgress;
                this.viewport.offset.y =
                    startOffset.y + (offset.y - startOffset.y) * easedProgress;

                this.render();

                if (progress < 1) {
                    requestAnimationFrame(animate);
                } else {
                    this.options.onDragEnd({ ...this.viewport.offset });
                    resolve();
                }
            };

            requestAnimationFrame(animate);
        });
    }

    /**
     * 缩放到指定比例（带动画）
     */
    zoomTo(
        scale: number,
        duration: number = 300,
        easing: (t: number) => number = (t) =>
            t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
    ): Promise<void> {
        return new Promise((resolve) => {
            const startScale = this.viewport.scale;
            const targetScale = Math.max(
                this.options.minZoom,
                Math.min(this.options.maxZoom, scale)
            );
            const startTime = performance.now();

            const animate = (currentTime: number) => {
                const elapsed = currentTime - startTime;
                const progress = Math.min(elapsed / duration, 1);
                const easedProgress = easing(progress);

                this.viewport.scale =
                    startScale + (targetScale - startScale) * easedProgress;

                this.render();

                if (progress < 1) {
                    requestAnimationFrame(animate);
                } else {
                    this.options.onZoom(this.viewport.scale, { ...this.viewport.offset });
                    resolve();
                }
            };

            requestAnimationFrame(animate);
        });
    }

    /**
     * 重置视图
     */
    reset(): void {
        this.viewport.reset({
            x: this.options.initialOffsetX,
            y: this.options.initialOffsetY,
        });
        this.render();
    }

    /**
     * 重置到画布中心点
     * 将视图移动到画布中心，保持当前缩放比例
     */
    resetToCenter(): void {
        const { width, height } = this.canvas.getBoundingClientRect();
        
        this.viewport.offset = {
            x: width / 2,
            y: height / 2,
        };
        this.render();
        
        // 触发拖拽完成回调
        this.options.onDragEnd({ ...this.viewport.offset });
    }

    /**
     * 放大画布
     * @param factor - 缩放因子，默认为 1.1
     */
    zoomIn(factor: number = 1.1): void {
        const newScale = Math.min(
            this.options.maxZoom,
            this.viewport.scale * factor
        );
        this.setScale(newScale);
    }

    /**
     * 缩小画布
     * @param factor - 缩放因子，默认为 0.9
     */
    zoomOut(factor: number = 0.9): void {
        const newScale = Math.max(
            this.options.minZoom,
            this.viewport.scale * factor
        );
        this.setScale(newScale);
    }

    /**
     * 获取当前缩放比例
     * @returns 当前缩放比例
     */
    getZoom(): number {
        return this.viewport.scale;
    }

    /**
     * 设置网格大小
     * @param size - 网格大小（像素）
     */
    setGridSize(size: number): void {
        this.options.grid.size = size;
        this.scheduleRender();
    }

    /**
     * 设置网格颜色
     * @param color - 网格颜色（CSS 颜色值）
     */
    setGridColor(color: string): void {
        this.options.grid.color = color;
        this.scheduleRender();
    }

    /**
     * 启用或禁用网格
     * @param enabled - 是否启用网格
     */
    setGridEnabled(enabled: boolean): void {
        this.options.grid.enabled = enabled;
        this.scheduleRender();
    }

    /**
     * 设置网格类型
     * @param type - 网格类型：'mesh' 为线状网格，'dot' 为点状网格
     */
    setGridType(type: 'mesh' | 'dot'): void {
        this.options.grid.type = type;
        this.scheduleRender();
    }

    /**
     * 获取网格配置
     * @returns 当前网格配置
     */
    getGridConfig(): { enabled: boolean; size: number; color: string; type: 'mesh' | 'dot' } {
        return {
            enabled: this.options.grid.enabled,
            size: this.options.grid.size ?? 20,
            color: this.options.grid.color ?? '#e5e7eb',
            type: this.options.grid.type ?? 'mesh',
        };
    }

    /**
     * 适应内容到视图
     */
    fitToContent(
        contentBounds: { x: number; y: number; width: number; height: number },
        padding: number = 50
    ): void {
        const { width, height } = this.canvas.getBoundingClientRect();
        const contentWidth = contentBounds.width + padding * 2;
        const contentHeight = contentBounds.height + padding * 2;

        const scaleX = width / contentWidth;
        const scaleY = height / contentHeight;
        const scale = Math.min(scaleX, scaleY, this.options.maxZoom);

        const offsetX =
            (width - contentBounds.width * scale) / 2 - contentBounds.x * scale;
        const offsetY =
            (height - contentBounds.height * scale) / 2 - contentBounds.y * scale;

        this.viewport.scale = scale;
        this.viewport.offset = { x: offsetX, y: offsetY };
        this.render();
    }

    /**
     * 将屏幕坐标转换为世界坐标
     */
    screenToWorld(screenPoint: Point): Point {
        return this.viewport.screenToWorld(screenPoint);
    }

    /**
     * 将鼠标事件位置转换为画布屏幕坐标（相对画布左上角）
     */
    private eventToScreenPoint(e: { clientX: number; clientY: number }): Point {
        return this.viewport.eventToScreenPoint(this.canvas, e);
    }

    /**
     * 将鼠标事件位置转换为世界坐标
     */
    private eventToWorldPoint(e: { clientX: number; clientY: number }): Point {
        return this.viewport.eventToWorldPoint(this.canvas, e);
    }

    /**
     * 将世界坐标转换为屏幕坐标
     */
    worldToScreen(worldPoint: Point): Point {
        return this.viewport.worldToScreen(worldPoint);
    }

    /**
     * 获取 Canvas 上下文
     */
    getContext(): CanvasRenderingContext2D {
        return this.ctx;
    }

    /**
     * 获取 Canvas 元素
     */
    getCanvas(): HTMLCanvasElement {
        return this.canvas;
    }

    /**
     * 获取边线层 Canvas 元素
     */
    getEdgeCanvas(): HTMLCanvasElement {
        return this.edgeCanvas;
    }

    /**
     * 获取完整的画布内容（合并节点层和边线层）
     * 导出所有画布元素，而不只是当前可视区域
     * @param padding - 边距，默认 20
     * @returns 包含完整内容的 Canvas 元素
     */
    getFullCanvas(padding: number = 20): HTMLCanvasElement {
        // 计算所有元素的世界坐标边界
        const bounds = this.calculateContentBounds(padding);
        
        // 如果没有元素，返回一个空白画布
        if (!bounds) {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = 100;
            tempCanvas.height = 100;
            return tempCanvas;
        }
        
        // 创建临时画布，尺寸为所有元素的范围
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = Math.round(bounds.width);
        tempCanvas.height = Math.round(bounds.height);
        const tempCtx = tempCanvas.getContext('2d')!;
        
        // 保存当前上下文状态
        tempCtx.save();
        
        // 应用偏移变换，使世界坐标 (bounds.x, bounds.y) 对应画布原点 (0, 0)
        tempCtx.translate(-bounds.x, -bounds.y);
        
        // 绘制所有节点（在世界坐标系中）
        const sortedNodes = Array.from(this.nodes.values()).sort((a, b) => a.getZIndex() - b.getZIndex());
        sortedNodes.forEach((node) => {
            node.draw(tempCtx, this.animationTime);
        });
        
        // 绘制所有边和连接桩
        const drawItems: Array<{ zIndex: number; draw: () => void }> = [];
        
        // 绘制边（需要计算端点）
        this.edges.forEach((edge) => {
            const endpoints = resolveEdgeEndpoints(edge, this.nodes);
            if (!endpoints) return;

            const { sourcePoint, targetPoint } = endpoints;
            drawItems.push({
                type: 'edge',
                zIndex: edge.getZIndex(),
                draw: () => {
                    edge.draw(tempCtx, sourcePoint, targetPoint);
                }
            } as any);
        });
        
        // 绘制连接桩
        this.nodes.forEach((node) => {
            const nodePos = node.getPosition();
            const nodeStyle = node.getStyle();
            const allPorts = node.getAllPorts();
            
            allPorts.forEach((port: any) => {
                drawItems.push({
                    type: 'port',
                    zIndex: port.getZIndex(),
                    draw: () => {
                        port.draw(tempCtx, nodePos.x, nodePos.y, nodeStyle.width, nodeStyle.height);
                    }
                } as any);
            });
        });
        
        // 按 zIndex 排序后绘制
        drawItems.sort((a, b) => a.zIndex - b.zIndex).forEach(item => {
            item.draw();
        });
        
        tempCtx.restore();
        
        return tempCanvas;
    }
    
    /**
     * 计算所有元素的世界坐标边界
     * @param padding - 边距
     * @returns 边界框或 null（如果没有元素）
     */
    private calculateContentBounds(padding: number = 0): { x: number; y: number; width: number; height: number } | null {
        const nodes = this.getAllNodes();
        if (nodes.length === 0) {
            return null;
        }
        
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        
        // 遍历所有节点
        nodes.forEach((node) => {
            const bounds = node.getBounds();
            minX = Math.min(minX, bounds.x);
            minY = Math.min(minY, bounds.y);
            maxX = Math.max(maxX, bounds.x + bounds.width);
            maxY = Math.max(maxY, bounds.y + bounds.height);
        });
        
        // 考虑边的端点位置
        this.edges.forEach((edge) => {
            const endpoints = resolveEdgeEndpoints(edge, this.nodes);
            if (!endpoints) return;

            const { sourcePoint, targetPoint } = endpoints;
            minX = Math.min(minX, sourcePoint.x, targetPoint.x);
            minY = Math.min(minY, sourcePoint.y, targetPoint.y);
            maxX = Math.max(maxX, sourcePoint.x, targetPoint.x);
            maxY = Math.max(maxY, sourcePoint.y, targetPoint.y);
        });
        
        // 应用边距
        return {
            x: minX - padding,
            y: minY - padding,
            width: maxX - minX + padding * 2,
            height: maxY - minY + padding * 2,
        };
    }

    /**
     * 获取画布可视区域（viewport）的截图
     * @returns 可视区域的 Canvas 元素
     */
    getViewportCanvas(): HTMLCanvasElement {
        const { width, height } = this.canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        
        // 创建临时画布，尺寸为可视区域大小
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = Math.round(width * dpr);
        tempCanvas.height = Math.round(height * dpr);
        const tempCtx = tempCanvas.getContext('2d')!;
        
        // 从原始画布复制可视区域
        // 注意：canvas 已经经过 DPR 缩放，所以源坐标需要乘以 dpr
        tempCtx.drawImage(
            this.canvas,
            0, 0, tempCanvas.width, tempCanvas.height,  // 源区域（从左上角开始）
            0, 0, tempCanvas.width, tempCanvas.height   // 目标区域
        );
        
        // 绘制边线层
        tempCtx.drawImage(
            this.edgeCanvas,
            0, 0, tempCanvas.width, tempCanvas.height,
            0, 0, tempCanvas.width, tempCanvas.height
        );
        
        return tempCanvas;
    }

    /**
     * 获取当前视口信息
     * @returns 视口的宽度和高度（CSS 像素）
     */
    getViewport(): { width: number; height: number } {
        const rect = this.canvas.getBoundingClientRect();
        return {
            width: rect.width,
            height: rect.height,
        };
    }

    /**
     * 启用/禁用拖拽
     */
    setDraggable(enabled: boolean): void {
        this.options.draggable = enabled;
        this.canvas.style.cursor = 'default';
    }

    /**
     * 启用/禁用缩放
     */
    setScalable(enabled: boolean): void {
        this.options.scalable = enabled;
    }

    /**
     * 将图导出为 JSON 格式
     * @returns 包含 cells 数组的对象，cells 按渲染顺序排列（先边后节点）
     */
    toJSON(): { cells: Array<ReturnType<Node['toJSON']> | ReturnType<Edge['toJSON']>> } {
        const cells: Array<ReturnType<Node['toJSON']> | ReturnType<Edge['toJSON']>> = [];

        // 先添加所有边（边在节点下方渲染）
        this.edges.forEach((edge) => {
            cells.push(edge.toJSON());
        });

        // 再添加所有节点（节点在边上方渲染）
        this.nodes.forEach((node) => {
            cells.push(node.toJSON());
        });

        return { cells };
    }

    /**
     * 销毁组件
     */
    destroy(): void {
        // 停止连线流动动画的总循环（否则 destroy 后 rAF 仍每帧空转，泄漏且耗 CPU）
        this.stopEdgeAnimation();

        // 取消正在进行的渲染调度
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }

        // 卸载全部插件（清理各自的 DOM、document/window 级监听、键盘监听等）
        // 需在移除画布元素之前执行，插件卸载时仍要访问 canvas / container
        for (const plugin of [...this.plugins.values()]) {
            try {
                plugin.uninstall();
            } catch {
                // 忽略单个插件的清理失败，保证其余插件与画布继续清理
            }
        }
        this.plugins.clear();

        // 解绑事件（包含 ResizeObserver 的清理）
        this.unbindEvents();

        // 移除画布元素
        if (this.canvas.parentNode === this.container) {
            this.container.removeChild(this.canvas);
        }

        // 移除 overlay 层
        if (this.overlay.parentNode === this.container) {
            this.container.removeChild(this.overlay);
        }

        // 移除边线层
        if (this.edgeCanvas.parentNode === this.container) {
            this.container.removeChild(this.edgeCanvas);
        }

        // 清空 HTML 节点元素
        this.htmlNodeElements.clear();

        // 清空引用
        (this as any).container = null;
        (this as any).canvas = null;
        (this as any).ctx = null;
        (this as any).overlay = null;
        (this as any).edgeCanvas = null;
        (this as any).edgeCtx = null;

        // 清理事件管理器
        this.eventManager.clear();
    }

    // ==================== 事件系统 ====================

    /**
     * 注册事件处理器
     * @param eventName - 事件名称
     * @param handler - 事件处理器
     * @returns 注销函数
     */
    on(eventName: string, handler: EventHandler): () => void {
        return this.eventManager.on(eventName, handler);
    }

    /**
     * 注册一次性事件处理器
     * @param eventName - 事件名称
     * @param handler - 事件处理器
     * @returns 注销函数
     */
    once(eventName: string, handler: EventHandler): () => void {
        return this.eventManager.once(eventName, handler);
    }

    /**
     * 注销事件处理器
     * @param eventName - 事件名称
     * @param handler - 要注销的处理器（不传则注销该事件的所有处理器）
     */
    off(eventName: string, handler?: EventHandler): void {
        this.eventManager.off(eventName, handler);
    }

    /**
     * 触发 Graph 级别事件
     */
    private emit(eventName: string, eventData: any): boolean {
        return this.eventManager.emit(eventName, eventData);
    }

    /**
     * 触发 Graph 级别事件
     * @internal 供 GraphEventDispatcher 调用
     */
    emitGraphEvent(eventName: string, eventData: any): boolean {
        return this.emit(eventName, eventData);
    }

    /**
     * 立即渲染画布（绕过 requestAnimationFrame 调度）
     * @internal 供 ResizeManager 在 resize 过程中实时更新手柄位置时调用
     */
    renderNow(): void {
        this.render();
    }

    /**
     * 执行连接验证回调
     * @internal 供 ConnectionManager 调用
     */
    runValidateConnection(context: ConnectionValidateContext): boolean {
        return this.options.validateConnection(context);
    }

    /**
     * 开关所有 HTML 节点元素的鼠标事件捕获
     * 连接拖拽时禁用（none），使鼠标事件能穿透到 overlay 层；结束后恢复（auto）
     * @internal 供 ConnectionManager 调用
     */
    setHtmlNodesPointerEvents(enabled: boolean): void {
        this.htmlNodeElements.forEach((element) => {
            element.style.pointerEvents = enabled ? 'auto' : 'none';
        });
    }

    /**
     * 获取视口状态对象（可直接修改 offset/scale）
     * @internal 供 DragManager 调用
     */
    getViewportState(): Viewport {
        return this.viewport;
    }

    /**
     * 获取画布拖拽时的光标样式
     * @internal 供 DragManager 调用
     */
    getDraggingCursor(): string {
        return this.options.draggingCursor;
    }

    /**
     * 触发画布拖拽完成回调（onDragEnd），载荷为当前视口偏移的副本
     * @internal 供 DragManager 调用
     */
    notifyDragEnd(): void {
        this.options.onDragEnd({ ...this.viewport.offset });
    }

    /**
     * 触发延迟的 node:unselected 事件（如果存在待取消选中的节点）
     * @internal 供 DragManager 在节点拖拽结束时调用
     */
    flushPendingNodeUnselected(x?: number, y?: number, originalEvent?: globalThis.MouseEvent): void {
        if (this.nodeToUnselect) {
            this.triggerNodeUnselected(this.nodeToUnselect, x, y, originalEvent);
            this.nodeToUnselect = null;
        }
    }

    /**
     * 是否存在悬停节点（用于拖拽结束后恢复光标）
     * @internal 供 DragManager 调用
     */
    hasHoveredNode(): boolean {
        return this.hoveredNode !== null;
    }

    /**
     * 处理空白区域事件：触发 blank:* 事件，并在需要时取消选中
     * @internal 供 GraphEventDispatcher 调用
     */
    dispatchBlankAreaEvent(eventType: string, baseEventData: MouseEvent, worldPoint: Point): void {
        const blankEventMap: Record<string, string> = {
            click: EVENT_NAMES.BLANK_CLICK,
            contextmenu: EVENT_NAMES.BLANK_CONTEXTMENU,
            mousedown: EVENT_NAMES.BLANK_MOUSEDOWN,
            mousemove: EVENT_NAMES.BLANK_MOUSEMOVE,
            mouseup: EVENT_NAMES.BLANK_MOUSEUP,
        };
        const blankEventName = blankEventMap[eventType] || null;
        if (blankEventName) {
            const blankEventData = {
                ...baseEventData,
                target: null,
                x: worldPoint.x,
                y: worldPoint.y,
            };
            this.emit(blankEventName, blankEventData);

            // 如果是 mouseup 或 click 事件且有选中的节点，取消选中并触发 unselected 事件
            if ((eventType === 'mouseup' || eventType === 'click') && this.selectedNode) {
                const unselectedNode = this.selectedNode;
                unselectedNode.setSelected(false);

                // 优先使用延迟触发的节点（如果有）
                const nodeToTrigger = this.nodeToUnselect || unselectedNode;

                // 触发 node:unselected 事件
                const unselectedEventData = {
                    ...baseEventData,
                    type: 'node',
                    target: nodeToTrigger,
                    node: nodeToTrigger,
                    x: worldPoint.x,
                    y: worldPoint.y,
                };
                nodeToTrigger.emit(EVENT_NAMES.NODE_UNSELECTED, unselectedEventData);
                this.emit(EVENT_NAMES.NODE_UNSELECTED, unselectedEventData);

                this.selectedNode = null;
                this.nodeToUnselect = null; // 清除延迟触发标记
                this.options.onNodeSelect(null);
                this.scheduleRender();
            }

            // 如果是 mouseup 事件且有选中的边，取消选中
            if (eventType === 'mouseup' && this.selectedEdge) {
                this.selectedEdge.setSelected(false);
                this.selectedEdge = null;
                this.scheduleRender();
            }
        }
    }

    // ==================== 插件系统 ====================

    /**
     * 注册插件
     * @param plugin - 插件实例
     * @returns this（支持链式调用）
     */
    use(plugin: Plugin): this {
        if (this.plugins.has(plugin.name)) {
            console.warn(`Plugin "${plugin.name}" is already registered.`);
            return this;
        }
        
        this.plugins.set(plugin.name, plugin);
        plugin.install(this);
        
        return this;
    }

    /**
     * 注销插件
     * @param pluginName - 插件名称
     * @returns this（支持链式调用）
     */
    unuse(pluginName: string): this {
        const plugin = this.plugins.get(pluginName);
        if (plugin) {
            plugin.uninstall();
            this.plugins.delete(pluginName);
        }
        return this;
    }

    /**
     * 获取插件实例
     * @param pluginName - 插件名称
     * @returns 插件实例或 undefined
     */
    getPlugin<T extends Plugin>(pluginName: string): T | undefined {
        return this.plugins.get(pluginName) as T | undefined;
    }

    /**
     * 检查插件是否已注册
     * @param pluginName - 插件名称
     */
    hasPlugin(pluginName: string): boolean {
        return this.plugins.has(pluginName);
    }

    // ==================== 行级悬停节点处理 ====================

    private hoveredDynamicNode: (Node & RowHoverable) | null = null;
    private lastHoveredRowIndex: number = -1;

    /**
     * 处理支持行级悬停的节点（如 DynamicHeightNode）的悬停状态
     */
    private handleDynamicNodeRowHover(e: globalThis.MouseEvent): void {
        const worldPoint = this.eventToWorldPoint(e);

        // 查找鼠标下的行级悬停节点
        let hoveredNode: (Node & RowHoverable) | null = null;
        const nodes = this.getAllNodes();
        
        for (let i = nodes.length - 1; i >= 0; i--) {
            const node = nodes[i];
            if (isRowHoverable(node) && node.containsPoint(worldPoint)) {
                hoveredNode = node;
                break;
            }
        }

        // 如果离开了之前的节点，清除其行悬停状态
        if (this.hoveredDynamicNode && this.hoveredDynamicNode !== hoveredNode) {
            this.hoveredDynamicNode.setHoveredRow(-1);
            this.scheduleRender();
        }

        this.hoveredDynamicNode = hoveredNode;

        // 如果在节点上，计算悬停的行
        if (hoveredNode) {
            const rowIndex = hoveredNode.getRowIndexAtPoint(worldPoint);
            if (rowIndex !== this.lastHoveredRowIndex) {
                hoveredNode.setHoveredRow(rowIndex);
                this.lastHoveredRowIndex = rowIndex;
                this.scheduleRender();
            }
        } else {
            this.lastHoveredRowIndex = -1;
        }
    }
}

export default Graph;
