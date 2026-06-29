/**
 * 规范化路径用于比较：统一斜杠、去除末尾斜杠、解析 . / ..、忽略大小写。
 *
 * 用于解决 macOS/Windows 大小写不敏感文件系统、符号链接/别名、
 * 用户输入路径中多余的 . / .. 等导致的路径字符串不一致问题。
 */
export function normalizePathForCompare(p: string): string {
  return (p || '')
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

/**
 * §需求：把任意 filePath（绝对 / 相对 / 含 ./../ 等冗余）转换为
 * 用于比较的「绝对路径 key」。
 *
 * - 已是绝对路径（mac/linux 以 / 开头、windows 以 [a-zA-Z]:/ 开头）：直接规范化
 * - 相对路径：拼接 workspaceRoot 后规范化
 * - workspaceRoot 缺失：仅做规范化（best effort）
 *
 * 用例：LLM 在多轮输出中可能给出 `./vite.config.ts` / `vite.config.ts` /
 * `/abs/.../vite.config.ts` 三种字面串，但实际指向同一文件，按裸字符串比较
 * 会判为不同 → 重复渲染 SuggestionCard。本函数把它们归一为同一个 key。
 */
export function toAbsolutePathKey(filePath: string, workspaceRoot?: string): string {
  if (!filePath) return '';
  const fp = filePath.trim();
  if (!fp) return '';
  // 已是绝对路径（mac/linux 或 windows）
  const isAbsolute = fp.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(fp);
  const abs = isAbsolute ? fp : (workspaceRoot ? `${workspaceRoot.replace(/[\\/]+$/, '')}/${fp.replace(/^[\\/]+/, '')}` : fp);
  return normalizePathForCompare(abs);
}