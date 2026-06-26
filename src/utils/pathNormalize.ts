/**
 * 规范化路径用于比较：统一斜杠、去除末尾斜杠、解析 . / ..、忽略大小写。
 *
 * 用于解决 macOS/Windows 大小写不敏感文件系统、符号链接/别名、
 * 用户输入路径中多余的 . / .. 等导致的路径字符串不一致问题。
 */
export function normalizePathForCompare(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean)
    .reduce<string[]>((acc, part) => {
      if (part === '..') { acc.pop(); }
      else if (part !== '.') { acc.push(part); }
      return acc;
    }, [])
    .join('/')
    .toLowerCase();
}
