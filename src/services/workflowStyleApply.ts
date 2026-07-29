import { Edge, Graph, Node } from '../workflow';
import type { WorkflowStyleConfig } from './workflowStyleConfig';

/**
 * 工作流样式应用器：工作流画布（WorkflowCanvas）与样式配置页的
 * 预览画布（WorkflowStyleConfig）共用的一套「配置 → 图元」应用逻辑。
 */

/** 默认连接桩方位：上下左右各一个 */
export const DEFAULT_PORT_POSITIONS = ['top', 'right', 'bottom', 'left'] as const;

/** 为节点挂载默认的 4 向连接桩（样式取自调用方提供的有效配置） */
export function addDefaultPorts(node: Node, config: WorkflowStyleConfig): void {
  for (const position of DEFAULT_PORT_POSITIONS) {
    node.addPort({
      id: `${node.getId()}-port-${position}`,
      position,
      style: {
        fillColor: config.portColor,
        width: config.portSize,
        height: config.portSize,
        strokeColor: config.portStrokeColor,
      },
    });
  }
}

/** 把样式配置应用到单条边上（新边创建 / 批量刷新共用） */
export function applyEdgeConfig(edge: Edge, config: WorkflowStyleConfig): void {
  edge.setType(config.edgeType);
  edge.updateStyle({
    stroke: config.edgeColor,
    strokeWidth: config.edgeWidth,
    dashed: config.edgeDashed,
    arrowSize: config.edgeArrowSize,
    arrowColor: config.edgeArrowColor,
    selectedStroke: config.edgeSelectedStroke,
    cornerRadius: config.edgeCornerRadius,
  });
  if (config.edgeAnimated) {
    edge.startAnimation();
  } else {
    edge.stopAnimation();
  }
}

/** 把样式配置应用到画布上已有的全部节点 / 连线 / 连接桩 */
export function applyStyleConfig(graph: Graph, config: WorkflowStyleConfig): void {
  for (const node of graph.getAllNodes()) {
    node.updateStyle({
      borderColor: config.nodeBorderColor,
      backgroundColor: config.nodeBackgroundColor,
      borderWidth: config.nodeBorderWidth,
      borderRadius: config.nodeBorderRadius,
      borderStyle: config.nodeBorderStyle,
      textColor: config.nodeTextColor,
      fontSize: config.nodeFontSize,
      selectedBorderColor: config.nodeSelectedBorderColor,
    });
    node.setPortsAlwaysVisible(config.portsAlwaysVisible);
    for (const port of node.getAllPorts()) {
      port.updateStyle({
        fillColor: config.portColor,
        width: config.portSize,
        height: config.portSize,
        strokeColor: config.portStrokeColor,
      });
    }
  }
  for (const edge of graph.getAllEdges()) {
    applyEdgeConfig(edge, config);
  }
  // 流动动画总循环
  if (config.edgeAnimated) {
    graph.startEdgeAnimation();
  } else {
    graph.stopEdgeAnimation();
  }
}

/** 画布基础外观：背景色 + 网格（Graph 未消费 backgroundColor 选项，作用在宿主元素上） */
export function applyCanvasBasics(graph: Graph, host: HTMLElement, config: WorkflowStyleConfig): void {
  host.style.backgroundColor = config.canvasBackgroundColor;
  graph.setGridEnabled(config.gridEnabled);
  graph.setGridSize(config.gridSize);
  graph.setGridColor(config.gridColor);
  graph.setGridType(config.gridType);
}
