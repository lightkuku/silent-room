import { loadKeysFromStorage, encrypt, tryDecrypt } from '../utils/crypto';
import { encryptFileChunkedWithYield } from '../utils/crypto';
import { decryptFileChunkedWithKeysYield } from '../utils/crypto';

export type TaskStatus = 'pending' | 'uploading' | 'paused' | 'completed' | 'error' | 'cancelled';
export type TaskType = 'upload' | 'download';

export interface FileTask {
  id: string;
  type: TaskType;
  filename: string;
  originalName: string;
  file?: File;
  url?: string;
  size: number;
  progress: number;
  loadedSize: number;
  status: TaskStatus;
  tempMessageId?: string;
  attachmentId?: string;  // 关联的附件 ID
  isEncrypted: boolean;
  senderId?: string;
  isBurn?: boolean;
  error?: string;
  result?: any;
  speed: number;
  createdAt: number;
  abortController?: AbortController;
  xhr?: XMLHttpRequest;
  customEndpoint?: string;
  totalSize?: number;
  skipSizeCheck?: boolean;
  uploadedChunks?: number[];
  totalChunks?: number;
  chunkSize?: number;
  resumeId?: string;
  encryptedFile?: File; // 暂停时保存加密后的文件
  onProgress?: (progress: number, speed: number, loadedSize: number) => void;
  sessionId?: string; // 群附件需要
}

type TaskUpdateCallback = (task: FileTask) => void;
type TaskCompleteCallback = (task: FileTask, result: any) => void;
type TaskErrorCallback = (task: FileTask, error: Error) => void;

interface FileServiceConfig {
  apiBaseUrl: string;
  maxConcurrent: number;
  onTaskUpdate?: TaskUpdateCallback;
  onTaskComplete?: TaskCompleteCallback;
  onTaskError?: TaskErrorCallback;
}

const DEFAULT_CHUNK_SIZE = 2 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 3;

interface ChunkInfo {
  index: number;
  status: 'pending' | 'uploading' | 'completed' | 'error';
  xhr: XMLHttpRequest | null;
}

class ChunkedUploader {
  private task: FileTask;
  private config: FileServiceConfig;
  private isPaused = false;
  private isCancelled = false;
  private fileToUpload: File | null = null;
  private encryptedName: string = '';
  private chunks: ChunkInfo[] = [];
  private resumeId = '';
  private finalUrl = '';
  private startTime = 0;

  constructor(task: FileTask, config: FileServiceConfig) {
    this.task = task;
    this.config = config;
  }

  async upload(): Promise<{ url: string; name: string; originalName: string; size: number; encrypted: boolean }> {
    const { file, totalChunks, chunkSize, uploadedChunks, resumeId: taskResumeId } = this.task;
    if (!file) throw new Error('没有文件');

    const keys = loadKeysFromStorage();
    const encryptionKey = localStorage.getItem('encryptionKey') || '';
    const keyToUse = keys?.currentKey || encryptionKey;
    const token = localStorage.getItem('token') || '';

    // console.log('[DEBUG] upload() 开始: task.isEncrypted=', this.task.isEncrypted, 'keys?.currentKey=', !!keys?.currentKey, 'encryptionKey=', !!encryptionKey, 'keyToUse=', !!keyToUse);

    this.fileToUpload = file;
    this.startTime = Date.now();
    const originalSize = file.size;

    const totalSize = this.task.totalSize || file.size;
    const actualChunkSize = chunkSize || DEFAULT_CHUNK_SIZE;
    const actualTotalChunks = totalChunks || Math.ceil(totalSize / actualChunkSize);

    const doneSet = new Set<number>(uploadedChunks || []);

    this.chunks = [];
    for (let i = 0; i < actualTotalChunks; i++) {
      this.chunks.push({
        index: i,
        status: doneSet.has(i) ? 'completed' : 'pending',
        xhr: null
      });
    }

    // 如果有恢复的 resumeId，使用它；否则先生成一个（用于关联所有分片）
    if (!this.resumeId) {
      if (taskResumeId) {
        this.resumeId = taskResumeId;
      } else {
        const userId = localStorage.getItem('userId') || 'anonymous';
        this.resumeId = `${userId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      }
    }
    
    let isEncrypted = false;
    
    // 如果有保存的加密文件（恢复时），直接使用
    if (this.task.encryptedFile) {
      this.fileToUpload = this.task.encryptedFile;
      isEncrypted = true;
      // 如果没有 encryptedName，需要重新生成
      if (!this.encryptedName) {
        this.encryptedName = encrypt(this.task.originalName, keyToUse || '');
      }
    } else if (keyToUse) {
      // 参考源代码：只要有密钥就加密文件
      // console.log('[DEBUG] 开始加密文件: keyToUse=', !!keyToUse, 'fileSize=', file.size);
      try {
        const encrypted = await encryptFileChunkedWithYield(file, keyToUse, (progress) => {
          if (this.isCancelled) throw new Error('任务已取消');
          if (this.isPaused) throw new Error('任务已暂停');
        });
        
        // 暂停检查
        if (this.isPaused) {
          throw new Error('任务已暂停');
        }
        
        this.fileToUpload = new File([encrypted], file.name + '.enc', { type: 'application/octet-stream' });
        isEncrypted = true;
        this.encryptedName = encrypt(file.name, keyToUse);
        // console.log('[DEBUG] 加密完成: encryptedName=', this.encryptedName, 'fileToUpload size=', this.fileToUpload.size);
      } catch (e: any) {
        if (e.message === '任务已取消' || e.message === '任务已暂停') throw e;
        console.error('加密失败:', e);
        throw new Error('文件加密失败: ' + e.message);
      }
    }

    if (this.isCancelled) throw new Error('任务已取消');
    if (this.isPaused) throw new Error('任务已暂停');

    this.task.status = 'uploading';
    this.notifyUpdate();

    const uploadSingleChunk = (chunkInfo: ChunkInfo): Promise<{ url?: string; name?: string; size?: number; encrypted?: boolean; skipped?: boolean }> => {
      return new Promise((resolve, reject) => {
        if (this.isCancelled) {
          reject(new Error('任务已取消'));
          return;
        }
        if (this.isPaused) {
          reject(new Error('任务已暂停'));
          return;
        }

        const xhr = new XMLHttpRequest();
        chunkInfo.xhr = xhr;
        chunkInfo.status = 'uploading';

        const chunkStart = chunkInfo.index * actualChunkSize;
        const chunkEnd = Math.min(chunkStart + actualChunkSize, this.fileToUpload!.size);
        const chunkBlob = this.fileToUpload!.slice(chunkStart, chunkEnd);
        const chunkSize = chunkEnd - chunkStart;

        const formData = new FormData();
        formData.append('chunk', chunkBlob);
        formData.append('chunkIndex', String(chunkInfo.index));
        formData.append('totalChunks', String(actualTotalChunks));
        // 发送原始文件名用于存储，加密文件名单独传递
        formData.append('filename', this.task.originalName);
        if (isEncrypted) {
          formData.append('name', this.encryptedName || this.task.originalName);
          formData.append('encrypted', 'true');
        }
        if (this.resumeId) {
          formData.append('resumeId', this.resumeId);
        }
        
        const totalFileSize = this.fileToUpload!.size;
        let lastSpeedUpdate = Date.now();
        let lastLoaded = 0;
        
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            // 计算已完成分片的实际大小
            const completedChunksSize = this.chunks
              .filter(c => c.index < chunkInfo.index && c.status === 'completed')
              .reduce((sum, c) => {
                const start = c.index * actualChunkSize;
                const end = Math.min(start + actualChunkSize, totalFileSize);
                return sum + (end - start);
              }, 0);
            
            // 当前分片的实际大小
            const chunkStartPos = chunkInfo.index * actualChunkSize;
            const chunkEndPos = Math.min(chunkStartPos + actualChunkSize, totalFileSize);
            const actualChunkSize2 = chunkEndPos - chunkStartPos;
            
            // 当前分片已上传的大小（不能超过分片实际大小）
            const currentChunkLoaded = Math.min(e.loaded, actualChunkSize2);
            const totalLoaded = completedChunksSize + currentChunkLoaded;
            
            // 进度基于实际文件大小
            const p = totalFileSize > 0 ? Math.round((totalLoaded / totalFileSize) * 100) : 0;
            
            const speed = lastLoaded > 0 && Date.now() - lastSpeedUpdate > 0
              ? Math.round(((e.loaded - lastLoaded) / (Date.now() - lastSpeedUpdate)) * 1000)
              : 0;
            
            if (Date.now() - lastSpeedUpdate >= 500) {
              lastSpeedUpdate = Date.now();
              lastLoaded = e.loaded;
            }
            
            this.updateProgress(Math.min(p, 100), speed, totalLoaded, totalFileSize);
          } else {
            this.updateProgressFromChunks();
          }
        });

        xhr.addEventListener('load', () => {
          chunkInfo.status = 'completed';
          chunkInfo.xhr = null;

          // 更新进度
          this.updateProgressFromChunks();

          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const response = JSON.parse(xhr.responseText);
              // console.log('[Debug] 分片', chunkInfo.index, '响应:', JSON.stringify(response));
              if (response.success) {
                if (response.data.resumeId) this.resumeId = response.data.resumeId;
                // 如果分片已存在（断点续传）
                if (response.data.skipped) {
                  resolve({ skipped: true });
                  return;
                }
                // 只有最终响应才包含 url
                if (response.data.url) {
                  this.finalUrl = response.data.url;
                  resolve({
                    url: response.data.url,
                    name: response.data.name,
                    size: response.data.size,
                    encrypted: response.data.encrypted
                  });
                } else {
                  // 中间分片上传完成
                  resolve({});
                }
              } else {
                reject(new Error(response.message || '分片上传失败'));
              }
            } catch {
              reject(new Error('解析响应失败'));
            }
          } else if (xhr.status === 0) {
            reject(new Error('上传已取消'));
          } else {
            reject(new Error(`上传失败: ${xhr.status}`));
          }
        });

        xhr.addEventListener('error', () => {
          chunkInfo.status = 'error';
          chunkInfo.xhr = null;
          reject(new Error('网络错误'));
        });

        xhr.addEventListener('abort', () => {
          chunkInfo.status = 'error';
          chunkInfo.xhr = null;
          if (this.isPaused || this.isCancelled) {
            resolve({ skipped: true });
          } else {
            resolve({ skipped: true } as any);
          }
        });

        xhr.open('POST', `${this.config.apiBaseUrl}/api/upload/chunk`);
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.send(formData);
      });
    };

    let finalResult: { url?: string; name?: string; size?: number; encrypted?: boolean } | null = null;
    
    const pendingChunks = this.chunks.filter(c => c.status === 'pending');
    
    if (pendingChunks.length === 0) {
      throw new Error('没有待上传的分片');
    }
    
    // 1. 先调用初始化 API（传递 sessionId 用于群附件）
    const initResponse = await fetch(`${this.config.apiBaseUrl}/api/upload/chunk/init`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        filename: this.task.originalName,
        totalChunks: actualTotalChunks,
        encrypted: isEncrypted,
        encryptedName: this.encryptedName,
        fileSize: totalSize,
        sessionId: this.task.sessionId
      })
    });

    if (!initResponse.ok) {
      throw new Error('初始化上传失败');
    }

    const initData = await initResponse.json();
    if (!initData.success) {
      throw new Error(initData.message || '初始化上传失败');
    }

    // 检查是否使用分片上传
    if (!initData.data.useChunkedUpload) {
      return await this.normalUpload(file, isEncrypted);
    }

    this.resumeId = initData.data.uploadId;
    
    // 获取已上传的分片信息（用于断点续传）
    const uploadedChunksFromServer: number[] = initData.data.uploadedChunks || [];
    
    // 更新 chunks 状态，跳过已上传的分片
    uploadedChunksFromServer.forEach(idx => {
      const chunk = this.chunks.find(c => c.index === idx);
      if (chunk) {
        chunk.status = 'completed';
      }
    });
    
    // 重新获取 pendingChunks
    const newPendingChunks = this.chunks.filter(c => c.status === 'pending');
    
    // 参考 hendrialqori/chunks-upload：顺序上传分片，最后一个触发合并
    for (let i = 0; i < newPendingChunks.length; i++) {
      // 检查暂停/取消
      if (this.isCancelled) throw new Error('任务已取消');
      if (this.isPaused) throw new Error('任务已暂停');
      
      const chunk = newPendingChunks[i];
      
      try {
        const result = await uploadSingleChunk(chunk);
        // console.log('[DEBUG] 分片', chunk.index, '完成, result:', JSON.stringify(result));
        
        if (result.skipped) {
          chunk.status = 'completed';
        }
        
        // 最后一个分片包含最终 URL
        if (result.url) {
          finalResult = result;
        }
      } catch (e: any) {
        if (this.isPaused) throw new Error('任务已暂停');
        if (this.isCancelled) throw new Error('任务已取消');
        throw e;
      }
    }
    
    // 如果任务被暂停或取消
    if (this.isPaused || this.isCancelled) {
      return;
    }

    // console.log('[DEBUG] 最终 finalResult:', finalResult);

    // 检查结果
    if (!finalResult?.url) {
      throw new Error('上传失败：未收到文件URL');
    }

    // 上传完成，设置进度为 100%
    this.task.progress = 100;
    this.task.loadedSize = this.fileToUpload?.size || file.size;
    this.task.speed = 0;
    this.notifyUpdate();

    // console.log('[DEBUG] 返回结果:', { 
    //   url: finalResult.url, 
    //   name: finalResult.name || (isEncrypted ? this.encryptedName : this.task.originalName),
    //   originalName: this.task.originalName,
    //   size: finalResult.size || file.size,
    //   encrypted: finalResult.encrypted ?? isEncrypted,
    // });

    return {
      url: finalResult.url,
      name: finalResult.name || (isEncrypted ? this.encryptedName : this.task.originalName),
      originalName: this.task.originalName,
      size: finalResult.size || file.size,
      encrypted: finalResult.encrypted ?? isEncrypted,
    };
  }

  // 普通上传（用于非 R2 存储）
  private async normalUpload(file: File, encrypted: boolean): Promise<{ url: string; name: string; originalName: string; size: number; encrypted: boolean }> {
    const token = localStorage.getItem('token') || '';
    
    // 使用已加密的文件（如果已加密）
    const fileToUpload = this.fileToUpload || file;
    
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      
      let lastSpeedUpdate = Date.now();
      let lastLoaded = 0;
      
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const p = Math.round((e.loaded / e.total) * 100);
          const speed = lastLoaded > 0 && Date.now() - lastSpeedUpdate > 0
            ? Math.round(((e.loaded - lastLoaded) / (Date.now() - lastSpeedUpdate)) * 1000)
            : 0;
          
          if (Date.now() - lastSpeedUpdate >= 500) {
            lastSpeedUpdate = Date.now();
            lastLoaded = e.loaded;
          }
          
          this.updateProgress(p, speed, e.loaded, e.total);
        }
      });
      
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const response = JSON.parse(xhr.responseText);
            if (response.success) {
              this.task.progress = 100;
              this.task.loadedSize = fileToUpload.size;
              this.task.speed = 0;
              this.notifyUpdate();
              resolve({
                url: response.data.url,
                name: response.data.name,
                originalName: this.task.originalName,
                size: response.data.size,
                encrypted: response.data.encrypted
              });
            } else {
              reject(new Error(response.message || '上传失败'));
            }
          } catch (e) {
            reject(new Error('解析响应失败'));
          }
        } else {
          reject(new Error(`上传失败: ${xhr.status}`));
        }
      });
      
      xhr.addEventListener('error', () => {
        reject(new Error('网络错误'));
      });
      
      xhr.addEventListener('abort', () => {
        if (this.isPaused) {
          reject(new Error('任务已暂停'));
        } else {
          reject(new Error('任务已取消'));
        }
      });
      
      const formData = new FormData();
      formData.append('file', fileToUpload);
      if (this.encryptedName) {
        formData.append('encrypted', 'true');
        formData.append('name', this.encryptedName);
      }
      
      xhr.open('POST', `${this.config.apiBaseUrl}/api/upload`);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.send(formData);
    });
  }

  // 上传到自定义端点
  private async normalUploadToEndpoint(file: File, encrypted: boolean): Promise<{ url: string; name: string; originalName: string; size: number; encrypted: boolean }> {
    const endpoint = this.task.customEndpoint!;
    const fileToUpload = this.fileToUpload || file;
    
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      
      let lastSpeedUpdate = Date.now();
      let lastLoaded = 0;
      
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const p = Math.round((e.loaded / e.total) * 100);
          const speed = lastLoaded > 0 && Date.now() - lastSpeedUpdate > 0
            ? Math.round(((e.loaded - lastLoaded) / (Date.now() - lastSpeedUpdate)) * 1000)
            : 0;
          
          if (Date.now() - lastSpeedUpdate >= 500) {
            lastSpeedUpdate = Date.now();
            lastLoaded = e.loaded;
          }
          
          this.updateProgress(p, speed, e.loaded, e.total);
        }
      });
      
      const sendRequest = (csrfToken: string) => {
        const token = localStorage.getItem('token') || '';
        
        const formData = new FormData();
        formData.append('file', fileToUpload);
        formData.append('filename', this.encryptedName || this.task.originalName);
        if (this.encryptedName) {
          formData.append('encrypted', 'true');
          formData.append('name', this.encryptedName);
        }
        
        xhr.open('POST', `${this.config.apiBaseUrl}${endpoint}`);
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.setRequestHeader('X-CSRF-Token', csrfToken);
        
        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const response = JSON.parse(xhr.responseText);
              if (response.success) {
                this.task.progress = 100;
                this.task.loadedSize = fileToUpload.size;
                this.task.speed = 0;
                this.notifyUpdate();
                resolve({
                  url: response.data.url,
                  name: response.data.name,
                  originalName: this.task.originalName,
                  size: response.data.size,
                  encrypted: response.data.encrypted
                });
              } else {
                reject(new Error(response.message || '上传失败'));
              }
            } catch (e) {
              reject(new Error('解析响应失败'));
            }
          } else if (xhr.status === 403) {
            // CSRF 错误，刷新 token 后重试
            this.refreshCsrfToken().then(newToken => {
              if (newToken) {
                sendRequest(newToken);
              } else {
                reject(new Error('CSRF token 刷新失败'));
              }
            });
          } else {
            reject(new Error(`上传失败: ${xhr.status}`));
          }
        });
        
        xhr.addEventListener('error', () => {
          reject(new Error('网络错误'));
        });
        
        xhr.addEventListener('abort', () => {
          if (this.isPaused) {
            reject(new Error('任务已暂停'));
          } else {
            reject(new Error('任务已取消'));
          }
        });
        
        xhr.send(formData);
      };
      
      // 初始获取 CSRF token
      let csrfToken = sessionStorage.getItem('csrfToken') || localStorage.getItem('csrfToken') || '';
      if (!csrfToken) {
        this.refreshCsrfToken().then(token => {
          sendRequest(token || '');
        });
      } else {
        sendRequest(csrfToken);
      }
    });
  }
  
  // 刷新 CSRF token
  private async refreshCsrfToken(): Promise<string | null> {
    try {
      const token = localStorage.getItem('token');
      if (!token) return null;
      
      const response = await fetch(`${this.config.apiBaseUrl}/api/auth/csrf`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      const data = await response.json();
      if (data.success && data.data.csrfToken) {
        const csrfToken = data.data.csrfToken;
        sessionStorage.setItem('csrfToken', csrfToken);
        return csrfToken;
      }
    } catch (e) {
      console.error('刷新 CSRF token 失败:', e);
    }
    return null;
  }

  private updateProgressFromChunks(): void {
    const actualChunkSize = this.task.chunkSize || DEFAULT_CHUNK_SIZE;
    
    let totalLoaded = 0;
    const fileSize = this.fileToUpload?.size || this.task.totalSize || 0;
    
    for (const chunk of this.chunks) {
      const chunkStart = chunk.index * actualChunkSize;
      const chunkEnd = Math.min(chunkStart + actualChunkSize, fileSize);
      const chunkSize = chunkEnd - chunkStart;
      
      if (chunk.status === 'completed') {
        totalLoaded += chunkSize;
      }
    }
    
    // 进度基于实际文件大小
    const p = fileSize > 0 ? Math.round((totalLoaded / fileSize) * 100) : 0;

    this.task.loadedSize = totalLoaded;
    this.task.uploadedChunks = this.chunks
      .filter(c => c.status === 'completed')
      .map(c => c.index);
    
    this.updateProgress(Math.min(p, 100), 0, totalLoaded, fileSize);
  }

  private updateProgress(progress: number, speed: number, loadedSize: number, totalSize?: number): void {
    this.task.progress = progress;
    this.task.speed = speed;
    this.task.loadedSize = loadedSize;
    if (totalSize !== undefined) {
      this.task.totalSize = totalSize;
    }
    this.task.onProgress?.(progress, speed, loadedSize);
    this.notifyUpdate();
  }

  pause(): void {
    this.isPaused = true;
    this.chunks.forEach(c => {
      if (c.xhr) {
        c.xhr.abort();
        c.xhr = null;
      }
    });
    this.task.status = 'paused';
    this.task.speed = 0;
    this.task.uploadedChunks = this.chunks
      .filter(c => c.status === 'completed')
      .map(c => c.index);
    
    // 保存加密后的文件，以便恢复时使用
    if (this.fileToUpload && this.task.isEncrypted) {
      this.task.encryptedFile = this.fileToUpload;
      this.task.totalSize = this.fileToUpload.size;
    }
    
    // 保存暂停状态
    const fileService = FileService.getInstanceSafe();
    if (fileService) {
      fileService.savePausedTask(this.task.id, {
        uploadedChunks: this.task.uploadedChunks,
        resumeId: this.resumeId,
        loadedSize: this.task.loadedSize || 0,
        totalSize: this.task.totalSize,
        encryptedFile: this.fileToUpload
      });
    }
    
    this.notifyUpdate();
  }

  cancel(): void {
    this.isCancelled = true;
    this.chunks.forEach(c => {
      if (c.xhr) {
        c.xhr.abort();
        c.xhr = null;
      }
    });
    this.task.status = 'cancelled';
    this.task.speed = 0;
    this.task.loadedSize = 0;
    this.task.uploadedChunks = [];
    this.notifyUpdate();
  }

  private notifyUpdate(): void {
    this.config.onTaskUpdate?.(this.task);
  }
}

const DOWNLOAD_CONCURRENCY = 4;
const DOWNLOAD_CHUNK_SIZE = 2 * 1024 * 1024;
const MIN_CONCURRENT_SIZE = 5 * 1024 * 1024;

interface DownloadChunk {
  index: number;
  start: number;
  end: number;
  data: Uint8Array | null;
  status: 'pending' | 'downloading' | 'completed' | 'error';
  abortController: AbortController | null;
}

class ChunkedDownloader {
  private task: FileTask;
  private config: FileServiceConfig;
  private isPaused = false;
  private isCancelled = false;
  private chunks: DownloadChunk[] = [];
  private activeControllers: AbortController[] = [];

  constructor(task: FileTask, config: FileServiceConfig) {
    this.task = task;
    this.config = config;
  }

  async download(): Promise<Blob> {
    if (!this.task.url) throw new Error('没有下载链接');

    const keys = loadKeysFromStorage();
    const token = localStorage.getItem('token');

    this.task.status = 'uploading';
    this.notifyUpdate();

    const fullUrl = this.task.url.startsWith('http')
      ? this.task.url
      : this.task.url.includes('group-attachments') 
        ? `${this.config.apiBaseUrl}${this.task.url}`  // 群附件使用完整路径
        : `${this.config.apiBaseUrl}/api/files/${this.task.url}`;

    // console.log('[DEBUG] download(): url=', fullUrl, 'size=', this.task.size);

    const totalSize = await this.getFileSize(fullUrl, token);
    this.task.size = totalSize;

    if (totalSize < MIN_CONCURRENT_SIZE) {
      return this.downloadSimple(fullUrl, token, keys);
    }

    return this.downloadConcurrent(fullUrl, token, keys, totalSize);
  }

  private async getFileSize(url: string, token: string): Promise<number> {
    if (this.task.size > 0) {
      // console.log('[DEBUG] getFileSize: 使用已有size=', this.task.size);
      return this.task.size;
    }

    try {
      // console.log('[DEBUG] getFileSize: 发送HEAD请求到', url);
      const response = await fetch(url, {
        method: 'HEAD',
        headers: { Authorization: `Bearer ${token}` }
      });
      const contentLength = response.headers.get('Content-Length');
      // console.log('[DEBUG] getFileSize: Content-Length=', contentLength);
      if (contentLength) {
        return parseInt(contentLength, 10);
      }
    } catch (e) {
      // console.log('[DEBUG] getFileSize: 失败', e);
    }

    return this.task.size || 50 * 1024 * 1024;
  }

  private async downloadSimple(url: string, token: string, keys: any): Promise<Blob> {
    const abortController = new AbortController();
    this.activeControllers.push(abortController);
    this.task.abortController = abortController;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: abortController.signal
    });

    if (!response.ok && response.status !== 206) {
      throw new Error(`下载失败: ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('无法读取响应');

    const chunks: Uint8Array[] = [];
    let receivedLength = 0;
    const startTime = Date.now();
    let lastLoaded = 0;
    let lastTime = startTime;

    while (true) {
      if (this.isCancelled) {
        try { reader.cancel(); } catch {}
        throw new Error('任务已取消');
      }
      if (this.isPaused) {
        this.task.loadedSize = receivedLength;
        try { reader.cancel(); } catch {}
        throw new Error('任务已暂停');
      }

      let readResult;
      try {
        readResult = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value?: undefined }>((_, reject) => 
            setTimeout(() => reject(new Error('timeout')), 100)
          )
        ]);
      } catch (e: any) {
        if (e.message === 'timeout') continue;
        if (abortController.signal.aborted) {
          try { reader.cancel(); } catch {}
          throw new Error('任务已取消');
        }
        throw e;
      }

      if (!readResult || readResult.done) break;

      const { done, value } = readResult;
      if (done) break;

      chunks.push(value);
      receivedLength += value.length;

      const now = Date.now();
      const timeDiff = (now - lastTime) / 1000;
      let speed = 0;
      if (timeDiff > 0.1) {
        speed = (receivedLength - lastLoaded) / timeDiff;
        lastLoaded = receivedLength;
        lastTime = now;
      }

      this.task.loadedSize = receivedLength;
      this.task.speed = speed;
      this.task.progress = this.task.size > 0 ? Math.round((receivedLength / this.task.size) * 100) : 0;
      this.notifyUpdate();
    }

    return this.processResult(new Blob(chunks as BlobPart[]), keys);
  }

  private async downloadConcurrent(url: string, token: string, keys: any, totalSize: number): Promise<Blob> {
    const startOffset = this.task.loadedSize || 0;
    const remainingSize = totalSize - startOffset;
    const numChunks = Math.ceil(remainingSize / DOWNLOAD_CHUNK_SIZE);

    // console.log('[DEBUG] 下载分片: totalSize=', totalSize, 'startOffset=', startOffset, 'remainingSize=', remainingSize, 'numChunks=', numChunks, 'chunkSize=', DOWNLOAD_CHUNK_SIZE);

    this.chunks = [];
    for (let i = 0; i < numChunks; i++) {
      const chunkStart = startOffset + i * DOWNLOAD_CHUNK_SIZE;
      const chunkEnd = Math.min(chunkStart + DOWNLOAD_CHUNK_SIZE - 1, totalSize - 1);
      
      this.chunks.push({
        index: i,
        start: chunkStart,
        end: chunkEnd,
        data: null,
        status: 'pending',
        abortController: null
      });
    }

    // 如果有已下载的分片信息，跳过这些分片
    if (this.task.uploadedChunks && this.task.uploadedChunks.length > 0) {
      // console.log('[DEBUG] 恢复下载，已完成分片:', this.task.uploadedChunks);
      this.task.uploadedChunks.forEach(idx => {
        const chunk = this.chunks.find(c => c.index === idx);
        if (chunk) {
          chunk.status = 'completed';
        }
      });
    }

    const startTime = Date.now();
    let lastUpdateTime = startTime;
    let lastLoaded = startOffset;

    const downloadChunk = async (chunk: DownloadChunk): Promise<void> => {
      if (this.isCancelled || this.isPaused) {
        chunk.status = 'pending';
        return;
      }

      const abortController = new AbortController();
      chunk.abortController = abortController;
      chunk.status = 'downloading';

      try {
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            Range: `bytes=${chunk.start}-${chunk.end}`
          },
          signal: abortController.signal
        });

        if (!response.ok && response.status !== 206) {
          chunk.status = 'error';
          throw new Error(`下载失败: ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('无法读取响应');

        const chunks: Uint8Array[] = [];
        while (!abortController.signal.aborted) {
          try {
            const { done, value } = await Promise.race([
              reader.read(),
              new Promise<{ done: true; value?: undefined }>((_, reject) => 
                setTimeout(() => reject(new Error('timeout')), 100)
              )
            ]);
            if (done || abortController.signal.aborted) break;
            chunks.push(value);
          } catch (e: any) {
            if (e.message === 'timeout') continue;
            if (abortController.signal.aborted) break;
            throw e;
          }
        }

        chunk.data = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
        let offset = 0;
        for (const c of chunks) {
          chunk.data!.set(c, offset);
          offset += c.length;
        }
        chunk.status = 'completed';
        // console.log('[DEBUG] 分片', chunk.index, '下载完成, size=', chunk.data?.length);
      } catch (e: any) {
        if (e.name === 'AbortError') {
          chunk.status = 'pending';
        } else {
          chunk.status = 'error';
        }
      } finally {
        chunk.abortController = null;
      }
    };

    const pendingChunks = () => this.chunks.filter(c => c.status === 'pending');
    const completedChunks = () => this.chunks.filter(c => c.status === 'completed');
    const totalLoaded = () => {
      let loaded = startOffset;
      for (const c of this.chunks) {
        if (c.status === 'completed' && c.data) {
          loaded += c.data.length;
        } else if (c.status === 'downloading') {
          loaded += Math.floor((c.end - c.start + 1) * 0.5);
        }
      }
      return loaded;
    };

    while (completedChunks().length < this.chunks.length) {
      if (this.isCancelled) {
        for (const c of this.chunks) {
          if (c.abortController) {
            c.abortController.abort();
          }
        }
        throw new Error('任务已取消');
      }

      if (this.isPaused) {
        for (const c of this.chunks) {
          if (c.abortController) {
            c.abortController.abort();
          }
        }
        this.task.loadedSize = totalLoaded();
        throw new Error('任务已暂停');
      }

      const pending = pendingChunks();
      const downloading = this.chunks.filter(c => c.status === 'downloading');
      const maxConcurrent = DOWNLOAD_CONCURRENCY - downloading.length;

      if (maxConcurrent > 0 && pending.length > 0) {
        const toDownload = pending.slice(0, maxConcurrent);
        toDownload.forEach(c => downloadChunk(c));
      }

      await new Promise(resolve => setTimeout(resolve, 100));

      const now = Date.now();
      if (now - lastUpdateTime > 100) {
        const loaded = totalLoaded();
        const timeDiff = (now - lastUpdateTime) / 1000;
        const speed = (loaded - lastLoaded) / timeDiff;
        
        this.task.loadedSize = loaded;
        this.task.speed = speed;
        this.task.progress = Math.round((loaded / totalSize) * 100);
        lastLoaded = loaded;
        lastUpdateTime = now;
        this.notifyUpdate();
      }
    }

    const sortedChunks = this.chunks.sort((a, b) => a.index - b.index);
    const totalLength = sortedChunks.reduce((acc, c) => acc + (c.data?.length || 0), 0);
    const resultData = new Uint8Array(totalLength);
    let offset = 0;
    for (const c of sortedChunks) {
      if (c.data) {
        resultData.set(c.data, offset);
        offset += c.data.length;
      }
    }

    return this.processResult(new Blob([resultData.buffer]), keys);
  }

  private async processResult(blob: Blob, keys: any): Promise<Blob> {
    // console.log('[DEBUG] processResult: isEncrypted=', this.task.isEncrypted, 'keys=', !!keys?.currentKey, 'blob size=', blob.size, 'first bytes=', blob.size > 0 ? new Uint8Array(await blob.slice(0, 20).arrayBuffer()) : 'empty');
    if (this.task.isEncrypted && keys?.currentKey) {
      try {
        const decryptedBlob = await decryptFileChunkedWithKeysYield(blob, keys, (progress) => {
          // 解密进度：下载 100% + 解密 0-100%
          const decryptProgress = Math.round(70 + progress * 30);
          this.task.progress = decryptProgress;
          this.notifyUpdate();
        });
        this.task.progress = 100;
        this.notifyUpdate();
        // console.log('[DEBUG] 解密成功, decrypted size=', decryptedBlob.blob.size);
        return decryptedBlob.blob;
      } catch (e: any) {
        console.error('解密失败:', e.message, e.stack);
        throw new Error('文件解密失败');
      }
    }
    this.task.progress = 100;
    this.notifyUpdate();
    return blob;
  }

  pause(): void {
    this.isPaused = true;
    for (const c of this.chunks) {
      if (c.abortController) {
        c.abortController.abort();
      }
    }
    this.activeControllers.forEach(c => c.abort());
    this.activeControllers = [];
    this.task.status = 'paused';
    this.task.speed = 0;
    
    // 保存暂停状态，以便恢复（下载不需要 resumeId）
    const fileService = FileService.getInstanceSafe();
    if (fileService) {
      fileService.savePausedTask(this.task.id, {
        uploadedChunks: this.chunks.filter(c => c.status === 'completed').map(c => c.index),
        loadedSize: this.task.loadedSize || 0
      });
    }
    
    this.notifyUpdate();
  }

  cancel(): void {
    this.isCancelled = true;
    for (const c of this.chunks) {
      if (c.abortController) {
        c.abortController.abort();
      }
    }
    this.activeControllers.forEach(c => c.abort());
    this.activeControllers = [];
    this.task.status = 'cancelled';
    this.task.speed = 0;
    this.task.loadedSize = 0;
    this.notifyUpdate();
  }

  private notifyUpdate(): void {
    this.config.onTaskUpdate?.(this.task);
  }
}

class FileService {
  private static instance: FileService;
  private tasks: Map<string, FileTask> = new Map();
  private queue: string[] = [];
  private config: FileServiceConfig;
  private isProcessing = false;
  private activeTasks = 0;
  private uploaders: Map<string, ChunkedUploader> = new Map();
  private downloaders: Map<string, ChunkedDownloader> = new Map();
  private pausedTasks: Map<string, { uploadedChunks: number[]; resumeId?: string; loadedSize: number; totalSize?: number; encryptedFile?: File }> = new Map();

  private constructor(config: FileServiceConfig) {
    this.config = {
      maxConcurrent: 3,
      ...config,
    };
  }

  static getInstance(config?: Partial<FileServiceConfig>): FileService {
    if (!FileService.instance) {
      if (!config?.apiBaseUrl) {
        throw new Error('FileService 需要 apiBaseUrl');
      }
      FileService.instance = new FileService({
        apiBaseUrl: config.apiBaseUrl,
        maxConcurrent: config?.maxConcurrent || 3,
        onTaskUpdate: config?.onTaskUpdate,
        onTaskComplete: config?.onTaskComplete,
        onTaskError: config?.onTaskError,
      });
    }
    return FileService.instance;
  }

  static getInstanceSafe(config?: Partial<FileServiceConfig>): FileService | null {
    if (!FileService.instance && config?.apiBaseUrl) {
      return FileService.getInstance(config);
    }
    return FileService.instance;
  }

  static resetInstance(): void {
    FileService.instance = undefined as any;
  }

  private generateId(): string {
    return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private notifyUpdate(task: FileTask): void {
    this.config.onTaskUpdate?.(task);
  }

  private notifyComplete(task: FileTask, result: any): void {
    this.config.onTaskComplete?.(task, result);
  }

  private notifyError(task: FileTask, error: Error): void {
    this.config.onTaskError?.(task, error);
  }

  addUploadTask(params: {
    filename: string;
    file: File;
    size: number;
    tempMessageId?: string;
    attachmentId?: string;
    isEncrypted?: boolean;
    totalSize?: number;
    customEndpoint?: string;
    sessionId?: string;
  }): string {
    const id = this.generateId();
    const totalSize = params.totalSize || params.file.size;
    const chunkSize = DEFAULT_CHUNK_SIZE;
    const totalChunks = Math.ceil(totalSize / chunkSize);

    const task: FileTask = {
      id,
      type: 'upload',
      filename: params.filename,
      originalName: params.filename,
      file: params.file,
      size: totalSize,
      progress: 0,
      loadedSize: 0,
      status: 'pending',
      tempMessageId: params.tempMessageId,
      attachmentId: params.attachmentId,
      isEncrypted: params.isEncrypted || false,
      customEndpoint: params.customEndpoint,
      sessionId: params.sessionId,
      totalSize,
      speed: 0,
      createdAt: Date.now(),
      uploadedChunks: [],
      totalChunks,
      chunkSize,
    };

    this.tasks.set(id, task);
    this.queue.push(id);
    this.notifyUpdate(task);
    this.processQueue();
    return id;
  }

  addDownloadTask(params: {
    filename: string;
    url: string;
    size?: number;
    tempMessageId?: string;
    attachmentId?: string;
    isEncrypted?: boolean;
    senderId?: string;
    isBurn?: boolean;
  }): string {
    const id = this.generateId();
    const task: FileTask = {
      id,
      type: 'download',
      filename: params.filename,
      originalName: params.filename,
      url: params.url,
      size: params.size || 0,
      progress: 0,
      loadedSize: 0,
      status: 'pending',
      tempMessageId: params.tempMessageId,
      attachmentId: params.attachmentId,
      isEncrypted: params.isEncrypted || false,
      senderId: params.senderId,
      isBurn: params.isBurn,
      speed: 0,
      createdAt: Date.now(),
    };

    this.tasks.set(id, task);
    this.queue.push(id);
    this.notifyUpdate(task);
    this.processQueue();
    return id;
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.queue.length > 0 && this.activeTasks < this.config.maxConcurrent) {
      const taskId = this.queue.shift();
      if (!taskId) continue;

      const task = this.tasks.get(taskId);
      if (!task || (task.status !== 'pending' && task.status !== 'paused')) continue;

      this.activeTasks++;
      this.executeTask(task).finally(() => {
        this.activeTasks--;
        this.processQueue();
      });
    }

    this.isProcessing = false;
  }

  private async executeTask(task: FileTask): Promise<void> {
    // 检查是否有暂停信息需要恢复
    const pausedInfo = this.getPausedTaskInfo(task.id);
    // console.log('[DEBUG] executeTask: type=', task.type, 'id=', task.id, 'isEncrypted=', task.isEncrypted, 'pausedInfo=', !!pausedInfo);
    
    try {
      if (task.type === 'upload') {
        const uploader = new ChunkedUploader(task, this.config);
        this.uploaders.set(task.id, uploader);
        
        // 如果有恢复信息，恢复已上传的分片
        if (pausedInfo) {
          task.loadedSize = pausedInfo.loadedSize;
          task.uploadedChunks = pausedInfo.uploadedChunks || [];
        }
        
        let result;
        try {
          result = await uploader.upload();
        } catch (e: any) {
          // 暂停或取消时，直接返回，不报错
          if (e.message === '任务已暂停' || e.message === '任务已取消') {
            return;
          }
          throw e;
        }
        
        if (!result) return;
        
        const isImage = task.file?.type.startsWith('image/');
        const finalResult = {
          type: isImage ? 'image' : 'file',
          name: result.name || task.filename,
          size: result.size || task.size,
          url: result.url || '',
          encrypted: result.encrypted ?? task.isEncrypted,
        };
        
        task.progress = 100;
        task.status = 'completed';
        // console.log('[FileService] notifyComplete:', { 
        //   taskId: task.id, 
        //   tempMessageId: task.tempMessageId, 
        //   filename: task.filename,
        //   finalResult,
        //   result
        // });
        this.notifyComplete(task, finalResult);
        this.notifyUpdate(task);
      } else {
        // 先解密文件名，失败则不下载（只有文件名看起来是加密的才尝试解密）
        let downloadFilename = task.filename;
        if (task.isEncrypted) {
          // 检查文件名是否看起来是加密的
          const isLikelyEncrypted = task.filename.startsWith('U2FsdGVkX') || task.filename.startsWith('Salted__');
          if (isLikelyEncrypted) {
            const result = tryDecrypt(task.filename);
            if (!result.decrypted) {
              throw new Error('文件名解密失败，无法下载');
            }
            downloadFilename = result.content;
          }
          // 如果文件名不是加密格式（已经是解密后的），直接使用
        }

        const downloader = new ChunkedDownloader(task, this.config);
        
        // 如果有恢复信息，恢复已下载的分片
        if (pausedInfo) {
          task.loadedSize = pausedInfo.loadedSize;
        }
        
        this.downloaders.set(task.id, downloader);
        
        let blob;
        // console.log('[DEBUG] 开始下载, url=', task.url, 'size=', task.size);
        try {
          blob = await downloader.download();
          // console.log('[DEBUG] 下载完成, blob size=', blob?.size);
        } catch (e: any) {
          console.error('[DEBUG] 下载失败:', e.message);
          // 暂停或取消时，直接返回
          if (e.message === '任务已暂停' || e.message === '任务已取消') {
            return;
          }
          throw e;
        }
        
        if (!blob) return;
        
        this.downloadBlob(blob, downloadFilename);
        
        task.progress = 100;
        task.status = 'completed';
        this.notifyComplete(task, { success: true, blob });
        this.notifyUpdate(task);
      }
    } catch (error: any) {
      const msg = error.message || '';
      if (!msg.includes('已取消') && !msg.includes('已暂停')) {
        task.status = 'error';
        task.error = msg;
        this.notifyError(task, error);
      }
      this.notifyUpdate(task);
    } finally {
      this.uploaders.delete(task.id);
      this.downloaders.delete(task.id);
    }
  }

  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  pauseTask(taskId: string): void {
    const uploader = this.uploaders.get(taskId);
    if (uploader) {
      uploader.pause();
      return;
    }
    
    const downloader = this.downloaders.get(taskId);
    if (downloader) {
      downloader.pause();
      return;
    }

    const task = this.tasks.get(taskId);
    if (task && task.status === 'uploading') {
      task.status = 'paused';
      task.speed = 0;
      this.notifyUpdate(task);
    }
  }

  savePausedTask(taskId: string, info: { uploadedChunks: number[]; resumeId?: string; loadedSize: number; totalSize?: number; encryptedFile?: File }): void {
    this.pausedTasks.set(taskId, info);
  }

  getPausedTaskInfo(taskId: string): { uploadedChunks: number[]; resumeId?: string; loadedSize: number } | undefined {
    return this.pausedTasks.get(taskId) as any;
  }

  resumeTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'paused') return;

    task.status = 'pending';
    task.speed = 0;

    // 从 pausedTasks 中恢复已上传的分片信息
    const pausedInfo = this.pausedTasks.get(taskId);
    if (pausedInfo) {
      task.uploadedChunks = pausedInfo.uploadedChunks;
      task.resumeId = pausedInfo.resumeId;
      task.loadedSize = pausedInfo.loadedSize;
      if (pausedInfo.totalSize) {
        task.totalSize = pausedInfo.totalSize;
      }
      // 恢复加密后的文件（用于跳过重新加密）
      if (pausedInfo.encryptedFile) {
        task.encryptedFile = pausedInfo.encryptedFile;
      }
      this.pausedTasks.delete(taskId);
    }

    if (!this.queue.includes(taskId)) {
      this.queue.unshift(taskId);
    }

    this.notifyUpdate(task);
    this.processQueue();
  }

  cancelTask(taskId: string): void {
    const uploader = this.uploaders.get(taskId);
    if (uploader) {
      uploader.cancel();
      return;
    }

    const downloader = this.downloaders.get(taskId);
    if (downloader) {
      downloader.cancel();
      return;
    }

    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = 'cancelled';
    task.speed = 0;
    this.notifyUpdate(task);
  }

  cancelAll(): void {
    this.uploaders.forEach(u => u.cancel());
    this.downloaders.forEach(d => d.cancel());
    
    const tasks = this.getAllTasks();
    tasks.forEach(task => {
      if (task.status === 'pending' || task.status === 'paused') {
        task.status = 'cancelled';
        task.speed = 0;
        this.notifyUpdate(task);
      }
    });
  }

  retryTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task || (task.status !== 'error' && task.status !== 'cancelled' && task.status !== 'paused')) return;

    task.status = 'pending';
    task.progress = 0;
    task.loadedSize = 0;
    task.speed = 0;
    task.error = undefined;

    // 保留 uploadedChunks 和 resumeId 以支持断点续传
    // uploadedChunks = task.uploadedChunks; // 不清空，保留已上传的分片
    // resumeId 会保持不变

    if (!this.queue.includes(taskId)) {
      this.queue.push(taskId);
    }

    this.notifyUpdate(task);
    this.processQueue();
  }

  removeTask(taskId: string): void {
    this.cancelTask(taskId);
    this.tasks.delete(taskId);
  }

  getTask(taskId: string): FileTask | undefined {
    return this.tasks.get(taskId);
  }

  getAllTasks(): FileTask[] {
    return Array.from(this.tasks.values());
  }

  getTasksByStatus(status: TaskStatus): FileTask[] {
    return Array.from(this.tasks.values()).filter(t => t.status === status);
  }

  getActiveTasks(): FileTask[] {
    return Array.from(this.tasks.values()).filter(t => t.status === 'uploading' || t.status === 'pending');
  }

  clearAllTasks(): void {
    this.tasks.forEach((task, id) => {
      this.cancelTask(id);
    });
    this.tasks.clear();
    this.queue = [];
  }
}

export { FileService, ChunkedUploader, ChunkedDownloader };
export default FileService;
