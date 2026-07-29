// 拖拽插件
export {
    Dnd,
    type DndOptions,
    type DndSourceConfig,
    type DndEvent,
    type Plugin,
} from './Dnd';

// React 形状插件
export {
    ReactShape,
    ReactShapeNode,
    registerReactShape,
    unregisterReactShape,
    getGlobalReactShape,
    hasGlobalReactShape,
    getGlobalReactShapes,
    isReactShape,
    addReactNode,
    type ReactNodeProps,
    type ReactShapeConfig,
    type ReactShapePortConfig,
} from './ReactShape';

// 对齐线插件
export {
    Snapline,
    type SnaplineOptions,
    type SnaplineType,
    type SnaplineData,
    type SnapPoint,
} from './Snapline';

// 剪贴板插件
export {
    Clipboard,
    type ClipboardOptions,
    type ClipboardData,
    type NodeClipboardData,
    type EdgeClipboardData,
} from './Clipboard';

// 小地图插件
export {
    MiniMap,
    type MiniMapOptions,
    type MiniMapPosition,
} from './MiniMap';

// 下拉菜单插件
export {
    Dropdown,
    createDropdown,
    type DropdownOptions,
    type MenuItem,
} from './Dropdown';

// 历史记录插件
export {
    History,
    type HistoryOptions,
    type HistoryAction,
    type HistoryActionType,
    type HistoryState,
    type BatchHistoryAction,
} from './History';

// 框选插件
export {
    Selection,
    type SelectionOptions,
    type SelectionEvent,
} from './Selection';

// 工具栏插件
export {
    Tools,
    type ToolsOptions,
    type SearchResults,
} from './Tools';