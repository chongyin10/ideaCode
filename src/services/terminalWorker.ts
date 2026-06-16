/**
 * terminalWorker.ts — WebWorker 终端渲染隔离
 * 
 * 将 xterm.js 的 VT 解析运行在 Web Worker 中，主线程只负责 DOM 更新。
 * 此文件构建为独立的 Worker bundle。
 * 
 * 优势：
 * 1. 避免大量 VT 输出阻塞主线程（Monaco 编辑器不受影响）
 * 2. 可以多线程并行处理多个终端的输出
 * 3. 主线程卡顿不会导致终端丢帧
 * 
 * 注意：由于 xterm.js 对 DOM 有直接依赖，完整的 Worker 化需要较多适配工作。
 * 此处提供的是轻量级方案：将输出文本的批处理/节流放到 Worker 中。
 */

// Worker 消息类型
interface WorkerMessage {
  type: 'write' | 'resize' | 'dispose';
  id: string;
  data?: {
    text?: string;
    cols?: number;
    rows?: number;
  };
}

interface WorkerResponse {
  type: 'rendered' | 'error';
  id: string;
  /** 输出中提取的文件路径信息 */
  filePaths?: Array<{ path: string; line?: number; col?: number }>;
  /** 输出中提取的错误信息 */
  errors?: Array<{ message: string; severity: 'error' | 'warning' }>;
}

// 终端实例缓冲
const buffers = new Map<string, {
  text: string;
  cols: number;
  rows: number;
}>();

/**
 * 解析输出文本中的文件路径
 */
function parseFilePaths(text: string): Array<{ path: string; line?: number; col?: number }> {
  const results: Array<{ path: string; line?: number; col?: number }> = [];
  
  // 匹配 file:line:col 格式 (如 src/app.ts:42:10)
  const pattern = /(\S+\.\w{1,10}):(\d+):(\d+)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    results.push({
      path: match[1],
      line: parseInt(match[2]),
      col: parseInt(match[3]),
    });
  }
  return results;
}

/**
 * 解析输出文本中的错误信息
 */
function parseErrors(text: string): Array<{ message: string; severity: 'error' | 'warning' }> {
  const errors: Array<{ message: string; severity: 'error' | 'warning' }> = [];
  
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.includes('error') || line.includes('Error')) {
      if (line.length < 300) {
        errors.push({ message: line.trim(), severity: 'error' });
      }
    } else if (line.includes('warning') || line.includes('Warning')) {
      if (line.length < 300) {
        errors.push({ message: line.trim(), severity: 'warning' });
      }
    }
  }
  return errors;
}

/**
 * 处理终端写入
 */
function handleWrite(id: string, text: string): WorkerResponse {
  let buffer = buffers.get(id);
  if (!buffer) {
    buffer = { text: '', cols: 80, rows: 24 };
    buffers.set(id, buffer);
  }

  buffer.text += text;

  // 限制 buffer 大小
  const MAX_BUFFER = 100000;
  if (buffer.text.length > MAX_BUFFER) {
    buffer.text = buffer.text.slice(-MAX_BUFFER);
  }

  const filePaths = parseFilePaths(text);
  const errors = parseErrors(text);

  return {
    type: 'rendered',
    id,
    filePaths: filePaths.length > 0 ? filePaths : undefined,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Worker 消息处理器
 */
self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const { type, id, data } = event.data;

  switch (type) {
    case 'write': {
      if (data?.text) {
        const response = handleWrite(id, data.text);
        self.postMessage(response);
      }
      break;
    }
    case 'dispose': {
      buffers.delete(id);
      break;
    }
    default: {
      self.postMessage({ type: 'error', id, error: `未知消息类型: ${type}` });
    }
  }
};
