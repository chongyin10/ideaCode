/* ANSI 转义序列剥离属于终端场景的合法用途，豁免 no-control-regex */
/* eslint-disable no-control-regex */
import { useState, useEffect, useRef, useMemo, memo } from 'react';
import { Terminal, Loader2, X, ChevronRight } from 'lucide-react';

interface ShellEntry {
  id: string;
  output: string;
  status: 'running' | 'success' | 'error' | 'killed' | 'deferred';
  longRunning?: boolean;
}

interface ShellInteractionProps {
  shells: ShellEntry[];
  onShellInput: (id: string, input: string) => void;
  onKillShell: (id: string) => void;
}

/**
 * §strip ANSI 转义序列（颜色、光标移动等），让 PTY 输出在 <pre> 中可读。
 * create-vite / prompts / inquirer 等交互式库会输出大量 ANSI 控制序列，
 * 直接显示会乱码（如 \x1b[36m\x1b[39m\x1b[2K\x1b[1A）。
 */
function stripAnsi(text: string): string {
   
  return text
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '') // CSI 序列
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC 序列
    .replace(/\x1b./g, ''); // 其他单字符转义
}

interface SelectOption {
  text: string;
  selected: boolean;
  index: number;
}

interface ParsedSelect {
  question: string;
  options: SelectOption[];
}

/**
 * §解析 PTY 输出中的交互式选择菜单。
 *
 * prompts / inquirer 等库的输出格式（strip ANSI 后）：
 *   ? Target directory is not empty. Remove existing files and continue?
 *     ❯   Remove existing files and continue
 *         Cancel operation
 *         Ignore files and continue
 *
 * 识别策略：
 * 1. 从末尾找包含 `❯` 的行（当前选中项）— 取最后一次重绘的菜单
 * 2. 用选中项的缩进作为基准，向上向下收集缩进 >= 基准的连续行作为选项
 * 3. 向上找最近的 `?` 开头行作为问题文本
 *
 * 返回 null 表示未识别到选择菜单（可能是文本输入型提示，退化为输入框）
 */
function parseSelectOptions(cleanOutput: string): ParsedSelect | null {
  const lines = cleanOutput.split('\n');

  // §从末尾找包含 ❯ 的行（最后一次菜单重绘的选中项）
  let selectedIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes('❯') || lines[i].match(/^\s*>/)) {
      selectedIdx = i;
      break;
    }
  }
  if (selectedIdx === -1) return null;

  // §选中项的缩进作为基准
  const indentMatch = lines[selectedIdx].match(/^(\s*)/);
  const baseIndent = indentMatch ? indentMatch[1].length : 0;
  if (baseIndent === 0 && !lines[selectedIdx].match(/^\s*[❯>]/)) return null;

  // §向上收集选项行：缩进 >= baseIndent 且非空
  let startIdx = selectedIdx;
  while (startIdx > 0) {
    const prev = lines[startIdx - 1];
    const prevIndent = prev.match(/^(\s*)/)?.[1].length ?? 0;
    if (prev.trim().length === 0) break;
    if (prevIndent < baseIndent) break;
    // §排除明显不是选项的行（如包含 ? 的问题行）
    if (/^\s*[?❓]/.test(prev)) break;
    startIdx--;
  }

  // §向下收集选项行
  let endIdx = selectedIdx;
  while (endIdx < lines.length - 1) {
    const next = lines[endIdx + 1];
    const nextIndent = next.match(/^(\s*)/)?.[1].length ?? 0;
    if (next.trim().length === 0) break;
    if (nextIndent < baseIndent) break;
    endIdx++;
  }

  // §提取选项文本
  const options: SelectOption[] = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const line = lines[i];
    const isSelected = line.includes('❯') || /^\s*>/.test(line);
    // 去除前导空格、❯、> 等标记，提取纯文本
    const text = line.replace(/^[\s❯>]+/, '').trim();
    if (text) {
      options.push({ text, selected: isSelected, index: options.length });
    }
  }

  if (options.length < 2) return null;

  // §找问题文本：选项上方最近的 ? 开头行
  let question = '';
  for (let i = startIdx - 1; i >= 0 && i >= startIdx - 5; i--) {
    const qMatch = lines[i].match(/^\s*[?❓]\s*(.+)$/);
    if (qMatch) {
      question = qMatch[1].trim();
      break;
    }
  }

  return { question, options };
}

/**
 * §交互式 Shell 面板：当 Agent 执行的 shell 命令需要用户交互时
 * （如 create-vite 的"Remove/Cancel/Ignore"选择），
 * 显示 PTY 实时输出并提供可视化选择 / 输入框让用户响应。
 *
 * 数据来源：ChatPanel 的 shellOutputs 中 status='running' 且 id 以 'agent-shell-' 开头的条目。
 * 输入发送：通过 onShellInput → vscode.postMessage({ command: 'shellInput', id, input })
 * 后端处理：extension.js 的 shellInput case → proc.write(input)
 */
function ShellEntryView({
  entry,
  onShellInput,
  onKillShell,
}: {
  entry: ShellEntry;
  onShellInput: (id: string, input: string) => void;
  onKillShell: (id: string) => void;
}) {
  const [showRawOutput, setShowRawOutput] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);

  const cleanOutput = useMemo(() => stripAnsi(entry.output), [entry.output]);
  const parsedSelect = useMemo(() => parseSelectOptions(cleanOutput), [cleanOutput]);

  // §自动滚动到底部（仅 raw output 模式）
  useEffect(() => {
    if (outputRef.current && showRawOutput) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [cleanOutput, showRawOutput]);

  // §点击选项：计算从当前选中项到目标项的偏移，发送对应次数的上/下箭头 + 回车确认
  const handleSelectOption = (targetIndex: number) => {
    if (!parsedSelect) return;
    const current = parsedSelect.options.find((o) => o.selected);
    const currentIdx = current ? current.index : 0;
    const diff = targetIndex - currentIdx;
    let seq = '';
    if (diff > 0) {
      seq = '\x1b[B'.repeat(diff); // 下箭头
    } else if (diff < 0) {
      seq = '\x1b[A'.repeat(-diff); // 上箭头
    }
    seq += '\r'; // 回车确认
    onShellInput(entry.id, seq);
  };

  return (
    <div className="shell-interaction shell-interaction--running">
      <div className="shell-interaction__header">
        <span className="shell-interaction__icon">
          <Terminal size={12} strokeWidth={1.8} />
        </span>
        <span className="shell-interaction__title">交互式终端</span>
        <span className="shell-interaction__hint">等待输入</span>
        <Loader2 size={11} strokeWidth={2.5} className="shell-interaction__spinner" />
        <button
          type="button"
          className="shell-interaction__kill"
          title="终止命令"
          onClick={() => onKillShell(entry.id)}
        >
          <X size={12} strokeWidth={2} />
        </button>
      </div>

      {/* §可视化选择列表：识别到 select 菜单时渲染可点击选项 */}
      {parsedSelect ? (
        <div className="shell-interaction__select">
          {parsedSelect.question && (
            <div className="shell-interaction__question">{parsedSelect.question}</div>
          )}
          <div className="shell-interaction__options">
            {parsedSelect.options.map((opt) => (
              <button
                key={opt.index}
                type="button"
                className={`shell-interaction__option ${opt.selected ? 'shell-interaction__option--selected' : ''}`}
                onClick={() => handleSelectOption(opt.index)}
                title={`选择：${opt.text}`}
              >
                <span className="shell-interaction__option-marker">
                  {opt.selected ? <ChevronRight size={13} strokeWidth={2.5} /> : null}
                </span>
                <span className="shell-interaction__option-text">{opt.text}</span>
              </button>
            ))}
          </div>
          <div className="shell-interaction__select-tip">点击选项即可选择并确认</div>
        </div>
      ) : (
        <pre ref={outputRef} className="shell-interaction__output">{cleanOutput}</pre>
      )}

      {/* §折叠的原始输出（select 模式下可展开查看完整 PTY 输出） */}
      {parsedSelect && (
        <button
          type="button"
          className="shell-interaction__toggle-raw"
          onClick={() => setShowRawOutput((v) => !v)}
        >
          {showRawOutput ? '隐藏原始输出' : '查看原始输出'}
        </button>
      )}
      {parsedSelect && showRawOutput && (
        <pre ref={outputRef} className="shell-interaction__output shell-interaction__output--raw">{cleanOutput}</pre>
      )}
    </div>
  );
}

function ShellInteractionBase({ shells, onShellInput, onKillShell }: ShellInteractionProps) {
  if (shells.length === 0) return null;
  return (
    <div className="shell-interaction-list">
      {shells.map((entry) => (
        <ShellEntryView
          key={entry.id}
          entry={entry}
          onShellInput={onShellInput}
          onKillShell={onKillShell}
        />
      ))}
    </div>
  );
}

export const ShellInteraction = memo(ShellInteractionBase);
