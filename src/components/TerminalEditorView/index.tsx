import { useRef } from 'react';
import { Minimize2 } from 'lucide-react';
import { useAppDispatch } from '../../store/hooks';
import { openTerminalModal } from '../../store/slices/modalSlice';
import { closeFile } from '../../store/slices/workspaceSlice';
import { moveToModal } from '../../store/slices/terminalSlice';
import { TerminalInstance, type TerminalInstanceHandle } from '../Terminal/TerminalInstance';
import './TerminalEditorView.css';

interface TerminalEditorViewProps {
  terminalId: string;
  title: string;
  active: boolean;
}

export default function TerminalEditorView({ terminalId, title, active }: TerminalEditorViewProps) {
  const dispatch = useAppDispatch();
  const terminalRef = useRef<TerminalInstanceHandle | null>(null);

  const handleDetach = () => {
    // 关闭编辑器 Tab，但保留底层终端进程与 tab 状态，切换回 Modal 展示
    dispatch(openTerminalModal({ tabId: terminalId, title }));
    dispatch(closeFile({ id: terminalId }));
    dispatch(moveToModal(terminalId));
  };

  return (
    <div className="terminal-editor-view">
      <div className="terminal-editor-view__toolbar">
        <span className="terminal-editor-view__title">{title}</span>
        <button
          className="terminal-editor-view__detach"
          title="脱离为独立窗口"
          onClick={handleDetach}
        >
          <Minimize2 size={14} />
        </button>
      </div>
      <div className="terminal-editor-view__body">
        <TerminalInstance
          ref={terminalRef}
          terminalId={terminalId}
          active={active}
          className="terminal-editor-view__instance"
        />
      </div>
    </div>
  );
}
