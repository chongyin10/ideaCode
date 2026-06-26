/**
 * @ideacode/sdk - 统一扩展 SDK
 *
 * 提供：
 * - ExtensionContextImpl: 统一扩展上下文
 * - ExtensionBridge: 扩展桥接器 (轻量版)
 * - ServiceAdapters: 服务适配器 (拆解 ExtensionBridge)
 */

export { ExtensionContextImpl } from './ExtensionContext.js';
export { ExtensionBridge } from './ExtensionBridge.js';
export type { ExtensionState } from './ExtensionBridge.js';

// ServiceAdapters 按需导出
export { FileServiceAdapter } from './serviceAdapters/FileServiceAdapter.js';
export { TerminalServiceAdapter } from './serviceAdapters/TerminalServiceAdapter.js';
export { EditorServiceAdapter } from './serviceAdapters/EditorServiceAdapter.js';
export { WorkspaceServiceAdapter } from './serviceAdapters/WorkspaceServiceAdapter.js';
export { WebViewServiceAdapter } from './serviceAdapters/WebViewServiceAdapter.js';
export { ExtensionMgmtAdapter } from './serviceAdapters/ExtensionMgmtAdapter.js';
export type { ServiceAdapter } from './serviceAdapters/ServiceAdapter.js';
