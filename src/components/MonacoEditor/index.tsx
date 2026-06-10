import Editor from '@monaco-editor/react';
import { useRef } from 'react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { clearSearchHighlight } from '../../store/slices/workspaceSlice';
import './MonacoEditor.css';

const Loading = () => (
  <div className="monaco-loading">
    <div className="monaco-loading__spinner" />
    <span className="monaco-loading__text">正在加载编辑器...</span>
  </div>
);

interface MonacoEditorProps {
  value: string;
  language: string;
  onChange?: (value: string) => void;
}

const MonacoEditor = ({ value, language, onChange }: MonacoEditorProps) => {
  const dispatch = useAppDispatch();
  const searchHighlight = useAppSelector((state) => state.workspace.searchHighlight);
  const decorationsRef = useRef<string[]>([]);

  return (
    <Editor
      height="100%"
      width="100%"
      language={language}
      value={value}
      onChange={(v) => onChange?.(v || '')}
      theme="vs-dark"
      loading={<Loading />}
      onMount={(editor, monaco) => {
        // 挂载后强制刷新一次布局，确保 Minimap 等内部组件坐标计算正确
        requestAnimationFrame(() => editor.layout());

        // 如果有搜索高亮，应用装饰并跳转
        if (searchHighlight) {
          const { keyword, line, column } = searchHighlight;

          // 1. 跳转到匹配位置（居中显示）
          if (line > 0) {
            editor.setPosition({ lineNumber: line, column });
            editor.revealLineInCenter(line);
          }

          // 2. 使用 deltaDecorations 高亮所有匹配
          const model = editor.getModel();
          if (model && keyword) {
            // 清除旧装饰
            if (decorationsRef.current.length > 0) {
              editor.deltaDecorations(decorationsRef.current, []);
            }

            // 查找所有匹配（不区分大小写高亮时，忽略大小写）
            const matches = model.findMatches(
              keyword,
              false,  // searchOnlyEditableRange
              false,  // isRegex
              false,  // matchCase
              null,   // wordSeparators
              true    // captureMatches
            );

            const newDecorations = matches.map((m) => ({
              range: m.range,
              options: {
                inlineClassName: 'search-highlight-match',
                overviewRuler: {
                  color: '#ea5c1b',
                  position: monaco.editor.OverviewRulerLane.Center,
                },
                minimap: {
                  color: '#ea5c1b',
                  position: monaco.editor.MinimapPosition.Inline,
                },
              },
            }));

            decorationsRef.current = editor.deltaDecorations([], newDecorations);
          }

          // 3. 消费后清除高亮状态
          dispatch(clearSearchHighlight());
        }
      }}
      options={{
        minimap: { enabled: true, showSlider: 'always' },
        fontSize: 14,
        wordWrap: 'on',
        automaticLayout: true,
        scrollBeyondLastLine: false,
        smoothScrolling: true,
      }}
    />
  );
};

export default MonacoEditor;
