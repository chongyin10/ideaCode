/**
 * Graph 流程图引擎核心模块
 *
 * 导出所有核心类、接口和类型
 */

// Graph 画布
export {
    Graph,
    type GraphOptions,
    type GraphState,
    type Point,
    type ConnectionValidateContext,
    type ConnectionValidator,
} from './Graph';

// 节点
export {
  Node,
  type NodeOptions,
  type NodeStyle,
  type NodePosition,
  type NodeData,
  type NodeEvent,
  type ResizeHandlePosition,
  type ResizeHandleConfig,
  DEFAULT_RESIZE_HANDLE_CONFIG,
} from './Node';

// 动态高度节点
export {
  DynamicHeightNode,
  type DynamicHeightNodeOptions,
  type DynamicHeightNodeStyle,
  type DynamicHeightNodeData,
  type DynamicHeightNodeEvent,
  type RowConfig,
  type RowData,
} from './DynamicNode';

// 边
export {
  Edge,
  EdgeType,
  type EdgeOptions,
  type EdgeStyle,
  type EdgeAnchor,
  type EdgeData,
  type EdgeEvent,
} from './Edge';

// 连接桩
export {
  Port,
  type PortOptions,
  type PortStyle,
  type PortPosition,
  type PortData,
  type PortEvent,
  type PortLayoutConfig,
  type PortGroupOptions,
} from './Port';

// 形状
export { Shape, type ShapeConfig, ShapeRenderer } from './Shape';

// 基础单元
export {
  type CellOptions,
  type CellData,
  type CellEvent,
  type BaseStyle,
  Cell,
} from './Cell';

// 事件管理
export {
  EventManager,
  Eventful,
  EVENT_NAMES,
  type EventHandler,
  type EventName,
  type BaseEvent,
  type MouseEvent,
  type WheelEvent,
  type IEventful,
} from './EventManager';
