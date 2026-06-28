/* ─────────────────────────────────────────────────────────────────── */
/*  ShellContext：shell 执行能力的 React Context                       */
/* ─────────────────────────────────────────────────────────────────── */
/*  MarkdownContent 用 <ShellContext.Provider> 包裹 ReactMarkdown，
 *  CodeBlock 主组件通过 useContext 订阅。这样 shellOutputs 变化时
 *  直接触发 CodeBlock 重渲染，绕过 ReactMarkdown 的 prop 链
 *  （ReactMarkdown 在 markdown 文本不变时会跳过 code 渲染器）。   */

import { createContext } from 'react';
import type { ShellOutputsMap } from './skills/types';

export interface ShellContextValue {
  shellOutputs: ShellOutputsMap;
  onExecuteShell?: (id: string, command: string) => void;
  onKillShell?: (id: string) => void;
}

export const ShellContext = createContext<ShellContextValue>({ shellOutputs: {} });
