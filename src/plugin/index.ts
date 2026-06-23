/**
 * 插件系统入口
 *
 * 导出插件系统所有公共 API：
 * - 插件管理器（注册/激活/停用/卸载）
 * - 插件类型定义
 * - 插件上下文工厂
 * - 示例插件
 */

export { createPluginManager, getPluginManager, PluginManager } from './core';
export { createPluginContext } from './api';
export { getMenuManager, resetMenuManager } from './menuManager';
export type { MenuContribution } from './menuManager';
export type {
  Plugin,
  PluginManifest,
  PluginContext,
  PluginState,
  PluginContributes,
  PluginCommand,
  PluginMenu,
  PluginConfiguration,
  PluginPanel,
  PluginFsApi,
  PluginWorkspaceApi,
  PluginCommandsApi,
  PluginUiApi,
  PluginMenusApi,
  PluginEditorApi,
  PluginStorage,
} from './types';

/**
 * 示例插件：Hello World
 * 展示插件的基本结构和 API 使用方式
 */
export { lifeAiCodePlugin } from './aiPlugin';
export const helloWorldPlugin: import('./types').Plugin = {
  manifest: {
    id: 'com.ideacode.hello-world',
    name: 'Hello World',
    version: '1.0.0',
    author: 'IDEACODE Team',
    description: '示例插件，演示插件系统基本功能',
    main: 'index.js',
    contributes: {
      commands: [
        {
          id: 'hello-world.sayHello',
          title: 'Say Hello',
          keybinding: 'Ctrl+Shift+H',
        },
      ],
    },
  },
  activate(context) {
    console.log(`[HelloWorld] 插件已激活，ID: ${context.pluginId}`);

    // 注册命令
    const unregisterCommand = context.commands.registerCommand(
      'hello-world.sayHello',
      () => {
        context.ui.showMessage('Hello from IDEACODE plugin!', 'info');
        return 'Hello!';
      }
    );
    context.subscriptions.push(unregisterCommand);

    // 示例：监听文件打开
    const unsubscribeOpen = context.workspace.onDidOpenFile((file) => {
      console.log(`[HelloWorld] 文件已打开: ${file.name}`);
    });
    context.subscriptions.push(unsubscribeOpen);

    // 示例：读写存储
    const visitCount = (context.storage.get<number>('visitCount', 0) ?? 0) + 1;
    context.storage.set('visitCount', visitCount);
    console.log(`[HelloWorld] 访问次数: ${visitCount}`);
  },
  deactivate() {
    console.log('[HelloWorld] 插件已停用');
  },
};
