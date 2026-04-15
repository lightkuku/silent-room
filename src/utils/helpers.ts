import { APIResponse } from '../types';

export class AppError extends Error {
  constructor(
    message: string,
    public code?: string,
    public statusCode: number = 500
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 400);
    this.name = 'ValidationError';
  }
}

export class AuthError extends AppError {
  constructor(message: string = '未授权') {
    super(message, 'AUTH_ERROR', 401);
    this.name = 'AuthError';
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = '资源不存在') {
    super(message, 'NOT_FOUND', 404);
    this.name = 'NotFoundError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = '权限不足') {
    super(message, 'FORBIDDEN', 403);
    this.name = 'ForbiddenError';
  }
}

export function isApiResponse(response: any): response is APIResponse {
  return typeof response === 'object' && 'success' in response;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as any).message);
  }
  return '未知错误';
}

export function handleApiError(error: unknown): string {
  if (error instanceof AppError) {
    return error.message;
  }
  
  if (error && typeof error === 'object') {
    const err = error as any;
    if (err.response?.data?.message) {
      return err.response.data.message;
    }
    if (err.message) {
      return err.message;
    }
    if (err.error) {
      return err.error;
    }
  }
  
  return getErrorMessage(error);
}

export function isNetworkError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const err = error as any;
    if (err.code === 'ECONNREFUSED' || err.code === 'NETWORK_ERROR') {
      return true;
    }
    if (err.name === 'TypeError' && err.message.includes('fetch')) {
      return true;
    }
  }
  return false;
}

export function isTimeoutError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const err = error as any;
    return err.code === 'ETIMEDOUT' || err.name === 'AbortError';
  }
  return false;
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout | null = null;
  
  return function(...args: Parameters<T>) {
    if (timeout) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(() => {
      func(...args);
    }, wait);
  };
}

export function throttle<T extends (...args: any[]) => any>(
  func: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle: boolean = false;
  
  return function(...args: Parameters<T>) {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => {
        inThrottle = false;
      }, limit);
    }
  };
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function formatDate(date: Date | number | string, format: 'date' | 'datetime' | 'time' = 'date'): string {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  
  switch (format) {
    case 'datetime':
      return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    case 'time':
      return `${hours}:${minutes}:${seconds}`;
    case 'date':
    default:
      return `${year}-${month}-${day}`;
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function groupBy<T>(array: T[], key: keyof T): Record<string, T[]> {
  return array.reduce((result, item) => {
    const groupKey = String(item[key]);
    if (!result[groupKey]) {
      result[groupKey] = [];
    }
    result[groupKey].push(item);
    return result;
  }, {} as Record<string, T[]>);
}

export function unique<T>(array: T[], key?: keyof T): T[] {
  if (!key) {
    return [...new Set(array)];
  }
  const seen = new Set();
  return array.filter(item => {
    const value = item[key];
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function retry<T>(
  fn: () => Promise<T>,
  options: { maxAttempts: number; delay: number; onRetry?: (attempt: number, error: unknown) => void }
): Promise<T> {
  const { maxAttempts, delay, onRetry } = options;
  
  return new Promise((resolve, reject) => {
    const attempt = async (attemptNumber: number) => {
      try {
        const result = await fn();
        resolve(result);
      } catch (error) {
        if (attemptNumber < maxAttempts) {
          onRetry?.(attemptNumber, error);
          await sleep(delay);
          attempt(attemptNumber + 1);
        } else {
          reject(error);
        }
      }
    };
    
    attempt(1);
  });
}
