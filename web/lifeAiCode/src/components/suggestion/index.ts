/* ─────────────────────────────────────────────────────────────────── */
/*  suggestion 模块导出                                                */
/* ─────────────────────────────────────────────────────────────────── */
/*  SuggestionList 只需导入 SuggestionCard。
 *  新增建议类型：在 suggestionTypes.tsx 调用 registerSuggestionType。 */

export { SuggestionCard } from './SuggestionCard';
export { SuggestionAdvice } from './SuggestionAdvice';
export { DiffView } from './DiffView';
export { registerSuggestionType, getSuggestionTypeMeta, isKnownSuggestionType } from './suggestionTypes';
export type { SuggestionTypeMeta } from './suggestionTypes';
