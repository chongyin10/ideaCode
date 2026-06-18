import { useState, useRef } from 'react';
import { Files, Search, GitBranch, Bug, Blocks, User, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { switchPanel, reorderPanel } from '../../store/slices/layoutSlice';
import type { PanelId } from '../../store/slices/layoutSlice';
import { setSettingsVisible } from '../../store/slices/workspaceSlice';
import './ActivityBar.css';

const ActivityBar = () => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const activePanel = useAppSelector((state) => state.layout.activePanel);
  const panelOrder = useAppSelector((state) => state.layout.panelOrder);
  const gitStagedCount = Object.keys(useAppSelector((s) => s.git.staged)).length;
  const gitChangesCount = Object.keys(useAppSelector((s) => s.git.changes)).length;
  const gitMergeCount = Object.keys(useAppSelector((s) => s.git.merge)).length;
  const gitUntrackedCount = Object.keys(useAppSelector((s) => s.git.untracked)).length;
  const gitBadgeCount = gitStagedCount + gitChangesCount + gitMergeCount + gitUntrackedCount;

  const panelConfig: Record<PanelId, { icon: React.ReactNode; title: string }> = {
    explorer: { icon: <Files size={20} strokeWidth={1.5} />, title: t('activityBar.explorer') },
    search: { icon: <Search size={20} strokeWidth={1.5} />, title: t('activityBar.search') },
    git: { icon: <GitBranch size={20} strokeWidth={1.5} />, title: t('activityBar.sourceControl') },
    debug: { icon: <Bug size={20} strokeWidth={1.5} />, title: t('activityBar.runAndDebug') },
    extensions: { icon: <Blocks size={20} strokeWidth={1.5} />, title: t('activityBar.extensions') },
  };

  // 按 panelOrder 排序的面板列表
  const panels = panelOrder.map((id) => ({ id, ...panelConfig[id] }));

  const bottomItems: { icon: React.ReactNode; title: string; action?: 'settings' }[] = [
    { icon: <User size={20} strokeWidth={1.5} />, title: t('activityBar.account') },
    { icon: <Settings size={20} strokeWidth={1.5} />, title: t('activityBar.settings'), action: 'settings' },
  ];

  // ── 拖拽重排状态 ──
  const [draggingId, setDraggingId] = useState<PanelId | null>(null);
  const [dragOverId, setDragOverId] = useState<PanelId | null>(null);
  const [dragOverPos, setDragOverPos] = useState<'before' | 'after'>('after');
  const draggingIdRef = useRef<PanelId | null>(null);
  draggingIdRef.current = draggingId;

  const handleDragStart = (e: React.DragEvent, panelId: PanelId) => {
    setDraggingId(panelId);
    draggingIdRef.current = panelId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', panelId);
  };

  const handleDragOver = (e: React.DragEvent, panelId: PanelId) => {
    if (!draggingIdRef.current || draggingIdRef.current === panelId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    // 根据鼠标在图标上的位置决定插入方向（上半边→插上方，下半边→插下方）
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    setDragOverId(panelId);
    setDragOverPos(e.clientY < midY ? 'before' : 'after');
  };

  const handleDragLeave = (panelId: PanelId) => {
    if (dragOverId === panelId) setDragOverId(null);
  };

  const handleDrop = (e: React.DragEvent, panelId: PanelId) => {
    e.preventDefault();
    e.stopPropagation();
    if (!draggingIdRef.current) return;
    const fromId = draggingIdRef.current;
    if (fromId !== panelId) {
      dispatch(reorderPanel({
        fromId,
        toId: panelId,
        position: dragOverPos === 'after' ? 'after' : 'before',
      }));
    }
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
    <div className="activity-bar">
      <div className="activity-bar__top">
        {panels.map((p) => {
          const isDragging = draggingId === p.id;
          const isDragOver = dragOverId === p.id;
          return (
            <div
              key={p.id}
              className={`activity-bar__item ${activePanel === p.id ? 'active' : ''} ${isDragging ? 'activity-bar__item--dragging' : ''} ${isDragOver ? `activity-bar__item--drag-over activity-bar__item--drag-${dragOverPos}` : ''}`}
              title={p.title}
              draggable
              onDragStart={(e) => handleDragStart(e, p.id)}
              onDragOver={(e) => handleDragOver(e, p.id)}
              onDragLeave={() => handleDragLeave(p.id)}
              onDrop={(e) => handleDrop(e, p.id)}
              onDragEnd={handleDragEnd}
              onClick={() => dispatch(switchPanel(p.id))}
            >
              {p.icon}
              {p.id === 'git' && gitBadgeCount > 0 && (
                <span className="activity-bar__badge">{gitBadgeCount}</span>
              )}
            </div>
          );
        })}
      </div>
      <div className="activity-bar__bottom">
        {bottomItems.map((item, idx) => (
          <div
            key={idx}
            className="activity-bar__item"
            title={item.title}
            onClick={() => {
              if (item.action === 'settings') dispatch(setSettingsVisible(true));
            }}
          >
            {item.icon}
          </div>
        ))}
      </div>
    </div>
  );
};

export default ActivityBar;
