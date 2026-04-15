/**
 * 全局 Toast 管理器
 * 用于在任何地方调用 Toast 提示
 */

import type { ToastType } from '../types';
export type { ToastType };

interface ToastItem {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
}

let listeners: ((toasts: ToastItem[]) => void)[] = [];
let toasts: ToastItem[] = [];
let toastId = 0;

function notifyListeners() {
  listeners.forEach(listener => listener([...toasts]));
}

function removeToast(id: string) {
  toasts = toasts.filter(t => t.id !== id);
  notifyListeners();
}

export const toast = {
  success: (title: string, message?: string) => {
    const id = `toast_${++toastId}_${Date.now()}`;
    toasts = [...toasts, { id, type: 'success', title, message }];
    notifyListeners();
    setTimeout(() => removeToast(id), 5000);
  },
  
  error: (title: string, message?: string) => {
    const id = `toast_${++toastId}_${Date.now()}`;
    toasts = [...toasts, { id, type: 'error', title, message }];
    notifyListeners();
    setTimeout(() => removeToast(id), 8000);
  },
  
  warning: (title: string, message?: string) => {
    const id = `toast_${++toastId}_${Date.now()}`;
    toasts = [...toasts, { id, type: 'warning', title, message }];
    notifyListeners();
    setTimeout(() => removeToast(id), 6000);
  },
  
  info: (title: string, message?: string) => {
    const id = `toast_${++toastId}_${Date.now()}`;
    toasts = [...toasts, { id, type: 'info', title, message }];
    notifyListeners();
    setTimeout(() => removeToast(id), 5000);
  }
};

export function subscribeToToast(listener: (toasts: ToastItem[]) => void) {
  listeners.push(listener);
  listener([...toasts]);
  return () => {
    listeners = listeners.filter(l => l !== listener);
  };
}

export { removeToast as removeToastById };
