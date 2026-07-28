/**
 * 事件处理器类型
 */
export type EventHandler<T = any> = (event: T) => void | boolean;

/**
 * 基础事件对象接口
 */
export interface BaseEvent {
    /** 事件类型 */
    type: string;
    /** 事件目标 */
    target: any;
    /** 原始 DOM 事件 */
    originalEvent?: Event;
    /** 是否阻止冒泡 */
    stopPropagation?: () => void;
    /** 是否阻止默认行为 */
    preventDefault?: () => void;
}

/**
 * 鼠标事件对象接口
 */
export interface MouseEvent extends BaseEvent {
    /** 鼠标 X 坐标（相对于画布） */
    x: number;
    /** 鼠标 Y 坐标（相对于画布） */
    y: number;
    /** 鼠标 X 坐标（相对于视口） */
    clientX: number;
    /** 鼠标 Y 坐标（相对于视口） */
    clientY: number;
    /** 是否按下 Ctrl 键 */
    ctrlKey: boolean;
    /** 是否按下 Shift 键 */
    shiftKey: boolean;
    /** 是否按下 Alt 键 */
    altKey: boolean;
    /** 是否按下 Meta 键 */
    metaKey: boolean;
    /** 鼠标按钮（0: 左键, 1: 中键, 2: 右键） */
    button: number;
}

/**
 * 滚轮事件对象接口
 */
export interface WheelEvent extends MouseEvent {
    /** 水平滚动量 */
    deltaX: number;
    /** 垂直滚动量 */
    deltaY: number;
    /** Z 轴滚动量 */
    deltaZ: number;
    /** 滚动模式 */
    deltaMode: number;
}

/**
 * 事件名称映射表
 */
export const EVENT_NAMES = {
    // Cell 事件
    CELL_CLICK: 'cell:click',
    CELL_DBLCLICK: 'cell:dblclick',
    CELL_CONTEXTMENU: 'cell:contextmenu',
    CELL_MOUSEDOWN: 'cell:mousedown',
    CELL_MOUSEMOVE: 'cell:mousemove',
    CELL_MOUSEUP: 'cell:mouseup',
    CELL_MOUSEWHEEL: 'cell:mousewheel',
    CELL_MOUSEENTER: 'cell:mouseenter',
    CELL_MOUSELEAVE: 'cell:mouseleave',

    // Node 事件
    NODE_CLICK: 'node:click',
    NODE_DBLCLICK: 'node:dblclick',
    NODE_CONTEXTMENU: 'node:contextmenu',
    NODE_MOUSEDOWN: 'node:mousedown',
    NODE_MOUSEMOVE: 'node:mousemove',
    NODE_MOUSEUP: 'node:mouseup',
    NODE_MOUSEWHEEL: 'node:mousewheel',
    NODE_MOUSEENTER: 'node:mouseenter',
    NODE_MOUSELEAVE: 'node:mouseleave',
    NODE_DRAGSTART: 'node:dragstart',
    NODE_DRAG: 'node:drag',
    NODE_DRAGEND: 'node:dragend',
    NODE_SELECTED: 'node:selected',
    NODE_UNSELECTED: 'node:unselected',

    // Port 事件
    PORT_CLICK: 'node:port:click',
    PORT_DBLCLICK: 'node:port:dblclick',
    PORT_CONTEXTMENU: 'node:port:contextmenu',
    PORT_MOUSEDOWN: 'node:port:mousedown',
    PORT_MOUSEMOVE: 'node:port:mousemove',
    PORT_MOUSEUP: 'node:port:mouseup',
    PORT_MOUSEENTER: 'node:port:mouseenter',
    PORT_MOUSELEAVE: 'node:port:mouseleave',

    // Edge 事件
    EDGE_CLICK: 'edge:click',
    EDGE_DBLCLICK: 'edge:dblclick',
    EDGE_CONTEXTMENU: 'edge:contextmenu',
    EDGE_MOUSEDOWN: 'edge:mousedown',
    EDGE_MOUSEMOVE: 'edge:mousemove',
    EDGE_MOUSEUP: 'edge:mouseup',
    EDGE_MOUSEWHEEL: 'edge:mousewheel',
    EDGE_MOUSEENTER: 'edge:mouseenter',
    EDGE_MOUSELEAVE: 'edge:mouseleave',

    // Graph/Blank 事件
    BLANK_CLICK: 'blank:click',
    BLANK_CONTEXTMENU: 'blank:contextmenu',
    BLANK_MOUSEDOWN: 'blank:mousedown',
    BLANK_MOUSEMOVE: 'blank:mousemove',
    BLANK_MOUSEUP: 'blank:mouseup',
} as const;

/**
 * 事件名称类型
 */
export type EventName = typeof EVENT_NAMES[keyof typeof EVENT_NAMES];

/**
 * EventManager - 事件管理器
 *
 * 提供统一的事件注册、注销和触发机制：
 * - 支持多个事件处理器
 * - 支持单次触发的事件
 * - 支持事件冒泡控制
 * - 支持命名空间（用于批量注销）
 */
export class EventManager {
    private handlers: Map<string, Set<EventHandler>> = new Map();
    private onceHandlers: Map<string, Set<EventHandler>> = new Map();

    /**
     * 注册事件处理器
     * @param eventName - 事件名称
     * @param handler - 事件处理器
     * @returns 注销函数
     */
    on(eventName: string, handler: EventHandler): () => void {
        if (!this.handlers.has(eventName)) {
            this.handlers.set(eventName, new Set());
        }
        this.handlers.get(eventName)!.add(handler);

        // 返回注销函数
        return () => {
            this.off(eventName, handler);
        };
    }

    /**
     * 注册一次性事件处理器（只触发一次）
     * @param eventName - 事件名称
     * @param handler - 事件处理器
     * @returns 注销函数
     */
    once(eventName: string, handler: EventHandler): () => void {
        if (!this.onceHandlers.has(eventName)) {
            this.onceHandlers.set(eventName, new Set());
        }
        this.onceHandlers.get(eventName)!.add(handler);

        // 返回注销函数
        return () => {
            this.off(eventName, handler);
        };
    }

    /**
     * 注销事件处理器
     * @param eventName - 事件名称
     * @param handler - 要注销的处理器（不传则注销该事件的所有处理器）
     */
    off(eventName: string, handler?: EventHandler): void {
        if (handler) {
            // 注销指定处理器
            this.handlers.get(eventName)?.delete(handler);
            this.onceHandlers.get(eventName)?.delete(handler);
        } else {
            // 注销该事件的所有处理器
            this.handlers.delete(eventName);
            this.onceHandlers.delete(eventName);
        }
    }

    /**
     * 触发事件
     * @param eventName - 事件名称
     * @param eventData - 事件数据
     * @returns 是否有处理器返回 false（用于阻止默认行为）
     */
    emit(eventName: string, eventData: any): boolean {
        let prevented = false;

        // 处理普通事件
        const handlers = this.handlers.get(eventName);
        if (handlers) {
            for (const handler of handlers) {
                const result = handler(eventData);
                if (result === false) {
                    prevented = true;
                }
            }
        }

        // 处理一次性事件
        const onceHandlers = this.onceHandlers.get(eventName);
        if (onceHandlers) {
            for (const handler of onceHandlers) {
                const result = handler(eventData);
                if (result === false) {
                    prevented = true;
                }
            }
            // 触发后删除一次性处理器
            this.onceHandlers.delete(eventName);
        }

        return !prevented;
    }

    /**
     * 检查是否有指定事件的处理器
     * @param eventName - 事件名称
     */
    hasHandlers(eventName: string): boolean {
        const hasRegular = (this.handlers.get(eventName)?.size ?? 0) > 0;
        const hasOnce = (this.onceHandlers.get(eventName)?.size ?? 0) > 0;
        return hasRegular || hasOnce;
    }

    /**
     * 获取指定事件的处理器数量
     * @param eventName - 事件名称
     */
    getHandlerCount(eventName: string): number {
        const regularCount = this.handlers.get(eventName)?.size ?? 0;
        const onceCount = this.onceHandlers.get(eventName)?.size ?? 0;
        return regularCount + onceCount;
    }

    /**
     * 清除所有事件处理器
     */
    clear(): void {
        this.handlers.clear();
        this.onceHandlers.clear();
    }

    /**
     * 根据命名空间批量注销事件
     * @param namespace - 命名空间（事件名称后缀，如 "myNamespace"）
     */
    offByNamespace(namespace: string): void {
        const suffix = `:${namespace}`;

        // 清理普通处理器
        for (const [eventName] of this.handlers) {
            if (eventName.endsWith(suffix)) {
                this.handlers.delete(eventName);
            }
        }

        // 清理一次性处理器
        for (const [eventName] of this.onceHandlers) {
            if (eventName.endsWith(suffix)) {
                this.onceHandlers.delete(eventName);
            }
        }
    }
}

/**
 * 可混入事件功能的接口
 */
export interface IEventful {
    /**
     * 注册事件处理器
     */
    on(eventName: string, handler: EventHandler): () => void;

    /**
     * 注册一次性事件处理器
     */
    once(eventName: string, handler: EventHandler): () => void;

    /**
     * 注销事件处理器
     */
    off(eventName: string, handler?: EventHandler): void;

    /**
     * 触发事件
     */
    emit(eventName: string, eventData: any): boolean;
}

/**
 * 事件功能混入类
 * 可以被其他类继承或组合使用
 */
export class Eventful implements IEventful {
    protected eventManager: EventManager;

    constructor() {
        this.eventManager = new EventManager();
    }

    /**
     * 注册事件处理器
     */
    on(eventName: string, handler: EventHandler): () => void {
        return this.eventManager.on(eventName, handler);
    }

    /**
     * 注册一次性事件处理器
     */
    once(eventName: string, handler: EventHandler): () => void {
        return this.eventManager.once(eventName, handler);
    }

    /**
     * 注销事件处理器
     */
    off(eventName: string, handler?: EventHandler): void {
        this.eventManager.off(eventName, handler);
    }

    /**
     * 触发事件
     */
    emit(eventName: string, eventData: any): boolean {
        return this.eventManager.emit(eventName, eventData);
    }

    /**
     * 检查是否有指定事件的处理器
     */
    hasHandlers(eventName: string): boolean {
        return this.eventManager.hasHandlers(eventName);
    }

    /**
     * 销毁事件管理器
     */
    destroy(): void {
        this.eventManager.clear();
    }
}

export default EventManager;
