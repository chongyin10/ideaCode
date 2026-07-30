import type { Dnd, Graph } from '../workflow';
import type { WorkflowFileData } from './workflowPersistence';

/** 第一个工作流画布 tab 的 id（后续递增为 workflow-canvas-2、workflow-canvas-3 …） */
export const WORKFLOW_TAB_ID = 'workflow-canvas';

/** 一个工作流画布实例：Graph + Dnd + 宿主 DOM（tab 切换只 reparent，不销毁） */
export interface WorkflowInstance {
  graph: Graph;
  dnd: Dnd;
  host: HTMLDivElement;
  /** 释放实例持有的外部订阅（样式配置监听等），destroyWorkflowInstance 时调用 */
  dispose: () => void;
}

export interface WorkflowRuntime {
  graph: Graph;
  dnd: Dnd;
  /** 该运行时归属的工作流 scope（= 画布 tab id） */
  scope: string;
}

/** 全部画布实例：scope（= tab id）→ 实例 */
const instances = new Map<string, WorkflowInstance>();
/** 画布已保存到的文件路径：scope → 完整路径（保存成功后记录，再次保存时直接覆盖） */
const savedFilePaths = new Map<string, string>();
/** 当前挂载中的画布运行时（物料面板据此注册拖拽源） */
let runtime: WorkflowRuntime | null = null;
/** 最近活跃的画布 scope：样式配置 tab 据此确定编辑目标；画布卸载后仍保留 */
let lastActiveScope: string | null = null;
const listeners = new Set<(r: WorkflowRuntime | null) => void>();

export function getWorkflowRuntime(): WorkflowRuntime | null {
  return runtime;
}

export function setWorkflowRuntime(r: WorkflowRuntime | null): void {
  runtime = r;
  if (r) lastActiveScope = r.scope;
  listeners.forEach((l) => l(runtime));
}

export function subscribeWorkflowRuntime(listener: (r: WorkflowRuntime | null) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 最近活跃的工作流 scope（样式配置 tab 的编辑目标） */
export function getLastActiveWorkflowScope(): string | null {
  return lastActiveScope;
}

export function getWorkflowInstance(scope: string): WorkflowInstance | undefined {
  return instances.get(scope);
}

export function setWorkflowInstance(scope: string, instance: WorkflowInstance): void {
  instances.set(scope, instance);
}

/** 画布已保存到的文件路径（无记录返回 undefined） */
export function getWorkflowSavedFilePath(scope: string): string | undefined {
  return savedFilePaths.get(scope);
}

/** 记录画布保存到的文件路径，再次保存时直接覆盖该文件 */
export function setWorkflowSavedFilePath(scope: string, filePath: string): void {
  savedFilePaths.set(scope, filePath);
}

/** 待灌入画布的图数据：scope → 数据（如依赖可视化，画布挂载后消费一次） */
const pendingGraphData = new Map<string, WorkflowFileData>();

/** 预置要在画布挂载时灌入的图数据 */
export function setPendingWorkflowGraphData(scope: string, data: WorkflowFileData): void {
  pendingGraphData.set(scope, data);
}

/** 取出并清除预置图数据（一次性消费） */
export function consumePendingWorkflowGraphData(scope: string): WorkflowFileData | undefined {
  const data = pendingGraphData.get(scope);
  if (data) pendingGraphData.delete(scope);
  return data;
}

/** 依赖可视化的视图模式：按子目录聚合成组节点 / 全部文件 */
export type DepGraphViewMode = 'aggregate' | 'files';

/** 依赖可视化：文件级源数据（模式切换时据此重建画布，无需重读文件） */
const depGraphSourceData = new Map<string, WorkflowFileData>();
/** 依赖可视化：当前视图模式（tab 重挂载时恢复） */
const depGraphViewModes = new Map<string, DepGraphViewMode>();

/** 保存依赖可视化的文件级源数据 */
export function setDepGraphSourceData(scope: string, data: WorkflowFileData): void {
  depGraphSourceData.set(scope, data);
}

/** 读取依赖可视化的文件级源数据（无记录返回 undefined） */
export function getDepGraphSourceData(scope: string): WorkflowFileData | undefined {
  return depGraphSourceData.get(scope);
}

/** 记录依赖可视化的视图模式 */
export function setDepGraphViewMode(scope: string, mode: DepGraphViewMode): void {
  depGraphViewModes.set(scope, mode);
}

/** 读取依赖可视化的视图模式（无记录返回 undefined） */
export function getDepGraphViewMode(scope: string): DepGraphViewMode | undefined {
  return depGraphViewModes.get(scope);
}

/** 依赖可视化：聚合模式下已双击下钻的组 id（tab 重挂载时恢复） */
const depGraphExpandedGroups = new Map<string, Set<string>>();
const EMPTY_GROUPS: ReadonlySet<string> = new Set();

/** 读取聚合模式下已展开的组 id 集合 */
export function getDepGraphExpandedGroups(scope: string): ReadonlySet<string> {
  return depGraphExpandedGroups.get(scope) ?? EMPTY_GROUPS;
}

/** 切换某个组的展开/收起状态 */
export function toggleDepGraphExpandedGroup(scope: string, groupId: string): void {
  let set = depGraphExpandedGroups.get(scope);
  if (!set) {
    set = new Set();
    depGraphExpandedGroups.set(scope, set);
  }
  if (set.has(groupId)) set.delete(groupId);
  else set.add(groupId);
}

/** 收起全部已展开的组（回到初始聚合视图） */
export function resetDepGraphExpandedGroups(scope: string): void {
  depGraphExpandedGroups.delete(scope);
}

/** 销毁某个工作流画布实例（tab 关闭时调用，释放 Graph 与宿主 DOM） */
export function destroyWorkflowInstance(scope: string): void {
  const instance = instances.get(scope);
  if (!instance) return;
  // 先摘除外部订阅（配置服务的 listeners 若残留闭包，会把整个实例留在内存里，
  // 且每次配置变化还会对已销毁的 Graph 做无效应用）
  instance.dispose();
  instance.graph.destroy();
  instance.host.remove();
  instances.delete(scope);
  savedFilePaths.delete(scope);
  pendingGraphData.delete(scope);
  depGraphSourceData.delete(scope);
  depGraphViewModes.delete(scope);
  depGraphExpandedGroups.delete(scope);
  if (runtime?.scope === scope) {
    setWorkflowRuntime(null);
  }
}

/**
 * 依据已打开的工作流 tab 计算下一个 tab 的 id 与序号。
 * 序号取现有最大序号 + 1（关闭中间序号的 tab 后不会重号）。
 */
export function getNextWorkflowTabMeta(
  openedFiles: { id: string; language?: string }[]
): { id: string; seq: number } {
  let max = 0;
  for (const f of openedFiles) {
    if (f.language !== 'workflow') continue;
    const m = /^workflow-canvas(?:-(\d+))?$/.exec(f.id);
    if (m) max = Math.max(max, m[1] ? parseInt(m[1], 10) : 1);
  }
  const seq = max + 1;
  return { id: seq === 1 ? WORKFLOW_TAB_ID : `${WORKFLOW_TAB_ID}-${seq}`, seq };
}
