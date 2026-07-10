/* ─────────────────────────────────────────────────────────────────── */
/*  CodeBlock Skill 类型定义                                          */
/* ─────────────────────────────────────────────────────────────────── */
/*  Skill 模式：把"代码块专属行为"（shell 执行、Python 运行、SQL 查询
 *  等）抽象成可注册的 Skill。新增语言行为只需新建文件 + registerSkill，
 *  不改动 CodeBlock 主组件。                                        */

import type { ReactNode } from 'react';

/** 终端输出状态：running 执行中 / success 完成 / error 失败 / killed 已停止 / deferred 已转入后台 */
export type ShellStatus = 'running' | 'success' | 'error' | 'killed' | 'deferred';

/** shellOutputs map：以 execId 为 key 存储每个执行实例的输出 */
export type ShellOutputsMap = Record<
  string,
  {
    output: string;
    status: ShellStatus;
    /** 长驻进程（dev server / watch / tail -f 等）：spawn 后已脱离 Agent 同步等待，仅节流推送日志 */
    longRunning?: boolean;
    /** §后台任务管理器：命令执行超阈值后转入后台队列，不阻塞 Agent 主流程 */
    deferred?: boolean;
  }
>;

/**
 * CodeBlock 主组件传给 Skill 的上下文。
 * Skill 通过此对象访问代码内容、语言、shell 相关能力及自身的 state。
 */
export interface CodeBlockSkillContext {
  /** 代码块语言（已归一化，如 'bash' 'python' 'typescript'） */
  language: string;
  /** 代码块原始文本（去掉末尾换行） */
  code: string;
  /** shell 执行输出 map（由 MarkdownContent 的 ShellContext 提供） */
  shellOutputs?: ShellOutputsMap;
  /** 触发 shell 执行（由 ChatPanel → 扩展宿主处理） */
  onExecuteShell?: (id: string, command: string) => void;
  /** 终止 shell 执行（释放子进程资源） */
  onKillShell?: (id: string) => void;
  /** 读取 Skill 自身持久化 state（如 execId、折叠状态） */
  getSkillState: (skillId: string) => Record<string, unknown> | undefined;
  /** 写入 Skill 自身持久化 state（触发 CodeBlock 重渲染） */
  setSkillState: (skillId: string, state: Record<string, unknown>) => void;
}

/**
 * CodeBlock Skill 接口。
 * 一个 Skill 负责：
 *  - 声明它适用于哪些语言（languages）或动态判断（canActivate）
 *  - 在 header 操作区渲染按钮（renderActions，如"执行""停止"）
 *  - 在 body 下方渲染输出占位区（renderOutput，如终端输出）
 */
export interface CodeBlockSkill {
  /** 唯一标识，用作 skillState 的 key */
  id: string;
  /** 静态语言匹配列表（与 language 归一化值比对） */
  languages?: string[];
  /** 动态匹配（优先级高于 languages，返回 true 则激活） */
  canActivate?(ctx: CodeBlockSkillContext): boolean;
  /** 渲染 header 操作按钮（执行/停止/格式化等） */
  renderActions?(ctx: CodeBlockSkillContext): ReactNode;
  /** 渲染 body 下方输出区（终端输出/预览等） */
  renderOutput?(ctx: CodeBlockSkillContext): ReactNode;
}
