import { Graph } from '../core/Graph';
import { Plugin } from './Snapline';
import { History } from './History';

/**
 * Tools 配置选项
 */
export interface ToolsOptions {
    /** 是否启用工具栏 */
    enabled?: boolean;
    /** 工具栏宽度 */
    width?: number;
    /** 工具栏高度 */
    height?: number;
    /** 工具栏位置 */
    position?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
    /** 工具栏背景颜色 */
    backgroundColor?: string;
    /** 工具栏边框颜色 */
    borderColor?: string;
    /** 工具栏圆角 */
    borderRadius?: number;
    /** 工具栏阴影 */
    boxShadow?: string;
    /** 工具栏层级 */
    zIndex?: number;
    /** 是否显示缩放按钮 */
    showZoom?: boolean;
    /** 是否显示拖拽切换按钮 */
    showDragToggle?: boolean;
    /** 是否显示撤销/重做按钮 */
    showHistory?: boolean;
    /** 是否显示搜索框 */
    showSearch?: boolean;
    /** 缩放步长 */
    zoomStep?: number;
    /** 搜索回调 */
    onSearch?: (keyword: string, results: SearchResults) => void;
    /** 缩放变化回调 */
    onZoomChange?: (scale: number) => void;
    /** 拖拽状态变化回调 */
    onDragToggle?: (enabled: boolean) => void;
}

/**
 * 搜索结果
 */
export interface SearchResults {
    nodes: Array<{ id: string; label?: string; data?: any }>;
    edges: Array<{ id: string; label?: string; data?: any }>;
}

/**
 * 创建 SVG 图标
 */
function createIcon(type: string, size: number = 16, color: string = 'currentColor'): string {
    const icons: Record<string, string> = {
        zoomIn: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            <line x1="11" y1="8" x2="11" y2="14"/>
            <line x1="8" y1="11" x2="14" y2="11"/>
        </svg>`,
        zoomOut: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            <line x1="8" y1="11" x2="14" y2="11"/>
        </svg>`,
        drag: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="5,9 2,12 5,15"/>
            <polyline points="9,5 12,2 15,5"/>
            <polyline points="15,19 12,22 9,19"/>
            <polyline points="19,9 22,12 19,15"/>
            <line x1="2" y1="12" x2="22" y2="12"/>
            <line x1="12" y1="2" x2="12" y2="22"/>
        </svg>`,
        dragDisabled: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="5,9 2,12 5,15"/>
            <polyline points="9,5 12,2 15,5"/>
            <polyline points="15,19 12,22 9,19"/>
            <polyline points="19,9 22,12 19,15"/>
            <line x1="2" y1="12" x2="22" y2="12"/>
            <line x1="12" y1="2" x2="12" y2="22"/>
            <line x1="4" y1="4" x2="20" y2="20" stroke-width="2.5"/>
        </svg>`,
        undo: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="1,4 1,10 7,10"/>
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
        </svg>`,
        redo: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23,4 23,10 17,10"/>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
        </svg>`,
        search: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>`,
    };
    return icons[type] || '';
}

/**
 * Tools - 工具栏插件
 *
 * 在画布上提供一个工具栏，包含以下功能：
 * - 放大/缩小画布
 * - 启用/禁用拖拽画布
 * - 撤销/重做（需要 History 插件）
 * - 搜索节点或边
 *
 * 使用示例：
 * ```typescript
 * const graph = new Graph({
 *     container: document.getElementById('canvas'),
 * });
 *
 * // 创建历史记录插件（可选，用于撤销/重做功能）
 * const history = new History();
 * graph.use(history);
 *
 * // 创建工具栏插件
 * const tools = new Tools({
 *     showZoom: true,
 *     showDragToggle: true,
 *     showHistory: true,
 *     showSearch: true,
 *     onSearch: (keyword, results) => {
 *         console.log('搜索结果:', results);
 *     },
 * });
 * graph.use(tools);
 *
 * // API 方法
 * tools.zoomIn();
 * tools.zoomOut();
 * tools.toggleDrag(enabled);
 * tools.search('keyword');
 * ```
 */
export class Tools implements Plugin {
    readonly name = 'Tools';

    private graph: Graph | null = null;
    private options: Required<ToolsOptions>;
    private container: HTMLDivElement | null = null;
    private toolbarElement: HTMLDivElement | null = null;
    private searchInputElement: HTMLInputElement | null = null;
    private historyPlugin: History | null = null;

    // 状态
    private isEnabled: boolean;
    private isDragEnabled: boolean = true;

    // 默认配置
    private static readonly DEFAULT_OPTIONS: Required<ToolsOptions> = {
        enabled: true,
        width: 30,
        height: 200,
        position: 'top-right',
        backgroundColor: '#ffffff',
        borderColor: '#e5e7eb',
        borderRadius: 8,
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
        zIndex: 1000,
        showZoom: true,
        showDragToggle: true,
        showHistory: true,
        showSearch: false,
        zoomStep: 0.1,
        onSearch: () => {},
        onZoomChange: () => {},
        onDragToggle: () => {},
    };

    constructor(options: ToolsOptions = {}) {
        this.options = {
            ...Tools.DEFAULT_OPTIONS,
            ...options,
        };
        this.isEnabled = this.options.enabled;
    }

    /**
     * 安装插件
     */
    install(graph: Graph): void {
        this.graph = graph;
        this.findHistoryPlugin();
        this.createToolbar();
        this.bindEvents();
    }

    /**
     * 卸载插件
     */
    uninstall(): void {
        this.unbindEvents();
        this.destroyToolbar();
        this.graph = null;
        this.historyPlugin = null;
    }

    /**
     * 查找 History 插件
     */
    private findHistoryPlugin(): void {
        if (!this.graph) return;
        
        // 尝试从 graph 获取已安装的插件
        const plugins = (this.graph as any).plugins;
        if (plugins && plugins instanceof Map) {
            plugins.forEach((plugin: any) => {
                if (plugin.name === 'History' && plugin instanceof History) {
                    this.historyPlugin = plugin;
                }
            });
        }
    }

    /**
     * 创建工具栏元素
     */
    private createToolbar(): void {
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
        this.container.className = 'graph-tools-container';

        // 计算位置样式
        const positionStyle = this.getPositionStyle();

        this.container.style.cssText = `
            position: absolute;
            ${positionStyle}
            z-index: ${this.options.zIndex};
            pointer-events: auto;
        `;

        // 创建工具栏
        this.toolbarElement = document.createElement('div');
        this.toolbarElement.className = 'graph-tools-toolbar';
        this.toolbarElement.style.cssText = `
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 8px;
            background-color: ${this.options.backgroundColor};
            border: 1px solid ${this.options.borderColor};
            border-radius: ${this.options.borderRadius}px;
            box-shadow: ${this.options.boxShadow};
            gap: 4px;
            width: ${this.options.width}px;
        `;

        // 添加工具按钮
        this.addToolButtons();

        this.container.appendChild(this.toolbarElement);
        graphContainer.appendChild(this.container);
    }

    /**
     * 获取位置样式
     */
    private getPositionStyle(): string {
        const margin = 16;
        switch (this.options.position) {
            case 'top-left':
                return `top: ${margin}px; left: ${margin}px;`;
            case 'bottom-right':
                return `bottom: ${margin}px; right: ${margin}px;`;
            case 'bottom-left':
                return `bottom: ${margin}px; left: ${margin}px;`;
            case 'top-right':
            default:
                return `top: ${margin}px; right: ${margin}px;`;
        }
    }

    /**
     * 添加工具按钮
     */
    private addToolButtons(): void {
        if (!this.toolbarElement) return;

        // 缩放按钮组
        if (this.options.showZoom) {
            // 放大按钮
            const zoomInBtn = this.createButton('zoomIn', '放大', () => this.zoomIn());
            this.toolbarElement.appendChild(zoomInBtn);

            // 缩小按钮
            const zoomOutBtn = this.createButton('zoomOut', '缩小', () => this.zoomOut());
            this.toolbarElement.appendChild(zoomOutBtn);

            // 分隔线
            this.toolbarElement.appendChild(this.createDivider());
        }

        // 拖拽切换按钮
        if (this.options.showDragToggle) {
            const dragBtn = this.createButton('drag', '拖拽画布', () => this.toggleDrag());
            dragBtn.className = 'graph-tools-btn graph-tools-drag-btn';
            this.toolbarElement.appendChild(dragBtn);

            // 分隔线
            this.toolbarElement.appendChild(this.createDivider());
        }

        // 撤销/重做按钮
        if (this.options.showHistory) {
            // 撤销按钮
            const undoBtn = this.createButton('undo', '撤销 (Ctrl+Z)', () => this.undo());
            undoBtn.className = 'graph-tools-btn graph-tools-undo-btn';
            this.toolbarElement.appendChild(undoBtn);

            // 重做按钮
            const redoBtn = this.createButton('redo', '重做 (Ctrl+Y)', () => this.redo());
            redoBtn.className = 'graph-tools-btn graph-tools-redo-btn';
            this.toolbarElement.appendChild(redoBtn);

            // 分隔线
            this.toolbarElement.appendChild(this.createDivider());
        }

        // 搜索框
        if (this.options.showSearch) {
            const searchContainer = this.createSearchInput();
            this.toolbarElement.appendChild(searchContainer);
        }
    }

    /**
     * 创建按钮
     */
    private createButton(iconType: string, title: string, onClick: () => void): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.className = 'graph-tools-btn';
        btn.innerHTML = createIcon(iconType, 12, '#64748b');
        btn.title = title;
        btn.style.cssText = `
            width: 24px;
            height: 24px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: transparent;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.2s;
            padding: 0;
        `;

        btn.addEventListener('mouseenter', () => {
            btn.style.backgroundColor = '#f1f5f9';
            btn.innerHTML = createIcon(iconType, 12, '#3b82f6');
        });

        btn.addEventListener('mouseleave', () => {
            btn.style.backgroundColor = 'transparent';
            btn.innerHTML = createIcon(iconType, 12, '#64748b');
        });

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            onClick();
        });

        return btn;
    }

    /**
     * 创建分隔线
     */
    private createDivider(): HTMLDivElement {
        const divider = document.createElement('div');
        divider.style.cssText = `
            width: 100%;
            height: 1px;
            background-color: #e5e7eb;
            margin: 4px 0;
        `;
        return divider;
    }

    /**
     * 创建搜索输入框
     */
    private createSearchInput(): HTMLDivElement {
        const container = document.createElement('div');
        container.style.cssText = `
            position: relative;
            width: 100%;
        `;

        // 搜索图标
        const searchIcon = document.createElement('span');
        searchIcon.innerHTML = createIcon('search', 10, '#94a3b8');
        searchIcon.style.cssText = `
            position: absolute;
            left: 6px;
            top: 50%;
            transform: translateY(-50%);
            pointer-events: none;
            display: flex;
            align-items: center;
        `;

        // 输入框
        this.searchInputElement = document.createElement('input');
        this.searchInputElement.type = 'text';
        this.searchInputElement.placeholder = '搜索...';
        this.searchInputElement.style.cssText = `
            width: 100%;
            height: 28px;
            padding: 0 8px 0 24px;
            border: 1px solid #e5e7eb;
            border-radius: 4px;
            font-size: 12px;
            outline: none;
            box-sizing: border-box;
            transition: border-color 0.2s;
        `;

        this.searchInputElement.addEventListener('focus', () => {
            this.searchInputElement!.style.borderColor = '#3b82f6';
        });

        this.searchInputElement.addEventListener('blur', () => {
            this.searchInputElement!.style.borderColor = '#e5e7eb';
        });

        this.searchInputElement.addEventListener('input', () => {
            this.handleSearch();
        });

        this.searchInputElement.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                this.handleSearch();
            }
        });

        container.appendChild(searchIcon);
        container.appendChild(this.searchInputElement);

        return container;
    }

    /**
     * 处理搜索
     */
    private handleSearch(): void {
        if (!this.graph || !this.searchInputElement) return;

        const keyword = this.searchInputElement.value.trim().toLowerCase();
        
        if (!keyword) {
            this.options.onSearch('', { nodes: [], edges: [] });
            return;
        }

        const results: SearchResults = {
            nodes: [],
            edges: [],
        };

        // 搜索节点
        const nodes = this.graph.getAllNodes();
        nodes.forEach((node) => {
            const label = node.getLabel();
            const id = node.getId();
            const data = node.getData();
            
            if (
                id.toLowerCase().includes(keyword) ||
                (label && label.toLowerCase().includes(keyword)) ||
                (data && JSON.stringify(data).toLowerCase().includes(keyword))
            ) {
                results.nodes.push({
                    id,
                    label,
                    data,
                });
            }
        });

        // 搜索边
        const edges = this.graph.getAllEdges();
        edges.forEach((edge) => {
            const id = edge.getId();
            const label = edge.getLabel();
            const data = (edge as any).data;
            
            if (
                id.toLowerCase().includes(keyword) ||
                (label && label.toLowerCase().includes(keyword)) ||
                (data && JSON.stringify(data).toLowerCase().includes(keyword))
            ) {
                results.edges.push({
                    id,
                    label,
                    data,
                });
            }
        });

        this.options.onSearch(keyword, results);
    }

    /**
     * 绑定事件
     */
    private bindEvents(): void {
        // 阻止工具栏事件冒泡到画布
        if (this.container) {
            this.container.addEventListener('mousedown', (e) => {
                e.stopPropagation();
            });
            this.container.addEventListener('wheel', (e) => {
                e.stopPropagation();
            });
        }
    }

    /**
     * 解绑事件
     */
    private unbindEvents(): void {
        // 事件已通过元素销毁移除
    }

    /**
     * 销毁工具栏
     */
    private destroyToolbar(): void {
        if (this.container && this.container.parentElement) {
            this.container.parentElement.removeChild(this.container);
        }
        this.container = null;
        this.toolbarElement = null;
        this.searchInputElement = null;
    }

    // ============== 公共 API ==============

    /**
     * 放大画布
     */
    zoomIn(): void {
        if (!this.graph) return;
        this.graph.zoomIn(this.options.zoomStep + 1);
        const scale = this.graph.getZoom();
        this.options.onZoomChange(scale);
    }

    /**
     * 缩小画布
     */
    zoomOut(): void {
        if (!this.graph) return;
        this.graph.zoomOut(1 - this.options.zoomStep);
        const scale = this.graph.getZoom();
        this.options.onZoomChange(scale);
    }

    /**
     * 设置缩放比例
     */
    setZoom(scale: number): void {
        if (!this.graph) return;
        this.graph.setScale(scale);
        this.options.onZoomChange(scale);
    }

    /**
     * 获取当前缩放比例
     */
    getZoom(): number {
        if (!this.graph) return 1;
        return this.graph.getZoom();
    }

    /**
     * 切换拖拽状态
     */
    toggleDrag(enabled?: boolean): void {
        if (!this.graph) return;
        
        this.isDragEnabled = enabled !== undefined ? enabled : !this.isDragEnabled;
        this.graph.setDraggable(this.isDragEnabled);
        
        // 更新按钮图标
        this.updateDragButton();
        
        this.options.onDragToggle(this.isDragEnabled);
    }

    /**
     * 更新拖拽按钮图标
     */
    private updateDragButton(): void {
        if (!this.toolbarElement) return;
        
        const dragBtn = this.toolbarElement.querySelector('.graph-tools-drag-btn');
        if (dragBtn) {
            const iconType = this.isDragEnabled ? 'drag' : 'dragDisabled';
            dragBtn.innerHTML = createIcon(iconType, 18, this.isDragEnabled ? '#22c55e' : '#ef4444');
            dragBtn.setAttribute('title', this.isDragEnabled ? '禁用拖拽' : '启用拖拽');
        }
    }

    /**
     * 撤销
     */
    undo(): void {
        if (!this.historyPlugin) {
            console.warn('Tools: History 插件未安装，撤销功能不可用');
            return;
        }
        this.historyPlugin.undo();
    }

    /**
     * 重做
     */
    redo(): void {
        if (!this.historyPlugin) {
            console.warn('Tools: History 插件未安装，重做功能不可用');
            return;
        }
        this.historyPlugin.redo();
    }

    /**
     * 是否可以撤销
     */
    canUndo(): boolean {
        return this.historyPlugin?.canUndo() ?? false;
    }

    /**
     * 是否可以重做
     */
    canRedo(): boolean {
        return this.historyPlugin?.canRedo() ?? false;
    }

    /**
     * 搜索节点或边
     */
    search(keyword: string): SearchResults {
        if (!this.graph) {
            return { nodes: [], edges: [] };
        }

        if (this.searchInputElement) {
            this.searchInputElement.value = keyword;
        }

        const results: SearchResults = {
            nodes: [],
            edges: [],
        };

        const lowerKeyword = keyword.toLowerCase();

        // 搜索节点
        const nodes = this.graph.getAllNodes();
        nodes.forEach((node) => {
            const label = node.getLabel();
            const id = node.getId();
            
            if (
                id.toLowerCase().includes(lowerKeyword) ||
                (label && label.toLowerCase().includes(lowerKeyword))
            ) {
                results.nodes.push({
                    id,
                    label,
                    data: node.getData(),
                });
            }
        });

        // 搜索边
        const edges = this.graph.getAllEdges();
        edges.forEach((edge) => {
            const id = edge.getId();
            const label = edge.getLabel();
            
            if (
                id.toLowerCase().includes(lowerKeyword) ||
                (label && label.toLowerCase().includes(lowerKeyword))
            ) {
                results.edges.push({
                    id,
                    label,
                    data: (edge as any).data,
                });
            }
        });

        this.options.onSearch(keyword, results);
        return results;
    }

    /**
     * 高亮搜索结果
     */
    highlightSearchResults(results: SearchResults): void {
        if (!this.graph) return;

        // 清除所有高亮
        this.graph.getAllNodes().forEach((node) => {
            node.setSelected(false);
        });

        // 高亮匹配的节点
        results.nodes.forEach((result) => {
            const node = this.graph?.getNode(result.id);
            if (node) {
                node.setSelected(true);
            }
        });
    }

    /**
     * 定位到指定节点
     */
    focusNode(nodeId: string): void {
        if (!this.graph) return;

        const node = this.graph.getNode(nodeId);
        if (!node) return;

        const pos = node.getPosition();
        const canvasWidth = this.graph.getCanvas().width;
        const canvasHeight = this.graph.getCanvas().height;

        // 计算居中偏移
        const offsetX = canvasWidth / 2 - pos.x * this.graph.getZoom();
        const offsetY = canvasHeight / 2 - pos.y * this.graph.getZoom();

        this.graph.panTo({ x: offsetX, y: offsetY });
    }

    /**
     * 启用工具栏
     */
    enable(): void {
        this.isEnabled = true;
        if (this.container) {
            this.container.style.display = 'block';
        }
    }

    /**
     * 禁用工具栏
     */
    disable(): void {
        this.isEnabled = false;
        if (this.container) {
            this.container.style.display = 'none';
        }
    }

    /**
     * 获取是否启用
     */
    isEnabledState(): boolean {
        return this.isEnabled;
    }

    /**
     * 更新配置
     */
    setOptions(options: Partial<ToolsOptions>): void {
        this.options = {
            ...this.options,
            ...options,
        };

        // 重新创建工具栏
        this.destroyToolbar();
        if (this.graph) {
            this.createToolbar();
        }
    }

    /**
     * 获取当前配置
     */
    getOptions(): Required<ToolsOptions> {
        return { ...this.options };
    }

    /**
     * 设置 History 插件实例
     */
    setHistoryPlugin(history: History): void {
        this.historyPlugin = history;
    }
}
