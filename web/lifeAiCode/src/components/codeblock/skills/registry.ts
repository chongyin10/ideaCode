/* ─────────────────────────────────────────────────────────────────── */
/*  CodeBlock Skill 注册表                                            */
/* ─────────────────────────────────────────────────────────────────── */
/*  所有 Skill 在此注册，CodeBlock 主组件通过 getMatchingSkills 查找。
 *  新增语言行为：新建 skill 文件 → 在此 registerSkill → 自动生效。    */

import type { CodeBlockSkill, CodeBlockSkillContext } from './types';
import { ShellSkill } from './ShellSkill';

const skills: CodeBlockSkill[] = [];

/** 注册一个 Skill（重复 id 会被忽略） */
export function registerSkill(skill: CodeBlockSkill) {
  if (skills.some((s) => s.id === skill.id)) return;
  skills.push(skill);
}

/** 查找匹配当前上下文的所有 Skill（按注册顺序） */
export function getMatchingSkills(ctx: CodeBlockSkillContext): CodeBlockSkill[] {
  return skills.filter((s) => {
    if (s.canActivate) return s.canActivate(ctx);
    if (s.languages) return s.languages.includes(ctx.language);
    return false;
  });
}

/** 获取所有已注册 Skill（调试用） */
export function getAllSkills(): readonly CodeBlockSkill[] {
  return skills;
}

/* ── 内置 Skill 注册 ────────────────────────────────────────────── */
registerSkill(ShellSkill);
