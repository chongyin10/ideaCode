import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, RefreshCw, Filter, FileDown, ArrowDownUp, ArrowRightLeft, Sparkles, FolderTree, Files, FlaskConical, TestTube2 } from 'lucide-react';
import {
  Graph,
  EdgeType,
  Selection,
  Dnd,
  Tools,
  Dropdown,
  MiniMap,
  type Node,
  type Edge,
  type ConnectionValidateContext,
} from '../../workflow';
import i18n from '../../i18n';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import {
  openFile,
  expandToFile,
  openDiffView,
  openVirtualFile,
  refreshAllFilePaths,
  refreshDirectory,
  setPendingSearchQuery,
} from '../../store/slices/workspaceSlice';
import { switchPanel, switchRightItem } from '../../store/slices/layoutSlice';
import { extensionRpc, isPath, readFile } from '../../services/fileService';
import { exists, revealInExplorer } from '../../services/fileOperations';
import { terminalSDK } from '../../services/terminalSDK';
import {
  getWorkflowInstance,
  setWorkflowInstance,
  consumePendingWorkflowGraphData,
  setPendingWorkflowGraphData,
  setDepGraphSourceData,
  getDepGraphSourceData,
  setDepGraphViewMode,
  getDepGraphViewMode,
  getDepGraphExpandedGroups,
  toggleDepGraphExpandedGroup,
  resetDepGraphExpandedGroups,
  setDepGraphTarget,
  getDepGraphTarget,
  setDepGraphDirection,
  getDepGraphDirection,
  type DepGraphViewMode,
  type WorkflowInstance,
} from '../../services/workflowRuntime';
import { loadGraphFromData } from '../../services/workflowPersistence';
import { getEffectiveConfig } from '../../services/workflowStyleConfig';
import { addDefaultPorts } from '../../services/workflowStyleApply';
import {
  aggregateByDirectory,
  buildDependencyGraph,
  renameFileWithImportSync,
  renameNodeInGraphData,
  extractDirectSubgraph,
  filterChangedImpact,
  findCyclicNodeIds,
  relayoutGraphData,
  findDependencyPath,
  filterGraphNodes,
  toMermaid,
} from '../../services/dependencyGraph';
import { getExtensionBridge } from '../../plugin/extensionBridge';
import './DependencyGraphCanvas.css';

/** 节点右键菜单的动作集：由 React 侧提供（需要 dispatch / 终端 / 弹窗等能力） */
interface DepGraphMenuActions {
  /** 节点 id → 文件的项目相对路径；非文件节点（聚合组）返回 null（不弹菜单） */
  resolveFilePath: (nodeId: string) => string | null;
  /** 双击组节点：下钻展开一层（仅聚合模式生效） */
  onToggleGroup: (groupId: string) => void;
  /** 打开文件（编辑区 tab） */
  onOpenFile: (rel: string) => void;
  /** 在资源管理器中定位（展开所有父目录） */
  onLocate: (rel: string) => void;
  /** diff 对比（HEAD vs 工作树，走 git 扩展） */
  onDiff: (rel: string) => void;
  /** 在磁盘中打开（系统文件管理器中定位） */
  onReveal: (rel: string) => void;
  /** 在终端中打开（cwd = 文件所在目录） */
  onOpenInTerminal: (rel: string) => void;
  /** 在文件中查找（跳搜索面板并预置文件名） */
  onFindInFiles: (rel: string) => void;
  /** 复制绝对路径 */
  onCopyPath: (rel: string) => void;
  /** 复制项目相对路径 */
  onCopyRelativePath: (rel: string) => void;
  /** 发起重命名（打开重命名弹窗） */
  onRequestRename: (rel: string) => void;
  /** 拆分为新的依赖图：以该节点为中心提取直接关联子图，开新画布 tab */
  onSplitGraph: (rel: string) => void;
  /** 高亮反向依赖：谁引用了该文件（入边高亮，其余压暗） */
  onHighlightDependents: (rel: string) => void;
  /** 节点悬停：展示信息卡（依赖数/被引用数/git 状态/循环标记） */
  onNodeHover: (nodeId: string) => void;
  /** 节点移出：关闭信息卡 */
  onNodeLeave: () => void;
  /** 发起依赖路径查找：以该节点为起点，等待用户点击目标节点 */
  onFindPath: (rel: string) => void;
  /** AI 解析：读取文件内容发给 lifeAiCode，生成代码结构/类型/优化点分析 */
  onAiAnalyze: (rel: string) => void;
  /** 添加到 LifeAiCode：把文件作为 @ 引用芯片塞进 AI 输入框 */
  onAddToAi: (rel: string) => void;
  /** AI 测试节点拖入画布：登记注册表 */
  onAiTestDrop: (testId: string, x: number, y: number) => void;
  /** 用户手动连线建立：登记 测试节点 → 文件节点 关联 */
  onAiTestLink: (testId: string, fileId: string) => void;
  /** 查询测试节点信息（右键菜单禁用态用） */
  getAiTestInfo: (testId: string) => { links: string[]; status: AiTestStatus } | null;
  /** 开始 AI 单元测试：拼 prompt 走 lifeAiCode Agent 通道 */
  onAiTestStart: (testId: string) => void;
  /** 查看测试报告（单击节点或右键菜单） */
  onAiTestViewReport: (testId: string) => void;
  /** 清除测试节点的全部连线并复位状态 */
  onAiTestClearLinks: (testId: string) => void;
  /** 删除测试节点（含轮询定时器与注册表清理） */
  onAiTestDelete: (testId: string) => void;
  /** 当前路径查找的起点（null = 未处于选目标状态） */
  getPathSource: () => string | null;
  /** 用户点选目标节点：计算并高亮依赖路径 */
  onPickPathTarget: (targetId: string) => void;
  /** 取消路径查找的选目标状态（空白点击） */
  cancelPathPick: () => void;
}

/** 依赖连线的默认样式（直线；低透明度细线，避免密集区域糊成一团。
 *  selectedStroke 与 stroke 保持一致：外观只由下方选中高亮逻辑控制，
 *  不被引擎内置的选中色（橙）干扰） */
const DEP_EDGE_STYLE = {
  stroke: 'rgba(86, 156, 214, 0.45)',
  strokeWidth: 1,
  arrowSize: 6,
  arrowColor: 'rgba(86, 156, 214, 0.45)',
  selectedStroke: 'rgba(86, 156, 214, 0.45)',
  selectedStrokeWidth: 1,
};

/** 选中节点/连线时：关联连线高亮 */
const DEP_EDGE_ACTIVE_STYLE = {
  stroke: '#4fc1ff',
  strokeWidth: 2,
  arrowSize: 8,
  arrowColor: '#4fc1ff',
  selectedStroke: '#4fc1ff',
  selectedStrokeWidth: 2,
};

/** 选中节点/连线时：无关连线压暗 */
const DEP_EDGE_DIM_STYLE = {
  stroke: 'rgba(86, 156, 214, 0.08)',
  strokeWidth: 1,
  arrowSize: 0,
  arrowColor: 'rgba(86, 156, 214, 0.08)',
  selectedStroke: 'rgba(86, 156, 214, 0.08)',
  selectedStrokeWidth: 1,
};

/** AI 单元测试节点状态（idle 待连线 / running 测试进行中 / done 报告已生成） */
type AiTestStatus = 'idle' | 'running' | 'done';

/** AI 单元测试连线（用户手动拖出）的默认样式：紫色贝塞尔曲线，与蓝色依赖直线区分 */
const TEST_LINK_STYLE = {
  stroke: 'rgba(197, 134, 192, 0.75)',
  strokeWidth: 1.5,
  arrowSize: 6,
  arrowColor: 'rgba(197, 134, 192, 0.75)',
  selectedStroke: 'rgba(197, 134, 192, 0.75)',
  selectedStrokeWidth: 1.5,
};

/** 测试连线被点击时的高亮样式 */
const TEST_LINK_ACTIVE_STYLE = {
  stroke: '#e3b7ff',
  strokeWidth: 2,
  arrowSize: 8,
  arrowColor: '#e3b7ff',
  selectedStroke: '#e3b7ff',
  selectedStrokeWidth: 2,
};

/** AI 单元测试节点的固定样式（紫色圆角胶囊，与文件节点蓝、组节点琥珀区分） */
const AI_TEST_NODE_STYLE = {
  width: 140,
  height: 44,
  backgroundColor: '#2d2436',
  borderColor: '#c586c0',
  borderWidth: 1.5,
  borderRadius: 22,
  textColor: '#e8d5f2',
  fontSize: 12,
};

/** 测试节点状态 → 边框色（idle 紫 / running 琥珀 / done 绿） */
const AI_TEST_STATUS_BORDER: Record<AiTestStatus, string> = {
  idle: '#c586c0',
  running: '#cca700',
  done: '#73c991',
};

/** 是否 AI 单元测试节点（data.kind 标记，与文件/组节点区分） */
function isAiTestNode(node: Node): boolean {
  return node.getData()?.kind === 'aiTest';
}

/** 是否 AI 单元测试连线（用户手动拖出，data.kind 标记，与程序生成的依赖边区分） */
function isAiTestLink(edge: Edge): boolean {
  return edge.getData()?.kind === 'aiTestLink';
}

/** 搜索命中节点的边框高亮色（与文件节点蓝 #569cd6、组节点琥珀 #e0af68 区分） */
const SEARCH_HIGHLIGHT_BORDER = '#f97583';

/** 循环依赖节点的边框警示色（红，与 git 删除色一致） */
const CYCLE_BORDER = '#f85149';

/** git 状态码 → 角标颜色（与资源管理器 .git-status 配色一致，见 SidePanel.css） */
const GIT_STATUS_BADGE_COLORS: Record<string, string> = {
  M: '#cca700', // 已修改 — 暗金
  A: '#73c991', // 新增 — 绿
  U: '#73c991', // 未跟踪 — 绿
  D: '#f85149', // 删除 — 红
  R: '#4a9eff', // 重命名 — 蓝
  C: '#73c991', // 复制 — 绿
};

/** 测试文件路径判定（.test./.spec. 中缀、Go 的 _test 后缀、Python 的 test_ 前缀） */
function isTestFilePath(id: string): boolean {
  const name = id.split('/').pop() || id;
  return /\.(test|spec)\.[^.]+$|_test\.[^.]+$|^test_.*\.py$/i.test(name);
}

/** 取文件的小写扩展名（带点，无扩展名返回 ''） */
function extOfPath(id: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(id);
  return match ? `.${match[1].toLowerCase()}` : '';
}

/** 把 git 文件状态同步为节点左上角角标（节点 id = 项目相对路径，与 gitStatus 键同口径）；
 *  无状态的节点清除角标。组节点 id 不在 gitStatus 中，天然无角标 */
function applyGitStatusBadges(graph: Graph, gitStatus: Record<string, string>): void {
  for (const node of graph.getAllNodes()) {
    const code = gitStatus[node.getId()];
    node.updateStyle({
      badgeText: code || undefined,
      badgeColor: code ? GIT_STATUS_BADGE_COLORS[code] ?? '#cccccc' : undefined,
    });
  }
  graph.scheduleRender();
}

/**
 * 创建依赖可视化 scope 的 Graph 实例（把 workflow 引擎当 SDK 用，
 * 只装配只读浏览所需的插件，不接物料面板 / 样式配置服务）。
 * 实例缓存在 workflowRuntime 注册表中，tab 切换只 reparent 宿主 DOM，不销毁。
 * menuActionsRef：菜单/事件动作的可变引用——实例跨组件挂载复用，闭包必须
 * 每次经 ref 取最新动作集，否则会用首次挂载的旧闭包（setState 已随旧组件卸载，
 * 表现为重命名弹窗等动作失效）。
 */
function createDepGraphInstance(
  scope: string,
  parent: HTMLElement,
  menuActionsRef: { current: DepGraphMenuActions }
): WorkflowInstance {
  const host = document.createElement('div');
  host.className = 'dependency-graph-canvas__host';
  parent.appendChild(host);

  // validateConnection 需要在自身初始化器里引用 graph（循环推断会报 TS7022），
  // 先经 graphRef 间接引用，构造完成后立即赋值
  let graphRef: Graph | null = null;
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
    // 手动连线仅允许「AI 测试节点 ↔ 文件节点」：依赖边由程序生成，
    // 文件互连/测试节点互连没有语义；同一对节点之间只允许一条测试连线
    validateConnection: ({ sourceNode, targetNode }: ConnectionValidateContext): boolean => {
      if (isAiTestNode(sourceNode) === isAiTestNode(targetNode)) return false;
      const g = graphRef;
      if (!g) return true;
      return !g.getAllEdges().some((e) => {
        const s = e.getSourceAnchor().nodeId;
        const t2 = e.getTargetAnchor().nodeId;
        return (
          (s === sourceNode.getId() && t2 === targetNode.getId()) ||
          (s === targetNode.getId() && t2 === sourceNode.getId())
        );
      });
    },
  });
  graphRef = graph;

  // 只读浏览：框选 / 工具栏（无撤销重做、无搜索）；小地图用于大图谱导航
  graph.use(new Selection({ enabled: true }));
  graph.use(
    new Tools({
      enabled: true,
      position: 'top-right',
      showSearch: false,
      showHistory: false,
      backgroundColor: '#252526',
      borderColor: '#3c3c3c',
    })
  );
  graph.use(
    new MiniMap({
      enabled: true,
      position: 'bottom-right',
      width: 160,
      height: 110,
      backgroundColor: '#252526',
      borderColor: '#3c3c3c',
    })
  );

  // 「AI 单元测试」物料：工具栏拖入画布创建测试节点。
  // onDrop 接管创建（返回 false 阻止默认创建）：自定义 id/data 并挂 4 向连接桩，
  // 连接桩是手动连线的起点（Graph 在 mousedown 命中 port 时启动连线拖拽）
  const dnd = new Dnd({
    enabled: true,
    onDrop: (e) => {
      if (!e.nodeOptions) return false;
      const id = `ai-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const node = e.target.addNode({
        ...e.nodeOptions,
        id,
        data: { kind: 'aiTest', status: 'idle' },
      });
      addDefaultPorts(node, getEffectiveConfig(scope));
      const pos = node.getPosition();
      menuActionsRef.current.onAiTestDrop(id, pos.x, pos.y);
      return false;
    },
  });
  graph.use(dnd);

  // 节点右键菜单（暗色风格，与资源管理器右键菜单一致）：
  // 仅文件节点弹菜单（聚合组节点 resolveFilePath 返回 null）；标签在点击时取当前语言
  const dropdown = new Dropdown({
    menuWidth: 170,
    backgroundColor: '#252526',
    textColor: '#cccccc',
    hoverColor: '#37373d',
    borderColor: '#3c3c3c',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.45)',
    nodeMenu: (node) => {
      // 菜单弹出时先关掉悬停信息卡（它会浮在菜单下方造成视觉穿透）
      menuActionsRef.current.onNodeLeave();
      // AI 单元测试节点：独立菜单（与文件节点语义不同，单独成组）
      if (isAiTestNode(node)) {
        const testMenuActions = menuActionsRef.current;
        const testId = node.getId();
        const info = testMenuActions.getAiTestInfo(testId);
        const linkCount = info?.links.length ?? 0;
        return [
          { label: i18n.t('dependencyGraph.aiTest.nodeLabel'), header: true, action: () => {} },
          {
            label: i18n.t('dependencyGraph.aiTest.start'),
            disabled: linkCount === 0 || info?.status === 'running',
            action: () => testMenuActions.onAiTestStart(testId),
          },
          {
            label: i18n.t('dependencyGraph.aiTest.viewReport'),
            action: () => testMenuActions.onAiTestViewReport(testId),
          },
          { label: '', separator: true, action: () => {} },
          {
            label: i18n.t('dependencyGraph.aiTest.clearLinks'),
            disabled: linkCount === 0,
            action: () => testMenuActions.onAiTestClearLinks(testId),
          },
          {
            label: i18n.t('dependencyGraph.aiTest.delete'),
            action: () => testMenuActions.onAiTestDelete(testId),
          },
        ];
      }
        const menuActions = menuActionsRef.current;
        const rel = menuActions.resolveFilePath(node.getId());
        if (!rel) return [];
        // 叶子节点（依赖链末尾，没有任何出向连线）拆不出子图：菜单项置灰禁用
        const nodeId = node.getId();
        const hasOutgoing = graph
          .getAllEdges()
          .some((e) => e.getSourceAnchor().nodeId === nodeId);
        return [
          // 顶部提示：完整相对路径（纯展示，节点上可能因截断看不清全路径）
          { label: rel, header: true, action: () => {} },
          // ── 文件操作 ──
          {
            label: i18n.t('dependencyGraph.openFile'),
            action: () => menuActions.onOpenFile(rel),
          },
          {
            label: i18n.t('dependencyGraph.locate'),
            action: () => menuActions.onLocate(rel),
          },
          {
            label: i18n.t('dependencyGraph.aiAnalyze'),
            action: () => menuActions.onAiAnalyze(rel),
          },
          {
            label: i18n.t('dependencyGraph.addToAi'),
            action: () => menuActions.onAddToAi(rel),
          },
          { label: '', separator: true, action: () => {} },
          // ── 依赖分析 ──
          {
            label: i18n.t('dependencyGraph.highlightDependents'),
            action: () => menuActions.onHighlightDependents(rel),
          },
          {
            label: i18n.t('dependencyGraph.findPath'),
            action: () => menuActions.onFindPath(rel),
          },
          {
            label: i18n.t('dependencyGraph.diffCompare'),
            action: () => menuActions.onDiff(rel),
          },
          { label: '', separator: true, action: () => {} },
          // ── 系统集成 ──
          {
            label: i18n.t('explorer.contextMenu.revealInExplorer'),
            action: () => menuActions.onReveal(rel),
          },
          {
            label: i18n.t('explorer.contextMenu.openInTerminal'),
            action: () => menuActions.onOpenInTerminal(rel),
          },
          {
            label: i18n.t('explorer.contextMenu.findInFiles'),
            action: () => menuActions.onFindInFiles(rel),
          },
          { label: '', separator: true, action: () => {} },
          // ── 路径工具 ──
          {
            label: i18n.t('explorer.contextMenu.copyPath'),
            action: () => menuActions.onCopyPath(rel),
          },
          {
            label: i18n.t('explorer.contextMenu.copyRelativePath'),
            action: () => menuActions.onCopyRelativePath(rel),
          },
          { label: '', separator: true, action: () => {} },
          // ── 修改 ──
          { label: i18n.t('rename'), action: () => menuActions.onRequestRename(rel) },
          {
            label: i18n.t('dependencyGraph.splitToNewGraph'),
            disabled: !hasOutgoing,
            action: () => menuActions.onSplitGraph(rel),
          },
        ];
    },
  });
  graph.use(dropdown);

  // 用户手动连出的「测试节点 ↔ 文件节点」边：打 kind 标记、统一为紫色贝塞尔样式，
  // 并登记到 React 侧的关联注册表。程序生成的依赖边两端都不是测试节点，不受影响；
  // 画布重建（renderMode）重新注入测试连线时也会走这里（登记是幂等的 Set.add）
  graph.on('edge:add', (data: { edge?: Edge }) => {
    const edge = data.edge;
    if (!edge) return;
    const srcId = edge.getSourceAnchor().nodeId;
    const tgtId = edge.getTargetAnchor().nodeId;
    const srcNode = graph.getAllNodes().find((n) => n.getId() === srcId);
    const tgtNode = graph.getAllNodes().find((n) => n.getId() === tgtId);
    const srcTest = srcNode ? isAiTestNode(srcNode) : false;
    const tgtTest = tgtNode ? isAiTestNode(tgtNode) : false;
    if (srcTest === tgtTest) return;
    edge.setData({ ...edge.getData(), kind: 'aiTestLink' });
    edge.setType(EdgeType.Bezier);
    edge.updateStyle(TEST_LINK_STYLE);
    menuActionsRef.current.onAiTestLink(srcTest ? srcId : tgtId, srcTest ? tgtId : srcId);
  });

  // 当前高亮关联集：从边样式动态推导（处于高亮色的边的两端节点）。
  // 不另存状态——画布重建 / 空白点击会把边样式重置回默认色，推导结果自动失效
  const getLitNodeIds = (): Set<string> | null => {
    const lit = new Set<string>();
    for (const edge of graph.getAllEdges()) {
      if (edge.getStyle().stroke === DEP_EDGE_ACTIVE_STYLE.stroke) {
        lit.add(edge.getSourceAnchor().nodeId);
        lit.add(edge.getTargetAnchor().nodeId);
      }
    }
    return lit.size > 0 ? lit : null;
  };

  // 选中节点时只高亮其「出边」（它引用的子节点方向），父节点方向的入边压暗；
  // 同时压暗无关节点（子节点保持不透明）。
  // 已存在高亮关联线时，点击（含右键触发的选中）关联集内的节点保持原状，
  // 只有点击集外节点才取消旧高亮、按新节点重新计算
  graph.on('node:selected', (data: { node?: Node }) => {
    const selectedId = data.node?.getId();
    if (!selectedId) return;
    // 路径查找选目标状态：点选另一个节点即计算依赖路径，不进入常规高亮
    const pathSource = menuActionsRef.current.getPathSource();
    if (pathSource) {
      if (selectedId !== pathSource) menuActionsRef.current.onPickPathTarget(selectedId);
      return;
    }
    if (getLitNodeIds()?.has(selectedId)) return;
    const neighborIds = new Set<string>([selectedId]);
    for (const edge of graph.getAllEdges()) {
      const srcId = edge.getSourceAnchor().nodeId;
      const tgtId = edge.getTargetAnchor().nodeId;
      // 测试连线不参与依赖高亮配色；选中测试节点时其关联文件保持不透明
      if (isAiTestLink(edge)) {
        edge.updateStyle(TEST_LINK_STYLE);
        if (srcId === selectedId) neighborIds.add(tgtId);
        if (tgtId === selectedId) neighborIds.add(srcId);
        continue;
      }
      const isOutgoing = srcId === selectedId;
      edge.updateStyle(isOutgoing ? DEP_EDGE_ACTIVE_STYLE : DEP_EDGE_DIM_STYLE);
      if (isOutgoing) {
        neighborIds.add(tgtId);
      }
    }
    for (const node of graph.getAllNodes()) {
      node.updateStyle({ opacity: neighborIds.has(node.getId()) ? 1 : 0.6 });
    }
  });

  // 双击：文件节点 → 打开文件 tab；组节点（聚合模式）→ 下钻展开一层目录/文件结构
  graph.on('node:dblclick', (data: { node?: Node }) => {
    const id = data.node?.getId();
    if (!id) return;
    const menuActions = menuActionsRef.current;
    const rel = menuActions.resolveFilePath(id);
    if (rel) menuActions.onOpenFile(rel);
    else menuActions.onToggleGroup(id);
  });

  // 悬停信息卡：进入节点时展示（位置由 React 侧跟踪的鼠标坐标决定）。
  // 右键菜单打开期间抑制——菜单浮在画布上，光标在菜单内移动会穿透触发节点悬停
  graph.on('node:mouseenter', (data: { node?: Node }) => {
    if (dropdown.isOpen()) return;
    const id = data.node?.getId();
    if (id) menuActionsRef.current.onNodeHover(id);
  });
  graph.on('node:mouseleave', () => {
    menuActionsRef.current.onNodeLeave();
  });

  // 点击连线时同款处理：高亮该连线、压暗其余连线，仅两端节点保持不透明
  graph.on('edge:click', (data: { edge?: Edge }) => {
    const clickedId = data.edge?.getId();
    if (!clickedId || !data.edge) return;
    const endpointIds = new Set<string>([
      data.edge.getSourceAnchor().nodeId,
      data.edge.getTargetAnchor().nodeId,
    ]);
    for (const edge of graph.getAllEdges()) {
      // 测试连线与依赖边分属两套配色体系，各自处理
      if (isAiTestLink(edge)) {
        edge.updateStyle(edge.getId() === clickedId ? TEST_LINK_ACTIVE_STYLE : TEST_LINK_STYLE);
      } else {
        edge.updateStyle(edge.getId() === clickedId ? DEP_EDGE_ACTIVE_STYLE : DEP_EDGE_DIM_STYLE);
      }
    }
    for (const node of graph.getAllNodes()) {
      node.updateStyle({ opacity: endpointIds.has(node.getId()) ? 1 : 0.6 });
    }
  });

  // 取消高亮只认「真正的空白点击」：记录按下位置，点击时位移超过阈值
  // 视为拖拽平移画布（引擎在拖拽松手时也会派发 click），此时保留高亮
  let blankDown: { clientX: number; clientY: number } | null = null;
  graph.on('blank:mousedown', (data: { clientX?: number; clientY?: number }) => {
    blankDown = { clientX: data.clientX ?? 0, clientY: data.clientY ?? 0 };
  });
  graph.on('blank:click', (data: { clientX?: number; clientY?: number }) => {
    const dx = (data.clientX ?? 0) - (blankDown?.clientX ?? 0);
    const dy = (data.clientY ?? 0) - (blankDown?.clientY ?? 0);
    blankDown = null;
    if (dx * dx + dy * dy > 25) return; // 位移超过 5px 视为拖拽，不取消高亮
    menuActionsRef.current.cancelPathPick();
    for (const edge of graph.getAllEdges()) {
      edge.updateStyle(isAiTestLink(edge) ? TEST_LINK_STYLE : DEP_EDGE_STYLE);
    }
    for (const node of graph.getAllNodes()) {
      node.updateStyle({ opacity: 1 });
    }
  });

  // 测试节点被拖动后同步位置到注册表（否则画布重建时恢复的是拖入时的旧位置）
  graph.on('node:dragend', (data: { node?: Node }) => {
    const node = data.node;
    if (!node || !isAiTestNode(node)) return;
    const pos = node.getPosition();
    menuActionsRef.current.onAiTestDrop(node.getId(), pos.x, pos.y);
  });

  // 单击 AI 测试节点：弹出测试报告。用按下/抬起时的节点世界坐标差识别拖拽，
  // 拖拽移动过的节点不触发（引擎在拖拽松手时也会派发 click）
  let testNodeDownPos: { x: number; y: number } | null = null;
  graph.on('node:mousedown', (data: { node?: Node }) => {
    testNodeDownPos = data.node ? data.node.getPosition() : null;
  });
  graph.on('node:click', (data: { node?: Node }) => {
    const node = data.node;
    if (!node || !isAiTestNode(node)) {
      testNodeDownPos = null;
      return;
    }
    const pos = node.getPosition();
    const moved = testNodeDownPos
      ? Math.abs(pos.x - testNodeDownPos.x) + Math.abs(pos.y - testNodeDownPos.y)
      : 0;
    testNodeDownPos = null;
    if (moved > 2) return;
    menuActionsRef.current.onAiTestViewReport(node.getId());
  });

  return { graph, dnd, host, dispose: () => {} };
}

/** 按当前节点内容自适应缩放居中（布局从左上角开始，首次打开直接看到全图） */
function fitContent(graph: Graph): void {
  const nodes = graph.getAllNodes();
  if (nodes.length === 0) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    const b = node.getBounds();
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  graph.fitToContent({ x: minX, y: minY, width: maxX - minX, height: maxY - minY }, 60);
}

/**
 * 代码依赖可视化画布（主编辑区 tab 内容）
 *
 * 与 WorkflowCanvas 完全独立：不渲染物料面板 / 工具栏，不注册工作流运行时，
 * 只把 ExplorerContent 预置的依赖图数据灌入画布并统一连线样式。
 */
const DependencyGraphCanvas = ({ tabId }: { tabId: string }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const rootSource = useAppSelector((state) => state.workspace.rootSource);
  const allFilePaths = useAppSelector((state) => state.workspace.allFilePaths);
  const activePanel = useAppSelector((state) => state.layout.activePanel);
  const sidePanelVisible = useAppSelector((state) => state.layout.sidePanelVisible);
  const activeRightItem = useAppSelector((state) => state.layout.activeRightItem);
  const rightPanelVisible = useAppSelector((state) => state.layout.rightPanelVisible);
  const dockableItems = useAppSelector((state) => state.layout.dockableItems);
  // Git 文件状态（web/git 扩展推送）：同步为节点左上角角标
  const gitStatus = useAppSelector((state) => state.workspace.gitStatus);
  // 菜单动作在实例创建时被捕获（实例跨渲染缓存），用 ref 保证始终读到最新的根路径/文件清单
  const rootSourceRef = useRef(rootSource);
  rootSourceRef.current = rootSource;
  const allFilePathsRef = useRef(allFilePaths);
  allFilePathsRef.current = allFilePaths;
  const layoutRef = useRef({ activePanel, sidePanelVisible, activeRightItem, rightPanelVisible, dockableItems });
  layoutRef.current = { activePanel, sidePanelVisible, activeRightItem, rightPanelVisible, dockableItems };
  const gitStatusRef = useRef(gitStatus);
  gitStatusRef.current = gitStatus;
  // 视图模式：默认按子目录聚合成组节点（tab 重挂载时恢复上次模式）
  const [mode, setMode] = useState<DepGraphViewMode>(
    () => getDepGraphViewMode(tabId) ?? 'aggregate'
  );
  // 重命名弹窗：目标文件的项目相对路径 + 输入中的新文件名
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // 悬停信息卡：内容 + 屏幕坐标（鼠标位置由容器 mousemove 持续跟踪）
  const [hoverInfo, setHoverInfo] = useState<{ x: number; y: number; title: string; lines: string[] } | null>(null);
  const lastMouseRef = useRef({ x: 0, y: 0 });
  // 当前画布中处于循环依赖的节点 id（renderMode 重建时重算，悬停信息卡用）
  const cyclicIdsRef = useRef<Set<string>>(new Set());
  const [cycleCount, setCycleCount] = useState(0);
  // 「仅看变更影响」过滤开关（renderMode 经 ref 读取，避免重建闭包失效）
  const [impactOnly, setImpactOnly] = useState(false);
  const impactOnlyRef = useRef(false);
  // 刷新中（按钮转圈，防重复点击）
  const [refreshing, setRefreshing] = useState(false);
  // 布局方向（renderMode 经 ref 读取；tab 重挂载时恢复上次方向）
  const [direction, setDirection] = useState<'TB' | 'LR'>(
    () => getDepGraphDirection(tabId) ?? 'TB'
  );
  const directionRef = useRef(direction);
  // 依赖路径查找：起点节点（非 null 时处于「点击目标节点」状态）
  const [pathSource, setPathSource] = useState<string | null>(null);
  const pathSourceRef = useRef<string | null>(null);
  const updatePathSource = (v: string | null) => {
    pathSourceRef.current = v;
    setPathSource(v);
  };
  // 过滤器栏：扩展名过滤 + 隐藏测试文件（renderMode 经 ref 读取）
  const [extFilter, setExtFilter] = useState('');
  const extFilterRef = useRef('');
  const [hideTests, setHideTests] = useState(false);
  const hideTestsRef = useRef(false);
  // AI 单元测试节点注册表：id → 位置/状态/关联文件（renderMode 重建画布时据此恢复）
  const aiTestRef = useRef(new Map<string, { x: number; y: number; status: AiTestStatus; links: Set<string> }>());
  // 测试报告弹窗内容（单击测试节点或右键「查看测试报告」打开）
  const [reportView, setReportView] = useState<{ title: string; content: string } | null>(null);
  // 测试进行中的报告轮询定时器（testId → interval id）
  const aiTestPollRef = useRef(new Map<string, number>());
  // 「AI 单元测试」物料按钮（注册为 Dnd 拖拽源）
  const aiTestMaterialRef = useRef<HTMLButtonElement>(null);
  const [extOptions, setExtOptions] = useState<string[]>([]);
  // renderMode 声明在 menuActions 之后，用 ref 打通（双击下钻组节点时触发画布重建）
  const renderModeRef = useRef<((graph: Graph, nextMode: DepGraphViewMode) => void) | null>(null);
  // 节点搜索：输入值 + 当前查询的匹配结果（重复点击循环跳转）+ 已高亮节点的原始边框
  const [searchValue, setSearchValue] = useState('');
  const searchQueryRef = useRef('');
  const searchMatchesRef = useRef<string[]>([]);
  const searchIndexRef = useRef(0);
  const highlightRef = useRef<{ nodeId: string; borderColor?: string; borderWidth?: number } | null>(null);

  /** 把 lifeAiCode 面板切到可见（按它当前所在位置条件跳转）：
   *  - 在右侧标签区：只激活对应 tab（switchRightItem 会自动展开右面板），不动左侧路由；
   *    已是激活 tab 且面板可见时不动作
   *  - 在左侧（默认）：已激活且侧栏可见时不重复切换（switchPanel 是 toggle 语义，再调会关掉） */
  const revealLifeAiCode = useCallback(() => {
    const layout = layoutRef.current;
    const item = layout.dockableItems.find((i) => i.id === 'lifeAiCode');
    if (item?.location === 'right') {
      if (!(layout.rightPanelVisible && layout.activeRightItem === 'lifeAiCode')) {
        dispatch(switchRightItem('lifeAiCode'));
      }
      return;
    }
    if (layout.activePanel !== 'lifeAiCode' || !layout.sidePanelVisible) {
      dispatch(switchPanel('lifeAiCode'));
    }
  }, [dispatch]);

  /** 同步测试节点状态到画布（边框色区分 idle/running/done） */
  const updateAiTestNodeStatus = useCallback(
    (testId: string) => {
      const instance = getWorkflowInstance(tabId);
      const info = aiTestRef.current.get(testId);
      const node = instance?.graph.getAllNodes().find((n) => n.getId() === testId);
      if (!node || !info) return;
      node.setData({ ...node.getData(), status: info.status });
      node.updateStyle({ borderColor: AI_TEST_STATUS_BORDER[info.status], borderWidth: 2 });
      instance?.graph.scheduleRender();
    },
    [tabId]
  );

  /** 节点右键菜单动作（节点 id = 文件的项目相对路径，绝对路径 = 根路径 + rel） */
  const menuActions = useMemo<DepGraphMenuActions>(
    () => ({
      resolveFilePath: (nodeId) => {
        const source = getDepGraphSourceData(tabId);
        return source && source.nodes.some((n) => n.id === nodeId) ? nodeId : null;
      },
      onToggleGroup: (groupId) => {
        if ((getDepGraphViewMode(tabId) ?? 'aggregate') !== 'aggregate') return;
        toggleDepGraphExpandedGroup(tabId, groupId);
        const instance = getWorkflowInstance(tabId);
        if (instance) renderModeRef.current?.(instance.graph, 'aggregate');
      },
      onOpenFile: (rel) => {
        const root = rootSourceRef.current;
        if (!root || !isPath(root)) return;
        dispatch(openFile({ source: `${root}/${rel}`, name: rel.split('/').pop() || rel, kind: 'file' }));
      },
      onLocate: (rel) => {
        // switchPanel 是切换语义：资源管理器已激活且侧栏可见时再调会把面板关掉，
        // 仅在需要切换面板或展开侧栏时才调用
        const layout = layoutRef.current;
        if (layout.activePanel !== 'explorer' || !layout.sidePanelVisible) {
          dispatch(switchPanel('explorer'));
        }
        dispatch(expandToFile(rel));
      },
      onHighlightDependents: (rel) => {
        // 反向依赖高亮：入边（谁引用了它）高亮，其余压暗；节点透明度和正向一致
        const instance = getWorkflowInstance(tabId);
        if (!instance) return;
        const keepIds = new Set<string>([rel]);
        for (const edge of instance.graph.getAllEdges()) {
          const srcId = edge.getSourceAnchor().nodeId;
          const isIncoming = edge.getTargetAnchor().nodeId === rel;
          edge.updateStyle(isIncoming ? DEP_EDGE_ACTIVE_STYLE : DEP_EDGE_DIM_STYLE);
          if (isIncoming) keepIds.add(srcId);
        }
        for (const node of instance.graph.getAllNodes()) {
          node.updateStyle({ opacity: keepIds.has(node.getId()) ? 1 : 0.6 });
        }
      },
      onDiff: (rel) => {
        const root = rootSourceRef.current;
        if (!root || !isPath(root)) return;
        void (async () => {
          const fileName = rel.split('/').pop() || rel;
          try {
            const res = await extensionRpc<{
              original: string;
              modified: string;
              isBinary: boolean;
            } | null>('ext.invoke', {
              extId: 'ideacode-git',
              method: 'getWorkingTreeFileDiff',
              args: [{ filePath: rel }],
            });
            if (!res) {
              window.alert(i18n.t('dependencyGraph.diffNoRepo'));
              return;
            }
            if (res.isBinary) {
              // 二进制无法 diff，回退为普通打开（与 extensionBridge git.openFile 行为一致）
              dispatch(openFile({ source: `${root}/${rel}`, name: fileName, kind: 'file' }));
              return;
            }
            const { getLanguageFromPath } = await import('../../utils/languageFromPath');
            dispatch(
              openDiffView({
                filePath: rel,
                fileName,
                original: res.original,
                modified: res.modified,
                language: getLanguageFromPath(fileName),
              })
            );
          } catch (err) {
            console.error('[DependencyGraph] diff 对比失败:', err);
            window.alert(
              i18n.t('dependencyGraph.diffFailed', {
                message: err instanceof Error ? err.message : String(err),
              })
            );
          }
        })();
      },
      onReveal: (rel) => {
        const root = rootSourceRef.current;
        if (!root || !isPath(root)) return;
        revealInExplorer(`${root}/${rel}`).catch((err) => {
          window.alert(
            i18n.t('explorer.errors.revealFailed', {
              message: err instanceof Error ? err.message : String(err),
            })
          );
        });
      },
      onOpenInTerminal: (rel) => {
        const root = rootSourceRef.current;
        if (!root || !isPath(root)) return;
        const abs = `${root}/${rel}`;
        const dir = abs.replace(/[/\\][^/\\]*$/, '') || abs;
        terminalSDK.createTab({ cwd: dir }).catch((err) => {
          window.alert(`打开终端失败: ${err instanceof Error ? err.message : String(err)}`);
        });
      },
      onFindInFiles: (rel) => {
        dispatch(switchPanel('search'));
        dispatch(setPendingSearchQuery(rel.split('/').pop() || rel));
      },
      onCopyPath: (rel) => {
        const root = rootSourceRef.current;
        if (!root || !isPath(root)) return;
        navigator.clipboard.writeText(`${root}/${rel}`).catch(() => {});
      },
      onCopyRelativePath: (rel) => {
        navigator.clipboard.writeText(rel).catch(() => {});
      },
      onRequestRename: (rel) => {
        setRenameTarget(rel);
        setRenameValue(rel.split('/').pop() || rel);
      },
      onSplitGraph: (rel) => {
        // 从当前 tab 的文件级源数据提取直接关联子图，开新依赖图 tab（与资源管理器
        // 「工作流可视化」同套路：预置数据 + openVirtualFile，由新画布挂载时消费）
        const source = getDepGraphSourceData(tabId);
        if (!source) return;
        const sub = extractDirectSubgraph(source, rel);
        if (sub.nodes.length === 0) return;
        const newTabId = `workflow-dep-${Date.now()}`;
        setPendingWorkflowGraphData(newTabId, sub);
        // 拆分图按「文件模式」重建（刷新时取该文件的完整依赖闭包）
        setDepGraphTarget(newTabId, { path: rel, kind: 'file' });
        dispatch(
          openVirtualFile({
            id: newTabId,
            name: t('explorer.contextMenu.workflowVisualizeTab', {
              name: rel.split('/').pop() || rel,
            }),
            source: `workflow://dep/${encodeURIComponent(rel)}`,
            content: '',
            language: 'dependency-graph',
            isDirty: false,
            isPreview: false,
            readOnly: true,
          })
        );
      },
      onNodeHover: (nodeId) => {
        const instance = getWorkflowInstance(tabId);
        if (!instance) return;
        // 出入度按当前渲染的图计算（聚合模式下即组级连线数）
        let outCount = 0;
        let inCount = 0;
        for (const edge of instance.graph.getAllEdges()) {
          if (edge.getSourceAnchor().nodeId === nodeId) outCount++;
          if (edge.getTargetAnchor().nodeId === nodeId) inCount++;
        }
        const lines = [
          t('dependencyGraph.hoverDependsOn', { count: outCount }),
          t('dependencyGraph.hoverUsedBy', { count: inCount }),
        ];
        const status = gitStatusRef.current[nodeId];
        if (status) {
          lines.push(
            t('dependencyGraph.hoverGitStatus', {
              status: i18n.t(`dependencyGraph.git.${status}`, { defaultValue: status }),
            })
          );
        }
        if (cyclicIdsRef.current.has(nodeId)) {
          lines.push(t('dependencyGraph.hoverCyclic'));
        }
        setHoverInfo({ x: lastMouseRef.current.x, y: lastMouseRef.current.y, title: nodeId, lines });
      },
      onNodeLeave: () => {
        setHoverInfo(null);
      },
      onFindPath: (rel) => {
        updatePathSource(rel);
      },
      onAiAnalyze: (rel) => {
        const root = rootSourceRef.current;
        if (!root || !isPath(root)) return;
        const bridge = getExtensionBridge();
        if (!bridge) {
          window.alert(i18n.t('dependencyGraph.aiUnavailable'));
          return;
        }
        // 先切出 AI 面板：sendToHost 的 RPC 要等整条 AI 回复完成才返回，
        // 若 await 之后再切换，面板跳转会被卡住（表现为"点击后没有跳转"）
        revealLifeAiCode();
        void (async () => {
          try {
            // processMessage 是纯对话通道（Agent 工具不可用，模型无法自己去读文件），
            // 因此把文件内容随提示词发送；语言无关——任何文本代码均可解析。
            // 超大文件截断，避免提示词过长
            const MAX_CONTENT = 20000;
            let content = await readFile(`${root}/${rel}`);
            const truncated = content.length > MAX_CONTENT;
            if (truncated) content = content.slice(0, MAX_CONTENT);
            const ext = rel.split('.').pop() || '';
            const prompt = [
              `请解析文件 ${rel} 的代码，用中文输出分析报告：`,
              '1. 代码结构：主要导出、类/函数/组件及其职责；',
              '2. 关键类型/接口/数据结构定义；',
              '3. 潜在问题与可优化点（性能、可读性、健壮性），按优先级列出。',
              '',
              truncated ? `（文件过大，以下仅为前 ${MAX_CONTENT} 字符，请说明分析基于部分内容）` : '',
              `\`\`\`${ext}`,
              content,
              '```',
            ]
              .filter(Boolean)
              .join('\n');
            await bridge.sendToHost('lifeAiCode.internal.processMessage', {
              text: prompt,
              context: null,
            });
          } catch (err) {
            window.alert(
              i18n.t('dependencyGraph.aiFailed', {
                message: err instanceof Error ? err.message : String(err),
              })
            );
          }
        })();
      },
      onAddToAi: (rel) => {
        const root = rootSourceRef.current;
        if (!root || !isPath(root)) return;
        const bridge = getExtensionBridge();
        if (!bridge) {
          window.alert(i18n.t('dependencyGraph.aiUnavailable'));
          return;
        }
        // 芯片携带绝对路径：相对路径会让 Agent 的 read_file 在工作区根目录拼接时
        // 出现解析歧义（模型反复试探路径），绝对路径无歧义、可直接读取
        const absPath = `${root}/${rel}`;
        // 先切出 AI 面板；延迟发送——若面板是本次才被激活创建的，
        // webview 需要时间完成挂载，否则 addMention 消息会丢失
        revealLifeAiCode();
        window.setTimeout(() => {
          bridge
            .sendToHost('lifeAiCode.internal.addMention', {
              file: { name: rel.split('/').pop() || rel, path: absPath, isDirectory: false },
            })
            .catch((err: unknown) =>
              window.alert(
                i18n.t('dependencyGraph.aiFailed', {
                  message: err instanceof Error ? err.message : String(err),
                })
              )
            );
        }, 300);
      },
      onAiTestDrop: (testId, x, y) => {
        // 合并语义：拖入时新建登记，拖动后仅更新位置（保留状态与关联）
        const prev = aiTestRef.current.get(testId);
        aiTestRef.current.set(testId, {
          x,
          y,
          status: prev?.status ?? 'idle',
          links: prev?.links ?? new Set(),
        });
      },
      onAiTestLink: (testId, fileId) => {
        aiTestRef.current.get(testId)?.links.add(fileId);
      },
      getAiTestInfo: (testId) => {
        const info = aiTestRef.current.get(testId);
        return info ? { links: [...info.links], status: info.status } : null;
      },
      onAiTestStart: (testId) => {
        const root = rootSourceRef.current;
        const info = aiTestRef.current.get(testId);
        if (!info || info.links.size === 0 || !root || !isPath(root)) return;
        const bridge = getExtensionBridge();
        if (!bridge) {
          window.alert(i18n.t('dependencyGraph.aiUnavailable'));
          return;
        }
        const reportPath = `${root}/.ideacode/ai-test-report-${testId}.md`;
        // 运行令牌：报告首行标记，轮询据此区分本次运行与历史残留报告
        const runToken = `ai-test-run:${testId}:${Date.now()}`;
        const absFiles = [...info.links].map((rel) => `${root}/${rel}`);
        const prompt = [
          `请为以下 ${absFiles.length} 个文件编写单元测试并实际运行，要求：`,
          '1. 先查看项目的测试框架配置（如 package.json 的 test 脚本、jest/vitest/pytest 配置等），沿用项目已有的测试框架与目录约定；若项目没有测试框架，选择该语言最主流的方案并说明；',
          '2. 为每个文件编写覆盖主要逻辑的单元测试代码，保存到合适的测试文件中；',
          '3. 运行测试命令；若失败，分析原因并修复后重跑（最多重试 2 轮），不要改动与测试无关的业务逻辑；',
          `4. 最后将完整的测试报告（被测文件、测试文件清单、运行的命令、通过/失败统计、失败原因与修复说明、总体结论）以 Markdown 格式写入文件：${reportPath}，报告第一行必须是 <!-- ${runToken} -->；`,
          '',
          '被测文件（绝对路径）：',
          ...absFiles.map((p) => `- ${p}`),
        ].join('\n');
        info.status = 'running';
        updateAiTestNodeStatus(testId);
        // 先切出 AI 面板；延迟发送——若面板是本次才被激活创建的，webview 需要时间完成挂载
        revealLifeAiCode();
        window.setTimeout(() => {
          bridge
            .sendToHost('lifeAiCode.internal.runAgent', { text: prompt })
            .catch((err: unknown) =>
              window.alert(
                i18n.t('dependencyGraph.aiFailed', {
                  message: err instanceof Error ? err.message : String(err),
                })
              )
            );
        }, 300);
        // 轮询报告文件：Agent 任务是 fire-and-forget，无完成回调；
        // 报告含本次运行令牌才算完成（避免历史残留报告误判），15 分钟超时停止
        const oldTimer = aiTestPollRef.current.get(testId);
        if (oldTimer) window.clearInterval(oldTimer);
        const startedAt = Date.now();
        const timer = window.setInterval(() => {
          void (async () => {
            try {
              const content = await readFile(reportPath);
              if (content.includes(runToken)) {
                const cur = aiTestRef.current.get(testId);
                if (cur) {
                  cur.status = 'done';
                  updateAiTestNodeStatus(testId);
                }
                window.clearInterval(timer);
                aiTestPollRef.current.delete(testId);
              }
            } catch {
              // 报告尚未生成，继续轮询
            }
            if (Date.now() - startedAt > 15 * 60 * 1000) {
              window.clearInterval(timer);
              aiTestPollRef.current.delete(testId);
            }
          })();
        }, 5000);
        aiTestPollRef.current.set(testId, timer);
      },
      onAiTestViewReport: (testId) => {
        const root = rootSourceRef.current;
        if (!root || !isPath(root)) return;
        const info = aiTestRef.current.get(testId);
        void (async () => {
          try {
            const content = await readFile(`${root}/.ideacode/ai-test-report-${testId}.md`);
            setReportView({ title: i18n.t('dependencyGraph.aiTest.reportTitle'), content });
          } catch {
            setReportView({
              title: i18n.t('dependencyGraph.aiTest.reportTitle'),
              content:
                info?.status === 'running'
                  ? i18n.t('dependencyGraph.aiTest.reportRunning')
                  : i18n.t('dependencyGraph.aiTest.reportMissing'),
            });
          }
        })();
      },
      onAiTestClearLinks: (testId) => {
        const instance = getWorkflowInstance(tabId);
        if (!instance) return;
        for (const edge of instance.graph.getAllEdges()) {
          if (!isAiTestLink(edge)) continue;
          const s = edge.getSourceAnchor().nodeId;
          const t2 = edge.getTargetAnchor().nodeId;
          if (s === testId || t2 === testId) instance.graph.removeEdge(edge.getId());
        }
        const info = aiTestRef.current.get(testId);
        if (info) {
          info.links.clear();
          info.status = 'idle';
        }
        updateAiTestNodeStatus(testId);
      },
      onAiTestDelete: (testId) => {
        const timer = aiTestPollRef.current.get(testId);
        if (timer) {
          window.clearInterval(timer);
          aiTestPollRef.current.delete(testId);
        }
        aiTestRef.current.delete(testId);
        getWorkflowInstance(tabId)?.graph.removeNode(testId);
      },
      getPathSource: () => pathSourceRef.current,
      onPickPathTarget: (targetId) => {
        const source = pathSourceRef.current;
        updatePathSource(null);
        if (!source) return;
        const instance = getWorkflowInstance(tabId);
        if (!instance) return;
        // 在当前渲染的图上找最短依赖路径（正向不可达自动试反向）
        const renderedEdges = instance.graph.getAllEdges().map((e) => ({
          id: e.getId(),
          label: '',
          source: e.getSourceAnchor(),
          target: e.getTargetAnchor(),
        }));
        const path = findDependencyPath(renderedEdges, source, targetId);
        if (!path) {
          window.alert(t('dependencyGraph.pathNotFound'));
          return;
        }
        const onPath = new Set(path);
        const pathEdgeKeys = new Set<string>();
        for (let i = 0; i < path.length - 1; i++) {
          pathEdgeKeys.add(`${path[i]}->${path[i + 1]}`);
        }
        for (const edge of instance.graph.getAllEdges()) {
          const key = `${edge.getSourceAnchor().nodeId}->${edge.getTargetAnchor().nodeId}`;
          edge.updateStyle(pathEdgeKeys.has(key) ? DEP_EDGE_ACTIVE_STYLE : DEP_EDGE_DIM_STYLE);
        }
        for (const node of instance.graph.getAllNodes()) {
          node.updateStyle({ opacity: onPath.has(node.getId()) ? 1 : 0.6 });
        }
      },
      cancelPathPick: () => {
        updatePathSource(null);
      },
    }),
    [tabId, dispatch, t, revealLifeAiCode, updateAiTestNodeStatus]
  );
  // Graph 实例跨组件挂载复用，闭包经此 ref 始终拿到最新动作集（见 createDepGraphInstance）
  const menuActionsRef = useRef(menuActions);
  menuActionsRef.current = menuActions;

  /** 按模式从文件级源数据重建画布（聚合 / 全量两种视图共用一份源数据） */
  const renderMode = useCallback(
    (graph: Graph, nextMode: DepGraphViewMode) => {
      const source = getDepGraphSourceData(tabId);
      if (!source) return;
      // 画布重建后旧节点全部销毁：搜索匹配缓存与高亮状态一并失效
      searchQueryRef.current = '';
      searchMatchesRef.current = [];
      highlightRef.current = null;
      // 「仅看变更影响」：先把源数据裁剪为变更文件 + 直接关联文件的子图
      let effective = impactOnlyRef.current
        ? filterChangedImpact(source, gitStatusRef.current)
        : source;
      // 过滤器栏：扩展名过滤 / 隐藏测试文件（与变更影响过滤串联）
      if (extFilterRef.current) {
        const ext = extFilterRef.current;
        effective = filterGraphNodes(effective, (id) => extOfPath(id) === ext);
      }
      if (hideTestsRef.current) {
        effective = filterGraphNodes(effective, (id) => !isTestFilePath(id));
      }
      // 过滤器下拉的可选扩展名集合随源数据刷新
      setExtOptions(
        [...new Set(source.nodes.map((n) => extOfPath(n.id)).filter(Boolean))].sort()
      );
      const data = relayoutGraphData(
        nextMode === 'aggregate'
          ? aggregateByDirectory(effective, getDepGraphExpandedGroups(tabId))
          : effective,
        directionRef.current
      );
      graph.clearEdges();
      graph.clearNodes();
      loadGraphFromData(graph, data, tabId);
      // 恢复 AI 单元测试节点及其连线（上方 clearNodes/clearEdges 已销毁全部图元）；
      // 连线重建会触发 edge:add 监听（自动打标记/配色/登记，幂等）
      for (const [testId, info] of aiTestRef.current) {
        const testNode = graph.addNode({
          id: testId,
          label: i18n.t('dependencyGraph.aiTest.nodeLabel'),
          x: info.x,
          y: info.y,
          style: {
            ...AI_TEST_NODE_STYLE,
            borderColor: AI_TEST_STATUS_BORDER[info.status],
            borderWidth: info.status === 'idle' ? 1.5 : 2,
          },
          portsAlwaysVisible: false,
          data: { kind: 'aiTest', status: info.status },
        });
        addDefaultPorts(testNode, getEffectiveConfig(tabId));
        for (const fileId of info.links) {
          // 被过滤（扩展名/隐藏测试文件/变更影响）掉的文件节点不存在，跳过其连线
          if (!graph.getAllNodes().some((n) => n.getId() === fileId)) continue;
          graph.addEdge({
            id: `aitest-${testId}--${fileId}`,
            source: { nodeId: testId },
            target: { nodeId: fileId },
            type: EdgeType.Bezier,
          });
        }
      }
      // 依赖连线统一为直线 + 固定配色（直线无采样/跳线计算开销，大数据量下保证流畅）
      for (const edge of graph.getAllEdges()) {
        // 测试连线保持自己的紫色贝塞尔体系，不被依赖边样式覆盖
        if (isAiTestLink(edge)) continue;
        edge.setType(EdgeType.Straight);
        edge.updateStyle(DEP_EDGE_STYLE);
      }
      // 重建的节点默认无角标：按当前 git 状态重新挂载
      applyGitStatusBadges(graph, gitStatusRef.current);
      // 循环依赖检测：处于环上的节点红框警示（聚合模式下即目录级循环）
      const cyclic = findCyclicNodeIds(data.edges);
      cyclicIdsRef.current = cyclic;
      setCycleCount(cyclic.size);
      for (const node of graph.getAllNodes()) {
        if (cyclic.has(node.getId())) {
          node.updateStyle({ borderColor: CYCLE_BORDER, borderWidth: 2 });
        }
      }
      fitContent(graph);
    },
    [tabId]
  );
  renderModeRef.current = renderMode;

  // git 状态变化（web/git 扩展异步推送）时同步到现有画布节点
  useEffect(() => {
    const instance = getWorkflowInstance(tabId);
    if (instance) applyGitStatusBadges(instance.graph, gitStatus);
  }, [gitStatus, tabId]);

  /** 重命名确认：磁盘改名 + 同步改写全部引入，再更新图数据并重建画布、刷新资源管理器 */
  const handleRenameConfirm = useCallback(async () => {
    if (!renameTarget) return;
    const root = rootSourceRef.current;
    const oldName = renameTarget.split('/').pop() || renameTarget;
    const newName = renameValue.trim();
    if (!newName || newName === oldName) {
      setRenameTarget(null);
      return;
    }
    if (!root || !isPath(root)) {
      setRenameTarget(null);
      return;
    }
    const dir = renameTarget.includes('/')
      ? renameTarget.slice(0, renameTarget.lastIndexOf('/'))
      : '';
    const parentSource = dir ? `${root}/${dir}` : root;
    if (await exists(parentSource, newName)) {
      window.alert(t('explorer.errors.nameExists', { name: newName }));
      return; // 保留弹窗，让用户改名后重试
    }
    try {
      const { newRel } = await renameFileWithImportSync(
        root,
        allFilePathsRef.current,
        renameTarget,
        newName
      );
      // 源数据同步改名（纯数据推导，不重新分析），随后按当前模式重建画布
      const source = getDepGraphSourceData(tabId);
      if (source) {
        setDepGraphSourceData(tabId, renameNodeInGraphData(source, renameTarget, newRel));
      }
      dispatch(refreshAllFilePaths());
      dispatch(refreshDirectory(root));
      setRenameTarget(null);
      const instance = getWorkflowInstance(tabId);
      if (instance) renderMode(instance.graph, getDepGraphViewMode(tabId) ?? 'aggregate');
    } catch (err) {
      console.error('[DependencyGraph] 重命名失败:', err);
      window.alert(t('explorer.errors.renameFailed'));
    }
  }, [renameTarget, renameValue, tabId, dispatch, renderMode, t]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let instance = getWorkflowInstance(tabId);
    if (!instance) {
      instance = createDepGraphInstance(tabId, container, menuActionsRef);
      setWorkflowInstance(tabId, instance);
    } else if (instance.host.parentElement !== container) {
      // 重挂载（tab 切换回来）：把已有画布宿主 DOM 挂到新容器，并补一帧渲染
      // （隐藏期间若错过 resize/渲染，避免画布残留旧帧或空白）
      container.appendChild(instance.host);
      instance.graph.scheduleRender();
    }
    const current = instance;

    // 挂载后把预置的依赖图数据灌入画布（一次性消费，重复挂载不会重复灌入）
    const pending = consumePendingWorkflowGraphData(tabId);
    if (pending) {
      // 留存文件级源数据：模式切换时直接重建，无需重新读文件
      setDepGraphSourceData(tabId, pending);
      renderMode(current.graph, getDepGraphViewMode(tabId) ?? 'aggregate');
    }
  }, [tabId, renderMode, menuActions]);

  // 「AI 单元测试」物料：注册为 Dnd 拖拽源（上方挂载 effect 已保证实例存在）
  useEffect(() => {
    const el = aiTestMaterialRef.current;
    const instance = getWorkflowInstance(tabId);
    if (!el || !instance) return;
    return instance.dnd.registerSource(el, {
      id: 'ai-test-draft',
      label: t('dependencyGraph.aiTest.nodeLabel'),
      x: 0,
      y: 0,
      style: AI_TEST_NODE_STYLE,
      portsAlwaysVisible: false,
      data: { kind: 'aiTest' },
    });
  }, [tabId, t]);

  /** 还原搜索高亮：把上一个命中节点的边框恢复为原始样式 */
  const clearSearchHighlight = useCallback(() => {
    const prev = highlightRef.current;
    if (!prev) return;
    highlightRef.current = null;
    const instance = getWorkflowInstance(tabId);
    const prevNode = instance?.graph.getAllNodes().find((n) => n.getId() === prev.nodeId);
    if (prevNode) {
      prevNode.updateStyle({ borderColor: prev.borderColor, borderWidth: prev.borderWidth });
    }
  }, [tabId]);

  /** 刷新：按打开时记录的构图目标重新分析（读盘重算依赖），并重建画布 */
  const handleRefresh = useCallback(async () => {
    const target = getDepGraphTarget(tabId);
    const root = rootSourceRef.current;
    if (!target || !root || !isPath(root) || refreshing) return;
    setRefreshing(true);
    try {
      const data = await buildDependencyGraph(root, allFilePathsRef.current, target);
      if (data.nodes.length === 0) {
        window.alert(t('explorer.contextMenu.workflowVisualizeEmpty'));
        return;
      }
      setDepGraphSourceData(tabId, data);
      // 下钻展开状态可能引用已消失的目录，重建后重置回初始聚合视图
      resetDepGraphExpandedGroups(tabId);
      const instance = getWorkflowInstance(tabId);
      if (instance) renderMode(instance.graph, getDepGraphViewMode(tabId) ?? 'aggregate');
    } finally {
      setRefreshing(false);
    }
  }, [tabId, refreshing, renderMode, t]);

  /** 导出 Mermaid：把文件级源数据转成 graph TD 文本复制到剪贴板（粘贴到 Markdown 即可渲染） */
  const handleExportMermaid = useCallback(() => {
    const source = getDepGraphSourceData(tabId);
    if (!source) return;
    navigator.clipboard
      .writeText(toMermaid(source))
      .then(() => window.alert(t('dependencyGraph.mermaidCopied')))
      .catch(() => {});
  }, [tabId, t]);

  /** 重新灌图：过滤/方向类切换的公共收尾（清搜索并按当前模式重建） */
  const rerender = useCallback(() => {
    setSearchValue('');
    clearSearchHighlight();
    const instance = getWorkflowInstance(tabId);
    if (instance) renderMode(instance.graph, getDepGraphViewMode(tabId) ?? 'aggregate');
  }, [tabId, renderMode, clearSearchHighlight]);

  /** 布局方向切换：上下 ⇢ 左右（重排坐标并重建画布） */
  const handleDirectionToggle = useCallback(() => {
    const next = directionRef.current === 'TB' ? 'LR' : 'TB';
    directionRef.current = next;
    setDirection(next);
    setDepGraphDirection(tabId, next);
    rerender();
  }, [tabId, rerender]);

  /** 扩展名过滤变更（'' = 全部类型） */
  const handleExtFilterChange = useCallback(
    (ext: string) => {
      extFilterRef.current = ext;
      setExtFilter(ext);
      rerender();
    },
    [rerender]
  );

  /** 隐藏测试文件开关 */
  const handleHideTestsToggle = useCallback(() => {
    const next = !hideTestsRef.current;
    hideTestsRef.current = next;
    setHideTests(next);
    rerender();
  }, [rerender]);

  /** AI 解读架构：把依赖统计与边列表发给 lifeAiCode，并切出 AI 面板 */
  const handleAiExplain = useCallback(() => {
    const source = getDepGraphSourceData(tabId);
    if (!source) return;
    const bridge = getExtensionBridge();
    if (!bridge) {
      window.alert(t('dependencyGraph.aiUnavailable'));
      return;
    }
    // 枢纽文件：被引用次数前 5
    const inDegree = new Map<string, number>();
    for (const e of source.edges) {
      inDegree.set(e.target.nodeId, (inDegree.get(e.target.nodeId) ?? 0) + 1);
    }
    const hubs = [...inDegree.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const cyclic = findCyclicNodeIds(source.edges);
    // 超大图截断边列表，避免提示词过长
    const MAX_EDGES = 300;
    const edgeLines = source.edges
      .slice(0, MAX_EDGES)
      .map((e) => `${e.source.nodeId} -> ${e.target.nodeId}`);
    const prompt = [
      '请分析以下项目依赖关系，用中文生成架构解读：',
      '1. 按路径推断主要模块/层次及其职责；',
      '2. 指出枢纽文件及其作用；',
      cyclic.size > 0
        ? `3. 图中检测到循环依赖，涉及：${[...cyclic].slice(0, 20).join('、')}，请分析原因与改进建议。`
        : '3. 评价依赖结构的健康度并给出改进建议。',
      '',
      `共 ${source.nodes.length} 个文件、${source.edges.length} 条依赖${
        source.edges.length > MAX_EDGES ? `（仅列出前 ${MAX_EDGES} 条）` : ''
      }。`,
      hubs.length > 0
        ? `被引用最多的文件：${hubs.map(([id, c]) => `${id}（${c} 次）`).join('、')}`
        : '',
      '',
      '依赖列表（A -> B 表示 A 依赖 B）：',
      ...edgeLines,
    ]
      .filter(Boolean)
      .join('\n');
    bridge
      .sendToHost('lifeAiCode.internal.processMessage', { text: prompt, context: null })
      .catch((err: unknown) =>
        window.alert(
          t('dependencyGraph.aiFailed', {
            message: err instanceof Error ? err.message : String(err),
          })
        )
      );
    // 切出 AI 面板（按 lifeAiCode 当前所在位置条件跳转：右侧标签区只激活 tab）
    revealLifeAiCode();
  }, [tabId, t, revealLifeAiCode]);

  /** 「仅看变更影响」开关：开启时只保留 git 变更文件及其直接上下游 */
  const handleImpactToggle = useCallback(() => {    const next = !impactOnlyRef.current;
    if (next) {
      const source = getDepGraphSourceData(tabId);
      const hasChanged =
        source && Object.keys(gitStatusRef.current).some((p) => source.nodes.some((n) => n.id === p));
      if (!hasChanged) {
        window.alert(t('dependencyGraph.impactEmpty'));
        return;
      }
    }
    impactOnlyRef.current = next;
    setImpactOnly(next);
    // 重建后旧节点销毁：清空搜索输入与高亮（与模式切换同处理）
    setSearchValue('');
    clearSearchHighlight();
    const instance = getWorkflowInstance(tabId);
    if (instance) renderMode(instance.graph, getDepGraphViewMode(tabId) ?? 'aggregate');
  }, [tabId, renderMode, clearSearchHighlight, t]);

  const handleModeChange = (nextMode: DepGraphViewMode) => {
    // 切换/重置视图都会重建画布：清空搜索输入并撤销高亮（旧节点销毁，匹配结果已失效）
    setSearchValue('');
    clearSearchHighlight();
    // 已处于聚合模式时再点一次 = 收起全部已下钻的组，回到初始聚合视图
    if (nextMode === mode) {
      if (nextMode === 'aggregate') {
        resetDepGraphExpandedGroups(tabId);
        const instance = getWorkflowInstance(tabId);
        if (instance) renderMode(instance.graph, 'aggregate');
      }
      return;
    }
    setMode(nextMode);
    setDepGraphViewMode(tabId, nextMode);
    const instance = getWorkflowInstance(tabId);
    if (instance) renderMode(instance.graph, nextMode);
  };

  /** 搜索定位：匹配当前画布节点（id/标签，忽略大小写包含匹配），平滑居中并高亮边框；
   *  同一查询重复点击在多个匹配间循环跳转；查询为空时仅清除已有高亮 */
  const handleSearch = useCallback(() => {
    const query = searchValue.trim().toLowerCase();
    const instance = getWorkflowInstance(tabId);
    if (!query || !instance) {
      clearSearchHighlight();
      searchQueryRef.current = '';
      searchMatchesRef.current = [];
      return;
    }
    const graph = instance.graph;

    if (query !== searchQueryRef.current) {
      searchQueryRef.current = query;
      searchMatchesRef.current = graph
        .getAllNodes()
        .filter(
          (n) =>
            n.getId().toLowerCase().includes(query) ||
            n.getLabel().toLowerCase().includes(query)
        )
        .map((n) => n.getId());
      searchIndexRef.current = 0;
    }
    const matches = searchMatchesRef.current;
    if (matches.length === 0) {
      window.alert(i18n.t('dependencyGraph.searchNoMatch', { query: searchValue.trim() }));
      return;
    }
    const nodeId = matches[searchIndexRef.current % matches.length];
    searchIndexRef.current += 1;
    const node = graph.getAllNodes().find((n) => n.getId() === nodeId);
    if (!node) return;

    // 居中：节点世界坐标中心 → 画布中心（保持当前缩放，平滑平移过去）
    const { scale } = graph.getTransform();
    const pos = node.getPosition();
    const rect = instance.host.getBoundingClientRect();
    void graph.panTo({
      x: rect.width / 2 - pos.x * scale,
      y: rect.height / 2 - pos.y * scale,
    });

    // 高亮命中节点边框（先还原上一个命中节点的原始边框）
    clearSearchHighlight();
    const style = node.getStyle();
    highlightRef.current = { nodeId, borderColor: style.borderColor, borderWidth: style.borderWidth };
    node.updateStyle({ borderColor: SEARCH_HIGHLIGHT_BORDER, borderWidth: 2 });
  }, [searchValue, tabId, clearSearchHighlight]);

  return (
    <div
      ref={containerRef}
      className="dependency-graph-canvas"
      onMouseMove={(e) => {
        lastMouseRef.current = { x: e.clientX, y: e.clientY };
      }}
    >
      <div className="dependency-graph-canvas__toolbar">
        <div className="dependency-graph-canvas__mode-switch">
          <button
            type="button"
            className={mode === 'aggregate' ? 'is-active' : ''}
            title={t('dependencyGraph.modeAggregate')}
            onClick={() => handleModeChange('aggregate')}
          >
            <FolderTree size={13} strokeWidth={1.5} />
          </button>
          <button
            type="button"
            className={mode === 'files' ? 'is-active' : ''}
            title={t('dependencyGraph.modeFiles')}
            onClick={() => handleModeChange('files')}
          >
            <Files size={13} strokeWidth={1.5} />
          </button>
        </div>
        <div className="dependency-graph-canvas__search">
          <input
            value={searchValue}
            placeholder={t('dependencyGraph.searchPlaceholder')}
            onChange={(e) => {
              setSearchValue(e.target.value);
              // 清空输入时同步撤掉节点高亮，不必再点一次搜索
              if (!e.target.value.trim()) clearSearchHighlight();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSearch();
            }}
          />
          <button
            type="button"
            className="dependency-graph-canvas__search-btn"
            title={t('dependencyGraph.searchPlaceholder')}
            onClick={handleSearch}
          >
            <Search size={13} strokeWidth={1.5} />
          </button>
        </div>
        <button
          type="button"
          className={`dependency-graph-canvas__tool-btn${impactOnly ? ' is-active' : ''}`}
          title={t('dependencyGraph.impactOnly')}
          onClick={handleImpactToggle}
        >
          <Filter size={13} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          className="dependency-graph-canvas__tool-btn"
          title={t('dependencyGraph.refresh')}
          disabled={refreshing || !getDepGraphTarget(tabId)}
          onClick={() => void handleRefresh()}
        >
          <RefreshCw
            size={13}
            strokeWidth={1.5}
            className={refreshing ? 'dependency-graph-canvas__spin' : undefined}
          />
        </button>
        <button
          type="button"
          className="dependency-graph-canvas__tool-btn"
          title={t('dependencyGraph.exportMermaid')}
          onClick={handleExportMermaid}
        >
          <FileDown size={13} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          className="dependency-graph-canvas__tool-btn"
          title={t(direction === 'TB' ? 'dependencyGraph.directionToLR' : 'dependencyGraph.directionToTB')}
          onClick={handleDirectionToggle}
        >
          {direction === 'TB' ? (
            <ArrowRightLeft size={13} strokeWidth={1.5} />
          ) : (
            <ArrowDownUp size={13} strokeWidth={1.5} />
          )}
        </button>
        <select
          className="dependency-graph-canvas__ext-select"
          title={t('dependencyGraph.filterAllTypes')}
          value={extFilter}
          onChange={(e) => handleExtFilterChange(e.target.value)}
        >
          <option value="">{t('dependencyGraph.filterAllTypes')}</option>
          {extOptions.map((ext) => (
            <option key={ext} value={ext}>
              {ext}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={`dependency-graph-canvas__tool-btn${hideTests ? ' is-active' : ''}`}
          title={t('dependencyGraph.hideTests')}
          onClick={handleHideTestsToggle}
        >
          <FlaskConical size={13} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          className="dependency-graph-canvas__tool-btn"
          title={t('dependencyGraph.aiExplain')}
          onClick={handleAiExplain}
        >
          <Sparkles size={13} strokeWidth={1.5} />
        </button>
        <button
          ref={aiTestMaterialRef}
          type="button"
          className="dependency-graph-canvas__tool-btn dependency-graph-canvas__ai-test-material"
          title={t('dependencyGraph.aiTest.materialHint')}
        >
          <TestTube2 size={13} strokeWidth={1.5} />
        </button>
        {cycleCount > 0 && (
          <span className="dependency-graph-canvas__cycle-warning">
            {t('dependencyGraph.cycleWarning', { count: cycleCount })}
          </span>
        )}
      </div>
      {pathSource && (
        <div className="dependency-graph-canvas__path-hint">
          <span>
            {t('dependencyGraph.pathPickHint', { name: pathSource.split('/').pop() || pathSource })}
          </span>
          <button type="button" onClick={() => updatePathSource(null)}>
            ×
          </button>
        </div>
      )}
      {hoverInfo && (
        <div
          className="dependency-graph-canvas__tooltip"
          style={{ left: hoverInfo.x + 14, top: hoverInfo.y + 14 }}
        >
          <div className="dependency-graph-canvas__tooltip-title">{hoverInfo.title}</div>
          {hoverInfo.lines.map((line, i) => (
            <div key={i} className="dependency-graph-canvas__tooltip-line">
              {line}
            </div>
          ))}
        </div>
      )}
      {reportView && (
        <div
          className="dependency-graph-canvas__modal-mask"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setReportView(null);
          }}
        >
          <div className="dependency-graph-canvas__modal dependency-graph-canvas__modal--report">
            <div className="dependency-graph-canvas__modal-title">{reportView.title}</div>
            <pre className="dependency-graph-canvas__report-content">{reportView.content}</pre>
            <div className="dependency-graph-canvas__modal-actions">
              <button type="button" className="is-primary" onClick={() => setReportView(null)}>
                {t('close')}
              </button>
            </div>
          </div>
        </div>
      )}
      {renameTarget && (
        <div
          className="dependency-graph-canvas__modal-mask"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setRenameTarget(null);
          }}
        >
          <div className="dependency-graph-canvas__modal">
            <div className="dependency-graph-canvas__modal-title">{t('rename')}</div>
            <input
              className="dependency-graph-canvas__modal-input"
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleRenameConfirm();
                if (e.key === 'Escape') setRenameTarget(null);
              }}
            />
            <div className="dependency-graph-canvas__modal-actions">
              <button type="button" onClick={() => setRenameTarget(null)}>
                {t('cancel')}
              </button>
              <button
                type="button"
                className="is-primary"
                onClick={() => void handleRenameConfirm()}
              >
                {t('confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DependencyGraphCanvas;
