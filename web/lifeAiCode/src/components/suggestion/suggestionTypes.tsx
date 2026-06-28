/* ─────────────────────────────────────────────────────────────────── */
/*  建议类型注册表（Action 模式）                                      */
/* ─────────────────────────────────────────────────────────────────── */
/*  把"建议类型元数据"（label/icon）抽成可注册结构。
 *  新增建议类型只需 registerSuggestionType，不改动 SuggestionCard。
 *  未知 type 一律回退到 refactor，避免 LLM 自由发挥污染 UI。        */

import type { ReactNode } from 'react';
import { Wrench, Bug, Sparkles, Zap, HelpCircle } from 'lucide-react';

export interface SuggestionTypeMeta {
  /** 唯一标识（对应 suggestion.type） */
  id: string;
  /** 显示名（如"重构""修复"） */
  label: string;
  /** 图标 */
  icon: ReactNode;
  /** 是否显示 diff 对比（explanation 类可能不需要，默认 true） */
  showDiff?: boolean;
}

const registry = new Map<string, SuggestionTypeMeta>();

/** 注册一个建议类型 */
export function registerSuggestionType(meta: SuggestionTypeMeta) {
  registry.set(meta.id, meta);
}

/** 获取类型元数据，未知 type 回退到 refactor（防御 LLM 自由发挥） */
export function getSuggestionTypeMeta(type: string): SuggestionTypeMeta {
  return registry.get(type) || registry.get('refactor')!;
}

/** 是否已注册该类型（用于 CSS class 防御） */
export function isKnownSuggestionType(type: string): boolean {
  return registry.has(type);
}

/* ── 内置类型注册 ────────────────────────────────────────────────── */
registerSuggestionType({ id: 'refactor', label: '重构', icon: <Wrench size={10} strokeWidth={2.2} /> });
registerSuggestionType({ id: 'bugfix', label: '修复', icon: <Bug size={10} strokeWidth={2.2} /> });
registerSuggestionType({ id: 'feature', label: '功能', icon: <Sparkles size={10} strokeWidth={2.2} /> });
registerSuggestionType({ id: 'optimization', label: '优化', icon: <Zap size={10} strokeWidth={2.2} /> });
registerSuggestionType({ id: 'explanation', label: '解释', icon: <HelpCircle size={10} strokeWidth={2.2} /> });
