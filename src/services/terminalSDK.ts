/**
 * Terminal SDK
 *
 * 对外暴露的终端 API，解耦扩展/插件与 BottomPanel 组件。
 * 所有终端操作都通过 Redux state 驱动，BottomPanel 只负责渲染。
 */

import { store } from '../store';
import { setBottomPanelVisible, switchBottomTab } from '../store/slices/layoutSlice';
import {
  addTab,
  removeTab,
  setTabProcessId,
  setTabReady,
  setTabConnecting,
  setTabExited,
  renameTab,
} from '../store/slices/terminalSlice';
import type { TerminalProfile } from '../types/electron';
import { createTerminal, sendInput, onTerminalOutput } from './terminalManager';

export interface TerminalCreateOptions {
  /** Tab 显示名称 */
  name?: string;
  /** 工作目录 */
  cwd?: string;
  /** 要执行的程序（默认使用系统 shell） */
  executable?: string;
  /** 程序参数 */
  args?: string[];
  /** 环境变量 */
  env?: Record<string, string>;
  /** 指定 shell profile（与 executable 二选一） */
  profile?: TerminalProfile;
  /** 是否自动显示并聚焦底部终端面板（默认 true） */
  autoFocus?: boolean;
  /** 终端启动后自动输入的文本（例如 SSH 密码），注意隐私安全 */
  input?: string;
  /** 输出过滤正则字符串，用于隐藏密码提示等不美观内容 */
  outputFilter?: string;
}

export interface TerminalCreateResult {
  tabId: string;
  processId?: number;
  success: boolean;
  error?: string;
}

export const terminalSDK = {
  /** 显示底部终端面板 */
  showPanel() {
    store.dispatch(setBottomPanelVisible(true));
    store.dispatch(switchBottomTab('terminal'));
  },

  /** 隐藏底部终端面板 */
  hidePanel() {
    store.dispatch(setBottomPanelVisible(false));
  },

  /** 设置当前底部 Tab 为终端 */
  focusTerminalTab() {
    store.dispatch(switchBottomTab('terminal'));
  },

  /**
   * 创建一个新的终端 Tab
   */
  async createTab(options: TerminalCreateOptions): Promise<TerminalCreateResult> {
    const { name, cwd, executable, args, env, profile, autoFocus = true, input, outputFilter } = options;

    if (autoFocus) {
      this.showPanel();
    }

    const tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    store.dispatch(addTab({ id: tabId, name, profile, outputFilter }));

    const config: import('../types/electron').TerminalCreateConfig = {
      cwd,
      executable,
      args,
      env,
    };

    try {
      const result = await createTerminal(config);
      if (result.success && result.id) {
        store.dispatch(setTabProcessId({ id: tabId, processId: result.id }));
        if (input) {
          // 标记为连接中，等终端出现 password 提示后再自动输入
          store.dispatch(setTabConnecting({ id: tabId, connecting: true }));
          let sent = false;
          let outputBuffer = '';
          const text = input.endsWith('\r') || input.endsWith('\n') ? input : `${input}\r`;

          const unsub = onTerminalOutput((event) => {
            if (event.id !== result.id || sent) return;

            if (event.type === 'data') {
              const data = typeof event.data === 'string' ? event.data : '';
              outputBuffer += data;
              // 保留最近 512 字符，避免无限制增长
              if (outputBuffer.length > 512) {
                outputBuffer = outputBuffer.slice(-512);
              }
              if (/password\s*:/i.test(outputBuffer)) {
                sent = true;
                unsub();
                sendInput(result.id as number, text);
                store.dispatch(setTabConnecting({ id: tabId, connecting: false }));
                store.dispatch(setTabReady({ id: tabId, pid: result.id, cwd: config.cwd || '' }));
              }
            }
          });

          // 兜底：3 秒后无论是否检测到 prompt 都发送一次并结束 connecting
          setTimeout(() => {
            if (!sent && result.id) {
              sent = true;
              unsub();
              sendInput(result.id, text);
              store.dispatch(setTabConnecting({ id: tabId, connecting: false }));
              store.dispatch(setTabReady({ id: tabId, pid: result.id, cwd: config.cwd || '' }));
            }
          }, 3000);
        }
        return { tabId, processId: result.id, success: true };
      }
      store.dispatch(setTabExited({ id: tabId, exitCode: -1 }));
      return { tabId, success: false, error: result.error || '创建终端进程失败' };
    } catch (err) {
      store.dispatch(setTabExited({ id: tabId, exitCode: -1 }));
      return {
        tabId,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  /** 关闭终端 Tab */
  closeTab(tabId: string) {
    store.dispatch(removeTab(tabId));
  },

  /** 重命名终端 Tab */
  renameTab(tabId: string, name: string) {
    store.dispatch(renameTab({ id: tabId, name }));
  },
};
