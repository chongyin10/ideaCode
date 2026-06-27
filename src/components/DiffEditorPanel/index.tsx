/**
 * Diff 编辑器组件（嵌入 Tab 系统）
 *
 * 使用 Monaco 内置 DiffEditor（与 VSCode 相同引擎），原生支持：
 * - 语法高亮（完整 tokenization + 主题着色）
 * - 行级 / 字符级差异标记
 * - 双栏同步滚动
 * - 差异导航
 *
 * 此版本作为 Tab 内容渲染，不显示独立头部（Tab 栏已显示文件名）。
 */

import { useRef, useCallback, useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { updateDiffView } from '../../store/slices/workspaceSlice';
import type { DiffView } from '../../store/slices/workspaceSlice';
import {
  ArrowLeftRight, ArrowUp, ArrowDown, ArrowRightLeft, RefreshCw,
} from 'lucide-react';
import type * as Monaco from 'monaco-editor';
import { DiffEditor } from '@monaco-editor/react';
import { beforeMount, toMonacoTheme } from '../MonacoEditor/index';
import { ensureLanguage } from '../../services/languageLoader';
import { computeLineDiff } from '../../services/diffAlgorithm';
import {
  registerDiffSemanticTokensProvider,
  SEMANTIC_LANGUAGES,
} from '../../services/monacoSemanticTokens';
import { tsService, type TsSemanticTokens } from '../../services/tsLanguageService';
import './DiffEditorPanel.css';

/* ─── 辅助：为 diff 左侧（git HEAD）构造独立虚拟路径 ─── */
/**
 * tsserver 按 filePath 维护文件内容，一个 filePath 只持有一份内容。
 * diff 左侧（original = git HEAD）与右侧（modified = 工作区）内容不同，
 * 若复用同一 filePath，original 的 open 会覆盖 modified 内容。
 * 因此为 original 构造一个独立虚拟路径，并保留原扩展名（如 .ts/.tsx），
 * 让 tsserver 仍按对应语言进行 tokenization，生成与 original 内容匹配的 semantic tokens。
 *
 * 例：/Users/foo/bar.ts → /Users/foo/bar.diff-original.ts
 */
function makeDiffOriginalPath(filePath: string): string {
  const lastSlash = filePath.lastIndexOf('/');
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot > lastSlash) {
    return filePath.slice(0, lastDot) + '.diff-original' + filePath.slice(lastDot);
  }
  return filePath + '.diff-original';
}

/* ─── Props ─── */

interface DiffEditorPanelProps {
  diffData: DiffView;
  groupId?: string;
}

/* ─── 组件 ─── */

const DiffEditorPanel = ({ diffData, groupId }: DiffEditorPanelProps) => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const theme = useAppSelector((s) => s.settings.theme);
  const semanticHighlightingEnabled = useAppSelector((s) => s.settings.semanticHighlightingEnabled);

  const diffEditorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const semTokensDisposableRef = useRef<Monaco.IDisposable | null>(null);
  const diagUnsubRef = useRef<(() => void) | null>(null);
  const retryTriggerRef = useRef<(() => void) | null>(null);
  // 预取的 semantic tokens：左右两个面板是独立 ITextModel，内容不同
  // （original = git HEAD，modified = 工区），tokens 基于「行+列+长度」相对编码，
  // 必须各自使用对应内容的 tokens，否则会出现字符高亮错位。
  const prefetchedTokensRef = useRef<{ modified: TsSemanticTokens | null; original: TsSemanticTokens | null }>({
    modified: null,
    original: null,
  });
  const [currentDiffIndex, setCurrentDiffIndex] = useState(-1);
  const [lineChanges, setLineChanges] = useState<Monaco.editor.ILineChange[]>([]);

  // 高亮准备状态：TS/JS 文件需要等 tsserver 加载并预取 semantic tokens 完成后再渲染 DiffEditor，
  // 否则 DiffEditor 首次渲染时 provider 返回空 → Monaco 标记 model 为"无 semantic tokens" → 高亮永不出现。
  // 非 TS/JS 文件不需要等待，直接渲染。
  const isTsJs = !!(diffData.language && SEMANTIC_LANGUAGES.has(diffData.language));
  const [tokensReady, setTokensReady] = useState(!isTsJs);

  // 预取 semantic tokens：在渲染 DiffEditor 之前，把文件推送给 tsserver 并等待 tokens 返回。
  // 这样 DiffEditor 首次渲染时 provider 就能用预取的 tokens，高亮立即生效。
  // 左右两个面板独立预取：modified 用真实 filePath，original 用虚拟路径（保留扩展名让 tsserver 识别语言），
  // 互不干扰。tsserver 一个 filePath 只持有一份内容，若 original 复用 filePath 会覆盖 modified。
  useEffect(() => {
    if (!isTsJs || !diffData.filePath) {
      setTokensReady(true);
      return;
    }

    let cancelled = false;
    const filePath = diffData.filePath;
    const originalPath = makeDiffOriginalPath(filePath);

    // 轮询获取某路径的 semantic tokens，最多 5 秒（10 次 × 500ms）
    const fetchTokens = async (path: string, content: string): Promise<TsSemanticTokens | null> => {
      await tsService.open(path, content);
      for (let i = 0; i < 10; i++) {
        if (cancelled) return null;
        try {
          const tokens = await tsService.semanticTokens(path);
          if (tokens && tokens.data && tokens.data.length > 0) {
            return tokens;
          }
        } catch { /* tsserver 未就绪，继续重试 */ }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return null;
    };

    const prepare = async () => {
      try {
        // 1. 预取 modified tokens（真实 filePath）
        const modTokens = await fetchTokens(filePath, diffData.modified);
        if (cancelled) return;

        // 2. 预取 original tokens（虚拟路径，tsserver 当作独立文件处理）
        let origTokens: TsSemanticTokens | null = null;
        if (diffData.original) {
          try {
            origTokens = await fetchTokens(originalPath, diffData.original);
          } catch {
            // original 预取失败：左侧走基础语法高亮（不会错位）
          } finally {
            // 释放虚拟文件，避免 tsserver 残留占用
            try { tsService.close(originalPath); } catch { /* 忽略 */ }
          }
        }
        if (cancelled) return;

        prefetchedTokensRef.current = { modified: modTokens, original: origTokens };
        setTokensReady(true);
      } catch {
        // open 或 semanticTokens 出错：降级为基础语法高亮
        if (!cancelled) setTokensReady(true);
      }
    };

    setTokensReady(false);
    prefetchedTokensRef.current = { modified: null, original: null };
    prepare();

    return () => {
      cancelled = true;
      // 清理虚拟文件
      try { tsService.close(originalPath); } catch { /* 忽略 */ }
    };
  }, [diffData.filePath, diffData.modified, diffData.original, isTsJs]);

  // 使用 groupId 生成唯一的 model path，避免分屏时 model 冲突
  const modelPathPrefix = groupId ? `${groupId}-` : '';
  const diffEditorKey = `${modelPathPrefix}${diffData.filePath}-${diffData.language}-${diffData.original.length}-${diffData.modified.length}`;

  /* ── 统计信息（Myers 算法即时计算） ── */
  const stats = useMemo(() => {
    const lines = computeLineDiff(diffData.original, diffData.modified);
    let added = 0;
    let deleted = 0;
    for (const line of lines) {
      if (line.type === 'insert') added++;
      if (line.type === 'delete') deleted++;
    }
    return { added, deleted };
  }, [diffData.original, diffData.modified]);

  /* ── DiffEditor 挂载处理 ── */
  const handleDiffEditorMount = useCallback(
    (editor: Monaco.editor.IStandaloneDiffEditor, monaco: typeof Monaco) => {
      diffEditorRef.current = editor;
      monacoRef.current = monaco;

      const language = diffData.language;
      if (language) {
        ensureLanguage(language).catch(() => {});
      }

      // 关键：把 modified（工作区当前内容）推送给 tsserver，让 semantic tokens 可用。
      // 主编辑器 MonacoEditor 在 onMount 也会 open，但用户可能直接从 git 面板点开 diff，
      // 从未在主编辑器打开过该文件 → tsserver 未加载该文件 → semanticTokens 返回 null。
      // 这里用 modified 内容 open（original 是 git HEAD，tsserver 无法获取其专属 tokens）。
      const filePath = diffData.filePath;
      const hasTsserver = typeof window !== 'undefined' && !!window.electronAPI?.tsserver;

      // 强制触发 semantic tokens 重新请求：切换 semanticHighlighting.enabled 选项。
      // 仅 resetTokenization 不会触发 SemanticTokensFeature 重新调用 provider，
      // 必须切换选项让 Monaco 内部的 SemanticTokensFeature 重新调度请求。
      // provider 返回空数组（不是 null）确保 Monaco 认为该 model 支持 semantic tokens。
      const triggerSemTokensRefresh = () => {
        try {
          const origEditor = editor.getOriginalEditor();
          const modEditor = editor.getModifiedEditor();
          origEditor.updateOptions({ 'semanticHighlighting.enabled': false });
          modEditor.updateOptions({ 'semanticHighlighting.enabled': false });
          // 微任务后重新启用，触发 provider 重新调用
          requestAnimationFrame(() => {
            try {
              origEditor.updateOptions({ 'semanticHighlighting.enabled': semanticHighlightingEnabled });
              modEditor.updateOptions({ 'semanticHighlighting.enabled': semanticHighlightingEnabled });
            } catch { /* editor 可能已销毁 */ }
          });
        } catch { /* editor 可能已销毁 */ }
      };

      if (hasTsserver && isTsJs && filePath) {
        // open 是幂等的：如果主编辑器已 open 该文件，再次 open 会更新内容（无害）
        tsService.open(filePath, diffData.modified).catch(() => {});

        // 事件驱动重试：tsserver 首次 handshake 期间 semanticTokens 可能返回 null，
        // 等 tsserver 推送该文件 diagnostics（标志 program 已构建）后立即重试。
        diagUnsubRef.current = tsService.onDiagnostics((data) => {
          if ('error' in data) return;
          if (data.file === filePath) {
            // tsserver 已处理该文件 → 强制重新请求 semantic tokens
            triggerSemTokensRefresh();
          }
        });
      }

      // 注册语义高亮 provider，让方法/属性/变量/参数在 Diff 视图中也能按语义着色
      // 仅 TS/JS 系语言走 tsserver；其它语言仅靠 Monaco 内置 tokenizer
      if (isTsJs) {
        // 防止 groupId 切换或重渲染时重复注册
        semTokensDisposableRef.current?.dispose();
        semTokensDisposableRef.current = registerDiffSemanticTokensProvider(
          monaco,
          language,
          prefetchedTokensRef.current.modified,
          prefetchedTokensRef.current.original,
          groupId,
        );
      }

      // 为内部编辑器启用语义高亮
      const originalEditor = editor.getOriginalEditor();
      const modifiedEditor = editor.getModifiedEditor();
      originalEditor.updateOptions({ 'semanticHighlighting.enabled': semanticHighlightingEnabled });
      modifiedEditor.updateOptions({ 'semanticHighlighting.enabled': semanticHighlightingEnabled });

      // 确保 model language 正确（@monaco-editor/react 有时未正确设置 diff model 语言）
      const origModel = originalEditor.getModel();
      const modModel = modifiedEditor.getModel();
      if (origModel && language && origModel.getLanguageId() !== language) {
        monaco.editor.setModelLanguage(origModel, language);
      }
      if (modModel && language && modModel.getLanguageId() !== language) {
        monaco.editor.setModelLanguage(modModel, language);
      }

      // 延迟触发 semantic tokens 重新请求：给 provider 注册 + tsserver open 一点时间
      if (semanticHighlightingEnabled) {
        // 首次尝试：100ms 后（provider 已注册，tsserver 可能已加载该文件）
        setTimeout(() => triggerSemTokensRefresh(), 100);
        // 二次重试：1s 后（tsserver 冷启动时首次可能返回空，1s 后通常已就绪）
        setTimeout(() => triggerSemTokensRefresh(), 1000);
        // 兜底重试：3s 后（大型项目 tsserver 首次 program 构建可能较慢）
        setTimeout(() => triggerSemTokensRefresh(), 3000);
      }

      // 监听 diff 计算完成事件，更新导航索引
      editor.onDidUpdateDiff(() => {
        const changes = editor.getLineChanges();
        if (changes) {
          setLineChanges(changes);
          if (changes.length > 0) {
            setCurrentDiffIndex((prev) => (prev < 0 ? 0 : Math.min(prev, changes.length - 1)));
          } else {
            setCurrentDiffIndex(-1);
          }
        }
      });
    },
    [diffData.language, diffData.filePath, diffData.modified, semanticHighlightingEnabled, groupId],
  );

  /* ── 语义高亮开关变化时同步更新内部编辑器 ── */
  useEffect(() => {
    const editor = diffEditorRef.current;
    if (!editor) return;
    const originalEditor = editor.getOriginalEditor();
    const modifiedEditor = editor.getModifiedEditor();
    originalEditor.updateOptions({ 'semanticHighlighting.enabled': semanticHighlightingEnabled });
    modifiedEditor.updateOptions({ 'semanticHighlighting.enabled': semanticHighlightingEnabled });
    // 延迟触发一次 tokenization 刷新，使语义高亮生效
    if (semanticHighlightingEnabled) {
      setTimeout(() => {
        const origModel = originalEditor.getModel();
        const modModel = modifiedEditor.getModel();
        if (origModel) {
          try {
            (origModel as unknown as { tokenization: { resetTokenization(): void } }).tokenization.resetTokenization();
          } catch { /* 忽略 */ }
        }
        if (modModel) {
          try {
            (modModel as unknown as { tokenization: { resetTokenization(): void } }).tokenization.resetTokenization();
          } catch { /* 忽略 */ }
        }
      }, 100);
    }
  }, [semanticHighlightingEnabled]);

  /* ── 卸载时清理引用 ── */
  useEffect(() => {
    return () => {
      diffEditorRef.current = null;
      monacoRef.current = null;
      semTokensDisposableRef.current?.dispose();
      semTokensDisposableRef.current = null;
      diagUnsubRef.current?.();
      diagUnsubRef.current = null;
      retryTriggerRef.current = null;
    };
  }, []);

  /* ── 跳转到差异块 ── */
  const goToDiff = useCallback(
    (direction: 'next' | 'previous') => {
      if (lineChanges.length === 0 || !diffEditorRef.current) return;

      let newIndex: number;
      if (direction === 'next') {
        newIndex = currentDiffIndex + 1;
        if (newIndex >= lineChanges.length) newIndex = 0;
      } else {
        newIndex = currentDiffIndex - 1;
        if (newIndex < 0) newIndex = lineChanges.length - 1;
      }
      setCurrentDiffIndex(newIndex);

      const change = lineChanges[newIndex];
      const targetLine = change.modifiedStartLineNumber > 0
        ? change.modifiedStartLineNumber
        : change.modifiedEndLineNumber;
      diffEditorRef.current.getModifiedEditor().revealLineInCenter(targetLine);
    },
    [lineChanges, currentDiffIndex],
  );

  /* ── 工具方法 ── */

  const replaceRightWithLeft = useCallback(() => {
    dispatch(updateDiffView({ ...diffData, modified: diffData.original }));
  }, [dispatch, diffData]);

  const replaceLeftWithRight = useCallback(() => {
    dispatch(updateDiffView({ ...diffData, original: diffData.modified }));
  }, [dispatch, diffData]);

  return (
    <div className="diff-panel">
      {/* 内联工具栏（不显示文件名，Tab 栏已显示） */}
      <div className="diff-panel__toolbar">
        <div className="diff-panel__stats">
          <span className="diff-stat diff-stat--added">+{stats.added}</span>
          <span className="diff-stat diff-stat--deleted">-{stats.deleted}</span>
        </div>

        <div className="diff-panel__tools">
          <button className="diff-panel__tool" onClick={replaceRightWithLeft} title={t('diffEditorPanel.replaceRight')}>
            <ArrowLeftRight size={14} strokeWidth={1.5} />
          </button>
          <button className="diff-panel__tool" onClick={replaceLeftWithRight} title={t('diffEditorPanel.replaceLeft')}>
            <ArrowRightLeft size={14} strokeWidth={1.5} />
          </button>

          <span className="diff-panel__sep" />

          <button className="diff-panel__tool" onClick={() => goToDiff('previous')} title={t('diffEditorPanel.prevChange')}>
            <ArrowUp size={14} strokeWidth={1.5} />
          </button>
          <button className="diff-panel__tool" onClick={() => goToDiff('next')} title={t('diffEditorPanel.nextChange')}>
            <ArrowDown size={14} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      <div className="diff-panel__editor">
        {!tokensReady ? (
          <div className="diff-panel__loading">
            <RefreshCw size={20} className="diff-panel__spin" />
            <span>正在读取文件内容</span>
          </div>
        ) : (
        <DiffEditor
          key={diffEditorKey}
          original={diffData.original}
          modified={diffData.modified}
          language={diffData.language}
          originalLanguage={diffData.language}
          modifiedLanguage={diffData.language}
          originalModelPath={`gitdiff-original://${modelPathPrefix}${diffData.filePath}`}
          modifiedModelPath={`gitdiff-modified://${modelPathPrefix}${diffData.filePath}`}
          keepCurrentOriginalModel={true}
          keepCurrentModifiedModel={true}
          height="100%"
          width="100%"
          loading=""
          theme={toMonacoTheme(theme)}
          beforeMount={beforeMount}
          onMount={handleDiffEditorMount}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 13,
            lineNumbers: 'on',
            renderSideBySide: true,
            renderValidationDecorations: 'off' as const,
            originalEditable: false,
            enableSplitViewResizing: true,
            renderOverviewRuler: true,
            diffWordWrap: 'off' as const,
            // @ts-expect-error Monaco 类型未声明 semanticHighlighting.enabled，但运行时支持
            'semanticHighlighting.enabled': semanticHighlightingEnabled,
          }}
        />
        )}
      </div>
    </div>
  );
};

export default DiffEditorPanel;
