import React, { useState, useEffect } from 'react';
import { subscribeToToast, removeToastById } from '../utils/toast';

interface Toast {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  message?: string;
}

export const ToastContainer: React.FC = () => {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const unsubscribe = subscribeToToast(setToasts);
    return unsubscribe;
  }, []);

  const getTypeStyles = (type: string) => {
    switch (type) {
      case 'success':
        return 'border-green-500';
      case 'error':
        return 'border-red-500';
      case 'warning':
        return 'border-yellow-500';
      default:
        return 'border-blue-500';
    }
  };

  const getIcon = (type: string) => {
    switch (type) {
      case 'success':
        return '✓';
      case 'error':
        return '✕';
      case 'warning':
        return '⚠';
      default:
        return 'ℹ';
    }
  };

  const getIconBg = (type: string) => {
    switch (type) {
      case 'success':
        return 'bg-green-500';
      case 'error':
        return 'bg-red-500';
      case 'warning':
        return 'bg-yellow-500';
      default:
        return 'bg-blue-500';
    }
  };

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast-item ${getTypeStyles(toast.type)}`}
        >
          <div className={`toast-icon ${getIconBg(toast.type)}`}>
            {getIcon(toast.type)}
          </div>
          <div className="toast-content">
            <div className="toast-title">{toast.title}</div>
            {toast.message && (
              <div className="toast-message">{toast.message}</div>
            )}
          </div>
          <button
            className="toast-close"
            onClick={() => removeToastById(toast.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
};

export default ToastContainer;
