import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { openVirtualFile } from '../../store/slices/workspaceSlice';
import {
  getWorkflowRuntime,
  subscribeWorkflowRuntime,
} from '../../services/workflowRuntime';
import { getWorkflowStyleConfig } from '../../services/workflowStyleConfig';
import './WorkflowPanel.css';

/** 画布 tab 的固定 id（同一时间只有一个工作流画布） */
const WORKFLOW_TAB_ID = 'workflow-canvas';

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

/** 单个物料块：注册为 Dnd 拖拽源，可拖入右侧画布 tab */
const PaletteItem = ({ node }: { node: PaletteNode }) => {
  const itemRef = useRef<HTMLDivElement>(null);
  const runtime = useSyncExternalStore(subscribeWorkflowRuntime, getWorkflowRuntime);

  useEffect(() => {
    const element = itemRef.current;
    if (!element || !runtime) return;
    return runtime.dnd.registerSource(element, () => {
      // 拖出时读取最新的样式配置，作为新节点的样式
      const config = getWorkflowStyleConfig();
      return {
        id: `node-${node.key}-${Date.now()}`,
        label: node.label,
        x: 0,
        y: 0,
        style: {
          width: 140,
          height: 56,
          backgroundColor: config.nodeBackgroundColor,
          borderColor: config.nodeBorderColor,
          textColor: '#e8e8e8',
          borderRadius: 6,
          borderWidth: 1,
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
 * 工作流物料面板（左侧栏）
 *
 * 展示可拖拽的节点列表；面板激活时自动在主编辑区打开画布 tab，
 * 节点从左侧拖入右侧画布即创建对应图元。
 * 样式配置由面板 header 的齿轮按钮打开（编辑区独立 tab）。
 */
const WorkflowPanel = () => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const panelActive = useAppSelector(
    (s) => s.layout.activePanel === 'workflow' && s.layout.sidePanelVisible
  );
  // 记录上一次的激活状态，只在「未激活 → 激活」跳变时打开画布 tab；
  // 不做持续监听，避免用户手动关闭 tab 后被立即重新打开
  const prevActiveRef = useRef(false);

  // 面板激活时打开（或聚焦）画布 tab；openVirtualFile 对已存在的 id 仅做激活
  useEffect(() => {
    const wasActive = prevActiveRef.current;
    prevActiveRef.current = panelActive;
    if (!panelActive || wasActive) return;
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
  }, [panelActive, dispatch, t]);

  return (
    <div className="workflow-palette">
      {PALETTE_NODES.map((node) => (
        <PaletteItem key={node.key} node={node} />
      ))}
    </div>
  );
};

export default WorkflowPanel;
