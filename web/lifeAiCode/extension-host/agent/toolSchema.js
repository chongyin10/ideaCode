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
