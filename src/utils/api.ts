/**
 * Cloudflare Workers API 客户端
 */

import { hashPassword } from './crypto';
import { apiFetch } from './csrf';
import { API_BASE_URL } from '../config/api';

class ApiClient {
  private token: string | null = null;

  setToken(token: string | null) {
    this.token = token;
    if (token) {
      localStorage.setItem('token', token);
    } else {
      localStorage.removeItem('token');
    }
  }

  getToken(): string | null {
    if (!this.token) {
      this.token = localStorage.getItem('token');
    }
    return this.token;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const token = this.getToken();
    const response = await apiFetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
    });

    const data = await response.json();

    if (!data.success) {
      throw new Error(data.message || '请求失败');
    }

    return data;
  }

  // 认证
  async login(username: string, password: string) {
    const hashedPassword = await hashPassword(password);
    const data = await this.request<any>('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: hashedPassword }),
    });
    if (data.data.token) {
      this.setToken(data.data.token);
    }
    return data;
  }

  async register(name: string, username: string, password: string) {
    const data = await this.request<any>('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, username, password }),
    });
    if (data.data.token) {
      this.setToken(data.data.token);
    }
    return data;
  }

  async getUserInfo() {
    return this.request<any>('/api/user/info');
  }

  async updateUserInfo(data: { name?: string; avatar?: string; signature?: string }) {
    return this.request<any>('/api/user/info', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  }

  // 好友与会话
  async getFriends() {
    return this.request<any>('/api/friends');
  }

  async addFriend(friendId: string) {
    const result = await this.request<any>('/api/friends', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendId }),
    });
    // 广播会话列表更新
    if (result.success) {
      await this.request<any>('/api/broadcast/conversations-update', { method: 'POST' });
    }
    return result;
  }

  async getConversations() {
    return this.request<any>('/api/conversations');
  }

  // 消息
  async getMessages(sessionId: string, page = 1, limit = 50) {
    return this.request<any>(`/api/conversations/${sessionId}/messages?page=${page}&limit=${limit}`);
  }

  async sendMessage(sessionId: string, content: string, attachments?: any[], quoteId?: string) {
    return this.request<any>(`/api/conversations/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, attachments, quoteId }),
    });
  }

  async markAsRead(sessionId: string) {
    return this.request<any>(`/api/conversations/${sessionId}/read`, {
      method: 'POST',
    });
  }

  // 会话管理
  async pinConversation(sessionId: string, isPinned: boolean) {
    return this.request<any>(`/api/conversations/${sessionId}/pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPinned }),
    });
  }

  async muteConversation(sessionId: string, isMuted: boolean) {
    return this.request<any>(`/api/conversations/${sessionId}/mute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isMuted }),
    });
  }

  // 群组
  async createGroup(name: string, memberIds: string[]) {
    const result = await this.request<any>('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, memberIds }),
    });
    // 广播会话列表更新
    if (result.success) {
      await this.request<any>('/api/broadcast/conversations-update', { method: 'POST' });
    }
    return result;
  }

  async getGroupInfo(groupId: string) {
    return this.request<any>(`/api/groups/${groupId}`);
  }

  async updateGroupAnnouncement(groupId: string, announcement: string) {
    return this.request<any>(`/api/groups/${groupId}/announcement`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ announcement }),
    });
  }

  async getGroupMembers(groupId: string) {
    return this.request<any>(`/api/groups/${groupId}/members`);
  }

  async addGroupMember(groupId: string, memberId: string) {
    const result = await this.request<any>(`/api/groups/${groupId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId }),
    });
    // 广播会话列表更新
    if (result.success) {
      await this.request<any>('/api/broadcast/conversations-update', { method: 'POST' });
    }
    return result;
  }

  async removeGroupMember(groupId: string, memberId: string) {
    const result = await this.request<any>(`/api/groups/${groupId}/members/${memberId}`, {
      method: 'DELETE',
    });
    // 广播会话列表更新
    if (result.success) {
      await this.request<any>('/api/broadcast/conversations-update', { method: 'POST' });
    }
    return result;
  }

  // 文件上传
  async uploadFile(file: File): Promise<{ url: string; name: string; size: number; type: string }> {
    const formData = new FormData();
    formData.append('file', file);

    const response = await apiFetch(`${API_BASE_URL}/api/upload`, {
      method: 'POST',
      body: formData as any,
    });

    const data = await response.json();
    if (!data.success) {
      throw new Error(data.message);
    }
    return data.data;
  }

  // 管理员
  async adminLogin(password: string) {
    const data = await this.request<any>('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (data.data.token) {
      this.setToken(data.data.token);
      localStorage.setItem('adminToken', data.data.token);
    }
    if (data.data.csrfToken) {
      sessionStorage.setItem('csrfToken', data.data.csrfToken);
    }
    return data;
  }

  async getAdminStats() {
    return this.request<any>('/api/admin/stats');
  }
  
  async leaveGroup(groupId: string, memberId: string) {
    const result = await this.request<any>(`/api/groups/${groupId}/members/${memberId}`, {
      method: 'DELETE',
    });
    // 广播会话列表更新
    if (result.success) {
      await this.request<any>('/api/broadcast/conversations-update', { method: 'POST' });
    }
    return result;
  }
}

export const api = new ApiClient();
export default api;
