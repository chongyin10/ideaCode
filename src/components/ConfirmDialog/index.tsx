import { useTranslation } from 'react-i18next';
import './ConfirmDialog.css';

export type ConfirmResult = 'save' | 'discard' | 'cancel';

interface ConfirmDialogProps {
  title: string;
  message: string;
  onResult: (result: ConfirmResult) => void;
}

const ConfirmDialog = ({ title, message, onResult }: ConfirmDialogProps) => {
  const { t } = useTranslation();
  return (
    <div className="confirm-dialog-overlay" onClick={() => onResult('cancel')}>
      <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-dialog__title">{title}</div>
        <div className="confirm-dialog__message">{message}</div>
        <div className="confirm-dialog__actions">
          <button
            className="confirm-dialog__btn confirm-dialog__btn--secondary"
            onClick={() => onResult('discard')}
          >
            取消
          </button>
          <button
            className="confirm-dialog__btn confirm-dialog__btn--primary"
            onClick={() => onResult('save')}
          >
            {t('confirmDialog.save')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmDialog;
