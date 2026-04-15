-- ==================== 数据库迁移脚本 ====================
-- 用途: 初始化所有数据库表和索引
-- 执行方式: wrangler d1 migrations apply <database_name>
-- ============================================================

-- ==================== 版本信息 ====================
-- Version: 2.0.0
-- Date: 2026-04-12
-- Description: 根据 schema.ts 生成的完整迁移脚本

-- ==================== 用户表 ====================
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  avatar TEXT DEFAULT '',
  signature TEXT DEFAULT '',
  status TEXT DEFAULT 'offline',
  account_status TEXT DEFAULT 'normal',
  role TEXT DEFAULT 'user',
  disk INTEGER DEFAULT 5368709120,
  created_at INTEGER DEFAULT 0,
  last_login_at INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);

-- ==================== 会话表 ====================
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT,
  last_message TEXT DEFAULT '',
  last_message_encrypted INTEGER DEFAULT 0,
  last_time INTEGER DEFAULT 0,
  announcement TEXT DEFAULT '',
  owner_ids TEXT DEFAULT '[]',
  is_pinned INTEGER DEFAULT 0,
  is_muted INTEGER DEFAULT 0,
  require_approval INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sessions_type ON sessions(type);
CREATE INDEX IF NOT EXISTS idx_sessions_last_time ON sessions(last_time);

-- ==================== 会话参与者表 ====================
CREATE TABLE IF NOT EXISTS session_participants (
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (session_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_session_participants_session_id ON session_participants(session_id);
CREATE INDEX IF NOT EXISTS idx_session_participants_user_id ON session_participants(user_id);

-- ==================== 消息表 ====================
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT DEFAULT '',
  content TEXT NOT NULL,
  type INTEGER DEFAULT 1,
  encrypted INTEGER DEFAULT 0,
  time INTEGER DEFAULT 0,
  read INTEGER DEFAULT 0,
  recalled INTEGER DEFAULT 0,
  is_system INTEGER DEFAULT 0,
  is_deleted INTEGER DEFAULT 0,
  quote_id TEXT,
  reply_to_id TEXT,
  mentions TEXT,
  burn_after_reading INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(time);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

-- ==================== 附件表 ====================
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  url TEXT NOT NULL,
  encrypted INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments(message_id);

-- ==================== 消息已读表 ====================
CREATE TABLE IF NOT EXISTS message_reads (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  read_at INTEGER DEFAULT 0,
  PRIMARY KEY (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_message_reads_message_id ON message_reads(message_id);
CREATE INDEX IF NOT EXISTS idx_message_reads_user_id ON message_reads(user_id);

-- ==================== 管理员表 ====================
CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY,
  password TEXT NOT NULL,
  role TEXT DEFAULT 'super_admin',
  created_at INTEGER DEFAULT 0
);

-- ==================== 网盘文件表 ====================
CREATE TABLE IF NOT EXISTS drive_files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'file',
  size INTEGER DEFAULT 0,
  url TEXT NOT NULL DEFAULT '',
  owner_id TEXT NOT NULL,
  parent_id TEXT,
  storage_type TEXT DEFAULT 'r2',
  is_shared INTEGER DEFAULT 0,
  share_permission TEXT DEFAULT 'view',
  share_from TEXT,
  share_to_users TEXT DEFAULT '[]',
  share_to_groups TEXT DEFAULT '[]',
  share_link_token TEXT,
  deleted_at INTEGER,
  is_deleted INTEGER DEFAULT 0,
  is_encrypted INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT 0,
  updated_at INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_drive_files_owner_id ON drive_files(owner_id);
CREATE INDEX IF NOT EXISTS idx_drive_files_parent_id ON drive_files(parent_id);
CREATE INDEX IF NOT EXISTS idx_drive_files_is_deleted ON drive_files(is_deleted);

-- ==================== 系统设置表 ====================
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- ==================== 群附件表 ====================
CREATE TABLE IF NOT EXISTS group_attachments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  url TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  uploaded_by_name TEXT DEFAULT '',
  created_at INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_group_attachments_session_id ON group_attachments(session_id);

-- ==================== 快捷短语表 ====================
CREATE TABLE IF NOT EXISTS phrases (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  phrase TEXT NOT NULL,
  created_at INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_phrases_user_id ON phrases(user_id);

-- ==================== 通知表 ====================
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  data TEXT DEFAULT '{}',
  read INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);

-- ==================== 用户封禁表 ====================
CREATE TABLE IF NOT EXISTS user_bans (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  banned_by TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_user_bans_user_id ON user_bans(user_id);

-- ==================== 群组禁言表 ====================
CREATE TABLE IF NOT EXISTS group_mutes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  muted_by TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_group_mutes_session_id ON group_mutes(session_id);
CREATE INDEX IF NOT EXISTS idx_group_mutes_user_id ON group_mutes(user_id);

-- ==================== 用户设置表 ====================
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  theme TEXT DEFAULT 'light',
  font_size TEXT DEFAULT 'medium',
  message_sound INTEGER DEFAULT 1,
  group_mention INTEGER DEFAULT 1,
  online_notify INTEGER DEFAULT 1,
  offline_notify INTEGER DEFAULT 0,
  cannot_delete INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT 0,
  updated_at INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_user_settings_user_id ON user_settings(user_id);

-- ==================== 登录统计表 ====================
CREATE TABLE IF NOT EXISTS login_stats (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  login_at INTEGER NOT NULL,
  ip_address TEXT,
  device_info TEXT
);

CREATE INDEX IF NOT EXISTS idx_login_stats_user_id ON login_stats(user_id);
CREATE INDEX IF NOT EXISTS idx_login_stats_login_at ON login_stats(login_at);

-- ==================== 聊天统计表 ====================
CREATE TABLE IF NOT EXISTS chat_stats (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message_count INTEGER DEFAULT 1,
  chat_date INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_stats_user_id ON chat_stats(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_stats_chat_date ON chat_stats(chat_date);

-- ==================== 群组加入申请表 ====================
CREATE TABLE IF NOT EXISTS group_join_requests (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  reason TEXT DEFAULT '',
  reviewed_by TEXT,
  reviewed_at INTEGER,
  created_at INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_group_join_requests_group_id ON group_join_requests(group_id);
CREATE INDEX IF NOT EXISTS idx_group_join_requests_user_id ON group_join_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_group_join_requests_status ON group_join_requests(status);

-- ==================== 消息反应表 ====================
CREATE TABLE IF NOT EXISTS message_reactions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_message_reactions_message_id ON message_reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_message_reactions_user_id ON message_reactions(user_id);

-- ==================== 消息举报表 ====================
CREATE TABLE IF NOT EXISTS message_reports (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  reporter_id TEXT NOT NULL,
  reporter_name TEXT DEFAULT '',
  reported_user_id TEXT NOT NULL,
  reported_user_name TEXT DEFAULT '',
  reason TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  reviewed_by TEXT,
  reviewed_at INTEGER,
  result TEXT DEFAULT '',
  created_at INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_message_reports_status ON message_reports(status);
CREATE INDEX IF NOT EXISTS idx_message_reports_reporter_id ON message_reports(reporter_id);
CREATE INDEX IF NOT EXISTS idx_message_reports_created_at ON message_reports(created_at);

-- ==================== 通用举报表 ====================
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  reporter_id TEXT NOT NULL,
  reporter_name TEXT DEFAULT '',
  reported_user_id TEXT NOT NULL,
  reported_user_name TEXT DEFAULT '',
  reason TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  reviewed_by TEXT,
  reviewed_at INTEGER,
  result TEXT DEFAULT '',
  created_at INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_reporter_id ON reports(reporter_id);
CREATE INDEX IF NOT EXISTS idx_reports_reported_user_id ON reports(reported_user_id);
CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports(created_at);

-- ==================== 迁移完成 ====================
-- 表数量: 17
-- 索引数量: 约 35+
