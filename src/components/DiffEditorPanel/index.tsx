import { useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { DiffEditor } from '@monaco-editor/react';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { closeDiffView, updateDiffView } from '../../store/slices/workspaceSlice';
import {
  X, ArrowLeftRight, ArrowUp, ArrowDown, ArrowRightLeft,
} from 'lucide-react';
import type * as Monaco from 'monaco-editor';
import { beforeMount } from '../MonacoEditor/index';
import { ensureLanguage } from '../../services/languageLoader';
import './DiffEditorPanel.css';

const DiffEditorPanel = () => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const diffView = useAppSelector((s) => s.workspace.diffView);
  const editorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);

  const handleMount = useCallback(
    (editor: Monaco.editor.IStandaloneDiffEditor, monaco: typeof Monaco) => {
      editorRef.current = editor;
      monacoRef.current = monaco;

      const language = diffView?.language;
      if (!language) return;

      // 按需加载语言语法 contribution（非内置语言如 css/html/json/python 等需要加载）
      // TypeScript/Javascript 已在 main.tsx 预注册；这里也调用一次确保就绪。
      ensureLanguage(language).then(() => {
        const ed = editorRef.current;
        const mc = monacoRef.current;
        if (!ed || !mc) return;

        // 确保 original / modified 两个 model 的语言正确，并强制刷新 tokenization，
        // 解决首次打开时 worker 尚未就绪导致无高亮的问题。
        const originalModel = ed.getOriginalEditor().getModel();
        const modifiedModel = ed.getModifiedEditor().getModel();

        const forceTokenization = (model: Monaco.editor.ITextModel | null) => {
          if (!model) return;
          if (model.getLanguageId() !== language) {
            mc.editor.setModelLanguage(model, language);
          }
          try {
            (model as unknown as { tokenization: { resetTokenization(): void } }).tokenization.resetTokenization();
          } catch { /* 忽略 */ }
        };

        forceTokenization(originalModel);
        forceTokenization(modifiedModel);

        // 200ms 后重试一次，确保 worker 已就绪后重新 tokenize
        setTimeout(() => {
          const ed2 = editorRef.current;
          if (!ed2) return;
          forceTokenization(ed2.getOriginalEditor().getModel());
          forceTokenization(ed2.getModifiedEditor().getModel());
        }, 200);
      }).catch(() => {});
    },
    [diffView]
  );

  /* ── 工具方法 ── */

  /** 通过 editor.setModel 直接更新内容，避免 key remount 导致的模型释放竞态 */
  const updateModels = useCallback(
    (original: string, modified: string) => {
      const editor = editorRef.current;
      const monaco = monacoRef.current;
      if (!editor || !monaco || !diffView) return;
      editor.setModel({
        original: monaco.editor.createModel(original, diffView.language, monaco.Uri.parse(`gitdiff-original://${diffView.filePath}`)),
        modified: monaco.editor.createModel(modified, diffView.language, monaco.Uri.parse(`gitdiff-modified://${diffView.filePath}`)),
      });
    },
    [diffView]
  );

  /** 把左边(原始)的全部内容拷贝到右边(修改) */
  const replaceRightWithLeft = useCallback(() => {
    if (!diffView) return;
    dispatch(updateDiffView({ ...diffView, modified: diffView.original }));
    updateModels(diffView.original, diffView.original);
  }, [dispatch, diffView, updateModels]);

  /** 把右边(修改)的全部内容拷贝到左边(原始) */
  const replaceLeftWithRight = useCallback(() => {
    if (!diffView) return;
    dispatch(updateDiffView({ ...diffView, original: diffView.modified }));
    updateModels(diffView.modified, diffView.modified);
  }, [dispatch, diffView, updateModels]);

  /** 跳转到下一个差异块 */
  const goToNextDiff = useCallback(() => {
    editorRef.current?.goToDiff('next');
  }, []);

  /** 跳转到上一个差异块 */
  const goToPrevDiff = useCallback(() => {
    editorRef.current?.goToDiff('previous');
  }, []);

  if (!diffView) return null;

  return (
    <div className="diff-panel">
      <div className="diff-panel__header">
        <span className="diff-panel__title">
          {t('diffEditorPanel.compareTitle', { fileName: diffView.fileName })}
        </span>

        <div className="diff-panel__tools">
          <button className="diff-panel__tool" onClick={replaceRightWithLeft} title={t('diffEditorPanel.replaceRight')}>
            <ArrowLeftRight size={14} strokeWidth={1.5} />
          </button>
          <button className="diff-panel__tool" onClick={replaceLeftWithRight} title={t('diffEditorPanel.replaceLeft')}>
            <ArrowRightLeft size={14} strokeWidth={1.5} />
          </button>

          <span className="diff-panel__sep" />

          <button className="diff-panel__tool" onClick={goToPrevDiff} title={t('diffEditorPanel.prevChange')}>
            <ArrowUp size={14} strokeWidth={1.5} />
          </button>
          <button className="diff-panel__tool" onClick={goToNextDiff} title={t('diffEditorPanel.nextChange')}>
            <ArrowDown size={14} strokeWidth={1.5} />
          </button>
        </div>

        <button
          className="diff-panel__close"
          onClick={() => dispatch(closeDiffView())}
          title={t('diffEditorPanel.close')}
        >
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>

      <div className="diff-panel__editor">
        <DiffEditor
          height="100%"
          language={diffView.language}
          original={diffView.original}
          modified={diffView.modified}
          originalModelPath={`gitdiff-original://${diffView.filePath}`}
          modifiedModelPath={`gitdiff-modified://${diffView.filePath}`}
          theme="ideacode-dark"
          beforeMount={beforeMount}
          onMount={handleMount}
          options={{
            readOnly: true,
            renderSideBySide: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 13,
          }}
        />
      </div>
    </div>
  );
};

export default DiffEditorPanel;
