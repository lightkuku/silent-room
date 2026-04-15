export const API_BASE_URL = import.meta.env.VITE_API_URL;
export const WS_BASE_URL = import.meta.env.VITE_WS_URL;
export const MAX_UPLOAD_SIZE = import.meta.env.MAX_UPLOAD_SIZE || 200;

// Cloudflare Turnstile 配置（机器人验证）
export const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || '';

// 网站自定义配置
import type { SiteConfig } from '../types';
export type { SiteConfig };

export const DEFAULT_SITE_CONFIG: SiteConfig = {
  title: 'Chat',
  description: '安全加密的即时通讯应用',
  favicon: '/logo.svg',
  logo: '/logo.svg'
};

// 从 localStorage 加载网站配置
export function loadSiteConfig(): SiteConfig {
  try {
    const stored = localStorage.getItem('siteConfig');
    if (stored) {
      return { ...DEFAULT_SITE_CONFIG, ...JSON.parse(stored) };
    }
  } catch (e) {}
  return DEFAULT_SITE_CONFIG;
}

// 保存网站配置到 localStorage
export function saveSiteConfig(config: Partial<SiteConfig>) {
  try {
    const current = loadSiteConfig();
    const newConfig = { ...current, ...config };
    localStorage.setItem('siteConfig', JSON.stringify(newConfig));
    applySiteConfig(newConfig);
  } catch (e) {}
}

// 应用网站配置到页面
export function applySiteConfig(config: SiteConfig) {
  if (typeof document === 'undefined') return;
  
  if (config.title) {
    document.title = config.title;
  }
  if (config.favicon) {
    const favicon = document.getElementById('favicon-link') as HTMLLinkElement;
    if (favicon) {
      favicon.href = config.favicon;
    }
  }
  if (config.description) {
    const meta = document.getElementById('meta-description') as HTMLMetaElement;
    if (meta) {
      meta.content = config.description;
    }
  }
}

// 初始化网站配置
export function initSiteConfig() {
  const config = loadSiteConfig();
  applySiteConfig(config);
  return config;
}

// 判断是否使用 Cloudflare Workers（始终为 true）
export const IS_CLOUDFLARE = true;

// 获取前端所在的基础URL（用于分享链接等场景）
export function getBaseUrl(): string {
  if (typeof window !== 'undefined') {
    return window.location.origin;
  }
  return API_BASE_URL;
}

// 动态获取 API URL（优先使用前端所在域）
export function getApiUrl(): string {
  return getBaseUrl();
}

export const API = {
  baseUrl: API_BASE_URL,
  wsUrl: WS_BASE_URL,
  wsEndpoint: `${WS_BASE_URL}/api/ws/connect`,

  auth: {
    login: `${API_BASE_URL}/api/auth/login`,
    register: `${API_BASE_URL}/api/auth/register`,
    logout: `${API_BASE_URL}/api/auth/logout`,
    csrf: `${API_BASE_URL}/api/auth/csrf`,
  },

  user: {
    info: `${API_BASE_URL}/api/user/info`,
    friends: `${API_BASE_URL}/api/friends`,
    search: `${API_BASE_URL}/api/users/search`,
    all: `${API_BASE_URL}/api/users/all`,
    avatar: `${API_BASE_URL}/api/user/avatar`,
    settings: `${API_BASE_URL}/api/user/settings`,
  },

  conversations: {
    list: `${API_BASE_URL}/api/conversations`,
    messages: (sessionId: string) => `${API_BASE_URL}/api/conversations/${sessionId}/messages`,
    read: (sessionId: string) => `${API_BASE_URL}/api/conversations/${sessionId}/read`,
    clearHistory: (sessionId: string) => `${API_BASE_URL}/api/conversations/${sessionId}/clear-history`,
    exportHistory: (sessionId: string) => `${API_BASE_URL}/api/conversations/${sessionId}/export-history`,
    pin: (convId: string) => `${API_BASE_URL}/api/conversations/${convId}/pin`,
    mute: (convId: string) => `${API_BASE_URL}/api/conversations/${convId}/mute`,
  },

  groups: {
    list: `${API_BASE_URL}/api/groups`,
    info: (id: string) => `${API_BASE_URL}/api/groups/${id}`,
    announcement: (id: string) => `${API_BASE_URL}/api/groups/${id}/announcement`,
    members: (id: string) => `${API_BASE_URL}/api/groups/${id}/members`,
    owners: (id: string) => `${API_BASE_URL}/api/groups/${id}/owners`,
    join: (id: string) => `${API_BASE_URL}/api/groups/${id}/join`,
    joinRequests: (id: string) => `${API_BASE_URL}/api/groups/${id}/join-requests`,
    myJoinRequests: `${API_BASE_URL}/api/groups/join-requests/my`,
    ownedJoinRequests: `${API_BASE_URL}/api/groups/join-requests/owned`,
    settingsApproval: (id: string) => `${API_BASE_URL}/api/groups/${id}/settings/approval`,
    muteStatus: (id: string) => `${API_BASE_URL}/api/groups/${id}/mute-status`,
    mutes: (id: string) => `${API_BASE_URL}/api/groups/${id}/mutes`,
    muteRecord: (groupId: string, recordId: string) => `${API_BASE_URL}/api/groups/${groupId}/mutes/${recordId}`,
    search: `${API_BASE_URL}/api/groups/search`,
  },

  messages: {
    recall: (id: string) => `${API_BASE_URL}/api/messages/${id}/recall`,
    delete: (id: string) => `${API_BASE_URL}/api/messages/${id}`,
    batch: `${API_BASE_URL}/api/messages/batch`,
    report: (id: string) => `${API_BASE_URL}/api/messages/${id}/report`,
    star: (id: string) => `${API_BASE_URL}/api/messages/${id}/star`,
    unstar: (id: string) => `${API_BASE_URL}/api/messages/${id}/star`,
    starred: (id: string) => `${API_BASE_URL}/api/messages/${id}/starred`,
  },

  upload: `${API_BASE_URL}/api/upload`,
  uploadDelete: `${API_BASE_URL}/api/upload/delete`,

  admin: {
    login: `${API_BASE_URL}/api/admin/login`,
    users: `${API_BASE_URL}/api/admin/users`,
    groups: `${API_BASE_URL}/api/admin/groups`,
    sessions: `${API_BASE_URL}/api/admin/sessions`,
    allUsers: `${API_BASE_URL}/api/admin/all-users`,
    stats: `${API_BASE_URL}/api/admin/stats`,
    disk: `${API_BASE_URL}/api/admin/disk`,
    userMessages: (id: string) => `${API_BASE_URL}/api/admin/users/${id}/messages`,
    messageDelete: (id: string) => `${API_BASE_URL}/api/admin/messages/${id}`,
    sessionInfo: (id: string) => `${API_BASE_URL}/api/admin/sessions/${id}`,
    sessionOwner: (id: string) => `${API_BASE_URL}/api/admin/sessions/${id}/owner`,
    sessionFriend: `${API_BASE_URL}/api/admin/sessions/friend`,
    sessionMembers: (id: string) => `${API_BASE_URL}/api/admin/sessions/${id}/members`,
    sessionUpdate: (id: string) => `${API_BASE_URL}/api/admin/sessions/${id}`,
    sessionDelete: (id: string) => `${API_BASE_URL}/api/admin/sessions/${id}`,
    driveSettings: `${API_BASE_URL}/api/admin/drive/settings`,
    driveStats: `${API_BASE_URL}/api/admin/drive/stats`,
    driveUsers: `${API_BASE_URL}/api/admin/drive/users`,
    driveUserLimit: (userId: string) => `${API_BASE_URL}/api/admin/drive/users/${userId}/limit`,
    bans: `${API_BASE_URL}/api/admin/bans`,
    ban: (userId: string) => `${API_BASE_URL}/api/admin/bans/${userId}`,
    globalMute: (userId: string) => `${API_BASE_URL}/api/admin/users/${userId}/global-mute`,
    userRole: (userId: string) => `${API_BASE_URL}/api/admin/users/${userId}/role`,
    backups: {
      chat: `${API_BASE_URL}/api/admin/backups/chat`,
      drive: `${API_BASE_URL}/api/admin/backups/drive`,
      chatBackup: (key: string) => `${API_BASE_URL}/api/admin/backups/chat/${key}`,
      driveBackup: (key: string) => `${API_BASE_URL}/api/admin/backups/drive/${key}`,
      chatDownload: (key: string) => `${API_BASE_URL}/api/admin/download-backup/chat/${key}`,
      driveDownload: (key: string) => `${API_BASE_URL}/api/admin/download-backup/drive/${key}`,
      backupDownload: `${API_BASE_URL}/api/admin/backup/download`,
      restoreChat: `${API_BASE_URL}/api/admin/restore/chat`,
      restoreDrive: `${API_BASE_URL}/api/admin/restore/drive`,
      restore: `${API_BASE_URL}/api/admin/restore`,
      backupChat: `${API_BASE_URL}/api/admin/backup/chat`,
      backupDrive: `${API_BASE_URL}/api/admin/backup/drive`,
      backup: (key: string) => `${API_BASE_URL}/api/admin/backups/${key}`,
    },
    clearDatabase: `${API_BASE_URL}/api/admin/clear-database`,
    clearDriveFiles: `${API_BASE_URL}/api/admin/clear-drive-files`,
    reports: `${API_BASE_URL}/api/admin/reports`,
    report: (id: string) => `${API_BASE_URL}/api/admin/reports/${id}/handle`,
    reportDelete: (id: string) => `${API_BASE_URL}/api/admin/reports/${id}`,
    batchDeleteReports: `${API_BASE_URL}/api/admin/reports/batch-delete`,
  },

  userContent: {
    reports: `${API_BASE_URL}/api/reports/my`,
    stars: `${API_BASE_URL}/api/stars/my`,
  },

  system: {
    clearMessages: `${API_BASE_URL}/api/system/clear-messages`,
  },

  ocr: {
    handwriting: `${API_BASE_URL}/api/ocr/handwriting`,
  },

  stats: {
    login: (days: number) => `${API_BASE_URL}/api/stats/login?days=${days}`,
    chat: (days: number) => `${API_BASE_URL}/api/stats/chat?days=${days}`,
  },

  ai: {
    chat: `${API_BASE_URL}/api/ai/chat`,
    vision: `${API_BASE_URL}/api/ai/vision`,
  },

  site: {
    config: `${API_BASE_URL}/api/site/config`,
  },

  phrases: {
    list: `${API_BASE_URL}/api/phrases`,
    phrase: (id: string) => `${API_BASE_URL}/api/phrases/${id}`,
  },

  drive: {
    list: `${API_BASE_URL}/api/drive/files`,
    file: (id: string) => `${API_BASE_URL}/api/drive/files/${id}`,
    upload: `${API_BASE_URL}/api/drive/upload`,
    createFolder: `${API_BASE_URL}/api/drive/folder`,
    delete: (id: string) => `${API_BASE_URL}/api/drive/files/${id}`,
    batchDelete: `${API_BASE_URL}/api/drive/batch-delete`,
    emptyTrash: `${API_BASE_URL}/api/drive/empty-trash`,
    batchPermanentDelete: `${API_BASE_URL}/api/drive/batch-permanent-delete`,
    rename: (id: string) => `${API_BASE_URL}/api/drive/files/${id}/rename`,
    share: (id: string) => `${API_BASE_URL}/api/drive/files/${id}/share`,
    move: (id: string) => `${API_BASE_URL}/api/drive/files/${id}/move`,
    download: (id: string) => `${API_BASE_URL}/api/drive/files/${id}/download`,
    restore: (id: string) => `${API_BASE_URL}/api/drive/files/${id}/restore`,
    permanentDelete: (id: string) => `${API_BASE_URL}/api/drive/files/${id}/permanent`,
  },

  files: {
    get: (url: string) => `${API_BASE_URL}/api/files/${url}`,
  },
  
notifications: {
    	read: `${API_BASE_URL}/api/notifications/read`,
    	readAll: `${API_BASE_URL}/api/notifications/read-all`,
    	markRead: (id: string) => `${API_BASE_URL}/api/notifications/${id}/read`,
    	deleteNotification: (id: string) => `${API_BASE_URL}/api/notifications/${id}`,
    	deleteRead: `${API_BASE_URL}/api/notifications/clear-read`,
    	deleteAll: `${API_BASE_URL}/api/notifications/all`,
    	notifications: `${API_BASE_URL}/api/notifications`,
    	adminNotifications: `${API_BASE_URL}/api/admin/notifications`,
  }
};

export const CONFIG = {
  MAX_UPLOAD_SIZE: MAX_UPLOAD_SIZE * 1024 * 1024, // 最大上传文件大小（200MB）
};

export default API;
