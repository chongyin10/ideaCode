/**
 * 终端屏幕内容快照管理
 *
 * 用于在 TerminalInstance 销毁/重建（Modal ↔ 编辑器 Tab）之间保留可见内容。
 * xterm.js 的 SerializeAddon 将缓冲区序列化为转义序列字符串，重建时写回即可。
 */

const terminalSnapshots = new Map<string, string>();

export function getTerminalSnapshot(id: string): string | undefined {
  return terminalSnapshots.get(id);
}

export function setTerminalSnapshot(id: string, snapshot: string): void {
  terminalSnapshots.set(id, snapshot);
}

export function clearTerminalSnapshot(id: string): void {
  terminalSnapshots.delete(id);
}
