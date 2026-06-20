import { useEffect } from 'react';
import { useAppDispatch } from '../store/hooks';
import { loadDirectory, openFile } from '../store/slices/workspaceSlice';
import { openDirectory } from '../services/fileService';
import type { FileEntry } from '../services/fileService';
import { eventBus } from '../utils/eventBus';

/**
 * 监听 Electron 主进程推送的系统级事件
 *
 * 同时接入 EventBus（Observer 模式），将原始 Electron 事件
 * 转换为类型安全的应用级事件，供其他模块订阅。
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
        eventBus.emit('project:opened', { rootPath: String(dir.source), rootName: dir.name });
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
        eventBus.emit('file:opened', { fileId: filePath, filePath, fileName: entry.name });
      }
    });
    cleanups.push(unsubMenuFile);

    /* ── 菜单：新建窗口 ── */
    const unsubMenuNewWindow = api.menu.onNewWindow(async () => {
      await api.window.create({ route: '/' });
    });
    cleanups.push(unsubMenuNewWindow);

    /* ── 窗口焦点变化 ── */
    const unsubFocus = api.window.onFocus((data) => {
      eventBus.emit('app:focus', undefined);
      console.log('[Electron] 窗口激活', data);
    });
    cleanups.push(unsubFocus);

    const unsubBlur = api.window.onBlur((data) => {
      eventBus.emit('app:blur', undefined);
      console.log('[Electron] 窗口失焦（后台模式）', data);
    });
    cleanups.push(unsubBlur);

    /* ── 窗口状态变化 ── */
    const unsubState = api.window.onStateChanged((data) => {
      // console.log('[Electron] 窗口状态变化', data);
    });
    cleanups.push(unsubState);

    /* ── 文件变更通知 ── */
    const unsubFsChange = api.fs.onChange((event) => {
      eventBus.emit('file:changed', {
        filePath: event.path,
        eventType: event.eventType,
      });
      // console.log('[Electron] 文件变更', event);
    });
    cleanups.push(unsubFsChange);

    /* ── 应用退出 ── */
    const unsubQuit = api.app.onQuit(() => {
      eventBus.emit('app:beforeQuit', undefined);
      console.log('[Electron] 应用即将退出');
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
