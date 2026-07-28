import type { Dnd, Graph } from '../workflow';

/**
 * 工作流画布运行时（模块级单例）
 *
 * 左侧物料面板（WorkflowPanel）与主编辑区画布 tab（WorkflowCanvas）
 * 在组件树中相距很远，通过此单例共享当前活跃的 Graph / Dnd 实例：
 * 画布挂载时注册，卸载时清空；面板据此注册拖拽源。
 */

export interface WorkflowRuntime {
  graph: Graph;
  dnd: Dnd;
}

let runtime: WorkflowRuntime | null = null;
const listeners = new Set<(r: WorkflowRuntime | null) => void>();

export function getWorkflowRuntime(): WorkflowRuntime | null {
  return runtime;
}

export function setWorkflowRuntime(r: WorkflowRuntime | null): void {
  runtime = r;
  listeners.forEach((l) => l(runtime));
}

export function subscribeWorkflowRuntime(listener: (r: WorkflowRuntime | null) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
