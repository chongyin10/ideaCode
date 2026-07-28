import { useSyncExternalStore } from 'react';
import { EdgeType } from '../../workflow';
import {
  getWorkflowStyleConfig,
  subscribeWorkflowStyleConfig,
  updateWorkflowStyleConfig,
} from '../../services/workflowStyleConfig';
import './WorkflowStyleConfig.css';

/** 连线类型选项 */
const EDGE_TYPE_OPTIONS: { value: EdgeType; label: string }[] = [
  { value: EdgeType.Straight, label: '直线' },
  { value: EdgeType.Horizontal, label: '水平折线' },
  { value: EdgeType.Vertical, label: '垂直折线' },
  { value: EdgeType.Bezier, label: '贝塞尔曲线' },
  { value: EdgeType.Arc, label: '弧度曲线' },
  { value: EdgeType.StepRight, label: '阶梯折线（先水平）' },
  { value: EdgeType.StepDown, label: '阶梯折线（先垂直）' },
];

/**
 * 工作流样式配置（主编辑区 tab 内容）
 *
 * 由左侧工作流面板 header 的齿轮按钮打开；
 * 修改实时作用于画布：已有图元即时刷新，新拖入节点 / 新连连线自动套用。
 */
const WorkflowStyleConfig = () => {
  const config = useSyncExternalStore(subscribeWorkflowStyleConfig, getWorkflowStyleConfig);

  return (
    <div className="workflow-style-config">
      <div className="workflow-style-config__section">
        <div className="workflow-style-config__group">节点</div>
        <div className="workflow-style-config__row">
          <span>边框颜色</span>
          <input
            type="color"
            value={config.nodeBorderColor}
            onChange={(e) => updateWorkflowStyleConfig({ nodeBorderColor: e.target.value })}
          />
        </div>
        <div className="workflow-style-config__row">
          <span>背景颜色</span>
          <input
            type="color"
            value={config.nodeBackgroundColor}
            onChange={(e) => updateWorkflowStyleConfig({ nodeBackgroundColor: e.target.value })}
          />
        </div>
      </div>

      <div className="workflow-style-config__section">
        <div className="workflow-style-config__group">连线</div>
        <div className="workflow-style-config__row">
          <span>类型</span>
          <select
            value={config.edgeType}
            onChange={(e) => updateWorkflowStyleConfig({ edgeType: e.target.value as EdgeType })}
          >
            {EDGE_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div className="workflow-style-config__row">
          <span>颜色</span>
          <input
            type="color"
            value={config.edgeColor}
            onChange={(e) => updateWorkflowStyleConfig({ edgeColor: e.target.value })}
          />
        </div>
        <div className="workflow-style-config__row">
          <span>宽度</span>
          <input
            type="number"
            min={1}
            max={10}
            step={1}
            value={config.edgeWidth}
            onChange={(e) => {
              const width = Number(e.target.value);
              if (Number.isFinite(width) && width >= 1 && width <= 10) {
                updateWorkflowStyleConfig({ edgeWidth: width });
              }
            }}
          />
        </div>
      </div>

      <div className="workflow-style-config__section">
        <div className="workflow-style-config__group">连接桩</div>
        <div className="workflow-style-config__row">
          <span>填充颜色</span>
          <input
            type="color"
            value={config.portColor}
            onChange={(e) => updateWorkflowStyleConfig({ portColor: e.target.value })}
          />
        </div>
      </div>
    </div>
  );
};

export default WorkflowStyleConfig;
