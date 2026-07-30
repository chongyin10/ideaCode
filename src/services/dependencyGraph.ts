import { readFile, writeFile, type FileSource } from './fileService';
import { renameEntry } from './fileOperations';
import type { NodeStyle } from '../workflow';
import {
  createWorkflowFileData,
  type WorkflowEdgeData,
  type WorkflowFileData,
  type WorkflowNodeData,
} from './workflowPersistence';

/** 依赖图节点尺寸与间距（自上而下分层：同层水平排列，层间垂直展开） */
const NODE_WIDTH = 170;
const NODE_HEIGHT = 48;
/** 同层节点的水平间距 */
const COLUMN_GAP = 210;
/** 层与层的垂直间距（留足贝塞尔曲线的弯曲空间） */
const ROW_GAP = 130;

/**
 * 依赖图节点的固定样式（与画布的坐标/缩放无关，仅声明差异字段；
 * 其余字段由 Node 构造时与默认样式浅合并兜底）
 */
const DEP_NODE_STYLE = {
  width: NODE_WIDTH,
  height: NODE_HEIGHT,
  backgroundColor: '#2d2d30',
  borderColor: '#569cd6',
  borderWidth: 1,
  borderRadius: 6,
  textColor: '#e8e8e8',
  // 路径式标签：目录部分用暗色、文件名用 textColor，区分同名 index.tsx
  secondaryTextColor: 'rgba(232, 232, 232, 0.45)',
  fontSize: 12,
} as NodeStyle;

/** 组节点（子目录聚合）的固定样式：琥珀色边框与文件节点区分 */
const GROUP_NODE_STYLE = {
  width: NODE_WIDTH,
  height: NODE_HEIGHT,
  backgroundColor: '#33301f',
  borderColor: '#e0af68',
  borderWidth: 1,
  borderRadius: 6,
  textColor: '#e8e8e8',
  fontSize: 12,
} as NodeStyle;

/** 根级文件聚合组的 ID 与标签（目标根目录下的散文件归为一组） */
const ROOT_GROUP_ID = '__root__';
const ROOT_GROUP_LABEL = '（根级文件）';

/** 参与依赖分析的代码文件扩展名 */
export const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

const CODE_FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** 判断文件名是否为可分析的代码文件 */
export function isCodeFile(name: string): boolean {
  return CODE_FILE_RE.test(name);
}

export interface DependencyGraphTarget {
  /** 相对项目根的路径（posix 分隔符） */
  path: string;
  kind: 'file' | 'directory';
}

/** 每批并发读取的文件数（与 searchService 的遍历骨架一致） */
const READ_BATCH_SIZE = 8;

/** import/require 说明符提取（在剔除注释后的内容上执行） */
const SPECIFIER_PATTERNS = [
  // import ... from '...' / import '...'
  /\bimport\s+(?:[\w$*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g,
  // export ... from '...'
  /\bexport\s+(?:[\w$*{}\s,]+|\*)\s+from\s+['"]([^'"]+)['"]/g,
  // import('...')
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // require('...')
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** 剔除块注释与行注释，减少 import 误匹配（行注释要求前导字符不是 `:`，避免误伤 http://） */
function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 提取文件中的模块说明符 */
function extractSpecifiers(content: string): string[] {
  const stripped = stripComments(content);
  const specifiers = new Set<string>();
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(stripped)) !== null) {
      specifiers.add(match[1]);
    }
  }
  return Array.from(specifiers);
}

/** posix 路径归一化（处理 ./ 与 ../） */
function normalizePath(p: string): string {
  const parts = p.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/**
 * 把相对说明符解析为项目内的相对文件路径（TS 解析规则：补扩展名 / index 文件）。
 * 包名引用（非 ./ ../ 开头）返回 null。
 */
function resolveSpecifier(spec: string, fromRel: string, fileSet: Set<string>): string | null {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
  const fromDir = fromRel.includes('/') ? fromRel.slice(0, fromRel.lastIndexOf('/')) : '';
  const joined = normalizePath(fromDir ? `${fromDir}/${spec}` : spec);
  if (fileSet.has(joined) && CODE_FILE_RE.test(joined)) return joined;
  for (const ext of CODE_EXTENSIONS) {
    if (fileSet.has(joined + ext)) return joined + ext;
  }
  for (const ext of CODE_EXTENSIONS) {
    if (fileSet.has(`${joined}/index${ext}`)) return `${joined}/index${ext}`;
  }
  return null;
}

/** 有限并发映射 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 分层布局（自上而下）：层 = 依赖链深度（入口文件在最上层，依赖逐层向下），
 * 同层节点水平排列。同层顺序用重心法（barycenter）多轮迭代排序，
 * 让有关联的节点尽量靠近，减少连线交叉；各层相对最宽层水平居中。
 */
function layoutNodes(nodeIds: string[], adjacency: Map<string, string[]>): WorkflowNodeData[] {
  // 依赖链深度：A imports B → depth(A) = max(depth(B)) + 1，无本地依赖为 0（带环保护）
  const depthCache = new Map<string, number>();
  const visiting = new Set<string>();
  const getDepth = (id: string): number => {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0; // 循环依赖按 0 处理
    visiting.add(id);
    let depth = 0;
    for (const dep of adjacency.get(id) ?? []) {
      depth = Math.max(depth, getDepth(dep) + 1);
    }
    visiting.delete(id);
    depthCache.set(id, depth);
    return depth;
  };
  for (const id of nodeIds) getDepth(id);
  let maxDepth = 0;
  for (const d of depthCache.values()) {
    if (d > maxDepth) maxDepth = d;
  }

  // 按层分组，入口（依赖链最长）排最上层
  const rowOf = new Map<string, number>();
  const rowCount = maxDepth + 1;
  const ordered: string[][] = Array.from({ length: rowCount }, () => []);
  for (const id of nodeIds) {
    const row = maxDepth - (depthCache.get(id) ?? 0);
    rowOf.set(id, row);
    ordered[row].push(id);
  }
  for (const ids of ordered) ids.sort();

  // 反向邻接：被谁依赖（上方邻居），重心法排序时用
  const dependents = new Map<string, string[]>();
  for (const [from, deps] of adjacency) {
    for (const dep of deps) {
      const list = dependents.get(dep) ?? [];
      list.push(from);
      dependents.set(dep, list);
    }
  }

  const indexOf = new Map<string, number>();
  const updateIndex = () => {
    indexOf.clear();
    for (const ids of ordered) ids.forEach((id, i) => indexOf.set(id, i));
  };
  updateIndex();

  /** 邻居节点在同层序号上的平均位置（无邻居返回 -1，排序时保持原位置） */
  const barycenter = (neighbors: string[]): number => {
    let sum = 0;
    let count = 0;
    for (const n of neighbors) {
      const idx = indexOf.get(n);
      if (idx !== undefined) {
        sum += idx;
        count++;
      }
    }
    return count > 0 ? sum / count : -1;
  };

  const sortRow = (row: number, neighborOf: (id: string) => string[]) => {
    ordered[row] = ordered[row].slice().sort((a, b) => {
      const ba = barycenter(neighborOf(a));
      const bb = barycenter(neighborOf(b));
      // 无邻居的节点按当前序号参与排序，保持相对位置稳定
      const ka = ba === -1 ? indexOf.get(a) ?? 0 : ba;
      const kb = bb === -1 ? indexOf.get(b) ?? 0 : bb;
      return ka - kb;
    });
    updateIndex();
  };

  // 重心法迭代：自上而下按上层邻居排序，再自下而上按下层邻居排序
  const ITERATIONS = 4;
  for (let it = 0; it < ITERATIONS; it++) {
    for (let r = 1; r < rowCount; r++) sortRow(r, (id) => dependents.get(id) ?? []);
    for (let r = rowCount - 2; r >= 0; r--) sortRow(r, (id) => adjacency.get(id) ?? []);
  }

  // 最宽层的节点数（各层以此为基准水平居中）
  let maxRowSize = 0;
  for (const ids of ordered) {
    if (ids.length > maxRowSize) maxRowSize = ids.length;
  }

  const nodes: WorkflowNodeData[] = [];
  ordered.forEach((ids, row) => {
    const rowOffset = ((maxRowSize - ids.length) * COLUMN_GAP) / 2;
    ids.forEach((id, index) => {
      nodes.push({
        id,
        // 标签用完整相对路径（Node 绘制时目录部分用次要色、文件名用主色），
        // 避免不同目录下的同名文件（如多个 index.tsx）在画布上无法区分
        label: id,
        x: 40 + rowOffset + index * COLUMN_GAP,
        y: 40 + row * ROW_GAP,
        style: DEP_NODE_STYLE,
        portsAlwaysVisible: false,
        data: { path: id },
      });
    });
  });
  return nodes;
}

/**
 * 构建文件依赖关系图：
 * - 文件夹：分析该目录（含子目录）全部代码文件，边 = 目录内部的相对 import；
 * - 文件：从该文件出发，沿相对 import 做 BFS，取其完整依赖闭包。
 * 返回可直接灌入工作流画布的 WorkflowFileData。
 */
export async function buildDependencyGraph(
  rootSource: FileSource,
  allFilePaths: string[],
  target: DependencyGraphTarget
): Promise<WorkflowFileData> {
  const rootStr = String(rootSource);
  const fileSet = new Set(allFilePaths);
  /** 文件 → 项目内依赖（去重后） */
  const adjacency = new Map<string, string[]>();

  const parseFile = async (rel: string): Promise<string[]> => {
    const cached = adjacency.get(rel);
    if (cached) return cached;
    adjacency.set(rel, []); // 先占位，避免循环依赖时重复读
    let content = '';
    try {
      content = await readFile(`${rootStr}/${rel}`);
    } catch {
      return [];
    }
    const deps = new Set<string>();
    for (const spec of extractSpecifiers(content)) {
      const resolved = resolveSpecifier(spec, rel, fileSet);
      if (resolved && resolved !== rel) deps.add(resolved);
    }
    const result = Array.from(deps);
    adjacency.set(rel, result);
    return result;
  };

  let nodeIds: string[];
  if (target.kind === 'directory') {
    // 目录模式：候选 = 目录下全部代码文件，批量并发解析
    const prefix = `${target.path}/`;
    nodeIds = allFilePaths.filter((p) => CODE_FILE_RE.test(p) && p.startsWith(prefix));
    await mapLimit(nodeIds, READ_BATCH_SIZE, parseFile);
    // 只保留目录内部的边
    const inScope = new Set(nodeIds);
    for (const [from, deps] of adjacency) {
      adjacency.set(from, deps.filter((d) => inScope.has(d)));
    }
    // 过滤没有任何依赖关系的孤立文件：对依赖可视化没有信息量，
    // 但会占据大量画面、加剧密集感（全是孤点或悬浮框）
    const connected = new Set<string>();
    for (const [from, deps] of adjacency) {
      if (deps.length === 0) continue;
      connected.add(from);
      for (const d of deps) connected.add(d);
    }
    nodeIds = nodeIds.filter((id) => connected.has(id));
  } else {
    // 文件模式：BFS 依赖闭包（依赖可超出所在目录）
    if (!CODE_FILE_RE.test(target.path)) return createWorkflowFileData([], []);
    const visited = new Set<string>([target.path]);
    let frontier = [target.path];
    while (frontier.length > 0) {
      const depsLists = await mapLimit(frontier, READ_BATCH_SIZE, parseFile);
      const next: string[] = [];
      for (const deps of depsLists) {
        for (const dep of deps) {
          if (!visited.has(dep)) {
            visited.add(dep);
            next.push(dep);
          }
        }
      }
      frontier = next;
    }
    nodeIds = Array.from(visited);
  }

  const edges: WorkflowEdgeData[] = [];
  for (const from of nodeIds) {
    for (const to of adjacency.get(from) ?? []) {
      // 自上而下编排：出口在底部连接桩，入口在顶部连接桩
      edges.push({
        id: `dep-${from}->${to}`,
        label: '',
        source: { nodeId: from, portId: `${from}-port-bottom` },
        target: { nodeId: to, portId: `${to}-port-top` },
      });
    }
  }

  return createWorkflowFileData(layoutNodes(nodeIds, adjacency), edges);
}

/**
 * 计算所有节点 ID 的最长公共目录前缀（以 `/` 结尾，无公共前缀返回 ''）。
 * 节点 ID 是项目相对路径（如 `src/components/a.tsx`），聚合分组要以
 * 分析目标根为基准层级，需先剥离这段公共前缀，否则所有文件都会
 * 落入同一个组（第一段都是 `src`），组间连线全部变成组内自连。
 */
function commonDirPrefix(ids: string[]): string {
  if (ids.length === 0) return '';
  const splitIds = ids.map((id) => id.split('/'));
  const first = splitIds[0];
  let depth = 0;
  // 只统计「每个 ID 在该段之后仍有内容」的公共段，保证前缀一定是目录
  for (let i = 0; i < first.length - 1; i++) {
    const seg = first[i];
    if (splitIds.every((parts) => parts.length > i + 1 && parts[i] === seg)) {
      depth = i + 1;
    } else {
      break;
    }
  }
  return depth > 0 ? `${first.slice(0, depth).join('/')}/` : '';
}

/**
 * 把文件级依赖图按目录聚合成组节点（纯数据推导，不重读文件）：
 * - 先剥离节点 ID 的最长公共目录前缀，再按目录层级分组；
 * - 默认只展开第一级：标签 = 目录名（文件数），目标根下的散文件归为一组；
 * - expandedGroups 中的组 id（如 `components` 或嵌套的 `components/A`）会被下钻：
 *   其直接子目录成为下一级组节点、直接文件成为文件节点，与未展开的组混排；
 * - 组间连线 = 组内任一文件依赖另一组内文件（去重，忽略自连）；
 * - 没有任何连线的孤立节点不进入画布（与文件级的孤立过滤一致）。
 */
export function aggregateByDirectory(
  data: WorkflowFileData,
  expandedGroups?: ReadonlySet<string>
): WorkflowFileData {
  const prefix = commonDirPrefix(data.nodes.map((n) => n.id));
  const expanded = expandedGroups ?? new Set<string>();

  // 文件 → 画布节点 id（第一个未展开组的组 id；组链全部展开则为文件自身 id）
  const renderIdOf = new Map<string, string>();
  // 组 id → 组内成员文件
  const members = new Map<string, string[]>();
  for (const node of data.nodes) {
    const rel = prefix && node.id.startsWith(prefix) ? node.id.slice(prefix.length) : node.id;
    const segs = rel.split('/');
    // 组链（自上而下）：根级散文件 = [__root__]；否则 = 逐级目录前缀
    const chain: string[] = [];
    if (segs.length === 1) {
      chain.push(ROOT_GROUP_ID);
    } else {
      let group = '';
      for (let i = 0; i < segs.length - 1; i++) {
        group = group ? `${group}/${segs[i]}` : segs[i];
        chain.push(group);
      }
    }
    let renderId = node.id;
    for (const g of chain) {
      if (!expanded.has(g)) {
        renderId = g;
        break;
      }
    }
    renderIdOf.set(node.id, renderId);
    if (renderId !== node.id) {
      const list = members.get(renderId) ?? [];
      list.push(node.id);
      members.set(renderId, list);
    }
  }

  // 组间/节点间依赖（去重、忽略自连）
  const adjacency = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const edge of data.edges) {
    const from = renderIdOf.get(edge.source.nodeId);
    const to = renderIdOf.get(edge.target.nodeId);
    if (!from || !to || from === to) continue;
    const pairKey = `${from}->${to}`;
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);
    const list = adjacency.get(from) ?? [];
    list.push(to);
    adjacency.set(from, list);
  }

  // 过滤没有任何连线的孤立节点；
  // 若全部节点都没有连线（如单文件场景），则全部保留，避免画布空白
  const connected = new Set<string>();
  for (const [from, deps] of adjacency) {
    connected.add(from);
    for (const d of deps) connected.add(d);
  }
  const fileIds = data.nodes.map((n) => n.id).filter((id) => renderIdOf.get(id) === id);
  const nodeIds = [...members.keys(), ...fileIds].filter(
    (id) => connected.size === 0 || connected.has(id)
  );

  const nodes = layoutNodes(nodeIds, adjacency).map((n) => {
    const count = members.get(n.id)?.length;
    // 文件节点：layoutNodes 已给 DEP_NODE_STYLE + 完整路径标签，无需处理
    if (count === undefined) return n;
    const dirName = n.id === ROOT_GROUP_ID ? ROOT_GROUP_LABEL : n.id.split('/').pop();
    return { ...n, label: `${dirName}（${count}）`, style: GROUP_NODE_STYLE };
  });

  const edges: WorkflowEdgeData[] = [];
  for (const [from, deps] of adjacency) {
    for (const to of deps) {
      edges.push({
        id: `dep-group-${from}->${to}`,
        label: '',
        source: { nodeId: from, portId: `${from}-port-bottom` },
        target: { nodeId: to, portId: `${to}-port-top` },
      });
    }
  }

  return createWorkflowFileData(nodes, edges);
}

/** 计算 fromDir（项目相对目录，可为 ''）指向 toRel（项目相对路径）的相对路径 */
function relativePath(fromDir: string, toRel: string): string {
  const from = fromDir ? fromDir.split('/') : [];
  const to = toRel.split('/');
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) i++;
  const ups = from.length - i;
  return [...Array<string>(ups).fill('..'), ...to.slice(i)].join('/');
}

/**
 * 按原说明符的书写风格生成重命名后的新说明符：
 * - 原说明符不带扩展名（TS 常规风格 `./foo`）则新说明符也不带扩展名；
 * - 原说明符是目录式引入（未显式写到 `index`）则保持目录式。
 */
function buildRenamedSpecifier(oldSpec: string, importerRel: string, newRel: string): string {
  const importerDir = importerRel.includes('/') ? importerRel.slice(0, importerRel.lastIndexOf('/')) : '';
  let rel = relativePath(importerDir, newRel);
  if (!rel.startsWith('.')) rel = `./${rel}`;
  if (!CODE_FILE_RE.test(oldSpec)) {
    rel = rel.replace(CODE_FILE_RE, '');
    if (!/(^|\/)index$/.test(oldSpec.replace(CODE_FILE_RE, ''))) {
      rel = rel.replace(/\/index$/, '');
    }
  }
  return rel;
}

export interface RenameImportSyncResult {
  /** 重命名后的项目相对路径 */
  newRel: string;
  /** 被改写引入说明符的文件（项目相对路径） */
  updatedFiles: string[];
}

/**
 * 重命名代码文件并同步改写项目内所有指向它的 import/require 说明符：
 * 先在磁盘上重命名，再遍历全部代码文件，凡解析结果指向旧路径的说明符
 * 一律按原书写风格改写为新相对路径（基于正则解析，与依赖图构建同一套规则）。
 */
export async function renameFileWithImportSync(
  rootSource: FileSource,
  allFilePaths: string[],
  oldRel: string,
  newName: string
): Promise<RenameImportSyncResult> {
  const rootStr = String(rootSource);
  const oldName = oldRel.split('/').pop() || oldRel;
  const dir = oldRel.includes('/') ? oldRel.slice(0, oldRel.lastIndexOf('/')) : '';
  const parentSource = dir ? `${rootStr}/${dir}` : rootStr;
  await renameEntry(parentSource, oldName, newName, 'file');
  const newRel = dir ? `${dir}/${newName}` : newName;

  // 用「重命名前」的文件集合解析旧引入目标
  const oldFileSet = new Set(allFilePaths);
  const updatedFiles: string[] = [];
  const importers = allFilePaths.filter((p) => CODE_FILE_RE.test(p) && p !== oldRel);
  await mapLimit(importers, READ_BATCH_SIZE, async (importerRel) => {
    let content: string;
    try {
      content = await readFile(`${rootStr}/${importerRel}`);
    } catch {
      return;
    }
    let next = content;
    for (const spec of extractSpecifiers(content)) {
      if (resolveSpecifier(spec, importerRel, oldFileSet) !== oldRel) continue;
      const newSpec = buildRenamedSpecifier(spec, importerRel, newRel);
      // 只替换带引号的字符串字面量位置，降低误伤同名文本的概率
      next = next.split(`'${spec}'`).join(`'${newSpec}'`).split(`"${spec}"`).join(`"${newSpec}"`);
    }
    if (next !== content) {
      await writeFile(`${rootStr}/${importerRel}`, next);
      updatedFiles.push(importerRel);
    }
  });
  return { newRel, updatedFiles };
}

/**
 * 把图数据里 oldRel 节点改名为 newRel（纯数据推导，不重读文件）：
 * 节点 id/标签/路径、连线的两端 nodeId/portId 与 id 同步更新，
 * 供依赖可视化画布在重命名后直接重建，无需重新分析。
 */
export function renameNodeInGraphData(
  data: WorkflowFileData,
  oldRel: string,
  newRel: string
): WorkflowFileData {
  const mapEndpoint = (nodeId: string, portId?: string) =>
    nodeId === oldRel
      ? { nodeId: newRel, portId: portId?.replace(`${oldRel}-port-`, `${newRel}-port-`) }
      : { nodeId, portId };
  const nodes = data.nodes.map((n) =>
    n.id === oldRel ? { ...n, id: newRel, label: newRel, data: { ...n.data, path: newRel } } : n
  );
  const edges = data.edges.map((e) => {
    const source = mapEndpoint(e.source.nodeId, e.source.portId);
    const target = mapEndpoint(e.target.nodeId, e.target.portId);
    return {
      ...e,
      id: e.id.replace(`dep-${oldRel}->`, `dep-${newRel}->`).replace(`->${oldRel}`, `->${newRel}`),
      source,
      target,
    };
  });
  return createWorkflowFileData(nodes, edges);
}