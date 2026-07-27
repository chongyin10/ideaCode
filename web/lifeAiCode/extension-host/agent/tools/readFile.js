/**
 * Tool: read_file
 *
 * 读取指定文件内容。
 * 支持绝对路径和相对于工作区的路径。
 * §SSH 远程工作区支持：优先使用 context.fs 统一适配器，自动桥接到 SSH FileSystemProvider。
 */

const fs = require('fs');
const path = require('path');
const SafeFileReader = require('../safeFileReader.cjs');
const { isRemoteUri } = require('../../sshUri');
const { extractDocumentText, isDocumentFile } = require('../../docExtractor');

async function readFile(args, context) {
  const { path: filePathInput } = args || {};
  if (!filePathInput || typeof filePathInput !== 'string') {
    return { success: false, error: '缺少 path 参数' };
  }

  const workspaceRoot = context.workspaceRoot || '';

  // §统一 fs 适配器：本地走 Node fs，远程走 SSH provider
  const fsAdapter = context.fs || createLocalFsAdapter();

  try {
    const stat = await fsAdapter.stat(filePathInput);
    if (!stat || stat.isDirectory) {
      return { success: false, error: `路径不是文件: ${filePathInput}` };
    }

    // §文档类文件（docx/pdf）：提取纯文本返回，而非二进制乱码（LLM 读不了二进制）
    if (isDocumentFile(filePathInput)) {
      if (isRemoteUri(workspaceRoot)) {
        return { success: false, error: '暂不支持远程工作区的文档提取（docx/pdf），请下载到本地后重试' };
      }
      const result = await extractDocumentText(resolveLocalPath(filePathInput, workspaceRoot));
      if (!result.success) {
        return { success: false, error: result.error };
      }
      return {
        success: true,
        path: filePathInput,
        size: result.size,
        document: true,
        truncated: result.truncated || false,
        content: result.text,
      };
    }

    // 大文件智能路由：超过 500KB 时不返回截断内容，
    // 而是返回文件结构大纲 + 使用建议，让大模型自适应选择分片读取工具
    const MAX_SIZE = 500 * 1024; // 500KB
    if (stat.size > MAX_SIZE) {
      const language = SafeFileReader.detectLanguage(filePathInput);
      let outline;
      try {
        // 本地文件才能走流式 outline；远程文件会抛错，降级处理
        if (!isRemoteUri(workspaceRoot)) {
          outline = await SafeFileReader.extractOutline(resolveLocalPath(filePathInput, workspaceRoot), language);
        } else {
          throw new Error('remote file');
        }
      } catch (err) {
        const content = await fsAdapter.readFile(filePathInput);
        const lines = (typeof content === 'string' ? content : content.toString('utf-8')).split('\n');
        outline = {
          symbols: [],
          imports: [],
          exports: [],
          totalLines: lines.length,
          truncated: true,
        };
      }
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

    const content = await fsAdapter.readFile(filePathInput);
    return {
      success: true,
      path: filePathInput,
      size: stat.size,
      content: typeof content === 'string' ? content : content.toString('utf-8'),
    };
  } catch (err) {
    return { success: false, error: `读取文件失败: ${err.message}` };
  }
}

function createLocalFsAdapter() {
  return {
    stat: (p) => fs.promises.stat(p),
    readFile: (p) => fs.promises.readFile(p, 'utf-8'),
  };
}

function resolveLocalPath(inputPath, workspaceRoot) {
  if (!path.isAbsolute(inputPath) && workspaceRoot && !isRemoteUri(workspaceRoot)) {
    return path.resolve(path.join(workspaceRoot, inputPath));
  }
  return path.resolve(inputPath);
}

module.exports = readFile;
