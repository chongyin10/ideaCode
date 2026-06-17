import type { TerminalViewBounds, TerminalViewCreateOptions } from '../types/electron';

const API = () => window.electronAPI?.terminalView;

export async function createTerminalView(options: TerminalViewCreateOptions): Promise<{ success: boolean; error?: string }> {
  const api = API();
  if (!api) return { success: false, error: 'Electron API 不可用' };
  return api.create(options);
}

export async function destroyTerminalView(terminalId: number): Promise<{ success: boolean }> {
  const api = API();
  if (!api) return { success: false };
  return api.destroy(terminalId);
}

export async function setTerminalViewBounds(terminalId: number, bounds: TerminalViewBounds): Promise<{ success: boolean }> {
  const api = API();
  if (!api) return { success: false };
  return api.setBounds(terminalId, bounds);
}

export async function focusTerminalView(terminalId: number): Promise<{ success: boolean }> {
  const api = API();
  if (!api) return { success: false };
  return api.focus(terminalId);
}

export async function setTerminalBroadcast(enabled: boolean): Promise<{ success: boolean }> {
  const api = API();
  if (!api) return { success: false };
  return api.setBroadcast(enabled);
}

export function onTerminalViewFind(callback: (data: { term: string; previous?: boolean }) => void): () => void {
  const api = API();
  if (!api) return () => {};
  return api.onFind(callback);
}

export function onTerminalViewClearSelection(callback: () => void): () => void {
  const api = API();
  if (!api) return () => {};
  return api.onClearSelection(callback);
}
