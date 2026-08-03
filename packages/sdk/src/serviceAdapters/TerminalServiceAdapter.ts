/**
 * 终端服务适配器
 *
 * 处理扩展的终端创建/管理请求。
 * 替代原 ExtensionBridge 中的 terminal.* RPC handlers。
 */

import type { IServiceBus } from '@ideacode/kernel';
import type { ServiceAdapter } from './ServiceAdapter.js';

export interface TerminalApiProvider {
  createTab(config: TerminalCreateConfig): Promise<{ tabId: string; processId: number; success: boolean; error?: string }>;
  disposeTab(tabId: string): Promise<void>;
  sendInputByTabId(tabId: string, text: string): Promise<void>;
  showTab(tabId: string): void;
  showPanel(): void;
  hidePanel(): void;
  onTabOutput(tabId: string, handler: (data: string) => void): () => void;
  onTabExit(tabId: string, handler: (exitCode: number) => void): () => void;
}

export interface TerminalCreateConfig {
  cwd?: string;
  shell?: string;
  shellArgs?: string[];
  env?: Record<string, string>;
  name?: string;
  tabId?: string;
  requestId?: string;
}

export class TerminalServiceAdapter implements ServiceAdapter {
  readonly id = 'terminalService';

  private terminalApi: TerminalApiProvider | null = null;

  setTerminalApi(api: TerminalApiProvider): void {
    this.terminalApi = api;
  }

  register(bus: IServiceBus): void {
    // 创建终端
    bus.handle('terminal.create', async (params) => {
      const config = params as TerminalCreateConfig & { requestId?: string };
      const result = await this.terminalApi?.createTab(config);
      if (!result?.success) {
        return { success: false, error: result?.error || '创建终端失败' };
      }
      const { tabId, processId } = result;

      // 转发输出/退出事件到 ServiceBus
      const unsubOutput = this.terminalApi?.onTabOutput(tabId, (data) => {
        bus.publish(`terminal:${tabId}:output`, data);
        bus.publish('terminal:output', { tabId, processId, data });
      });
      this.terminalApi?.onTabExit(tabId, (exitCode) => {
        bus.publish(`terminal:${tabId}:exit`, { exitCode });
        bus.publish('terminal:exit', { tabId, processId, exitCode });
        unsubOutput?.();
      });

      if (config.requestId) {
        bus.publish(`terminal:created`, { requestId: config.requestId, tabId, processId, success: true });
      }

      return { success: true, tabId, processId };
    });

    // 终端输入
    bus.handle('terminal.sendInput', async (params) => {
      const { tabId, text } = params as { tabId: string; text: string };
      await this.terminalApi?.sendInputByTabId(tabId, text);
      return { sent: true };
    });

    // 销毁终端
    bus.handle('terminal.dispose', (params) => {
      const { tabId } = params as { tabId: string };
      this.terminalApi?.disposeTab(tabId);
      return { disposed: true };
    });

    // 显示终端
    bus.handle('terminal.show', (params) => {
      const { tabId } = params as { tabId?: string };
      if (tabId) {
        this.terminalApi?.showTab(tabId);
      } else {
        this.terminalApi?.showPanel();
      }
      return { shown: true };
    });

    // 隐藏终端
    bus.handle('terminal.hide', () => {
      this.terminalApi?.hidePanel();
      return { hidden: true };
    });

    console.log('[TerminalServiceAdapter] 已注册 5 个处理器');
  }
}
