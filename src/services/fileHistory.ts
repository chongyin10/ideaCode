import type { RecentProject } from '../types/electron';
import { isElectron } from './fileService';

export async function getRecentProjects(): Promise<RecentProject[]> {
  if (!isElectron()) return [];
  return window.electronAPI!.history.getRecent();
}

export async function addRecentProject(projectPath: string, name: string): Promise<void> {
  if (!isElectron()) return;
  await window.electronAPI!.history.addRecent(projectPath, name);
}

export async function removeRecentProject(projectPath: string): Promise<void> {
  if (!isElectron()) return;
  await window.electronAPI!.history.removeRecent(projectPath);
}

export async function clearAllRecentProjects(): Promise<void> {
  if (!isElectron()) return;
  await window.electronAPI!.history.clearAll();
}

export async function getHistoryFilePath(): Promise<string | null> {
  if (!isElectron()) return null;
  return window.electronAPI!.history.getFilePath();
}
