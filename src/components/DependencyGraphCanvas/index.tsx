import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Graph,
  EdgeType,
  Selection,
  Dnd,
  Tools,
  Dropdown,
  type Node,
  type Edge,
} from '../../workflow';
import i18n from '../../i18n';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import {
  openFile,
  expandToFile,
  openDiffView,
  refreshAllFilePaths,
  refreshDirectory,
  setPendingSearchQuery,
} from '../../store/slices/workspaceSlice';
import { switchPanel } from '../../store/slices/layoutSlice';
import { extensionRpc, isPath } from '../../services/fileService';
import { exists, revealInExplorer } from '../../services/fileOperations';
import { terminalSDK } from '../../services/terminalSDK';
import {
  getWorkflowInstance,
  setWorkflowInstance,
  consumePendingWorkflowGraphData,
  setDepGraphSourceData,
  getDepGraphSourceData,
  setDepGraphViewMode,
  getDepGraphViewMode,
  type DepGraphViewMode,
  type WorkflowInstance,
} from '../../services/workflowRuntime';
import { loadGraphFromData } from '../../services/workflowPersistence';
import {
  aggregateByDirectory,
  renameFileWithImportSync,
  renameNodeInGraphData,
} from '../../services/dependencyGraph';
import './DependencyGraphCanvas.css';

/** 节点右键菜单的动作集：由 React 侧提供（需要 dispatch / 终端 / 弹窗等能力） */
interface DepGraphMenuActions {
  /** 节点 id → 文件的项目相对路径；非文件节点（聚合组）返回 null（不弹菜单） */
  resolveFilePath: (nodeId: string) => string | null;
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

/**
 * 创建依赖可视化 scope 的 Graph 实例（把 workflow 引擎当 SDK 用，
 * 只装配只读浏览所需的插件，不接物料面板 / 样式配置服务）。
 * 实例缓存在 workflowRuntime 注册表中，tab 切换只 reparent 宿主 DOM，不销毁。
 */
function createDepGraphInstance(
  _scope: string,
  parent: HTMLElement,
  menuActions: DepGraphMenuActions
): WorkflowInstance {
  const host = document.createElement('div');
  host.className = 'dependency-graph-canvas__host';
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
  });

  // 只读浏览：框选 / 工具栏（无撤销重做、无搜索；小地图意义不大且每帧有额外开销，不装）
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

  // 依赖可视化不接收物料拖入；仅为满足 WorkflowInstance 结构创建，不挂到 Graph
  const dnd = new Dnd({ enabled: false });

  // 节点右键菜单（暗色风格，与资源管理器右键菜单一致）：
  // 仅文件节点弹菜单（聚合组节点 resolveFilePath 返回 null）；标签在点击时取当前语言
  graph.use(
    new Dropdown({
      menuWidth: 170,
      backgroundColor: '#252526',
      textColor: '#cccccc',
      hoverColor: '#37373d',
      borderColor: '#3c3c3c',
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.45)',
      nodeMenu: (node) => {
        const rel = menuActions.resolveFilePath(node.getId());
        if (!rel) return [];
        return [
          // 顶部提示：完整相对路径（纯展示，节点上可能因截断看不清全路径）
          { label: rel, header: true, action: () => {} },
          {
            label: i18n.t('dependencyGraph.openFile'),
            action: () => menuActions.onOpenFile(rel),
          },
          {
            label: i18n.t('dependencyGraph.locate'),
            action: () => menuActions.onLocate(rel),
          },
          {
            label: i18n.t('dependencyGraph.diffCompare'),
            action: () => menuActions.onDiff(rel),
          },
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
          {
            label: i18n.t('explorer.contextMenu.copyPath'),
            action: () => menuActions.onCopyPath(rel),
          },
          {
            label: i18n.t('explorer.contextMenu.copyRelativePath'),
            action: () => menuActions.onCopyRelativePath(rel),
          },
          { label: i18n.t('rename'), action: () => menuActions.onRequestRename(rel) },
        ];
      },
    })
  );

  // 选中节点时只高亮其「出边」（它引用的子节点方向），父节点方向的入边压暗；
  // 同时压暗无关节点（子节点保持不透明）
  graph.on('node:selected', (data: { node?: Node }) => {
    const selectedId = data.node?.getId();
    if (!selectedId) return;
    const neighborIds = new Set<string>([selectedId]);
    for (const edge of graph.getAllEdges()) {
      const srcId = edge.getSourceAnchor().nodeId;
      const tgtId = edge.getTargetAnchor().nodeId;
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

  // 点击连线时同款处理：高亮该连线、压暗其余连线，仅两端节点保持不透明
  graph.on('edge:click', (data: { edge?: Edge }) => {
    const clickedId = data.edge?.getId();
    if (!clickedId || !data.edge) return;
    const endpointIds = new Set<string>([
      data.edge.getSourceAnchor().nodeId,
      data.edge.getTargetAnchor().nodeId,
    ]);
    for (const edge of graph.getAllEdges()) {
      edge.updateStyle(edge.getId() === clickedId ? DEP_EDGE_ACTIVE_STYLE : DEP_EDGE_DIM_STYLE);
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
    for (const edge of graph.getAllEdges()) {
      edge.updateStyle(DEP_EDGE_STYLE);
    }
    for (const node of graph.getAllNodes()) {
      node.updateStyle({ opacity: 1 });
    }
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
  // 菜单动作在实例创建时被捕获（实例跨渲染缓存），用 ref 保证始终读到最新的根路径/文件清单
  const rootSourceRef = useRef(rootSource);
  rootSourceRef.current = rootSource;
  const allFilePathsRef = useRef(allFilePaths);
  allFilePathsRef.current = allFilePaths;
  const layoutRef = useRef({ activePanel, sidePanelVisible });
  layoutRef.current = { activePanel, sidePanelVisible };
  // 视图模式：默认按子目录聚合成组节点（tab 重挂载时恢复上次模式）
  const [mode, setMode] = useState<DepGraphViewMode>(
    () => getDepGraphViewMode(tabId) ?? 'aggregate'
  );
  // 重命名弹窗：目标文件的项目相对路径 + 输入中的新文件名
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  /** 节点右键菜单动作（节点 id = 文件的项目相对路径，绝对路径 = 根路径 + rel） */
  const menuActions = useMemo<DepGraphMenuActions>(
    () => ({
      resolveFilePath: (nodeId) => {
        const source = getDepGraphSourceData(tabId);
        return source && source.nodes.some((n) => n.id === nodeId) ? nodeId : null;
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
    }),
    [tabId, dispatch]
  );

  /** 按模式从文件级源数据重建画布（聚合 / 全量两种视图共用一份源数据） */
  const renderMode = useCallback(
    (graph: Graph, nextMode: DepGraphViewMode) => {
      const source = getDepGraphSourceData(tabId);
      if (!source) return;
      const data = nextMode === 'aggregate' ? aggregateByDirectory(source) : source;
      graph.clearEdges();
      graph.clearNodes();
      loadGraphFromData(graph, data, tabId);
      // 依赖连线统一为直线 + 固定配色（直线无采样/跳线计算开销，大数据量下保证流畅）
      for (const edge of graph.getAllEdges()) {
        edge.setType(EdgeType.Straight);
        edge.updateStyle(DEP_EDGE_STYLE);
      }
      fitContent(graph);
    },
    [tabId]
  );

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
      instance = createDepGraphInstance(tabId, container, menuActions);
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

  const handleModeChange = (nextMode: DepGraphViewMode) => {
    if (nextMode === mode) return;
    setMode(nextMode);
    setDepGraphViewMode(tabId, nextMode);
    const instance = getWorkflowInstance(tabId);
    if (instance) renderMode(instance.graph, nextMode);
  };

  return (
    <div ref={containerRef} className="dependency-graph-canvas">
      <div className="dependency-graph-canvas__mode-switch">
        <button
          type="button"
          className={mode === 'aggregate' ? 'is-active' : ''}
          onClick={() => handleModeChange('aggregate')}
        >
          {t('dependencyGraph.modeAggregate')}
        </button>
        <button
          type="button"
          className={mode === 'files' ? 'is-active' : ''}
          onClick={() => handleModeChange('files')}
        >
          {t('dependencyGraph.modeFiles')}
        </button>
      </div>
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
