/**
 * LLM Adapter for Agent
 *
 * 包装 LlmClient，提供：
 * 1. Agent 专用 system prompt（含 tool schema）
 * 2. Prompt-based <tool_call> 标签解析
 * 3. Native tool_calls 支持（OpenAI 兼容 Provider）
 * 4. 结果回传 message 组装
 */

const { formatToolSchemasForPrompt, getToolSchemas } = require('./toolSchema');

// 支持原生 function calling 的 Provider（OpenAI 兼容格式）
const NATIVE_TOOL_PROVIDERS = new Set([
  'openai', 'deepseek', 'glm', 'qwen', 'kimi', 'MiniMax', 'doubao', 'custom',
]);

class LlmAdapter {
  constructor(llmClient) {
    this.llmClient = llmClient;
  }

  /**
   * 当前 Provider 是否支持原生 tool_calls
   */
  supportsNativeToolCalling() {
    if (!this.llmClient) return false;
    return NATIVE_TOOL_PROVIDERS.has(this.llmClient.provider);
  }

  /**
   * 构建 Agent 专用 system prompt
   */
  buildAgentSystemPrompt(useNativeTools = false) {
    const toolSchemas = formatToolSchemasForPrompt();
    if (useNativeTools) {
      return `你是 LifeAiCode Agent，运行在 IDEACODE IDE 中。你可以调用工具完成用户任务。

## 语言要求
- 始终使用中文进行思考、推理和回复。
- <step> 标签内的描述文字、<think> 标签内的推理内容、以及最终总结，都必须使用中文。

## 核心原则
- 你只能读取、搜索、执行命令或生成修改建议，不会直接修改文件。
- 修改文件前，必须先调用 read_file 读取当前内容，再调用 apply_edit 生成建议。
- 对于批量修改，先 search_files，再 read_file，再 apply_edit。
- 你只能访问工作区内的文件和目录。
- 当你认为任务完成时，输出最终总结。

## 文件读取策略
根据文件大小和目的选择合适的工具：
1. 小文件（已知较小）或需读取完整文件 → read_file
2. 不确定文件大小或文件较大 → 先调 read_file_outline 获取结构大纲
3. 知道行号范围 → read_file_lines（单次≤500行）
4. 知道要找的内容但不知道行号 → search_in_file
5. 需要顺序通读大文件 → read_file_chunks 逐块读取
注意：read_file 返回 largeFile 标记时，说明文件过大已切换为大纲模式，不要重复调用 read_file，改用上述分片工具。

## 文件修改策略
1. 创建新文件或全量覆盖 → write_file（不会立即落盘，生成建议供用户确认）
2. 修改文件局部内容 → apply_edit（先 read_file 读取当前内容，再 apply_edit 生成建议）
3. 删除文件 → delete_file（不可逆操作，生成建议供用户确认）
注意：所有修改/删除操作都不会立即落盘，需用户在 UI 中确认后才真正应用。

## 项目创建/初始化策略（重要）
当用户要求"创建项目"、"初始化项目"、"搭建项目"等任务时：
1. **优先使用 execute_shell 执行脚手架命令**（如 npm create vite@latest、npx create-react-app 等），这会真正在磁盘上创建完整的文件结构。
2. 如果脚手架命令不可用或需要自定义文件，**使用 execute_shell 的 heredoc 方式批量创建文件**，例如：
   execute_shell: command="mkdir -p src && cat > src/App.tsx << 'EOF'\nimport React from 'react'\nexport default function App() { return <div>Hello</div> }\nEOF"
3. **避免逐个调用 write_file 创建项目文件**——write_file 只生成待确认建议，不会立即落盘，批量调用会导致所有文件都卡在待确认队列，用户需要逐个确认，体验极差。
4. write_file 适用于：用户明确要求"生成修改建议"的场景，而非需要立即生效的文件创建。
5. **create-vite 等脚手架命令如果目标目录已存在会自动覆盖**——执行环境已自动追加 \`--force\`，无需手动 \`rmdir\` / \`rm -rf\`。如果确实需要保留旧目录，请选择新的项目名。

## Node.js 版本兼容性（重要）
当前运行环境可能是 Node.js 18。create-vite@latest（v9+）要求 Node ≥ 20.19，在 Node 18 上会崩溃。
- **创建 Vite 项目时务必使用 create-vite@5**（而非 @latest），例如：npx create-vite@5 my-app -- --template react-ts
- create-vite@5 完全兼容 Node 18，生成的项目结构与 @latest 基本一致。
- 其他脚手架（create-react-app 等）如遇类似 EBADENGINE 错误，同样需要指定兼容版本号。

## 任务完成判断
- 只有当所有文件已真正创建（通过 execute_shell）或所有修改建议已生成（通过 write_file/apply_edit）时，才可宣布任务完成。
- 创建项目后，使用 execute_shell 运行 ls -la 或 find . -type f 验证文件结构是否完整。
- 如果有步骤失败，必须重试或换方案，不能跳过失败步骤直接宣布完成。

## 步骤可视化
在分析过程中可以使用以下标签让 IDE 实时显示进度：
- 读取文件：<step type="read" target="path/to/file.ts">读取</step>
- 搜索：<step type="agent" target="search">搜索</step>
- 运行命令：<step type="run" target="npm run build">运行</step>
- 编辑文件：<step type="edit" target="path/to/file.ts">编辑</step>
- 思考：<step type="think">思考</step>`;
    }

    return `你是 LifeAiCode Agent，运行在 IDEACODE IDE 中。你可以调用工具完成用户任务。

## 语言要求
- 始终使用中文进行思考、推理和回复。
- <step> 标签内的描述文字、<think> 标签内的推理内容、以及最终总结，都必须使用中文。

## 核心原则
- 你只能读取、搜索、执行命令或生成修改建议，不会直接修改文件。
- 修改文件前必须先调用 read_file 读取当前内容，再调用 apply_edit 生成建议。
- 对于批量修改，先 search_files，再 read_file，再 apply_edit。
- 你只能访问工作区内的文件和目录。

## 文件读取策略
根据文件大小和目的选择合适的工具：
1. 小文件（已知较小）或需读取完整文件 → read_file
2. 不确定文件大小或文件较大 → 先调 read_file_outline 获取结构大纲
3. 知道行号范围 → read_file_lines（单次≤500行）
4. 知道要找的内容但不知道行号 → search_in_file
5. 需要顺序通读大文件 → read_file_chunks 逐块读取
注意：read_file 返回 largeFile 标记时，说明文件过大已切换为大纲模式，不要重复调用 read_file，改用上述分片工具。

## 文件修改策略
1. 创建新文件或全量覆盖 → write_file（不会立即落盘，生成建议供用户确认）
2. 修改文件局部内容 → apply_edit（先 read_file 读取当前内容，再 apply_edit 生成建议）
3. 删除文件 → delete_file（不可逆操作，生成建议供用户确认）
注意：所有修改/删除操作都不会立即落盘，需用户在 UI 中确认后才真正应用。

## 项目创建/初始化策略（重要）
当用户要求"创建项目"、"初始化项目"、"搭建项目"等任务时：
1. **优先使用 execute_shell 执行脚手架命令**（如 npm create vite@latest、npx create-react-app 等），这会真正在磁盘上创建完整的文件结构。
2. 如果脚手架命令不可用或需要自定义文件，**使用 execute_shell 的 heredoc 方式批量创建文件**，例如：
   execute_shell: command="mkdir -p src && cat > src/App.tsx << 'EOF'\nimport React from 'react'\nexport default function App() { return <div>Hello</div> }\nEOF"
3. **避免逐个调用 write_file 创建项目文件**——write_file 只生成待确认建议，不会立即落盘，批量调用会导致所有文件都卡在待确认队列，用户需要逐个确认，体验极差。
4. write_file 适用于：用户明确要求"生成修改建议"的场景，而非需要立即生效的文件创建。
5. **create-vite 等脚手架命令如果目标目录已存在会自动覆盖**——执行环境已自动追加 \`--force\`，无需手动 \`rmdir\` / \`rm -rf\`。如果确实需要保留旧目录，请选择新的项目名。

## Node.js 版本兼容性（重要）
当前运行环境可能是 Node.js 18。create-vite@latest（v9+）要求 Node ≥ 20.19，在 Node 18 上会崩溃。
- **创建 Vite 项目时务必使用 create-vite@5**（而非 @latest），例如：npx create-vite@5 my-app -- --template react-ts
- create-vite@5 完全兼容 Node 18，生成的项目结构与 @latest 基本一致。
- 其他脚手架（create-react-app 等）如遇类似 EBADENGINE 错误，同样需要指定兼容版本号。

## 任务完成判断
- 只有当所有文件已真正创建（通过 execute_shell）或所有修改建议已生成（通过 write_file/apply_edit）时，才可宣布任务完成。
- 创建项目后，使用 execute_shell 运行 ls -la 或 find . -type f 验证文件结构是否完整。
- 如果有步骤失败，必须重试或换方案，不能跳过失败步骤直接宣布完成。

## 可用工具
${toolSchemas}

## 调用规则
1. 当需要调用工具时，必须且仅输出一个：
   <tool_call>{"name": "工具名", "arguments": {...}}</tool_call>
2. 不要输出任何解释、推理或 Markdown，直接输出 <tool_call>。
3. 工具执行结果会以 <tool_result>...</tool_result> 形式返回，你基于结果继续调用工具或总结。
4. 当你认为任务完成时，输出最终总结，不要再输出 <tool_call>。
5. 如果工具执行失败，根据错误信息重试或调整策略。

## 步骤可视化
在分析过程中可以使用以下标签让 IDE 实时显示进度：
- 读取文件：<step type="read" target="path/to/file.ts">读取</step>
- 搜索：<step type="agent" target="search">搜索</step>
- 运行命令：<step type="run" target="npm run build">运行</step>
- 编辑文件：<step type="edit" target="path/to/file.ts">编辑</step>
- 思考：<step type="think">思考</step>`;
  }

  /**
   * 将统一 Tool Schema 转换为 OpenAI 兼容的 native tools 格式
   */
  toNativeTools() {
    const schemas = getToolSchemas();
    return schemas.map((s) => ({
      type: 'function',
      function: {
        name: s.name,
        description: s.description,
        parameters: s.parameters,
      },
    }));
  }

  /**
   * 从 native 响应中解析 tool_calls
   */
  parseNativeToolCalls(response) {
    if (!response || typeof response !== 'object') return null;
    const toolCalls = response.toolCalls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;

    const tc = toolCalls[0];
    if (!tc.function || !tc.function.name) return null;

    let args = {};
    try {
      args = JSON.parse(tc.function.arguments || '{}');
    } catch {
      args = {};
    }

    return { name: tc.function.name, arguments: args };
  }

  /**
   * 发送消息并获取 LLM 回复
   * @param {Array} messages OpenAI 格式消息数组
   * @param {object} options { stream?, onToken?, signal? }
   * @returns {Promise<string|{content:string,toolCalls:Array}>}
   */
  async chat(messages, options = {}) {
    if (!this.llmClient) {
      throw new Error('LLM 客户端未初始化');
    }

    const useNative = this.supportsNativeToolCalling();
    const systemPrompt = this.buildAgentSystemPrompt(useNative);
    const { stream = true, onToken, signal } = options;

    const requestOptions = {
      systemPrompt,
      // 始终返回对象：DeepSeek thinking mode 要求多轮对话回传 reasoning_content，
      // prompt-based 模式下也需要拿到 reasoningContent 以便回传，不能只返回字符串。
      returnRaw: true,
      signal, // 把 AbortSignal 透传到底层 HTTP 请求
    };

    if (useNative) {
      requestOptions.tools = this.toNativeTools();
      requestOptions.tool_choice = 'auto';
    }

    // 重要：只在流式模式下注册 token 监听。
    // 之前 removeAllListeners('token') 会清掉其他消费者（如 processMessage），
    // 这里改成精确移除"上一次自己注册的 listener"，避免破坏其他订阅者。
    if (stream && typeof onToken === 'function') {
      if (this._boundTokenListener) {
        this.llmClient.off('token', this._boundTokenListener);
      }
      this._boundTokenListener = onToken;
      this.llmClient.on('token', onToken);
    }

    try {
      if (stream) {
        return await this.llmClient.chatStream(messages, requestOptions);
      }
      return await this.llmClient.chat(messages, requestOptions);
    } finally {
      // 无论成功/失败都清理 listener。原代码只在 catch 中清理，
      // 正常完成后 listener 仍挂在 llmClient 上，若 llmClient 被复用
      // 触发 emit('token')，旧 listener 会被错误调用。
      if (stream && this._boundTokenListener === onToken) {
        try { this.llmClient.off('token', this._boundTokenListener); } catch { /* ignore */ }
        this._boundTokenListener = null;
      }
    }
  }

  /**
   * 从 LLM 回复中解析 tool_call（Prompt-based）
   * @param {string} content
   * @returns {object|null} { name, arguments } 或 null
   */
  parseToolCall(content) {
    if (!content || typeof content !== 'string') return null;
    const match = content.match(/<tool_call>\s*({[\s\S]*?})\s*<\/tool_call>/);
    if (!match) return null;

    try {
      const parsed = JSON.parse(match[1]);
      if (!parsed.name || typeof parsed.name !== 'string') return null;
      if (!parsed.arguments || typeof parsed.arguments !== 'object') {
        parsed.arguments = {};
      }
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * 统一解析 tool_call：优先 native，fallback 到 prompt-based
   */
  extractToolCall(response) {
    if (this.supportsNativeToolCalling() && response && typeof response === 'object') {
      const native = this.parseNativeToolCalls(response);
      if (native) return native;
    }
    if (typeof response === 'string') {
      return this.parseToolCall(response);
    }
    if (response && typeof response.content === 'string') {
      return this.parseToolCall(response.content);
    }
    return null;
  }

  /**
   * 将 tool 结果格式化为 message 追加到对话
   */
  buildToolResultMessage(toolName, result, callId = `call-${Date.now()}`) {
    // B6: prompt-based 模式（anthropic/ollama）不支持 role: 'tool'，
    // _buildRequestBody 会把 tool 消息当作未知角色处理，导致 API 报错或被丢弃。
    // 改用 user 角色 + <tool_result> 文本协议，让 LLM 在文本流中读取工具结果。
    if (this.supportsNativeToolCalling()) {
      return {
        role: 'tool',
        content: JSON.stringify(result),
        tool_call_id: callId,
        name: toolName,
      };
    }
    // prompt-based：用 user 角色 + tool_result 标签
    return {
      role: 'user',
      content: `<tool_result>\n${JSON.stringify(result)}\n</tool_result>`,
    };
  }

  /**
   * 将 tool_call 格式化为 assistant message 追加到对话（native 格式）
   */
  buildToolCallMessage(toolName, args, callId = `call-${Date.now()}`, reasoningContent = '') {
    // B5: prompt-based 模式（anthropic/ollama）不支持 tool_calls 数组，
    // _buildRequestBody 仅取 { role, content }，tool_calls 会被丢弃，
    // 导致 LLM 多轮对话看不到自己上一步的 tool_call，无法正确续接。
    // 改为把 tool_call 渲染为文本协议放入 content。
    if (this.supportsNativeToolCalling()) {
      const msg = {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: callId,
          type: 'function',
          function: {
            name: toolName,
            arguments: JSON.stringify(args),
          },
        }],
      };
      // DeepSeek thinking mode 要求 assistant 消息始终携带 reasoning_content 字段，
      // 即使为空字符串也必须存在，否则 API 报 400: "reasoning_content must be passed back"。
      msg.reasoning_content = reasoningContent || '';
      return msg;
    }
    // prompt-based：把 tool_call 渲染为 system prompt 约定的文本协议
    // 必须用 <tool_call> 标签包裹，与 parseToolCall 的解析正则保持一致，
    // 否则 LLM 多轮对话中看到自己上一轮的裸 JSON 会产生格式漂移。
    const toolCallText = `<tool_call>\n${JSON.stringify({ name: toolName, arguments: args }, null, 2)}\n</tool_call>`;
    // reasoning_content 作为独立字段保留，不混合到 content 中；
    // _buildRequestBody 对支持 reasoning 的 provider 会原样透传该字段。
    const msg = { role: 'assistant', content: toolCallText };
    msg.reasoning_content = reasoningContent || '';
    return msg;
  }
}

module.exports = { LlmAdapter };
