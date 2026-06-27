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
 * - 优先使用调用方预取的 tokens（避免 tsserver 冷启动延迟），
 *   预取失败时实时请求 tsService.semanticTokens()。
 *
 * @param prefetchedTokens 调用方预取的 semantic tokens（可选）
 * @returns disposable（monaco.languages.registerDocumentSemanticTokensProvider 返回值）
 */
export function registerDiffSemanticTokensProvider(
  monaco: typeof Monaco,
  language: string,
  prefetchedTokens?: TsSemanticTokens | null,
  groupId?: string,
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

      // 1. 优先使用预取的 tokens（DiffEditorPanel 在渲染前已等待 tsserver 加载完成）
      if (prefetchedTokens && prefetchedTokens.data && prefetchedTokens.data.length > 0) {
        return { resultId: prefetchedTokens.resultId, data: new Uint32Array(prefetchedTokens.data) };
      }

      // 2. 预取不可用时实时请求（兜底）
      try {
        const tokens: TsSemanticTokens | null = await tsService.semanticTokens(p);
        if (tokens && tokens.data && tokens.data.length > 0) {
          return { resultId: tokens.resultId, data: new Uint32Array(tokens.data) };
        }
      } catch {
        // tsserver 未就绪或不可达
      }
      return { data: new Uint32Array(0) };
    },
    releaseDocumentSemanticTokens: () => {},
  });
}