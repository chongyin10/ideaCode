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
  setActiveGroup,
  setActivePane,
} from '../store/slices/terminalSlice';
import type { TerminalProfile } from '../types/electron';
import type { TerminalTab } from '../store/slices/terminalSlice';
import { createTerminal, sendInput, disposeTerminal, onTerminalOutput } from './terminalManager';
import { clearTerminalSnapshot } from './terminalSnapshot';

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
  /** 是否为独立 Modal 终端，不参与底部面板布局 */
  isModal?: boolean;
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
    const { name, cwd, executable, args, env, profile, autoFocus = true, isModal, input, outputFilter } = options;

    if (autoFocus && !isModal) {
      this.showPanel();
    }

    const tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    store.dispatch(addTab({ id: tabId, name, profile, isModal, outputFilter }));

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
        } else {
          store.dispatch(setTabReady({ id: tabId, pid: result.id, cwd: config.cwd || '' }));
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

  /** 向指定终端进程发送输入 */
  sendInput(processId: number, data: string) {
    return sendInput(processId, data);
  },

  /** 关闭终端 Tab */
  closeTab(tabId: string) {
    store.dispatch(removeTab(tabId));
  },

  /** 重命名终端 Tab */
  renameTab(tabId: string, name: string) {
    store.dispatch(renameTab({ id: tabId, name }));
  },

  /** 根据 Tab ID 发送输入 */
  async sendInputByTabId(tabId: string, data: string): Promise<void> {
    const processId = getProcessIdByTabId(tabId);
    if (processId === undefined) {
      throw new Error(`终端 Tab 不存在或未就绪: ${tabId}`);
    }
    await sendInput(processId, data);
  },

  /** 处置终端 Tab（关闭进程并移除 UI） */
  async disposeTab(tabId: string): Promise<void> {
    const processId = getProcessIdByTabId(tabId);
    if (processId !== undefined) {
      await disposeTerminal(processId);
    }
    store.dispatch(removeTab(tabId));
    tabOutputListeners.delete(tabId);
    tabExitListeners.delete(tabId);
    clearTerminalSnapshot(tabId);
  },

  /** 聚焦并显示指定终端 Tab */
  showTab(tabId: string): void {
    this.showPanel();
    const state = store.getState().terminal;
    const group = state.panelLayout.groups.find((g) => g.panes.some((p) => p.terminalId === tabId));
    if (group) {
      store.dispatch(setActiveGroup(group.id));
      const pane = group.panes.find((p) => p.terminalId === tabId);
      if (pane) {
        store.dispatch(setActivePane({ groupId: group.id, paneId: pane.id }));
      }
    }
  },

  /** 监听指定 Tab 的输出 */
  onTabOutput(tabId: string, callback: (data: string) => void): () => void {
    ensureGlobalOutputListener();
    if (!tabOutputListeners.has(tabId)) {
      tabOutputListeners.set(tabId, new Set());
    }
    tabOutputListeners.get(tabId)!.add(callback);
    return () => {
      tabOutputListeners.get(tabId)?.delete(callback);
    };
  },

  /** 监听指定 Tab 的退出事件 */
  onTabExit(tabId: string, callback: (exitCode?: number) => void): () => void {
    ensureGlobalOutputListener();
    if (!tabExitListeners.has(tabId)) {
      tabExitListeners.set(tabId, new Set());
    }
    tabExitListeners.get(tabId)!.add(callback);
    return () => {
      tabExitListeners.get(tabId)?.delete(callback);
    };
  },
};

/* ─── Tab 级输出/退出事件路由 ─── */

type OutputListener = (data: string) => void;
type ExitListener = (exitCode?: number) => void;

const tabOutputListeners = new Map<string, Set<OutputListener>>();
const tabExitListeners = new Map<string, Set<ExitListener>>();

let globalOutputUnsub: (() => void) | null = null;

function ensureGlobalOutputListener(): void {
  if (globalOutputUnsub) return;
  globalOutputUnsub = onTerminalOutput((event) => {
    if (event.type === 'data' && event.data !== undefined) {
      const tab = findTabByProcessId(event.id);
      if (tab) {
        const callbacks = tabOutputListeners.get(tab.id);
        if (callbacks) {
          callbacks.forEach((cb) => cb(event.data as string));
        }
      }
    } else if (event.type === 'exit') {
      const tab = findTabByProcessId(event.id);
      if (tab) {
        const callbacks = tabExitListeners.get(tab.id);
        if (callbacks) {
          callbacks.forEach((cb) => cb(event.exitCode));
        }
      }
    }
  });
}

function getProcessIdByTabId(tabId: string): number | undefined {
  return store.getState().terminal.tabs[tabId]?.processId ?? undefined;
}

function findTabByProcessId(processId: number): TerminalTab | undefined {
  return Object.values(store.getState().terminal.tabs).find((t) => t.processId === processId);
}
