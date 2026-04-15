export interface User {
  id: string;
  name: string;
  username: string;
  avatar: string;
  signature?: string;
  status?: 'online' | 'away' | 'offline';
  type?: 'friend' | 'group';
  role?: 'admin' | 'superadmin' | 'vip' | 'user';
  accountStatus?: 'normal' | 'muted' | 'banned';
}

export type SendStatus = 'pending' | 'sending' | 'sent' | 'failed';

export interface Message {
  id: string;
  content: string;
  sender: User;
  receiver: User;
  timestamp: Date;
  replyTo?: {
    id: string;
    name: string;
    content: string;
  };
  status?: SendStatus;
  isEncrypted?: boolean;
  attachments?: Array<{
    id: string;
    type: string;
    name: string;
    size: number;
    url: string;
    encrypted?: boolean;
  }>;
  isSystem?: boolean;
  recalled?: boolean;
}

export interface EncryptionKeys {
  currentKey: string;
  legacyKeys: string[];
}

export type TaskStatus = 'pending' | 'uploading' | 'paused' | 'completed' | 'error' | 'cancelled';
export type TaskType = 'upload' | 'download';

export interface TaskItem {
  id: string;
  filename: string;
  originalName?: string;
  progress: number;
  status: TaskStatus;
  type: TaskType;
  totalSize?: number;
  loadedSize?: number;
  speed?: number;
  tempMessageId?: string;
  file?: File;
  result?: any;
  createdAt: number;
  url?: string;
  encrypted?: boolean;
  senderId?: string;
  originalSize?: number;
  isBurn?: boolean;
  skipSizeCheck?: boolean;
  customEndpoint?: string;
  attachmentId?: string;
  encrypting?: boolean;
}

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastItem {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
}

export interface SiteConfig {
  title?: string;
  description?: string;
  favicon?: string;
  logo?: string;
  version?: string;
}

export interface UseLocalStorageOptions<T> {
  serializer?: (value: T) => string;
  deserializer?: (value: string) => T;
}

export type MessageHandler = (data: any) => void;

export type UploadCallback = (uploads: any[]) => void;

export interface Group {
  id: string;
  name: string;
  avatar?: string;
  description?: string;
  ownerId: string;
  memberCount: number;
  maxMembers?: number;
  createdAt?: string;
  settings?: {
    requireApproval?: boolean;
    allowMemberInvite?: boolean;
  };
}

export interface Conversation {
  id: string;
  type: 'private' | 'group';
  name?: string;
  avatar?: string;
  lastMessage?: {
    content: string;
    timestamp: Date;
  };
  unreadCount?: number;
  isPinned?: boolean;
  isMuted?: boolean;
  participants?: User[];
}

export interface Session {
  id: string;
  type: 'private' | 'group';
  name?: string;
  avatar?: string;
  participants?: User[];
  lastMessage?: {
    content: string;
    timestamp: Date;
  };
  unreadCount?: number;
  isPinned?: boolean;
  isMuted?: boolean;
}

export interface FriendRequest {
  id: string;
  fromUser: User;
  toUserId: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: Date;
}

export interface GroupJoinRequest {
  id: string;
  userId: string;
  groupId: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: Date;
}

export interface APIResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginationParams {
  page?: number;
  limit?: number;
  offset?: number;
}

export interface LoginCredentials {
  username: string;
  password: string;
}

export interface RegisterData extends LoginCredentials {
  name?: string;
}

export interface AuthResponse {
  token: string;
  user: User;
  expiresAt?: string;
}

export interface FileUploadResponse {
  id: string;
  filename: string;
  url: string;
  size: number;
  type: string;
}

export interface AdminUserStats {
  totalUsers: number;
  activeUsers: number;
  newUsersToday: number;
  newUsersThisWeek: number;
}

export interface AdminGroupStats {
  totalGroups: number;
  activeGroups: number;
}

export interface AdminSessionStats {
  totalSessions: number;
  privateSessions: number;
  groupSessions: number;
}

export interface AdminDiskStats {
  totalSize: number;
  usedSize: number;
  userCount: number;
}

export interface AdminBackupInfo {
  key: string;
  size: number;
  createdAt: string;
  type: 'chat' | 'drive';
}

export interface BackupProgress {
  status: 'idle' | 'creating' | 'restoring';
  progress?: number;
  message?: string;
}

export interface BanInfo {
  userId: string;
  bannedAt: string;
  bannedBy?: string;
  reason?: string;
}

export interface MuteInfo {
  userId: string;
  groupId: string;
  mutedAt: string;
  mutedBy?: string;
  expiresAt?: string;
}

export interface DriveUserInfo {
  userId: string;
  username: string;
  usedSize: number;
  fileCount: number;
}

export interface DriveUserLimit {
  maxSize: number;
  usedSize: number;
}
