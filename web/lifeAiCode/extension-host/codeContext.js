/**
 * 代码上下文构建器
 *
 * 职责：
 * - 收集当前编辑器中的代码上下文（激活文件、相关文件、诊断信息）
 * - 构建发送给 LLM 的结构化上下文
 * - 支持按需提取函数定义、类型定义等
 *
 * 原则：
 * - 只读读取，绝不修改任何文件
 * - 通过 Extension Host 的 RPC 机制与渲染进程通信
 * - 自动裁剪过长上下文，避免超出 LLM token 限制
 */

const path = require('path');
const fs = require('fs');

class CodeContextBuilder {
  constructor(rpc) {
    this.rpc = rpc;
    this.maxTotalTokens = 8000;
    this.maxFileSize = 100 * 1024;
  }

  /**
   * 构建完整代码上下文
   */
  async buildContext(options = {}) {
    const { selection, maxFiles = 5 } = options;

    const activeEditor = await this.rpc.request('editor.getActive', {});
    const activeFile = activeEditor?.document
      ? {
          filePath: activeEditor.document.fileName,
          content: activeEditor.document.content,
          language: activeEditor.document.languageId,
          size: (activeEditor.document.content || '').length,
        }
      : null;

    if (!activeFile) {
      return {
        activeFile: null,
        relatedFiles: [],
        workspaceRoot: '',
        diagnostics: [],
        selection: selection || '',
      };
    }

    const openedFiles = await this.rpc.request('editor.getVisible', {});
    const relatedFiles = [];
    if (openedFiles && Array.isArray(openedFiles)) {
      for (const file of openedFiles) {
        if (!file.document) continue;
        const fp = file.document.fileName;
        if (fp === activeFile.filePath) continue;
        if (this._isBinaryExtension(fp)) continue;
        if (relatedFiles.length >= maxFiles) break;

        const content = file.document.content || '';
        if (content.length > this.maxFileSize) {
          relatedFiles.push({
            filePath: fp,
            content: this._summarizeLargeFile(content, file.document.languageId),
            language: file.document.languageId,
            size: content.length,
            summarized: true,
          });
        } else {
          relatedFiles.push({
            filePath: fp,
            content,
            language: file.document.languageId,
            size: content.length,
            summarized: false,
          });
        }
      }
    }

    let diagnostics = [];
    try {
      if (activeFile.language === 'typescript' || activeFile.language === 'javascript') {
        const tsDiag = await this.rpc.request('tsserver.diagnostics', {
          filePath: activeFile.filePath,
        });
        if (tsDiag?.diagnostics) {
          diagnostics = tsDiag.diagnostics.map((d) => ({
            file: activeFile.filePath,
            line: d.start?.line || 0,
            message: d.text || d.message || '',
            severity: d.severity || 1,
          }));
        }
      }
    } catch {
      // LSP 可能尚未就绪
    }

    let workspaceRoot = '';
    try {
      const folders = await this.rpc.request('workspace.getFolders', {});
      if (folders && folders.length > 0) {
        workspaceRoot = folders[0].uri?.fsPath || '';
      }
    } catch {
      // ignore
    }

    let fileTree = '';
    if (workspaceRoot) {
      try {
        fileTree = this._getFileTree(workspaceRoot, 2, 80);
      } catch {
        // ignore
      }
    }

    return {
      activeFile,
      relatedFiles,
      workspaceRoot,
      fileTree,
      diagnostics,
      selection: selection || '',
    };
  }

  /**
   * 将上下文格式化为 LLM 提示词内容
   */
  formatContextForPrompt(context) {
    const parts = [];

    if (context.workspaceRoot) {
      parts.push(`## 工作区\n${context.workspaceRoot}\n`);
    }

    if (context.fileTree) {
      parts.push(`## 项目结构\n${context.fileTree}\n`);
    }

    if (context.activeFile) {
      const f = context.activeFile;
      const relPath = this._getRelativePath(f.filePath, context.workspaceRoot);
      parts.push(`## 当前文件: ${relPath}\n\`\`\`${f.language}\n${f.content}\n\`\`\`\n`);
    }

    if (context.selection) {
      parts.push(`## 选中代码\n\`\`\`\n${context.selection}\n\`\`\`\n`);
    }

    if (context.relatedFiles.length > 0) {
      parts.push(`## 相关文件\n`);
      for (const f of context.relatedFiles) {
        const relPath = this._getRelativePath(f.filePath, context.workspaceRoot);
        const prefix = f.summarized ? '(摘要) ' : '';
        parts.push(`### ${prefix}${relPath}\n\`\`\`${f.language}\n${f.content}\n\`\`\`\n`);
      }
    }

    if (context.diagnostics.length > 0) {
      parts.push(`## 当前诊断错误\n`);
      for (const d of context.diagnostics.slice(0, 20)) {
        parts.push(`- 第 ${d.line} 行: ${d.message}\n`);
      }
    }

    return parts.join('\n');
  }

  _getRelativePath(filePath, workspaceRoot) {
    if (workspaceRoot && filePath.startsWith(workspaceRoot)) {
      return '.' + filePath.slice(workspaceRoot.length);
    }
    return filePath;
  }

  _isBinaryExtension(fp) {
    const ext = path.extname(fp).toLowerCase();
    const binaryExts = new Set([
      '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg',
      '.woff', '.woff2', '.ttf', '.eot',
      '.mp3', '.mp4', '.avi', '.mov',
      '.zip', '.tar', '.gz', '.rar',
      '.pdf', '.doc', '.docx',
      '.exe', '.dll', '.so', '.dylib',
      '.o', '.obj', '.class',
    ]);
    return binaryExts.has(ext);
  }

  _summarizeLargeFile(content, language) {
    const lines = content.split('\n');
    const summary = [];

    let importCount = 0;
    for (const line of lines) {
      if (importCount > 30) break;
      if (line.trim().startsWith('import ') || line.trim().startsWith('export ') ||
          line.trim().startsWith('const ') || line.trim().startsWith('function ') ||
          line.trim().startsWith('class ') || line.trim().startsWith('interface ') ||
          line.trim().startsWith('type ')) {
        summary.push(line);
        importCount++;
      }
    }

    const defs = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('export function ') || trimmed.startsWith('export class ') ||
          trimmed.startsWith('export interface ') || trimmed.startsWith('export type ') ||
          trimmed.startsWith('export const ') || trimmed.startsWith('function ') ||
          trimmed.startsWith('class ') || trimmed.startsWith('interface ') ||
          trimmed.match(/^\w+\s*\(/) || trimmed.match(/^async\s+\w+\s*\(/)) {
        defs.push(trimmed.slice(0, 120));
        if (defs.length > 50) break;
      }
    }

    if (defs.length > 0) {
      summary.push('\n// 定义的符号:');
      summary.push(...defs.map((d) => `//   ${d}`));
    }

    summary.push(`\n// ... 文件共 ${lines.length} 行，此处仅显示结构摘要`);
    return summary.join('\n');
  }

  /**
   * 获取目录树（递归深度受限，跳过常见忽略目录）
   */
  _getFileTree(dir, maxDepth = 2, maxFiles = 80) {
    const ignoredDirs = new Set([
      'node_modules', '.git', 'dist', 'build', 'out', '.vite', '.next', '.nuxt',
      'coverage', '.cache', 'tmp', 'temp', 'vendor', '__pycache__',
    ]);
    const ignoredFiles = new Set([
      '.DS_Store', 'Thumbs.db',
    ]);

    let count = 0;
    const walk = (currentDir, depth) => {
      if (depth > maxDepth || count >= maxFiles) return [];
      const entries = [];
      let items;
      try {
        items = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return [];
      }

      // 目录在前，文件在后，均按字母排序
      const dirs = items.filter((i) => i.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
      const files = items.filter((i) => i.isFile()).sort((a, b) => a.name.localeCompare(b.name));

      for (const item of [...dirs, ...files]) {
        if (count >= maxFiles) break;
        if (item.name.startsWith('.') && !ignoredDirs.has(item.name) && item.isDirectory()) continue;
        if (ignoredDirs.has(item.name)) continue;
        if (item.isFile() && ignoredFiles.has(item.name)) continue;

        const fullPath = path.join(currentDir, item.name);
        const relPath = path.relative(dir, fullPath);
        const prefix = '  '.repeat(depth);
        if (item.isDirectory()) {
          entries.push(`${prefix}📁 ${item.name}/`);
          count++;
          entries.push(...walk(fullPath, depth + 1));
        } else {
          entries.push(`${prefix}📄 ${item.name}`);
          count++;
        }
      }
      return entries;
    };

    const lines = walk(dir, 0);
    return [`📁 ${path.basename(dir)}/`, ...lines].join('\n');
  }
}

module.exports = { CodeContextBuilder };
