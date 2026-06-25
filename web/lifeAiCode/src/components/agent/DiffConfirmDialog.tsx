interface DiffConfirmDialogProps {
  filePath: string;
  original: string;
  modified: string;
  onConfirm: () => void;
  onReject: () => void;
}

export function DiffConfirmDialog({ filePath, original, modified, onConfirm, onReject }: DiffConfirmDialogProps) {
  return (
    <div className="agent-edit-dialog">
      <div className="agent-edit-dialog__content">
        <div className="agent-edit-dialog__title">确认应用修改</div>
        <div className="agent-edit-dialog__file">{filePath}</div>
        <div className="agent-edit-dialog__diff">
          <div className="agent-edit-dialog__section agent-edit-dialog__section--original">
            <div className="agent-edit-dialog__section-title">原始</div>
            <pre>{original}</pre>
          </div>
          <div className="agent-edit-dialog__section agent-edit-dialog__section--modified">
            <div className="agent-edit-dialog__section-title">修改后</div>
            <pre>{modified}</pre>
          </div>
        </div>
        <div className="agent-edit-dialog__actions">
          <button className="agent-edit-dialog__btn agent-edit-dialog__btn--reject" onClick={onReject}>
            拒绝
          </button>
          <button className="agent-edit-dialog__btn agent-edit-dialog__btn--confirm" onClick={onConfirm}>
            应用
          </button>
        </div>
      </div>
    </div>
  );
}
