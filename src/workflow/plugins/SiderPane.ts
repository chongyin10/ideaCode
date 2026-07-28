import { Graph } from '../core/Graph';
import { Plugin } from './Snapline';

// React 类型声明（如果项目使用 React）
type ReactNode = any;

/**
 * SiderPane 配置选项
 */
export interface SiderPaneOptions {
    /** 是否默认显示侧边栏 */
    visible?: boolean;
    /** 侧边栏初始宽度 */
    width?: number;
    /** 侧边栏最小宽度 */
    minWidth?: number;
    /** 侧边栏最大宽度 */
    maxWidth?: number;
    /** 侧边栏标题 */
    title?: string;
    /** 侧边栏背景颜色 */
    backgroundColor?: string;
    /** 侧边栏边框颜色 */
    borderColor?: string;
    /** 侧边栏阴影 */
    boxShadow?: string;
    /** 侧边栏层级 */
    zIndex?: number;
    /** 是否显示调整大小的手柄 */
    resizable?: boolean;
    /** 调整大小手柄宽度 */
    resizeHandleWidth?: number;
    /** 调整大小手柄颜色 */
    resizeHandleColor?: string;
    /** 调整大小手柄悬停颜色 */
    resizeHandleHoverColor?: string;
    /** 展开/收起按钮颜色 */
    toggleButtonColor?: string;
    /** 展开/收起按钮悬停颜色 */
    toggleButtonHoverColor?: string;
    /** 展开/收起按钮背景色 */
    toggleButtonBg?: string;
    /** 展开/收起按钮悬停背景色 */
    toggleButtonHoverBg?: string;
    /** 自定义内容渲染函数 */
    renderContent?: (container: HTMLElement) => void;
    /** 自定义头部渲染函数 */
    renderHeader?: (container: HTMLElement) => void;
    /** React 内容组件（renderContent 的 React 语法糖替代） */
    reactContent?: ReactNode;
    /** React 头部组件（renderHeader 的 React 语法糖替代） */
    reactHeader?: ReactNode;
    /** 宽度变化回调 */
    onResize?: (width: number) => void;
    /** 显示/隐藏状态变化回调 */
    onToggle?: (visible: boolean) => void;
}

/**
 * SiderPane - 侧边栏插件
 *
 * 在画布左侧提供一个可伸缩的侧边栏 UI 组件：
 * - 支持自定义内容
 * - 支持左右拖拽调整宽度
 * - 支持隐藏/展开功能
 * - 隐藏后在画布左上角显示展开按钮
 * - 样式大气美观
 *
 * 使用示例：
 * ```typescript
 * const graph = new Graph({
 *     container: document.getElementById('canvas'),
 * });
 *
 * // 使用默认配置
 * const siderPane = new SiderPane({
 *     title: '节点列表',
 *     renderContent: (container) => {
 *         container.innerHTML = '<div>自定义内容</div>';
 *     },
 * });
 * graph.use(siderPane);
 *
 * // 显示/隐藏侧边栏
 * siderPane.show();
 * siderPane.hide();
 * siderPane.toggle();
 * ```
 */
export class SiderPane implements Plugin {
    readonly name = 'SiderPane';

    private graph: Graph | null = null;
    private options: Required<SiderPaneOptions>;
    private container: HTMLDivElement | null = null;
    private paneElement: HTMLDivElement | null = null;
    private contentElement: HTMLDivElement | null = null;
    private resizeHandle: HTMLDivElement | null = null;
    private toggleButton: HTMLDivElement | null = null;
    private headerElement: HTMLDivElement | null = null;

    // 状态
    private isVisible: boolean;
    private currentWidth: number;
    private isResizing: boolean = false;
    private startX: number = 0;
    private startWidth: number = 0;

    // 默认配置
    private static readonly DEFAULT_OPTIONS: Required<SiderPaneOptions> = {
        visible: true,
        width: 280,
        minWidth: 200,
        maxWidth: 500,
        title: '侧边栏',
        backgroundColor: '#ffffff',
        borderColor: '#e5e7eb',
        boxShadow: '4px 0 16px rgba(0, 0, 0, 0.08)',
        zIndex: 100,
        resizable: true,
        resizeHandleWidth: 6,
        resizeHandleColor: 'rgba(0, 0, 0, 0.06)',
        resizeHandleHoverColor: 'rgba(59, 130, 246, 0.5)',
        toggleButtonColor: '#64748b',
        toggleButtonHoverColor: '#3b82f6',
        toggleButtonBg: '#ffffff',
        toggleButtonHoverBg: '#f1f5f9',
        renderContent: () => {},
        renderHeader: () => {},
        reactContent: null,
        reactHeader: null,
        onResize: () => {},
        onToggle: () => {},
    };

    constructor(options: SiderPaneOptions = {}) {
        this.options = {
            ...SiderPane.DEFAULT_OPTIONS,
            ...options,
        };
        this.isVisible = this.options.visible;
        this.currentWidth = this.options.width;
    }

    /**
     * 安装插件
     */
    install(graph: Graph): void {
        this.graph = graph;
        this.createSiderPane();
        this.bindEvents();
    }

    /**
     * 卸载插件
     */
    uninstall(): void {
        this.unbindEvents();
        this.destroySiderPane();
        this.graph = null;
    }

    /**
     * 创建侧边栏元素
     */
    private createSiderPane(): void {
        if (!this.graph) return;

        const graphContainer = this.graph.getCanvas().parentElement;
        if (!graphContainer) return;

        // 确保父容器有定位
        const computedStyle = window.getComputedStyle(graphContainer);
        if (computedStyle.position === 'static') {
            graphContainer.style.position = 'relative';
        }

        // 创建容器
        this.container = document.createElement('div');
        this.container.className = 'graph-siderpane-container';
        this.container.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            bottom: 0;
            z-index: ${this.options.zIndex};
            pointer-events: none;
        `;

        // 创建侧边栏面板
        this.paneElement = document.createElement('div');
        this.paneElement.className = 'graph-siderpane';
        this.paneElement.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            bottom: 0;
            width: ${this.currentWidth}px;
            background-color: ${this.options.backgroundColor};
            border-right: 1px solid ${this.options.borderColor};
            box-shadow: ${this.options.boxShadow};
            display: flex;
            flex-direction: column;
            pointer-events: auto;
            transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            transform: translateX(${this.isVisible ? '0' : '-100%'});
        `;

        // 创建头部
        this.headerElement = document.createElement('div');
        this.headerElement.className = 'graph-siderpane-header';
        this.headerElement.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 16px 20px;
            border-bottom: 1px solid ${this.options.borderColor};
            background: linear-gradient(180deg, #fafbfc 0%, #ffffff 100%);
            min-height: 56px;
            flex-shrink: 0;
        `;

        // 标题
        const titleElement = document.createElement('div');
        titleElement.className = 'graph-siderpane-title';
        titleElement.style.cssText = `
            font-size: 16px;
            font-weight: 600;
            color: #1e293b;
            letter-spacing: 0.5px;
            display: flex;
            align-items: center;
            gap: 8px;
        `;

        // 标题图标
        const titleIcon = document.createElement('span');
        titleIcon.innerHTML = this.getTitleIcon();
        titleIcon.style.cssText = `
            display: flex;
            align-items: center;
            color: #3b82f6;
        `;
        titleElement.appendChild(titleIcon);

        const titleText = document.createElement('span');
        titleText.textContent = this.options.title;
        titleElement.appendChild(titleText);

        this.headerElement.appendChild(titleElement);

        // 关闭按钮
        const closeButton = document.createElement('div');
        closeButton.className = 'graph-siderpane-close';
        closeButton.style.cssText = `
            width: 32px;
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            border-radius: 8px;
            color: ${this.options.toggleButtonColor};
            background: transparent;
            transition: all 0.2s ease;
        `;
        closeButton.innerHTML = this.getCollapseIcon();
        closeButton.addEventListener('click', () => this.hide());
        closeButton.addEventListener('mouseenter', () => {
            closeButton.style.backgroundColor = this.options.toggleButtonHoverBg;
            closeButton.style.color = this.options.toggleButtonHoverColor;
        });
        closeButton.addEventListener('mouseleave', () => {
            closeButton.style.backgroundColor = 'transparent';
            closeButton.style.color = this.options.toggleButtonColor;
        });
        this.headerElement.appendChild(closeButton);

        this.paneElement.appendChild(this.headerElement);

        // 创建内容区域
        this.contentElement = document.createElement('div');
        this.contentElement.className = 'graph-siderpane-content';
        this.contentElement.style.cssText = `
            flex: 1;
            overflow-y: auto;
            overflow-x: hidden;
            padding: 16px 20px;
        `;

        // 调用自定义头部渲染
        if (this.options.renderHeader && this.headerElement) {
            this.options.renderHeader(this.headerElement);
        }

        // 调用自定义内容渲染
        if (this.options.renderContent && this.contentElement) {
            this.options.renderContent(this.contentElement);
        }

        // 渲染 React 内容（语法糖）
        if (this.options.reactContent && this.contentElement) {
            this.renderReactContent(this.options.reactContent, this.contentElement);
        }

        // 渲染 React 头部（语法糖）
        if (this.options.reactHeader && this.headerElement) {
            this.renderReactContent(this.options.reactHeader, this.headerElement);
        }

        this.paneElement.appendChild(this.contentElement);

        // 创建调整大小手柄
        if (this.options.resizable) {
            this.resizeHandle = document.createElement('div');
            this.resizeHandle.className = 'graph-siderpane-resize-handle';
            this.resizeHandle.style.cssText = `
                position: absolute;
                top: 50%;
                right: -3px;
                transform: translateY(-50%);
                width: ${this.options.resizeHandleWidth}px;
                height: 48px;
                cursor: col-resize;
                background: ${this.options.resizeHandleColor};
                transition: all 0.2s ease;
                z-index: 10;
                border-radius: 3px;
                display: flex;
                align-items: center;
                justify-content: center;
            `;

            // 创建拖拽指示点
            const dragIndicator = document.createElement('div');
            dragIndicator.style.cssText = `
                width: 2px;
                height: 20px;
                background: rgba(0, 0, 0, 0.15);
                border-radius: 1px;
            `;
            this.resizeHandle.appendChild(dragIndicator);

            this.paneElement.appendChild(this.resizeHandle);
        }

        this.container.appendChild(this.paneElement);

        // 创建展开按钮
        this.createToggleButton();

        graphContainer.appendChild(this.container);

        // 添加自定义滚动条样式
        this.injectScrollbarStyles();
    }

    /**
     * 创建展开按钮
     */
    private createToggleButton(): void {
        if (!this.container) return;

        this.toggleButton = document.createElement('div');
        this.toggleButton.className = 'graph-siderpane-toggle';
        this.toggleButton.style.cssText = `
            position: absolute;
            top: 16px;
            left: 16px;
            width: 40px;
            height: 40px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            border-radius: 12px;
            color: ${this.options.toggleButtonColor};
            background-color: ${this.options.toggleButtonBg};
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
            pointer-events: auto;
            transition: all 0.2s ease;
            opacity: ${this.isVisible ? '0' : '1'};
            transform: ${this.isVisible ? 'scale(0.8)' : 'scale(1)'};
            visibility: ${this.isVisible ? 'hidden' : 'visible'};
            transition-delay: ${this.isVisible ? '0.2s' : '0s'};
        `;
        this.toggleButton.innerHTML = this.getExpandIcon();
        this.toggleButton.addEventListener('click', () => this.show());
        this.toggleButton.addEventListener('mouseenter', () => {
            if (this.toggleButton) {
                this.toggleButton.style.backgroundColor = this.options.toggleButtonHoverBg;
                this.toggleButton.style.color = this.options.toggleButtonHoverColor;
                this.toggleButton.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.15)';
            }
        });
        this.toggleButton.addEventListener('mouseleave', () => {
            if (this.toggleButton) {
                this.toggleButton.style.backgroundColor = this.options.toggleButtonBg;
                this.toggleButton.style.color = this.options.toggleButtonColor;
                this.toggleButton.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.1)';
            }
        });

        this.container.appendChild(this.toggleButton);
    }

    /**
     * 绑定事件
     */
    private bindEvents(): void {
        if (this.resizeHandle) {
            this.resizeHandle.addEventListener('mousedown', this.handleResizeStart);
            this.resizeHandle.addEventListener('mouseenter', this.handleResizeHover);
            this.resizeHandle.addEventListener('mouseleave', this.handleResizeLeave);
        }
        document.addEventListener('mousemove', this.handleResizeMove);
        document.addEventListener('mouseup', this.handleResizeEnd);
    }

    /**
     * 解绑事件
     */
    private unbindEvents(): void {
        if (this.resizeHandle) {
            this.resizeHandle.removeEventListener('mousedown', this.handleResizeStart);
            this.resizeHandle.removeEventListener('mouseenter', this.handleResizeHover);
            this.resizeHandle.removeEventListener('mouseleave', this.handleResizeLeave);
        }
        document.removeEventListener('mousemove', this.handleResizeMove);
        document.removeEventListener('mouseup', this.handleResizeEnd);
    }

    /**
     * 开始调整大小
     */
    private handleResizeStart = (e: MouseEvent): void => {
        e.preventDefault();
        this.isResizing = true;
        this.startX = e.clientX;
        this.startWidth = this.currentWidth;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        // 添加调整大小时的视觉效果
        if (this.resizeHandle) {
            this.resizeHandle.style.background = 'rgba(59, 130, 246, 0.3)';
            this.resizeHandle.style.height = '64px';
            this.resizeHandle.style.boxShadow = '0 0 8px rgba(59, 130, 246, 0.4)';
        }

        // 添加调整大小时的遮罩
        this.addResizeOverlay();
    };

    /**
     * 调整大小移动
     */
    private handleResizeMove = (e: MouseEvent): void => {
        if (!this.isResizing) return;

        const deltaX = e.clientX - this.startX;
        let newWidth = this.startWidth + deltaX;

        // 限制宽度范围
        newWidth = Math.max(this.options.minWidth, Math.min(this.options.maxWidth, newWidth));

        this.currentWidth = newWidth;
        if (this.paneElement) {
            this.paneElement.style.width = `${newWidth}px`;
        }

        this.options.onResize(newWidth);
    };

    /**
     * 结束调整大小
     */
    private handleResizeEnd = (): void => {
        if (!this.isResizing) return;
        this.isResizing = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';

        // 恢复调整手柄样式
        if (this.resizeHandle) {
            this.resizeHandle.style.background = this.options.resizeHandleHoverColor;
            this.resizeHandle.style.height = '48px';
            this.resizeHandle.style.boxShadow = 'none';
        }

        // 移除调整大小时的遮罩
        this.removeResizeOverlay();
    };

    /**
     * 调整手柄悬停
     */
    private handleResizeHover = (): void => {
        if (this.resizeHandle) {
            this.resizeHandle.style.background = this.options.resizeHandleHoverColor;
        }
    };

    /**
     * 调整手柄离开
     */
    private handleResizeLeave = (): void => {
        if (this.resizeHandle && !this.isResizing) {
            this.resizeHandle.style.background = this.options.resizeHandleColor;
        }
    };

    /**
     * 添加调整大小遮罩
     */
    private addResizeOverlay(): void {
        if (!this.container) return;

        const overlay = document.createElement('div');
        overlay.className = 'graph-siderpane-resize-overlay';
        overlay.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            z-index: 1000;
            cursor: col-resize;
        `;
        this.container.appendChild(overlay);
    }

    /**
     * 移除调整大小遮罩
     */
    private removeResizeOverlay(): void {
        if (!this.container) return;

        const overlay = this.container.querySelector('.graph-siderpane-resize-overlay');
        if (overlay) {
            overlay.remove();
        }
    }

    /**
     * 显示侧边栏
     */
    show(): void {
        if (this.isVisible) return;

        this.isVisible = true;
        if (this.paneElement) {
            this.paneElement.style.transform = 'translateX(0)';
        }
        if (this.toggleButton) {
            this.toggleButton.style.opacity = '0';
            this.toggleButton.style.transform = 'scale(0.8)';
            this.toggleButton.style.visibility = 'hidden';
            this.toggleButton.style.transitionDelay = '0.2s';
        }

        this.options.onToggle(true);
    }

    /**
     * 隐藏侧边栏
     */
    hide(): void {
        if (!this.isVisible) return;

        this.isVisible = false;
        if (this.paneElement) {
            this.paneElement.style.transform = 'translateX(-100%)';
        }
        if (this.toggleButton) {
            this.toggleButton.style.opacity = '1';
            this.toggleButton.style.transform = 'scale(1)';
            this.toggleButton.style.visibility = 'visible';
            this.toggleButton.style.transitionDelay = '0s';
        }

        this.options.onToggle(false);
    }

    /**
     * 切换显示/隐藏
     */
    toggle(): void {
        if (this.isVisible) {
            this.hide();
        } else {
            this.show();
        }
    }

    /**
     * 获取当前可见状态
     */
    getVisible(): boolean {
        return this.isVisible;
    }

    /**
     * 获取当前宽度
     */
    getWidth(): number {
        return this.currentWidth;
    }

    /**
     * 设置宽度
     */
    setWidth(width: number): void {
        const newWidth = Math.max(this.options.minWidth, Math.min(this.options.maxWidth, width));
        this.currentWidth = newWidth;
        if (this.paneElement) {
            this.paneElement.style.width = `${newWidth}px`;
        }
        this.options.onResize(newWidth);
    }

    /**
     * 获取内容容器
     */
    getContentElement(): HTMLDivElement | null {
        return this.contentElement;
    }

    /**
     * 获取头部容器
     */
    getHeaderElement(): HTMLDivElement | null {
        return this.headerElement;
    }

    /**
     * 更新内容
     */
    updateContent(renderFn: (container: HTMLElement) => void): void {
        if (this.contentElement) {
            this.contentElement.innerHTML = '';
            renderFn(this.contentElement);
        }
    }

    /**
     * 更新 React 内容（语法糖）
     */
    updateReactContent(reactNode: ReactNode): void {
        if (this.contentElement) {
            this.contentElement.innerHTML = '';
            this.renderReactContent(reactNode, this.contentElement);
        }
    }

    /**
     * 渲染 React 内容到 DOM 容器
     * 使用 React 18 的 createRoot API
     */
    private renderReactContent(reactNode: ReactNode, container: HTMLElement): void {
        try {
            // 尝试从全局 window 获取 React（如果项目已加载 React）
            const React = (window as any).React;
            const ReactDOM = (window as any).ReactDOM;

            if (!React || !ReactDOM || !ReactDOM.createRoot) {
                console.warn('[SiderPane] React 未在全局环境中找到，请确保项目中已加载 React');
                container.innerHTML = '<div style="padding: 16px; color: #64748b;">请使用 renderContent 替代 reactContent</div>';
                return;
            }

            // 创建 root 并渲染
            const root = ReactDOM.createRoot(container);
            root.render(reactNode);

            // 存储 root 引用以便后续清理
            (container as any).__reactRoot = root;
        } catch (error) {
            console.warn('[SiderPane] React 渲染失败:', error);
            container.innerHTML = '<div style="padding: 16px; color: #ef4444;">React 渲染失败</div>';
        }
    }

    /**
     * 销毁侧边栏
     */
    private destroySiderPane(): void {
        if (this.container && this.container.parentElement) {
            this.container.parentElement.removeChild(this.container);
        }
        this.container = null;
        this.paneElement = null;
        this.contentElement = null;
        this.resizeHandle = null;
        this.toggleButton = null;
        this.headerElement = null;
    }

    /**
     * 注入滚动条样式
     */
    private injectScrollbarStyles(): void {
        const styleId = 'graph-siderpane-scrollbar-styles';
        if (document.getElementById(styleId)) return;

        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            .graph-siderpane-content::-webkit-scrollbar {
                width: 6px;
            }
            .graph-siderpane-content::-webkit-scrollbar-track {
                background: transparent;
            }
            .graph-siderpane-content::-webkit-scrollbar-thumb {
                background-color: #d1d5db;
                border-radius: 3px;
            }
            .graph-siderpane-content::-webkit-scrollbar-thumb:hover {
                background-color: #9ca3af;
            }
        `;
        document.head.appendChild(style);
    }

    /**
     * 获取标题图标
     */
    private getTitleIcon(): string {
        return `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="9" y1="3" x2="9" y2="21"></line>
            </svg>
        `;
    }

    /**
     * 获取展开图标
     */
    private getExpandIcon(): string {
        return `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="9" y1="3" x2="9" y2="21"></line>
                <polyline points="13 8 17 12 13 16"></polyline>
            </svg>
        `;
    }

    /**
     * 获取收起图标
     */
    private getCollapseIcon(): string {
        return `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="15 18 9 12 15 6"></polyline>
            </svg>
        `;
    }
}
