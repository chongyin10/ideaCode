import { useState } from 'react';
import { Check } from 'lucide-react';

interface Props {
  onCommit: (message: string, opts: { amend?: boolean; noVerify?: boolean }) => void;
  disabled?: boolean;
}

export default function CommitBox({ onCommit, disabled }: Props) {
  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(false);

  const handleCommit = () => {
    if (!message.trim() || disabled) return;
    onCommit(message, { amend });
    setMessage('');
    setAmend(false);
  };

  return (
    <div className="git-commit-box">
      <textarea
        className="git-commit-box__input"
        placeholder="提交信息（按 Ctrl/Cmd + Enter 提交）"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            handleCommit();
          }
        }}
        rows={3}
        disabled={disabled}
      />
      <div className="git-commit-box__row">
        <label className="git-commit-box__amend">
          <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} />
          <span>修改上一次提交 (amend)</span>
        </label>
        <button
          className="git-btn git-btn--primary"
          onClick={handleCommit}
          disabled={disabled || !message.trim()}
          title="提交"
        >
          <Check size={14} />
          <span>提交</span>
        </button>
      </div>
    </div>
  );
}