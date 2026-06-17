import { useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { DiffEditor } from '@monaco-editor/react';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { closeDiffView, updateDiffView } from '../../store/slices/workspaceSlice';
import {
  X, ArrowLeftRight, ArrowUp, ArrowDown, ArrowRightLeft,
} from 'lucide-react';
import type * as Monaco from 'monaco-editor';
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
    },
    []
  );

  /* ── 工具方法 ── */

  /** 通过 editor.setModel 直接更新内容，避免 key remount 导致的模型释放竞态 */
  const updateModels = useCallback(
    (original: string, modified: string) => {
      const editor = editorRef.current;
      const monaco = monacoRef.current;
      if (!editor || !monaco || !diffView) return;
      editor.setModel({
        original: monaco.editor.createModel(original, diffView.language),
        modified: monaco.editor.createModel(modified, diffView.language),
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
          theme="vs-dark"
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
