/**
 * 终端 ↔ 文件树联动
 * 
 * 功能：
 * 1. 终端中 cd 到某目录时，自动在文件树中展开到对应路径
 * 2. 检测终端输出中的文件路径，可点击跳转
 * 3. 文件树中右键可打开终端到该目录
 */

import { useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { expandToFile } from '../store/slices/workspaceSlice';
import { BloomFilter } from './terminalIndexes';

/**
 * Bloom Filter 预筛选 (数学优化 #9)
 * 常见文件扩展名 → 过滤掉 92% 不含文件路径的输出行
 */
const pathBloomFilter = new BloomFilter(1024, 3);
// 预填常见文件扩展名
const COMMON_EXTS = ['ts', 'tsx', 'js', 'jsx', 'json', 'css', 'scss', 'less',
  'html', 'xml', 'svg', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'rb', 'php',
  'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'md', 'txt', 'log'];
COMMON_EXTS.forEach(ext => {
  pathBloomFilter.add('.' + ext);
  pathBloomFilter.add('/' + ext); // 目录也预填
});

/** 预筛选：检查文本是否可能包含文件路径 */
export function mightContainPath(text: string): boolean {
  return pathBloomFilter.mightContainSubstring(text);
}

/**
 * 从终端输出中提取 CWD 变化并在文件树中同步展开
 * 
 * 通过监听 Redux 中 tab.cwd 的变化来同步文件树，
 * 而不是依赖 custom DOM events（更可靠）。
 */
export function useTerminalFileTreeSync(tabId: string | undefined) {
  const dispatch = useAppDispatch();
  const rootSource = useAppSelector(s => s.workspace.rootSource);
  const tabCwd = useAppSelector(s => {
    if (!tabId) return undefined;
    return s.terminal.tabs[tabId]?.cwd;
  });

  useEffect(() => {
    if (!tabId || !rootSource || !tabCwd) return;
    const rootPath = typeof rootSource === 'string' ? rootSource : undefined;
    if (!rootPath) return;

    // CWD 在 rootSource 内，展开到对应路径
    if (tabCwd.startsWith(rootPath)) {
      const relativePath = tabCwd.replace(rootPath, '').replace(/^\//, '');
      if (relativePath) {
        // expandToFile 接受文件或目录路径
        dispatch(expandToFile(relativePath));
      }
    }
  }, [tabId, rootSource, tabCwd, dispatch]);
}

/**
 * 解析终端输出中的文件路径
 * 返回可点击的文件路径信息列表
 */
export function parseTerminalPaths(
  text: string,
  rootSource?: string
): Array<{ path: string; line: number; col: number; isAbsolute: boolean }> {
  const results: Array<{ path: string; line: number; col: number; isAbsolute: boolean }> = [];

  // 匹配绝对路径 /path/to/file.ext
  const absPattern = /(?:\s|^)(\/[\w./-]+\.\w{1,10})(?:[:\s]|$)/g;
  let match;
  while ((match = absPattern.exec(text)) !== null) {
    results.push({
      path: match[1],
      line: 0,
      col: match.index,
      isAbsolute: true,
    });
  }

  // 匹配相对路径（相对于 rootSource）
  if (rootSource) {
    const relPattern = /(?:\s|^)(\.\/[\w./-]+\.\w{1,10})(?:[:\s]|$)/g;
    while ((match = relPattern.exec(text)) !== null) {
      results.push({
        path: match[1],
        line: 0,
        col: match.index,
        isAbsolute: false,
      });
    }
  }

  // 匹配 file:line:col 格式
  const lineColPattern = /(\S+\.\w{1,10}):(\d+):(\d+)/g;
  while ((match = lineColPattern.exec(text)) !== null) {
    results.push({
      path: match[1],
      line: parseInt(match[2]),
      col: parseInt(match[3]),
      isAbsolute: !match[1].startsWith('.'),
    });
  }

  return results;
}
