/**
 * 网盘存储管理器
 * 根据设置动态选择存储后端
 */

import { PCloudStorage, PCloudConfig } from './pcloud';
import { GoogleDriveStorage, GoogleDriveConfig } from './googleDrive';

export interface StorageConfig {
  storageType: 'r2' | 'kv' | 'pcloud' | 'google';
  r2?: { bucket: string };
  kv?: { namespace: string };
  pcloud?: PCloudConfig & {
    chatFilesFolderId?: string;
    chatAvatarFolderId?: string;
    chatBackupFolderId?: string;
    driveFilesFolderId?: string;
    driveBackupFolderId?: string;
  };
  google?: GoogleDriveConfig & {
    chatFilesFolderId?: string;
    chatAvatarFolderId?: string;
    chatBackupFolderId?: string;
    driveFilesFolderId?: string;
    driveBackupFolderId?: string;
  };
}

export interface ChunkState {
  key: string;
  metadata: {
    filename: string;
    encryptedName: string;
    totalChunks: number;
    userId: string;
    createdAt: number;
    encrypted: boolean;
  };
  parts: { etag: string; partNumber: number }[];
  uploadedChunks: number[];
  status: 'uploading' | 'merging' | 'completed' | 'failed';
}

/* 网盘上传、下载 */
export class StorageManager {
  private config: StorageConfig;
  private r2: R2Bucket;
  private kv: KVNamespace;
  private prefix = 'drive/files';
  private pcloudStorage?: PCloudStorage;
  private googleDriveStorage?: GoogleDriveStorage;
  
  constructor(config: StorageConfig, r2: R2Bucket, kv: KVNamespace) {
    this.config = config;
    this.r2 = r2;
    this.kv = kv;

    if (config.pcloud?.token) {
      this.pcloudStorage = new PCloudStorage(config.pcloud);
    }
    if (config.google?.token) {
      this.googleDriveStorage = new GoogleDriveStorage(config.google);
    }
  }
  
  setPrefix(prefix: string) {
    this.prefix = prefix;
  }

  getStorageType(): string {
    return this.config.storageType;
  }

  async uploadFile(key: string, data: Uint8Array, contentType: string): Promise<string> {
    switch (this.config.storageType) {
      case 'r2':
        return this.uploadToR2(key, data, contentType);
      case 'kv':
        return this.uploadToKV(key, data);
      case 'pcloud':
        return this.uploadToPcloud(key, data);
      case 'google':
        return this.uploadToGoogleDrive(key, data);
      default:
        return this.uploadToR2(key, data, contentType);
    }
  }

  async downloadFile(key: string): Promise<{ data: Uint8Array; contentType: string } | null> {
    switch (this.config.storageType) {
      case 'r2':
        return this.downloadFromR2(key);
      case 'kv':
        return this.downloadFromKV(key);
      case 'pcloud':
        return this.downloadFromPcloud(key);
      case 'google':
        return this.downloadFromGoogleDrive(key);
      default:
        return this.downloadFromR2(key);
    }
  }

  async deleteFile(key: string): Promise<boolean> {
    switch (this.config.storageType) {
      case 'r2':
        return this.deleteFromR2(key);
      case 'kv':
        return this.deleteFromKV(key);
      case 'pcloud':
        return this.deleteFromPcloud(key);
      case 'google':
        return this.deleteFromGoogleDrive(key);
      default:
        return this.deleteFromR2(key);
    }
  }

  // 流式分片上传到 R2（不缓冲整个文件）
  async uploadChunk(key: string, chunkData: Uint8Array, options?: { contentType?: string }): Promise<{ etag: string }> {
    const fullKey = `${this.prefix}/${key}`;
    
    const obj = await this.r2.put(fullKey, chunkData, {
      httpMetadata: options?.contentType ? { contentType: options.contentType } : undefined
    });
    
    return { etag: obj.etag || '' };
  }

  // 检查 R2 对象是否存在
  async checkR2Object(key: string): Promise<boolean> {
    try {
      const fullKey = `${this.prefix}/${key}`;
      const obj = await this.r2.head(fullKey);
      return !!obj;
    } catch {
      return false;
    }
  }

  // 删除 R2 对象
  async deleteR2Object(key: string): Promise<void> {
    const fullKey = `${this.prefix}/${key}`;
    await this.r2.delete(fullKey);
  }

  // 直接上传到 R2（分片专用，不经过 prefix）
  async uploadChunkDirect(key: string, data: Uint8Array): Promise<{ etag: string }> {
    const obj = await this.r2.put(key, data, {
      httpMetadata: { contentType: 'application/octet-stream' }
    });
    return { etag: obj.etag || '' };
  }

  // 直接从 R2 下载（分片专用，不经过 prefix）
  async downloadChunkDirect(key: string): Promise<{ data: Uint8Array; contentType: string } | null> {
    const obj = await this.r2.get(key);
    if (!obj) return null;
    const data = await obj.arrayBuffer();
    return {
      data: new Uint8Array(data),
      contentType: obj.httpMetadata?.contentType || 'application/octet-stream'
    };
  }

  // 直接删除 R2 对象（分片专用，不经过 prefix）
  async deleteChunkDirect(key: string): Promise<void> {
    await this.r2.delete(key);
  }

  // KV 分片状态管理
  async saveChunkState(uploadId: string, state: ChunkState): Promise<void> {
    await this.kv.put(`chunk:${uploadId}`, JSON.stringify(state), { expirationTtl: 3600 * 24 });
  }
  
  async getChunkState(uploadId: string): Promise<ChunkState | null> {
    const data = await this.kv.get(`chunk:${uploadId}`, 'text');
    if (!data) return null;
    return JSON.parse(data);
  }
  
  async deleteChunkState(uploadId: string): Promise<void> {
    await this.kv.delete(`chunk:${uploadId}`);
  }

  // 分片单独状态管理（用于解决 KV 并发覆盖问题）
  async markChunkUploaded(uploadId: string, chunkIndex: number, etag: string): Promise<boolean> {
    const key = `chunk:${uploadId}:${chunkIndex}`;
    const existing = await this.kv.get(key, 'text');
    if (existing) {
      return false; // 已存在，跳过
    }
    await this.kv.put(key, JSON.stringify({ etag, uploadedAt: Date.now() }), { expirationTtl: 3600 * 24 });
    return true;
  }

  async isChunkUploaded(uploadId: string, chunkIndex: number): Promise<boolean> {
    const key = `chunk:${uploadId}:${chunkIndex}`;
    const data = await this.kv.get(key, 'text');
    return !!data;
  }

  async getUploadedChunks(uploadId: string, totalChunks: number): Promise<number[]> {
    const uploaded: number[] = [];
    for (let i = 0; i < totalChunks; i++) {
      if (await this.isChunkUploaded(uploadId, i)) {
        uploaded.push(i);
      }
    }
    return uploaded;
  }

  async deleteChunkMarker(uploadId: string, chunkIndex: number): Promise<void> {
    await this.kv.delete(`chunk:${uploadId}:${chunkIndex}`);
  }

  // R2 存储
  private async uploadToR2(key: string, data: Uint8Array, contentType: string): Promise<string> {
    const fullKey = `${this.prefix}/${key}`;
    
    await this.r2.put(fullKey, data, {
      httpMetadata: { contentType }
    });
    return key;
  }

  private async downloadFromR2(key: string): Promise<{ data: Uint8Array; contentType: string } | null> {
    const fullKey = `${this.prefix}/${key}`;
    const obj = await this.r2.get(fullKey);
    if (!obj) return null;
    const data = await obj.arrayBuffer();
    return {
      data: new Uint8Array(data),
      contentType: obj.httpMetadata?.contentType || 'application/octet-stream'
    };
  }

  private async deleteFromR2(key: string): Promise<boolean> {
    const fullKey = `${this.prefix}/${key}`;
    await this.r2.delete(fullKey);
    return true;
  }

  // KV 存储
  private async uploadToKV(key: string, data: Uint8Array): Promise<string> {
    const fullKey = `${this.prefix}/${key}`;
    await this.kv.put(fullKey, data);
    return key;
  }

  private async downloadFromKV(key: string): Promise<{ data: Uint8Array; contentType: string } | null> {
    const fullKey = `${this.prefix}/${key}`;
    const data = await this.kv.get(fullKey, 'arrayBuffer');
    if (!data) return null;
    return {
      data: new Uint8Array(data),
      contentType: 'application/octet-stream'
    };
  }

  private async deleteFromKV(key: string): Promise<boolean> {
    const fullKey = `${this.prefix}/${key}`;
    await this.kv.delete(fullKey);
    return true;
  }

  // pCloud 存储
  private async uploadToPcloud(key: string, data: Uint8Array): Promise<string> {
    if (!this.pcloudStorage) {
      throw new Error('pCloud未配置');
    }
    const fileName = key.split('/').pop() || 'file';
    const result = await this.pcloudStorage.upload(data, fileName, 'application/octet-stream', this.prefix);
    return result.fileId;
  }

  private async downloadFromPcloud(fileId: string): Promise<{ data: Uint8Array; contentType: string } | null> {
    if (!this.pcloudStorage) {
      throw new Error('pCloud未配置');
    }
    const data = await this.pcloudStorage.download(fileId);
    return { data, contentType: 'application/octet-stream' };
  }

  private async deleteFromPcloud(fileId: string): Promise<boolean> {
    if (!this.pcloudStorage) {
      throw new Error('pCloud未配置');
    }
    await this.pcloudStorage.delete(fileId);
    return true;
  }

  // Google Drive 存储
  private async uploadToGoogleDrive(key: string, data: Uint8Array): Promise<string> {
    if (!this.googleDriveStorage) {
      throw new Error('Google Drive未配置');
    }
    const fileName = key.split('/').pop() || 'file';
    const result = await this.googleDriveStorage.upload(data, fileName, 'application/octet-stream', this.prefix);
    return result.fileId;
  }

  private async downloadFromGoogleDrive(fileId: string): Promise<{ data: Uint8Array; contentType: string } | null> {
    if (!this.googleDriveStorage) {
      throw new Error('Google Drive未配置');
    }
    const data = await this.googleDriveStorage.download(fileId);
    return { data, contentType: 'application/octet-stream' };
  }

  private async deleteFromGoogleDrive(fileId: string): Promise<boolean> {
    if (!this.googleDriveStorage) {
      throw new Error('Google Drive未配置');
    }
    await this.googleDriveStorage.delete(fileId);
    return true;
  }
}
