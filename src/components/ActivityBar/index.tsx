import { useState, useRef, useMemo } from 'react';
import { Files, Search, GitBranch, Bug, Blocks, User, Settings, Terminal, Sparkles, Zap, Lightbulb, Wand, Workflow, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { switchPanel, moveDockableItem, reorderDockableItem, setRightPanelVisible, activateVirtualPanel, type DockLocation } from '../../store/slices/layoutSlice';
import { setSettingsVisible, openVirtualFile, activateFile } from '../../store/slices/workspaceSlice';
import { WORKFLOW_TAB_ID, getLastActiveWorkflowScope } from '../../services/workflowRuntime';
import './ActivityBar.css';

const DOCK_MIME = 'application/lifeai-dock-item';

// 动态图标映射（扩展贡献的图标名 → lucide-react 组件）
const iconMap: Record<string, LucideIcon> = {
  Files, Search, GitBranch, Bug, Blocks, User, Settings, Terminal,
  Sparkles, Zap, Lightbulb, Wand, Workflow,
};

function getLucideIcon(name: string): LucideIcon | null {
  const cleanName = name.replace(/^\$\((.*)\)$/, '$1');
  // 支持 git-branch → GitBranch 这类 kebab-case 图标名
  const pascal = cleanName
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
  return iconMap[pascal] || iconMap[cleanName] || null;
}

const ActivityBar = () => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const activePanel = useAppSelector((state) => state.layout.activePanel);
  const dockableItems = useAppSelector((state) => state.layout.dockableItems);
  const openedFiles = useAppSelector((state) => state.workspace.openedFiles);
  // 工作流：内置画布功能，作为「虚拟左侧面板」——没有侧栏内容，
  // 点击时只切换图标选中态（activePanel='workflow'），侧栏保持收起，
  // 编辑器全屏显示画布 tab；同时关闭右侧面板，保证菜单互斥。
  // 已有工作流 tab 时聚焦最近活跃的一个，否则创建第一个；
  // 更多工作流 tab 由 TabBar 上工作流标签右侧的「+」按钮创建。
  const handleOpenWorkflow = () => {
    dispatch(activateVirtualPanel('workflow'));
    dispatch(setRightPanelVisible(false));
    const existing = openedFiles.filter((f) => f.language === 'workflow');
    if (existing.length > 0) {
      const lastScope = getLastActiveWorkflowScope();
      const target = existing.find((f) => f.id === lastScope) ?? existing[0];
      dispatch(activateFile(target.id));
      return;
    }
    dispatch(
      openVirtualFile({
        id: WORKFLOW_TAB_ID,
        name: t('activityBar.workflow'),
        source: 'workflow://canvas',
        content: '',
        language: 'workflow',
        isDirty: false,
        // 默认锁定（固定 tab，不被其他 tab 替换）；用户在 tab 上解锁后恢复预览态
        isPreview: false,
        readOnly: true,
      })
    );
  };

  const leftItems = useMemo(() => {
    return dockableItems.filter((i) => i.location === 'left');
  }, [dockableItems]);

  const bottomItems: { icon: React.ReactNode; title: string; action?: 'settings' }[] = [
    { icon: <User size={20} strokeWidth={1.5} />, title: t('activityBar.account') },
    { icon: <Settings size={20} strokeWidth={1.5} />, title: t('activityBar.settings'), action: 'settings' },
  ];

  // ── 拖拽状态 ──
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragOverPos, setDragOverPos] = useState<'before' | 'after'>('after');
  const draggingIdRef = useRef<string | null>(null);
  draggingIdRef.current = draggingId;

  const buildDragData = (id: string, source: DockLocation) => {
    return JSON.stringify({ id, source });
  };

  const readDragData = (e: React.DragEvent): { id: string; source: DockLocation } | null => {
    try {
      const data = e.dataTransfer.getData(DOCK_MIME);
      if (data) return JSON.parse(data);
    } catch {
      // ignore
    }
    return null;
  };

  const handleDragStart = (e: React.DragEvent, panelId: string) => {
    setDraggingId(panelId);
    draggingIdRef.current = panelId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(DOCK_MIME, buildDragData(panelId, 'left'));
  };

  const hasDockData = (e: React.DragEvent) => e.dataTransfer.types.includes(DOCK_MIME);

  const handleDragOver = (e: React.DragEvent, panelId: string) => {
    // dragover 阶段不能可靠读取 getData，改由 types 判断
    if (!hasDockData(e) || draggingIdRef.current === panelId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    setDragOverId(panelId);
    setDragOverPos(e.clientY < midY ? 'before' : 'after');
  };

  const handleDragLeave = (panelId: string) => {
    if (dragOverId === panelId) setDragOverId(null);
  };

  const handleDrop = (e: React.DragEvent, panelId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const dragData = readDragData(e);
    if (!dragData) return;
    const fromId = dragData.id;
    if (fromId === panelId) {
      resetDrag();
      return;
    }
    if (dragData.source === 'left') {
      dispatch(reorderDockableItem({ fromId, toId: panelId, position: dragOverPos }));
    } else {
      dispatch(moveDockableItem({ id: fromId, targetLocation: 'left', targetId: panelId, position: dragOverPos }));
    }
    resetDrag();
  };

  const handleContainerDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const dragData = readDragData(e);
    if (!dragData || dragData.source === 'left') {
      resetDrag();
      return;
    }
    // 拖到容器空白区，放到末尾
    dispatch(moveDockableItem({ id: dragData.id, targetLocation: 'left' }));
    resetDrag();
  };

  const resetDrag = () => {
    setDraggingId(null);
    setDragOverId(null);
    draggingIdRef.current = null;
  };

  return (
    <div className="activity-bar">
      <div
        className="activity-bar__top"
        onDragOver={(e) => {
          // 只要拖的是 dock item 就允许进入容器，drop 时再按 source 处理
          if (hasDockData(e)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
          }
        }}
        onDrop={handleContainerDrop}
      >
        {leftItems.map((item) => {
          const IconComp = getLucideIcon(item.icon) || Blocks;
          const isDragging = draggingId === item.id;
          const isDragOver = dragOverId === item.id;
          return (
            <div
              key={item.id}
              className={`activity-bar__item ${activePanel === item.id ? 'active' : ''} ${isDragging ? 'activity-bar__item--dragging' : ''} ${isDragOver ? `activity-bar__item--drag-over activity-bar__item--drag-${dragOverPos}` : ''}`}
              title={t(item.title) || item.title}
              draggable
              onDragStart={(e) => handleDragStart(e, item.id)}
              onDragOver={(e) => handleDragOver(e, item.id)}
              onDragLeave={() => handleDragLeave(item.id)}
              onDrop={(e) => handleDrop(e, item.id)}
              onDragEnd={resetDrag}
              onClick={() => dispatch(switchPanel(item.id))}
            >
              <IconComp size={20} strokeWidth={1.5} />
              {item.badge && item.badge > 0 && (
                <span className="activity-bar__badge">{item.badge}</span>
              )}
            </div>
          );
        })}
        {/* 工作流固定入口：虚拟左侧面板，选中态与其他图标一样由 activePanel 驱动 */}
        <div
          className={`activity-bar__item ${activePanel === 'workflow' ? 'active' : ''}`}
          title={t('activityBar.workflow')}
          onClick={handleOpenWorkflow}
        >
          <Workflow size={20} strokeWidth={1.5} />
        </div>
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
