import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Search, FileText, Settings } from 'lucide-react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { openFile, expandToFile } from '../../store/slices/workspaceSlice';
import { quickOpenFiles } from '../../services/searchService';
import type { QuickOpenItem } from '../../services/searchService';
import type { FileEntry } from '../../services/fileService';
import './QuickOpen.css';

const DEFAULT_EXCLUDES = 'node_modules, .git, dist, build';

function parseExcludeDirs(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 解析查询字符串，支持路径前缀过滤：
 * - "index" → 全局搜索 index
 * - "src/index" → 只在 src 目录下搜索 index
 */
function parseQuery(raw: string): { prefix: string; query: string } {
  const trimmed = raw.trim();
  const lastSlash = trimmed.lastIndexOf('/');
  if (lastSlash > 0) {
    return { prefix: trimmed.slice(0, lastSlash + 1), query: trimmed.slice(lastSlash + 1) };
  }
  return { prefix: '', query: trimmed };
}

interface QuickOpenProps {
  onClose: () => void;
  files?: string[];
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
const QuickOpen = ({ onClose, files }: QuickOpenProps) => {
  const dispatch = useAppDispatch();
  const { allFilePaths: storeAllFilePaths, rootSource } = useAppSelector((state) => state.workspace);
  const allFilePaths = files ?? storeAllFilePaths;
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [excludeDirsRaw, setExcludeDirsRaw] = useState(DEFAULT_EXCLUDES);
  const inputRef = useRef<HTMLInputElement>(null);

  const excludeDirs = useMemo(() => parseExcludeDirs(excludeDirsRaw), [excludeDirsRaw]);

  const { prefix, query: searchQuery } = parseQuery(query);

  // 先按排除目录和路径前缀过滤，再执行模糊搜索
  const filteredFiles = useMemo(() => {
    let files = allFilePaths;

    // 排除目录
    if (excludeDirs.length > 0) {
      files = files.filter((path) => {
        const parts = path.split('/');
        return !excludeDirs.some((dir) => parts.includes(dir));
      });
    }

    // 路径前缀过滤
    if (prefix) {
      files = files.filter((path) => path.startsWith(prefix));
    }

    return files;
  }, [allFilePaths, excludeDirs, prefix]);

  // 执行模糊搜索
  const results = useMemo(() => {
    return quickOpenFiles(searchQuery, filteredFiles);
  }, [searchQuery, filteredFiles]);

  // 重置选中位置
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // 自动聚焦输入框
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 使用 ref 存储最新值，避免键盘事件 effect 因结果变化而频繁重建
  const resultsRef = useRef(results);
  const selectedIndexRef = useRef(selectedIndex);
  resultsRef.current = results;
  selectedIndexRef.current = selectedIndex;

  // ESC 关闭 / 上下选择 / Enter 打开
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, resultsRef.current.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const item = resultsRef.current[selectedIndexRef.current];
        if (item) {
          handleSelect(item);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleSelect = useCallback(
    (item: QuickOpenItem) => {
      // 构造完整文件路径 source
      let source: string | FileSystemHandle = item.path;
      if (rootSource && typeof rootSource === 'string') {
        source = rootSource + '/' + item.path;
      }
      const entry: FileEntry = {
        name: item.name,
        kind: 'file',
        source,
      };
      dispatch(openFile(entry));
      // 触发资源管理器展开到该文件所在目录
      dispatch(expandToFile(item.path));
      onClose();
    },
    [dispatch, onClose, rootSource]
  );

  return (
    <div className="quick-open-overlay" onClick={onClose}>
      <div className="quick-open-panel" onClick={(e) => e.stopPropagation()}>
        <div className="quick-open-input-wrap">
          <Search size={18} strokeWidth={1.5} />
          <input
            ref={inputRef}
            className="quick-open-input"
            placeholder={prefix ? `在 ${prefix} 中搜索文件...` : '输入文件名（支持模糊匹配，如 apptsx → App.tsx）'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            className={`quick-open-settings-btn ${showSettings ? 'active' : ''}`}
            title="过滤设置"
            onClick={() => setShowSettings((v) => !v)}
          >
            <Settings size={14} strokeWidth={1.5} />
          </button>
        </div>

        {showSettings && (
          <div className="quick-open-settings">
            <div className="quick-open-settings__row">
              <label>排除目录</label>
              <input
                type="text"
                value={excludeDirsRaw}
                onChange={(e) => setExcludeDirsRaw(e.target.value)}
                placeholder="例如: node_modules, .git, dist"
              />
            </div>
          </div>
        )}

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
                  <FilePathHighlight path={item.path} highlights={item.highlights} />
                </div>
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
 * 路径高亮：将路径拆分为文件名（带高亮）和目录前缀（灰色）
 * 显示顺序：文件名 + 目录前缀
 */
const FilePathHighlight = ({
  path,
  highlights,
}: {
  path: string;
  highlights: boolean[];
}) => {
  const lastSlash = path.lastIndexOf('/');
  const dirPath = lastSlash >= 0 ? path.substring(0, lastSlash + 1) : '';
  const fileStart = lastSlash >= 0 ? lastSlash + 1 : 0;

  const fileElements: JSX.Element[] = [];
  let lastIndex = fileStart;

  for (let i = fileStart; i < path.length && i < highlights.length; i++) {
    if (highlights[i]) {
      if (i > lastIndex) {
        fileElements.push(
          <span key={`plain-${i}`}>{path.substring(lastIndex, i)}</span>
        );
      }
      fileElements.push(<mark key={`match-${i}`}>{path[i]}</mark>);
      lastIndex = i + 1;
    }
  }

  if (lastIndex < path.length) {
    fileElements.push(
      <span key="plain-end">{path.substring(lastIndex)}</span>
    );
  }

  return (
    <span className="quick-open-item__line">
      <span className="quick-open-item__file">{fileElements}</span>
      {dirPath && (
        <>
          &nbsp;
          <span className="quick-open-item__dir">{dirPath}</span>
        </>
      )}
    </span>
  );
};

export default QuickOpen;
