import API from '../config/api';
import { decrypt, decryptWithKeys, decryptFileChunkedWithKeysYield, loadKeysFromStorage } from '../utils/crypto';
import { decryptFileChunkedAsync, decryptFileChunkedWithKeysAsync } from '../utils/cryptoAsync';
import { getCsrfToken, setCsrfToken } from '../utils/csrf';

function getToken() {
  return localStorage.getItem('token');
}

function setToken(token: string) {
  localStorage.setItem('token', token);
}

function removeToken() {
  localStorage.removeItem('token');
}

async function request<T>(endpoint: string, options: RequestInit = {}, retries = 2): Promise<T> {
  const token = getToken();
  const csrfToken = getCsrfToken();
  
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.headers as Record<string, string>,
  };
  
  // 添加 Authorization header
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  
  // 确定是否需要 CSRF token
  const method = (options.method || 'GET').toUpperCase();
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && csrfToken) {
    headers['X-CSRF-Token'] = csrfToken;
  }
  
  const config: RequestInit = {
    ...options,
    headers,
    credentials: 'include',
  };

  const response = await fetch(endpoint, config);
  
  // CSRF token 过期时自动刷新并重试
  if (response.status === 403 && retries > 0) {
    try {
      const data = await response.clone().json();
      if (data.message && (
        data.message.includes('CSRF') || 
        data.message.includes('token') ||
        data.message.includes('无效') ||
        data.message.includes('过期')
      )) {
        // console.log('[CSRF] Token expired, refreshing...');
        
        // 导入刷新函数（动态导入避免循环依赖）
        const { refreshCsrfToken } = await import('../utils/csrf');
        const newCsrfToken = await refreshCsrfToken();
        
        if (newCsrfToken) {
          // 使用新 token 重试
          headers['X-CSRF-Token'] = newCsrfToken;
          config.headers = headers;
          
          const retryResponse = await fetch(endpoint, config);
          const retryData = await retryResponse.json();
          
          if (!retryResponse.ok) {
            throw new Error(retryData.message || '请求失败');
          }
          
          return retryData;
        }
      }
    } catch (e) {
      // 忽略 JSON 解析错误，继续处理
      console.error('[CSRF] Retry failed:', e);
    }
  }
  
  const data = await response.json();
  
  if (!response.ok) {
    throw new Error(data.message || '请求失败');
  }
  
  return data;
}

export const auth = {
  async login(username: string, password: string) {
    const data = await request<{ success: boolean; data: { token: string; csrfToken?: string; user: any } }>(API.auth.login, {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    
    if (data.success) {
      setToken(data.data.token);
      localStorage.setItem('user', JSON.stringify(data.data.user));
      // 保存 CSRF token
      if (data.data.csrfToken) {
        setCsrfToken(data.data.csrfToken);
      }
      // 获取用户通知设置
      this.getNotificationSettings();
    }
    
    return data;
  },
  
  async register(name: string, username: string, password: string) {
    const data = await request<{ success: boolean; data: { token: string; csrfToken?: string; user: any } }>(API.auth.register, {
      method: 'POST',
      body: JSON.stringify({ name, username, password }),
    });
    
    if (data.success) {
      setToken(data.data.token);
      localStorage.setItem('user', JSON.stringify(data.data.user));
      // 保存 CSRF token
      if (data.data.csrfToken) {
        setCsrfToken(data.data.csrfToken);
      }
      // 获取用户通知设置
      this.getNotificationSettings();
    }
    
    return data;
  },
  
  async logout() {
    try {
      await request<{ success: boolean }>(API.auth.logout, { method: 'POST' });
    } finally {
      removeToken();
      localStorage.removeItem('user');
      localStorage.removeItem('notificationSettings');
      sessionStorage.removeItem('csrfToken');
    }
  },
  
  async getCurrentUser() {
    return request<{ success: boolean; data: any }>(API.user.info);
  },
  
  async getNotificationSettings() {
    try {
      const data = await request<{ success: boolean; data: any }>(API.user.settings);
      if (data.success && data.data) {
        localStorage.setItem('notificationSettings', JSON.stringify(data.data));
      }
    } catch (e) {
      // 使用默认设置
      localStorage.setItem('notificationSettings', JSON.stringify({
        messageSound: true,
        groupMention: true,
        onlineNotify: true,
        offlineNotify: false
      }));
    }
  },
  
  async saveNotificationSettings(settings: any) {
    try {
      const data = await request<{ success: boolean }>(API.user.settings, {
        method: 'PUT',
        body: JSON.stringify(settings)
      });
      if (data.success) {
        localStorage.setItem('notificationSettings', JSON.stringify(settings));
      }
      return data;
    } catch (e) {
      console.error('保存通知设置失败:', e);
      return { success: false, message: e instanceof Error ? e.message : '保存失败' };
    }
  },

  async saveAppSettings(settings: any) {
    try {
      const data = await request<{ success: boolean }>(API.user.settings, {
        method: 'PUT',
        body: JSON.stringify(settings)
      });
      return data;
    } catch (e) {
      console.error('保存应用设置失败:', e);
      return { success: false, message: e instanceof Error ? e.message : '保存失败' };
    }
  }
};

export const user = {
  async getInfo() {
    return request<{ success: boolean; data: any }>(API.user.info);
  },
  
  async updateInfo(data: { name?: string; avatar?: string; signature?: string }) {
    return request<{ success: boolean; data: any }>(API.user.info, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },
  
  async getFriends() {
    return request<{ success: boolean; data: any[] }>(API.user.friends);
  },
  
  async addFriend(friendId: string) {
    return request<{ success: boolean; data: any }>(API.user.friends, {
      method: 'POST',
      body: JSON.stringify({ friendId }),
    });
  },
  
  async searchUsers(query: string) {
    return request<{ success: boolean; data: any[] }>(`${API.user.search}?q=${encodeURIComponent(query)}`);
  },
  
  async getAllUsers() {
    return request<{ success: boolean; data: any[] }>(API.user.all);
  },
  
  async uploadAvatar(file: File, onProgress?: (progress: number) => void) {
    const token = getToken();
    const formData = new FormData();
    formData.append('avatar', file);
    
    return new Promise<{ success: boolean; data: any }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      });
      
      xhr.addEventListener('load', () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300 && data.success) {
            resolve(data);
          } else {
            reject(new Error(data.message || '上传失败'));
          }
        } catch {
          reject(new Error('解析响应失败'));
        }
      });
      
      xhr.addEventListener('error', () => reject(new Error('上传失败')));
      xhr.addEventListener('abort', () => reject(new Error('上传已取消')));
      
      xhr.open('POST', API.user.avatar);
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.send(formData);
    });
  },
  
  async deleteAvatar(filename: string) {
    return request<{ success: boolean }>(`${API.user.avatar}/${encodeURIComponent(filename)}`, { method: 'DELETE' });
  },
};

export const conversation = {
  async getList() {
    return request<{ success: boolean; data: any[] }>(API.conversations.list);
  },
  
  async getMessages(sessionId: string, page = 1, limit = 50) {
    return request<{ success: boolean; data: any[] }>(
      `${API.conversations.messages(sessionId)}?page=${page}&limit=${limit}`
    );
  },
  
  async markAsRead(sessionId: string) {
    return request<{ success: boolean }>(API.conversations.read(sessionId), { method: 'POST' });
  },
  
  async clearHistory(sessionId: string) {
    return request<{ success: boolean }>(API.conversations.clearHistory(sessionId), { method: 'DELETE' });
  },
  
  async exportHistory(sessionId: string, page = 1, limit = 100) {
    return request<{ success: boolean; data: any }>(
      `${API.conversations.exportHistory(sessionId)}?page=${page}&limit=${limit}`
    );
  },
  
  async pinConversation(convId: string, isPinned: boolean) {
    return request<{ success: boolean }>(API.conversations.pin(convId), {
      method: 'POST',
      body: JSON.stringify({ isPinned }),
    });
  },
  
  async muteConversation(convId: string, isMuted: boolean) {
    return request<{ success: boolean }>(API.conversations.mute(convId), {
      method: 'POST',
      body: JSON.stringify({ isMuted }),
    });
  },
};

export const group = {
  async create(name: string, memberIds: string[]) {
    return request<{ success: boolean; data: any }>(API.groups.list, {
      method: 'POST',
      body: JSON.stringify({ name, memberIds }),
    });
  },
  
  async getInfo(groupId: string) {
    return request<{ success: boolean; data: any }>(API.groups.info(groupId));
  },
  
  async getMembers(groupId: string) {
    return request<{ success: boolean; data: any[] }>(API.groups.members(groupId));
  },
  
  async updateAnnouncement(groupId: string, announcement: string) {
    return request<{ success: boolean }>(API.groups.announcement(groupId), {
      method: 'PUT',
      body: JSON.stringify({ announcement }),
    });
  },
  
  async addMember(groupId: string, memberId: string) {
    return request<{ success: boolean }>(API.groups.members(groupId), {
      method: 'POST',
      body: JSON.stringify({ memberId }),
    });
  },
  
  async leave(groupId: string, memberId: string) {
    return request<{ success: boolean }>(`${API.groups.members(groupId)}/${memberId}`, {
      method: 'DELETE',
    });
  },
  
  async getJoinRequests(groupId: string) {
    return request<{ success: boolean; data: any[] }>(API.groups.joinRequests(groupId));
  },
  
  async getMyJoinRequests() {
    return request<{ success: boolean; data: any[] }>(API.groups.myJoinRequests);
  },
  
  async getOwnedJoinRequests() {
    return request<{ success: boolean; data: any[]; groupIds: string[] }>(API.groups.ownedJoinRequests);
  },
  
  async approveJoinRequest(groupId: string, requestId: string) {
    return request<{ success: boolean }>(`${API.groups.joinRequests(groupId)}/${requestId}/approve`, {
      method: 'POST',
    });
  },
  
  async rejectJoinRequest(groupId: string, requestId: string) {
    return request<{ success: boolean }>(`${API.groups.joinRequests(groupId)}/${requestId}/reject`, {
      method: 'POST',
    });
  },
  
  async updateApprovalSetting(groupId: string, requireApproval: boolean) {
    return request<{ success: boolean }>(API.groups.settingsApproval(groupId), {
      method: 'PUT',
      body: JSON.stringify({ requireApproval }),
    });
  },
  
  async removeMember(groupId: string, memberId: string) {
    return request<{ success: boolean }>(`${API.groups.members(groupId)}/${memberId}`, {
      method: 'DELETE',
    });
  },
  
  async joinGroup(groupId: string) {
    return request<{ success: boolean }>(API.groups.join(groupId), { method: 'POST' });
  },
  
  async getMuteStatus(groupId: string) {
    return request<{ success: boolean; data: any }>(API.groups.muteStatus(groupId));
  },
  
  async getMutes(groupId: string) {
    return request<{ success: boolean; data: any[] }>(API.groups.mutes(groupId));
  },
  
  async removeMuteRecord(groupId: string, recordId: string) {
    return request<{ success: boolean }>(API.groups.muteRecord(groupId, recordId), { method: 'DELETE' });
  },
  
  async searchGroups(query: string) {
    return request<{ success: boolean; data: any[] }>(`${API.groups.search}?q=${encodeURIComponent(query)}`);
  },
  
  async getOwners(groupId: string) {
    return request<{ success: boolean; data: any[] }>(API.groups.owners(groupId));
  },
  
  async addOwner(groupId: string, userId: string) {
    return request<{ success: boolean }>(API.groups.owners(groupId), {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
  },
  
  async removeOwner(groupId: string, userId: string) {
    return request<{ success: boolean }>(`${API.groups.owners(groupId)}/${userId}`, { method: 'DELETE' });
  },
};

export const message = {
  async recall(messageId: string) {
    return request<{ success: boolean }>(API.messages.recall(messageId), { method: 'POST' });
  },
  
  async delete(messageId: string) {
    return request<{ success: boolean }>(API.messages.delete(messageId), { method: 'DELETE' });
  },
  
  async batchDelete(messageIds: string[]) {
    return request<{ success: boolean }>(API.messages.batch, {
      method: 'DELETE',
      body: JSON.stringify({ messageIds }),
    });
  },
};

export const upload = {
  async delete(fileId: string) {
    return request<{ success: boolean }>(API.uploadDelete, {
      method: 'POST',
      body: JSON.stringify({ fileId }),
    });
  },
};

export const ocr = {
  async handwriting(imageData: string) {
    const token = getToken();
    const formData = new FormData();
    formData.append('image', imageData);
    
    const response = await fetch(API.ocr.handwriting, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });
    
    return response.json();
  },
};

export const stats = {
  async login(days: number) {
    return request<{ success: boolean; data: any }>(API.stats.login(days));
  },
  
  async chat(days: number) {
    return request<{ success: boolean; data: any }>(API.stats.chat(days));
  },
};

export const ai = {
  async chat(messages: any[], systemPrompt?: string) {
    const token = getToken();
    const csrfToken = getCsrfToken();
    const response = await fetch(API.ai.chat, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(csrfToken && { 'X-CSRF-Token': csrfToken }),
      },
      body: JSON.stringify({ messages, systemPrompt }),
    });
    return response.json();
  },
  
  async vision(imageUrl: string, question?: string) {
    const token = getToken();
    const csrfToken = getCsrfToken();
    const response = await fetch(API.ai.vision, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(csrfToken && { 'X-CSRF-Token': csrfToken }),
      },
      body: JSON.stringify({ imageUrl, question }),
    });
    return response.json();
  },
};

export const site = {
  async getConfig() {
    const response = await fetch(API.site.config);
    return response.json();
  },
};

export const drive = {
  async getStorage() {
    return request<{ success: boolean; data: { used: number; limit: number; available: number } }>(
      `${API.baseUrl}/api/drive/storage`
    );
  },

  async getFiles(parentId: string | null, view: string = 'my') {
    const params = new URLSearchParams();
    if (parentId) params.set('parentId', parentId);
    if (view) params.set('view', view);
    return request<{ success: boolean; data: any[] }>(
      `${API.baseUrl}/api/drive/files?${params.toString()}`
    );
  },

  async getFilesById(id: string) {
    return request<{ success: boolean; data: any[] }>(
      `${API.baseUrl}/api/drive/files/${id}`
    );
  },

  async getShareOptions() {
    return request<{ success: boolean; data: { users: any[]; groups: any[] } }>(
      `${API.baseUrl}/api/drive/share-options`
    );
  },

  async createFolder(name: string, parentId: string | null, isEncrypted: boolean = false) {
    return request<{ success: boolean; data: any }>(
      `${API.baseUrl}/api/drive/folder`,
      {
        method: 'POST',
        body: JSON.stringify({ name, parentId, isEncrypted }),
      }
    );
  },

  async shareFile(
    id: string,
    share: boolean,
    permission: string,
    shareToUsers: string[],
    shareToGroups: string[]
  ) {
    return request<{ success: boolean; data: any }>(
      `${API.baseUrl}/api/drive/files/${id}/share`,
      {
        method: 'POST',
        body: JSON.stringify({ share, permission, shareToUsers, shareToGroups }),
      }
    );
  },

  async renameFile(id: string, name: string) {
    return request<{ success: boolean }>(
      `${API.baseUrl}/api/drive/files/${id}/rename`,
      {
        method: 'POST',
        body: JSON.stringify({ name }),
      }
    );
  },

  async sharedRename(token: string, id: string, name: string) {
    return request<{ success: boolean }>(
      `${API.baseUrl}/api/drive/shared/${token}/rename`,
      {
        method: 'POST',
        body: JSON.stringify({ id, name }),
      }
    );
  },

  async moveFile(id: string, parentId: string) {
    return request<{ success: boolean }>(
      `${API.baseUrl}/api/drive/files/${id}/move`,
      {
        method: 'POST',
        body: JSON.stringify({ parentId }),
      }
    );
  },

  async deleteFile(id: string) {
    return request<{ success: boolean }>(
      `${API.baseUrl}/api/drive/files/${id}`,
      {
        method: 'DELETE',
      }
    );
  },

  async restoreFile(id: string) {
    return request<{ success: boolean }>(
      `${API.baseUrl}/api/drive/files/${id}/restore`,
      {
        method: 'POST',
      }
    );
  },

  async permanentDelete(id: string) {
    return request<{ success: boolean }>(
      `${API.baseUrl}/api/drive/files/${id}/permanent`,
      {
        method: 'DELETE',
      }
    );
  },

  async downloadFile(id: string, onProgress?: (progress: number, loaded?: number, total?: number) => void, fileName?: string, isEncrypted?: boolean, keys?: { currentKey?: string; legacyKeys?: string[] }, abortSignal?: AbortSignal) {
    const token = getToken();
    const response = await fetch(`${API.baseUrl}/api/drive/files/${id}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: abortSignal
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.message || '下载失败');
    }

    const contentType = response.headers.get('Content-Type');
    
    // 如果是 JSON 格式，说明是文件夹下载（返回URL列表）
    if (contentType?.includes('application/json')) {
      const data = await response.json();
      if (data.success && data.data && data.data.files) {
        // 处理文件夹下载
        let { folderName, files } = data.data;
        const JSZip = (await import('jszip')).default;
        const zip = new JSZip();
        
        // 解密文件夹名称
        if (folderName?.startsWith('U2FsdGVkX') && keys) {
          const decryptResult = decryptWithKeys(folderName, keys as any);
          if (decryptResult.result) {
            folderName = decryptResult.result;
          }
        }
        
        // 计算总大小用于进度显示
        const totalSize = files.reduce((sum: number, f: any) => sum + (f.size || 0), 0);
        let downloadedSize = 0;
        
        // 逐个下载文件
        for (let i = 0; i < files.length; i++) {
          const fileInfo = files[i];
          const { fileId, name, path, size, isEncrypted } = fileInfo;
          
          try {
            // 获取文件内容
            const fileResponse = await fetch(`${API.baseUrl}/api/drive/files/${fileId}/download`, {
              headers: token ? { Authorization: `Bearer ${token}` } : {},
              signal: abortSignal
            });
            
            if (!fileResponse.ok) {
              console.error('下载文件失败:', name);
              continue;
            }
            
            const fileBlob = await fileResponse.blob();
            let finalBytes = new Uint8Array(await fileBlob.arrayBuffer());
            
            // 解密文件名
            let finalPath = path || name;
            if (name?.startsWith('U2FsdGVkX') && keys) {
              const decryptResult = decryptWithKeys(name, keys as any);
              if (decryptResult.result) {
                finalPath = decryptResult.result + (path?.substring(name.length) || '');
              }
            }
            
            // 如果文件是加密的，需要解密
            if (isEncrypted === 1 && keys?.currentKey) {
              try {
                const encryptedBlob = new Blob([finalBytes]);
                const { blob: decryptedBlob } = await decryptFileChunkedWithKeysYield(encryptedBlob, keys as any);
                finalBytes = new Uint8Array(await decryptedBlob.arrayBuffer());
              } catch (e) {
                console.error('解密文件失败:', name, e);
              }
            }
            
            // 添加到 zip
            zip.file(finalPath, finalBytes);
            downloadedSize += size || 0;
            
            if (onProgress && totalSize > 0) {
              onProgress(Math.round((downloadedSize / totalSize) * 100), downloadedSize, totalSize);
            }
          } catch (error) {
            console.error('处理文件失败:', name, error);
          }
        }
        
        // 生成 zip 文件并下载
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        const blobUrl = window.URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = `${folderName || 'folder'}.zip`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(blobUrl);
        document.body.removeChild(a);
        
        return { success: true, filename: `${folderName || 'folder'}.zip` };
      }
      throw new Error(data.message || '获取文件夹内容失败');
    }

    const contentDisposition = response.headers.get('Content-Disposition');
    const filenameStarMatch = contentDisposition?.match(/filename\*=UTF-8''([^;]+)(?:;|$)/);
    const filenameMatch = contentDisposition?.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
    let filename = fileName || 'download';
    if (filenameStarMatch && filenameStarMatch[1]) {
      filename = decodeURIComponent(filenameStarMatch[1].trim());
    } else if (filenameMatch && filenameMatch[1]) {
      filename = filenameMatch[1].replace(/['"]/g, '').trim();
    }

    const contentLength = response.headers.get('Content-Length');
    const total = contentLength ? parseInt(contentLength, 10) : 0;

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('无法读取响应');
    }

    const chunks: Uint8Array[] = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      received += value.length;

      if (onProgress && total > 0) {
        onProgress(Math.round((received / total) * 100), received, total);
      }
    }

    let blob = new Blob(chunks);
    
    // 如果文件是加密的，需要解密
    if (isEncrypted && keys) {
      try {
        const decrypted = await decryptFileChunkedWithKeysYield(blob, keys as any);
        blob = decrypted.blob;
        // 修改文件名为原始文件名（去掉 .enc 后缀）
        if (filename.endsWith('.enc')) {
          filename = filename.replace('.enc', '');
        }
      } catch (error) {
        console.error('解密失败:', error);
      }
    }
    
    const blobUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = decodeURIComponent(filename);
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(blobUrl);
    document.body.removeChild(a);

    return { success: true, filename };
  },

  async uploadFile(
    file: File,
    parentId: string | null,
    onProgress?: (progress: number) => void,
    isEncrypted: boolean = false,
    encryptedName?: string,
    originalSize?: number,
    xhrRef?: { current: XMLHttpRequest | null }
  ) {
    const token = getToken();
    const formData = new FormData();
    formData.append('file', file);
    if (parentId) formData.append('parentId', parentId);
    if (isEncrypted) formData.append('isEncrypted', 'true');
    if (encryptedName) formData.append('name', encryptedName);
    if (originalSize) formData.append('originalSize', String(originalSize));

    return new Promise<{ success: boolean; data: any }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let aborted = false;
      
      if (xhrRef) {
        xhrRef.current = xhr;
      }

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      });

      xhr.addEventListener('load', () => {
        if (xhrRef) {
          xhrRef.current = null;
        }
        if (aborted) {
          // console.log('[DEBUG] xhr load 但已中止，忽略');
          return;
        }
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300 && data.success) {
            resolve(data);
          } else {
            reject(new Error(data.message || '上传失败'));
          }
        } catch {
          reject(new Error('解析响应失败'));
        }
      });

      xhr.addEventListener('error', () => {
        if (xhrRef) {
          xhrRef.current = null;
        }
        if (aborted) {
          // console.log('[DEBUG] xhr error 但已中止，忽略');
          return;
        }
        reject(new Error('上传失败'));
      });

      xhr.addEventListener('abort', () => {
        // console.log('[DEBUG] xhr abort 事件触发, aborted=', aborted);
        aborted = true;
        // 不再 reject，让上传继续完成，然后在 load 事件中处理
      });

      xhr.open('POST', `${API.baseUrl}/api/drive/upload`);
      if (token) {
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      }
      xhr.send(formData);
    });
  },

  // 分享链接相关
  async getSharedFiles(folderId: string) {
    return request<{ success: boolean; data: any }>(
      `${API.baseUrl}/api/drive/shared/${folderId}`
    );
  },

  async getSharedFilesWithPath(token: string, folderId?: string) {
    try {
      let url = `${API.baseUrl}/api/drive/shared/${token}`;
      if (folderId) {
        url += `?folderId=${encodeURIComponent(folderId)}`;
      }
      const response = await fetch(url);
      
      // 检查 HTTP 状态码
      if (response.status === 404) {
        return { success: false, message: '分享链接无效或已失效' };
      }
      
      if (!response.ok) {
        try {
          const data = await response.json();
          return { success: false, message: data.message || '分享链接无效' };
        } catch {
          return { success: false, message: '分享链接无效' };
        }
      }
      
      const data = await response.json();
      return data;
    } catch (err) {
      console.error('getSharedFilesWithPath error:', err);
      return { success: false, message: '分享链接无效' };
    }
  },

  async sharedDownload(
    id: string,
    token: string,
    onProgress?: (progress: number, loaded?: number, total?: number) => void,
    fallbackFilename?: string,
    isEncrypted?: boolean,
    key?: string,
    abortSignal?: AbortSignal
  ) {
    let url = `${API.baseUrl}/api/drive/shared/${token}/download?id=${id}`;
    if (key) {
      url += `&key=${encodeURIComponent(key)}`;
    }
    const response = await fetch(url, {
      signal: abortSignal
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.message || '下载失败');
    }

    const contentType = response.headers.get('Content-Type');
    
    // 如果是 JSON 格式，说明是文件夹下载（返回URL列表）
    if (contentType?.includes('application/json')) {
      const data = await response.json();
      if (data.success && data.data && data.data.files) {
        const JSZip = (await import('jszip')).default;
        const zip = new JSZip();
        
        let { folderName, files } = data.data;
        
        // 解密文件夹名称
        if (folderName?.startsWith('U2FsdGVkX') && key) {
          const decrypted = decrypt(folderName, key);
          if (decrypted) {
            folderName = decrypted;
          }
        }
        
        // 计算总大小用于进度显示
        const totalSize = files.reduce((sum: number, f: any) => sum + (f.size || 0), 0);
        let downloadedSize = 0;
        
        // 逐个下载文件
        for (let i = 0; i < files.length; i++) {
          const fileInfo = files[i];
          const { fileId, name, path, size, isEncrypted, url } = fileInfo;
          
          try {
            // 获取文件内容（通过分享链接下载）
            const fileResponse = await fetch(`${API.baseUrl}/api/drive/shared/${token}/download?id=${fileId}`);
            
            if (!fileResponse.ok) {
              console.error('下载文件失败:', name);
              continue;
            }
            
            const fileBlob = await fileResponse.blob();
            let finalBytes = new Uint8Array(await fileBlob.arrayBuffer());
            
            // 解密文件名
            let finalPath = path || name;
            if (name?.startsWith('U2FsdGVkX') && key) {
              const decrypted = decrypt(name, key);
              if (decrypted) {
                finalPath = decrypted + (path?.substring(name.length) || '');
              }
            }
            
            // 如果文件是加密的，需要解密
            if (isEncrypted === 1 && key) {
              try {
                const encryptedBlob = new Blob([finalBytes]);
                const storedKeys = loadKeysFromStorage();
                const keysToTry = {
                  currentKey: key,
                  legacyKeys: storedKeys?.legacyKeys || []
                };
                const { blob: decryptedBlob } = await decryptFileChunkedWithKeysAsync(encryptedBlob, keysToTry);
                finalBytes = new Uint8Array(await decryptedBlob.arrayBuffer());
              } catch (e) {
                console.error('解密文件失败:', name, e);
              }
            }
            
            zip.file(finalPath, finalBytes);
            downloadedSize += size || 0;
            
            if (onProgress && totalSize > 0) {
              onProgress(Math.round((downloadedSize / totalSize) * 100), downloadedSize, totalSize);
            }
          } catch (error) {
            console.error('处理文件失败:', name, error);
          }
        }
        
        // 生成 zip 文件并下载
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        const blobUrl = window.URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = `${folderName || 'folder'}.zip`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(blobUrl);
        document.body.removeChild(a);
        
        return { success: true, filename: `${folderName || 'folder'}.zip` };
      } else {
        throw new Error(data.message || '获取文件夹内容失败');
      }
    }

    // 单文件下载（二进制）
    const contentDisposition = response.headers.get('Content-Disposition');
    const filenameStarMatch = contentDisposition?.match(/filename\*=UTF-8''([^;]+)(?:;|$)/);
    const filenameMatch = contentDisposition?.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
    let filename = fallbackFilename || 'download';
    if (!fallbackFilename) {
      if (filenameStarMatch && filenameStarMatch[1]) {
        filename = decodeURIComponent(filenameStarMatch[1].trim());
      } else if (filenameMatch && filenameMatch[1]) {
        filename = filenameMatch[1].replace(/['"]/g, '').trim();
      }
    }

    const contentLength = response.headers.get('Content-Length');
    const total = contentLength ? parseInt(contentLength, 10) : 0;

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('无法读取响应');
    }

    const chunks: Uint8Array[] = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      received += value.length;

      if (onProgress && total > 0) {
        onProgress(Math.round((received / total) * 100), received, total);
      }
    }

    let blob = new Blob(chunks);
    
    if (!filename) {
      filename = fallbackFilename || 'download';
    }
    
    if (isEncrypted && key) {
      try {
        const storedKeys = loadKeysFromStorage();
        const keysToTry = {
          currentKey: key,
          legacyKeys: storedKeys?.legacyKeys || []
        };
        const { blob: decryptedBlob } = await decryptFileChunkedWithKeysAsync(blob, keysToTry);
        blob = decryptedBlob;
        if (filename && filename.endsWith('.enc')) {
          filename = filename.replace('.enc', '');
        }
      } catch (error: any) {
        console.error('解密失败:', error);
        throw new Error(`解密失败: ${error.message || '文件已损坏或密钥错误'}`);
      }
    }
    
    const blobUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = decodeURIComponent(filename);
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(blobUrl);
    document.body.removeChild(a);

    return { success: true, filename };
  },

  async sharedUpload(
    token: string,
    file: File,
    parentId?: string,
    encryptedName?: string,
    isEncrypted: boolean = false,
    onProgress?: (progress: number) => void,
    xhrRef?: { current: XMLHttpRequest | null },
    originalSize?: number
  ) {
    const formData = new FormData();
    formData.append('file', file);
    if (parentId) formData.append('parentId', parentId);
    if (isEncrypted) formData.append('isEncrypted', 'true');
    if (encryptedName) formData.append('name', encryptedName);
    if (originalSize) formData.append('originalSize', String(originalSize));

    return new Promise<{ success: boolean; data: any }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      
      if (xhrRef) {
        xhrRef.current = xhr;
      }

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      });

      xhr.addEventListener('load', () => {
        if (xhrRef) {
          xhrRef.current = null;
        }
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300 && data.success) {
            resolve(data);
          } else {
            reject(new Error(data.message || '上传失败'));
          }
        } catch {
          reject(new Error('解析响应失败'));
        }
      });

      xhr.addEventListener('error', () => {
        if (xhrRef) {
          xhrRef.current = null;
        }
        reject(new Error('上传失败'));
      });

      xhr.addEventListener('abort', () => {
        if (xhrRef) {
          xhrRef.current = null;
        }
        reject(new Error('上传已取消'));
      });

      xhr.open('POST', `${API.baseUrl}/api/drive/shared/${token}/upload`);
      xhr.send(formData);
    });
  },
};

export const api = {
  auth,
  user,
  conversation,
  group,
  message,
  upload,
  ocr,
  stats,
  ai,
  site,
  drive,
};

export default api;
