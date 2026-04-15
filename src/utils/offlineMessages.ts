/**
 * 离线消息管理
 * - 将发送失败的消息持久化到 localStorage
 * - 页面加载时自动发送离线消息
 * - 显示离线消息发送状态
 */

const OFFLINE_MESSAGES_KEY = 'offlineMessages';
const OFFLINE_ATTACHMENTS_KEY = 'offlineAttachments';

export interface OfflineMessage {
  id: string;
  sessionId: string;
  content: string;
  timestamp: number;
  attachments?: OfflineAttachment[];
  isEncrypted?: boolean;
  burnAfterReading?: boolean;
  quoteId?: string;
  retryCount?: number;
}

export interface OfflineAttachment {
  name: string;
  size: number;
  url: string;
  type: string;
  encrypted?: boolean;
}

export function saveOfflineMessage(message: OfflineMessage): void {
  try {
    const messages = getOfflineMessages();
    messages.push(message);
    localStorage.setItem(OFFLINE_MESSAGES_KEY, JSON.stringify(messages));
  } catch (e) {
    console.error('Failed to save offline message:', e);
  }
}

export function getOfflineMessages(): OfflineMessage[] {
  try {
    const stored = localStorage.getItem(OFFLINE_MESSAGES_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch (e) {
    return [];
  }
}

export function removeOfflineMessage(messageId: string): void {
  try {
    const messages = getOfflineMessages().filter(m => m.id !== messageId);
    localStorage.setItem(OFFLINE_MESSAGES_KEY, JSON.stringify(messages));
  } catch (e) {
    console.error('Failed to remove offline message:', e);
  }
}

export function clearOfflineMessages(): void {
  localStorage.removeItem(OFFLINE_MESSAGES_KEY);
  localStorage.removeItem(OFFLINE_ATTACHMENTS_KEY);
}

export function saveOfflineAttachment(messageId: string, file: File): void {
  try {
    const attachments = getOfflineAttachments();
    attachments[messageId] = {
      name: file.name,
      size: file.size,
      lastModified: file.lastModified
    };
    localStorage.setItem(OFFLINE_ATTACHMENTS_KEY, JSON.stringify(attachments));
  } catch (e) {
    console.error('Failed to save offline attachment:', e);
  }
}

export function getOfflineAttachments(): { [key: string]: { name: string; size: number; lastModified: number } } {
  try {
    const stored = localStorage.getItem(OFFLINE_ATTACHMENTS_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch (e) {
    return {};
  }
}

export function removeOfflineAttachment(messageId: string): void {
  try {
    const attachments = getOfflineAttachments();
    delete attachments[messageId];
    localStorage.setItem(OFFLINE_ATTACHMENTS_KEY, JSON.stringify(attachments));
  } catch (e) {
    console.error('Failed to remove offline attachment:', e);
  }
}

export function getOfflineMessagesCount(): number {
  return getOfflineMessages().length;
}
