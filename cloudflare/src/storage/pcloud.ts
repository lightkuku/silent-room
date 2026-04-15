/**
 * pCloud 存储适配器
 * Cloudflare Workers 版本
 */

export interface PCloudConfig {
  token: string;
  folderId: string;
  chatFilesFolderId?: string;
  chatAvatarFolderId?: string;
  chatBackupFolderId?: string;
  driveFilesFolderId?: string;
  driveBackupFolderId?: string;
}

export class PCloudStorage {
  private config: PCloudConfig;
  private token: string = '';
  private hosts = ['api.pcloud.com', 'eapi.pcloud.com'];

  constructor(config: PCloudConfig) {
    this.config = config;
  }

  private async getToken(): Promise<string> {
    if (this.token) return this.token;
    this.token = this.extractAccessToken(this.config.token);
    if (!this.token) throw new Error('请先配置 pCloud token');
    return this.token;
  }

  private extractAccessToken(token: string | undefined): string {
    if (!token) return '';
    
    if (typeof token === 'object') {
      const result = token.access_token || token.token || '';
      
      return result;
    }
    try {
      const parsed = JSON.parse(token);
      const result = parsed.access_token || parsed.token || parsed.accessToken || '';
      
      return result;
    } catch { 
      
      return token; 
    }
  }

  private getFolderId(pathType: string): string {
    const map: Record<string, string | undefined> = {
      'chat/files': this.config.chatFilesFolderId,
      'chat/avatar': this.config.chatAvatarFolderId,
      'chat/backup': this.config.chatBackupFolderId,
      'drive/files': this.config.driveFilesFolderId,
      'drive/backup': this.config.driveBackupFolderId,
    };
    return map[pathType] || this.config.folderId || '0';
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const token = await this.getToken();
    const headers = { 'Authorization': `Bearer ${token}`, ...options.headers };

    for (const host of this.hosts) {
      try {
        const res = await fetch(`https://${host}${path}`, { ...options, headers });
        const data = await res.json();

        if (data.result === 0) return data as T;
        if (data.result === 2094) throw new Error('token无效');
        if (data.result === 2004) throw new Error('2004');
        throw new Error(data.message || `错误: ${data.result}`);
      } catch (e: any) {
        if (e.message === '2004') throw e;
      }
    }
    throw new Error('所有host都失败');
  }

  async createFolder(name: string, parentId: string): Promise<string> {
    const listData = await this.request<any>(`/listfolder?folderid=${parentId}`);
    const contents = listData.contents || listData.metadata?.contents || [];

    const folder = contents.find((i: any) => i.name === name && i.isfolder);
    if (folder) return folder.folderid || folder.id;

    try {
      const createData = await this.request<any>(`/createfolder?folderid=${parentId}&name=${name}`);
      return createData.metadata?.folderid ?? createData.folderid;
    } catch (e: any) {
      if (e.message === '2004') {
        const retryData = await this.request<any>(`/listfolder?folderid=${parentId}`);
        const retryContents = retryData.contents || retryData.metadata?.contents || [];
        const existing = retryContents.find((i: any) => i.name === name && i.isfolder);
        if (existing) return existing.folderid || existing.id;
      }
      throw e;
    }
  }

  async upload(data: Uint8Array, fileName: string, contentType: string, pathType: string = 'drive/files'): Promise<{ fileId: string; url: string }> {
    const token = await this.getToken();
    const folderId = this.getFolderId(pathType);
    const headers = { 'Authorization': `Bearer ${token}` };

    for (const host of this.hosts) {
      try {
        const formData = new FormData();
        formData.append('file', new Blob([data.buffer], { type: contentType || 'application/octet-stream' }), fileName);

        const res = await fetch(`https://${host}/uploadfile?folderid=${folderId}`, { method: 'POST', headers, body: formData });
        const result = await res.json();

        if (result.result === 0 && result.metadata) {
          const fileId = result.metadata[0].fileid.toString();
          return { fileId, url: `pcloud://${fileId}` };
        }
        throw new Error(result.message || '上传失败');
      } catch (e: any) {
        // continue to next host
      }
    }
    throw new Error('上传失败');
  }

  async download(fileId: string): Promise<Uint8Array> {
    // 去掉 pcloud:// 前缀
    const actualFileId = fileId.replace(/^pcloud:\/\//, '');
    const token = await this.getToken();
    const headers = { 'Authorization': `Bearer ${token}` };

    // 重试机制：最多重试3次
    const maxRetries = 3;
    for (let retry = 0; retry < maxRetries; retry++) {
      try {
        // 先调用 getfilelink 获取临时下载链接
        for (const host of this.hosts) {
          const linkRes = await fetch(`https://${host}/getfilelink?fileid=${actualFileId}`, { headers });
          const linkData = await linkRes.json();
          
          if (linkData.result !== 0) {
            throw new Error(`getfilelink failed: ${linkData.error || linkData.result}`);
          }
          
          // 从返回的 hosts 和 path 构造下载链接
          const downloadHost = linkData.hosts?.[0];
          const downloadPath = linkData.path;
          if (!downloadHost || !downloadPath) {
            throw new Error('Invalid getfilelink response: missing hosts or path');
          }
          
          const downloadUrl = `https://${downloadHost}${downloadPath}`;
          
          // 立即下载（链接是临时的）
          const res = await fetch(downloadUrl);
          
          if (res.status === 410) {
            // 链接过期，重新获取
            break;
          }
          
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text.substring(0, 100)}`);
          }
          
          const arrayBuffer = await res.arrayBuffer();
          return new Uint8Array(arrayBuffer);
        }
      } catch (e: any) {
        // 如果不是 410 错误，直接抛出
        if (!e.message.includes('410')) {
          throw e;
        }
      }
      
      // 等待一下再重试
      if (retry < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    }
    
    throw new Error('下载失败：链接多次过期，请重试');
  }

  async delete(fileId: string): Promise<void> {
    const token = await this.getToken();
    const headers = { 'Authorization': `Bearer ${token}` };

    for (const host of this.hosts) {
      try {
        const res = await fetch(`https://${host}/deletefile?fileid=${fileId}`, { headers });
        const result = await res.json();
        if (result.result === 0) return;
        throw new Error(result.message || '删除失败');
      } catch (e: any) {
        // continue to next host
      }
    }
    throw new Error('删除失败');
  }
}
