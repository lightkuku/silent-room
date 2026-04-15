import { StorageManager, StorageConfig, ChunkState } from './storage/manager';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';
import { eq, and, desc, sql, like, or } from 'drizzle-orm';

export class FileManager {
	constructor(prefix, db?: ReturnType<typeof drizzle>, r2?: ReturnType<typeof object>, kv?: ReturnType<typeof object> ) {
		this.db = db || null;
		this.r2 = r2 || null;
		this.kv = kv || null;
		this.prefix = prefix || 'drive/files';
		this.settings = null;
		this.storageManager = null;
	}

	init(db, r2, kv) {
	    this.db = db;
	    this.r2 = r2;
	    this.kv = kv;
	    this.settings = this.loadDriveSettings();
	    this.storageManager = new StorageManager(this.settings, this.r2, this.kv);
	    this.storageManager.setPrefix(this.prefix);
	}
	
	// 异步初始化
	async initAsync(db, r2, kv) {
	    this.db = db;
	    this.r2 = r2;
	    this.kv = kv;
	    try {
	        this.settings = await this.loadDriveSettings();
	    } catch (e) {
	        console.error('Failed to load drive settings:', e);
	        this.settings = { storageType: 'r2' };
	    }
	    this.storageManager = new StorageManager(this.settings, this.r2, this.kv);
	    this.storageManager.setPrefix(this.prefix);
	}
	
	limit(settings) {
        if (!settings) return;
        if (settings.storageType === 'kv') {
            // 使用KV存储
            if (uint8Array.length > (25 * 1024 * 1024)) {
                throw new Error('KV存储不支持超过 25MB 的文件');
            }
        }
	}
	
	setPrefix(prefix) {
	    this.storageManager.setPrefix(prefix);
	}

	// ==================== 辅助函数 ====================
	// 从数据库中加载网盘设置
	async loadDriveSettings(): Promise<StorageConfig> {
	  try {
		const storageTypeRow = await this.db.select({ value: schema.system_settings.value })
		  .from(schema.system_settings)
		  .where(eq(schema.system_settings.key, 'storageType'))
		  .get();
		const pcloudRow = await this.db.select({ value: schema.system_settings.value })
		  .from(schema.system_settings)
		  .where(eq(schema.system_settings.key, 'pcloud'))
		  .get();
		const googleRow = await this.db.select({ value: schema.system_settings.value })
		  .from(schema.system_settings)
		  .where(eq(schema.system_settings.key, 'google'))
		  .get();
		const pcloudFolderIdsRow = await this.db.select({ value: schema.system_settings.value })
		  .from(schema.system_settings)
		  .where(eq(schema.system_settings.key, 'pcloud_folder_ids'))
		  .get();
		const googleFolderIdsRow = await this.db.select({ value: schema.system_settings.value })
		  .from(schema.system_settings)
		  .where(eq(schema.system_settings.key, 'google_folder_ids'))
		  .get();
		
		const settings: StorageConfig = { storageType: 'r2' };
		
		if (storageTypeRow?.value) settings.storageType = storageTypeRow.value as StorageConfig['storageType'];
		
		if (pcloudRow?.value) {
		  try { 
		    let parsed: any;
		    // 如果是 JSON 字符串，先解析
		    if (typeof pcloudRow.value === 'string' && pcloudRow.value.startsWith('{')) {
		      parsed = JSON.parse(pcloudRow.value);
		    } else {
		      parsed = pcloudRow.value;
		    }
		    // parsed 可能是对象或已经是提取后的值
		    if (typeof parsed === 'object' && parsed !== null) {
		      // token 可能是普通字符串，也可能是 JSON 字符串
		      let tokenValue = parsed.token || '';
		      if (typeof tokenValue === 'string' && tokenValue.startsWith('{')) {
		        try {
		          const tokenParsed = JSON.parse(tokenValue);
		          tokenValue = tokenParsed.access_token || tokenParsed.token || '';
		        } catch {}
		      }
		      settings.pcloud = { 
		        token: tokenValue, 
		        folderId: parsed.folderId || '0' 
		      };
		    } else {
		      // 已经是字符串
		      settings.pcloud = { 
		        token: String(parsed), 
		        folderId: '0' 
		      };
		    }
		  } catch (e) {
		    console.error('解析 pcloud 设置失败:', e);
		  }
		}
		
		if (googleRow?.value) {
		  try { 
		    let parsed: any;
		    if (typeof googleRow.value === 'string' && googleRow.value.startsWith('{')) {
		      parsed = JSON.parse(googleRow.value);
		    } else {
		      parsed = googleRow.value;
		    }
		    // token 可能是普通字符串，也可能是 JSON 字符串
		    let tokenValue = parsed.token || parsed.access_token || '';
		    if (typeof tokenValue === 'string' && tokenValue.startsWith('{')) {
		      try {
		        const tokenParsed = JSON.parse(tokenValue);
		        tokenValue = tokenParsed.access_token || tokenParsed.token || '';
		      } catch {}
		    }
		    settings.google = { 
		      token: tokenValue, 
		      folderId: parsed.folderId || 'root' 
		    };
		  } catch {}
		}
		
		if (pcloudFolderIdsRow?.value) {
		  try {
		    const folderIds = JSON.parse(pcloudFolderIdsRow.value);
		    if (settings.pcloud) {
		      settings.pcloud.chatFilesFolderId = folderIds.chatFilesFolderId;
		      settings.pcloud.chatAvatarFolderId = folderIds.chatAvatarFolderId;
		      settings.pcloud.chatBackupFolderId = folderIds.chatBackupFolderId;
		      settings.pcloud.driveFilesFolderId = folderIds.driveFilesFolderId;
		      settings.pcloud.driveBackupFolderId = folderIds.driveBackupFolderId;
		    }
		  } catch {}
		}
		
		if (googleFolderIdsRow?.value) {
		  try {
		    const folderIds = JSON.parse(googleFolderIdsRow.value);
		    if (settings.google) {
		      settings.google.chatFilesFolderId = folderIds.chatFilesFolderId;
		      settings.google.chatAvatarFolderId = folderIds.chatAvatarFolderId;
		      settings.google.chatBackupFolderId = folderIds.chatBackupFolderId;
		      settings.google.driveFilesFolderId = folderIds.driveFilesFolderId;
		      settings.google.driveBackupFolderId = folderIds.driveBackupFolderId;
		    }
		  } catch {}
		}
		return settings;
	  } catch (e) {
		console.error('加载网盘设置失败:', e);
	  }
	  // 默认加载R2
	  return { storageType: 'r2' };
	}

	async uploadToStorage(key: string, data: Uint8Array, contentType: string): Promise<string> {
	  this.limit(this.settings);

	  return await this.storageManager.uploadFile(key, data, contentType);
	}

	async downloadFromStorage(key: string): Promise<Uint8Array> {
	  if (!key) throw new Error('文件路径为空');

	  const result = await this.storageManager.downloadFile(key);
	  if (!result || !result.data || result.data.length === 0) {
		throw new Error('文件不存在或为空');
	  }
	  return result.data;
	}

	async deleteFromStorage(key: string): Promise<boolean> {
	  return await this.storageManager.deleteFile(key);
	}

	// 分片上传状态管理
	async saveChunkState(uploadId: string, state: ChunkState): Promise<void> {
	  await this.storageManager.saveChunkState(uploadId, state);
	}
	
	async getChunkState(uploadId: string): Promise<ChunkState | null> {
	  return await this.storageManager.getChunkState(uploadId);
	}
	
	async deleteChunkState(uploadId: string): Promise<void> {
	  await this.storageManager.deleteChunkState(uploadId);
	}

	// 分片单独状态管理（用于解决 KV 并发覆盖问题）
	async markChunkUploaded(uploadId: string, chunkIndex: number, etag: string): Promise<boolean> {
	  return await this.storageManager.markChunkUploaded(uploadId, chunkIndex, etag);
	}

	async isChunkUploaded(uploadId: string, chunkIndex: number): Promise<boolean> {
	  return await this.storageManager.isChunkUploaded(uploadId, chunkIndex);
	}

	async getUploadedChunks(uploadId: string, totalChunks: number): Promise<number[]> {
	  return await this.storageManager.getUploadedChunks(uploadId, totalChunks);
	}

	async deleteChunkMarker(uploadId: string, chunkIndex: number): Promise<void> {
	  await this.storageManager.deleteChunkMarker(uploadId, chunkIndex);
	}

	// 上传分片
	async uploadChunk(key: string, chunkData: Uint8Array, options?: { contentType?: string }): Promise<{ etag: string }> {
	  return await this.storageManager.uploadChunk(key, chunkData, options);
	}

	// 直接上传分片到 R2（分片专用，不经过 prefix）
	async uploadChunkDirect(key: string, chunkData: Uint8Array): Promise<{ etag: string }> {
	  return await this.storageManager.uploadChunkDirect(key, chunkData);
	}

	// 直接从 R2 下载分片（分片专用，不经过 prefix）
	async downloadChunkDirect(key: string): Promise<{ data: Uint8Array; contentType: string } | null> {
	  return await this.storageManager.downloadChunkDirect(key);
	}

	// 直接删除 R2 分片（分片专用，不经过 prefix）
	async deleteChunkDirect(key: string): Promise<void> {
	  return await this.storageManager.deleteChunkDirect(key);
	}

	// 下载文件
	async downloadFile(key: string): Promise<{ data: Uint8Array; contentType: string } | null> {
	  return await this.storageManager.downloadFile(key);
	}

	// 获取存储类型
	getStorageType(): string {
	  return this.storageManager.getStorageType();
	}
}
