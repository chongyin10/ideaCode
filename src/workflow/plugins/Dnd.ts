import { NodeOptions } from '../core/Node';
import { Graph, Point } from '../core/Graph';
import { EventManager, type EventHandler } from '../core/EventManager';

/**
 * Dnd 拖拽源配置
 */
export interface DndSourceConfig {
    /** 节点配置或生成函数 */
    node: NodeOptions | ((e: DragEvent) => NodeOptions);
    /** 拖拽开始回调（DOM 原生事件） */
    onDragStart?: (e: DragEvent) => void;
    /** 拖拽结束回调（DOM 原生事件） */
    onDragEnd?: (e: DragEvent) => void;
}

/**
 * Dnd 事件对象
 */
export interface DndEvent {
    /** 事件类型 */
    type: 'dnd:dragstart' | 'dnd:drag' | 'dnd:drop' | 'dnd:dragend' | 'dnd:dragenter' | 'dnd:dragover' | 'dnd:dragleave';
    /** 原始 DOM 事件 */
    originalEvent: DragEvent;
    /** 目标 Graph 实例 */
    target: Graph;
    /** 当前鼠标位置（世界坐标） */
    position: Point;
    /** 拖拽的节点配置 */
    nodeOptions?: NodeOptions;
    /** 拖拽预览元素 */
    dragElement?: HTMLElement;
}

/**
 * Dnd 配置选项
 */
export interface DndOptions {
    /** 是否启用拖拽 */
    enabled?: boolean;
    /** 拖拽预览元素类名 */
    dragClassName?: string;
    /** 拖拽预览元素样式 */
    dragStyle?: Partial<CSSStyleDeclaration>;
    /** 是否使用 Canvas 绘制拖拽预览 */
    useCanvasPreview?: boolean;
    /** 拖拽预览节点样式（Canvas 模式） */
    previewNodeStyle?: Partial<NodeOptions['style']>;
    /** 是否允许节点重叠放置，默认为 true（允许）。设为 false 时禁止在已有节点区域放置 */
    allowOverlap?: boolean;
    /** 拖拽开始回调 */
    onDragStart?: (e: DndEvent) => void;
    /** 拖拽中回调 */
    onDrag?: (e: DndEvent) => void;
    /** 放置回调（返回 false 可阻止放置） */
    onDrop?: (e: DndEvent) => boolean | void;
    /** 拖拽结束回调 */
    onDragEnd?: (e: DndEvent) => void;
    /** 拖拽进入画布回调 */
    onDragEnter?: (e: DndEvent) => void;
    /** 拖拽在画布上移动回调 */
    onDragOver?: (e: DndEvent) => void;
    /** 拖拽离开画布回调 */
    onDragLeave?: (e: DndEvent) => void;
    /** 是否验证放置位置（返回 false 阻止放置） */
    validateDrop?: (position: Point, nodeOptions: NodeOptions) => boolean;
    /** 放置节点前的转换函数 */
    transformNodeOptions?: (position: Point, nodeOptions: NodeOptions) => NodeOptions;
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
 * Dnd - 拖拽插件
 *
 * 支持从外部拖拽节点到画布中，主要功能：
 * - 从 DOM 元素开始拖拽
 * - 拖拽预览（HTML 元素或 Canvas）
 * - 放置节点到画布
 * - 完整的事件系统
 *
 * 使用示例：
 * ```typescript
 * const dnd = new Dnd({
 *     enabled: true,
 *     onDragStart: (e) => console.log('拖拽开始'),
 *     onDrop: (e) => {
 *         console.log('放置位置:', e.position);
 *         return true; // 允许放置
 *     },
 * });
 *
 * // 通过 graph.use 注册插件
 * graph.use(dnd);
 *
 * // 注册拖拽源元素
 * dnd.registerSource(element, {
 *     id: 'node-1',
 *     label: '新节点',
 *     x: 0,
 *     y: 0,
 * });
 * ```
 */
export class Dnd implements Plugin {
    readonly name = 'dnd';
    
    private graph: Graph | null = null;
    private options: DndOptions;
    private eventManager: EventManager;
    private isDragging: boolean = false;
    private isDropped: boolean = false;  // 标记是否已成功放置
    private dragPreviewElement: HTMLElement | null = null;
    private currentNodeOptions: NodeOptions | null = null;
    private dropPosition: Point | null = null;
    private isCollision: boolean = false; // 是否发生碰撞
    private collisionOverlayElement: HTMLElement | null = null; // 碰撞提示元素
    private boundHandlers: {
        onDragOver: (e: DragEvent) => void;
        onDrop: (e: DragEvent) => void;
        onDragEnter: (e: DragEvent) => void;
        onDragLeave: (e: DragEvent) => void;
        onDragEnd: (e: DragEvent) => void;
    };
    
    // 已注册的拖拽源
    private registeredSources: Map<HTMLElement, {
        config: DndSourceConfig;
        cleanup: () => void;
    }> = new Map();

    // 默认配置
    private static readonly DEFAULT_OPTIONS: Pick<
        DndOptions,
        'enabled' | 'dragClassName' | 'dragStyle' | 'useCanvasPreview' | 'previewNodeStyle' | 'allowOverlap'
    > = {
        enabled: true,
        dragClassName: 'dnd-drag-preview',
        dragStyle: {
            position: 'fixed',
            pointerEvents: 'none',
            zIndex: '9999',
            opacity: '0.8',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
        },
        useCanvasPreview: false,
        previewNodeStyle: {
            backgroundColor: '#60a5fa',
            borderColor: '#3b82f6',
            borderWidth: 2,
        },
        allowOverlap: true,
    };

    constructor(options: DndOptions = {}) {
        this.options = {
            ...Dnd.DEFAULT_OPTIONS,
            ...options,
            dragStyle: {
                ...Dnd.DEFAULT_OPTIONS.dragStyle,
                ...options.dragStyle,
            },
            previewNodeStyle: {
                ...Dnd.DEFAULT_OPTIONS.previewNodeStyle,
                ...options.previewNodeStyle,
            },
        };
        this.eventManager = new EventManager();

        // 绑定事件处理器
        this.boundHandlers = {
            onDragOver: this.handleDragOver.bind(this),
            onDrop: this.handleDrop.bind(this),
            onDragEnter: this.handleDragEnter.bind(this),
            onDragLeave: this.handleDragLeave.bind(this),
            onDragEnd: this.handleDragEnd.bind(this),
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
        this.unregisterAllSources();
        this.cleanup();
        this.eventManager.clear();
        this.graph = null;
    }

    /**
     * 启用拖拽功能
     */
    enable(): void {
        if (!this.graph) return;
        const canvas = this.graph.getCanvas();
        canvas.addEventListener('dragover', this.boundHandlers.onDragOver);
        canvas.addEventListener('drop', this.boundHandlers.onDrop);
        canvas.addEventListener('dragenter', this.boundHandlers.onDragEnter);
        canvas.addEventListener('dragleave', this.boundHandlers.onDragLeave);
        document.addEventListener('dragend', this.boundHandlers.onDragEnd);
    }

    /**
     * 禁用拖拽功能
     */
    disable(): void {
        if (!this.graph) return;
        const canvas = this.graph.getCanvas();
        canvas.removeEventListener('dragover', this.boundHandlers.onDragOver);
        canvas.removeEventListener('drop', this.boundHandlers.onDrop);
        canvas.removeEventListener('dragenter', this.boundHandlers.onDragEnter);
        canvas.removeEventListener('dragleave', this.boundHandlers.onDragLeave);
        document.removeEventListener('dragend', this.boundHandlers.onDragEnd);
    }

    // ==================== 拖拽源注册 ====================

    /**
     * 注册拖拽源元素
     * @param element - DOM 元素
     * @param config - 拖拽源配置
     * @returns 注销函数
     */
    registerSource(
        element: HTMLElement,
        config: NodeOptions | ((e: DragEvent) => NodeOptions) | DndSourceConfig
    ): () => void {
        // 统一配置格式
        const sourceConfig: DndSourceConfig = this.normalizeSourceConfig(config);
        
        // 设置元素可拖拽
        element.draggable = true;
        element.style.cursor = 'grab';

        // 绑定 dragstart 事件
        const handleDragStart = (e: DragEvent) => {
            // 调用用户的 onDragStart 回调
            sourceConfig.onDragStart?.(e);
            
            // 启动 Dnd 拖拽
            this.start(sourceConfig.node, e);
        };

        // 绑定 dragend 事件
        const handleDragEnd = (e: DragEvent) => {
            // 调用用户的 onDragEnd 回调
            sourceConfig.onDragEnd?.(e);
        };

        element.addEventListener('dragstart', handleDragStart);
        element.addEventListener('dragend', handleDragEnd);

        // 清理函数
        const cleanup = () => {
            element.removeEventListener('dragstart', handleDragStart);
            element.removeEventListener('dragend', handleDragEnd);
            element.draggable = false;
            element.style.cursor = '';
        };

        // 保存注册信息
        this.registeredSources.set(element, {
            config: sourceConfig,
            cleanup,
        });

        // 返回注销函数
        return () => this.unregisterSource(element);
    }

    /**
     * 注销拖拽源元素
     * @param element - DOM 元素
     */
    unregisterSource(element: HTMLElement): void {
        const source = this.registeredSources.get(element);
        if (source) {
            source.cleanup();
            this.registeredSources.delete(element);
        }
    }

    /**
     * 注销所有拖拽源
     */
    unregisterAllSources(): void {
        this.registeredSources.forEach((source) => {
            source.cleanup();
        });
        this.registeredSources.clear();
    }

    /**
     * 标准化拖拽源配置
     */
    private normalizeSourceConfig(
        config: NodeOptions | ((e: DragEvent) => NodeOptions) | DndSourceConfig
    ): DndSourceConfig {
        if (typeof config === 'function') {
            return { node: config };
        }
        if ('node' in config) {
            return config;
        }
        return { node: config };
    }

    // ==================== 拖拽核心逻辑 ====================

    /**
     * 开始拖拽
     * @param node - 节点配置选项或生成函数
     * @param e - 原始拖拽事件
     */
    start(node: NodeOptions | ((e: DragEvent) => NodeOptions), e: DragEvent): void {
        if (!this.options.enabled || !this.graph) return;

        // 清理之前的状态（如果有）
        this.cleanup();

        // 解析节点配置
        this.currentNodeOptions = typeof node === 'function' ? node(e) : { ...node };

        // 设置拖拽数据（用于浏览器原生拖拽）
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'copy';
            e.dataTransfer.setData('application/json', JSON.stringify(this.currentNodeOptions));

            // 设置拖拽预览
            this.setupDragPreview(e);
        }

        this.isDragging = true;
        this.isDropped = false;

        // 触发拖拽开始事件
        const dndEvent = this.createDndEvent('dnd:dragstart', e);
        this.emit('dnd:dragstart', dndEvent);
        this.options.onDragStart?.(dndEvent);
    }

    /**
     * 设置拖拽预览
     */
    private setupDragPreview(e: DragEvent): void {
        if (!e.dataTransfer) return;

        if (this.options.useCanvasPreview) {
            // 使用 Canvas 绘制预览（简化版本）
            const canvas = document.createElement('canvas');
            canvas.width = 120;
            canvas.height = 60;
            const ctx = canvas.getContext('2d');
            if (ctx) {
                // 绘制简单的节点预览
                ctx.fillStyle = this.options.previewNodeStyle?.backgroundColor || '#60a5fa';
                ctx.strokeStyle = this.options.previewNodeStyle?.borderColor || '#3b82f6';
                ctx.lineWidth = this.options.previewNodeStyle?.borderWidth || 2;

                // 绘制圆角矩形
                const width = 100;
                const height = 50;
                const x = 10;
                const y = 5;
                const radius = 8;

                ctx.beginPath();
                ctx.roundRect(x, y, width, height, radius);
                ctx.fill();
                ctx.stroke();

                // 绘制文字
                ctx.fillStyle = '#ffffff';
                ctx.font = '14px system-ui';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(this.currentNodeOptions?.label || 'Node', x + width / 2, y + height / 2);

                e.dataTransfer.setDragImage(canvas, width / 2, height / 2);
            }
        } else {
            // 使用 DOM 元素作为拖拽预览
            this.createDragPreviewElement();
            if (this.dragPreviewElement) {
                document.body.appendChild(this.dragPreviewElement);
                e.dataTransfer.setDragImage(this.dragPreviewElement, 60, 30);
            }
        }
    }

    /**
     * 创建拖拽预览元素
     */
    private createDragPreviewElement(): void {
        const preview = document.createElement('div');
        preview.className = this.options.dragClassName || 'dnd-drag-preview';

        // 应用样式
        const defaultStyle: Partial<CSSStyleDeclaration> = {
            position: 'fixed',
            pointerEvents: 'none',
            zIndex: '9999',
            opacity: '0.8',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
        };
        Object.assign(preview.style, defaultStyle, this.options.dragStyle);
        preview.style.width = '120px';
        preview.style.height = '60px';
        preview.style.backgroundColor = this.options.previewNodeStyle?.backgroundColor || '#60a5fa';
        preview.style.border = `${this.options.previewNodeStyle?.borderWidth || 2}px solid ${this.options.previewNodeStyle?.borderColor || '#3b82f6'}`;
        preview.style.borderRadius = '8px';
        preview.style.display = 'flex';
        preview.style.alignItems = 'center';
        preview.style.justifyContent = 'center';
        preview.style.color = '#ffffff';
        preview.style.fontSize = '14px';
        preview.style.fontFamily = 'system-ui, -apple-system, sans-serif';

        // 添加标签
        preview.textContent = this.currentNodeOptions?.label || 'Node';

        this.dragPreviewElement = preview;
    }

    /**
     * 处理拖拽悬停
     */
    private handleDragOver(e: DragEvent): void {
        e.preventDefault();
        e.stopPropagation();

        if (!this.graph) return;

        // 计算世界坐标
        const position = this.getWorldPosition(e);
        this.dropPosition = position;

        // 检查碰撞并更新视觉反馈
        if (this.options.allowOverlap === false && this.currentNodeOptions) {
            const hasCollision = this.checkCollision(position, this.currentNodeOptions);
            this.updateCollisionFeedback(hasCollision);
        }

        // 设置放置效果
        if (e.dataTransfer) {
            const canDrop = this.validateDrop(position);
            e.dataTransfer.dropEffect = canDrop ? 'copy' : 'none';
        }

        // 只有当正在拖拽时才触发事件
        if (this.isDragging) {
            // 触发拖拽移动事件
            const dndEvent = this.createDndEvent('dnd:drag', e, position);
            this.emit('dnd:drag', dndEvent);
            this.options.onDrag?.(dndEvent);
        }
    }

    /**
     * 更新碰撞视觉反馈
     */
    private updateCollisionFeedback(hasCollision: boolean): void {
        if (this.isCollision === hasCollision) return;
        
        this.isCollision = hasCollision;
        
        if (hasCollision) {
            this.showCollisionOverlay();
        } else {
            this.hideCollisionOverlay();
        }
    }

    /**
     * 显示碰撞提示覆盖层
     */
    private showCollisionOverlay(): void {
        if (!this.graph || !this.currentNodeOptions || !this.dropPosition) return;

        const canvas = this.graph.getCanvas();
        
        if (!this.collisionOverlayElement) {
            this.collisionOverlayElement = document.createElement('div');
            this.collisionOverlayElement.style.cssText = `
                position: absolute;
                pointer-events: none;
                z-index: 9998;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 14px;
                color: #ef4444;
                background: rgba(239, 68, 68, 0.1);
                border: 2px dashed #ef4444;
                border-radius: 8px;
                transition: all 0.15s ease;
            `;
            canvas.parentElement?.appendChild(this.collisionOverlayElement);
        }

        // 计算屏幕坐标位置
        const screenPoint = this.graph.worldToScreen(this.dropPosition);
        const width = this.currentNodeOptions.style?.width ?? 200;
        const height = this.currentNodeOptions.style?.height ?? 80;
        const scale = this.graph.getZoom();

        this.collisionOverlayElement.style.left = `${screenPoint.x - (width * scale) / 2}px`;
        this.collisionOverlayElement.style.top = `${screenPoint.y - (height * scale) / 2}px`;
        this.collisionOverlayElement.style.width = `${width * scale}px`;
        this.collisionOverlayElement.style.height = `${height * scale}px`;
        this.collisionOverlayElement.textContent = '🚫 禁止放置区';
        this.collisionOverlayElement.style.display = 'flex';
    }

    /**
     * 隐藏碰撞提示覆盖层
     */
    private hideCollisionOverlay(): void {
        if (this.collisionOverlayElement) {
            this.collisionOverlayElement.style.display = 'none';
        }
    }

    /**
     * 处理拖拽进入画布
     */
    private handleDragEnter(e: DragEvent): void {
        e.preventDefault();
        e.stopPropagation();

        if (!this.graph) return;

        // 触发拖拽进入事件
        const position = this.getWorldPosition(e);
        const dndEvent = this.createDndEvent('dnd:dragenter', e, position);
        this.emit('dnd:dragenter', dndEvent);
        this.options.onDragEnter?.(dndEvent);
    }

    /**
     * 处理拖拽离开画布
     */
    private handleDragLeave(e: DragEvent): void {
        e.preventDefault();
        e.stopPropagation();

        if (!this.graph) return;

        // 检查是否真的离开了画布
        const canvas = this.graph.getCanvas();
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX;
        const y = e.clientY;

        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
            const position = this.getWorldPosition(e);
            const dndEvent = this.createDndEvent('dnd:dragleave', e, position);
            this.emit('dnd:dragleave', dndEvent);
            this.options.onDragLeave?.(dndEvent);
        }
    }

    /**
     * 处理放置
     */
    private handleDrop(e: DragEvent): void {
        e.preventDefault();
        e.stopPropagation();

        if (!this.graph) return;

        // 计算放置位置（如果 dropPosition 为 null）
        let position = this.dropPosition;
        if (!position) {
            position = this.getWorldPosition(e);
        }

        // 验证放置
        if (!this.validateDrop(position)) {
            this.cleanup();
            return;
        }

        // 转换节点配置
        let finalNodeOptions = this.currentNodeOptions;
        if (!finalNodeOptions) {
            // 尝试从 dataTransfer 获取节点配置
            try {
                const data = e.dataTransfer?.getData('application/json');
                if (data) {
                    finalNodeOptions = JSON.parse(data) as NodeOptions;
                }
            } catch {
                // 解析失败
            }
        }

        if (!finalNodeOptions) {
            this.cleanup();
            return;
        }

        // 应用转换
        if (this.options.transformNodeOptions) {
            finalNodeOptions = this.options.transformNodeOptions(position, finalNodeOptions);
        } else {
            // 默认设置节点位置为放置位置
            finalNodeOptions = {
                ...finalNodeOptions,
                x: position.x,
                y: position.y,
            };
        }

        // 触发放置事件
        const dndEvent = this.createDndEvent('dnd:drop', e, position);
        dndEvent.nodeOptions = finalNodeOptions;

        // 先触发事件，让监听器有机会阻止
        const eventPrevented = !this.emit('dnd:drop', dndEvent);
        
        // 调用 onDrop 回调（返回 false 可阻止放置）
        const onDropResult = this.options.onDrop?.(dndEvent);
        
        // 如果 onDrop 返回 false 或事件被阻止，则不创建节点
        if (onDropResult === false || eventPrevented) {
            this.cleanup();
            return;
        }

        // 创建节点
        this.graph.addNode(finalNodeOptions);

        // 标记已成功放置
        this.isDropped = true;

        this.cleanup();
    }

    /**
     * 处理拖拽结束
     */
    private handleDragEnd(e: DragEvent): void {
        // 如果已经放置成功，不需要再触发 dragend 事件
        if (this.isDropped) {
            this.cleanup();
            return;
        }

        if (!this.isDragging) return;

        const dndEvent = this.createDndEvent('dnd:dragend', e);
        this.emit('dnd:dragend', dndEvent);
        this.options.onDragEnd?.(dndEvent);

        this.cleanup();
    }

    /**
     * 清理状态
     */
    private cleanup(): void {
        this.isDragging = false;
        this.isDropped = false;
        this.currentNodeOptions = null;
        this.dropPosition = null;
        this.isCollision = false;

        // 移除拖拽预览元素
        if (this.dragPreviewElement && this.dragPreviewElement.parentNode) {
            this.dragPreviewElement.parentNode.removeChild(this.dragPreviewElement);
            this.dragPreviewElement = null;
        }

        // 移除碰撞提示元素
        if (this.collisionOverlayElement && this.collisionOverlayElement.parentNode) {
            this.collisionOverlayElement.parentNode.removeChild(this.collisionOverlayElement);
            this.collisionOverlayElement = null;
        }
    }

    /**
     * 验证放置位置
     */
    private validateDrop(position: Point): boolean {
        if (!this.currentNodeOptions) return false;

        // 检查是否允许重叠
        if (this.options.allowOverlap === false) {
            if (this.checkCollision(position, this.currentNodeOptions)) {
                return false;
            }
        }

        // 调用用户自定义验证
        if (this.options.validateDrop) {
            return this.options.validateDrop(position, this.currentNodeOptions);
        }
        return true;
    }

    /**
     * 检查节点是否与其他节点发生碰撞
     * @param position - 放置位置
     * @param nodeOptions - 节点配置
     * @returns 是否发生碰撞
     */
    private checkCollision(position: Point, nodeOptions: NodeOptions): boolean {
        if (!this.graph) return false;

        // 获取新节点的边界框
        const newNodeBounds = this.getNodeBounds(position, nodeOptions);

        // 获取所有已有节点
        const existingNodes = this.graph.getAllNodes();

        // 检查与每个已有节点的碰撞
        for (const node of existingNodes) {
            const existingBounds = node.getBounds();

            if (this.isBoundsIntersect(newNodeBounds, existingBounds)) {
                return true;
            }
        }

        return false;
    }

    /**
     * 获取节点在指定位置的边界框
     */
    private getNodeBounds(
        position: Point,
        nodeOptions: NodeOptions
    ): { x: number; y: number; width: number; height: number } {
        const width = nodeOptions.style?.width ?? 200;
        const height = nodeOptions.style?.height ?? 80;

        return {
            x: position.x - width / 2,
            y: position.y - height / 2,
            width,
            height,
        };
    }

    /**
     * 检查两个边界框是否相交
     */
    private isBoundsIntersect(
        bounds1: { x: number; y: number; width: number; height: number },
        bounds2: { x: number; y: number; width: number; height: number }
    ): boolean {
        return !(
            bounds1.x + bounds1.width < bounds2.x ||
            bounds2.x + bounds2.width < bounds1.x ||
            bounds1.y + bounds1.height < bounds2.y ||
            bounds2.y + bounds2.height < bounds1.y
        );
    }

    /**
     * 获取世界坐标
     */
    private getWorldPosition(e: DragEvent): Point {
        if (!this.graph) {
            return { x: 0, y: 0 };
        }
        const canvas = this.graph.getCanvas();
        const rect = canvas.getBoundingClientRect();
        const screenPoint: Point = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
        };
        return this.graph.screenToWorld(screenPoint);
    }

    /**
     * 创建 Dnd 事件对象
     */
    private createDndEvent(
        type: DndEvent['type'],
        originalEvent: DragEvent,
        position?: Point
    ): DndEvent {
        return {
            type,
            originalEvent,
            target: this.graph!,
            position: position || this.getWorldPosition(originalEvent),
            nodeOptions: this.currentNodeOptions || undefined,
            dragElement: this.dragPreviewElement || undefined,
        };
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
     * 触发事件
     */
    private emit(eventName: string, eventData: DndEvent): boolean {
        return this.eventManager.emit(eventName, eventData);
    }

    // ==================== 公共方法 ====================

    /**
     * 检查是否正在拖拽
     */
    isDraggingActive(): boolean {
        return this.isDragging;
    }

    /**
     * 获取当前拖拽的节点配置
     */
    getCurrentNodeOptions(): NodeOptions | null {
        return this.currentNodeOptions ? { ...this.currentNodeOptions } : null;
    }

    /**
     * 获取当前的放置位置
     */
    getDropPosition(): Point | null {
        return this.dropPosition ? { ...this.dropPosition } : null;
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
     * 是否启用
     */
    getEnabled(): boolean {
        return this.options.enabled ?? true;
    }

    /**
     * 获取绑定的 Graph 实例
     */
    getGraph(): Graph | null {
        return this.graph;
    }

    /**
     * 销毁插件（等同于 uninstall）
     */
    destroy(): void {
        this.uninstall();
    }
}

export default Dnd;
