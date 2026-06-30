import { useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { loadDirectory, openFile, setExternalFileChange } from '../store/slices/workspaceSlice';
import { openDirectory } from '../services/fileService';
import type { FileEntry } from '../services/fileService';
import type { ExtensionMessage } from '../types/electron';
import { eventBus } from '../utils/eventBus';
import { normalizePathForCompare } from '../utils/pathNormalize';

/**
 * 监听 Electron 主进程推送的系统级事件
 *
 * 同时接入 EventBus（Observer 模式），将原始 Electron 事件
 * 转换为类型安全的应用级事件，供其他模块订阅。
 */
export function useElectronEvents() {
  const dispatch = useAppDispatch();
  const rootSource = useAppSelector((state) => state.workspace.rootSource);

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
    const unsubFocus = api.window.onFocus(() => {
      eventBus.emit('app:focus', undefined);
    });
    cleanups.push(unsubFocus);

    const unsubBlur = api.window.onBlur(() => {
      eventBus.emit('app:blur', undefined);
    });
    cleanups.push(unsubBlur);

    /* ── 窗口状态变化 ── */
    const unsubState = api.window.onStateChanged((_data) => {
      // console.log('[Electron] 窗口状态变化', _data);
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
    // §需求：AI Agent 完成 shell 命令（如 `npm create vite@latest`）后，
    //   后端会通过 lifeAiCode.fileChanged 通知渲染进程刷新"资源管理器"。
    //   ExplorerContent 监听 externalFileChange 变化后精准刷新受影响目录
    //   （不全量重建，避免 GPU/CPU 卡顿）。
    const unsubExtension = api.extension.onMessage((msg: ExtensionMessage) => {
      if (msg?.method === 'lifeAiCode.fileChanged' && msg.params) {
        // msg.params 是 unknown；按契约是 { paths?: string[]; cwds?: string[] }，这里做运行时安全降级
        const params = (msg.params && typeof msg.params === 'object') ? msg.params as { paths?: string[]; cwds?: string[] } : {};
        // 合并 paths + cwds 一起作为刷新路径集合。
        // cwd 用于触发父目录 refreshDirectory 重建 entries；具体 path 用于精准通知。
        const all = [...(params.paths || []), ...(params.cwds || [])];
        if (all.length === 0) return;
        // 后端传的是绝对路径（如 /Users/foo/project），需要转成相对工作区根的路径，
        // ExplorerContent 才会正确构建祖先目录链。
        const normalizedRoot = rootSource ? normalizePathForCompare(String(rootSource)) : '';
        const refreshPaths = all
          .map((p) => {
            if (!p) return null;
            const np = normalizePathForCompare(p);
            if (normalizedRoot && np.startsWith(normalizedRoot + '/')) {
              return np.substring(normalizedRoot.length + 1);
            }
            if (normalizedRoot && np === normalizedRoot) {
              return '';
            }
            return p; // 不在工作区内的路径透传，ExplorerContent 会忽略
          })
          .filter((p): p is string => p !== null);
        if (refreshPaths.length > 0) {
          dispatch(setExternalFileChange({ paths: refreshPaths, timestamp: Date.now() }));
        }
      }
    });
    cleanups.push(unsubExtension);

    return () => {
      cleanups.forEach((fn) => fn());
    };
  }, [dispatch, rootSource]);
}
