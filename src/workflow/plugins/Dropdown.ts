import { Graph } from '../core/Graph';
import { Node } from '../core/Node';
import { Edge } from '../core/Edge';
import { Cell } from '../core/Cell';
import type { Plugin } from './Dnd';

/**
 * 菜单项配置
 */
export interface MenuItem {
    /** 菜单项标签 */
    label: string;
    /** 菜单项图标（可选） */
    icon?: string;
    /** 点击回调 */
    action: (target: Node | Edge | Cell | null, event: any) => void;
    /** 是否危险操作（红色文字） */
    danger?: boolean;
    /** 是否禁用 */
    disabled?: boolean;
    /** 是否为纯展示的提示文本（不可点击、无悬停效果，常用于菜单顶部显示上下文信息） */
    header?: boolean;
}

/**
 * Dropdown 配置选项
 */
export interface DropdownOptions {
    /** 节点右键菜单配置 */
    nodeMenu?: MenuItem[] | ((node: Node, event: any) => MenuItem[]);
    /** 边右键菜单配置 */
    edgeMenu?: MenuItem[] | ((edge: Edge, event: any) => MenuItem[]);
    /** 单元格（节点/边）右键菜单配置 */
    cellMenu?: MenuItem[] | ((cell: Cell, event: any) => MenuItem[]);
    /** 空白区域右键菜单配置 */
    blankMenu?: MenuItem[] | ((event: any) => MenuItem[]);
    /** 菜单宽度 */
    menuWidth?: number;
    /** 菜单背景色 */
    backgroundColor?: string;
    /** 菜单文字颜色 */
    textColor?: string;
    /** 危险操作文字颜色 */
    dangerColor?: string;
    /** 悬停背景色 */
    hoverColor?: string;
    /** 危险操作悬停背景色 */
    dangerHoverColor?: string;
    /** 菜单圆角 */
    borderRadius?: number;
    /** 菜单边框颜色 */
    borderColor?: string;
    /** 菜单阴影 */
    boxShadow?: string;
    /** 点击其他地方是否关闭菜单 */
    closeOnClickOutside?: boolean;
    /** 拖拽时是否关闭菜单 */
    closeOnDrag?: boolean;
}

/**
 * Dropdown 插件 - 右键菜单功能
 *
 * 为 Graph 提供统一的右键菜单支持。
 *
 * 使用方式：
 * 1. 在 Graph 配置中直接设置 dropdown 选项（推荐）
 * 2. 通过 `graph.use(new Dropdown(options))` 手动注册
 *
 * @example
 * ```typescript
 * // 方式1：在 Graph 配置中直接设置
 * const graph = new Graph({
 *   container: container,
 *   dropdown: {
 *     nodeMenu: [
 *       { label: '复制节点', icon: '📋', action: (node) => console.log('复制', node.getId()) },
 *       { label: '删除节点', icon: '🗑️', danger: true, action: (node) => graph.removeNode(node.getId()) },
 *     ],
 *   },
 * });
 *
 * // 方式2：手动注册插件
 * graph.use(new Dropdown({
 *   nodeMenu: [...],
 * }));
 * ```
 */
export class Dropdown implements Plugin {
    readonly name = 'dropdown';

    private graph: Graph | null = null;
    private options: Required<DropdownOptions>;
    private currentPopup: HTMLDivElement | null = null;
    private container: HTMLElement | null = null;
    /** 容器级 DOM 监听（destroy 时移除） */
    private boundContainerMouseDown: ((e: globalThis.MouseEvent) => void) | null = null;
    private boundContainerWheel: (() => void) | null = null;

    constructor(options: DropdownOptions = {}) {
        this.options = {
            nodeMenu: options.nodeMenu || [],
            edgeMenu: options.edgeMenu || [],
            cellMenu: options.cellMenu || [],
            blankMenu: options.blankMenu || [],
            menuWidth: options.menuWidth || 140,
            backgroundColor: options.backgroundColor || '#ffffff',
            textColor: options.textColor || '#334155',
            dangerColor: options.dangerColor || '#dc2626',
            hoverColor: options.hoverColor || '#f1f5f9',
            dangerHoverColor: options.dangerHoverColor || '#fef2f2',
            borderRadius: options.borderRadius || 6,
            borderColor: options.borderColor || '#e2e8f0',
            boxShadow: options.boxShadow || '0 4px 12px rgba(0,0,0,0.15)',
            closeOnClickOutside: options.closeOnClickOutside !== false,
            closeOnDrag: options.closeOnDrag !== false,
        };
    }

    /**
     * 安装插件
     */
    install(graph: Graph): void {
        this.graph = graph;
        this.init();
    }

    /**
     * 卸载插件
     */
    uninstall(): void {
        this.destroy();
        this.graph = null;
        this.container = null;
    }

    /**
     * 从 Graph 配置选项创建 Dropdown 插件
     * 由 Graph 内部调用
     * @internal
     */
    static fromOptions(options: DropdownOptions): Dropdown {
        return new Dropdown(options);
    }

    /**
     * 初始化插件
     */
    private init(): void {
        // 获取画布容器 - 通过 Graph 实例的公开属性
        this.container = (this.graph as any).container;
        if (!this.container) {
            console.warn('Dropdown: 未找到画布容器，请确保 Graph 已初始化');
            return;
        }

        // 绑定事件
        this.bindEvents();
    }

    /**
     * 绑定事件监听
     */
    private bindEvents(): void {
        if (!this.graph) return;

        // 节点右键菜单
        if (this.options.nodeMenu.length > 0 || typeof this.options.nodeMenu === 'function') {
            this.graph.on('node:contextmenu', (e: any) => {
                e.preventDefault?.();
                const menuItems = typeof this.options.nodeMenu === 'function'
                    ? (this.options.nodeMenu as Function)(e.node, e)
                    : this.options.nodeMenu;
                if (menuItems && menuItems.length > 0) {
                    this.show(e.node, e, menuItems);
                }
            });
        }

        // 边右键菜单
        if (this.options.edgeMenu.length > 0 || typeof this.options.edgeMenu === 'function') {
            this.graph.on('edge:contextmenu', (e: any) => {
                e.preventDefault?.();
                const menuItems = typeof this.options.edgeMenu === 'function'
                    ? (this.options.edgeMenu as Function)(e.edge, e)
                    : this.options.edgeMenu;
                if (menuItems && menuItems.length > 0) {
                    this.show(e.edge, e, menuItems);
                }
            });
        }

        // 单元格右键菜单（节点/边）
        if (this.options.cellMenu.length > 0 || typeof this.options.cellMenu === 'function') {
            this.graph.on('cell:contextmenu', (e: any) => {
                e.preventDefault?.();
                const menuItems = typeof this.options.cellMenu === 'function'
                    ? (this.options.cellMenu as Function)(e.cell, e)
                    : this.options.cellMenu;
                if (menuItems && menuItems.length > 0) {
                    this.show(e.cell, e, menuItems);
                }
            });
        }

        // 空白区域右键菜单
        if (this.options.blankMenu.length > 0 || typeof this.options.blankMenu === 'function') {
            this.graph.on('blank:contextmenu', (e: any) => {
                e.preventDefault?.();
                const menuItems = typeof this.options.blankMenu === 'function'
                    ? (this.options.blankMenu as Function)(e)
                    : this.options.blankMenu;
                if (menuItems && menuItems.length > 0) {
                    this.show(null, e, menuItems);
                }
            });
        }

        // 点击空白处关闭菜单
        if (this.options.closeOnClickOutside) {
            this.graph.on('blank:mousedown', () => {
                this.close();
            });
        }

        // 拖拽节点时关闭菜单
        if (this.options.closeOnDrag) {
            this.graph.on('node:dragstart', () => {
                this.close();
            });
        }

        // 全局点击事件（处理点击非菜单区域）
        if (this.options.closeOnClickOutside && this.container) {
            this.boundContainerMouseDown = (e) => {
                if (this.currentPopup && !this.currentPopup.contains(e.target as globalThis.Node)) {
                    this.close();
                }
            };
            this.container.addEventListener('mousedown', this.boundContainerMouseDown);
        }

        // 滚轮缩放时关闭菜单：菜单位置按打开时的屏幕坐标固定，
        // 缩放后画布内容移动，菜单不跟随节点，留着会“飘”在错误位置
        if (this.container) {
            this.boundContainerWheel = () => {
                this.close();
            };
            this.container.addEventListener('wheel', this.boundContainerWheel, { passive: true });
        }
    }

    /**
     * 显示菜单
     * @param target - 目标对象（节点/边/null）
     * @param event - 事件对象
     * @param items - 菜单项配置
     */
    public show(target: Node | Edge | Cell | null, event: any, items?: MenuItem[]): void {
        // 关闭已有菜单
        this.close();

        const menuItems = items || [];
        if (menuItems.length === 0) return;

        // 检查事件对象是否有效
        if (!event || typeof event.clientX !== 'number' || typeof event.clientY !== 'number') {
            console.warn('Dropdown.show: 无效的事件对象，无法显示菜单');
            return;
        }

        // 获取容器边界
        const containerRect = this.container!.getBoundingClientRect();

        // 计算菜单位置（相对于容器）
        const popupX = event.clientX - containerRect.left + 10;
        const popupY = event.clientY - containerRect.top;

        // 创建菜单容器
        const popup = document.createElement('div');
        popup.style.cssText = `
            position: absolute;
            left: ${popupX}px;
            top: ${popupY}px;
            background: ${this.options.backgroundColor};
            border: 1px solid ${this.options.borderColor};
            border-radius: ${this.options.borderRadius}px;
            box-shadow: ${this.options.boxShadow};
            padding: 4px 0;
            min-width: ${this.options.menuWidth}px;
            z-index: 1000;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        `;

        // 创建菜单项
        menuItems.forEach((item) => {
            // 纯展示项（菜单顶部的上下文提示）：不可点击、无悬停效果，过长省略号截断
            if (item.header) {
                const headerEl = document.createElement('div');
                headerEl.style.cssText = `
                    padding: 5px 14px;
                    font-size: 11px;
                    line-height: 1.4;
                    color: ${this.options.textColor};
                    opacity: 0.5;
                    max-width: 260px;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    cursor: default;
                    user-select: none;
                    border-bottom: 1px solid ${this.options.borderColor};
                    margin-bottom: 2px;
                `;
                headerEl.textContent = item.label;
                headerEl.title = item.label; // 悬停可见完整内容
                popup.appendChild(headerEl);
                return;
            }

            const menuItem = document.createElement('div');
            const textColor = item.danger ? this.options.dangerColor : this.options.textColor;
            const hoverBg = item.danger ? this.options.dangerHoverColor : this.options.hoverColor;

            // 禁用项：渲染为灰色、无悬停效果、不可点击（而不是直接隐藏，
            // 让用户知道功能存在但当前不满足条件）
            menuItem.style.cssText = `
                padding: 5px 14px;
                cursor: ${item.disabled ? 'default' : 'pointer'};
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 12px;
                line-height: 1.4;
                color: ${textColor};
                opacity: ${item.disabled ? 0.4 : 1};
                transition: background 0.1s;
                user-select: none;
            `;

            menuItem.innerHTML = `${item.icon || ''} ${item.label}`.trim();

            if (!item.disabled) {
                menuItem.onmouseenter = () => {
                    menuItem.style.background = hoverBg;
                };
                menuItem.onmouseleave = () => {
                    menuItem.style.background = 'transparent';
                };

                menuItem.onclick = () => {
                    this.close();
                    item.action(target, event);
                };
            }

            popup.appendChild(menuItem);
        });

        // 阻止事件冒泡
        popup.addEventListener('mousedown', (ev) => {
            ev.stopPropagation();
        });
        popup.addEventListener('click', (ev) => {
            ev.stopPropagation();
        });

        // 添加到容器
        this.container!.appendChild(popup);
        this.currentPopup = popup;
    }

    /**
     * 关闭菜单
     */
    public close(): void {
        if (this.currentPopup) {
            this.currentPopup.remove();
            this.currentPopup = null;
        }
    }

    /**
     * 销毁插件
     */
    public destroy(): void {
        this.close();
        if (this.container) {
            if (this.boundContainerMouseDown) {
                this.container.removeEventListener('mousedown', this.boundContainerMouseDown);
                this.boundContainerMouseDown = null;
            }
            if (this.boundContainerWheel) {
                this.container.removeEventListener('wheel', this.boundContainerWheel);
                this.boundContainerWheel = null;
            }
        }
        // 解绑事件在 Graph 销毁时自动处理
    }

    /**
     * 更新配置
     * @param options - 新的配置选项
     */
    public updateOptions(options: Partial<DropdownOptions>): void {
        this.options = { ...this.options, ...options };
    }

    /**
     * 获取当前菜单是否显示
     */
    public isOpen(): boolean {
        return this.currentPopup !== null;
    }
}

/**
 * 创建 Dropdown 插件的便捷函数
 * @param options - 菜单配置选项
 * @returns Dropdown 实例
 * @example
 * ```typescript
 * const dropdown = createDropdown({
 *   nodeMenu: [
 *     { label: '删除节点', icon: '🗑️', danger: true, action: (node) => graph.removeNode(node.getId()) },
 *   ],
 * });
 * graph.use(dropdown);
 * ```
 */
export function createDropdown(options: DropdownOptions): Dropdown {
    return new Dropdown(options);
}

export default Dropdown;
