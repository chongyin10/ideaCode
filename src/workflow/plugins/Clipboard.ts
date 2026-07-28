import { Graph } from '../core/Graph';
import { Node, NodeOptions, NodeStyle } from '../core/Node';
import { Edge, EdgeOptions, EdgeType, EdgeStyle, EdgeAnchor } from '../core/Edge';
import { Plugin } from './Snapline';

/**
 * 剪贴板数据类型
 */
export interface ClipboardData {
    /** 节点数据 */
    nodes: NodeClipboardData[];
    /** 边数据 */
    edges: EdgeClipboardData[];
    /** 复制时间戳 */
    timestamp: number;
}

/**
 * 节点剪贴板数据
 */
export interface NodeClipboardData {
    /** 节点 ID（原始） */
    id: string;
    /** 节点标签 */
    label: string;
    /** X 坐标 */
    x: number;
    /** Y 坐标 */
    y: number;
    /** 节点样式 */
    style: Partial<NodeStyle>;
    /** 形状配置 */
    shape?: any;
    /** 是否可调整大小 */
    resizable?: boolean;
    /** 自定义数据 */
    data?: any;
}

/**
 * 边剪贴板数据
 */
export interface EdgeClipboardData {
    /** 边 ID（原始） */
    id: string;
    /** 源节点 ID（原始） */
    sourceId: string;
    /** 目标节点 ID（原始） */
    targetId: string;
    /** 边类型 */
    type: EdgeType;
    /** 边样式 */
    style: Partial<EdgeStyle>;
    /** 源连接桩 */
    source?: EdgeAnchor['portId'] | EdgeAnchor['position'];
    /** 目标连接桩 */
    target?: EdgeAnchor['portId'] | EdgeAnchor['position'];
    /** 标签 */
    label?: string;
}

/**
 * Clipboard 配置选项
 */
export interface ClipboardOptions {
    /** 是否启用剪贴板 */
    enabled?: boolean;
    /** 是否使用系统剪贴板 */
    useSystemClipboard?: boolean;
    /** 粘贴时的偏移量 */
    pasteOffset?: number;
    /** 是否在粘贴时保持原 ID */
    keepOriginalId?: boolean;
    /** 自定义 ID 生成函数 */
    generateId?: () => string;
    /** 复制前回调 */
    onBeforeCopy?: (data: ClipboardData) => boolean | void;
    /** 复制后回调 */
    onCopy?: (data: ClipboardData) => void;
    /** 粘贴前回调 */
    onBeforePaste?: (data: ClipboardData) => boolean | ClipboardData | void;
    /** 粘贴后回调 */
    onPaste?: (nodes: Node[], edges: Edge[]) => void;
    /** 剪切后回调 */
    onCut?: (data: ClipboardData) => void;
    /** 删除后回调 */
    onDelete?: (nodeIds: string[], edgeIds: string[]) => void;
}

/**
 * Clipboard - 剪贴板插件
 *
 * 提供节点和边的复制、粘贴、剪切、删除功能：
 * - 支持键盘快捷键（Ctrl+C/V/X/Del）
 * - 支持系统剪贴板（可选）
 * - 支持自定义粘贴偏移量
 * - 支持事件回调
 *
 * 使用示例：
 * ```typescript
 * const clipboard = new Clipboard({
 *     enabled: true,
 *     pasteOffset: 20,
 *     onCopy: (data) => console.log('已复制', data.nodes.length, '个节点'),
 * });
 * graph.use(clipboard);
 * ```
 */
export class Clipboard implements Plugin {
    readonly name = 'Clipboard';
    
    private graph: Graph | null = null;
    private options: Required<ClipboardOptions>;
    private clipboardData: ClipboardData | null = null;
    private cleanupFns: (() => void)[] = [];
    
    // 默认配置
    private static readonly DEFAULT_OPTIONS: Required<ClipboardOptions> = {
        enabled: true,
        useSystemClipboard: false,
        pasteOffset: 20,
        keepOriginalId: false,
        generateId: () => `clipboard-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        onBeforeCopy: () => {},
        onCopy: () => {},
        onBeforePaste: () => {},
        onPaste: () => {},
        onCut: () => {},
        onDelete: () => {},
    };
    
    constructor(options: ClipboardOptions = {}) {
        this.options = { ...Clipboard.DEFAULT_OPTIONS, ...options } as Required<ClipboardOptions>;
    }
    
    /**
     * 安装插件
     */
    install(graph: Graph): void {
        this.graph = graph;
        this.bindEvents();
    }
    
    /**
     * 卸载插件
     */
    uninstall(): void {
        this.unbindEvents();
        this.clear();
        this.graph = null;
    }
    
    /**
     * 更新配置
     */
    setOptions(options: Partial<ClipboardOptions>): void {
        this.options = { ...this.options, ...options } as Required<ClipboardOptions>;
    }
    
    /**
     * 获取当前配置
     */
    getOptions(): Required<ClipboardOptions> {
        return { ...this.options };
    }
    
    /**
     * 启用剪贴板
     */
    enable(): void {
        this.options.enabled = true;
    }
    
    /**
     * 禁用剪贴板
     */
    disable(): void {
        this.options.enabled = false;
    }
    
    /**
     * 是否已启用
     */
    isEnabled(): boolean {
        return this.options.enabled;
    }
    
    /**
     * 绑定事件
     */
    private bindEvents(): void {
        if (typeof document === 'undefined') return;
        
        const handleKeyDown = this.handleKeyDown.bind(this);
        document.addEventListener('keydown', handleKeyDown);
        this.cleanupFns.push(() => document.removeEventListener('keydown', handleKeyDown));
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
        if (!this.options.enabled || !this.graph) return;
        
        // 忽略输入框中的快捷键
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
            return;
        }
        
        const isCtrlOrCmd = e.ctrlKey || e.metaKey;
        
        // Ctrl+C: 复制
        if (isCtrlOrCmd && e.key === 'c') {
            e.preventDefault();
            this.copy();
        }
        
        // Ctrl+V: 粘贴
        if (isCtrlOrCmd && e.key === 'v') {
            e.preventDefault();
            this.paste();
        }
        
        // Ctrl+X: 剪切
        if (isCtrlOrCmd && e.key === 'x') {
            e.preventDefault();
            this.cut();
        }
        
        // Delete/Backspace: 删除
        if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            this.delete();
        }
        
        // Ctrl+A: 全选
        if (isCtrlOrCmd && e.key === 'a') {
            e.preventDefault();
            this.selectAll();
        }
    }
    
    /**
     * 复制选中的节点和边
     */
    copy(): ClipboardData | null {
        if (!this.options.enabled || !this.graph) return null;
        
        const selectedNode = this.graph.getSelectedNode();
        const selectedEdge = this.graph.getSelectedEdge();
        
        if (!selectedNode && !selectedEdge) return null;
        
        const nodes: NodeClipboardData[] = [];
        const edges: EdgeClipboardData[] = [];
        const nodeIds = new Set<string>();
        
        // 复制选中的节点
        if (selectedNode) {
            const nodeData = this.nodeToClipboardData(selectedNode);
            nodes.push(nodeData);
            nodeIds.add(selectedNode.getId());
        }
        
        // 复制与选中节点相关的边
        const allEdges = this.graph.getAllEdges();
        allEdges.forEach(edge => {
            const sourceId = edge.getSourceId();
            const targetId = edge.getTargetId();
            
            // 只复制两端节点都被选中的边
            if (nodeIds.has(sourceId) && nodeIds.has(targetId)) {
                edges.push(this.edgeToClipboardData(edge));
            }
        });
        
        // 如果只选中了边，也复制边
        if (selectedEdge && nodes.length === 0) {
            edges.push(this.edgeToClipboardData(selectedEdge));
        }
        
        const data: ClipboardData = {
            nodes,
            edges,
            timestamp: Date.now(),
        };
        
        // 调用复制前回调
        const beforeResult = this.options.onBeforeCopy(data);
        if (beforeResult === false) return null;
        
        this.clipboardData = data;
        
        // 使用系统剪贴板
        if (this.options.useSystemClipboard && typeof navigator !== 'undefined' && navigator.clipboard) {
            try {
                navigator.clipboard.writeText(JSON.stringify(data));
            } catch (err) {
                console.warn('无法写入系统剪贴板:', err);
            }
        }
        
        // 调用复制后回调
        this.options.onCopy(data);
        
        console.log('📋 已复制:', nodes.length, '个节点,', edges.length, '条边');
        
        return data;
    }
    
    /**
     * 粘贴剪贴板内容
     */
    paste(): { nodes: Node[]; edges: Edge[] } | null {
        if (!this.options.enabled || !this.graph) return null;
        
        if (!this.clipboardData || this.clipboardData.nodes.length === 0) {
            console.log('📋 剪贴板为空');
            return null;
        }
        
        // 调用粘贴前回调
        const beforeResult = this.options.onBeforePaste(this.clipboardData);
        if (beforeResult === false) return null;
        
        // 使用回调返回的修改后数据（如果有）
        const dataToPaste: ClipboardData = 
            beforeResult && typeof beforeResult === 'object' ? beforeResult : this.clipboardData;
        
        const idMapping = new Map<string, string>(); // 原ID -> 新ID
        const newNodes: Node[] = [];
        const newEdges: Edge[] = [];
        
        // 粘贴节点
        dataToPaste.nodes.forEach(nodeData => {
            const newId = this.options.keepOriginalId 
                ? nodeData.id 
                : this.options.generateId();
            
            idMapping.set(nodeData.id, newId);
            
            const nodeOptions: NodeOptions = {
                id: newId,
                label: nodeData.label,
                x: nodeData.x + this.options.pasteOffset,
                y: nodeData.y + this.options.pasteOffset,
                style: nodeData.style,
                shape: nodeData.shape,
                resizable: nodeData.resizable,
                data: nodeData.data,
            };
            
            const newNode = this.graph!.addNode(nodeOptions);
            newNodes.push(newNode);
        });
        
        // 粘贴边（只粘贴两端节点都存在的边）
        dataToPaste.edges.forEach(edgeData => {
            const newSourceId = idMapping.get(edgeData.sourceId);
            const newTargetId = idMapping.get(edgeData.targetId);
            
            // 如果源节点或目标节点不在粘贴的节点中，跳过
            if (!newSourceId || !newTargetId) return;
            
            const newEdgeId = this.options.keepOriginalId 
                ? edgeData.id 
                : this.options.generateId();
            
            const edgeOptions: EdgeOptions = {
                id: newEdgeId,
                source: newSourceId,
                target: newTargetId,
                type: edgeData.type,
                style: edgeData.style,
                label: edgeData.label,
            };
            
            // 处理连接桩
            if (edgeData.source) {
                edgeOptions.source = { nodeId: newSourceId };
                if (typeof edgeData.source === 'string') {
                    edgeOptions.source.portId = edgeData.source;
                } else {
                    edgeOptions.source.position = edgeData.source;
                }
            }
            
            if (edgeData.target) {
                edgeOptions.target = { nodeId: newTargetId };
                if (typeof edgeData.target === 'string') {
                    edgeOptions.target.portId = edgeData.target;
                } else {
                    edgeOptions.target.position = edgeData.target;
                }
            }
            
            const newEdge = this.graph!.addEdge(edgeOptions);
            newEdges.push(newEdge);
        });
        
        // 更新剪贴板数据中的节点位置，以便连续粘贴时位置递增
        dataToPaste.nodes.forEach(nodeData => {
            nodeData.x += this.options.pasteOffset;
            nodeData.y += this.options.pasteOffset;
        });
        
        // 选中新粘贴的节点
        if (newNodes.length > 0) {
            this.graph.selectNode(newNodes[0].getId());
        }
        
        // 调用粘贴后回调
        this.options.onPaste(newNodes, newEdges);
        
        console.log('📋 已粘贴:', newNodes.length, '个节点,', newEdges.length, '条边');
        
        return { nodes: newNodes, edges: newEdges };
    }
    
    /**
     * 剪切选中的节点和边
     */
    cut(): ClipboardData | null {
        if (!this.options.enabled || !this.graph) return null;
        
        const data = this.copy();
        if (!data) return null;
        
        // 删除选中的节点和边
        const selectedNode = this.graph.getSelectedNode();
        const selectedEdge = this.graph.getSelectedEdge();
        
        if (selectedEdge) {
            this.graph.removeEdge(selectedEdge.getId());
        }
        
        if (selectedNode) {
            this.graph.removeNode(selectedNode.getId());
        }
        
        // 调用剪切后回调
        this.options.onCut(data);
        
        console.log('✂️ 已剪切:', data.nodes.length, '个节点,', data.edges.length, '条边');
        
        return data;
    }
    
    /**
     * 删除选中的节点和边
     */
    delete(): { nodeIds: string[]; edgeIds: string[] } | null {
        if (!this.options.enabled || !this.graph) return null;
        
        const selectedNode = this.graph.getSelectedNode();
        const selectedEdge = this.graph.getSelectedEdge();
        
        const nodeIds: string[] = [];
        const edgeIds: string[] = [];
        
        if (selectedEdge) {
            edgeIds.push(selectedEdge.getId());
            this.graph.removeEdge(selectedEdge.getId());
        }
        
        if (selectedNode) {
            nodeIds.push(selectedNode.getId());
            this.graph.removeNode(selectedNode.getId());
        }
        
        if (nodeIds.length === 0 && edgeIds.length === 0) {
            return null;
        }
        
        // 调用删除后回调
        this.options.onDelete(nodeIds, edgeIds);
        
        console.log('🗑️ 已删除:', nodeIds.length, '个节点,', edgeIds.length, '条边');
        
        return { nodeIds, edgeIds };
    }
    
    /**
     * 全选
     */
    selectAll(): void {
        if (!this.graph) return;
        
        const nodes = this.graph.getAllNodes();
        if (nodes.length > 0) {
            // 选中第一个节点（当前设计只支持单选）
            this.graph.selectNode(nodes[0].getId());
        }
    }
    
    /**
     * 清空剪贴板
     */
    clear(): void {
        this.clipboardData = null;
    }
    
    /**
     * 获取剪贴板数据
     */
    getClipboardData(): ClipboardData | null {
        return this.clipboardData;
    }
    
    /**
     * 设置剪贴板数据（用于外部设置）
     */
    setClipboardData(data: ClipboardData): void {
        this.clipboardData = data;
    }
    
    /**
     * 检查剪贴板是否有内容
     */
    hasContent(): boolean {
        return this.clipboardData !== null && this.clipboardData.nodes.length > 0;
    }
    
    /**
     * 将节点转换为剪贴板数据
     */
    private nodeToClipboardData(node: Node): NodeClipboardData {
        const pos = node.getPosition();
        const style = node.getStyle();
        
        return {
            id: node.getId(),
            label: node.getLabel(),
            x: pos.x,
            y: pos.y,
            style: {
                width: style.width,
                height: style.height,
                backgroundColor: style.backgroundColor,
                borderColor: style.borderColor,
                borderWidth: style.borderWidth,
                borderRadius: style.borderRadius,
                textColor: style.textColor,
                fontSize: style.fontSize,
                fontFamily: style.fontFamily,
                shadowColor: style.shadowColor,
                shadowBlur: style.shadowBlur,
                shadowOffsetX: style.shadowOffsetX,
                shadowOffsetY: style.shadowOffsetY,
                selectedBorderColor: style.selectedBorderColor,
                selectedBorderWidth: style.selectedBorderWidth,
                hoverBackgroundColor: style.hoverBackgroundColor,
                shape: style.shape,
            },
            shape: node.getShapeConfig(),
            resizable: node.resizable || false,
            data: node.getData(),
        };
    }
    
    /**
     * 将边转换为剪贴板数据
     */
    private edgeToClipboardData(edge: Edge): EdgeClipboardData {
        const style = edge.getStyle();
        
        return {
            id: edge.getId(),
            sourceId: edge.getSourceId(),
            targetId: edge.getTargetId(),
            type: edge.getType(),
            style: {
                stroke: style.stroke,
                strokeWidth: style.strokeWidth,
                dashed: style.dashed,
                dashPattern: style.dashPattern,
                arrowSize: style.arrowSize,
                arrowColor: style.arrowColor,
                selectedStroke: style.selectedStroke,
                selectedStrokeWidth: style.selectedStrokeWidth,
                hoverStroke: style.hoverStroke,
                cornerRadius: style.cornerRadius,
                animated: style.animated,
                waveColor: style.waveColor,
                waveWidth: style.waveWidth,
                waveLength: style.waveLength,
                waveSpeed: style.waveSpeed,
                waveOpacity: style.waveOpacity,
            },
            label: edge.getLabel(),
        };
    }
    
    /**
     * 从 JSON 加载剪贴板数据
     */
    loadFromJSON(json: string): boolean {
        try {
            const data = JSON.parse(json) as ClipboardData;
            if (data.nodes && Array.isArray(data.nodes)) {
                this.clipboardData = data;
                return true;
            }
            return false;
        } catch (err) {
            console.error('加载剪贴板数据失败:', err);
            return false;
        }
    }
    
    /**
     * 导出剪贴板数据为 JSON
     */
    toJSON(): string | null {
        if (!this.clipboardData) return null;
        return JSON.stringify(this.clipboardData, null, 2);
    }
}
