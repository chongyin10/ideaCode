/* ─────────────────────────────────────────────────────────────────── */
/*  codeblock 模块导出                                                 */
/* ─────────────────────────────────────────────────────────────────── */
/*  MarkdownContent 只需导入 CodeBlock 和 ShellContext。
 *  新增 Skill：在 skills/ 下建文件 → 在 skills/registry.ts 注册。    */

export { CodeBlock } from './CodeBlock';
export { ShellContext } from './ShellContext';
export type { ShellContextValue } from './ShellContext';
export type { ShellOutputsMap, ShellStatus, CodeBlockSkill, CodeBlockSkillContext } from './skills/types';
export { registerSkill, getMatchingSkills } from './skills/registry';
// 智能 Shell 命令检测（前后端共用入口，后端 cjs 版见 extension-host/shellDetect.cjs）
export { isShellCommand, hasShellCommand, describeShellCommand } from './shellDetect';
