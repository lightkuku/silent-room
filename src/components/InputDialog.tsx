import React, { useState } from 'react';

interface InputDialogProps {
  open: boolean;
  title: string;
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export const InputDialog: React.FC<InputDialogProps> = ({
  open,
  title,
  message,
  placeholder = '',
  defaultValue = '',
  confirmText = '确定',
  cancelText = '取消',
  onConfirm,
  onCancel
}) => {
  const [value, setValue] = useState(defaultValue);

  if (!open) return null;

  const handleConfirm = () => {
    onConfirm(value);
    setValue('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleConfirm();
    }
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="input-dialog" onClick={e => e.stopPropagation()}>
        <div className="input-dialog-header">
          <span className="input-dialog-title">{title}</span>
        </div>
        {message && (
          <div className="input-dialog-body">
            <p>{message}</p>
          </div>
        )}
        <div className="input-dialog-content">
          <input
            type="text"
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder={placeholder}
            onKeyDown={handleKeyDown}
            autoFocus
          />
        </div>
        <div className="input-dialog-footer">
          <button className="input-cancel" onClick={onCancel}>
            {cancelText}
          </button>
          <button className="input-confirm" onClick={handleConfirm}>
            {confirmText}
          </button>
        </div>
      </div>
      <style>{`
        .input-dialog {
          background: var(--light);
          border-radius: var(--radius-md);
          width: 400px;
          max-width: 90vw;
          box-shadow: var(--shadow-lg);
          overflow: hidden;
        }
        .input-dialog-header {
          padding: 16px 20px;
          border-bottom: 1px solid var(--border);
        }
        .input-dialog-title {
          font-size: 16px;
          font-weight: 600;
          color: var(--dark);
        }
        .input-dialog-body {
          padding: 12px 20px;
        }
        .input-dialog-body p {
          color: var(--gray);
          line-height: 1.5;
          font-size: 14px;
        }
        .input-dialog-content {
          padding: 0 20px 16px;
        }
        .input-dialog-content input {
          width: 100%;
          padding: 10px 14px;
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          font-size: 14px;
          outline: none;
          transition: all var(--transition-fast);
          background: var(--input-bg);
          color: var(--dark);
        }
        .input-dialog-content input:focus {
          border-color: var(--primary);
          box-shadow: 0 0 0 3px rgba(67, 97, 238, 0.2);
        }
        .input-dialog-footer {
          padding: 16px 20px;
          display: flex;
          justify-content: flex-end;
          gap: 12px;
          border-top: 1px solid var(--border);
        }
        .input-cancel {
          padding: 8px 16px;
          border-radius: var(--radius-sm);
          background: var(--light-gray);
          color: var(--dark);
          border: none;
          cursor: pointer;
          font-size: 14px;
          transition: all var(--transition-fast);
        }
        .input-cancel:hover {
          background: var(--border);
        }
        .input-confirm {
          padding: 8px 16px;
          border-radius: var(--radius-sm);
          color: white;
          border: none;
          cursor: pointer;
          font-size: 14px;
          background: var(--primary);
          transition: all var(--transition-fast);
        }
        .input-confirm:hover {
          background: var(--primary-dark);
          transform: translateY(-1px);
          box-shadow: var(--shadow-md);
        }
        [data-theme="dark"] .input-dialog {
          background: var(--float-panel);
        }
        [data-theme="dark"] .input-dialog-title,
        [data-theme="dark"] .input-cancel {
          color: #f1f5f9;
        }
        [data-theme="dark"] .input-dialog-content input {
          background: #1f2937;
          border-color: #4b5563;
          color: #f1f5f9;
        }
        [data-theme="dark"] .input-cancel {
          background: #374151;
        }
        [data-theme="dark"] .input-cancel:hover {
          background: #4e596c;
        }
      `}</style>
    </div>
  );
};

// 全局输入对话框状态管理
let inputCallback: ((value: string | null) => void) | null = null;
let inputDialogListeners: ((state: { open: boolean; title: string; message?: string; placeholder?: string; defaultValue?: string; confirmText?: string; cancelText?: string }) => void)[] = [];

export function showInput(options: {
  title: string;
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmText?: string;
  cancelText?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    inputCallback = resolve;
    inputDialogListeners.forEach(listener => listener({
      open: true,
      title: options.title,
      message: options.message,
      placeholder: options.placeholder || '',
      defaultValue: options.defaultValue || '',
      confirmText: options.confirmText,
      cancelText: options.cancelText
    }));
  });
}

export function resolveInput(value: string | null) {
  if (inputCallback) {
    inputCallback(value);
    inputCallback = null;
  }
  inputDialogListeners.forEach(listener => listener({
    open: false,
    title: '',
    message: '',
    placeholder: ''
  }));
}

export function subscribeInputDialog(listener: (state: { open: boolean; title: string; message?: string; placeholder?: string; defaultValue?: string; confirmText?: string; cancelText?: string }) => void) {
  inputDialogListeners.push(listener);
  return () => {
    inputDialogListeners = inputDialogListeners.filter(l => l !== listener);
  };
}
