/**
 * Tool: search_in_file
 *
 * 在单个文件内搜索匹配内容（grep 语义）。流式扫描，内存只持有当前行，
 * 可安全搜索超大文件。返回匹配行 + 行号 + 上下文。
 *
 * 与 search_files 的区别：
 *   - search_files: 递归搜索项目多个文件，每文件只返回匹配行
 *   - search_in_file: 深入搜索单个文件，返回上下文，适合定位大文件中的特定内容
 */

const path = require('path');
const SafeFileReader = require('../safeFileReader.cjs');
const tokenBudget = require('../tokenBudget.cjs');

async function searchInFile(args, context) {
  const {
    path: filePathInput,
    pattern,
    isRegex,
    caseSensitive,
    maxMatches,
  } = args || {};

  if (!filePathInput || typeof filePathInput !== 'string') {
    return { success: false, error: '缺少 path 参数' };
  }
  if (!pattern || typeof pattern !== 'string') {
    return { success: false, error: '缺少 pattern 参数' };
  }

  const workspaceRoot = context.workspaceRoot || '';
  let targetPath = filePathInput;
  if (!path.isAbsolute(targetPath) && workspaceRoot) {
    targetPath = path.join(workspaceRoot, targetPath);
  }
  targetPath = path.resolve(targetPath);

  if (workspaceRoot && !targetPath.startsWith(path.resolve(workspaceRoot))) {
    return { success: false, error: `拒绝访问工作区外的路径: ${filePathInput}` };
  }

  try {
    const stat = await SafeFileReader.stat(targetPath);
    if (!stat.isFile()) {
      return { success: false, error: `路径不是文件: ${filePathInput}` };
    }

    const result = await SafeFileReader.searchLines(targetPath, pattern, {
      isRegex: isRegex !== false,
      caseSensitive: caseSensitive !== false,
      maxMatches: Math.min(maxMatches || 50, 200),
      contextLines: 2,
    });

    if (result.error) {
      return { success: false, error: result.error };
    }

    // 格式化匹配结果为可读文本
    const content = formatSearchResults(result, pattern);

    // Token 预算检查
    const maxTokens = tokenBudget.getSafeReturnLimit(context);
    const checked = tokenBudget.checkAndTruncate(content, maxTokens);

    return {
      success: true,
      path: filePathInput,
      pattern,
      matches: result.matches,
      matchCount: result.matches.length,
      totalMatches: result.totalMatches,
      truncated: result.truncated || checked.truncated,
      content: checked.content,
      suggestion: result.truncated
        ? `共找到 ${result.totalMatches} 处匹配，已返回前 ${result.matches.length} 处。如需缩小范围请使用更精确的 pattern。`
        : undefined,
    };
  } catch (err) {
    return { success: false, error: `搜索文件失败: ${err.message}` };
  }
}

/**
 * 格式化搜索结果为可读文本
 */
function formatSearchResults(result, pattern) {
  const lines = [];
  lines.push(`搜索模式: ${pattern}`);
  lines.push(`匹配数: ${result.totalMatches}${result.truncated ? `（已截断，仅显示前 ${result.matches.length} 处）` : ''}`);
  lines.push('');

  for (const m of result.matches) {
    lines.push(`── L${m.line} ──────────────`);
    if (m.contextBefore && m.contextBefore.length > 0) {
      for (const ctx of m.contextBefore) {
        lines.push(`  ${ctx}`);
      }
    }
    lines.push(`▶ ${m.text}`);
    if (m.contextAfter && m.contextAfter.length > 0) {
      for (const ctx of m.contextAfter) {
        lines.push(`  ${ctx}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = searchInFile;
