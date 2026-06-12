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

function api() {
  return window.electronAPI?.tsserver;
}

export const tsService = {
  /** 启动 tsserver */
  start(rootPath: string) {
    return api()?.start(rootPath) ?? Promise.resolve(false);
  },

  /** 停止 tsserver */
  stop() {
    return api()?.stop() ?? Promise.resolve(false);
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
  async completions(filePath: string, line: number, offset: number) {
    return api()?.completions(filePath, line, offset) ?? [];
  },

  /** 跳转到定义 */
  async definition(filePath: string, line: number, offset: number): Promise<TsLocation[]> {
    return api()?.definition(filePath, line, offset) ?? [];
  },

  /** 悬停信息 */
  async quickInfo(filePath: string, line: number, offset: number) {
    return api()?.quickInfo(filePath, line, offset) ?? null;
  },

  /** 监听诊断推送 */
  onDiagnostics(cb: (data: { file: string; diagnostics: TsDiagnostic[] } | { error: string }) => void) {
    return api()?.onDiagnostics((data) => {
      cb(data);
    }) ?? (() => {});
  },
};
