/**
 * Tool: read_file
 *
 * 读取指定文件内容。
 * 支持绝对路径和相对于工作区的路径。
 */

const fs = require('fs');
const path = require('path');
const SafeFileReader = require('../safeFileReader.cjs');

async function readFile(args, context) {
  const { path: filePathInput } = args || {};
  if (!filePathInput || typeof filePathInput !== 'string') {
    return { success: false, error: '缺少 path 参数' };
  }

  const workspaceRoot = context.workspaceRoot || '';
  let targetPath = filePathInput;

  // 处理相对路径
  if (!path.isAbsolute(targetPath) && workspaceRoot) {
    targetPath = path.join(workspaceRoot, targetPath);
  }

  targetPath = path.resolve(targetPath);

  // 路径边界检查
  if (workspaceRoot && !targetPath.startsWith(path.resolve(workspaceRoot))) {
    return { success: false, error: `拒绝访问工作区外的路径: ${filePathInput}` };
  }

  try {
    const stat = await fs.promises.stat(targetPath);
    if (!stat.isFile()) {
      return { success: false, error: `路径不是文件: ${filePathInput}` };
    }

    // 大文件智能路由：超过 500KB 时不返回截断内容，
    // 而是返回文件结构大纲 + 使用建议，让大模型自适应选择分片读取工具
    const MAX_SIZE = 500 * 1024; // 500KB
    if (stat.size > MAX_SIZE) {
      const language = SafeFileReader.detectLanguage(targetPath);
      const outline = await SafeFileReader.extractOutline(targetPath, language);
      const sizeKB = (stat.size / 1024).toFixed(1);
      return {
        success: true,
        path: filePathInput,
        size: stat.size,
        language,
        totalLines: outline.totalLines,
        largeFile: true,
        truncated: true,
        content: '',
        outline: outline.symbols,
        imports: outline.imports,
        exports: outline.exports,
        suggestion: `文件较大（${sizeKB}KB / ${outline.totalLines} 行），已返回结构大纲而非全文。请使用 read_file_lines(path, startLine, endLine) 读取感兴趣的行范围（单次≤500行），或使用 search_in_file(path, pattern) 搜索特定内容。`,
      };
    }

    const content = await fs.promises.readFile(targetPath, 'utf-8');
    return {
      success: true,
      path: filePathInput,
      size: stat.size,
      content,
    };
  } catch (err) {
    return { success: false, error: `读取文件失败: ${err.message}` };
  }
}

module.exports = readFile;
