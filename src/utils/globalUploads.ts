import type { UploadCallback } from '../types';
import type { TaskItem, TaskStatus } from '../types';
import { TaskService } from './TaskService';
export type { UploadCallback };

let globalUploads: TaskItem[] = [];
let listeners: UploadCallback[] = [];

export const cancelledTasks: Map<string, XMLHttpRequest> = new Map();
export const cancelledDownloads: Map<string, AbortController> = new Map();

export function getGlobalUploads(): TaskItem[] {
  return globalUploads;
}

export function setGlobalUploads(uploads: TaskItem[]): void {
  globalUploads = uploads;
  listeners.forEach(cb => cb(globalUploads));
}

export function addGlobalUpload(task: TaskItem): void {
  globalUploads = [...globalUploads, task];
  listeners.forEach(cb => cb(globalUploads));
}

export function updateGlobalUpload(task: TaskItem): void {
  globalUploads = globalUploads.map(t => t.id === task.id ? task : t);
  listeners.forEach(cb => cb(globalUploads));
}

export function updateGlobalUploadStatus(id: string, status: TaskStatus): void {
  globalUploads = globalUploads.map(t => t.id === id ? { ...t, status } : t);
  listeners.forEach(cb => cb(globalUploads));
}

export function removeGlobalUpload(id: string): void {
  globalUploads = globalUploads.filter(t => t.id !== id);
  cancelledTasks.delete(id);
  cancelledDownloads.delete(id);
  listeners.forEach(cb => cb(globalUploads));
}

export function clearGlobalUploads(): void {
  const taskService = TaskService.getInstanceSafe();
  if (taskService) {
    taskService.cancelAll();
  }
  
  cancelledTasks.forEach(xhr => xhr.abort());
  cancelledDownloads.forEach(ctrl => ctrl.abort());
  cancelledTasks.clear();
  cancelledDownloads.clear();
  globalUploads = [];
  listeners.forEach(cb => cb(globalUploads));
}

export function cancelUpload(id: string): void {
  // 标记为 cancelled
  globalUploads = globalUploads.map(t => t.id === id ? { ...t, status: 'cancelled' as TaskStatus } : t);
  listeners.forEach(cb => cb(globalUploads));
  
  // 调用 TaskService 的 cancelTask
  const taskService = TaskService.getInstanceSafe();
  if (taskService) {
    taskService.cancelTask(id);
  }
}

export function pauseUpload(id: string): void {
  globalUploads = globalUploads.map(t => t.id === id ? { ...t, status: 'paused' as TaskStatus } : t);
  listeners.forEach(cb => cb(globalUploads));
  
  const xhr = cancelledTasks.get(id);
  if (xhr) {
    xhr.abort();
    cancelledTasks.delete(id);
  }
  
  const ctrl = cancelledDownloads.get(id);
  if (ctrl) {
    ctrl.abort();
    cancelledDownloads.delete(id);
  }
}

export function resumeUpload(id: string): void {
  const taskService = TaskService.getInstanceSafe();
  if (taskService) {
    taskService.retryTask(id);
  }
}

export function retryUpload(id: string): void {
  // console.log('[DEBUG] retryUpload 被调用, id=', id);
  
  // 优先尝试从 TaskService 获取任务
  const taskService = TaskService.getInstanceSafe();
  if (taskService) {
    const task = taskService.getTask(id);
    // console.log('[DEBUG] TaskService 中的任务:', task);
    if (task) {
      taskService.retryTask(id);
      return;
    }
  }
  
  // 如果 TaskService 中没有，检查 globalUploads
  const upload = globalUploads.find(t => t.id === id);
  // console.log('[DEBUG] globalUploads 中的任务:', upload);
  if (!upload) {
    // console.log('[DEBUG] 未找到任务:', id);
    return;
  }
  
  // 检查是否是网盘（有 file 的任务）
  if (upload.file) {
    // console.log('[DEBUG] 网盘任务，设置 pending 状态, file=', !!upload.file);
    globalUploads = globalUploads.map(t => t.id === id ? { ...t, status: 'pending' as TaskStatus, progress: 0, uploading: false } : t);
    listeners.forEach(cb => cb(globalUploads));
  } else {
    // 如果没有 file，从 TaskService 获取
    const taskService = TaskService.getInstanceSafe();
    if (taskService) {
      taskService.retryTask(id);
    }
  }
}

export function registerUploadXhr(id: string, xhr: XMLHttpRequest): void {
  cancelledTasks.set(id, xhr);
}

export function registerDownloadController(id: string, ctrl: AbortController): void {
  cancelledDownloads.set(id, ctrl);
}

export function subscribeGlobalUploads(callback: UploadCallback): () => void {
  listeners.push(callback);
  return () => {
    listeners = listeners.filter(cb => cb !== callback);
  };
}