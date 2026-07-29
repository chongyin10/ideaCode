import { EdgeType } from '../workflow';

/**
 * 工作流样式配置（模块级单例，两层模型）
 *
 * - 全局配置（globalConfig）：所有工作流共享的默认样式；
 * - 局部覆盖（localOverrides）：按作用域（scope，一个工作流画布一个 scope）
 *   存放的差异化配置，优先级高于全局。
 *
 * 「样式配置」tab 的「应用到所有工作流」开关决定修改写入哪一层；
 * 画布订阅的是本 scope 的「有效配置」（全局 + 局部合并后的结果），
 * 新拖入的节点、新连接的边在创建时同样读取有效配置。
 */

export interface WorkflowStyleConfig {
  // ── 节点 ──
  /** 节点边框颜色 */
  nodeBorderColor: string;
  /** 节点背景颜色 */
  nodeBackgroundColor: string;
  /** 节点边框宽度 */
  nodeBorderWidth: number;
  /** 节点圆角 */
  nodeBorderRadius: number;
  /** 节点边框样式：实线 / 虚线 / 蚂蚁线 */
  nodeBorderStyle: 'solid' | 'dashed' | 'animated';
  /** 节点文字颜色 */
  nodeTextColor: string;
  /** 节点字号 */
  nodeFontSize: number;
  /** 节点选中态边框颜色 */
  nodeSelectedBorderColor: string;

  // ── 连线 ──
  /** 连线类型 */
  edgeType: EdgeType;
  /** 连线颜色 */
  edgeColor: string;
  /** 连线宽度 */
  edgeWidth: number;
  /** 连线是否虚线 */
  edgeDashed: boolean;
  /** 箭头大小（0 = 无箭头） */
  edgeArrowSize: number;
  /** 箭头颜色 */
  edgeArrowColor: string;
  /** 连线选中态颜色 */
  edgeSelectedStroke: string;
  /** 折线圆角（仅折线类生效） */
  edgeCornerRadius: number;
  /** 连线流动动画 */
  edgeAnimated: boolean;

  // ── 连接桩 ──
  /** 连接桩填充颜色 */
  portColor: string;
  /** 连接桩大小（直径） */
  portSize: number;
  /** 连接桩边框颜色 */
  portStrokeColor: string;

  // ── 画布 ──
  /** 画布背景颜色 */
  canvasBackgroundColor: string;
  /** 网格开关 */
  gridEnabled: boolean;
  /** 网格间距 */
  gridSize: number;
  /** 网格颜色 */
  gridColor: string;
  /** 网格类型：线状 / 点状 */
  gridType: 'mesh' | 'dot';

  // ── 功能开关 ──
  /** 对齐线 */
  snaplineEnabled: boolean;
  /** 框选 */
  selectionEnabled: boolean;
  /** 复制粘贴 */
  clipboardEnabled: boolean;
  /** 撤销重做 */
  historyEnabled: boolean;
  /** 工具栏 */
  toolsEnabled: boolean;
  /** 连接桩常显（false = 悬停节点时显示） */
  portsAlwaysVisible: boolean;
  /** 小地图 */
  minimapEnabled: boolean;
}

const DEFAULT_STYLE_CONFIG: WorkflowStyleConfig = {
  nodeBorderColor: '#569cd6',
  nodeBackgroundColor: '#2d2d30',
  nodeBorderWidth: 1,
  nodeBorderRadius: 6,
  nodeBorderStyle: 'solid',
  nodeTextColor: '#e8e8e8',
  nodeFontSize: 14,
  nodeSelectedBorderColor: '#569cd6',

  edgeType: EdgeType.Straight,
  edgeColor: '#8c8c8c',
  edgeWidth: 2,
  edgeDashed: false,
  edgeArrowSize: 10,
  edgeArrowColor: '#8c8c8c',
  edgeSelectedStroke: '#f59e0b',
  edgeCornerRadius: 10,
  edgeAnimated: false,

  portColor: '#ffffff',
  portSize: 8,
  portStrokeColor: '#64748b',

  canvasBackgroundColor: '#1e1e1e',
  gridEnabled: true,
  gridSize: 20,
  gridColor: '#333333',
  gridType: 'mesh',

  snaplineEnabled: true,
  selectionEnabled: true,
  clipboardEnabled: true,
  historyEnabled: true,
  toolsEnabled: true,
  portsAlwaysVisible: true,
  minimapEnabled: false,
};

/** 配置作用域 id：一个工作流画布一个 scope（当前取画布 tab id） */
export type WorkflowConfigScope = string;

/** 全局配置：所有工作流共享 */
let globalConfig: WorkflowStyleConfig = { ...DEFAULT_STYLE_CONFIG };
/** 局部覆盖：仅对某个工作流生效的差异化配置 */
const localOverrides = new Map<WorkflowConfigScope, Partial<WorkflowStyleConfig>>();
/** 有效配置缓存（保证 getSnapshot 引用稳定，变更时才失效） */
const effectiveCache = new Map<WorkflowConfigScope, WorkflowStyleConfig>();
const listeners = new Set<() => void>();

function computeEffective(scope: WorkflowConfigScope): WorkflowStyleConfig {
  const cached = effectiveCache.get(scope);
  if (cached) return cached;
  const effective = { ...globalConfig, ...(localOverrides.get(scope) ?? {}) };
  effectiveCache.set(scope, effective);
  return effective;
}

function invalidate(scope?: WorkflowConfigScope): void {
  if (scope === undefined) {
    effectiveCache.clear();
  } else {
    effectiveCache.delete(scope);
  }
}

function notify(): void {
  listeners.forEach((l) => l());
}

/** 读取某 scope 的有效配置（全局 + 局部合并；返回缓存的稳定引用） */
export function getEffectiveConfig(scope: WorkflowConfigScope): WorkflowStyleConfig {
  return computeEffective(scope);
}

/** 供 useSyncExternalStore 使用：任何一层配置变化都会触发 */
export function subscribeConfigStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 订阅某 scope 的有效配置变化（画布等非 React 调用方使用） */
export function subscribeEffectiveConfig(
  scope: WorkflowConfigScope,
  listener: (c: WorkflowStyleConfig) => void
): () => void {
  const wrapped = () => listener(computeEffective(scope));
  listeners.add(wrapped);
  return () => {
    listeners.delete(wrapped);
  };
}

/**
 * 修改配置。
 * globalMode = true：写入全局层，应用到所有工作流；
 * globalMode = false：写入当前 scope 的局部覆盖，仅当前工作流生效。
 */
export function updateStyleConfig(
  scope: WorkflowConfigScope,
  patch: Partial<WorkflowStyleConfig>,
  globalMode: boolean
): void {
  if (globalMode) {
    globalConfig = { ...globalConfig, ...patch };
    invalidate();
  } else {
    localOverrides.set(scope, { ...(localOverrides.get(scope) ?? {}), ...patch });
    invalidate(scope);
  }
  notify();
}

/**
 * 恢复默认。
 * globalMode = true：全局层恢复出厂默认（各 scope 的局部覆盖保留）；
 * globalMode = false：清除当前 scope 的局部覆盖，回退到全局配置。
 */
export function resetStyleConfig(scope: WorkflowConfigScope, globalMode: boolean): void {
  if (globalMode) {
    globalConfig = { ...DEFAULT_STYLE_CONFIG };
    invalidate();
  } else {
    localOverrides.delete(scope);
    invalidate(scope);
  }
  notify();
}
