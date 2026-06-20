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
  ArrowLeftRight, ArrowUp, ArrowDown, ArrowRightLeft,
} from 'lucide-react';
import type * as Monaco from 'monaco-editor';
import { DiffEditor } from '@monaco-editor/react';
import { beforeMount, toMonacoTheme } from '../MonacoEditor/index';
import { ensureLanguage } from '../../services/languageLoader';
import { computeLineDiff } from '../../services/diffAlgorithm';
import './DiffEditorPanel.css';

/* ─── Props ─── */

interface DiffEditorPanelProps {
  diffData: DiffView;
}

/* ─── 组件 ─── */

const DiffEditorPanel = ({ diffData }: DiffEditorPanelProps) => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const theme = useAppSelector((s) => s.settings.theme);
  const semanticHighlightingEnabled = useAppSelector((s) => s.settings.semanticHighlightingEnabled);

  const diffEditorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const [currentDiffIndex, setCurrentDiffIndex] = useState(-1);
  const [lineChanges, setLineChanges] = useState<Monaco.editor.ILineChange[]>([]);

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

      // 为内部编辑器启用语义高亮
      // 注意：不手动调用 resetTokenization()，避免高亮闪动。
      // Monaco 检测到 semanticHighlighting.enabled 变化后会自动调度语义 tokens 请求。
      const originalEditor = editor.getOriginalEditor();
      const modifiedEditor = editor.getModifiedEditor();
      originalEditor.updateOptions({ 'semanticHighlighting.enabled': semanticHighlightingEnabled });
      modifiedEditor.updateOptions({ 'semanticHighlighting.enabled': semanticHighlightingEnabled });

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
    [diffData.language, semanticHighlightingEnabled],
  );

  /* ── 语义高亮开关变化时同步更新内部编辑器 ── */
  useEffect(() => {
    const editor = diffEditorRef.current;
    if (!editor) return;
    editor.getOriginalEditor().updateOptions({ 'semanticHighlighting.enabled': semanticHighlightingEnabled });
    editor.getModifiedEditor().updateOptions({ 'semanticHighlighting.enabled': semanticHighlightingEnabled });
    // 不手动 resetTokenization：Monaco 检测到选项变化后会自动调度语义 tokens 刷新，
    // 手动调用反而会导致高亮闪动（先变白再重新上色）。
  }, [semanticHighlightingEnabled]);

  /* ── 卸载时清理引用 ── */
  useEffect(() => {
    return () => {
      diffEditorRef.current = null;
      monacoRef.current = null;
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

  // key 包含内容和语言，确保任何变化时重新挂载 DiffEditor
  const diffEditorKey = `${diffData.filePath}-${diffData.language}-${diffData.original.length}-${diffData.modified.length}`;

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
        <DiffEditor
          key={diffEditorKey}
          original={diffData.original}
          modified={diffData.modified}
          language={diffData.language}
          originalLanguage={diffData.language}
          modifiedLanguage={diffData.language}
          originalModelPath={`gitdiff-original://${diffData.filePath}`}
          modifiedModelPath={`gitdiff-modified://${diffData.filePath}`}
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
            'semanticHighlighting.enabled': semanticHighlightingEnabled,
          }}
        />
      </div>
    </div>
  );
};

export default DiffEditorPanel;
