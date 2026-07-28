import { useEffect, useRef } from 'react';
import {
  Graph,
  Node,
  Edge,
  History,
  Snapline,
  Selection,
  Clipboard,
  MiniMap,
  Dnd,
  Tools,
} from '../../workflow';
import { setWorkflowRuntime } from '../../services/workflowRuntime';
import {
  getWorkflowStyleConfig,
  subscribeWorkflowStyleConfig,
  type WorkflowStyleConfig,
} from '../../services/workflowStyleConfig';
import './WorkflowCanvas.css';

/** 默认连接桩方位：上下左右各一个 */
const DEFAULT_PORT_POSITIONS = ['top', 'right', 'bottom', 'left'] as const;

/** 为节点挂载默认的 4 向连接桩 */
function addDefaultPorts(node: Node): void {
  const { portColor } = getWorkflowStyleConfig();
  for (const position of DEFAULT_PORT_POSITIONS) {
    node.addPort({
      id: `${node.getId()}-port-${position}`,
      position,
      style: { fillColor: portColor },
    });
  }
}

/** 把样式配置应用到画布上已有的全部节点 / 连线 / 连接桩 */
function applyStyleConfig(graph: Graph, config: WorkflowStyleConfig): void {
  for (const node of graph.getAllNodes()) {
    node.updateStyle({
      borderColor: config.nodeBorderColor,
      backgroundColor: config.nodeBackgroundColor,
    });
    for (const port of node.getAllPorts()) {
      port.updateStyle({ fillColor: config.portColor });
    }
  }
  for (const edge of graph.getAllEdges()) {
    edge.setType(config.edgeType);
    edge.updateStyle({ stroke: config.edgeColor, strokeWidth: config.edgeWidth });
  }
}

/**
 * 持久化的画布实例与宿主 DOM（模块级单例）。
 *
 * tab 切换会导致本组件卸载重挂载，若每次挂载都新建 Graph，
 * 画布上的节点/连线将全部丢失。因此 Graph 只创建一次，
 * 组件挂载时仅把宿主 DOM 重新挂到容器上，卸载时不销毁，
 * 节点数据、撤销历史、小地图、工具栏全部跨 tab 切换保留。
 */
let persistentHost: HTMLDivElement | null = null;
let persistentGraph: Graph | null = null;
let persistentDnd: Dnd | null = null;

/** 创建持久化的 Graph 实例（仅首次挂载时执行一次） */
function createPersistentGraph(parent: HTMLElement): void {
  const host = document.createElement('div');
  host.className = 'workflow-canvas__host';
  parent.appendChild(host);
  persistentHost = host;

  const graph = new Graph({
    container: host,
    draggable: true,
    scalable: true,
    backgroundColor: '#1e1e1e',
    grid: {
      enabled: true,
      size: 20,
      color: 'rgba(255, 255, 255, 0.06)',
    },
    // 右键菜单：节点 / 连线的删除操作（暗色主题）
    dropdown: {
      nodeMenu: [
        {
          label: '删除节点',
          danger: true,
          action: (target) => {
            if (target instanceof Node) graph.removeNode(target.getId());
          },
        },
      ],
      edgeMenu: [
        {
          label: '删除连线',
          danger: true,
          action: (target) => {
            if (target instanceof Edge) graph.removeEdge(target.getId());
          },
        },
      ],
      menuWidth: 120,
      backgroundColor: '#252526',
      textColor: '#cccccc',
      hoverColor: '#37373d',
      dangerColor: '#f48771',
      dangerHoverColor: '#37373d',
      borderColor: '#454545',
      borderRadius: 6,
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.4)',
    },
  });

  // 撤销重做需先于 Tools 安装（Tools 安装时查找 History 插件）
  graph.use(new History({ enabled: true, keyboardShortcuts: true }));
  graph.use(new Snapline({ enabled: true }));
  graph.use(new Selection({ enabled: true }));
  graph.use(new Clipboard({ enabled: true }));
  graph.use(new MiniMap({ enabled: true, position: 'bottom-right' }));

  // 工具栏：缩放 / 拖拽切换 / 撤销重做（暗色主题）
  graph.use(
    new Tools({
      enabled: true,
      position: 'top-right',
      showSearch: false,
      backgroundColor: '#252526',
      borderColor: '#3c3c3c',
    })
  );

  // 拖拽插件：接收左侧物料面板拖入的节点
  const dnd = new Dnd({
    enabled: true,
    onDrop: (e) => {
      // 接管节点创建：统一挂载默认 4 向 Port，返回 false 阻止默认创建
      if (e.nodeOptions) {
        addDefaultPorts(e.target.addNode(e.nodeOptions));
      }
      return false;
    },
  });
  graph.use(dnd);

  // ── 样式配置接线（随 Graph 生命周期只注册一次）──
  // 1. 新连接的边：创建时应用当前的连线类型 / 颜色 / 宽度
  graph.on('edge:add', (data: { edge?: Edge }) => {
    if (!data.edge) return;
    const config = getWorkflowStyleConfig();
    data.edge.setType(config.edgeType);
    data.edge.updateStyle({ stroke: config.edgeColor, strokeWidth: config.edgeWidth });
  });
  // 2. 已有图元：应用一次当前配置，并订阅「样式配置」的后续修改
  applyStyleConfig(graph, getWorkflowStyleConfig());
  subscribeWorkflowStyleConfig((config) => {
    applyStyleConfig(graph, config);
  });

  persistentGraph = graph;
  persistentDnd = dnd;
}

/**
 * 工作流画布（主编辑区 tab 内容）
 *
 * Graph 实例为模块级单例（见上），本组件只负责把宿主 DOM
 * 挂到当前容器，并把实例注册到 workflowRuntime 供左侧面板使用。
 */
const WorkflowCanvas = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (!persistentGraph) {
      createPersistentGraph(container);
    } else if (persistentHost && persistentHost.parentElement !== container) {
      // 重挂载（tab 切换回来）：把已有画布宿主 DOM 挂到新容器
      container.appendChild(persistentHost);
    }

    setWorkflowRuntime({ graph: persistentGraph!, dnd: persistentDnd! });

    // 卸载时只摘除运行时引用，不销毁 Graph（数据跨 tab 切换保留）
    return () => {
      setWorkflowRuntime(null);
    };
  }, []);

  return <div ref={containerRef} className="workflow-canvas" />;
};

export default WorkflowCanvas;
