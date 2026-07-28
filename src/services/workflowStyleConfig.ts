import { EdgeType } from '../workflow';

/**
 * 工作流样式配置（模块级单例）
 *
 * 左侧物料面板的「样式配置」区修改此配置；
 * 画布（WorkflowCanvas）订阅变化并应用到已有节点/连线/连接桩，
 * 新拖入的节点、新连接的边在创建时读取当前配置。
 */

export interface WorkflowStyleConfig {
  /** 节点边框颜色 */
  nodeBorderColor: string;
  /** 节点背景颜色 */
  nodeBackgroundColor: string;
  /** 连线类型 */
  edgeType: EdgeType;
  /** 连线颜色 */
  edgeColor: string;
  /** 连线宽度 */
  edgeWidth: number;
  /** 连接桩填充颜色 */
  portColor: string;
}

const DEFAULT_STYLE_CONFIG: WorkflowStyleConfig = {
  nodeBorderColor: '#569cd6',
  nodeBackgroundColor: '#2d2d30',
  edgeType: EdgeType.Straight,
  edgeColor: '#8c8c8c',
  edgeWidth: 2,
  portColor: '#ffffff',
};

let config: WorkflowStyleConfig = { ...DEFAULT_STYLE_CONFIG };
const listeners = new Set<(c: WorkflowStyleConfig) => void>();

export function getWorkflowStyleConfig(): WorkflowStyleConfig {
  return config;
}

export function updateWorkflowStyleConfig(patch: Partial<WorkflowStyleConfig>): void {
  config = { ...config, ...patch };
  listeners.forEach((l) => l(config));
}

export function subscribeWorkflowStyleConfig(
  listener: (c: WorkflowStyleConfig) => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
