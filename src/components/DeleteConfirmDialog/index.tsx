import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import './DeleteConfirmDialog.css';

interface DeleteConfirmDialogProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteConfirmDialog({ message, onConfirm, onCancel }: DeleteConfirmDialogProps) {
  const { t } = useTranslation();
  return createPortal(
    <div className="delete-confirm-overlay" onClick={onCancel}>
      <div className="delete-confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="delete-confirm-dialog__message">{message}</div>
        <div className="delete-confirm-dialog__actions">
          <button
            className="delete-confirm-dialog__btn delete-confirm-dialog__btn--secondary"
            onClick={onCancel}
          >
            {t('cancel')}
          </button>
          <button
            className="delete-confirm-dialog__btn delete-confirm-dialog__btn--danger"
            onClick={onConfirm}
          >
            {t('confirm')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
