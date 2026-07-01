import { useEffect, useRef } from 'react';
import { useAppSelector } from '../store/hooks';
import { isPath, isRemoteUri } from '../services/fileService';
import { tsService } from '../services/tsLanguageService';

/**
 * 监听 workspace.rootSource 变化，自动启动/重启 tsserver。
 *
 * 背景：tsserver（typescript-language-server）启动时需要扫描 tsconfig.json、
 * 索引 node_modules/@types/，对一个典型 React 项目来说首次冷启动通常需要 1~3s。
 *
 * 此前没有任何调用方调用 `tsService.start(rootPath)`，主进程 `ensureServer` 因 `rootUri`
 * 为 null 永远返回 false，导致 `textDocument/semanticTokens/full` 立即返回 null，
 * Monaco 自定义 SemanticTokensProvider 拿不到结果，进而回退到 Monaco 内置 TS worker
 * 冷启动（≈3s），表现为"打开 React 文件后代码高亮延迟 3 秒才出"。
 *
 * 修复：将启动时机提前到「用户在资源管理器打开文件夹」的瞬间。tsserver 在用户点击首个
 * 文件之前就开始预热，等到用户打开 Home.tsx 时语义高亮基本已就绪。
 *
 * 幂等性由 `tsService.start` 内部维护（相同 rootPath 跳过；in-flight 启动去重），
 * 切换工作区时调用 `tsService.stop` 让旧 server 立即退出。
 */
export function useTsServerLifecycle() {
  const rootSource = useAppSelector((s) => s.workspace.rootSource);

  // 记录当前正在运行的 rootPath，仅用于判断是否真的发生了"切换"。
  // 不能只比较 rootSource 字符串：redux 在重复设置相同值时也会触发 effect 重新执行，
  // 但 tsService.start 内部已有幂等保护，这里再判断一次只是减少无意义的 stop 调用。
  const currentRef = useRef<string | null>(null);

  useEffect(() => {
    // rootSource 可能是 null（欢迎页）或 FileSystemHandle（浏览器 File System Access），
    // 这里只处理本地路径场景：Electron + 选择目录。
    // §SSH 远程路径（ssh:// URI）不启动本地 tsserver——主进程会盲目拼接 file:// 生成
    // 畸形 URI，tsserver 无法找到文件。远程文件的语法高亮退化为 Monaco 内置 tokenizer。
    if (!rootSource || !isPath(rootSource) || isRemoteUri(rootSource)) {
      // 没有 workspace（欢迎页等场景）：不启动 tsserver；如果之前启动过，主动停止。
      if (currentRef.current !== null) {
        currentRef.current = null;
        tsService.stop().catch(() => {});
      }
      return;
    }

    const rootPath = rootSource;
    if (currentRef.current === rootPath) return;
    const previous = currentRef.current;
    currentRef.current = rootPath;

    // 切换工作区：先停旧的，再启新的。stop 失败也不阻塞 start。
    const p = (previous ? tsService.stop().catch(() => false) : Promise.resolve(true))
      .then(() => tsService.start(rootPath))
      .catch(() => false);

    // 暴露未捕获异常的兜底
    p.catch(() => {});
  }, [rootSource]);
}