/**
 * LifeAiCode 内置插件
 *
 * 运行在渲染进程的 Plugin System 中。
 * 职责：
 * - 在编辑器上下文菜单中注册 AI 操作
 * - 桥接 Extension Host 的 LifeAiCode 扩展
 * - 提供 TypeScript API 给其他插件调用
 *
 * 核心设计原则：
 * - 插件本身只读，不直接修改代码
 * - 代码写入始终通过 fileService，且仅在用户确认后
 */

import type { Plugin } from './types';
import { getExtensionBridge } from './extensionBridge';
import inlineSuggestionCSS from '../styles/inline-suggestion.css?inline';
import { toggleAiEditMode } from '../store/slices/workspaceSlice';
import { store } from '../store';

export const lifeAiCodePlugin: Plugin = {
  manifest: {
    id: 'com.ideacode.lifeAiCode',
    name: 'LifeAiCode',
    version: '1.0.0',
    author: 'IDEACODE Team',
    description: 'AI 代码辅助 — 只读分析，提供建议',
    main: 'aiPlugin.ts',
    contributes: {
      commands: [
        {
          id: 'lifeAiCode.explain',
          title: 'LifeAiCode: 解释代码',
        },
        {
          id: 'lifeAiCode.refactor',
          title: 'LifeAiCode: 建议重构',
        },
        {
          id: 'lifeAiCode.review',
          title: 'LifeAiCode: 代码审查',
        },
        {
          id: 'lifeAiCode.openChat',
          title: 'LifeAiCode: 打开 AI 对话',
        },
        {
          id: 'lifeAiCode.toggleEditMode',
          title: 'LifeAiCode: 切换编辑模式',
        },
      ],
      menus: [
        {
          id: 'lifeAiCode.explain',
          label: 'AI: 解释代码',
          group: 'ai',
          command: 'lifeAiCode.explain',
          order: 1,
        },
        {
          id: 'lifeAiCode.refactor',
          label: 'AI: 建议重构',
          group: 'ai',
          command: 'lifeAiCode.refactor',
          order: 2,
        },
        {
          id: 'lifeAiCode.review',
          label: 'AI: 代码审查',
          group: 'ai',
          command: 'lifeAiCode.review',
          order: 3,
        },
      ],
      configuration: [
        {
          id: 'lifeAiCode.provider',
          type: 'string',
          default: 'openai',
          description: 'LLM Provider (openai/anthropic/ollama)',
        },
        {
          id: 'lifeAiCode.apiKey',
          type: 'string',
          default: '',
          description: 'LLM API Key',
        },
        {
          id: 'lifeAiCode.readonly',
          type: 'boolean',
          default: true,
          description: '只读模式',
        },
      ],
    },
  },

  activate(context) {
    console.log('[LifeAiCode Plugin] 已激活');

    // 注册 CSS 样式（用于内联建议装饰器）
    const styleEl = document.createElement('style');
    styleEl.textContent = inlineSuggestionCSS || '';
    document.head.appendChild(styleEl);
    context.subscriptions.push(() => styleEl.remove());

    // 命令: 解释代码
    const unsubExplain = context.commands.registerCommand('lifeAiCode.explain', () => {
      const bridge = getExtensionBridge();
      if (bridge) {
        bridge.sendToHost('lifeAiCode.internal.explainCode', {
          context: null, // Extension Host 会自动获取
        }).catch((err) => {
          context.ui.showMessage(`AI 请求失败: ${err.message}`, 'error');
        });
      } else {
        context.ui.showMessage('未连接到 Extension Host', 'warning');
      }
    });
    context.subscriptions.push(unsubExplain);

    // 命令: 建议重构
    const unsubRefactor = context.commands.registerCommand('lifeAiCode.refactor', () => {
      const bridge = getExtensionBridge();
      if (bridge) {
        bridge.sendToHost('lifeAiCode.internal.suggestRefactor', {
          context: null,
        }).catch((err) => {
          context.ui.showMessage(`AI 请求失败: ${err.message}`, 'error');
        });
      } else {
        context.ui.showMessage('未连接到 Extension Host', 'warning');
      }
    });
    context.subscriptions.push(unsubRefactor);

    // 命令: 代码审查
    const unsubReview = context.commands.registerCommand('lifeAiCode.review', () => {
      const bridge = getExtensionBridge();
      if (bridge) {
        bridge.sendToHost('lifeAiCode.internal.processMessage', {
          text: '请审查当前代码，找出所有潜在问题、bug 和安全漏洞。列出严重程度。',
          context: null,
        }).catch((err) => {
          context.ui.showMessage(`AI 请求失败: ${err.message}`, 'error');
        });
      } else {
        context.ui.showMessage('未连接到 Extension Host', 'warning');
      }
    });
    context.subscriptions.push(unsubReview);

    // 命令: 切换 AI 编辑模式
    const doToggleEditMode = () => {
      store.dispatch(toggleAiEditMode());
      const isEditMode = store.getState().workspace.aiEditMode;
      // 不再弹窗提示，避免干扰
      console.log(isEditMode ? '[LifeAiCode] AI 编辑模式已开启' : '[LifeAiCode] AI 只读模式已开启');
      // 同步到 WebView
      const bridge = getExtensionBridge();
      if (bridge) {
        bridge.sendToHost('lifeAiCode.internal.setEditMode', { enabled: isEditMode }).catch(() => {});
      }
    };
    const unsubToggleEdit = context.commands.registerCommand('lifeAiCode.toggleEditMode', doToggleEditMode);
    context.subscriptions.push(unsubToggleEdit);

    // 注：原 lifeAiCode.toggleReadonly 命令已删除 — 它复用 doToggleEditMode 导致语义错乱
    // （readonly 与 editMode 是同一开关的两个名字，重复注册只会让命令面板出现两个等效入口）。
    // 统一使用 lifeAiCode.toggleEditMode，package.json 的 view action 也已同步切换。

    // 命令: 显示/隐藏历史对话
    const unsubShowHistory = context.commands.registerCommand('lifeAiCode.showHistory', () => {
      const bridge = getExtensionBridge();
      if (bridge) {
        bridge.sendToHost('commands.execute', {
          command: 'lifeAiCode.showHistory',
          args: [],
        }).catch(() => {});
      }
    });
    context.subscriptions.push(unsubShowHistory);

    // 命令: 新开对话
    const unsubNewChat = context.commands.registerCommand('lifeAiCode.newChat', () => {
      const bridge = getExtensionBridge();
      if (bridge) {
        bridge.sendToHost('commands.execute', {
          command: 'lifeAiCode.newChat',
          args: [],
        }).catch(() => {});
      }
    });
    context.subscriptions.push(unsubNewChat);

    // 命令: 打开配置
    const unsubOpenConfig = context.commands.registerCommand('lifeAiCode.openConfig', () => {
      const bridge = getExtensionBridge();
      if (bridge) {
        bridge.sendToHost('commands.execute', {
          command: 'lifeAiCode.openConfig',
          args: [],
        }).catch(() => {});
      }
    });
    context.subscriptions.push(unsubOpenConfig);

    // 命令: 打开 AI 对话 WebView
    const unsubOpenChat = context.commands.registerCommand('lifeAiCode.openChat', () => {
      // 激活扩展会创建 WebView 面板，只需执行对应的扩展命令
      const bridge = getExtensionBridge();
      if (bridge) {
        bridge.sendToHost('commands.execute', {
          command: 'lifeAiCode.ask',
          args: [],
        }).catch(() => {});
      }
    });
    context.subscriptions.push(unsubOpenChat);

    // 同步初始编辑模式到 Extension Host / WebView
    const bridge = getExtensionBridge();
    if (bridge) {
      bridge.sendToHost('lifeAiCode.internal.setEditMode', { enabled: store.getState().workspace.aiEditMode }).catch(() => {});
    }

    // 未配置 API Key 时只在控制台提示，避免启动时弹窗干扰
    const apiKey = context.storage.get<string>('apiKey', '');
    const envKey = typeof process !== 'undefined'
      ? (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.ZHIPU_API_KEY || process.env.DASHSCOPE_API_KEY)
      : undefined;
    if (!apiKey && !envKey) {
      console.log('[LifeAiCode Plugin] 未配置 API Key，请在设置中配置 lifeAiCode.apiKey 或环境变量');
    }
  },

  deactivate() {
    console.log('[LifeAiCode Plugin] 已停用');
  },
};
