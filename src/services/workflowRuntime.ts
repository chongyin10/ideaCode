import type { Dnd, Graph } from '../workflow';

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
