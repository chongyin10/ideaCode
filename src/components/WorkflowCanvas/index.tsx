import { useEffect, useRef } from 'react';
import {
  Graph,
  Node,
  Edge,
  History,
  Snapline,
  Selection,
  Clipboard,
  MiniMap,
  Dnd,
  Tools,
} from '../../workflow';
import { setWorkflowRuntime, getWorkflowInstance, setWorkflowInstance, type WorkflowInstance } from '../../services/workflowRuntime';
import WorkflowPanel from '../WorkflowPanel';
import WorkflowToolbar from '../WorkflowToolbar';
import {
  getEffectiveConfig,
  subscribeEffectiveConfig,
  type WorkflowStyleConfig,
} from '../../services/workflowStyleConfig';
import {
  addDefaultPorts,
  applyCanvasBasics,
  applyEdgeConfig,
  applyStyleConfig,
} from '../../services/workflowStyleApply';
import './WorkflowCanvas.css';

/** 画布级配置：背景 / 网格 / 插件开关（插件实例经闭包传入） */
interface CanvasPlugins {
  snapline: Snapline;
  selection: Selection;
  clipboard: Clipboard;
  history: History;
  tools: Tools;
  minimap: MiniMap;
}

function applyCanvasConfig(
  graph: Graph,
  host: HTMLElement,
  plugins: CanvasPlugins,
  config: WorkflowStyleConfig
): void {
  applyCanvasBasics(graph, host, config);
  // 插件开关
  if (config.snaplineEnabled) plugins.snapline.enable(); else plugins.snapline.disable();
  if (config.selectionEnabled) plugins.selection.enable(); else plugins.selection.disable();
  if (config.clipboardEnabled) plugins.clipboard.enable(); else plugins.clipboard.disable();
  if (config.historyEnabled) plugins.history.enable(); else plugins.history.disable();
  if (config.toolsEnabled) plugins.tools.enable(); else plugins.tools.disable();
  if (config.minimapEnabled) plugins.minimap.show(); else plugins.minimap.hide();
}

/**
 * 创建某个工作流 scope 的 Graph 实例（每个画布 tab 一个实例，数据相互独立）。
 * 实例缓存在 workflowRuntime 注册表中，tab 切换只 reparent 宿主 DOM，不销毁。
 */
function createGraphInstance(scope: string, parent: HTMLElement): WorkflowInstance {
  const host = document.createElement('div');
  host.className = 'workflow-canvas__host';
  parent.appendChild(host);

  const graph = new Graph({
    container: host,
    draggable: true,
    scalable: true,
    backgroundColor: '#1e1e1e',
    grid: {
      enabled: true,
      size: 20,
      color: 'rgba(255, 255, 255, 0.06)',
    },
    // 右键菜单：节点 / 连线的删除操作（暗色主题）
    dropdown: {
      nodeMenu: [
        {
          label: '删除节点',
          danger: true,
          action: (target) => {
            if (target instanceof Node) graph.removeNode(target.getId());
          },
        },
      ],
      edgeMenu: [
        {
          label: '删除连线',
          danger: true,
          action: (target) => {
            if (target instanceof Edge) graph.removeEdge(target.getId());
          },
        },
      ],
      menuWidth: 120,
      backgroundColor: '#252526',
      textColor: '#cccccc',
      hoverColor: '#37373d',
      dangerColor: '#f48771',
      dangerHoverColor: '#37373d',
      borderColor: '#454545',
      borderRadius: 6,
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.4)',
    },
  });

  // 撤销重做需先于 Tools 安装（Tools 安装时查找 History 插件）
  const history = new History({ enabled: true, keyboardShortcuts: true });
  const snapline = new Snapline({ enabled: true });
  const selection = new Selection({ enabled: true });
  const clipboard = new Clipboard({ enabled: true });
  const minimap = new MiniMap({ enabled: true, position: 'bottom-right' });
  const tools = new Tools({
    enabled: true,
    position: 'top-right',
    showSearch: false,
    backgroundColor: '#252526',
    borderColor: '#3c3c3c',
  });
  graph.use(history);
  graph.use(snapline);
  graph.use(selection);
  graph.use(clipboard);
  graph.use(minimap);
  graph.use(tools);

  // 拖拽插件：接收物料面板拖入的节点
  const dnd = new Dnd({
    enabled: true,
    onDrop: (e) => {
      // 接管节点创建：统一挂载默认 4 向 Port，返回 false 阻止默认创建
      if (e.nodeOptions) {
        addDefaultPorts(e.target.addNode(e.nodeOptions), getEffectiveConfig(scope));
      }
      return false;
    },
  });
  graph.use(dnd);

  const plugins: CanvasPlugins = { snapline, selection, clipboard, history, tools, minimap };

  // ── 样式配置接线（随 Graph 生命周期只注册一次）──
  // 1. 新连接的边：创建时应用当前的有效连线样式
  graph.on('edge:add', (data: { edge?: Edge }) => {
    if (data.edge) applyEdgeConfig(data.edge, getEffectiveConfig(scope));
  });
  // 2. 已有图元 + 画布 + 插件：应用一次当前配置，并订阅后续修改
  const initialConfig = getEffectiveConfig(scope);
  applyStyleConfig(graph, initialConfig);
  applyCanvasConfig(graph, host, plugins, initialConfig);
  const unsubscribeStyle = subscribeEffectiveConfig(scope, (config) => {
    applyStyleConfig(graph, config);
    applyCanvasConfig(graph, host, plugins, config);
  });

  return { graph, dnd, host, dispose: unsubscribeStyle };
}

/**
 * 工作流画布（主编辑区 tab 内容）
 *
 * 每个工作流 tab 一个独立 Graph 实例（注册在 workflowRuntime），
 * 本组件只负责把宿主 DOM 挂到当前容器，并把实例注册为当前运行时，
 * 供画布内嵌的物料面板使用。物料面板（WorkflowPanel）以浮动卡片
 * 形式内嵌在画布内部。
 */
const WorkflowCanvas = ({ tabId }: { tabId: string }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let instance = getWorkflowInstance(tabId);
    if (!instance) {
      instance = createGraphInstance(tabId, container);
      setWorkflowInstance(tabId, instance);
    } else if (instance.host.parentElement !== container) {
      // 重挂载（tab 切换回来）：把已有画布宿主 DOM 挂到新容器
      container.appendChild(instance.host);
    }
    const current = instance;

    setWorkflowRuntime({ graph: current.graph, dnd: current.dnd, scope: tabId });

    // tab 隐藏期间 cleanup 会停止连线流动动画的总循环；
    // 重新挂载时按当前配置恢复，避免未挂载的画布在后台每帧空转
    if (getEffectiveConfig(tabId).edgeAnimated) {
      current.graph.startEdgeAnimation();
    }

    // 卸载时只摘除运行时引用并暂停动画，不销毁 Graph（数据跨 tab 切换保留）
    return () => {
      current.graph.stopEdgeAnimation();
      setWorkflowRuntime(null);
    };
  }, [tabId]);

  return (
    <div ref={containerRef} className="workflow-canvas">
      <WorkflowPanel />
      <WorkflowToolbar tabId={tabId} />
    </div>
  );
};

export default WorkflowCanvas;
