import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Settings, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useAppDispatch } from '../../store/hooks';
import { openVirtualFile } from '../../store/slices/workspaceSlice';
import {
  getWorkflowRuntime,
  subscribeWorkflowRuntime,
} from '../../services/workflowRuntime';
import { getEffectiveConfig } from '../../services/workflowStyleConfig';
import './WorkflowPanel.css';

interface PaletteNode {
  key: string;
  label: string;
  /** 强调色（物料块边框） */
  accentColor: string;
}

/** 物料节点列表（长方体块） */
const PALETTE_NODES: PaletteNode[] = [
  { key: 'start', label: '开始', accentColor: '#4ec9b0' },
  { key: 'process', label: '处理', accentColor: '#569cd6' },
  { key: 'decision', label: '判断', accentColor: '#d7ba7d' },
  { key: 'end', label: '结束', accentColor: '#f48771' },
];

/** 单个物料块：注册为 Dnd 拖拽源，可拖入所在画布 */
const PaletteItem = ({ node }: { node: PaletteNode }) => {
  const itemRef = useRef<HTMLDivElement>(null);
  const runtime = useSyncExternalStore(subscribeWorkflowRuntime, getWorkflowRuntime);

  useEffect(() => {
    const element = itemRef.current;
    if (!element || !runtime) return;
    return runtime.dnd.registerSource(element, () => {
      // 拖出时读取该画布的最新有效配置（全局 + 本工作流局部），作为新节点的样式
      const config = getEffectiveConfig(runtime.scope);
      return {
        id: `node-${node.key}-${Date.now()}`,
        label: node.label,
        x: 0,
        y: 0,
        portsAlwaysVisible: config.portsAlwaysVisible,
        style: {
          width: 140,
          height: 56,
          backgroundColor: config.nodeBackgroundColor,
          borderColor: config.nodeBorderColor,
          borderWidth: config.nodeBorderWidth,
          borderRadius: config.nodeBorderRadius,
          borderStyle: config.nodeBorderStyle,
          textColor: config.nodeTextColor,
          fontSize: config.nodeFontSize,
          selectedBorderColor: config.nodeSelectedBorderColor,
        },
      };
    });
  }, [runtime, node]);

  return (
    <div
      ref={itemRef}
      className="workflow-palette__item"
      style={{ borderColor: node.accentColor }}
    >
      {node.label}
    </div>
  );
};

/**
 * 工作流物料面板（画布内嵌浮动面板）
 *
 * 不再是 IDE 左侧栏面板，而是作为浮动卡片内嵌在画布 tab 内部，
 * 四周与画布边缘保持间隙，可折叠隐藏——让工作流功能自包含在
 * 自己的 tab 里，也为以后其他 tab 内嵌各自的面板提供范式。
 * 样式配置由面板 header 的齿轮按钮打开（编辑区独立 tab）。
 */
const WorkflowPanel = () => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const [collapsed, setCollapsed] = useState(false);

  // header 齿轮 → 在编辑区打开「样式配置」tab
  const handleOpenStyleConfig = () => {
    dispatch(
      openVirtualFile({
        id: 'workflow-style-config',
        name: t('workflow.styleConfig'),
        source: 'workflow://style-config',
        content: '',
        language: 'workflow-style-config',
        isDirty: false,
      })
    );
  };

  // 折叠/展开都做 CSS 过渡：面板与展开按钮常驻，用 class 切换
  return (
    <>
      <div className={`workflow-palette ${collapsed ? 'workflow-palette--collapsed' : ''}`}>
        <div className="workflow-palette__header">
          <span className="workflow-palette__title">{t('activityBar.workflow')}</span>
          <button
            type="button"
            className="workflow-palette__header-action"
            title={t('workflow.styleConfig')}
            onClick={handleOpenStyleConfig}
          >
            <Settings size={13} strokeWidth={1.5} />
          </button>
          <button
            type="button"
            className="workflow-palette__header-action"
            title={t('activityBar.workflow')}
            onClick={() => setCollapsed(true)}
          >
            <PanelLeftClose size={13} strokeWidth={1.5} />
          </button>
        </div>
        <div className="workflow-palette__list">
          {PALETTE_NODES.map((node) => (
            <PaletteItem key={node.key} node={node} />
          ))}
        </div>
      </div>
      <button
        type="button"
        className={`workflow-palette__expand ${collapsed ? 'workflow-palette__expand--visible' : ''}`}
        title={t('activityBar.workflow')}
        onClick={() => setCollapsed(false)}
      >
        <PanelLeftOpen size={14} strokeWidth={1.5} />
      </button>
    </>
  );
};

export default WorkflowPanel;
