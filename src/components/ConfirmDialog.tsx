import React from 'react';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  type?: 'danger' | 'warning' | 'info';
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  message,
  confirmText = '确定',
  cancelText = '取消',
  onConfirm,
  onCancel,
  type = 'info'
}) => {
  if (!open) return null;

  const getTypeStyles = () => {
    switch (type) {
      case 'danger':
        return {
          button: 'bg-red-500 hover:bg-red-600',
          icon: '🔴',
          border: 'border-red-500'
        };
      case 'warning':
        return {
          button: 'bg-yellow-500 hover:bg-yellow-600',
          icon: '⚠️',
          border: 'border-yellow-500'
        };
      default:
        return {
          button: 'bg-blue-500 hover:bg-blue-600',
          icon: 'ℹ️',
          border: 'border-blue-500'
        };
    }
  };

  const styles = getTypeStyles();

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="confirm-dialog" onClick={e => e.stopPropagation()}>
        <div className={`confirm-header ${styles.border}`}>
          <span className="confirm-icon">{styles.icon}</span>
          <span className="confirm-title">{title}</span>
        </div>
        <div className="confirm-body">
          <p>{message}</p>
        </div>
        <div className="confirm-footer">
          <button className="confirm-cancel" onClick={onCancel}>
            {cancelText}
          </button>
          <button className={`confirm-btn ${styles.button}`} onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      </div>
      <style>{`
        .confirm-dialog {
          background: var(--light);
          border-radius: var(--radius-md);
          width: 400px;
          max-width: 90vw;
          box-shadow: var(--shadow-lg);
          overflow: hidden;
        }
        .confirm-header {
          padding: 16px 20px;
          display: flex;
          align-items: center;
          gap: 10px;
          border-left: 4px solid var(--primary);
        }
        .confirm-icon {
          font-size: 20px;
        }
        .confirm-title {
          font-size: 16px;
          font-weight: 600;
          color: var(--dark);
        }
        .confirm-body {
          padding: 20px;
        }
        .confirm-body p {
          color: var(--gray);
          line-height: 1.6;
          white-space: pre-line;
        }
        .confirm-footer {
          padding: 16px 20px;
          display: flex;
          justify-content: flex-end;
          gap: 12px;
          border-top: 1px solid var(--border);
        }
        .confirm-cancel {
          padding: 8px 16px;
          border-radius: var(--radius-sm);
          background: var(--light-gray);
          color: var(--dark);
          border: none;
          cursor: pointer;
          font-size: 14px;
          transition: all var(--transition-fast);
        }
        .confirm-cancel:hover {
          background: var(--border);
        }
        .confirm-btn {
          padding: 8px 16px;
          border-radius: var(--radius-sm);
          color: white;
          border: none;
          cursor: pointer;
          font-size: 14px;
          background: var(--primary);
          transition: all var(--transition-fast);
        }
        .confirm-btn:hover {
          transform: translateY(-1px);
          box-shadow: var(--shadow-md);
        }
        [data-theme="dark"] .confirm-dialog {
          background: var(--float-panel);
        }
        [data-theme="dark"] .confirm-title,
        [data-theme="dark"] .confirm-cancel {
          color: #f1f5f9;
        }
        [data-theme="dark"] .confirm-cancel {
          background: #374151;
        }
        [data-theme="dark"] .confirm-cancel:hover {
          background: #4e596c;
        }
      `}</style>
    </div>
  );
};

// 全局确认对话框状态管理
let confirmCallback: ((result: boolean) => void) | null = null;
let dialogListeners: ((state: { open: boolean; title: string; message: string; type?: 'danger' | 'warning' | 'info' }) => void)[] = [];

export function showConfirm(options: {
  title: string;
  message: string;
  type?: 'danger' | 'warning' | 'info';
  confirmText?: string;
  cancelText?: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    confirmCallback = resolve;
    dialogListeners.forEach(listener => listener({
      open: true,
      title: options.title,
      message: options.message,
      type: options.type || 'info'
    }));
  });
}

export function resolveConfirm(result: boolean) {
  if (confirmCallback) {
    confirmCallback(result);
    confirmCallback = null;
  }
  dialogListeners.forEach(listener => listener({
    open: false,
    title: '',
    message: ''
  }));
}

export function subscribeConfirmDialog(listener: (state: { open: boolean; title: string; message: string; type?: 'danger' | 'warning' | 'info' }) => void) {
  dialogListeners.push(listener);
  return () => {
    dialogListeners = dialogListeners.filter(l => l !== listener);
  };
}
