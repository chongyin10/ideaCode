/**
 * tsserver LSP 渲染进程适配层
 *
 * 职责：封装 IPC 调用，连接 tsserver 与 Monaco Editor。
 */

export interface TsDiagnostic {
  start: { line: number; column: number };
  end: { line: number; column: number };
  message: string;
  category: number; // 8=error, 4=warning, 2=info
  code?: number;
}

export interface TsLocation {
  file: string;
  start: { line: number; offset: number };
  end: { line: number; offset: number };
  originSelectionRange?: { start: { line: number; offset: number }; end: { line: number; offset: number } };
}

export interface TsSemanticTokens {
  legend?: { tokenTypes: string[]; tokenModifiers: string[] };
  resultId?: string;
  data: number[];
}

export interface TsCompletionEntry {
  name: string;
  kind: string;
  sortText?: string;
}

export interface TsQuickInfo {
  displayString?: string;
  kind?: string;
  documentation?: string;
  start?: { line: number; offset: number };
  end?: { line: number; offset: number };
  startLineNumber?: number;
  startColumn?: number;
  endLineNumber?: number;
  endColumn?: number;
}

function api() {
  return window.electronAPI?.tsserver;
}

/**
 * 当前已启动 tsserver 的工作区根路径。
 *
 * tsserver 是绑定 rootPath 启动的进程（启动时需要扫描 tsconfig.json、索引 node_modules/@types），
 * 重复启动同一 rootPath 既浪费资源又会因为 `startServer` 中 `stopServer` 导致旧的立即被关掉、
 * 重新冷启动，延误用户首次打开文件时的语义高亮出现。
 *
 * 在 rootPath 已就绪时直接跳过 IPC，避免渲染端任何重复触发（菜单打开、最近项目、
 * Explorer 按钮、GitSetup 等）造成的"重启抖动"。
 */
let startedRootPath: string | null = null;
let startInFlight: Promise<boolean> | null = null;

export const tsService = {
  /** 启动 tsserver（幂等：相同 rootPath 不会重复启动） */
  start(rootPath: string): Promise<boolean> {
    const a = api();
    if (!a) return Promise.resolve(false);
    if (startedRootPath === rootPath) return Promise.resolve(true);
    if (startInFlight) return startInFlight;
    startInFlight = a.start(rootPath).then(
      (ok) => {
        startedRootPath = ok ? rootPath : startedRootPath;
        return ok;
      },
      (err) => {
        console.warn('[tsserver] 启动失败:', err);
        return false;
      },
    ).finally(() => {
      startInFlight = null;
    });
    return startInFlight;
  },

  /** 同步获取当前已启动的 rootPath（用于调试 / 状态显示） */
  getStartedRootPath(): string | null {
    return startedRootPath;
  },

  /**
   * 停止 tsserver。切换工作区时由 useTsServerLifecycle 调用：
   * 主进程 startServer 内部也会 stopServer，但显式 stop 可以立即让旧 server 退出，
   * 避免 5s+ 的 stdin EOF 等待期间旧 server 仍占用资源。
   */
  stop(): Promise<boolean> {
    const a = api();
    if (!a) return Promise.resolve(false);
    const prev = startedRootPath;
    startedRootPath = null;
    return Promise.resolve(a.stop()).then(
      () => true,
      (err) => {
        console.warn('[tsserver] 停止失败:', err);
        startedRootPath = prev;
        return false;
      },
    );
  },

  /** 打开文件：tsserver 解析并生成诊断 */
  async open(filePath: string, content: string) {
    return api()?.open(filePath, content) ?? null;
  },

  /** 关闭文件 */
  close(filePath: string) {
    return api()?.close(filePath);
  },

  /** 通知 tsserver 文件内容已改变 */
  change(filePath: string, content: string) {
    return api()?.change(filePath, content);
  },

  /** 获取补全建议 */
  async completions(filePath: string, line: number, offset: number): Promise<TsCompletionEntry[]> {
    return (api()?.completions(filePath, line, offset) as TsCompletionEntry[] | undefined) ?? [];
  },

  /** 跳转到定义 */
  async definition(filePath: string, line: number, offset: number): Promise<TsLocation[]> {
    return (api()?.definition(filePath, line, offset) as TsLocation[] | undefined) ?? [];
  },

  /** 语义高亮 tokens */
  async semanticTokens(filePath: string): Promise<TsSemanticTokens | null> {
    return api()?.semanticTokens(filePath) ?? null;
  },

  /** 悬停信息 */
  async quickInfo(filePath: string, line: number, offset: number): Promise<TsQuickInfo | null> {
    return (api()?.quickInfo(filePath, line, offset) as TsQuickInfo | undefined) ?? null;
  },

  /** 监听诊断推送 */
  onDiagnostics(cb: (data: { file: string; diagnostics: TsDiagnostic[] } | { error: string }) => void) {
    return api()?.onDiagnostics((data) => {
      cb(data as { file: string; diagnostics: TsDiagnostic[] } | { error: string });
    }) ?? (() => {});
  },
};
