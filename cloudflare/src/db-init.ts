// 数据库初始化脚本 - 一次性创建所有表和索引

import { getPasswordSalt, hashPassword } from './auth';


export const CREATE_TABLES_SQL = `
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
  role TEXT DEFAULT 'user' CHECK (role IN ('user', 'vip', 'admin', 'super_admin')),
  disk INTEGER DEFAULT 5368709120,
  created_at INTEGER DEFAULT 0,
  last_login_at INTEGER DEFAULT 0
);

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

-- ==================== 会话参与者表 ====================
CREATE TABLE IF NOT EXISTS session_participants (
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (session_id, user_id)
);

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

-- ==================== 消息已读表 ====================
CREATE TABLE IF NOT EXISTS message_reads (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  read_at INTEGER DEFAULT 0,
  PRIMARY KEY (message_id, user_id)
);

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

-- ==================== 快捷短语表 ====================
CREATE TABLE IF NOT EXISTS phrases (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  phrase TEXT NOT NULL,
  created_at INTEGER DEFAULT 0
);

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

-- ==================== 登录统计表 ====================
CREATE TABLE IF NOT EXISTS login_stats (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  login_at INTEGER NOT NULL,
  ip_address TEXT,
  device_info TEXT
);

-- ==================== 聊天统计表 ====================
CREATE TABLE IF NOT EXISTS chat_stats (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message_count INTEGER DEFAULT 1,
  chat_date INTEGER NOT NULL
);

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

-- ==================== 用户封禁表 ====================
CREATE TABLE IF NOT EXISTS user_bans (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  reason TEXT DEFAULT '',
  banned_by TEXT NOT NULL,
  created_at INTEGER DEFAULT 0
);

-- ==================== 消息收藏表 (表情反应) ====================
CREATE TABLE IF NOT EXISTS message_reactions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at INTEGER DEFAULT 0
);

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
`;

export const CREATE_INDEXES_SQL = `
-- ==================== 用户表索引 ====================
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_last_login ON users(last_login_at);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);

-- ==================== 会话表索引 ====================
CREATE INDEX IF NOT EXISTS idx_sessions_type ON sessions(type);
CREATE INDEX IF NOT EXISTS idx_sessions_last_time ON sessions(last_time);

-- ==================== 会话参与者索引 ====================
CREATE INDEX IF NOT EXISTS idx_participants_session ON session_participants(session_id);
CREATE INDEX IF NOT EXISTS idx_participants_user ON session_participants(user_id);

-- ==================== 消息表索引 ====================
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_session_time ON messages(session_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(time);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

-- ==================== 附件表索引 ====================
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

-- ==================== 已读表索引 ====================
CREATE INDEX IF NOT EXISTS idx_reads_message ON message_reads(message_id);
CREATE INDEX IF NOT EXISTS idx_reads_user ON message_reads(user_id);

-- ==================== 网盘文件索引 ====================
CREATE INDEX IF NOT EXISTS idx_drive_owner ON drive_files(owner_id);
CREATE INDEX IF NOT EXISTS idx_drive_parent ON drive_files(parent_id);
CREATE INDEX IF NOT EXISTS idx_drive_shared ON drive_files(is_shared);
CREATE INDEX IF NOT EXISTS idx_drive_deleted ON drive_files(is_deleted);
CREATE INDEX IF NOT EXISTS idx_drive_owner_parent ON drive_files(owner_id, parent_id, is_deleted);
CREATE INDEX IF NOT EXISTS idx_drive_owner_recent ON drive_files(owner_id, is_deleted, storage_type, created_at);

-- ==================== 群附件索引 ====================
CREATE INDEX IF NOT EXISTS idx_group_attachments_session ON group_attachments(session_id);

-- ==================== 快捷短语索引 ====================
CREATE INDEX IF NOT EXISTS idx_phrases_user ON phrases(user_id);

-- ==================== 通知索引 ====================
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);

-- ==================== 登录统计索引 ====================
CREATE INDEX IF NOT EXISTS idx_login_stats_user ON login_stats(user_id);
CREATE INDEX IF NOT EXISTS idx_login_stats_login_at ON login_stats(login_at);

-- ==================== 聊天统计索引 ====================
CREATE INDEX IF NOT EXISTS idx_chat_stats_user ON chat_stats(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_stats_date ON chat_stats(chat_date);

-- ==================== 用户设置表索引 ====================
CREATE INDEX IF NOT EXISTS idx_user_settings_user ON user_settings(user_id);
CREATE INDEX IF NOT EXISTS idx_user_settings_updated ON user_settings(updated_at);

-- ==================== 用户封禁表索引 ====================
CREATE INDEX IF NOT EXISTS idx_user_bans_user_id ON user_bans(user_id);

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

-- ==================== 群组加入申请索引 ====================
CREATE INDEX IF NOT EXISTS idx_group_join_requests_group_id ON group_join_requests(group_id);
CREATE INDEX IF NOT EXISTS idx_group_join_requests_user_id ON group_join_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_group_join_requests_status ON group_join_requests(status);

-- ==================== 消息收藏表索引 ====================
CREATE INDEX IF NOT EXISTS idx_message_reactions_message_id ON message_reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_message_reactions_user_id ON message_reactions(user_id);

-- ==================== 消息举报表索引 ====================
CREATE INDEX IF NOT EXISTS idx_message_reports_status ON message_reports(status);
CREATE INDEX IF NOT EXISTS idx_message_reports_reporter_id ON message_reports(reporter_id);
CREATE INDEX IF NOT EXISTS idx_message_reports_created_at ON message_reports(created_at);
`;

export async function initDatabase(DB: D1Database, adminPassword?: string, env?: { PASSWORD_SALT?: string }): Promise<void> {
  // 创建所有表
  const tables = CREATE_TABLES_SQL.split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));
  
  for (const tableSQL of tables) {
    try {
      await DB.exec(tableSQL);
    } catch (error) {
      console.error('Error creating table:', error);
    }
  }
  
  // 创建所有索引
  const indexes = CREATE_INDEXES_SQL.split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));
  
  for (const indexSQL of indexes) {
    try {
      await DB.exec(indexSQL);
    } catch (error) {
      console.error('Error creating index:', error);
    }
  }
  
  // 自动创建管理员（如果 admins 表为空且提供了密码）
  if (adminPassword) {
    try {
      const result = await DB.prepare(`SELECT COUNT(*) as count FROM admins`).first<{ count: number }>();
      
      if (result && result.count === 0) {
        const hashedPassword = await hashPassword(adminPassword, env);
        const adminId = crypto.randomUUID();
        await DB.exec(`INSERT INTO admins (id, password, role, created_at) VALUES ('${adminId}', '${hashedPassword}', 'super_admin', ${Date.now()})`);
      }
    } catch (error) {
      console.error('[DB] 创建管理员失败:', error);
    }
  }
}
