/**
 * Cloudflare WebSocket 客户端
 */

import type { MessageHandler } from '../types';
import { API, API_BASE_URL } from '../config/api';
import { apiFetch } from './csrf';
export type { MessageHandler };

class CloudflareWebSocket {
  private ws: WebSocket | null = null;
  private url: string = '';
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private baseReconnectDelay = 1000;
  private listeners: Map<string, Set<MessageHandler>> = new Map();
  private messageQueue: any[] = [];
  private isConnected = false;
  private isConnecting = false;
  private shouldReconnect = true;
  private sessionId: string = 'global';
  private currentToken: string = '';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private onMessageSent: ((success: boolean, data?: any) => void) | null = null;

  constructor() {
    const wsBaseUrl = API_BASE_URL;
    this.url = `${wsBaseUrl}/api/ws`;
  }
  
  setOnMessageSent(callback: (success: boolean, data?: any) => void) {
    this.onMessageSent = callback;
  }
  
  private async sendViaRestApi(data: any): Promise<boolean> {
    if (data.type === 'message') {
      try {
        const response = await apiFetch(API.conversations.messages(data.sessionId), {
          method: 'POST',
          body: JSON.stringify({
            content: data.content,
            attachments: data.attachments,
            quoteId: data.quoteId,
            isEncrypted: data.isEncrypted,
            clientMessageId: data.clientMessageId
          })
        });
        
        if (response.ok) {
          const result = await response.json();
          if (this.onMessageSent) {
            this.onMessageSent(true, result);
          }
          return true;
        } else {
          if (this.onMessageSent) {
            this.onMessageSent(false, { message: '发送失败' });
          }
          return false;
        }
      } catch (error) {
        console.error('[WebSocket] REST API fallback failed:', error);
        if (this.onMessageSent) {
          this.onMessageSent(false, { message: '网络错误' });
        }
        return false;
      }
    }
    return false;
  }

  connect(token: string, sessionId?: string): Promise<void> {
    if (this.isConnected && this.currentToken === token) {
      return Promise.resolve();
    }
    
    this.currentToken = token;
    this.sessionId = sessionId || 'global';
    
    return new Promise((resolve, reject) => {
      if (!token) {
        reject(new Error('No token'));
        return;
      }

      if (this.isConnecting) {
        resolve();
        return;
      }

      // 关闭旧的 WebSocket 连接
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }

      this.isConnecting = true;
      // 使用 URL 参数传递 token 和 sessionId
      const wsUrl = `${this.url}?token=${token}&sessionId=${this.sessionId}`;
      
      // 直接使用 WebSocket
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.isConnected = true;
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        
        // 启动心跳
        this.startHeartbeat();
        
        this.emit('connect', {});
        
        // 发送队列中的消息
        this.flushMessageQueue();
        
        resolve();
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string);
          
          this.handleMessage(data);
        } catch (e) {
          console.error('Failed to parse message:', e);
        }
      };

      this.ws.onerror = (error) => {
        console.error('[WebSocket] Error:', error);
        // WebSocket 错误，不在这里处理，避免影响 onclose
      };
      
      this.ws.onclose = (event) => {
        this.isConnected = false;
        this.isConnecting = false;
        this.stopHeartbeat();
        
        // 如果是正常关闭（shouldReconnect=false），不触发重连
        if (!this.shouldReconnect) {
          this.emit('disconnect', { reason: event.reason, willReconnect: false });
          return;
        }
        
        // 检查是否是连接拒绝错误 (code 1006 表示异常关闭)
        const isAbnormalClose = event.code === 1006 || 
          (event.reason && event.reason.toLowerCase().includes('connection refused'));
        
        if (isAbnormalClose) {
          console.warn('[WebSocket] Connection refused, using REST API fallback');
          // 连接被拒绝时，不停止重连，而是使用 REST API 作为后备
          this.emit('trulyOffline', { reason: 'connection refused' });
          // 继续尝试重连
          this.reconnectAttempts++;
          const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
          // console.log(`[WebSocket] Retrying connection in ${delay}ms (attempt ${this.reconnectAttempts})`);
          setTimeout(() => {
            if (this.shouldReconnect) {
              this.connect(this.currentToken, this.sessionId).catch(() => {});
            }
          }, delay);
          return;
        }
        
        this.emit('disconnect', { reason: event.reason, willReconnect: true });
        
        // 只有在重连次数未超限时才重连
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
          // console.log(`[WebSocket] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
          setTimeout(() => {
            if (this.shouldReconnect) {
              this.connect(this.currentToken, this.sessionId).catch(() => {});
            }
          }, delay);
        } else {
          console.error('[WebSocket] Max reconnect attempts reached, using REST API fallback');
          this.emit('trulyOffline', {});
        }
      };
    });
  }

  private flushMessageQueue() {
    while (this.messageQueue.length > 0) {
      const msg = this.messageQueue.shift();
      this.send(msg, false);
    }
  }

  private handleMessage(data: any) {
    const type = data.type;
    
    switch (type) {
      case 'message':
        this.emit('message', data.data);
        break;
      case 'userStatus':
        this.emit('userStatus', data.data);
        break;
      case 'messagesRead':
        this.emit('messagesRead', data.data);
        break;
      case 'messageSent':
        this.emit('messageSent', data.data);
        break;
      case 'messageRecalled':
        this.emit('messageRecalled', data.data);
        break;
      case 'messageDeleted':
        this.emit('messageDeleted', data.data);
        break;
      case 'deleteBlocked':
        this.emit('deleteBlocked', data.data);
        break;
      case 'typing':
        this.emit('typing', data.data);
        break;
      case 'unreadUpdate':
        this.emit('unreadUpdate', data.data);
        break;
      case 'conversationsUpdate':
        this.emit('conversationsUpdate', data.data);
        break;
      case 'groupMembersUpdate':
        this.emit('groupMembersUpdate', data.data);
        break;
      case 'burnAfterRead':
        this.emit('burnAfterRead', data.data);
        break;
      case 'kickedFromGroup':
        this.emit('kickedFromGroup', data.data);
        break;
      case 'joinedGroup':
        this.emit('joinedGroup', data.data);
        break;
      case 'error':
        this.emit('error', data.data);
        break;
      case 'muted':
        this.emit('muted', data.data);
        break;
      case 'unmuted':
        this.emit('unmuted', data.data);
        break;
      case 'userMuted':
        this.emit('userMuted', data.data);
        break;
      case 'userUnmuted':
        this.emit('userUnmuted', data.data);
        break;
      case 'userBanned':
        this.emit('userBanned', data.data);
        break;
      case 'userUnbanned':
        this.emit('userUnbanned', data.data);
        break;
      case 'forceLogout':
        this.emit('forceLogout', data.data);
        break;
      case 'joinRequestSubmitted':
        this.emit('joinRequestSubmitted', data.data);
        break;
      case 'joinRequestApproved':
        this.emit('joinRequestApproved', data.data);
        break;
      case 'joinRequestRejected':
        this.emit('joinRequestRejected', data.data);
        break;
      case 'report':
        this.emit('report', data);
        break;
      case 'newReport':
        this.emit('newReport', data.data);
        break;
      case 'connected':
        break;
    }
  }

  send(data: any, queueIfNotConnected: boolean = true) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
      return true;
    } else if (queueIfNotConnected) {
      // WebSocket未连接时，如果是消息类型，尝试使用REST API发送
      if (data.type === 'message') {
        this.sendViaRestApi(data);
        return true;
      }
      // 其他类型的消息加入队列
      this.messageQueue.push(data);
      if (!this.isConnecting && this.shouldReconnect) {
        this.connect(this.currentToken, this.sessionId).catch(console.error);
      }
      return false;
    }
    return false;
  }

  private emit(event: string, data: any) {
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.forEach(cb => cb(data));
    }
  }

  on(event: string, callback: MessageHandler) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
  }

  off(event: string, callback: MessageHandler) {
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.delete(callback);
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 20000);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  disconnect() {
    this.shouldReconnect = false;
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.isConnecting = false;
    this.listeners.clear();
  }

  sendMessage(sessionId: string, content: string, options?: {
    attachments?: any[];
    quoteId?: string;
    mentions?: string[];
    burnAfterReading?: boolean;
    isEncrypted?: boolean;
    timestamp?: number;
    clientMessageId?: string;
  }): boolean {
    const timestamp = options?.timestamp || Date.now();
    const clientMessageId = options?.clientMessageId || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const data = {
      type: 'message',
      sessionId,
      content,
      clientMessageId,
      timestamp,
      attachments: options?.attachments,
      quoteId: options?.quoteId,
      mentions: options?.mentions,
      burnAfterReading: options?.burnAfterReading,
      isEncrypted: options?.isEncrypted
    };
    
    
    return this.send(data);
  }

  markRead(sessionId: string, messageIds: string[]) {
    this.send({
      type: 'markRead',
      sessionId,
      messageIds
    });
  }

  joinSession(sessionId: string) {
    this.send({
      type: 'joinSession',
      sessionId
    });
  }

  recallMessage(messageId: string, sessionId: string, senderId: string, senderName: string, content: string) {
    this.send({
      type: 'messageRecalled',
      messageId,
      sessionId,
      senderId,
      senderName,
      content
    });
  }

  deleteMessage(messageId: string, sessionId: string, senderId: string, senderName: string, content: string) {
    this.send({
      type: 'messageDeleted',
      messageId,
      sessionId,
      senderId,
      senderName,
      content
    });
  }

  sendTyping(sessionId: string) {
    this.send({
      type: 'typing',
      sessionId
    });
  }
}

export const cfSocket = new CloudflareWebSocket();
export default cfSocket;
