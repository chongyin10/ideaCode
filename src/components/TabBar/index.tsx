import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Columns2, Loader2 } from 'lucide-react';
import './TabBar.css';

interface TabBarProps {
  tabs: { id: string; name: string; isDirty?: boolean; isPreview?: boolean; gitStatus?: string }[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onPin?: (id: string) => void;
  onSplitView?: () => void;
  onContextMenu?: (e: React.MouseEvent, id: string) => void;
  /** 拖拽重排：将 fromId 移动到 toId 的 before/after 位置 */
  onReorder?: (fromId: string, toId: string, position: 'before' | 'after') => void;
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

const TabBar = ({ tabs, activeId, onActivate, onClose, onPin, onSplitView, onContextMenu, onReorder, splitActive, focused = true, loadingFiles, missingFileIds }: TabBarProps) => {
  const { t } = useTranslation();
  const [displayTabs, setDisplayTabs] = useState<DisplayTab[]>([]);
  const prevTabsRef = useRef(tabs);

  // ── 拖拽状态 ──
  /** 正在被拖拽的 tab id */
  const [draggingId, setDraggingId] = useState<string | null>(null);
  /** 拖拽悬停的目标 tab id（用于显示插入指示线） */
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  /** 拖拽悬停的方向：'left' | 'right'，指示线显示在目标 tab 的左/右侧 */
  const [dragOverPos, setDragOverPos] = useState<'left' | 'right'>('right');
  /** ref 存储最新 draggingId，供 dragend 时判断是否需要清理 */
  const draggingIdRef = useRef<string | null>(null);
  draggingIdRef.current = draggingId;

  useEffect(() => {
    const prevTabs = prevTabsRef.current;
    const nextIds = new Set(tabs.map((t) => t.id));
    const prevIds = new Set(prevTabs.map((t) => t.id));

    // 检测"预览替换"场景：旧 Tab 是预览态，被新 Tab 替换在同一位置
    // 这种情况下直接切换，不播放退出/进入动画，避免"幻影"效果
    const replacedPreviewIds = new Set<string>();
    for (const prevTab of prevTabs) {
      if (prevTab.isPreview && !nextIds.has(prevTab.id)) {
        // 旧 Tab 是预览态且被移除，检查是否有新 Tab 在同一位置
        const prevIdx = prevTabs.findIndex((t) => t.id === prevTab.id);
        const newTabAtSamePos = tabs[prevIdx];
        if (newTabAtSamePos && newTabAtSamePos.isPreview && !prevIds.has(newTabAtSamePos.id)) {
          replacedPreviewIds.add(prevTab.id);
        }
      }
    }

    setDisplayTabs((current) => {
      const next: DisplayTab[] = [];

      // 保留/新增当前仍应显示的 tab
      for (const tab of tabs) {
        const existing = current.find((t) => t.id === tab.id);
        if (existing) {
          // 已存在：同步数据；如果它之前正在退出，恢复为稳定态
          next.push({ ...tab, phase: existing.phase === 'exiting' ? 'stable' : existing.phase });
        } else {
          // 新增：如果是预览替换场景，直接标记为 stable（无动画）
          const isPreviewReplace = prevTabs.some((pt) => replacedPreviewIds.has(pt.id));
          next.push({ ...tab, phase: isPreviewReplace ? 'stable' : 'entering' });
        }
      }

      // 对正在移除的 tab 保留其 exiting 状态，以播放退出动画
      // 但预览替换场景下的旧 tab 直接跳过（不显示退出动画）
      for (const tab of current) {
        if (!nextIds.has(tab.id) && !replacedPreviewIds.has(tab.id) && tab.phase !== 'exiting') {
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

  // ── 拖拽事件处理 ──

  const handleDragStart = (e: React.DragEvent, tabId: string) => {
    if (!onReorder) return;
    setDraggingId(tabId);
    draggingIdRef.current = tabId;
    e.dataTransfer.effectAllowed = 'move';
    // 设置透明拖拽图像（用默认即可，这里只需标记数据）
    e.dataTransfer.setData('text/plain', tabId);
  };

  const handleDragOver = (e: React.DragEvent, tabId: string) => {
    if (!onReorder || !draggingIdRef.current || draggingIdRef.current === tabId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    // 根据鼠标在 tab 上的位置决定插入方向（左半边→插左边，右半边→插右边）
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    setDragOverId(tabId);
    setDragOverPos(e.clientX < midX ? 'left' : 'right');
  };

  const handleDragLeave = (tabId: string) => {
    if (dragOverId === tabId) {
      setDragOverId(null);
    }
  };

  const handleDrop = (e: React.DragEvent, tabId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!onReorder || !draggingIdRef.current) return;
    const fromId = draggingIdRef.current;
    if (fromId !== tabId) {
      // 直接传递位置语义：left → 插入到 tabId 之前，right → 插入到 tabId 之后
      onReorder(fromId, tabId, dragOverPos === 'right' ? 'after' : 'before');
    }
    // 清理状态
    setDraggingId(null);
    setDragOverId(null);
    draggingIdRef.current = null;
  };

  const handleDragEnd = () => {
    setDraggingId(null);
    setDragOverId(null);
    draggingIdRef.current = null;
  };

  return (
    <div className="tab-bar">
      <div className="tab-bar__tabs">
        {displayTabs.map((tab) => {
          const isDragging = draggingId === tab.id;
          const isDragOver = dragOverId === tab.id;
          return (
            <div
              key={tab.id}
              className={`tab-bar__item tab-bar__item--${tab.phase} ${focused && activeId === tab.id ? 'active' : ''} ${tab.isPreview ? 'preview' : ''} ${missingFileIds?.has(tab.id) ? 'deleted' : ''} ${isDragging ? 'tab-bar__item--dragging' : ''} ${isDragOver ? `tab-bar__item--drag-over tab-bar__item--drag-${dragOverPos}` : ''}`}
              draggable={!!onReorder}
              onDragStart={(e) => handleDragStart(e, tab.id)}
              onDragOver={(e) => handleDragOver(e, tab.id)}
              onDragLeave={() => handleDragLeave(tab.id)}
              onDrop={(e) => handleDrop(e, tab.id)}
              onDragEnd={handleDragEnd}
              onClick={() => onActivate(tab.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                onContextMenu?.(e, tab.id);
              }}
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
          );
        })}
      </div>
      {onSplitView && focused && (
        <div className={`tab-bar__actions ${splitActive ? 'split-active' : ''}`}>
          <button
            className="tab-bar__action-btn"
            onClick={onSplitView}
            title={t('tabBar.splitViewTooltip')}
          >
            <Columns2 size={14} strokeWidth={1.5} />
          </button>
        </div>
      )}
    </div>
  );
};

export default TabBar;
