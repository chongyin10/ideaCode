import { useMemo } from 'react';
import type { Suggestion, SuggestionChange } from '../types';
import { SuggestionCard, SuggestionAdvice } from './suggestion';
import { toAbsolutePathKey } from '../utils/pathNormalize';

interface SuggestionListProps {
  suggestions: Suggestion[];
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  /** §需求：SuggestionCard header 的「变更」按钮调用此回调在编辑器中打开 diff 对比 */
  onOpenDiffInEditor: (change: SuggestionChange) => void;
  /**
   * §需求：当前工作区根路径，用于把相对路径（./xxx / xxx）解析为绝对路径做去重。
   * 缺失时也能正常工作（best-effort，仅做字符串规范化）。
   */
  workspaceRoot?: string;
}

/**
 * §需求：按绝对路径去重 Suggestion，保留最新的（数组末尾优先）。
 *
 * 场景：LLM 在多轮输出中可能为同一文件多次生成建议（v1 改两行、v2 改成更优版本等），
 * 字面 filePath 可能不同（`./vite.config.ts` / `vite.config.ts` / 绝对路径），
 * 若都渲染到聊天窗口会重复占用空间。
 *
 * 设计：
 * 1. **去重范围**：只对有 changes 的 Suggestion 去重；纯 explanation / 没有 filePath
 *    的 Suggestion 一律保留（无法归类到同一文件）。
 * 2. **保留策略**：last-write-wins（保留最后出现的 Suggestion，因为它是 LLM 最新的理解）。
 *    这样用户看到的是最新版本，旧版本被覆盖（不会同时存在两份）。
 * 3. **不影响 allChanges**：本组件只控制渲染，不修改 messages/suggestions。
 *    ChatPanel 里的 allChanges（弹窗中的"变更文件"列表）仍能展示所有相关文件。
 */
function dedupeByAbsolutePath(suggestions: Suggestion[], workspaceRoot?: string): Suggestion[] {
  // §需求：先用绝对路径 key 做去重，然后用原数组下标排序保持渲染顺序。
  // 拆分：有 changes 的与没 changes 的都保留（无 filePath 的无法归类）。
  const keyToIndex = new Map<string, number>();
  suggestions.forEach((s, idx) => {
    const firstFile = s.changes?.[0]?.filePath;
    if (!firstFile) return;
    const key = toAbsolutePathKey(firstFile, workspaceRoot);
    if (!key) return;
    // §需求：last-write-wins——同一个 key 后面出现的覆盖前面的（Set 后写入生效）。
    keyToIndex.set(key, idx);
  });

  // §需求：仅保留「该 idx 对应的 suggestion 是该文件最后一次出现」的项。
  // 构造原数组中所有需要保留的下标集合。
  const keepIndices = new Set<number>(keyToIndex.values());
  // 同时保留所有无 filePath 的 suggestion（无法归类）
  suggestions.forEach((s, idx) => {
    if (!s.changes?.[0]?.filePath) keepIndices.add(idx);
  });

  // 按原数组顺序输出
  return suggestions.filter((_, idx) => keepIndices.has(idx));
}

export function SuggestionList({ suggestions, onAccept, onReject, onOpenDiffInEditor, workspaceRoot }: SuggestionListProps) {
  // §需求：按绝对路径去重（last-write-wins），把去重后的数组传给 SuggestionCard 渲染。
  const deduped = useMemo(() => dedupeByAbsolutePath(suggestions, workspaceRoot), [suggestions, workspaceRoot]);

  if (deduped.length === 0) return null;

  return (
    <div className="suggestions-container">
      {deduped.map((s) => {
        // §需求：按"是否有具体文件位置"分流渲染
        //  - 有 filePath：走 SuggestionCard（完整卡片，带变更/展开/状态）
        //  - 无 filePath：走 SuggestionAdvice（轻量建议行，无变更/展开）
        // 双重判断：先看 changes[0]?.filePath，再看 description（兜底，防御 LLM
        // 把建议文字塞到 description 而 changes 为空的情况）
        const hasFilePath = !!(s.changes?.[0]?.filePath && s.changes[0].filePath.trim());
        if (hasFilePath) {
          return (
            <SuggestionCard
              key={s.id}
              suggestion={s}
              onAccept={onAccept}
              onReject={onReject}
              onOpenDiffInEditor={onOpenDiffInEditor}
              loading={s.status === 'pending'}
            />
          );
        }
        return (
          <SuggestionAdvice
            key={s.id}
            suggestion={s}
            onAccept={onAccept}
            onReject={onReject}
            loading={s.status === 'pending'}
          />
        );
      })}
    </div>
  );
}