import type { EdgeAnchor, EdgeType, Graph, NodeStyle } from '../workflow';
import { getEffectiveConfig } from './workflowStyleConfig';
import { addDefaultPorts } from './workflowStyleApply';

/** 工作流导出文件格式标识 */
const WORKFLOW_FILE_APP = 'ideacode-workflow';
const WORKFLOW_FILE_VERSION = 1;

/** 导出的节点数据（样式完整保留，连接桩按约定 ID 重建，见 addDefaultPorts） */
export interface WorkflowNodeData {
  id: string;
  label: string;
  x: number;
  y: number;
  /** 节点样式；内部生成图数据（如依赖可视化）时可省略，由画布配置兜底 */
  style?: NodeStyle;
  portsAlwaysVisible: boolean;
  data: Record<string, unknown>;
}

/** 导出的连线数据（锚点含 nodeId / portId，导入时按原 ID 重连） */
export interface WorkflowEdgeData {
  id: string;
  label: string;
  source: EdgeAnchor;
  target: EdgeAnchor;
  /** 连线类型；省略时由 edge:add 监听按当前有效配置应用 */
  type?: EdgeType;
}

export interface WorkflowFileData {
  app: typeof WORKFLOW_FILE_APP;
  version: number;
  nodes: WorkflowNodeData[];
  edges: WorkflowEdgeData[];
}

/** 构造导出数据结构（内部生成图数据时使用，如依赖可视化） */
export function createWorkflowFileData(
  nodes: WorkflowNodeData[],
  edges: WorkflowEdgeData[]
): WorkflowFileData {
  return { app: WORKFLOW_FILE_APP, version: WORKFLOW_FILE_VERSION, nodes, edges };
}

/** 把画布序列化为可导出的 JSON 对象 */
export function serializeGraph(graph: Graph): WorkflowFileData {
  const nodes: WorkflowNodeData[] = graph.getAllNodes().map((node) => {
    const pos = node.getPosition();
    return {
      id: node.getId(),
      label: node.getLabel(),
      x: pos.x,
      y: pos.y,
      style: node.getStyle(),
      portsAlwaysVisible: node.portsAlwaysVisible,
      data: node.getData(),
    };
  });

  const edges: WorkflowEdgeData[] = graph.getAllEdges().map((edge) => ({
    id: edge.getId(),
    label: edge.getLabel(),
    source: edge.getSourceAnchor(),
    target: edge.getTargetAnchor(),
    type: edge.getType(),
  }));

  return { app: WORKFLOW_FILE_APP, version: WORKFLOW_FILE_VERSION, nodes, edges };
}

/** 校验并规整导入的 JSON，非法格式返回 null */
export function parseWorkflowFile(json: string): WorkflowFileData | null {
  try {
    const raw = JSON.parse(json) as Partial<WorkflowFileData>;
    if (!raw || raw.app !== WORKFLOW_FILE_APP) return null;
    if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return null;
    return {
      app: WORKFLOW_FILE_APP,
      version: typeof raw.version === 'number' ? raw.version : WORKFLOW_FILE_VERSION,
      nodes: raw.nodes as WorkflowNodeData[],
      edges: raw.edges as WorkflowEdgeData[],
    };
  } catch {
    return null;
  }
}

/** 生成不与现有图元冲突的导入 ID */
function generateImportId(existing: Set<string>, prefix: string): string {
  let id: string;
  do {
    id = `${prefix}-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  } while (existing.has(id));
  return id;
}

/**
 * 把导出的数据合并进画布：保留画布现有内容，导入的节点 / 连线追加进来。
 * - 节点 ID 与画布现有节点冲突时生成新 ID，并同步重映射连线的 nodeId 和
 *   portId 前缀（连接桩按 addDefaultPorts 约定 ID `${nodeId}-port-${position}` 重建）；
 * - 发生冲突时导入内容整体偏移 40px，避免与原节点完全重叠（重复导入同一文件时可见）；
 * - 连线两端节点必须已存在（本次导入或画布原有），否则跳过，避免悬空连线；
 * - 新连线样式由 edge:add 监听按当前有效配置应用。
 */
export function loadGraphFromData(graph: Graph, data: WorkflowFileData, scope: string): void {
  const config = getEffectiveConfig(scope);
  const existingNodeIds = new Set(graph.getAllNodes().map((n) => n.getId()));
  const existingEdgeIds = new Set(graph.getAllEdges().map((e) => e.getId()));
  /** 原节点 ID → 实际使用的节点 ID（仅冲突时重映射） */
  const idMapping = new Map<string, string>();

  // 有任一节点 ID 冲突时，导入内容整体偏移，避免与原节点叠在一起
  const hasCollision = data.nodes.some((n) => n && existingNodeIds.has(n.id));
  const offset = hasCollision ? 40 : 0;

  for (const nodeData of data.nodes) {
    if (!nodeData || typeof nodeData.id !== 'string') continue;
    let nodeId = nodeData.id;
    if (existingNodeIds.has(nodeId)) {
      nodeId = generateImportId(existingNodeIds, 'node');
    }
    existingNodeIds.add(nodeId);
    idMapping.set(nodeData.id, nodeId);
    const node = graph.addNode({
      id: nodeId,
      label: nodeData.label,
      x: (nodeData.x ?? 0) + offset,
      y: (nodeData.y ?? 0) + offset,
      style: nodeData.style,
      portsAlwaysVisible: nodeData.portsAlwaysVisible ?? true,
      data: nodeData.data,
    });
    addDefaultPorts(node, config);
  }

  /** 端点重映射：nodeId 走 idMapping；portId 前缀随节点 ID 一起换 */
  const remapAnchor = (anchor: WorkflowEdgeData['source']): WorkflowEdgeData['source'] | null => {
    if (!anchor?.nodeId) return null;
    const mappedNodeId = idMapping.get(anchor.nodeId) ?? (existingNodeIds.has(anchor.nodeId) ? anchor.nodeId : null);
    if (!mappedNodeId) return null;
    let portId = anchor.portId;
    // 节点 ID 被重映射时，portId 的 `${oldNodeId}-port-*` 前缀同步替换
    if (portId && mappedNodeId !== anchor.nodeId && portId.startsWith(`${anchor.nodeId}-`)) {
      portId = `${mappedNodeId}${portId.slice(anchor.nodeId.length)}`;
    }
    return { ...anchor, nodeId: mappedNodeId, portId };
  };

  for (const edgeData of data.edges) {
    const source = remapAnchor(edgeData?.source);
    const target = remapAnchor(edgeData?.target);
    if (!source || !target) continue;
    let edgeId = edgeData.id;
    if (typeof edgeId !== 'string' || existingEdgeIds.has(edgeId)) {
      edgeId = generateImportId(existingEdgeIds, 'edge');
    }
    existingEdgeIds.add(edgeId);
    graph.addEdge({
      id: edgeId,
      label: edgeData.label,
      source,
      target,
      type: edgeData.type,
    });
  }
}
