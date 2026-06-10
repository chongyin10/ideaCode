/**
 * 插件 API 工厂
 *
 * 将 IDE 的核心能力（文件系统、状态管理、编辑器、UI）封装为插件可调用的 API。
 * 插件无法直接访问 Redux store 或 Monaco Editor，只能通过此 API 层间接操作。
 */

import type { Store } from '@reduxjs/toolkit';
import type {
  PluginContext,
  PluginManifest,
  PluginFsApi,
  PluginWorkspaceApi,
  PluginCommandsApi,
  PluginUiApi,
  PluginMenusApi,
  PluginEditorApi,
} from './types';
import type { RootState } from '../store';
import { openFile } from '../store/slices/workspaceSlice';
import { readFile, writeFile as fsWriteFile, readDirectory } from '../services/fileService';
import { getPluginManager } from './core';
import { getMenuManager } from './menuManager';

/**
 * 创建插件上下文
 * @param pluginId 插件标识
 * @param manifest 插件元数据
 * @param store Redux store 实例
 */
export function createPluginContext(
  pluginId: string,
  manifest: PluginManifest,
  store: Store<RootState>
): PluginContext {
  const manager = getPluginManager();
  if (!manager) {
    throw new Error('PluginManager 尚未初始化');
  }

  const subscriptions: (() => void)[] = [];

  // ─── 文件系统 API ───
  const fs: PluginFsApi = {
    readFile: async (source) => readFile(source),
    writeFile: async (source, content) => {
      await fsWriteFile(source, content);
      return true;
    },
    readDirectory: async (source) => readDirectory(source),
    watch: async (path, callback) => {
      if (!window.electronAPI?.isElectron) {
        return () => {};
      }
      const result = await window.electronAPI.fs.watch(path);
      if (!result.success) throw new Error('监听失败');
      const unsub = window.electronAPI.fs.onChange(callback);
      subscriptions.push(unsub);
      return unsub;
    },
  };

  // ─── 工作区 API ───
  const workspace: PluginWorkspaceApi = {
    getRootSource: () => store.getState().workspace.rootSource,
    getOpenedFiles: () =>
      store.getState().workspace.openedFiles.map((f) => ({
        id: f.id,
        name: f.name,
        source: f.source,
      })),
    getActiveFile: () => {
      const state = store.getState().workspace;
      const file = state.openedFiles.find((f) => f.id === state.activeFileId);
      return file ? { id: file.id, name: file.name, source: file.source } : null;
    },
    openFile: (entry) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      store.dispatch(openFile(entry) as any);
    },
    onDidOpenFile: (callback) => {
      let prevIds = new Set(store.getState().workspace.openedFiles.map((f) => f.id));
      const unsubscribe = store.subscribe(() => {
        const files = store.getState().workspace.openedFiles;
        const currentIds = new Set(files.map((f) => f.id));
        for (const file of files) {
          if (!prevIds.has(file.id)) {
            callback({ id: file.id, name: file.name, source: file.source });
          }
        }
        prevIds = currentIds;
      });
      subscriptions.push(unsubscribe);
      return unsubscribe;
    },
    onDidChangeActiveFile: (callback) => {
      let lastId = store.getState().workspace.activeFileId;
      const unsubscribe = store.subscribe(() => {
        const currentId = store.getState().workspace.activeFileId;
        if (currentId !== lastId) {
          lastId = currentId;
          callback(currentId);
        }
      });
      subscriptions.push(unsubscribe);
      return unsubscribe;
    },
  };

  // ─── 命令 API ───
  const commands: PluginCommandsApi = manager.getCommandManager();

  // ─── 菜单 API ───
  const menus: PluginMenusApi = {
    registerMenuItem: (context, item) => {
      const manager = getMenuManager();
      const dispose = manager.register(context, {
        id: item.id,
        label: item.label,
        group: item.group,
        order: item.order,
        shortcut: item.shortcut,
        command: item.command,
        when: item.when
          ? (ctx) => {
              try {
                return new Function('ctx', `return ${item.when}`)(ctx);
              } catch {
                return true;
              }
            }
          : undefined,
      });
      subscriptions.push(dispose);
      return dispose;
    },
  };

  // ─── UI API ───
  const ui: PluginUiApi = {
    registerStatusBarItem: (id, options) => {
      // 触发 Redux action 注册状态栏项
      console.log(`[Plugin] 注册状态栏项: ${id}`, options);
      // TODO: 实现状态栏项注册
      return () => console.log(`[Plugin] 注销状态栏项: ${id}`);
    },
    registerPanel: (id, options) => {
      console.log(`[Plugin] 注册面板: ${id}`, options);
      // TODO: 实现面板注册
      return () => console.log(`[Plugin] 注销面板: ${id}`);
    },
    showMessage: (message, type = 'info') => {
      console.log(`[Plugin ${type}] ${message}`);
      // TODO: 实现 toast 通知系统
      alert(`[${type}] ${message}`);
    },
    showInputBox: async (options) => {
      return window.prompt(options.prompt, options.value) || undefined;
    },
    showQuickPick: async (items, options) => {
      // 简单的快速选择实现
      const idx = window.prompt(
        `${options?.placeHolder || '请选择'}:\n${items.map((item, i) => `${i + 1}. ${item}`).join('\n')}`
      );
      const num = parseInt(idx || '', 10);
      return !isNaN(num) && num > 0 && num <= items.length ? items[num - 1] : undefined;
    },
  };

  // ─── 编辑器 API ───
  const editor: PluginEditorApi = {
    getValue: () => {
      const state = store.getState();
      const activeFile = state.workspace.openedFiles.find(
        (f) => f.id === state.workspace.activeFileId
      );
      return activeFile?.content ?? null;
    },
    setValue: (value) => {
      const state = store.getState();
      const activeFile = state.workspace.openedFiles.find(
        (f) => f.id === state.workspace.activeFileId
      );
      if (activeFile) {
        // TODO: 需要 MonacoEditor 暴露设置值的方法
        console.log(`[Plugin] 设置编辑器内容: ${value.substring(0, 50)}...`);
      }
    },
    insertText: (text) => {
      console.log(`[Plugin] 插入文本: ${text}`);
      // TODO: 需要 MonacoEditor 暴露插入文本的方法
    },
    gotoLine: (line, column = 1) => {
      console.log(`[Plugin] 跳转到行: ${line}, 列: ${column}`);
      // TODO: 需要 MonacoEditor 暴露跳转方法
    },
    onDidChangeContent: (callback) => {
      const getContent = () => {
        const state = store.getState();
        const activeFile = state.workspace.openedFiles.find(
          (f) => f.id === state.workspace.activeFileId
        );
        return { id: activeFile?.id ?? null, content: activeFile?.content ?? '' };
      };
      let prev = getContent();
      const unsubscribe = store.subscribe(() => {
        const curr = getContent();
        if (curr.id !== prev.id || curr.content !== prev.content) {
          prev = curr;
          callback(curr.content);
        }
      });
      subscriptions.push(unsubscribe);
      return unsubscribe;
    },
  };

  // ─── 存储 ───
  const storage = manager.getStorage(pluginId);

  return {
    pluginId,
    manifest,
    storage,
    fs,
    workspace,
    commands,
    ui,
    menus,
    editor,
    subscriptions,
  };
}
