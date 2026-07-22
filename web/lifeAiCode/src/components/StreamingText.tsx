import { useState, useEffect, useRef } from 'react';
import { MarkdownContent } from './MarkdownContent';
import type { ShellOutputsMap } from './codeblock';

interface StreamingTextProps {
  content: string;
  isStreaming: boolean;
  onOptionClick?: (text: string) => void;
  onExecuteShell?: (id: string, command: string) => void;
  onKillShell?: (id: string) => void;
  shellOutputs?: ShellOutputsMap;
}

const TYPEWRITER_INTERVAL_MS = 30;

/**
 * §流式打字机效果：将模型一次性返回的 token 缓冲后，按固定节奏逐字揭示，
 * 给用户“连续敲打”的视觉感受。完成或中断时立即显示全部内容，不 lag。
 *
 * 节奏策略：
 * - 模型输出慢或接近追平时，每 30ms 揭示 1 字符，呈现平滑打字。
 * - 模型输出远快于显示速度时，每 tick 最多揭示 3 字符，避免 lag 过大。
 */
export function StreamingText({
  content,
  isStreaming,
  onOptionClick,
  onExecuteShell,
  onKillShell,
  shellOutputs,
}: StreamingTextProps) {
  const [displayedLength, setDisplayedLength] = useState(0);
  const contentRef = useRef(content);
  const isStreamingRef = useRef(isStreaming);

  contentRef.current = content;
  isStreamingRef.current = isStreaming;

  useEffect(() => {
    if (!isStreaming) {
      // 完成/中断：立即显示全部内容
      setDisplayedLength(contentRef.current.length);
      return;
    }

    const id = window.setInterval(() => {
      setDisplayedLength((prev) => {
        const target = contentRef.current.length;
        if (!isStreamingRef.current || prev >= target) {
          return prev;
        }
        const lag = target - prev;
        // 正常 1 字符/30ms；lag 大时最多 3 字符/30ms，控制最大 lag
        const charsPerTick = Math.min(lag, Math.max(1, Math.min(3, Math.floor(lag / 30))));
        return Math.min(target, prev + charsPerTick);
      });
    }, TYPEWRITER_INTERVAL_MS);

    return () => window.clearInterval(id);
  }, [isStreaming]); // 只随 streaming 状态启停，content 变化通过 ref 读取，避免 interval 被反复重置

  const displayed = content.slice(0, displayedLength);

  return (
    <MarkdownContent
      content={displayed}
      className="streaming-text"
      onOptionClick={onOptionClick}
      onExecuteShell={onExecuteShell}
      onKillShell={onKillShell}
      shellOutputs={shellOutputs}
    />
  );
}
