import { 
  loadKeysFromStorage, 
  encryptFileChunkedWithYield, 
  decryptFileChunkedWithKeysYield,
  encrypt
} from './crypto';
import { getCsrfTokenWithRefresh } from './csrf';
import { 
  registerUploadXhr, 
  registerDownloadController, 
  getGlobalUploads,
  updateGlobalUpload
} from './globalUploads';
import { showConfirm } from '../components/ConfirmDialog';
import type { TaskItem, TaskStatus, TaskType } from '../types';
export type { TaskStatus, TaskType };
export type { TaskItem };

type TaskUpdateCallback = (task: TaskItem) => void;
type TaskCompleteCallback = (task: TaskItem, result: any) => void;
type TaskErrorCallback = (task: TaskItem, error: Error) => void;

interface TaskServiceConfig {
  apiBaseUrl: string;
  onTaskUpdate?: TaskUpdateCallback;
  onTaskComplete?: TaskCompleteCallback;
  onTaskError?: TaskErrorCallback;
}

export class TaskService {
  private static instance: TaskService | null = null;
  private tasks: Map<string, TaskItem> = new Map();
  private queue: string[] = [];
  private isProcessing: boolean = false;
  private currentTaskId: string | null = null;
  private currentXhr: XMLHttpRequest | null = null;
  private currentAbortController: AbortController | null = null;
  private cancelledTasks: Set<string> = new Set();
  private cancelled: boolean = false;
  private config: TaskServiceConfig;

  private constructor(config: TaskServiceConfig) {
    this.config = config;
  }

  static getInstance(config?: TaskServiceConfig): TaskService {
    if (!TaskService.instance && config) {
      TaskService.instance = new TaskService(config);
    }
    if (!TaskService.instance && !config) {
      throw new Error('TaskService must be initialized with config first');
    }
    return TaskService.instance!;
  }
  
  static getInstanceSafe(): TaskService | null {
    return TaskService.instance;
  }

  static resetInstance(): void {
    if (TaskService.instance) {
      TaskService.instance.cancelAll();
      TaskService.instance = null;
    }
  }

  private generateId(): string {
    return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private isTaskCancelled(id: string): boolean {
    if (this.cancelledTasks.has(id) || this.cancelled) {
      return true;
    }
    const globalTask = getGlobalUploads().find(t => t.id === id);
    return globalTask?.status === 'cancelled';
  }

  addUploadTask(params: {
    filename: string;
    file: File;
    totalSize?: number;
    tempMessageId?: string;
    attachmentId?: string;
    isEncrypted?: boolean;
    customEndpoint?: string;
  }): string {
    const id = this.generateId();
    const task: TaskItem = {
      id,
      filename: params.filename,
      originalName: params.filename,
      progress: 0,
      status: 'pending',
      type: 'upload',
      totalSize: params.totalSize || params.file.size,
      loadedSize: 0,
      tempMessageId: params.tempMessageId,
      attachmentId: params.attachmentId,
      encrypted: params.isEncrypted,
      file: params.file,
      customEndpoint: params.customEndpoint,
      createdAt: Date.now(),
    };
    
    this.tasks.set(id, task);
    this.queue.push(id);
    this.cancelled = false;
    this.notifyUpdate(task);
    this.processQueue();
    
    return id;
  }

  addDownloadTask(params: {
    filename: string;
    url: string;
    totalSize?: number;
    tempMessageId?: string;
    isEncrypted?: boolean;
    senderId?: string;
    originalSize?: number;
    isBurn?: boolean;
    skipSizeCheck?: boolean;
    attachmentId?: string;
    encrypted?: boolean;
    customEndpoint?: string;
  }): string {
    const id = this.generateId();
    const task: TaskItem = {
      id,
      filename: params.filename,
      progress: 0,
      status: 'pending',
      type: 'download',
      totalSize: params.totalSize,
      loadedSize: 0,
      tempMessageId: params.tempMessageId,
      url: params.url,
      encrypted: params.isEncrypted || params.encrypted,
      senderId: params.senderId,
      originalSize: params.originalSize,
      isBurn: params.isBurn,
      skipSizeCheck: params.skipSizeCheck,
      attachmentId: params.attachmentId,
      customEndpoint: params.customEndpoint,
      createdAt: Date.now(),
    };
    
    this.tasks.set(id, task);
    this.queue.push(id);
    this.cancelled = false;
    this.notifyUpdate(task);
    this.processQueue();
    
    return id;
  }

  cancelTask(id: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    
    task.status = 'cancelled';
    this.notifyUpdate(task);
    this.cancelledTasks.add(id);
    
    // 同步更新 globalUploads
    const globalUploads = getGlobalUploads();
    const upload = globalUploads.find(u => u.id === id);
    if (upload) {
      updateGlobalUpload({ ...upload, status: 'cancelled' });
    }
    
    if (this.currentTaskId === id) {
      if (task.type === 'upload' && this.currentXhr) {
        this.currentXhr.abort();
        this.currentXhr = null;
      } else if (task.type === 'download' && this.currentAbortController) {
        this.currentAbortController.abort();
        this.currentAbortController = null;
      }
      this.currentTaskId = null;
      this.isProcessing = false;
    }
    
    this.queue = this.queue.filter(taskId => taskId !== id);
    
    if (this.isProcessing === false && this.queue.length > 0) {
      this.processQueue();
    }
  }

  clearCancelledTask(id: string): void {
    this.cancelledTasks.delete(id);
  }

  removeTask(id: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    
    if (this.currentTaskId === id) {
      if (task.type === 'upload' && this.currentXhr) {
        this.currentXhr.abort();
        this.currentXhr = null;
      } else if (task.type === 'download' && this.currentAbortController) {
        this.currentAbortController.abort();
        this.currentAbortController = null;
      }
      this.currentTaskId = null;
      this.isProcessing = false;
    }
    
    task.status = 'error';
    this.notifyUpdate(task);
    
    this.queue = this.queue.filter(taskId => taskId !== id);
    this.tasks.delete(id);
    
    if (this.isProcessing === false && this.queue.length > 0) {
      this.processQueue();
    }
  }

  cancelAll(): void {
    this.cancelled = true;
    
    this.tasks.forEach((_, id) => {
      this.cancelledTasks.add(id);
    });
    
    if (this.currentXhr) {
      this.currentXhr.abort();
      this.currentXhr = null;
    }
    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
    }
    
    if (this.currentTaskId) {
      const currentTask = this.tasks.get(this.currentTaskId);
      if (currentTask && (currentTask.status === 'uploading' || currentTask.status === 'pending')) {
        this.updateTask(this.currentTaskId, { status: 'error' });
      }
    }
    
    this.queue = [];
    this.currentTaskId = null;
    this.isProcessing = false;
  }
  
  resetCancelState(): void {
    this.cancelled = false;
    this.cancelledTasks.clear();
  }
  
  clearCancelledFlag(id: string): void {
    this.cancelledTasks.delete(id);
  }

  getAllTasks(): TaskItem[] {
    return Array.from(this.tasks.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  getTask(id: string): TaskItem | undefined {
    return this.tasks.get(id);
  }

  getTasksByMessageId(tempMessageId: string): TaskItem[] {
    return this.getAllTasks().filter(t => t.tempMessageId === tempMessageId);
  }

  getTaskStats(): {
    total: number;
    pending: number;
    uploading: number;
    completed: number;
    error: number;
  } {
    const tasks = this.getAllTasks();
    return {
      total: tasks.length,
      pending: tasks.filter(t => t.status === 'pending').length,
      uploading: tasks.filter(t => t.status === 'uploading').length,
      completed: tasks.filter(t => t.status === 'completed').length,
      error: tasks.filter(t => t.status === 'error').length,
    };
  }

  retryTask(id: string): void {
    const task = this.tasks.get(id);
    if (!task || (task.status !== 'error' && task.status !== 'cancelled')) return;

    // 清除取消状态
    this.cancelledTasks.delete(id);
    
    task.status = 'pending';
    task.progress = 0;
    this.notifyUpdate(task);
    
    // 同步更新 globalUploads
    const globalUploads = getGlobalUploads();
    const upload = globalUploads.find(u => u.id === id);
    if (upload) {
      updateGlobalUpload({ ...upload, status: 'pending', progress: 0 });
    }
    
    if (!this.queue.includes(id)) {
      this.queue.push(id);
    }
    
    this.processQueue();
  }

  private notifyUpdate(task: TaskItem): void {
    this.config.onTaskUpdate?.(task);
  }

  private updateTask(id: string, updates: Partial<TaskItem>): void {
    const task = this.tasks.get(id);
    if (task) {
      Object.assign(task, updates);
      this.notifyUpdate(task);
    }
  }

  private processQueue(): void {
    if (this.isProcessing || this.queue.length === 0) return;
    
    const nextTaskId = this.queue[0];
    const task = this.tasks.get(nextTaskId);
    
    if (!task || task.status !== 'pending') {
      this.queue.shift();
      this.processQueue();
      return;
    }

    this.isProcessing = true;
    this.currentTaskId = nextTaskId;
    task.status = 'uploading';
    this.notifyUpdate(task);

    const executePromise = task.type === 'upload' 
      ? this.executeUpload(task) 
      : this.executeDownload(task);

    executePromise
      .then((result) => {
        if (result?.cancelled) {
          task.status = 'error';
          this.notifyUpdate(task);
          return;
        }
        task.status = 'completed';
        task.progress = 100;
        task.result = result;
        this.notifyUpdate(task);
        this.config.onTaskComplete?.(task, result);
      })
      .catch((error) => {
        task.status = 'error';
        this.notifyUpdate(task);
        if (task.isBurn && error.message?.includes('已被删除')) {
          showConfirm({
            title: '文件已删除',
            message: '阅后即焚：文件已被删除',
            type: 'warning'
          });
        } else {
          this.config.onTaskError?.(task, error);
        }
      })
      .finally(() => {
        if (this.queue.length > 0) {
          this.queue.shift();
          this.currentTaskId = null;
          this.currentXhr = null;
          this.currentAbortController = null;
          this.isProcessing = false;
          this.processQueue();
        } else {
          this.currentTaskId = null;
          this.currentXhr = null;
          this.currentAbortController = null;
          this.isProcessing = false;
        }
      });
  }

  private async executeUpload(task: TaskItem): Promise<any> {
    const file = task.file;
    if (!file) throw new Error('No file to upload');
    
    const keys = loadKeysFromStorage();
    const encryptionKeyFromStorage = localStorage.getItem('encryptionKey') || '';
    const originalSize = file.size;
    const keyToUse = keys?.currentKey || encryptionKeyFromStorage;
    
    const token = localStorage.getItem('token');
    const endpoint = task.customEndpoint || '/api/upload';
    const uploadUrl = `${this.config.apiBaseUrl}${endpoint}`;
    
    let fileToUpload = file;
    let isEncrypted = task.encrypted || false;
    let encryptedName = '';
    
    // 加密文件
    if (keyToUse && isEncrypted) {
      try {
        const encrypted = await encryptFileChunkedWithYield(file, keyToUse, (progress) => {
          if (this.isTaskCancelled(task.id)) {
            throw new Error('上传已取消');
          }
        });
        encryptedName = encrypt(file.name, keyToUse);
        fileToUpload = new File([encrypted], encryptedName, { type: 'application/octet-stream' });
      } catch (e: any) {
        if (e.message === '上传已取消') {
          throw e;
        }
      }
    }

    // 只在上传前检查是否被取消，pending 状态才抛错
    if (this.isTaskCancelled(task.id) && task.status === 'pending') {
      throw new Error('上传已取消');
    }

    const parentIdFromEndpoint = task.customEndpoint?.includes('parentId=') 
      ? task.customEndpoint.match(/parentId=([^&]+)/)?.[1] 
      : null;
    
    return new Promise((resolve, reject) => {
      const formData = new FormData();
      formData.append('file', fileToUpload);
      if (parentIdFromEndpoint && parentIdFromEndpoint !== 'null') {
        formData.append('parentId', parentIdFromEndpoint);
      }
      if (isEncrypted) {
        formData.append('encrypted', 'true'); // 聊天附件兼容
        formData.append('isEncrypted', 'true'); // 网盘文件兼容
        formData.append('name', encryptedName);
      }
      
      const xhr = new XMLHttpRequest();
      this.currentXhr = xhr;
      registerUploadXhr(task.id, xhr);
      
      let lastSpeedUpdate = Date.now();
      let lastLoaded = 0;
      
      xhr.upload.onprogress = (e) => {
        if (this.isTaskCancelled(task.id)) {
          xhr.abort();
          return;
        }
        if (e.lengthComputable) {
          const uploadProgress = Math.round((e.loaded / e.total) * 100);
          this.updateTask(task.id, { 
            progress: uploadProgress, 
            loadedSize: e.loaded, 
            totalSize: e.total,
            speed: lastLoaded > 0 && Date.now() - lastSpeedUpdate > 0 
              ? Math.round(((e.loaded - lastLoaded) / (Date.now() - lastSpeedUpdate)) * 1000) 
              : 0
          });
          
          if (Date.now() - lastSpeedUpdate >= 500) {
            lastSpeedUpdate = Date.now();
            lastLoaded = e.loaded;
          }
        }
      };
      
      xhr.onload = () => {
        if (this.isTaskCancelled(task.id)) {
          reject(new Error('上传已取消'));
          return;
        }
        if (xhr.status === 200) {
          const response = JSON.parse(xhr.responseText);
          if (response.success) {
            const uploadedSize = response.data.size;
            if (uploadedSize !== originalSize && uploadedSize !== fileToUpload.size) {
              reject(new Error('文件上传不完整，请重试'));
              return;
            }
            
            const isImage = file.type.startsWith('image/');
            const encryptedFileName = isEncrypted ? encryptedName : file.name;
            resolve({
              type: isImage ? 'image' : 'file',
              name: encryptedFileName,
              size: originalSize,
              url: response.data.url,
              encrypted: isEncrypted
            });
          } else {
            reject(new Error(response.message || '上传失败'));
          }
        } else {
          reject(new Error('上传失败'));
        }
      };
      
      xhr.onerror = () => reject(new Error('网络错误'));
      xhr.onabort = () => reject(new Error('上传已取消'));
      
      xhr.open('POST', uploadUrl);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      
      // 添加 CSRF token（异步获取并刷新）
      getCsrfTokenWithRefresh().then(csrfToken => {
        if (csrfToken) {
          xhr.setRequestHeader('X-CSRF-Token', csrfToken);
        }
        xhr.send(formData);
      }).catch(() => {
        // 如果获取 CSRF token 失败，仍然发送请求
        xhr.send(formData);
      });
    });
  }

  private async executeDownload(task: TaskItem): Promise<any> {
    if (!task.url) {
      throw new Error('No URL to download');
    }

    // 判断文件类型（通过 customEndpoint 判断）
    const isDriveFile = task.customEndpoint?.includes('/api/drive');
    const isGroupAttachment = task.customEndpoint?.includes('/api/group-attachments');
    const fullUrl = isDriveFile 
      ? `${this.config.apiBaseUrl}/api/drive/files/${task.url}/download`
      : isGroupAttachment
        ? `${this.config.apiBaseUrl}/api/group-attachments/${task.url}/download`
        : task.url.startsWith('http') 
          ? task.url 
          : `${this.config.apiBaseUrl}/api/files/${task.url}`;
    
    const token = localStorage.getItem('token');
    const keys = loadKeysFromStorage();
    
    this.updateTask(task.id, { progress: 0 });

    const abortController = new AbortController();
    this.currentAbortController = abortController;
    registerDownloadController(task.id, abortController);

    try {
      const response = await fetch(fullUrl, {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
        signal: abortController.signal
      });
      
      if (this.isTaskCancelled(task.id)) {
        throw new Error('下载已取消');
      }
      
      if (!response.ok) {
        if (task.isBurn) {
          throw new Error('阅后即焚：文件已被删除');
        }
        throw new Error('Download failed');
      }
      
      const contentLength = response.headers.get('content-length');
      const total = contentLength ? parseInt(contentLength) : 0;
      
      let loaded = 0;
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let blob: Blob;
      let lastSpeedUpdate = Date.now();
      let lastLoaded = 0;
      
      if (reader && total > 0) {
        while (true) {
          if (this.isTaskCancelled(task.id)) {
            throw new Error('下载已取消');
          }
          
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          loaded += value.length;
          
          const speed = Date.now() - lastSpeedUpdate > 0 && lastLoaded > 0
            ? Math.round(((loaded - lastLoaded) / (Date.now() - lastSpeedUpdate)) * 1000)
            : 0;
          
          if (Date.now() - lastSpeedUpdate >= 500) {
            lastSpeedUpdate = Date.now();
            lastLoaded = loaded;
          }
          
          this.updateTask(task.id, { 
            progress: Math.round((loaded / total) * 50),
            loadedSize: loaded,
            totalSize: total,
            speed
          });
        }
        blob = new Blob(chunks as BlobPart[]);
        
        if (task.encrypted) {
          if (!keys?.currentKey) {
            throw new Error('文件解密失败，无法下载文件（缺少密钥）');
          }
          this.updateTask(task.id, { progress: 50 });
          const result = await decryptFileChunkedWithKeysYield(blob, keys, (p) => {
            if (this.isTaskCancelled(task.id)) {
              throw new Error('下载已取消');
            }
            this.updateTask(task.id, { progress: 50 + Math.round(p * 0.5) });
          });
          blob = result.blob;
        }
      } else {
        blob = await response.blob();
        
        if (task.encrypted) {
          if (!keys?.currentKey) {
            throw new Error('文件解密失败，无法下载文件（缺少密钥）');
          }
          this.updateTask(task.id, { progress: 50 });
          const result = await decryptFileChunkedWithKeysYield(blob, keys, (p) => {
            this.updateTask(task.id, { progress: 50 + Math.round(p * 0.5) });
          });
          blob = result.blob;
        }
      }

      this.updateTask(task.id, { progress: 100 });

      // 跳过文件大小检查，直接返回

      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = task.filename;
      a.click();
      URL.revokeObjectURL(downloadUrl);

      return { success: true, blob };
    } catch (error: any) {
      if (error.name === 'AbortError' || error.message === '下载已取消') {
        return { cancelled: true };
      }
      throw error;
    } finally {
      this.currentAbortController = null;
    }
  }
}

export default TaskService;