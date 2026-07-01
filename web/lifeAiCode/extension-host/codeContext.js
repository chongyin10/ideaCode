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
const { isRemoteUri, parseSshUri } = require('./sshUri');

class CodeContextBuilder {
  constructor(rpc) {
    this.rpc = rpc;
    this.maxTotalTokens = 8000;
    this.maxFileSize = 100 * 1024;
    // §TCR：文件访问历史，用于计算时间衰减和共现频率
    this.fileAccessLog = new Map();
    this.recencyLambda = 0.001; // 每毫秒衰减系数（约 10 分钟半衰期）
  }

  /**
   * 构建完整代码上下文
   */
  async buildContext(options = {}) {
    const { selection, maxFiles = 5 } = options;

    let activeEditor = null;
    try {
      activeEditor = await this.rpc.request('editor.getActive', {});
    } catch {
      // ignore
    }
    const activeFile = activeEditor?.document
      ? {
          filePath: activeEditor.document.fileName,
          content: activeEditor.document.content,
          language: activeEditor.document.languageId,
          size: (activeEditor.document.content || '').length,
        }
      : null;

    // 无论是否有激活文件，都尝试获取工作区根目录和项目文件树
    let workspaceRoot = '';
    let remote = null;
    try {
      const folders = await this.rpc.request('workspace.getFolders', {});
      if (folders && folders.length > 0) {
        const uri = folders[0].uri || {};
        workspaceRoot = uri.fsPath || uri.toString?.() || '';
      }
    } catch {
      // ignore
    }

    // §SSH 远程工作区：解析连接信息；本地文件树走 _getFileTree，远程先留空，由 Agent get_file_tree 工具按需获取
    if (isRemoteUri(workspaceRoot)) {
      const sshInfo = parseSshUri(workspaceRoot);
      remote = {
        isRemote: true,
        scheme: sshInfo.scheme,
        connectionId: sshInfo.connectionId,
        remotePath: sshInfo.remotePath,
      };
    }

    let fileTree = '';
    if (workspaceRoot && !remote?.isRemote) {
      try {
        fileTree = this._getFileTree(workspaceRoot, 2, 80);
      } catch {
        // ignore
      }
    }

    if (!activeFile) {
      return {
        activeFile: null,
        relatedFiles: [],
        workspaceRoot,
        fileTree,
        diagnostics: [],
        selection: selection || '',
      };
    }

    let openedFiles = [];
    try {
      openedFiles = await this.rpc.request('editor.getVisible', {});
    } catch {
      // ignore
    }

    // §TCR：更新文件访问历史（用于时间衰减与共现统计）
    const now = Date.now();
    this._touchFile(activeFile.filePath, now);
    if (openedFiles && Array.isArray(openedFiles)) {
      for (const file of openedFiles) {
        if (file?.document?.fileName) {
          this._touchFile(file.document.fileName, now);
        }
      }
    }

    // §TCR：候选文件 = 可见文件（排除当前文件和二进制文件）
    const candidates = [];
    if (openedFiles && Array.isArray(openedFiles)) {
      for (const file of openedFiles) {
        if (!file.document) continue;
        const fp = file.document.fileName;
        if (fp === activeFile.filePath) continue;
        if (this._isBinaryExtension(fp)) continue;
        candidates.push({
          filePath: fp,
          content: file.document.content || '',
          language: file.document.languageId,
        });
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

    // §TCR：数学化排序 + Token 预算选择
    const ranked = this._rankCandidates(activeFile, candidates, workspaceRoot);
    const relatedFiles = this._selectByTokenBudget(
      activeFile,
      ranked,
      selection,
      fileTree,
      diagnostics
    );

    return {
      activeFile,
      relatedFiles,
      workspaceRoot,
      remote,
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

  // ─── TCR（Token-budgeted Context Ranker）相关方法 ───

  _touchFile(filePath, timestamp) {
    const entry = this.fileAccessLog.get(filePath) || { count: 0, lastTime: 0 };
    entry.count += 1;
    entry.lastTime = timestamp;
    this.fileAccessLog.set(filePath, entry);
  }

  _tokenCount(text) {
    return Math.ceil((text || '').length / 4);
  }

  _tokenize(text) {
    const tokens = new Map();
    const parts = (text || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
    for (const t of parts) {
      tokens.set(t, (tokens.get(t) || 0) + 1);
    }
    return tokens;
  }

  _cosineSimilarity(a, b) {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (const [token, count] of a) {
      normA += count * count;
      const cb = b.get(token) || 0;
      dot += count * cb;
    }
    for (const count of b.values()) {
      normB += count * count;
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  _commonPrefixDepth(a, b) {
    const pa = a.split(/[\\/]+/).filter(Boolean);
    const pb = b.split(/[\\/]+/).filter(Boolean);
    let depth = 0;
    const min = Math.min(pa.length, pb.length);
    while (depth < min && pa[depth] === pb[depth]) depth += 1;
    return depth;
  }

  _rankCandidates(activeFile, candidates, workspaceRoot) {
    const activeTokens = this._tokenize(activeFile.content);
    const activePath = activeFile.filePath;
    const now = Date.now();
    const scored = [];

    for (const cand of candidates) {
      const candTokens = this._tokenize(cand.content);
      const sim = this._cosineSimilarity(activeTokens, candTokens);

      // 时间衰减 + 访问频次
      const log = this.fileAccessLog.get(cand.filePath) || { count: 0, lastTime: 0 };
      const recency = log.lastTime > 0 ? Math.exp(-this.recencyLambda * (now - log.lastTime)) : 0;
      const frequency = Math.min(log.count / 10, 1); // 归一化到 0..1
      const accessScore = 0.7 * recency + 0.3 * frequency;

      // 目录邻近度
      const relActive = this._getRelativePath(activePath, workspaceRoot);
      const relCand = this._getRelativePath(cand.filePath, workspaceRoot);
      const commonDepth = this._commonPrefixDepth(relActive, relCand);
      const maxDepth = Math.max(relActive.split(/[\\/]+/).filter(Boolean).length, 1);
      const proximity = commonDepth / maxDepth;

      // 导入/引用信号：当前文件内容中是否出现候选文件名或相对路径
      let importBoost = 0;
      const candBase = require('path').basename(cand.filePath);
      const candRelative = relCand.replace(/^\.\//, '').replace(/\.[^.]+$/, '');
      const activeContent = activeFile.content || '';
      if (activeContent.includes(candBase) || activeContent.includes(candRelative)) {
        importBoost = 0.5;
      }

      // 加权组合（权重和为 1）
      const score = 0.35 * sim + 0.30 * accessScore + 0.20 * proximity + 0.15 * importBoost;

      scored.push({
        ...cand,
        score,
        tokens: this._tokenCount(cand.content),
      });
    }

    // 按单位 token 收益降序，兼顾相关性与经济性
    scored.sort((a, b) => b.score / Math.max(1, b.tokens) - a.score / Math.max(1, a.tokens));
    return scored;
  }

  _selectByTokenBudget(activeFile, ranked, selection, fileTree, diagnostics) {
    const activeTokens = this._tokenCount(activeFile.content);
    const selectionTokens = this._tokenCount(selection || '');
    const treeTokens = this._tokenCount(fileTree || '');
    const diagTokens = diagnostics.length * 15;
    const overhead = 300; // 提示词模板、标题等固定开销
    const reserved = activeTokens + selectionTokens + treeTokens + diagTokens + overhead;
    let remaining = Math.max(0, this.maxTotalTokens - reserved);

    const selected = [];
    for (const cand of ranked) {
      if (remaining <= 0) break;
      let content = cand.content;
      let summarized = false;
      const needTokens = cand.tokens;

      // 超大文件先摘要，避免单个文件吞掉全部预算
      if (content.length > this.maxFileSize) {
        content = this._summarizeLargeFile(content, cand.language);
        summarized = true;
      }

      const actualTokens = this._tokenCount(content);
      if (actualTokens > remaining) {
        // 剩余预算不足完整文件时，尝试用摘要替代
        if (!summarized) {
          content = this._summarizeLargeFile(content, cand.language);
          summarized = true;
        }
        const summaryTokens = this._tokenCount(content);
        if (summaryTokens > remaining) break;
        remaining -= summaryTokens;
      } else {
        remaining -= actualTokens;
      }

      selected.push({
        filePath: cand.filePath,
        content,
        language: cand.language,
        size: cand.content.length,
        summarized,
      });
    }

    return selected;
  }

  _getRelativePath(filePath, workspaceRoot) {
    if (!workspaceRoot) return filePath;
    if (isRemoteUri(workspaceRoot)) {
      const { remotePath } = parseSshUri(workspaceRoot);
      if (filePath.startsWith(remotePath)) {
        return '.' + filePath.slice(remotePath.length);
      }
      if (filePath.startsWith(workspaceRoot)) {
        return '.' + filePath.slice(workspaceRoot.length);
      }
      return filePath;
    }
    if (filePath.startsWith(workspaceRoot)) {
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
