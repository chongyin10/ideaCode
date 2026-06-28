/**
 * Monaco 语义高亮（Semantic Tokens）Provider 共享模块
 *
 * 背景：
 * - 主编辑器（MonacoEditor）和 Diff 编辑器（DiffEditorPanel）都需要按语言（TS/JS/JSX/TSX）
 *   提供 semantic tokens，让方法/属性/变量/参数等具备语义化着色。
 * - 两个编辑器在同一个 monaco 实例下注册 provider 时，注册到同一语言的多个 provider
 *   会同时被调用（monaco-editor 的 SemanticTokensProviderRegistry 支持按 language
 *   累计 provider），由 monaco 自行挑选第一个返回非空 tokens 的 provider。
 * - 因此需要在 DiffEditorPanel 中为 diff 虚拟模型额外注册一个 provider，
 *   并让 MonacoEditor 的 provider 对非 file:// 模型主动放弃，避免误用错文件路径的 tokens。
 *
 * 公共 legend：与 electron/shared/semanticTokensLegend.cjs / MonacoEditor 默认 legend 保持一致。
 */

import type * as Monaco from 'monaco-editor';
import { tsService } from './tsLanguageService';
import type { TsSemanticTokens } from './tsLanguageService';

/** 与 tsserver 的语义 token legend 保持同步（同时见 electron/shared/semanticTokensLegend.cjs） */
export const SEMANTIC_TOKEN_TYPES = [
  'class', 'enum', 'interface', 'namespace', 'typeParameter', 'type',
  'parameter', 'variable', 'enumMember', 'property', 'function', 'member',
];

export const SEMANTIC_TOKEN_MODIFIERS = [
  'declaration', 'static', 'async', 'readonly', 'defaultLibrary', 'local',
];

export const DEFAULT_SEMANTIC_TOKENS_LEGEND = {
  tokenTypes: SEMANTIC_TOKEN_TYPES,
  tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
};

/** 哪些语言需要语义高亮 provider（仅 TS/JS 系） */
export const SEMANTIC_LANGUAGES = new Set([
  'typescript', 'javascript', 'typescriptreact', 'javascriptreact',
]);

/**
 * 注册一个 Diff 模型专用的语义高亮 provider
 *
 * 调用时机：在 DiffEditorPanel 的 `onMount` 中（拿到 monaco 后），并把 disposable
 * 保存到组件状态中，组件卸载时 dispose。
 *
 * 行为：
 * - 仅处理 scheme 为 gitdiff-original / gitdiff-modified 的模型；
 *   其它模型返回 null，让 MonacoEditor 注册的 file:// provider 接管。
 * - 左右两个面板是**相互独立**的 ITextModel，内容不同（一个是 git HEAD，一个是工作区），
 *   semantic tokens 基于「行+列+长度」相对编码，必须各自使用对应内容的 tokens，
 *   否则会出现字符高亮错位（如 modified 的 tokens 套到 original 上，标识符颜色串位）。
 * - 因此 provider 按 scheme 区分：original model 用预取的 original tokens，
 *   modified model 用预取的 modified tokens。预取失败时 modified 走实时请求兜底，
 *   original（tsserver 只持有 modified 内容）走空数组 → 基础语法高亮（不会错位）。
 *
 * @param prefetchedModifiedTokens modified 面板预取的 semantic tokens（可选）
 * @param prefetchedOriginalTokens original 面板预取的 semantic tokens（可选）
 * @returns disposable（monaco.languages.registerDocumentSemanticTokensProvider 返回值）
 */
export function registerDiffSemanticTokensProvider(
  monaco: typeof Monaco,
  language: string,
  prefetchedModifiedTokens?: TsSemanticTokens | null,
  prefetchedOriginalTokens?: TsSemanticTokens | null,
): Monaco.IDisposable {
  return monaco.languages.registerDocumentSemanticTokensProvider(language, {
    getLegend: () => DEFAULT_SEMANTIC_TOKENS_LEGEND,
    provideDocumentSemanticTokens: async (model) => {
      const scheme = model.uri.scheme;
      if (scheme !== 'gitdiff-original' && scheme !== 'gitdiff-modified') {
        // 不是我负责的模型，让别的 provider 处理
        return null;
      }
      // model.uri.path 是绝对磁盘路径（如 /Users/foo/bar.ts）。
      const p = model.uri.path || '';
      if (!p) return null;

      // 按 scheme 选取对应内容的预取 tokens（左右面板独立）
      const prefetched = scheme === 'gitdiff-original' ? prefetchedOriginalTokens : prefetchedModifiedTokens;
      if (prefetched && prefetched.data && prefetched.data.length > 0) {
        const src = prefetched.data;
        const data = src instanceof Uint32Array ? src : new Uint32Array(src);
        return { resultId: prefetched.resultId, data };
      }

      // 兜底：modified 可实时请求 tsserver（它持有 modified 内容）；
      // original 不能实时请求（tsserver 只 open 了 modified，会拿到 modified 的 tokens → 错位），
      // 返回空数组走基础语法高亮，至少不错位。
      if (scheme === 'gitdiff-modified') {
        try {
          const tokens: TsSemanticTokens | null = await tsService.semanticTokens(p);
          if (tokens && tokens.data && tokens.data.length > 0) {
            return { resultId: tokens.resultId, data: new Uint32Array(tokens.data) };
          }
        } catch {
          // tsserver 未就绪或不可达
        }
      }
      return { data: new Uint32Array(0) };
    },
    releaseDocumentSemanticTokens: () => {},
  });
}