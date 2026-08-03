import { Eventful, type MouseEvent, EVENT_NAMES } from './EventManager';

/**
 * 基础样式接口 - Cell 的通用样式属性
 */
export interface BaseStyle {
    /** 选中状态颜色 */
    selectedColor: string;
    /** 悬停状态颜色 */
    hoverColor: string;
}

/**
 * Cell 配置选项基础接口
 */
export interface CellOptions {
    id: string;
    label?: string;
    data?: Record<string, any>;
    visible?: boolean;
    locked?: boolean;
    /** 层级索引，数值越高显示越在上层，默认 0 */
    zIndex?: number;
}

/**
 * Cell 数据接口
 */
export interface CellData {
    id: string;
    label?: string;
    data?: Record<string, any>;
}

/**
 * Cell 事件对象接口
 */
export interface CellEvent extends MouseEvent {
    /** Cell 实例 */
    cell: Cell;
}

/**
 * Cell - 基础单元类
 *
 * 作为 Node 和 Edge 的基类，提供共同属性和方法：
 * - ID、标签、数据
 * - 选中、悬停状态
 * - 事件系统支持
 * - 序列化和克隆
 *
 * 支持的事件（子类会自动映射到具体事件名）：
 * - cell:click - 单击
 * - cell:dblclick - 双击
 * - cell:contextmenu - 右键
 * - cell:mousedown - 鼠标按下
 * - cell:mousemove - 鼠标移动
 * - cell:mouseup - 鼠标抬起
 * - cell:mousewheel - 鼠标滚轮
 * - cell:mouseenter - 鼠标进入
 * - cell:mouseleave - 鼠标离开
 */
export abstract class Cell extends Eventful {
    protected id: string;
    protected label: string;
    protected data: Record<string, any>;
    protected isSelected: boolean = false;
    protected isHovered: boolean = false;
    protected isVisible: boolean = true;
    protected isLocked: boolean = false;
    protected zIndex: number = 0;

    constructor(options: CellOptions) {
        super();
        this.id = options.id;
        this.label = options.label || '';
        this.data = options.data || {};
        this.isVisible = options.visible !== undefined ? options.visible : true;
        this.isLocked = options.locked !== undefined ? options.locked : false;
        this.zIndex = options.zIndex !== undefined ? options.zIndex : 0;
    }

    /**
     * 获取单元 ID
     */
    getId(): string {
        return this.id;
    }

    /**
     * 获取标签
     */
    getLabel(): string {
        return this.label;
    }

    /**
     * 设置标签
     */
    setLabel(label: string): void {
        this.label = label;
    }

    /**
     * 获取数据
     */
    getData(): Record<string, any> {
        return { ...this.data };
    }

    /**
     * 设置数据
     */
    setData(data: Record<string, any>): void {
        this.data = data;
    }

    /**
     * 设置选中状态
     */
    setSelected(selected: boolean): void {
        this.isSelected = selected;
    }

    /**
     * 是否选中
     */
    getSelected(): boolean {
        return this.isSelected;
    }

    /**
     * 设置悬停状态
     */
    setHovered(hovered: boolean): void {
        this.isHovered = hovered;
    }

    /**
     * 是否悬停
     */
    getHovered(): boolean {
        return this.isHovered;
    }

    /**
     * 设置可见性
     */
    setVisible(visible: boolean): void {
        this.isVisible = visible;
    }

    /**
     * 是否可见
     */
    getVisible(): boolean {
        return this.isVisible;
    }

    /**
     * 设置锁定状态
     */
    setLocked(locked: boolean): void {
        this.isLocked = locked;
    }

    /**
     * 是否锁定
     */
    getLocked(): boolean {
        return this.isLocked;
    }

    /**
     * 设置层级索引
     * @param zIndex - 层级值，数值越高显示越在上层
     */
    setZIndex(zIndex: number): void {
        this.zIndex = zIndex;
    }

    /**
     * 获取层级索引
     */
    getZIndex(): number {
        return this.zIndex;
    }

    /**
     * 切换选中状态
     */
    toggleSelected(): void {
        this.isSelected = !this.isSelected;
    }

    /**
     * 抽象方法：序列化为 JSON
     * 子类必须实现
     */
    abstract toJSON(): CellData;

    /**
     * 抽象方法：克隆单元
     * 子类必须实现
     */
    abstract clone(newId?: string): Cell;

    /**
     * 抽象方法：绘制单元
     * 子类必须实现
     */
    abstract draw(ctx: CanvasRenderingContext2D, ...args: any[]): void;

    /**
     * 获取 CSS 类名
     */
    getClassName(): string {
        const classes = ['cell'];
        if (this.isSelected) classes.push('selected');
        if (this.isHovered) classes.push('hovered');
        if (!this.isVisible) classes.push('hidden');
        if (this.isLocked) classes.push('locked');
        return classes.join(' ');
    }

    /**
     * 基础 CSS 样式字符串
     */
    static readonly BASE_CSS_STYLES = `
        .cell {
            transition: all 0.2s ease;
        }

        .cell.selected {
            filter: brightness(1.1);
        }

        .cell.hovered {
            filter: brightness(1.05);
        }

        .cell.hidden {
            display: none;
        }

        .cell.locked {
            cursor: not-allowed;
        }
    `;

    // ==================== 事件触发方法 ====================

    /**
     * 触发 Cell 相关事件
     * @param eventType - 事件类型（click, dblclick, contextmenu, mousedown, mousemove, mouseup, mousewheel, mouseenter, mouseleave）
     * @param originalEvent - 原始 DOM 事件
     * @param extraData - 额外的事件数据
     * @returns 是否未阻止默认行为
     */
    protected triggerCellEvent(
        eventType: string,
        originalEvent: Event,
        extraData: Partial<CellEvent> = {}
    ): boolean {
        const cellEventName = `cell:${eventType}`;

        // 创建事件对象
        const eventData = this.createCellEvent(originalEvent, extraData);

        // 触发具体 Cell 类型的事件
        return this.emit(cellEventName, eventData);
    }

    /**
     * 创建 Cell 事件对象
     */
    protected createCellEvent(
        originalEvent: Event,
        extraData: Partial<CellEvent> = {}
    ): CellEvent {
        // 提取鼠标/触摸坐标
        let clientX = 0;
        let clientY = 0;
        const x = 0;
        const y = 0;

        if (originalEvent instanceof MouseEvent) {
            clientX = originalEvent.clientX;
            clientY = originalEvent.clientY;
            // x, y 需要在子类中根据画布坐标系转换
        }

        return {
            type: 'cell',
            target: this,
            cell: this,
            originalEvent,
            x,
            y,
            clientX,
            clientY,
            ctrlKey: originalEvent instanceof MouseEvent ? originalEvent.ctrlKey : false,
            shiftKey: originalEvent instanceof MouseEvent ? originalEvent.shiftKey : false,
            altKey: originalEvent instanceof MouseEvent ? originalEvent.altKey : false,
            metaKey: originalEvent instanceof MouseEvent ? originalEvent.metaKey : false,
            button: originalEvent instanceof MouseEvent ? originalEvent.button : 0,
            stopPropagation: () => {
                originalEvent.stopPropagation();
            },
            preventDefault: () => {
                originalEvent.preventDefault();
            },
            ...extraData,
        } as CellEvent;
    }

    /**
     * 获取 Cell 的事件名称映射
     * 子类可以重写此方法返回特定的事件名称
     */
    protected getEventNameMap(): Record<string, string> {
        return {
            click: EVENT_NAMES.CELL_CLICK,
            dblclick: EVENT_NAMES.CELL_DBLCLICK,
            contextmenu: EVENT_NAMES.CELL_CONTEXTMENU,
            mousedown: EVENT_NAMES.CELL_MOUSEDOWN,
            mousemove: EVENT_NAMES.CELL_MOUSEMOVE,
            mouseup: EVENT_NAMES.CELL_MOUSEUP,
            mousewheel: EVENT_NAMES.CELL_MOUSEWHEEL,
            mouseenter: EVENT_NAMES.CELL_MOUSEENTER,
            mouseleave: EVENT_NAMES.CELL_MOUSELEAVE,
        };
    }
}

export default Cell;
