/* ─────────────────────────────────────────────────────────────────── */
/*  ShellContext：shell 执行能力的 React Context                       */
/* ─────────────────────────────────────────────────────────────────── */
/*  MarkdownContent 用 <ShellContext.Provider> 包裹自定义 hast 渲染，
 *  CodeBlock 主组件通过 useContext 订阅。这样 shellOutputs 变化时
 *  直接触发 CodeBlock 重渲染，绕过自定义渲染的 prop 链
 *  （hast 文本不变时跳过的不是整个子树）。   */

import { createContext } from 'react';
import type { ShellOutputsMap } from './skills/types';

export interface ShellContextValue {
  shellOutputs: ShellOutputsMap;
  onExecuteShell?: (id: string, command: string) => void;
  onKillShell?: (id: string) => void;
}

export const ShellContext = createContext<ShellContextValue>({ shellOutputs: {} });
