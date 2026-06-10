import { useEffect } from 'react';
import { useAppDispatch } from '../store/hooks';
import { loadDirectory, openFile } from '../store/slices/workspaceSlice';
import { openDirectory } from '../services/fileService';
import type { FileEntry } from '../services/fileService';

/**
 * 监听 Electron 主进程推送的系统级事件
 * 
 * - 菜单事件：Cmd/Ctrl+O 打开文件夹、Cmd/Ctrl+P 打开文件、Shift+Cmd+N 新建窗口
 * - 窗口焦点：激活模式 / 后台模式状态切换
 * - 文件变更：后台文件监听推送的变更通知
 * - 应用退出：保存状态提示
 * - 扩展消息：扩展宿主进程推送的消息
 */
export function useElectronEvents() {
  const dispatch = useAppDispatch();

  useEffect(() => {
    if (!window.electronAPI?.isElectron) return;

    const api = window.electronAPI;
    const cleanups: (() => void)[] = [];

    /* ── 菜单：打开文件夹 ── */
    const unsubMenuFolder = api.menu.onOpenFolder(async () => {
      const dir = await openDirectory();
      if (dir) {
        dispatch(loadDirectory({ source: dir.source, name: dir.name }));
      }
    });
    cleanups.push(unsubMenuFolder);

    /* ── 菜单：打开文件 ── */
    const unsubMenuFile = api.menu.onOpenFile(async () => {
      const filePath = await api.dialog.openFile();
      if (filePath) {
        const entry: FileEntry = {
          name: filePath.split(/[\\/]/).pop() || filePath,
          kind: 'file',
          source: filePath,
        };
        dispatch(openFile(entry));
      }
    });
    cleanups.push(unsubMenuFile);

    /* ── 菜单：新建窗口 ── */
    const unsubMenuNewWindow = api.menu.onNewWindow(async () => {
      await api.window.create({ route: '/' });
    });
    cleanups.push(unsubMenuNewWindow);

    /* ── 窗口焦点变化（激活模式）── */
    const unsubFocus = api.window.onFocus((data) => {
      console.log('[Electron] 窗口激活', data);
      // 窗口激活时可触发刷新逻辑（如 Git 状态、文件树同步）
    });
    cleanups.push(unsubFocus);

    const unsubBlur = api.window.onBlur((data) => {
      console.log('[Electron] 窗口失焦（后台模式）', data);
      // 窗口失焦时进入后台模式，文件监听等后台任务继续运行
    });
    cleanups.push(unsubBlur);

    /* ── 窗口状态变化 ── */
    const unsubState = api.window.onStateChanged((data) => {
      console.log('[Electron] 窗口状态变化', data);
    });
    cleanups.push(unsubState);

    /* ── 文件变更通知（后台模式推送）── */
    const unsubFsChange = api.fs.onChange((event) => {
      console.log('[Electron] 文件变更', event);
      // 可在此触发 Redux action 刷新文件树或提示用户重新加载
    });
    cleanups.push(unsubFsChange);

    /* ── 应用退出 ── */
    const unsubQuit = api.app.onQuit(() => {
      console.log('[Electron] 应用即将退出');
      // 可在此保存编辑器状态、未保存文件提示等
    });
    cleanups.push(unsubQuit);

    /* ── 扩展消息 ── */
    const unsubExtension = api.extension.onMessage((msg) => {
      console.log('[Electron] 扩展消息', msg);
    });
    cleanups.push(unsubExtension);

    return () => {
      cleanups.forEach((fn) => fn());
    };
  }, [dispatch]);
}
