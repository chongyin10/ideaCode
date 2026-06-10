import { useState, useEffect, useRef } from 'react';
import './InlineInput.css';

interface InlineInputProps {
  defaultValue?: string;
  placeholder?: string;
  onConfirm: (value: string) => void | Promise<void>;
  onCancel: () => void;
}

const InlineInput = ({ defaultValue = '', placeholder = '', onConfirm, onCancel }: InlineInputProps) => {
  const [value, setValue] = useState(defaultValue);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleKeyDown = async (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (isSubmitting) return;
      const trimmed = value.trim();
      if (!trimmed) {
        setIsSubmitting(true);
        onCancel();
        return;
      }
      setIsSubmitting(true);
      try {
        await Promise.resolve(onConfirm(trimmed));
      } catch {
        setIsSubmitting(false);
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (isSubmitting) return;
      setIsSubmitting(true);
      onCancel();
    }
  };

  const handleBlur = () => {
    // 延迟处理，让 click 事件先处理（如果点击的是其他菜单项）
    setTimeout(async () => {
      if (isSubmitting) return;
      const trimmed = value.trim();
      if (trimmed) {
        setIsSubmitting(true);
        try {
          await Promise.resolve(onConfirm(trimmed));
        } catch {
          setIsSubmitting(false);
          requestAnimationFrame(() => inputRef.current?.focus());
        }
      } else {
        setIsSubmitting(true);
        onCancel();
      }
    }, 150);
  };

  return (
    <input
      ref={inputRef}
      className="inline-input"
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      onClick={(e) => e.stopPropagation()}
    />
  );
};

export default InlineInput;
