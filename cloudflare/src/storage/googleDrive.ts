/**
 * Google Drive 存储适配器
 * Cloudflare Workers 版本
 */

export interface GoogleDriveConfig {
  token: string;
  folderId: string;
}

export class GoogleDriveStorage {
  private config: GoogleDriveConfig;

  constructor(config: GoogleDriveConfig) {
    this.config = config;
  }

  private extractAccessToken(token: string | undefined): string {
    if (!token) return '';
    if (typeof token === 'object') {
      return token.access_token || token.token || '';
    }
    try {
      const parsed = JSON.parse(token);
      return parsed.access_token || parsed.token || '';
    } catch {
      return token;
    }
  }

  private getFolderPath(pathType: string): string[] {
    switch (pathType) {
      case 'chat/files':
        return ['chat', 'files'];
      case 'chat/avatar':
        return ['chat', 'avatar'];
      case 'chat/backup':
        return ['chat', 'backup'];
      case 'drive/files':
        return ['drive', 'files'];
      case 'drive/backup':
        return ['drive', 'backup'];
      default:
        return pathType.split('/');
    }
  }

  private async getOrCreateFolder(folderName: string, parentId: string): Promise<string> {
    const cacheKey = `${parentId}/${folderName}`;
    
    const accessToken = this.extractAccessToken(this.config.token);

    // 先尝试查找文件夹
    const searchQuery = `name='${folderName}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    try {
      const searchResponse = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(searchQuery)}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const searchData = await searchResponse.json();
      
      if (searchData.files && searchData.files.length > 0) {
        const folderId = searchData.files[0].id;
        
        return folderId;
      }
    } catch (e) {
      
    }

    // 文件夹不存在，创建它
    try {
      const metadata = {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId]
      };

      const boundary = '-------314159265358979323846';
      const delimiter = `\r\n--${boundary}\r\n`;
      const closeDelimiter = `\r\n--${boundary}--`;
      const metadataStr = JSON.stringify(metadata);
      const body = delimiter +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        metadataStr +
        closeDelimiter;

      const createResponse = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': `multipart/related; boundary="${boundary}"`
        },
        body: new TextEncoder().encode(body)
      });

      const createData = await createResponse.json();
      
      if (createData.id) {
        
        return createData.id;
      } else {
        console.error('[Google Drive] 创建文件夹失败:', createData);
        throw new Error(createData.error?.message || '创建文件夹失败');
      }
    } catch (e) {
      console.error('[Google Drive] 创建文件夹异常:', e);
      throw e;
    }
  }

  private async getFolderId(pathType: string): Promise<string> {
    let parentId = this.config.folderId || 'root';
    const pathParts = this.getFolderPath(pathType);
    
    for (const part of pathParts) {
      parentId = await this.getOrCreateFolder(part, parentId);
    }
    
    return parentId;
  }

  async upload(data: Uint8Array, fileName: string, contentType: string, pathType: string = 'drive/files'): Promise<{ fileId: string; url: string }> {
    const accessToken = this.extractAccessToken(this.config.token);
    if (!accessToken) {
      throw new Error('请先配置 Google Drive token');
    }

    const folderId = await this.getFolderId(pathType);
    

    const metadata = {
      name: fileName,
      parents: [folderId]
    };

    const boundary = '-------314159265358979323846';
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    const metadataStr = JSON.stringify(metadata);
    const body = delimiter +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      metadataStr +
      delimiter +
      `Content-Type: ${contentType || 'application/octet-stream'}\r\n\r\n` +
      new TextDecoder('utf-8').decode(data) +
      closeDelimiter;

    const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary="${boundary}"`
      },
      body: new TextEncoder().encode(body)
    });

    const result = await response.json();

    if (result.error) {
      throw new Error(result.error.message || 'Google Drive 上传失败');
    }

    return {
      fileId: result.id,
      url: `googledrive://${result.id}`
    };
  }

  async download(fileId: string): Promise<Uint8Array> {
    // 去掉 googledrive:// 前缀
    const actualFileId = fileId.replace(/^googledrive:\/\//, '');
    const accessToken = this.extractAccessToken(this.config.token);
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${actualFileId}?alt=media`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Google Drive 下载失败: ${error}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  }

  async delete(fileId: string): Promise<void> {
    const accessToken = this.extractAccessToken(this.config.token);
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    if (!response.ok && response.status !== 204) {
      const error = await response.text();
      throw new Error(`Google Drive 删除失败: ${error}`);
    }
  }

  async getAccessToken(): Promise<string> {
    return this.extractAccessToken(this.config.token);
  }

  async createFolder(folderName: string, parentId: string): Promise<string> {
    const accessToken = this.extractAccessToken(this.config.token);

    // 先尝试查找文件夹
    const searchQuery = `name='${folderName}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    try {
      const searchResponse = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(searchQuery)}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const searchData = await searchResponse.json();
      
      if (searchData.files && searchData.files.length > 0) {
        const folderId = searchData.files[0].id;
        
        return folderId;
      }
    } catch (e) {
      
    }

    // 文件夹不存在，创建它
    try {
      const metadata = {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId]
      };

      const boundary = '-------314159265358979323846';
      const delimiter = `\r\n--${boundary}\r\n`;
      const closeDelimiter = `\r\n--${boundary}--`;
      const metadataStr = JSON.stringify(metadata);
      const body = delimiter +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        metadataStr +
        closeDelimiter;

      const createResponse = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': `multipart/related; boundary="${boundary}"`
        },
        body: new TextEncoder().encode(body)
      });

      const createData = await createResponse.json();
      
      if (createData.id) {
        
        return createData.id;
      }
      
      // 如果创建失败但错误是"已存在"，重新查找
      if (createData.error?.code === 403 || createData.error?.message?.includes('already exists')) {
        const retryResponse = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(searchQuery)}`, {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        const retryData = await retryResponse.json();
        if (retryData.files && retryData.files.length > 0) {
          return retryData.files[0].id;
        }
      }
      
      throw new Error(createData.error?.message || '创建文件夹失败');
    } catch (e: any) {
      // 如果是并发创建导致的错误，重新查找
      if (e.message?.includes('already exists') || e.message?.includes('duplicate')) {
        try {
          const retryResponse = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(searchQuery)}`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
          });
          const retryData = await retryResponse.json();
          if (retryData.files && retryData.files.length > 0) {
            return retryData.files[0].id;
          }
        } catch { }
      }
      console.error('[Google Drive] 创建文件夹异常:', e);
      throw e;
    }
  }
}
