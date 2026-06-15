import { useState, useEffect, useRef } from 'react';
import { X, Columns2, Loader2 } from 'lucide-react';
import './TabBar.css';

interface TabBarProps {
  tabs: { id: string; name: string; isDirty?: boolean; isPreview?: boolean; gitStatus?: string }[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onPin?: (id: string) => void;
  onSplitView?: () => void;
  splitActive?: boolean;
  focused?: boolean;
  /** 正在加载中的文件 ID 集合 */
  loadingFiles?: Set<string>;
  /** 已不存在/被删除的打开文件 ID 集合 */
  missingFileIds?: Set<string>;
}

type TabPhase = 'entering' | 'stable' | 'exiting';

type DisplayTab = TabBarProps['tabs'][number] & { phase: TabPhase };

const TRANSITION_MS = 200;

const TabBar = ({ tabs, activeId, onActivate, onClose, onPin, onSplitView, splitActive, focused = true, loadingFiles, missingFileIds }: TabBarProps) => {
  const [displayTabs, setDisplayTabs] = useState<DisplayTab[]>([]);
  const prevTabsRef = useRef(tabs);

  useEffect(() => {
    const nextIds = new Set(tabs.map((t) => t.id));

    setDisplayTabs((current) => {
      const next: DisplayTab[] = [];

      // 保留/新增当前仍应显示的 tab
      for (const tab of tabs) {
        const existing = current.find((t) => t.id === tab.id);
        if (existing) {
          // 已存在：同步数据；如果它之前正在退出，恢复为稳定态
          next.push({ ...tab, phase: existing.phase === 'exiting' ? 'stable' : existing.phase });
        } else {
          // 新增：标记为进入动画
          next.push({ ...tab, phase: 'entering' });
        }
      }

      // 对正在移除的 tab 保留其 exiting 状态，以播放退出动画
      for (const tab of current) {
        if (!nextIds.has(tab.id) && tab.phase !== 'exiting') {
          next.push({ ...tab, phase: 'exiting' });
        }
      }

      return next;
    });

    const timer = setTimeout(() => {
      setDisplayTabs((current) =>
        current
          .filter((t) => t.phase !== 'exiting')
          .map((t) => (t.phase === 'entering' ? { ...t, phase: 'stable' as TabPhase } : t))
      );
    }, TRANSITION_MS);

    prevTabsRef.current = tabs;
    return () => clearTimeout(timer);
  }, [tabs]);

  if (displayTabs.length === 0) return null;

  return (
    <div className="tab-bar">
      <div className="tab-bar__tabs">
        {displayTabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab-bar__item tab-bar__item--${tab.phase} ${focused && activeId === tab.id ? 'active' : ''} ${tab.isPreview ? 'preview' : ''} ${missingFileIds?.has(tab.id) ? 'deleted' : ''}`}
            onClick={() => onActivate(tab.id)}
            onDoubleClick={() => {
              if (tab.isPreview) {
                onPin?.(tab.id);
              }
            }}
          >
            <span className={`tab-bar__name ${tab.isDirty ? 'dirty' : ''} ${tab.gitStatus ? 'git-' + tab.gitStatus.toLowerCase() : ''}`}>{tab.name}</span>
            {tab.isDirty && <span className="tab-bar__dirty">●</span>}
            {loadingFiles?.has(tab.id) && <Loader2 size={12} strokeWidth={1.5} className="tab-bar__loading tab-bar__spinner" />}
            <span
              className="tab-bar__close"
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
            >
              <X size={14} strokeWidth={1.5} />
            </span>
          </div>
        ))}
      </div>
      {onSplitView && focused && (
        <div className={`tab-bar__actions ${splitActive ? 'split-active' : ''}`}>
          <button
            className="tab-bar__action-btn"
            onClick={onSplitView}
            title="分屏编辑"
          >
            <Columns2 size={14} strokeWidth={1.5} />
          </button>
        </div>
      )}
    </div>
  );
};

export default TabBar;
