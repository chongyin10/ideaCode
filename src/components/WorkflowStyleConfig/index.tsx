import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { EdgeType, Graph } from '../../workflow';
import { WORKFLOW_TAB_ID, getLastActiveWorkflowScope } from '../../services/workflowRuntime';
import {
  getEffectiveConfig,
  subscribeConfigStore,
  subscribeEffectiveConfig,
  updateStyleConfig,
  resetStyleConfig,
  type WorkflowStyleConfig as StyleConfig,
} from '../../services/workflowStyleConfig';
import {
  addDefaultPorts,
  applyCanvasBasics,
  applyStyleConfig,
} from '../../services/workflowStyleApply';
import './WorkflowStyleConfig.css';

/** 连线类型选项（EdgeType 全量 14 种） */
const EDGE_TYPE_OPTIONS: { value: EdgeType; label: string }[] = [
  { value: EdgeType.Straight, label: '直线' },
  { value: EdgeType.Horizontal, label: '水平折线' },
  { value: EdgeType.Vertical, label: '垂直折线' },
  { value: EdgeType.Bezier, label: '贝塞尔曲线' },
  { value: EdgeType.Arc, label: '弧度曲线' },
  { value: EdgeType.StepRight, label: '阶梯折线（先水平）' },
  { value: EdgeType.StepDown, label: '阶梯折线（先垂直）' },
  { value: EdgeType.RoundedStepRight, label: '圆角阶梯（先水平）' },
  { value: EdgeType.RoundedStepDown, label: '圆角阶梯（先垂直）' },
  { value: EdgeType.SmoothStep, label: '平滑 L 型折线' },
  { value: EdgeType.Orthogonal, label: '正交折线（智能路由）' },
  { value: EdgeType.DashedStep, label: '虚线阶梯折线' },
  { value: EdgeType.DashedRounded, label: '虚线圆角折线' },
  { value: EdgeType.JumpLine, label: '跳线' },
];

/* ── 通用小控件 ── */

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="workflow-style-config__row">
    <span>{label}</span>
    {children}
  </div>
);

const Switch = ({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    className={`workflow-style-config__switch ${checked ? 'is-on' : ''}`}
    onClick={() => onChange(!checked)}
  >
    <span className="workflow-style-config__switch-thumb" />
  </button>
);

const ColorField = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
  <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
);

const NumberField = ({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) => (
  <input
    type="number"
    min={min}
    max={max}
    step={1}
    value={value}
    onChange={(e) => {
      const n = Number(e.target.value);
      if (Number.isFinite(n) && n >= min && n <= max) onChange(n);
    }}
  />
);

/** 右侧实时预览画布：独立的示例 Graph，订阅配置即时刷新 */
const StylePreview = ({ scope }: { scope: string }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const graph = new Graph({
      container,
      draggable: true,
      scalable: true,
      backgroundColor: '#1e1e1e',
    });

    // 示例内容：两个节点 + 一条连线（节点样式随后由 applyStyleConfig 统一套用）
    // 节点固定在原点附近布局，随后通过 setOffset 把内容整体移到容器中心
    const nodeWidth = 140;
    const nodeHeight = 56;
    const gap = 120;
    const pad = 20;
    const contentBounds = {
      x: -pad,
      y: -pad,
      width: nodeWidth + pad * 2,
      height: nodeHeight * 2 + gap + pad * 2,
    };

    const sampleStyle = { width: nodeWidth, height: nodeHeight };
    const node1 = graph.addNode({ id: 'preview-node-1', label: '节点 A', x: 0, y: 0, style: sampleStyle });
    const node2 = graph.addNode({ id: 'preview-node-2', label: '节点 B', x: 0, y: nodeHeight + gap, style: sampleStyle });
    const effective = getEffectiveConfig(scope);
    addDefaultPorts(node1, effective);
    addDefaultPorts(node2, effective);
    graph.addEdge({
      id: 'preview-edge-1',
      source: { nodeId: node1.getId(), portId: `${node1.getId()}-port-bottom` },
      target: { nodeId: node2.getId(), portId: `${node2.getId()}-port-top` },
    });

    // 挂载瞬间容器可能尚未完成布局（宽高为 0），先 rAF 尝试，
    // 仍无效则用 ResizeObserver 等首次有效尺寸，居中成功一次后停止
    let centered = false;
    let observer: ResizeObserver | null = null;
    const centerContent = () => {
      if (centered) return true;
      const rect = container.getBoundingClientRect();
      if (rect.width < 50 || rect.height < 50) return false;
      graph.setScale(1);
      graph.setOffset({
        x: (rect.width - contentBounds.width) / 2 - contentBounds.x,
        y: (rect.height - contentBounds.height) / 2 - contentBounds.y,
      });
      centered = true;
      return true;
    };
    const rafId = requestAnimationFrame(() => {
      if (centerContent()) return;
      observer = new ResizeObserver(() => {
        if (centerContent()) {
          observer?.disconnect();
          observer = null;
        }
      });
      observer.observe(container);
    });

    const applyAll = (config: StyleConfig) => {
      applyStyleConfig(graph, config);
      applyCanvasBasics(graph, container, config);
    };
    applyAll(getEffectiveConfig(scope));
    const unsubscribe = subscribeEffectiveConfig(scope, applyAll);

    return () => {
      cancelAnimationFrame(rafId);
      observer?.disconnect();
      unsubscribe();
      graph.destroy();
    };
  }, [scope]);

  return <div ref={containerRef} className="workflow-style-config__preview-canvas" />;
};

/**
 * 工作流样式配置（主编辑区 tab 内容）
 *
 * 由画布内嵌物料面板 header 的齿轮按钮打开；
 * 「应用到所有工作流」开关决定修改写入全局层还是当前工作流的局部覆盖；
 * 恢复默认同样分全局 / 当前两种作用域。
 * 右侧为实时预览画布，无需切回工作流 tab 即可查看效果。
 */
const WorkflowStyleConfig = () => {
  // 编辑目标：最近活跃的工作流画布（齿轮按钮所在画布）；挂载时确定一次
  const [scope] = useState(() => getLastActiveWorkflowScope() ?? WORKFLOW_TAB_ID);
  const config = useSyncExternalStore(subscribeConfigStore, () => getEffectiveConfig(scope));
  // 作用域开关：开启 = 修改写入全局（所有工作流），关闭 = 仅当前工作流
  const [globalMode, setGlobalMode] = useState(true);
  const update = (patch: Partial<StyleConfig>) => updateStyleConfig(scope, patch, globalMode);

  return (
    <div className="workflow-style-config">
      <div className="workflow-style-config__form">
      {/* ── 作用域 ── */}
      <div className="workflow-style-config__section">
        <div className="workflow-style-config__group">作用域</div>
        <Row label="应用到所有工作流">
          <Switch checked={globalMode} onChange={setGlobalMode} />
        </Row>
        <div className="workflow-style-config__hint">
          {globalMode ? '当前修改将应用到所有工作流' : '当前修改仅对本工作流生效'}
        </div>
        <Row label="恢复默认">
          <button
            type="button"
            className="workflow-style-config__reset-btn"
            onClick={() => resetStyleConfig(scope, globalMode)}
          >
            {globalMode ? '恢复全局默认' : '恢复当前默认'}
          </button>
        </Row>
      </div>

      {/* ── 节点 ── */}
      <div className="workflow-style-config__section">
        <div className="workflow-style-config__group">节点</div>
        <Row label="边框颜色">
          <ColorField value={config.nodeBorderColor} onChange={(v) => update({ nodeBorderColor: v })} />
        </Row>
        <Row label="边框宽度">
          <NumberField value={config.nodeBorderWidth} min={0} max={10} onChange={(v) => update({ nodeBorderWidth: v })} />
        </Row>
        <Row label="边框样式">
          <select
            value={config.nodeBorderStyle}
            onChange={(e) => update({ nodeBorderStyle: e.target.value as typeof config.nodeBorderStyle })}
          >
            <option value="solid">实线</option>
            <option value="dashed">虚线</option>
            <option value="animated">蚂蚁线</option>
          </select>
        </Row>
        <Row label="圆角">
          <NumberField value={config.nodeBorderRadius} min={0} max={30} onChange={(v) => update({ nodeBorderRadius: v })} />
        </Row>
        <Row label="背景颜色">
          <ColorField value={config.nodeBackgroundColor} onChange={(v) => update({ nodeBackgroundColor: v })} />
        </Row>
        <Row label="文字颜色">
          <ColorField value={config.nodeTextColor} onChange={(v) => update({ nodeTextColor: v })} />
        </Row>
        <Row label="字号">
          <NumberField value={config.nodeFontSize} min={10} max={32} onChange={(v) => update({ nodeFontSize: v })} />
        </Row>
        <Row label="选中边框色">
          <ColorField value={config.nodeSelectedBorderColor} onChange={(v) => update({ nodeSelectedBorderColor: v })} />
        </Row>
      </div>

      {/* ── 连线 ── */}
      <div className="workflow-style-config__section">
        <div className="workflow-style-config__group">连线</div>
        <Row label="类型">
          <select value={config.edgeType} onChange={(e) => update({ edgeType: e.target.value as EdgeType })}>
            {EDGE_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </Row>
        <Row label="颜色">
          <ColorField value={config.edgeColor} onChange={(v) => update({ edgeColor: v })} />
        </Row>
        <Row label="宽度">
          <NumberField value={config.edgeWidth} min={1} max={10} onChange={(v) => update({ edgeWidth: v })} />
        </Row>
        <Row label="虚线">
          <Switch checked={config.edgeDashed} onChange={(v) => update({ edgeDashed: v })} />
        </Row>
        <Row label="箭头大小">
          <NumberField value={config.edgeArrowSize} min={0} max={20} onChange={(v) => update({ edgeArrowSize: v })} />
        </Row>
        <Row label="箭头颜色">
          <ColorField value={config.edgeArrowColor} onChange={(v) => update({ edgeArrowColor: v })} />
        </Row>
        <Row label="选中颜色">
          <ColorField value={config.edgeSelectedStroke} onChange={(v) => update({ edgeSelectedStroke: v })} />
        </Row>
        <Row label="折线圆角">
          <NumberField value={config.edgeCornerRadius} min={0} max={30} onChange={(v) => update({ edgeCornerRadius: v })} />
        </Row>
        <Row label="流动动画">
          <Switch checked={config.edgeAnimated} onChange={(v) => update({ edgeAnimated: v })} />
        </Row>
      </div>

      {/* ── 连接桩 ── */}
      <div className="workflow-style-config__section">
        <div className="workflow-style-config__group">连接桩</div>
        <Row label="填充颜色">
          <ColorField value={config.portColor} onChange={(v) => update({ portColor: v })} />
        </Row>
        <Row label="大小">
          <NumberField value={config.portSize} min={4} max={20} onChange={(v) => update({ portSize: v })} />
        </Row>
        <Row label="边框颜色">
          <ColorField value={config.portStrokeColor} onChange={(v) => update({ portStrokeColor: v })} />
        </Row>
        <Row label="常显">
          <Switch checked={config.portsAlwaysVisible} onChange={(v) => update({ portsAlwaysVisible: v })} />
        </Row>
      </div>

      {/* ── 画布 ── */}
      <div className="workflow-style-config__section">
        <div className="workflow-style-config__group">画布</div>
        <Row label="背景颜色">
          <ColorField value={config.canvasBackgroundColor} onChange={(v) => update({ canvasBackgroundColor: v })} />
        </Row>
      </div>

      {/* ── 网格 ── */}
      <div className="workflow-style-config__section">
        <div className="workflow-style-config__group">网格</div>
        <Row label="显示网格">
          <Switch checked={config.gridEnabled} onChange={(v) => update({ gridEnabled: v })} />
        </Row>
        <Row label="间距">
          <NumberField value={config.gridSize} min={5} max={100} onChange={(v) => update({ gridSize: v })} />
        </Row>
        <Row label="颜色">
          <ColorField value={config.gridColor} onChange={(v) => update({ gridColor: v })} />
        </Row>
        <Row label="类型">
          <select
            value={config.gridType}
            onChange={(e) => update({ gridType: e.target.value as typeof config.gridType })}
          >
            <option value="mesh">线状</option>
            <option value="dot">点状</option>
          </select>
        </Row>
      </div>

      {/* ── 功能 ── */}
      <div className="workflow-style-config__section">
        <div className="workflow-style-config__group">功能</div>
        <Row label="对齐线">
          <Switch checked={config.snaplineEnabled} onChange={(v) => update({ snaplineEnabled: v })} />
        </Row>
        <Row label="框选">
          <Switch checked={config.selectionEnabled} onChange={(v) => update({ selectionEnabled: v })} />
        </Row>
        <Row label="复制粘贴">
          <Switch checked={config.clipboardEnabled} onChange={(v) => update({ clipboardEnabled: v })} />
        </Row>
        <Row label="撤销重做">
          <Switch checked={config.historyEnabled} onChange={(v) => update({ historyEnabled: v })} />
        </Row>
        <Row label="工具栏">
          <Switch checked={config.toolsEnabled} onChange={(v) => update({ toolsEnabled: v })} />
        </Row>
        <Row label="小地图">
          <Switch checked={config.minimapEnabled} onChange={(v) => update({ minimapEnabled: v })} />
        </Row>
      </div>
      </div>

      {/* ── 右侧实时预览 ── */}
      <div className="workflow-style-config__preview">
        <div className="workflow-style-config__preview-title">预览</div>
        <StylePreview scope={scope} />
      </div>
    </div>
  );
};

export default WorkflowStyleConfig;
