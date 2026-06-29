/**
 * Agent Tool Schema 定义
 *
 * 统一描述所有可用工具的输入输出格式。
 * 同时用于：
 * 1. 生成给 LLM 的 system prompt
 * 2. 校验 LLM 输出的 tool_call 参数
 * 3. 未来转换为各 Provider 的 native tool_calls 格式
 */

const TOOL_SCHEMAS = [
  {
    name: 'read_file',
    description: '读取指定文件的完整内容。path 支持绝对路径或相对于工作区的相对路径。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径，例如 "src/main.ts" 或绝对路径',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'get_file_tree',
    description: '获取项目或指定目录的目录树结构，便于了解项目布局。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '目录路径，默认为当前工作区根目录',
        },
        depth: {
          type: 'number',
          description: '递归深度，默认 2，最大 4',
        },
      },
      required: [],
    },
  },
  {
    name: 'search_files',
    description: '在项目中搜索匹配指定模式的文件或代码内容。支持字符串包含匹配。',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: '要搜索的字符串或正则表达式',
        },
        glob: {
          type: 'string',
          description: '文件通配符，例如 "**/*.ts"、"src/**/*.tsx"，默认为 "**/*"',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'execute_shell',
    description: '执行 shell 命令并返回输出。可用于运行构建、测试、脚本等。危险命令会被拦截或需要用户确认。',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '要执行的 shell 命令',
        },
        cwd: {
          type: 'string',
          description: '命令执行的工作目录，默认为当前工作区根目录',
        },
        timeout: {
          type: 'number',
          description: '超时时间（毫秒），默认 60000',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'apply_edit',
    description: '对文件进行安全的查找替换修改。修改不会立即落盘，会先生成建议供用户确认。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '要修改的文件路径',
        },
        original: {
          type: 'string',
          description: '文件中需要被替换的原始代码片段',
        },
        modified: {
          type: 'string',
          description: '替换后的新代码片段',
        },
      },
      required: ['path', 'original', 'modified'],
    },
  },
  {
    name: 'write_file',
    description: '创建新文件或全量覆盖已有文件。写入不会立即落盘，会先生成建议供用户确认。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径',
        },
        content: {
          type: 'string',
          description: '文件完整内容',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'delete_file',
    description: '删除指定文件。删除不可逆，不会立即落盘，会先生成删除建议供用户确认。仅用于删除工作区内的文件。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '要删除的文件路径',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_file_outline',
    description: '提取文件的结构大纲（函数/类/方法签名、import/export 列表），流式扫描可安全处理任意大小文件。当文件过大或不确定大小时，应优先使用此工具了解文件结构，再决定读取哪些行。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_file_lines',
    description: '读取文件中指定行范围的内容（1-based 行号）。流式读取，可安全处理超大文件的局部读取。单次最多 500 行。典型用法：先用 read_file_outline 获取结构找到目标行号，再用本工具精读。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径',
        },
        startLine: {
          type: 'number',
          description: '起始行号（≥1）',
        },
        endLine: {
          type: 'number',
          description: '结束行号（≥startLine，含本行，单次不超过 500 行）',
        },
      },
      required: ['path', 'startLine', 'endLine'],
    },
  },
  {
    name: 'search_in_file',
    description: '在单个文件内搜索匹配内容（grep 语义），返回匹配行+行号+上下文。流式扫描可安全搜索超大文件。适合在大文件中定位特定内容。与 search_files 的区别：search_files 递归搜索多个文件，本工具深入搜索单个文件并返回上下文。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径',
        },
        pattern: {
          type: 'string',
          description: '搜索模式（字符串或正则表达式）',
        },
        isRegex: {
          type: 'boolean',
          description: '是否为正则表达式，默认 true',
        },
        caseSensitive: {
          type: 'boolean',
          description: '是否区分大小写，默认 true',
        },
        maxMatches: {
          type: 'number',
          description: '最大返回匹配数，默认 50，最大 200',
        },
      },
      required: ['path', 'pattern'],
    },
  },
  {
    name: 'read_file_chunks',
    description: '将文件按固定行数分块，按 chunkIndex 读取指定块（从 0 开始）。适合顺序遍历大文件。默认每块 200 行，最多 500 行。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径',
        },
        chunkIndex: {
          type: 'number',
          description: '块索引（从 0 开始）',
        },
        chunkSize: {
          type: 'number',
          description: '每块行数，默认 200，最大 500',
        },
      },
      required: ['path', 'chunkIndex'],
    },
  },
];

/**
 * 获取工具 schema 列表
 */
function getToolSchemas() {
  return TOOL_SCHEMAS;
}

/**
 * 获取指定工具的 schema
 */
function getToolSchema(name) {
  return TOOL_SCHEMAS.find((t) => t.name === name) || null;
}

/**
 * 将 schema 列表格式化为 prompt 文本
 */
function formatToolSchemasForPrompt() {
  const lines = [];
  for (const tool of TOOL_SCHEMAS) {
    lines.push(`### ${tool.name}`);
    lines.push(tool.description);
    lines.push('参数：');
    const props = tool.parameters.properties || {};
    const required = tool.parameters.required || [];
    for (const [key, value] of Object.entries(props)) {
      const req = required.includes(key) ? '（必填）' : '（可选）';
      lines.push(`  - ${key}${req}: ${value.description || value.type}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = {
  getToolSchemas,
  getToolSchema,
  formatToolSchemasForPrompt,
};
