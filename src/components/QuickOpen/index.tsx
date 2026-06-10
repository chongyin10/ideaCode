import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Search, FileText } from 'lucide-react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { openFile } from '../../store/slices/workspaceSlice';
import { quickOpenFiles } from '../../services/searchService';
import type { QuickOpenItem } from '../../services/searchService';
import type { FileEntry } from '../../services/fileService';
import './QuickOpen.css';

interface QuickOpenProps {
  onClose: () => void;
}

/**
 * QuickOpen 命令面板
 * 
 * 使用 Fuzzy Search 算法实现文件快速定位：
 * - 输入 "apptsx" → 匹配 "src/App.tsx"
 * - 输入 "idx" → 匹配 "src/components/index.tsx"
 * 
 * 算法核心：动态规划计算最优匹配得分，支持不连续字符匹配
 * 时间复杂度：O(m × n)，m=输入长度, n=文件路径长度
 */
const QuickOpen = ({ onClose }: QuickOpenProps) => {
  const dispatch = useAppDispatch();
  const { entries } = useAppSelector((state) => state.workspace);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // 收集所有文件路径
  const allFiles = useMemo(() => {
    const files: string[] = [];
    const collect = (items: FileEntry[], prefix = '') => {
      for (const item of items) {
        const path = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.kind === 'file') {
          files.push(path);
        }
        // 注意：当前 entries 是一级列表，子目录通过 FileTree 懒加载
        // 实际使用时应从 Redux store 中获取完整的展平路径列表
      }
    };
    collect(entries);
    return files;
  }, [entries]);

  // 执行模糊搜索
  const results = useMemo(() => {
    return quickOpenFiles(query, allFiles);
  }, [query, allFiles]);

  // 重置选中位置
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // 自动聚焦输入框
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // ESC 关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const item = results[selectedIndex];
        if (item) {
          handleSelect(item);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [results, selectedIndex, onClose]);

  const handleSelect = useCallback(
    (item: QuickOpenItem) => {
      // 构造 FileEntry 并打开
      const entry: FileEntry = {
        name: item.name,
        kind: 'file',
        source: item.path,
      };
      dispatch(openFile(entry));
      onClose();
    },
    [dispatch, onClose]
  );

  return (
    <div className="quick-open-overlay" onClick={onClose}>
      <div className="quick-open-panel" onClick={(e) => e.stopPropagation()}>
        <div className="quick-open-input-wrap">
          <Search size={18} strokeWidth={1.5} />
          <input
            ref={inputRef}
            className="quick-open-input"
            placeholder="输入文件名（支持模糊匹配，如 apptsx → App.tsx）"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="quick-open-list">
          {results.length === 0 ? (
            <div className="quick-open-empty">
              {query ? '未找到匹配的文件' : '开始输入以搜索文件'}
            </div>
          ) : (
            results.map((item, index) => (
              <div
                key={item.path}
                className={`quick-open-item ${index === selectedIndex ? 'selected' : ''}`}
                onClick={() => handleSelect(item)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <span className="quick-open-item__icon">
                  <FileText size={16} strokeWidth={1.5} />
                </span>
                <div className="quick-open-item__info">
                  <div className="quick-open-item__name">
                    <HighlightMatches text={item.path} matches={item.highlights} />
                  </div>
                  <div className="quick-open-item__path">{item.path}</div>
                </div>
                <span className="quick-open-score">
                  {item.score > 0 ? `score: ${Math.round(item.score)}` : ''}
                </span>
              </div>
            ))
          )}
        </div>

        <div className="quick-open-footer">
          <span>{results.length} 个结果</span>
          <span>↑↓ 选择 · Enter 打开 · Esc 关闭</span>
        </div>
      </div>
    </div>
  );
};

/**
 * 高亮匹配字符
 */
const HighlightMatches = ({
  text,
  matches,
}: {
  text: string;
  matches: boolean[];
}) => {
  const elements: JSX.Element[] = [];
  let lastIndex = 0;

  for (let i = 0; i < matches.length; i++) {
    if (matches[i]) {
      if (i > lastIndex) {
        elements.push(
          <span key={`plain-${i}`}>{text.substring(lastIndex, i)}</span>
        );
      }
      elements.push(<mark key={`match-${i}`}>{text[i]}</mark>);
      lastIndex = i + 1;
    }
  }

  if (lastIndex < text.length) {
    elements.push(
      <span key="plain-end">{text.substring(lastIndex)}</span>
    );
  }

  return <>{elements}</>;
};

export default QuickOpen;
