import React from 'react';
import ReactDOM from 'react-dom/client';
import { Graph } from '../core/Graph';
import { Node, NodeOptions, NodeStyle } from '../core/Node';
import { Shape, ShapeConfig } from '../core/Shape';
import { Plugin } from './Dnd';

/**
 * React 组件属性接口
 */
export interface ReactNodeProps {
    /** 节点 ID */
    nodeId: string;
    /** 节点数据 */
    data?: Record<string, any>;
    /** 节点位置 */
    position?: { x: number; y: number };
    /** 节点是否被选中 */
    selected?: boolean;
    /** 节点是否悬停 */
    hovered?: boolean;
    /** Graph 实例引用 */
    graph?: Graph;
    /** 节点实例引用 */
    node?: ReactShapeNode;
}

/**
 * React 形状注册配置
 */
export interface ReactShapeConfig {
    /** 形状名称（唯一标识） */
    shape: string;
    /** 默认宽度 */
    width?: number;
    /** 默认高度 */
    height?: number;
    /** React 组件 */
    component: React.ComponentType<ReactNodeProps>;
    /** 是否继承节点默认样式 */
    inheritStyle?: boolean;
    /** 自定义样式 */
    style?: Partial<NodeStyle>;
    /** 是否可调整大小 */
    resizable?: boolean;
    /** 连接桩配置 */
    ports?: ReactShapePortConfig[];
}

/**
 * React 形状连接桩配置
 */
export interface ReactShapePortConfig {
    /** 连接桩 ID */
    id: string;
    /** 连接桩位置 */
    position: 'top' | 'right' | 'bottom' | 'left';
    /** 连接桩标签 */
    label?: string;
}

/**
 * 已注册的 React 形状信息
 */
interface RegisteredShape {
    config: ReactShapeConfig;
    component: React.ComponentType<ReactNodeProps>;
}

/**
 * React 形状节点 - 扩展 Node 类以支持 React 组件渲染
 */
export class ReactShapeNode extends Node {
    private reactComponent: React.ComponentType<ReactNodeProps> | null = null;
    private reactRoot: ReactDOM.Root | null = null;
    private reactContainer: HTMLElement | null = null;
    private registeredConfig: ReactShapeConfig | null = null;
    private graphRef: Graph | null = null;

    constructor(options: NodeOptions & { reactConfig?: ReactShapeConfig }) {
        // 设置为 HTML 类型节点
        const shapeConfig: ShapeConfig = {
            type: Shape.HTML,
            html: '', // React 组件将渲染到此容器
        };

        super({
            ...options,
            shape: shapeConfig,
        });

        if (options.reactConfig) {
            this.registeredConfig = options.reactConfig;
            this.reactComponent = options.reactConfig.component;
        }
    }

    /**
     * 设置 React 组件
     */
    setReactComponent(component: React.ComponentType<ReactNodeProps>): void {
        this.reactComponent = component;
    }

    /**
     * 设置注册配置
     */
    setRegisteredConfig(config: ReactShapeConfig): void {
        this.registeredConfig = config;
    }

    /**
     * 获取注册配置
     */
    getRegisteredConfig(): ReactShapeConfig | null {
        return this.registeredConfig;
    }

    /**
     * 重写 createHtmlElement 方法以支持 React 组件渲染
     */
    override createHtmlElement(graph: any): HTMLElement {
        // 保存 graph 引用
        this.graphRef = graph as Graph;
        
        // 调用父类方法创建基础容器
        const element = super.createHtmlElement(graph);

        // 创建 React 挂载容器
        const reactContainer = document.createElement('div');
        reactContainer.style.cssText = `
            width: 100%;
            height: 100%;
            overflow: hidden;
        `;
        element.innerHTML = '';
        element.appendChild(reactContainer);

        this.reactContainer = reactContainer;

        // 渲染 React 组件
        this.renderReactComponent();

        return element;
    }
    
    /**
     * 获取 Graph 实例
     */
    getGraphInstance(): Graph | null {
        return this.graphRef;
    }

    /**
     * 渲染 React 组件
     */
    private renderReactComponent(): void {
        if (!this.reactContainer || !this.reactComponent) return;

        const props: ReactNodeProps = {
            nodeId: this.getId(),
            data: this.getData(),
            position: this.getPosition(),
            selected: this.isSelected,
            hovered: this.isHovered,
            graph: this.graphRef ?? undefined,
            node: this,
        };

        // 创建或更新 React Root
        if (!this.reactRoot) {
            this.reactRoot = ReactDOM.createRoot(this.reactContainer);
        }

        this.reactRoot.render(React.createElement(this.reactComponent, props));
    }

    /**
     * 更新 React 组件属性
     */
    updateReactProps(): void {
        this.renderReactComponent();
    }

    /**
     * 重写 setSelected 方法以同步 React 组件状态
     */
    override setSelected(selected: boolean): void {
        super.setSelected(selected);
        this.updateReactProps();
    }

    /**
     * 重写 setHovered 方法以同步 React 组件状态
     */
    override setHovered(hovered: boolean): void {
        super.setHovered(hovered);
        this.updateReactProps();
    }

    /**
     * 重写 setData 方法以同步 React 组件状态
     */
    override setData(data: Record<string, any>): void {
        super.setData(data);
        this.updateReactProps();
    }

    /**
     * 重写 setPosition 方法以同步 React 组件状态
     */
    override setPosition(x: number, y: number): void {
        super.setPosition(x, y);
        this.updateReactProps();
    }

    /**
     * 销毁 React 组件
     */
    override removeHtmlElement(): void {
        if (this.reactRoot) {
            this.reactRoot.unmount();
            this.reactRoot = null;
        }
        this.reactContainer = null;
        super.removeHtmlElement();
    }

    /**
     * 获取 React 容器元素
     */
    getReactContainer(): HTMLElement | null {
        return this.reactContainer;
    }
}

/**
 * ReactShape 插件 - 支持 React 组件作为节点
 * 
 * 使用示例：
 * ```typescript
 * // 1. 注册 React 形状
 * Graph.register({
 *     shape: 'react-node',
 *     width: 200,
 *     height: 100,
 *     component: MyReactComponent,
 * });
 * 
 * // 2. 添加 React 节点
 * graph.addNode({
 *     shape: 'react-node',
 *     x: 100,
 *     y: 100,
 *     data: { customProp: 'value' },
 * });
 * ```
 */
export class ReactShape implements Plugin {
    readonly name = 'react-shape';
    
    private graph: Graph | null = null;
    private shapeRegistry: Map<string, RegisteredShape> = new Map();
    private originalAddNode: ((nodeOrOptions: any) => any) | null = null;

    /**
     * 安装插件
     */
    install(graph: Graph): void {
        this.graph = graph;
        
        // 将插件实例注册到 Graph 上，以便 Graph.register 可以访问
        (graph as any).__reactShapePlugin = this;
        
        // 拦截 addNode 方法以支持 React 形状
        this.interceptAddNode(graph);
        
        // 同步全局注册的 React 形状
        this.syncGlobalShapes();
    }
    
    /**
     * 同步全局注册的 React 形状到插件
     */
    private syncGlobalShapes(): void {
        for (const [shapeName, config] of globalShapeRegistry) {
            if (!this.shapeRegistry.has(shapeName)) {
                this.shapeRegistry.set(shapeName, {
                    config,
                    component: config.component,
                });
            }
        }
    }
    
    /**
     * 拦截 addNode 方法，使其支持 React 形状
     */
    private interceptAddNode(graph: Graph): void {
        const self = this;
        const originalMethod = (graph as any).addNode.bind(graph);
        this.originalAddNode = originalMethod;
        (graph as any).addNode = function(nodeOrOptions: any) {
            // 如果是 Node 实例，直接调用原方法
            if (nodeOrOptions instanceof Node) {
                return originalMethod(nodeOrOptions);
            }
            
            // 检查是否是 React 形状
            const shapeName = nodeOrOptions.shape;
            if (typeof shapeName === 'string' && self.isReactShape(shapeName)) {
                // 使用 ReactShape 创建节点
                const reactNode = self.createNode(nodeOrOptions);
                if (reactNode) {
                    // 调用原方法添加节点，但传入的是 Node 实例
                    return originalMethod(reactNode);
                }
            }
            
            // 否则使用原方法
            return originalMethod(nodeOrOptions);
        };
    }
    
    /**
     * 检查是否是 React 形状（包括插件内和全局注册的）
     */
    isReactShape(shapeName: string): boolean {
        return this.shapeRegistry.has(shapeName) || globalShapeRegistry.has(shapeName);
    }

    /**
     * 卸载插件
     */
    uninstall(): void {
        // 恢复原始的 addNode 方法
        if (this.graph && this.originalAddNode) {
            (this.graph as any).addNode = this.originalAddNode;
        }
        this.shapeRegistry.clear();
        if (this.graph) {
            (this.graph as any).__reactShapePlugin = null;
        }
        this.graph = null;
    }

    /**
     * 注册 React 形状
     */
    register(config: ReactShapeConfig): void {
        if (this.shapeRegistry.has(config.shape)) {
            console.warn(`Shape "${config.shape}" is already registered. It will be overwritten.`);
        }

        this.shapeRegistry.set(config.shape, {
            config,
            component: config.component,
        });
    }

    /**
     * 注销 React 形状
     */
    unregister(shapeName: string): boolean {
        return this.shapeRegistry.delete(shapeName);
    }

    /**
     * 获取已注册的形状配置
     */
    getShape(shapeName: string): RegisteredShape | undefined {
        return this.shapeRegistry.get(shapeName);
    }

    /**
     * 检查形状是否已注册
     */
    hasShape(shapeName: string): boolean {
        return this.shapeRegistry.has(shapeName);
    }

    /**
     * 获取所有已注册的形状名称
     */
    getRegisteredShapes(): string[] {
        return Array.from(this.shapeRegistry.keys());
    }

    /**
     * 创建 React 节点
     */
    createNode(options: NodeOptions & { shape: string }): ReactShapeNode | null {
        const shapeName = options.shape;
        let registered = this.shapeRegistry.get(shapeName);
        
        // 如果插件内没有，检查全局注册表
        if (!registered) {
            const globalConfig = globalShapeRegistry.get(shapeName);
            if (globalConfig) {
                registered = {
                    config: globalConfig,
                    component: globalConfig.component,
                };
                // 同步到插件注册表
                this.shapeRegistry.set(shapeName, registered);
            }
        }
        
        if (!registered) {
            console.warn(`Shape "${shapeName}" is not registered.`);
            return null;
        }

        const { config, component } = registered;
        
        // 合并默认配置
        const nodeOptions: any = {
            ...options,
            x: options.x ?? 0,
            y: options.y ?? 0,
            style: {
                width: config.width ?? 200,
                height: config.height ?? 100,
                ...config.style,
                ...options.style,
            },
            resizable: options.resizable ?? config.resizable ?? false,
            reactConfig: config,
        };

        const node = new ReactShapeNode(nodeOptions);
        node.setReactComponent(component);
        node.setRegisteredConfig(config);

        // 添加连接桩
        if (config.ports && config.ports.length > 0) {
            config.ports.forEach(portConfig => {
                node.addPort({
                    id: portConfig.id,
                    position: portConfig.position,
                    label: portConfig.label,
                });
            });
        }

        return node;
    }
}

// ==================== 全局形状注册表 ====================

/**
 * 全局形状注册表（用于 Graph.register 静态方法）
 */
const globalShapeRegistry = new Map<string, ReactShapeConfig>();

/**
 * 全局注册 React 形状
 * 这个方法可以在使用 Graph 之前调用，注册的形状会被所有 Graph 实例共享
 */
export function registerReactShape(config: ReactShapeConfig): void {
    if (globalShapeRegistry.has(config.shape)) {
        console.warn(`Shape "${config.shape}" is already registered globally. It will be overwritten.`);
    }
    globalShapeRegistry.set(config.shape, config);
}

/**
 * 注销全局 React 形状
 */
export function unregisterReactShape(shapeName: string): boolean {
    return globalShapeRegistry.delete(shapeName);
}

/**
 * 获取全局注册的形状配置
 */
export function getGlobalReactShape(shapeName: string): ReactShapeConfig | undefined {
    return globalShapeRegistry.get(shapeName);
}

/**
 * 检查全局形状是否已注册
 */
export function hasGlobalReactShape(shapeName: string): boolean {
    return globalShapeRegistry.has(shapeName);
}

/**
 * 获取所有全局注册的形状名称
 */
export function getGlobalReactShapes(): string[] {
    return Array.from(globalShapeRegistry.keys());
}

// ==================== 辅助函数 ====================

/**
 * 检查给定的形状名称是否是 React 形状
 */
export function isReactShape(shapeName: string): boolean {
    return hasGlobalReactShape(shapeName);
}

/**
 * 为 Graph 添加 React 节点的辅助方法
 */
export function addReactNode(
    graph: Graph,
    options: {
        shape: string;
        x: number;
        y: number;
        id?: string;
        label?: string;
        data?: Record<string, any>;
        style?: Partial<NodeStyle>;
    }
): ReactShapeNode | null {
    // 获取插件实例
    const plugin = graph.getPlugin<ReactShape>('react-shape');
    
    if (!plugin) {
        console.error('ReactShape plugin is not installed. Please use graph.use(new ReactShape()) first.');
        return null;
    }

    // 检查是否是插件内注册的形状
    let node: ReactShapeNode | null = null;
    
    if (plugin.hasShape(options.shape)) {
        node = plugin.createNode(options as any);
    } else if (hasGlobalReactShape(options.shape)) {
        // 使用全局注册的形状
        const config = getGlobalReactShape(options.shape)!;
        plugin.register(config);
        node = plugin.createNode(options as any);
    } else {
        console.warn(`Shape "${options.shape}" is not registered.`);
        return null;
    }

    if (node) {
        graph.addNode(node);
    }

    return node;
}

export default ReactShape;
