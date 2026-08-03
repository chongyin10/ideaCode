/**
 * WebView 服务适配器
 *
 * 处理扩展的 WebView 面板创建/管理。
 * 替代原 ExtensionBridge 中的 webview.* / tree.* / webviewView.* RPC handlers。
 */

import type { IServiceBus } from '@ideacode/kernel';
import type { ServiceAdapter } from './ServiceAdapter.js';

export interface WebViewStateProvider {
  dispatch(action: unknown): void;
}

export class WebViewServiceAdapter implements ServiceAdapter {
  readonly id = 'webViewService';

  private webViewState: WebViewStateProvider | null = null;

  setWebViewState(state: WebViewStateProvider): void {
    this.webViewState = state;
  }

  register(bus: IServiceBus): void {
    // 创建 WebView 面板
    bus.handle('webview.create', (params) => {
      const { id, viewType, title, showOptions, options, extensionPath } = params as {
        id: string;
        viewType: string;
        title: string;
        showOptions?: { modal?: boolean; preserveFocus?: boolean };
        options?: { extensionId?: string; extensionPath?: string; enableScripts?: boolean; retainContextWhenHidden?: boolean };
        extensionPath?: string;
      };

      const isModal = showOptions?.modal === true;
      const payload = {
        id,
        viewType,
        title,
        html: '',
        extensionId: String(options?.extensionId || 'unknown'),
        extensionPath: String(extensionPath || options?.extensionPath || ''),
        visible: true,
      };

      if (isModal) {
        this.webViewState?.dispatch({ type: 'modal/openModalWebview', payload });
        console.log(`[WebView] 创建 Modal: ${id} (${title})`);
      } else {
        this.webViewState?.dispatch({ type: 'extensionUI/createWebviewPanel', payload });
        console.log(`[WebView] 创建面板: ${id} (${title})`);
      }

      return { created: true };
    });

    // 设置 WebView HTML
    bus.handle('webview.setHtml', (params) => {
      const { id, html } = params as { id: string; html: string };
      this.webViewState?.dispatch({ type: 'extensionUI/setWebviewPanelHtml', payload: { id, html } });
      console.log(`[WebView] 设置 HTML: ${id} (${html.length} bytes)`);
      return { set: true };
    });

    // 销毁 WebView
    bus.handle('webview.dispose', (params) => {
      const { id } = params as { id: string };
      this.webViewState?.dispatch({ type: 'extensionUI/disposeWebviewPanel', payload: id });
      console.log(`[WebView] 销毁: ${id}`);
      return { disposed: true };
    });

    // 显示 WebView
    bus.handle('webview.reveal', (params) => {
      const { id } = params as { id: string };
      // 切换到对应的右侧面板标签
      console.log(`[WebView] 显示: ${id}`);
      return { revealed: true };
    });

    // WebView 消息
    bus.handle('webview.postMessage', (params) => {
      const { id, message } = params as { id: string; message: unknown };
      bus.publish(`webview:${id}:message`, message);
      return { posted: true };
    });

    bus.handle('webview.message', (params) => {
      const { id, message } = params as { id: string; message: unknown };
      bus.publish(`webview:${id}:message`, message);
      return { received: true };
    });

    // 树视图注册
    bus.handle('tree.register', (params) => {
      const { viewId } = params as { viewId: string };
      console.log(`[TreeView] 注册: ${viewId}`);
      return { registered: true };
    });

    bus.handle('tree.unregister', (params) => {
      const { viewId } = params as { viewId: string };
      console.log(`[TreeView] 注销: ${viewId}`);
      return { unregistered: true };
    });

    // WebViewView 注册
    bus.handle('webviewView.register', (params) => {
      const { viewId } = params as { viewId: string };
      console.log(`[WebViewView] 注册: ${viewId}`);
      return { registered: true };
    });

    bus.handle('webviewView.unregister', (params) => {
      const { viewId } = params as { viewId: string };
      console.log(`[WebViewView] 注销: ${viewId}`);
      return { unregistered: true };
    });

    // 状态栏
    bus.handle('ui.statusBar.update', (params) => {
      const { id, text } = params as { id: string; text: string; tooltip?: string; command?: string };
      console.log(`[StatusBar] ${id}: ${text}`);
      return { updated: true };
    });

    bus.handle('ui.statusBar.hide', (params) => {
      const { id } = params as { id: string };
      console.log(`[StatusBar] 隐藏: ${id}`);
      return { hidden: true };
    });

    // ActivityBar 徽标
    bus.handle('ui.activityBar.setBadge', (params) => {
      const { id, badge } = params as { id: string; badge?: number };
      this.webViewState?.dispatch({
        type: 'layout/setDockableItemBadge',
        payload: { id, badge },
      });
      return { updated: true };
    });

    // 消息展示
    bus.handle('ui.showMessage', (params) => {
      const { message, type } = params as { message: string; type: 'info' | 'warning' | 'error' };
      console.log(`[Extension] ${type}: ${message}`);
      try { window.alert(`[${type?.toUpperCase() || 'INFO'}] ${message}`); } catch { /* ignore */ }
      return { shown: true };
    });

    console.log('[WebViewServiceAdapter] 已注册 14 个处理器');
  }
}
