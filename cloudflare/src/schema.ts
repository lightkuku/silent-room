import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  username: text('username').notNull().unique(),
  password: text('password').notNull(),
  avatar: text('avatar').default(''),
  signature: text('signature').default(''),
  status: text('status').default('offline'),
  accountStatus: text('account_status').default('normal'),
  role: text('role').default('user'),
  disk: integer('disk').default(5 * 1024 * 1024 * 1024),
  createdAt: integer('created_at').default(0),
  lastLoginAt: integer('last_login_at').default(0)
}, (table) => ({
  idxUsersStatus: index('idx_users_status').on(table.status),
  idxUsersCreatedAt: index('idx_users_created_at').on(table.createdAt)
}));

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  name: text('name'),
  lastMessage: text('last_message').default(''),
  lastMessageEncrypted: integer('last_message_encrypted').default(0),
  lastTime: integer('last_time').default(0),
  announcement: text('announcement').default(''),
  ownerIds: text('owner_ids').default('[]'),
  isPinned: integer('is_pinned').default(0),
  isMuted: integer('is_muted').default(0),
  requireApproval: integer('require_approval').default(1),
  createdAt: integer('created_at').default(0)
}, (table) => ({
  idxSessionsType: index('idx_sessions_type').on(table.type),
  idxSessionsLastTime: index('idx_sessions_last_time').on(table.lastTime)
}));

export const session_participants = sqliteTable('session_participants', {
  sessionId: text('session_id').notNull(),
  userId: text('user_id').notNull()
}, (table) => ({
  idxSessionParticipantsSessionId: index('idx_session_participants_session_id').on(table.sessionId),
  idxSessionParticipantsUserId: index('idx_session_participants_user_id').on(table.userId)
}));

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  senderId: text('sender_id').notNull(),
  senderName: text('sender_name').default(''),
  content: text('content').notNull(),
  type: integer('type').default(1),
  encrypted: integer('encrypted').default(0),
  time: integer('time').default(0),
  read: integer('read').default(0),
  recalled: integer('recalled').default(0),
  isSystem: integer('is_system').default(0),
  isDeleted: integer('is_deleted').default(0),
  quoteId: text('quote_id'),
  replyToId: text('reply_to_id'),
  mentions: text('mentions'),
  burnAfterReading: integer('burn_after_reading').default(0),
  createdAt: integer('created_at').default(0)
}, (table) => ({
  idxMessagesSessionId: index('idx_messages_session_id').on(table.sessionId),
  idxMessagesSenderId: index('idx_messages_sender_id').on(table.senderId),
  idxMessagesTime: index('idx_messages_time').on(table.time),
  idxMessagesCreatedAt: index('idx_messages_created_at').on(table.createdAt)
}));

export const attachments = sqliteTable('attachments', {
  id: text('id').primaryKey(),
  messageId: text('message_id').notNull(),
  type: text('type').notNull(),
  name: text('name').notNull(),
  size: integer('size').notNull(),
  url: text('url').notNull(),
  encrypted: integer('encrypted').default(0),
  createdAt: integer('created_at').default(0)
}, (table) => ({
  idxAttachmentsMessageId: index('idx_attachments_message_id').on(table.messageId)
}));

export const message_reads = sqliteTable('message_reads', {
  messageId: text('message_id').notNull(),
  userId: text('user_id').notNull(),
  readAt: integer('read_at').default(0)
}, (table) => ({
  idxMessageReadsMessageId: index('idx_message_reads_message_id').on(table.messageId),
  idxMessageReadsUserId: index('idx_message_reads_user_id').on(table.userId)
}));

export const admins = sqliteTable('admins', {
  id: text('id').primaryKey(),
  password: text('password').notNull(),
  role: text('role').default('super_admin'),
  createdAt: integer('created_at').default(0)
});

// ==================== 网盘相关表 ====================

export const drive_files = sqliteTable('drive_files', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull().default('file'),
  size: integer('size').default(0),
  url: text('url').notNull().default(''),
  ownerId: text('owner_id').notNull(),
  parentId: text('parent_id'),
  storageType: text('storage_type').default('r2'),
  isShared: integer('is_shared').default(0),
  sharePermission: text('share_permission').default('view'),
  shareFrom: text('share_from'),
  shareToUsers: text('share_to_users').default('[]'),
  shareToGroups: text('share_to_groups').default('[]'),
  shareLinkToken: text('share_link_token'),
  deletedAt: integer('deleted_at'),
  isDeleted: integer('is_deleted').default(0),
  isEncrypted: integer('is_encrypted').default(0),
  createdAt: integer('created_at').default(0),
  updatedAt: integer('updated_at').default(0)
}, (table) => ({
  idxDriveFilesOwnerId: index('idx_drive_files_owner_id').on(table.ownerId),
  idxDriveFilesParentId: index('idx_drive_files_parent_id').on(table.parentId),
  idxDriveFilesIsDeleted: index('idx_drive_files_is_deleted').on(table.isDeleted)
}));

export const system_settings = sqliteTable('system_settings', {
  key: text('key').primaryKey(),
  value: text('value')
});

export const group_attachments = sqliteTable('group_attachments', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  name: text('name').notNull(),
  size: integer('size').notNull(),
  url: text('url').notNull(),
  uploadedBy: text('uploaded_by').notNull(),
  uploadedByName: text('uploaded_by_name').default(''),
  createdAt: integer('created_at').default(0)
}, (table) => ({
  idxGroupAttachmentsSessionId: index('idx_group_attachments_session_id').on(table.sessionId)
}));

export const phrases = sqliteTable('phrases', {
  id: text('id').primaryKey(),
  userId: text('user_id'),
  phrase: text('phrase').notNull(),
  createdAt: integer('created_at').default(0)
}, (table) => ({
  idxPhrasesUserId: index('idx_phrases_user_id').on(table.userId)
}));

export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  type: text('type').notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  data: text('data').default('{}'),
  read: integer('read').default(0),
  createdAt: integer('created_at').default(0)
}, (table) => ({
  idxNotificationsUserId: index('idx_notifications_user_id').on(table.userId),
  idxNotificationsRead: index('idx_notifications_read').on(table.read),
  idxNotificationsCreatedAt: index('idx_notifications_created_at').on(table.createdAt)
}));

export const userBans = sqliteTable('user_bans', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  bannedBy: text('banned_by').notNull(),
  reason: text('reason'),
  createdAt: integer('created_at').default(0)
}, (table) => ({
  idxUserBansUserId: index('idx_user_bans_user_id').on(table.userId)
}));

export const groupMutes = sqliteTable('group_mutes', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  userId: text('user_id').notNull(),
  mutedBy: text('muted_by').notNull(),
  reason: text('reason'),
  createdAt: integer('created_at').default(0)
}, (table) => ({
  idxGroupMutesSessionId: index('idx_group_mutes_session_id').on(table.sessionId),
  idxGroupMutesUserId: index('idx_group_mutes_user_id').on(table.userId)
}));

export const userSettings = sqliteTable('user_settings', {
  userId: text('user_id').primaryKey(),
  theme: text('theme').default('light'),
  fontSize: text('font_size').default('medium'),
  messageSound: integer('message_sound').default(1),
  groupMention: integer('group_mention').default(1),
  onlineNotify: integer('online_notify').default(1),
  offlineNotify: integer('offline_notify').default(0),
  cannotDelete: integer('cannot_delete').default(0),
  createdAt: integer('created_at').default(0),
  updatedAt: integer('updated_at').default(0)
}, (table) => ({
  idxUserSettingsUserId: index('idx_user_settings_user_id').on(table.userId)
}));

export const loginStats = sqliteTable('login_stats', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  loginAt: integer('login_at').notNull(),
  ipAddress: text('ip_address'),
  deviceInfo: text('device_info')
}, (table) => ({
  idxLoginStatsUserId: index('idx_login_stats_user_id').on(table.userId),
  idxLoginStatsLoginAt: index('idx_login_stats_login_at').on(table.loginAt)
}));

export const chatStats = sqliteTable('chat_stats', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  sessionId: text('session_id').notNull(),
  messageCount: integer('message_count').default(1),
  chatDate: integer('chat_date').notNull()
}, (table) => ({
  idxChatStatsUserId: index('idx_chat_stats_user_id').on(table.userId),
  idxChatStatsChatDate: index('idx_chat_stats_chat_date').on(table.chatDate)
}));

export const group_join_requests = sqliteTable('group_join_requests', {
  id: text('id').primaryKey(),
  groupId: text('group_id').notNull(),
  userId: text('user_id').notNull(),
  userName: text('user_name').default(''),
  status: text('status').default('pending'),
  reason: text('reason').default(''),
  reviewedBy: text('reviewed_by'),
  reviewedAt: integer('reviewed_at'),
  createdAt: integer('created_at').default(0)
}, (table) => ({
  idxGroupJoinRequestsGroupId: index('idx_group_join_requests_group_id').on(table.groupId),
  idxGroupJoinRequestsUserId: index('idx_group_join_requests_user_id').on(table.userId),
  idxGroupJoinRequestsStatus: index('idx_group_join_requests_status').on(table.status)
}));

export const reports = sqliteTable('reports', {
  id: text('id').primaryKey(),
  messageId: text('message_id').notNull(),
  sessionId: text('session_id').notNull(),
  reporterId: text('reporter_id').notNull(),
  reporterName: text('reporter_name').default(''),
  reportedUserId: text('reported_user_id').notNull(),
  reportedUserName: text('reported_user_name').default(''),
  reason: text('reason').notNull(),
  description: text('description').default(''),
  status: text('status').default('pending'),
  reviewedBy: text('reviewed_by'),
  reviewedAt: integer('reviewed_at'),
  result: text('result').default(''),
  createdAt: integer('created_at').default(0)
}, (table) => ({
  idxReportsStatus: index('idx_reports_status').on(table.status),
  idxReportsReporterId: index('idx_reports_reporter_id').on(table.reporterId),
  idxReportsReportedUserId: index('idx_reports_reported_user_id').on(table.reportedUserId),
  idxReportsCreatedAt: index('idx_reports_created_at').on(table.createdAt)
}));

export const message_reactions = sqliteTable('message_reactions', {
  id: text('id').primaryKey(),
  messageId: text('message_id').notNull(),
  userId: text('user_id').notNull(),
  emoji: text('emoji').notNull(),
  createdAt: integer('created_at').default(0)
}, (table) => ({
  idxMessageReactionsMessageId: index('idx_message_reactions_message_id').on(table.messageId),
  idxMessageReactionsUserId: index('idx_message_reactions_user_id').on(table.userId)
}));

export const message_reports = sqliteTable('message_reports', {
  id: text('id').primaryKey(),
  messageId: text('message_id').notNull(),
  reporterId: text('reporter_id').notNull(),
  reporterName: text('reporter_name').default(''),
  reportedUserId: text('reported_user_id').notNull(),
  reportedUserName: text('reported_user_name').default(''),
  reason: text('reason').notNull(),
  description: text('description').default(''),
  status: text('status').default('pending'),
  reviewedBy: text('reviewed_by'),
  reviewedAt: integer('reviewed_at'),
  result: text('result').default(''),
  createdAt: integer('created_at').default(0)
}, (table) => ({
  idxMessageReportsStatus: index('idx_message_reports_status').on(table.status),
  idxMessageReportsReporterId: index('idx_message_reports_reporter_id').on(table.reporterId),
  idxMessageReportsCreatedAt: index('idx_message_reports_created_at').on(table.createdAt)
}));
