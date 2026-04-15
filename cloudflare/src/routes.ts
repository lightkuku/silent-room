/*
 * 后端 API 路由统一管理配置文件
 * src/routes.js
 * 
 * 包含所有API路由路径和不允许上传的文件后缀
 */

const API = {
  // 基础路径
  baseUrl: '/api',

  // Auth - 认证相关
  auth: {
    login: '/api/auth/login',
    register: '/api/auth/register',
  },

  // User - 用户相关
  user: {
    info: '/api/user/info',
    friends: '/api/friends',
  },

  // Conversations - 会话相关
  conversations: {
    list: '/api/conversations',
    messages: (sessionId) => `/api/conversations/${sessionId}/messages`,
    read: (sessionId) => `/api/conversations/${sessionId}/read`,
    clearHistory: (sessionId) => `/api/conversations/${sessionId}/clear-history`,
    exportHistory: (sessionId) => `/api/conversations/${sessionId}/export-history`,
  },

  // Groups - 群组相关
  groups: {
    list: '/api/groups',
    info: (id) => `/api/groups/${id}`,
    announcement: (id) => `/api/groups/${id}/announcement`,
    members: (id) => `/api/groups/${id}/members`,
    owners: (id) => `/api/groups/${id}/owners`,
  },

  // Messages - 消息相关
  messages: {
    recall: (id) => `/api/messages/${id}/recall`,
    delete: (id) => `/api/messages/${id}`,
  },

  // Upload - 文件上传
  upload: {
    single: '/api/upload',
  },

  // Admin - 管理员相关
  admin: {
    login: '/api/admin/login',
    users: '/api/admin/users',
    groups: '/api/admin/groups',
    sessions: '/api/admin/sessions',
    allUsers: '/api/admin/all-users',
    stats: '/api/admin/stats',
    disk: '/api/admin/disk',
    userMessages: (id) => `/api/admin/users/${id}/messages`,
    messageDelete: (id) => `/api/admin/messages/${id}`,
    sessionInfo: (id) => `/api/admin/sessions/${id}`,
    sessionOwner: (id) => `/api/admin/sessions/${id}/owner`,
    sessionFriend: '/api/admin/sessions/friend',
    sessionMembers: (id) => `/api/admin/sessions/${id}/members`,
    sessionUpdate: (id) => `/api/admin/sessions/${id}`,
    sessionDelete: (id) => `/api/admin/sessions/${id}`,
  },

  // System - 系统管理（新增）
  system: {
    clearMessages: '/api/system/clear-messages',
  },

  // Drive - 网盘相关
  drive: {
    list: '/api/drive/files',
    file: '/api/drive/files/:id',
    upload: '/api/drive/upload',
    createFolder: '/api/drive/folder',
    delete: '/api/drive/files/:id',
    batchDelete: '/api/drive/batch-delete',
    emptyTrash: '/api/drive/empty-trash',
    batchPermanentDelete: '/api/drive/batch-permanent-delete',
    rename: '/api/drive/files/:id/rename',
    share: '/api/drive/files/:id/share',
    move: '/api/drive/files/:id/move',
    download: '/api/drive/files/:id/download',
    sharedWithMe: '/api/drive/shared-with-me',
    restore: '/api/drive/files/:id/restore',
    permanentDelete: '/api/drive/files/:id/permanent',
    shareOptions: '/api/drive/share-options',
    sharedLink: '/api/drive/shared/:token',
    sharedLinkUpload: '/api/drive/shared/:token/upload',
    sharedLinkDownload: '/api/drive/shared/:token/download',
    sharedLinkRename: '/api/drive/shared/:token/rename',
    storage: '/api/drive/storage',
  },

  // 群附件
  groupAttachment: {
    list: '/api/group-attachments/:sessionId',
    upload: '/api/group-attachments/:sessionId/upload',
    delete: '/api/group-attachments/:id',
    download: '/api/group-attachments/:id/download',
  },
};

// 系统配置
const CONFIG = {
  CLEAR_HISTORY_DAYS: 7, // 清除历史记录的天数（默认7天）
};

// 检查文件后缀是否被禁止
function isFileExtensionBlocked(filename) {
  const ext = filename.split('.').pop()?.toLowerCase();
  return ext ? BLOCKED_FILE_EXTENSIONS.includes(ext) : false;
}

// 获取被阻止的文件后缀列表
function getBlockedExtensions() {
  return [...BLOCKED_FILE_EXTENSIONS];
}

module.exports = {
  API,
  CONFIG
};

