import { useState, useRef, useEffect } from 'react';
import { Search, Clock } from 'lucide-react';
import './RightPanel.css';

interface HistoryItem {
  id: string;
  title: string;
  preview: string;
  time: string;
}

const MOCK_HISTORY: HistoryItem[] = [
  { id: '1', title: '优化当前 UI 风格', preview: '保持和如图2中的界面风格，比如输入、输出、Input输入框...', time: '1m ago' },
  { id: '2', title: '代码没有高亮', preview: '如图1中，代码没有高亮，在正常的打开模式中，如图2代码是高亮的', time: '5h ago' },
  { id: '3', title: 'KILO CODE 调研', preview: '调研下，在当前的IDE工程中，若是开发类似于一个 KILO CODE 这样的AI代码辅助工具...', time: '9h ago' },
  { id: '4', title: '资源管理器右键错误', preview: '资源管理器打开一个文件后，在文件代码编辑器中光标移入到代码片段后，点击右键...', time: '5d ago' },
  { id: '5', title: '你好', preview: '你好', time: '5d ago' },
];

interface HistoryPopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

export function HistoryPopover({ open, onClose, anchorRef }: HistoryPopoverProps) {
  const [query, setQuery] = useState('');
  const [rendered, setRendered] = useState(open);
  const popoverRef = useRef<HTMLDivElement>(null);

  // 控制挂载/卸载时机，配合 CSS 做进入/退出动画
  useEffect(() => {
    if (open) {
      setRendered(true);
    } else {
      const timer = setTimeout(() => setRendered(false), 150);
      return () => clearTimeout(timer);
    }
  }, [open]);

  // 打开时重置搜索
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  // 点击弹出层外部关闭
  useEffect(() => {
    if (!rendered) return;
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        popoverRef.current &&
        !popoverRef.current.contains(target) &&
        anchorRef.current &&
        !anchorRef.current.contains(target)
      ) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [rendered, onClose, anchorRef]);

  if (!rendered) return null;

  const filtered = MOCK_HISTORY.filter(
    (item) =>
      item.title.toLowerCase().includes(query.toLowerCase()) ||
      item.preview.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div
      ref={popoverRef}
      className={`right-panel__history-popover ${open ? 'right-panel__history-popover--open' : ''}`}
      onClick={(e) => {
        // 点击弹出层空白背景也关闭
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="right-panel__history-search">
        <Search size={14} strokeWidth={1.5} className="right-panel__history-search-icon" />
        <input
          type="text"
          className="right-panel__history-search-input"
          placeholder="Search conversations..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
      </div>
      <div className="right-panel__history-list">
        {filtered.length === 0 ? (
          <div className="right-panel__history-empty">No conversations found</div>
        ) : (
          filtered.map((item) => (
            <div
              key={item.id}
              className="right-panel__history-item"
              onClick={() => {
                // TODO: 加载选中的历史会话
                onClose();
              }}
            >
              <div className="right-panel__history-item-title">{item.title}</div>
              <div className="right-panel__history-item-preview">{item.preview}</div>
              <div className="right-panel__history-item-meta">
                <Clock size={12} strokeWidth={1.5} />
                <span>{item.time}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
