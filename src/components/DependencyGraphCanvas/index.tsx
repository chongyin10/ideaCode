import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Graph,
  EdgeType,
  Selection,
  Dnd,
  Tools,
  type Node,
  type Edge,
} from '../../workflow';
import {
  getWorkflowInstance,
  setWorkflowInstance,
  consumePendingWorkflowGraphData,
  setDepGraphSourceData,
  getDepGraphSourceData,
  setDepGraphViewMode,
  getDepGraphViewMode,
  type DepGraphViewMode,
  type WorkflowInstance,
} from '../../services/workflowRuntime';
import { loadGraphFromData } from '../../services/workflowPersistence';
import { aggregateByDirectory } from '../../services/dependencyGraph';
import './DependencyGraphCanvas.css';

/** 依赖连线的默认样式（直线；低透明度细线，避免密集区域糊成一团。
 *  selectedStroke 与 stroke 保持一致：外观只由下方选中高亮逻辑控制，
 *  不被引擎内置的选中色（橙）干扰） */
const DEP_EDGE_STYLE = {
  stroke: 'rgba(86, 156, 214, 0.45)',
  strokeWidth: 1,
  arrowSize: 6,
  arrowColor: 'rgba(86, 156, 214, 0.45)',
  selectedStroke: 'rgba(86, 156, 214, 0.45)',
  selectedStrokeWidth: 1,
};

/** 选中节点/连线时：关联连线高亮 */
const DEP_EDGE_ACTIVE_STYLE = {
  stroke: '#4fc1ff',
  strokeWidth: 2,
  arrowSize: 8,
  arrowColor: '#4fc1ff',
  selectedStroke: '#4fc1ff',
  selectedStrokeWidth: 2,
};

/** 选中节点/连线时：无关连线压暗 */
const DEP_EDGE_DIM_STYLE = {
  stroke: 'rgba(86, 156, 214, 0.08)',
  strokeWidth: 1,
  arrowSize: 0,
  arrowColor: 'rgba(86, 156, 214, 0.08)',
  selectedStroke: 'rgba(86, 156, 214, 0.08)',
  selectedStrokeWidth: 1,
};

/**
 * 创建依赖可视化 scope 的 Graph 实例（把 workflow 引擎当 SDK 用，
 * 只装配只读浏览所需的插件，不接物料面板 / 样式配置服务）。
 * 实例缓存在 workflowRuntime 注册表中，tab 切换只 reparent 宿主 DOM，不销毁。
 */
function createDepGraphInstance(_scope: string, parent: HTMLElement): WorkflowInstance {
  const host = document.createElement('div');
  host.className = 'dependency-graph-canvas__host';
  parent.appendChild(host);

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
  });

  // 只读浏览：框选 / 工具栏（无撤销重做、无搜索；小地图意义不大且每帧有额外开销，不装）
  graph.use(new Selection({ enabled: true }));
  graph.use(
    new Tools({
      enabled: true,
      position: 'top-right',
      showSearch: false,
      showHistory: false,
      backgroundColor: '#252526',
      borderColor: '#3c3c3c',
    })
  );

  // 依赖可视化不接收物料拖入；仅为满足 WorkflowInstance 结构创建，不挂到 Graph
  const dnd = new Dnd({ enabled: false });

  // 选中节点时只高亮其「出边」（它引用的子节点方向），父节点方向的入边压暗；
  // 同时压暗无关节点（子节点保持不透明）
  graph.on('node:selected', (data: { node?: Node }) => {
    const selectedId = data.node?.getId();
    if (!selectedId) return;
    const neighborIds = new Set<string>([selectedId]);
    for (const edge of graph.getAllEdges()) {
      const srcId = edge.getSourceAnchor().nodeId;
      const tgtId = edge.getTargetAnchor().nodeId;
      const isOutgoing = srcId === selectedId;
      edge.updateStyle(isOutgoing ? DEP_EDGE_ACTIVE_STYLE : DEP_EDGE_DIM_STYLE);
      if (isOutgoing) {
        neighborIds.add(tgtId);
      }
    }
    for (const node of graph.getAllNodes()) {
      node.updateStyle({ opacity: neighborIds.has(node.getId()) ? 1 : 0.6 });
    }
  });

  // 点击连线时同款处理：高亮该连线、压暗其余连线，仅两端节点保持不透明
  graph.on('edge:click', (data: { edge?: Edge }) => {
    const clickedId = data.edge?.getId();
    if (!clickedId || !data.edge) return;
    const endpointIds = new Set<string>([
      data.edge.getSourceAnchor().nodeId,
      data.edge.getTargetAnchor().nodeId,
    ]);
    for (const edge of graph.getAllEdges()) {
      edge.updateStyle(edge.getId() === clickedId ? DEP_EDGE_ACTIVE_STYLE : DEP_EDGE_DIM_STYLE);
    }
    for (const node of graph.getAllNodes()) {
      node.updateStyle({ opacity: endpointIds.has(node.getId()) ? 1 : 0.6 });
    }
  });

  // 取消高亮只认「真正的空白点击」：记录按下位置，点击时位移超过阈值
  // 视为拖拽平移画布（引擎在拖拽松手时也会派发 click），此时保留高亮
  let blankDown: { clientX: number; clientY: number } | null = null;
  graph.on('blank:mousedown', (data: { clientX?: number; clientY?: number }) => {
    blankDown = { clientX: data.clientX ?? 0, clientY: data.clientY ?? 0 };
  });
  graph.on('blank:click', (data: { clientX?: number; clientY?: number }) => {
    const dx = (data.clientX ?? 0) - (blankDown?.clientX ?? 0);
    const dy = (data.clientY ?? 0) - (blankDown?.clientY ?? 0);
    blankDown = null;
    if (dx * dx + dy * dy > 25) return; // 位移超过 5px 视为拖拽，不取消高亮
    for (const edge of graph.getAllEdges()) {
      edge.updateStyle(DEP_EDGE_STYLE);
    }
    for (const node of graph.getAllNodes()) {
      node.updateStyle({ opacity: 1 });
    }
  });

  return { graph, dnd, host, dispose: () => {} };
}

/** 按当前节点内容自适应缩放居中（布局从左上角开始，首次打开直接看到全图） */
function fitContent(graph: Graph): void {
  const nodes = graph.getAllNodes();
  if (nodes.length === 0) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    const b = node.getBounds();
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  graph.fitToContent({ x: minX, y: minY, width: maxX - minX, height: maxY - minY }, 60);
}

/**
 * 代码依赖可视化画布（主编辑区 tab 内容）
 *
 * 与 WorkflowCanvas 完全独立：不渲染物料面板 / 工具栏，不注册工作流运行时，
 * 只把 ExplorerContent 预置的依赖图数据灌入画布并统一连线样式。
 */
const DependencyGraphCanvas = ({ tabId }: { tabId: string }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  // 视图模式：默认按子目录聚合成组节点（tab 重挂载时恢复上次模式）
  const [mode, setMode] = useState<DepGraphViewMode>(
    () => getDepGraphViewMode(tabId) ?? 'aggregate'
  );

  /** 按模式从文件级源数据重建画布（聚合 / 全量两种视图共用一份源数据） */
  const renderMode = useCallback(
    (graph: Graph, nextMode: DepGraphViewMode) => {
      const source = getDepGraphSourceData(tabId);
      if (!source) return;
      const data = nextMode === 'aggregate' ? aggregateByDirectory(source) : source;
      graph.clearEdges();
      graph.clearNodes();
      loadGraphFromData(graph, data, tabId);
      // 依赖连线统一为直线 + 固定配色（直线无采样/跳线计算开销，大数据量下保证流畅）
      for (const edge of graph.getAllEdges()) {
        edge.setType(EdgeType.Straight);
        edge.updateStyle(DEP_EDGE_STYLE);
      }
      fitContent(graph);
    },
    [tabId]
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let instance = getWorkflowInstance(tabId);
    if (!instance) {
      instance = createDepGraphInstance(tabId, container);
      setWorkflowInstance(tabId, instance);
    } else if (instance.host.parentElement !== container) {
      // 重挂载（tab 切换回来）：把已有画布宿主 DOM 挂到新容器
      container.appendChild(instance.host);
    }
    const current = instance;

    // 挂载后把预置的依赖图数据灌入画布（一次性消费，重复挂载不会重复灌入）
    const pending = consumePendingWorkflowGraphData(tabId);
    if (pending) {
      // 留存文件级源数据：模式切换时直接重建，无需重新读文件
      setDepGraphSourceData(tabId, pending);
      renderMode(current.graph, getDepGraphViewMode(tabId) ?? 'aggregate');
    }
  }, [tabId, renderMode]);

  const handleModeChange = (nextMode: DepGraphViewMode) => {
    if (nextMode === mode) return;
    setMode(nextMode);
    setDepGraphViewMode(tabId, nextMode);
    const instance = getWorkflowInstance(tabId);
    if (instance) renderMode(instance.graph, nextMode);
  };

  return (
    <div ref={containerRef} className="dependency-graph-canvas">
      <div className="dependency-graph-canvas__mode-switch">
        <button
          type="button"
          className={mode === 'aggregate' ? 'is-active' : ''}
          onClick={() => handleModeChange('aggregate')}
        >
          {t('dependencyGraph.modeAggregate')}
        </button>
        <button
          type="button"
          className={mode === 'files' ? 'is-active' : ''}
          onClick={() => handleModeChange('files')}
        >
          {t('dependencyGraph.modeFiles')}
        </button>
      </div>
    </div>
  );
};

export default DependencyGraphCanvas;
