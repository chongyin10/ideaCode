/**
 * SafeFileReader — 安全的流式文件读取基础设施
 *
 * 所有文件读取类 Agent 工具的底层模块。核心原则：
 * 1. 永不 readFile 全文，一律 createReadStream 流式处理
 * 2. 行范围读取提前 destroy，不读不需要的部分
 * 3. 搜索/大纲提取用流式 grep，内存只持有当前行
 *
 * 这样可以安全处理任意大小文件，不会触发 V8 Invalid string length。
 */

const fs = require('fs');

const SafeFileReader = {
  /**
   * 预检查文件状态
   * @returns {Promise<fs.Stats>}
   */
  async stat(filePath) {
    return fs.promises.stat(filePath);
  },

  /**
   * 检测文件语言（根据扩展名）
   */
  detectLanguage(filePath) {
    const ext = filePath.split('.').pop()?.toLowerCase();
    const map = {
      js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
      ts: 'typescript', tsx: 'typescript',
      py: 'python',
      java: 'java', kt: 'kotlin',
      go: 'go',
      rs: 'rust',
      rb: 'ruby',
      php: 'php',
      c: 'c', cpp: 'cpp', cc: 'cpp', h: 'c', hpp: 'cpp',
      cs: 'csharp',
      swift: 'swift',
      md: 'markdown', markdown: 'markdown',
      json: 'json',
      yaml: 'yaml', yml: 'yaml',
      xml: 'xml', html: 'html', htm: 'html',
      css: 'css', scss: 'css', less: 'css',
      sh: 'shell', bash: 'shell',
      sql: 'sql',
    };
    return map[ext] || 'unknown';
  },

  /**
   * 流式读取指定行范围
   * 到达 endLine 后立即 destroy stream，不读后续内容
   *
   * @param {string} filePath
   * @param {number} startLine - 起始行（1-based）
   * @param {number} endLine - 结束行（1-based，包含）
   * @param {object} options - { maxLines: 500 }
   * @returns {Promise<{lines: Array<{line:number, content:string}>, startLine, endLine, totalLines, stoppedEarly: boolean}>}
   */
  async readLines(filePath, startLine, endLine, options = {}) {
    const maxLines = options.maxLines || 500;
    const start = Math.max(1, Math.floor(startLine));
    const end = Math.min(start + maxLines - 1, Math.floor(endLine));

    return new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
      let leftover = '';
      let lineNum = 1;
      const collected = [];
      let totalLines = 0;
      let done = false;

      const finish = (stoppedEarly) => {
        if (done) return;
        done = true;
        resolve({
          lines: collected,
          startLine: start,
          endLine: end,
          totalLines: Math.max(totalLines, lineNum),
          stoppedEarly: !!stoppedEarly,
        });
      };

      stream.on('data', (chunk) => {
        if (done) return;
        leftover += chunk;
        const parts = leftover.split('\n');
        leftover = parts.pop(); // 保留最后未结束的行

        for (let i = 0; i < parts.length; i++) {
          totalLines = lineNum;
          if (lineNum >= start && lineNum <= end) {
            collected.push({ line: lineNum, content: parts[i] });
          }
          if (lineNum >= end) {
            // 已读到目标范围末尾，继续扫描剩余 chunk 计算 totalLines
            // 但如果已经收集够了且不需要精确 totalLines，提前终止
            stream.destroy();
            // 继续解析剩余 parts 以估算 totalLines
            totalLines = lineNum + (parts.length - i - 1);
            finish(true);
            return;
          }
          lineNum++;
        }
      });

      stream.on('end', () => {
        if (done) return;
        // 处理最后一行（没有尾换行的情况）
        if (leftover !== '') {
          totalLines = lineNum;
          if (lineNum >= start && lineNum <= end) {
            collected.push({ line: lineNum, content: leftover });
          }
        }
        finish(false);
      });

      stream.on('error', (err) => {
        if (!done) reject(err);
      });
    });
  },

  /**
   * 流式统计文件总行数
   */
  async countLines(filePath) {
    return new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
      let count = 0;
      let leftover = '';

      stream.on('data', (chunk) => {
        leftover += chunk;
        const parts = leftover.split('\n');
        leftover = parts.pop();
        count += parts.length;
      });

      stream.on('end', () => {
        if (leftover !== '') count++; // 最后一行无换行符
        resolve(count);
      });

      stream.on('error', reject);
    });
  },

  /**
   * 流式搜索文件内容（grep 语义）
   * 内存只持有当前行 + 少量上下文行
   *
   * @param {string} filePath
   * @param {string} pattern - 搜索模式
   * @param {object} options - { isRegex, caseSensitive, maxMatches, contextLines }
   * @returns {Promise<{matches: Array, totalMatches: number, truncated: boolean}>}
   */
  async searchLines(filePath, pattern, options = {}) {
    const maxMatches = options.maxMatches || 50;
    const isRegex = options.isRegex !== false;
    const caseSensitive = options.caseSensitive !== false;
    const contextLines = options.contextLines ?? 2;

    let regex;
    try {
      if (isRegex) {
        regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
      } else {
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        regex = new RegExp(escaped, caseSensitive ? 'g' : 'gi');
      }
    } catch (err) {
      return { error: `无效的搜索模式: ${err.message}`, matches: [], totalMatches: 0 };
    }

    return new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
      let leftover = '';
      let lineNum = 1;
      const matches = [];
      let totalMatches = 0;
      let done = false;
      const recentLines = []; // 滑动窗口存 contextBefore
      const pendingAfter = []; // 需要填充 contextAfter 的匹配项

      const finish = () => {
        if (done) return;
        done = true;
        // 清理临时字段
        for (const m of matches) {
          delete m._needAfter;
          delete m._afterStartLine;
        }
        resolve({ matches, totalMatches, truncated: totalMatches > matches.length });
      };

      stream.on('data', (chunk) => {
        if (done) return;
        leftover += chunk;
        const parts = leftover.split('\n');
        leftover = parts.pop();

        for (const line of parts) {
          // 检查匹配
          regex.lastIndex = 0;
          if (regex.test(line)) {
            totalMatches++;
            if (matches.length < maxMatches) {
              matches.push({
                line: lineNum,
                text: line.length > 200 ? line.substring(0, 200) + '…' : line,
                contextBefore: recentLines.slice(-contextLines),
                contextAfter: [],
                _needAfter: contextLines,
                _afterStartLine: lineNum,
              });
            }
          }

          // 填充之前匹配项的 contextAfter
          for (const m of pendingAfter.length > 0 ? matches : []) {
            if (m._needAfter > 0 && lineNum > m._afterStartLine) {
              m.contextAfter.push(line.length > 200 ? line.substring(0, 200) + '…' : line);
              m._needAfter--;
            }
          }

          // 维护滑动窗口
          recentLines.push(line);
          if (recentLines.length > contextLines) recentLines.shift();

          lineNum++;

          // 达到最大匹配数，继续读 contextLines 行后终止
          if (totalMatches >= maxMatches) {
            // 检查是否所有 contextAfter 都已填充
            const allFilled = matches.every((m) => m._needAfter === 0);
            if (allFilled) {
              stream.destroy();
              finish();
              return;
            }
          }
        }
      });

      stream.on('end', () => {
        if (done) return;
        // 处理最后一行
        if (leftover !== '') {
          regex.lastIndex = 0;
          if (regex.test(leftover)) {
            totalMatches++;
            if (matches.length < maxMatches) {
              matches.push({
                line: lineNum,
                text: leftover.length > 200 ? leftover.substring(0, 200) + '…' : leftover,
                contextBefore: recentLines.slice(-contextLines),
                contextAfter: [],
              });
            }
          }
        }
        finish();
      });

      stream.on('error', (err) => {
        if (!done) reject(err);
      });
    });
  },

  /**
   * 流式提取文件大纲（函数/类/方法签名 + import/export）
   * 按语言选择匹配模式，流式扫描，内存只持有当前行
   *
   * @param {string} filePath
   * @param {string} language
   * @returns {Promise<{symbols: Array, imports: string[], exports: string[], totalLines, truncated: boolean}>}
   */
  async extractOutline(filePath, language) {
    const MAX_SYMBOLS = 200;
    const patterns = getOutlinePatterns(language);
    const symbols = [];
    const imports = [];
    const exports = [];

    return new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
      let leftover = '';
      let lineNum = 1;
      let done = false;

      const finish = (truncated) => {
        if (done) return;
        done = true;
        resolve({
          symbols: symbols.slice(0, MAX_SYMBOLS),
          imports: imports.slice(0, 50),
          exports: exports.slice(0, 50),
          totalLines: lineNum,
          truncated: !!truncated,
        });
      };

      stream.on('data', (chunk) => {
        if (done) return;
        leftover += chunk;
        const parts = leftover.split('\n');
        leftover = parts.pop();

        for (const line of parts) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') && language !== 'python') {
            lineNum++;
            continue;
          }

          // 匹配 imports
          for (const re of patterns.imports) {
            if (re.test(trimmed)) {
              imports.push(trimmed.length > 120 ? trimmed.substring(0, 120) + '…' : trimmed);
              break;
            }
          }

          // 匹配 exports
          for (const re of patterns.exports) {
            if (re.test(trimmed)) {
              exports.push(trimmed.length > 120 ? trimmed.substring(0, 120) + '…' : trimmed);
              break;
            }
          }

          // 匹配符号定义
          for (const re of patterns.symbols) {
            const m = trimmed.match(re.regex);
            if (m) {
              symbols.push({
                name: m[1] || m[0].substring(0, 60),
                kind: re.kind,
                line: lineNum,
                signature: trimmed.length > 120 ? trimmed.substring(0, 120) + '…' : trimmed,
              });
              break;
            }
          }

          if (symbols.length >= MAX_SYMBOLS) {
            stream.destroy();
            finish(true);
            return;
          }
          lineNum++;
        }
      });

      stream.on('end', () => {
        if (done) return;
        if (leftover !== '') lineNum++;
        finish(false);
      });

      stream.on('error', (err) => {
        if (!done) reject(err);
      });
    });
  },
};

/**
 * 按语言获取大纲匹配模式
 */
function getOutlinePatterns(language) {
  const lang = (language || '').toLowerCase();

  // 通用 import/export 模式
  const jsImports = [
    /^\s*import\s+.+/,
    /^\s*require\s*\(/,
    /^\s*import\s*\(/,
  ];
  const jsExports = [
    /^\s*export\s+(default\s+)?/,
    /^\s*module\.exports\s*=/,
    /^\s*exports\./,
  ];

  const patterns = {
    imports: jsImports,
    exports: jsExports,
    symbols: [],
  };

  if (lang === 'javascript' || lang === 'typescript') {
    patterns.symbols = [
      { regex: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/, kind: 'function' },
      { regex: /^\s*(?:export\s+)?(?:default\s+)?class\s+([\w$]+)/, kind: 'class' },
      { regex: /^\s*(?:export\s+)?interface\s+([\w$]+)/, kind: 'interface' },
      { regex: /^\s*(?:export\s+)?type\s+([\w$]+)\s*=/, kind: 'type' },
      { regex: /^\s*(?:export\s+)?enum\s+([\w$]+)/, kind: 'enum' },
      { regex: /^\s*(?:export\s+)?const\s+([\w$]+)\s*=\s*(?:async\s*)?\(/, kind: 'function' },
      { regex: /^\s*(?:export\s+)?const\s+([\w$]+)\s*=\s*(?:async\s*)?function/, kind: 'function' },
      { regex: /^\s*(?:export\s+)?const\s+([\w$]+)\s*=\s*(?:async\s*)?[\w$.]+\s*=>/, kind: 'function' },
      { regex: /^\s*([\w$]+)\s*\(.*\)\s*\{/, kind: 'method' }, // 简单方法签名
    ];
  } else if (lang === 'python') {
    patterns.imports = [/^\s*import\s+/, /^\s*from\s+.+\s+import\s+/];
    patterns.exports = [/^\s*__all__\s*=/];
    patterns.symbols = [
      { regex: /^\s*(?:async\s+)?def\s+(\w+)/, kind: 'function' },
      { regex: /^\s*class\s+(\w+)/, kind: 'class' },
    ];
  } else if (lang === 'markdown') {
    patterns.imports = [];
    patterns.exports = [];
    patterns.symbols = [
      { regex: /^(#{1,6})\s+(.+)$/, kind: 'heading' },
    ];
  } else if (lang === 'json') {
    patterns.imports = [];
    patterns.exports = [];
    patterns.symbols = [
      { regex: /^\s*"([^"]+)"\s*:/, kind: 'key' },
    ];
  } else if (lang === 'go') {
    patterns.imports = [/^\s*import\s+/];
    patterns.exports = [];
    patterns.symbols = [
      { regex: /^\s*func\s+(?:\([^)]+\)\s+)?(\w+)/, kind: 'function' },
      { regex: /^\s*type\s+(\w+)\s+/, kind: 'type' },
      { regex: /^\s*struct\s*{/, kind: 'struct' },
    ];
  } else if (lang === 'rust') {
    patterns.imports = [/^\s*use\s+/];
    patterns.exports = [/^\s*pub\s+/];
    patterns.symbols = [
      { regex: /^\s*(?:pub\s+)?fn\s+(\w+)/, kind: 'function' },
      { regex: /^\s*(?:pub\s+)?struct\s+(\w+)/, kind: 'struct' },
      { regex: /^\s*(?:pub\s+)?enum\s+(\w+)/, kind: 'enum' },
      { regex: /^\s*(?:pub\s+)?trait\s+(\w+)/, kind: 'trait' },
      { regex: /^\s*impl\s+([\w<>]+)/, kind: 'impl' },
    ];
  } else if (lang === 'java' || lang === 'kotlin' || lang === 'csharp') {
    patterns.imports = [/^\s*import\s+/];
    patterns.exports = [];
    patterns.symbols = [
      { regex: /^\s*(?:public|private|protected)?\s*(?:static\s+)?class\s+(\w+)/, kind: 'class' },
      { regex: /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:void|[\w<>\[\]]+)\s+(\w+)\s*\(/, kind: 'method' },
      { regex: /^\s*interface\s+(\w+)/, kind: 'interface' },
    ];
  } else {
    // 通用回退：匹配缩进 + 标识符 + 括号
    patterns.symbols = [
      { regex: /^\s*(?:function|def|class|interface|struct|fn)\s+(\w+)/, kind: 'symbol' },
    ];
  }

  return patterns;
}

module.exports = SafeFileReader;
