import React, { useState, useEffect, useRef } from 'react';
import { API } from '../../config/api';

import { formatTimestamp, getServerTimestamp, convertServerTime } from '../../utils/time';
import { truncateText, getErrorMessage, isNetworkError, isTimeoutError } from '../../utils/helpers';
import { toast } from '../../utils/toast';
import { showConfirm, ConfirmDialog, subscribeConfirmDialog, resolveConfirm } from '../ConfirmDialog';
import { showInput } from '../InputDialog';
import { MoreVertical, Edit, MessageCircle, Ban, Trash2, UserCog, Users, MessageSquare, UsersRound, HardDrive, Database, BarChart3, Save, Cloud, UserX, VolumeX, AlertTriangle, Check, Flag } from 'lucide-react';
import { adminApiFetch } from '../../utils/csrf';
import { getReportReasonLabel } from '../../utils/report';

interface User {
  id: string;
  name: string;
  username: string;
  avatar: string;
  status: string;
  accountStatus?: string;
  role: string;
  isMuted?: boolean;
  createdAt: number;
  lastLoginAt?: number;
}

interface Group {
  id: string;
  name: string;
  type: string;
  announcement: string;
  owner_ids: string;
  members: User[];
  memberCount: number;
  createdAt: number;
}

interface Stats {
  users: number;
  groups: number;
  messages: number;
  sessions: number;
}

interface Session {
  id: string;
  type: 'friend' | 'group';
  name: string;
  last_message: string;
  last_time: number;
  participant_names: string;
  members?: User[];
  created_at: number;
}

interface DiskInfo {
  uploads: number;
  database: number;
  total: number;
}

interface DriveSettings {
  storageType: string;
  chatStorageType: string;
  r2: { bucket: string };
  kv: { namespace: string };
  pcloud: { token: string; folderId: string };
  google: { token: string; folderId: string };
}

interface DriveStats {
  storageType?: string;
  files: number;
  folders: number;
  trashed: number;
  totalSize: number;
}

interface UserStorageInfo {
  id: string;
  name: string;
  username: string;
  fileCount: number;
  totalSize: number;
  disk: number;
  storageLimit?: number;
}

export const AdminPanel: React.FC<{ token: string | null; isSuperAdmin: boolean; userToken?: string; onLogout: () => void }> = ({ token, isSuperAdmin, userToken, onLogout }) => {
  const [activeTab, setActiveTab] = useState<'users' | 'sessions' | 'groups' | 'stats' | 'backup' | 'drive' | 'storage' | 'reports'>('users');
  const [users, setUsers] = useState<User[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [stats, setStats] = useState<Stats>({ users: 0, groups: 0, messages: 0, sessions: 0 });
  const [diskInfo, setDiskInfo] = useState<DiskInfo>({ uploads: 0, database: 0, total: 0 });
  const isMountedRef = useRef(true);
  
  // 独立的 loading 状态
  type TabKey = 'users' | 'sessions' | 'groups' | 'stats' | 'backup' | 'drive' | 'storage' | 'reports';
  const [loading, setLoading] = useState<Record<TabKey, boolean>>({ users: false, sessions: false, groups: false, stats: false, backup: false, drive: false, storage: false, reports: false });
  const setTabLoading = (tab: TabKey, value: boolean) => {
    if (isMountedRef.current) setLoading(prev => ({ ...prev, [tab]: value }));
  };
  const [keyword, setKeyword] = useState('');
  const [searchInput, setSearchInput] = useState(''); // 前端搜索输入
  const [sessionType, setSessionType] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pageSize = 20;
  
  const [reportsCache, setReportsCache] = useState<any[]>([]);
  const [reportStatus, setReportStatus] = useState('all');
  const [reportsPage, setReportsPage] = useState(1);
  const [reportsTotal, setReportsTotal] = useState(0);
  const reportsPageSize = 20;
  
  // 数据缓存
  const [usersCache, setUsersCache] = useState<User[]>([]);
  const [groupsCache, setGroupsCache] = useState<Group[]>([]);
  
  // 用户菜单状态
  const [showUserMenu, setShowUserMenu] = useState<string | null>(null);
  const [showSessionMenu, setShowSessionMenu] = useState<string | null>(null);
  const [showGroupMenu, setShowGroupMenu] = useState<string | null>(null);
  const [showReportMenu, setShowReportMenu] = useState<string | null>(null);
  const [selectedReports, setSelectedReports] = useState<Set<string>>(new Set());
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const itemListRef = useRef<HTMLDivElement>(null);
  const [sessionsCache, setSessionsCache] = useState<Session[]>([]);
  const [cacheLoaded, setCacheLoaded] = useState<{[key: string]: boolean}>({
    users: false, sessions: false, groups: false, reports: false
  });
  
  const [backups, setBackups] = useState<{ key: string; size: number; uploaded: number }[]>([]);
  const [chatBackups, setChatBackups] = useState<{ key: string; size: number; uploaded: number }[]>([]);
  const [driveBackups, setDriveBackups] = useState<{ key: string; size: number; uploaded: number }[]>([]);
  const [showBackupModal, setShowBackupModal] = useState(false);
  const [backupLoading, setBackupLoading] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [chatBackupLoading, setChatBackupLoading] = useState(false);
  const [driveBackupLoading, setDriveBackupLoading] = useState(false);
  const [chatRestoreLoading, setChatRestoreLoading] = useState(false);
  const [driveRestoreLoading, setDriveRestoreLoading] = useState(false);
  
  const [driveSettings, setDriveSettings] = useState<DriveSettings>({
    storageType: 'r2',
    chatStorageType: 'r2',
    r2: { bucket: '' },
    kv: { namespace: '' },
    pcloud: { token: '', folderId: '0' },
    google: { token: '', folderId: '' }
  });
  const [driveStats, setDriveStats] = useState<DriveStats>({ files: 0, folders: 0, trashed: 0, totalSize: 0 });
  const [driveSettingsLoading, setDriveSettingsLoading] = useState(false);
  const [driveSettingsSaved, setDriveSettingsSaved] = useState(false);
  const [userStorageList, setUserStorageList] = useState<UserStorageInfo[]>([]);
  const [showStorageLimitModal, setShowStorageLimitModal] = useState(false);
  const [storageLimitUser, setStorageLimitUser] = useState<UserStorageInfo | null>(null);
  const [storageLimitValue, setStorageLimitValue] = useState<string>('');
  
  const [showUserModal, setShowUserModal] = useState(false);
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [showUserMessages, setShowUserMessages] = useState(false);
  const [userMessages, setUserMessages] = useState<any[]>([]);
  const [showSessionModal, setShowSessionModal] = useState(false);
  const [showAddMemberModal, setShowAddMemberModal] = useState(false);
  const [showSessionDetailModal, setShowSessionDetailModal] = useState(false);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set());
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set());
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [showBatchUserModal, setShowBatchUserModal] = useState(false);
  const [batchUserInput, setBatchUserInput] = useState('');
  const [showBatchGroupModal, setShowBatchGroupModal] = useState(false);
  const [batchGroupInput, setBatchGroupInput] = useState('');
  const [showBatchSessionModal, setShowBatchSessionModal] = useState(false);
  const [batchSessionInput, setBatchSessionInput] = useState('');
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  
  // 确认对话框状态
  const [confirmState, setConfirmState] = useState({
    open: false,
    title: '',
    message: '',
    type: 'info' as 'danger' | 'warning' | 'info'
  });
  
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [editingGroup, setEditingGroup] = useState<Group | null>(null);
  
  const [formData, setFormData] = useState({
    name: '', username: '', password: '', status: 'online'
  });
  const [showPassword, setShowPassword] = useState(false);
  const [groupFormData, setGroupFormData] = useState({
    name: '', announcement: '', memberIds: [] as string[]
  });
  const [sessionFormData, setSessionFormData] = useState({
    name: '', userId1: '', userId2: ''
  });
  const [addMemberData, setAddMemberData] = useState<{
    userIds: string[];
    addAllUsers?: boolean;
  }>({ userIds: [], addAllUsers: false });
  const [sessionDetail, setSessionDetail] = useState<any>(null);
  
  const authToken = token || userToken || localStorage.getItem('adminToken');
  console.log(authToken);
  const headers = { 'Authorization': `Bearer ${authToken}` };

  // 前端过滤函数
  const filterData = <T extends Record<string, any>>(data: T[], searchKeyword: string): T[] => {
    if (!searchKeyword) return data;
    const kw = searchKeyword.toLowerCase();
    return data.filter(item => {
      for (const key in item) {
        const value = item[key];
        if (typeof value === 'string' && value.toLowerCase().includes(kw)) {
          return true;
        }
      }
      return false;
    });
  };

  // 获取过滤后的数据
  const getFilteredUsers = () => filterData(usersCache, keyword);
  const getFilteredGroups = () => filterData(groupsCache, keyword);
  const getFilteredSessions = () => {
    let data = filterData(sessionsCache, keyword);
    if (sessionType) {
      data = data.filter(s => s.type === sessionType);
    }
    return data;
  };

  // 获取分页数据
  const getPaginatedData = <T extends any>(data: T[], page: number): { list: T[], total: number } => {
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    return {
      list: data.slice(start, end),
      total: data.length
    };
  };

  const fetchUsers = async (forceRefresh = false) => {
    if (!forceRefresh && cacheLoaded.users && usersCache.length > 0) {
      setTabLoading('users', false);
      return;
    }
    setTabLoading('users', true);
    try {
      const res = await adminApiFetch(`${API.admin.users}?page=1&limit=1000`, { requireCsrf: false });
      const data = await res.json();
      if (data.success) {
        setUsersCache(data.data.list);
        setUsers(data.data.list.slice(0, pageSize));
        setTotal(data.data.list.length);
        setCacheLoaded(prev => ({ ...prev, users: true }));
      }
    } catch (e) { console.error(e); }
    setTabLoading('users', false);
  };

  const fetchGroups = async (forceRefresh = false) => {
    if (!forceRefresh && cacheLoaded.groups && groupsCache.length > 0) {
      setTabLoading('groups', false);
      return;
    }
    setTabLoading('groups', true);
    try {
      const res = await adminApiFetch(`${API.admin.groups}?page=1&limit=1000`, { requireCsrf: false });
      const data = await res.json();
      if (data.success) {
        setGroupsCache(data.data.list);
        setGroups(data.data.list.slice(0, pageSize));
        setTotal(data.data.list.length);
        setCacheLoaded(prev => ({ ...prev, groups: true }));
      }
    } catch (e) { console.error(e); }
    setTabLoading('groups', false);
  };

  const fetchSessions = async (forceRefresh = false) => {
    if (!forceRefresh && cacheLoaded.sessions && sessionsCache.length > 0) {
      setTabLoading('sessions', false);
      return;
    }
    setTabLoading('sessions', true);
    try {
      const res = await adminApiFetch(`${API.admin.sessions}?page=1&limit=1000`, { requireCsrf: false });
      const data = await res.json();
      if (data.success) {
        setSessionsCache(data.data.list);
        setSessions(data.data.list.slice(0, pageSize));
        setTotal(data.data.list.length);
        setCacheLoaded(prev => ({ ...prev, sessions: true }));
      }
    } catch (e) { console.error(e); }
    setTabLoading('sessions', false);
  };

  const fetchAllUsers = async () => {
    try {
      const res = await adminApiFetch(API.admin.allUsers, { requireCsrf: false });
      const data = await res.json();
      if (data.success) setAllUsers(data.data);
    } catch (e) { console.error(e); }
  };

  const fetchStats = async () => {
    setTabLoading('stats', true);
    const authToken = token || userToken;
    const adminHeaders = { 'Authorization': `Bearer ${authToken}` };
    try {
      const [statsRes, diskRes, driveStatsRes] = await Promise.all([
        adminApiFetch(API.admin.stats, { headers: adminHeaders, requireCsrf: false }),
        adminApiFetch(API.admin.disk, { headers: adminHeaders, requireCsrf: false }),
        adminApiFetch(`${API.admin.driveStats}?storageType=${driveSettings.storageType}`, { headers: adminHeaders, requireCsrf: false })
      ]);
      const statsData = await statsRes.json();
      const diskData = await diskRes.json();
      const driveStatsData = await driveStatsRes.json();
      if (statsData.success) setStats(statsData.data);
      if (diskData.success) setDiskInfo(diskData.data);
      if (driveStatsData.success) setDriveStats(driveStatsData.data);
    } catch (e) { console.error(e); }
    setTabLoading('stats', false);
  };

  const fetchBackups = async () => {
    setTabLoading('backup', true);
    try {
      // 获取聊天备份
      const chatRes = await adminApiFetch(API.admin.backups.chat, { requireCsrf: false });
      const chatData = await chatRes.json();
      if (chatData.success) setChatBackups(chatData.data);
      // 处理chat备份key的前缀
      chatData.data.forEach(e => e.key = e.key.replace("chat/backup/", "") );

      // 获取网盘备份
      const driveRes = await adminApiFetch(API.admin.backups.drive, { requireCsrf: false });
      const driveData = await driveRes.json();
      if (driveData.success) setDriveBackups(driveData.data);
      // 处理chat备份key的前缀
      driveData.data.forEach(e => e.key = e.key.replace("drive/backup/", "") );
    } catch (e) { console.error(e); }
    setTabLoading('backup', false);
  };

  // 聊天备份
  const handleChatBackup = async () => {
    setChatBackupLoading(true);
    try {
      const res = await adminApiFetch(API.admin.backups.backupChat, { headers });
      const data = await res.json();
      if (data.success) {
        toast.success('聊天数据备份成功');
        fetchBackups();
      } else {
        toast.error('操作失败', data.message || '备份失败');
      }
    } catch (e) { toast.error('备份失败'); }
    setChatBackupLoading(false);
  };

  const handleChatRestore = async (backupKey: string) => {
    if (!(await showConfirm({ title: '确认', message: '确定要还原此聊天备份吗？当前聊天数据将被覆盖。', type: 'danger' }))) return;
    setChatRestoreLoading(true);
    try {
      const res = await adminApiFetch(API.admin.backups.restoreChat, {
        method: 'POST',
        headers,
        body: JSON.stringify({ backupKey })
      });
      const data = await res.json();
      if (data.success) {
        toast.success('还原成功');
      } else {
        toast.error('操作失败', data.message || '还原失败');
      }
    } catch (e) { toast.error('还原失败'); }
    setChatRestoreLoading(false);
  };

  const handleChatDelete = async (backupKey: string) => {
    if (!(await showConfirm({ title: '确认', message: '确定要删除此备份吗？', type: 'danger' }))) return;
    try {
      const res = await adminApiFetch(API.admin.backups.chatBackup(backupKey), {
        method: 'DELETE',
        headers
      });
      const data = await res.json();
      if (data.success) {
        fetchBackups();
      } else {
        toast.error('操作失败', data.message || '删除失败');
      }
    } catch (e) { toast.error('删除失败'); }
  };

  const handleChatDownload = async (backupKey: string) => {
    try {
      const res = await adminApiFetch(API.admin.backups.chatDownload(backupKey), { requireCsrf: false });
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = backupKey;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        toast.error('下载失败');
      }
    } catch (e) { toast.error('下载失败'); }
  };

  // 网盘备份
  const handleDriveBackup = async () => {
    setDriveBackupLoading(true);
    try {
      const res = await adminApiFetch(API.admin.backups.backupDrive, { headers });
      const data = await res.json();
      if (data.success) {
        toast.success('网盘数据备份成功');
        fetchBackups();
      } else {
        toast.error('操作失败', data.message || '备份失败');
      }
    } catch (e) { toast.error('备份失败'); }
    setDriveBackupLoading(false);
  };

  const handleDriveRestore = async (backupKey: string) => {
    if (!(await showConfirm({ title: '确认', message: '确定要还原此网盘备份吗？当前网盘数据将被覆盖。', type: 'danger' }))) return;
    setDriveRestoreLoading(true);
    try {
      const res = await adminApiFetch(API.admin.backups.restoreDrive, {
        method: 'POST',
        headers,
        body: JSON.stringify({ backupKey })
      });
      const data = await res.json();
      if (data.success) {
        toast.success('还原成功');
      } else {
        toast.error('操作失败', data.message || '还原失败');
      }
    } catch (e) { toast.error('还原失败'); }
    setDriveRestoreLoading(false);
  };

  const handleDriveDelete = async (backupKey: string) => {
    if (!(await showConfirm({ title: '确认', message: '确定要删除此备份吗？', type: 'danger' }))) return;
    try {
      const res = await adminApiFetch(API.admin.backups.driveBackup(backupKey), {
        method: 'DELETE',
        headers
      });
      const data = await res.json();
      if (data.success) {
        fetchBackups();
      } else {
        toast.error('操作失败', data.message || '删除失败');
      }
    } catch (e) { toast.error('删除失败'); }
  };

  const handleDriveDownload = async (backupKey: string) => {
    try {
      const encodedKey = encodeURIComponent(backupKey);
      const res = await adminApiFetch(API.admin.backups.driveDownload(encodedKey), { requireCsrf: false });
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = backupKey;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        toast.error('下载失败');
      }
    } catch (e) { toast.error('下载失败'); }
  };

  const handleCreateBackup = async () => {
    setBackupLoading(true);
    try {
      const res = await adminApiFetch(API.admin.backups.backupDownload, { 
        headers,
        requireCsrf: false
      });
      if (res.ok) {
        const blob = await res.blob();
        const backupKey = `backup_${Date.now()}.json`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = backupKey;
        a.click();
        URL.revokeObjectURL(url);
        toast.success('备份已下载');
      } else {
        const data = await res.json();
        toast.error('操作失败', data.message || '备份失败');
      }
    } catch (e) { toast.error('备份失败'); }
    setBackupLoading(false);
  };

  const handleRestoreBackup = async (backupKey: string) => {
    if (!(await showConfirm({ title: '确认', message: '确定要还原此备份吗？当前数据将被覆盖。', type: 'danger' }))) return;
    setRestoreLoading(true);
    try {
      const res = await adminApiFetch(`${API.admin.backups.restore}?key=${encodeURIComponent(backupKey)}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ backupKey })
      });
      const data = await res.json();
      if (data.success) {
        toast.success('还原成功');
        fetchBackups();
      } else {
        toast.error('操作失败', data.message || '还原失败');
      }
    } catch (e) { toast.error('还原失败'); }
    setRestoreLoading(false);
  };

  const handleDownloadBackup = async (backupKey: string) => {
    try {
      const res = await adminApiFetch(`${API.admin.backups.backupDownload}?key=${encodeURIComponent(backupKey)}`, { requireCsrf: false });
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = backupKey;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        toast.error('下载失败');
      }
    } catch (e) { toast.error('下载失败'); }
  };

  const handleDeleteBackup = async (backupKey: string) => {
    if (!(await showConfirm({ title: '确认', message: '确定要删除此备份吗？', type: 'danger' }))) return;
    try {
      const res = await adminApiFetch(API.admin.backups.backup(backupKey), {
        method: 'DELETE',
        headers
      });
      const data = await res.json();
      if (data.success) {
        fetchBackups();
      } else {
        toast.error('操作失败', data.message || '删除失败');
      }
    } catch (e) { toast.error('删除失败'); }
  };

  const handleClearDatabase = async () => {
    if (!(await showConfirm({ title: '确认', message: '确定要清空所有聊天记录吗？此操作将清空：\n- 所有会话\n- 所有消息\n- 所有聊天附件\n- 所有群附件\n\n保留：用户、管理员、网盘文件', type: 'danger' }))) return;
    setBackupLoading(true);
    try {
      const res = await adminApiFetch(API.admin.clearDatabase, {
        method: 'POST',
        headers
      });
      const data = await res.json();
      if (data.success) {
        toast.success('清空成功', data.message);
        fetchBackups();
      } else {
        toast.error('操作失败', data.message || '清空失败');
      }
    } catch (e) { toast.error('清空失败'); }
    setBackupLoading(false);
  };

  const handleClearDriveFiles = async () => {
    const storageType = driveSettings?.storageType || 'r2';
    if (!(await showConfirm({ title: '确认', message: `确定要清空当前网盘(${storageType})的所有文件吗？此操作不可恢复。`, type: 'danger' }))) return;
    setBackupLoading(true);
    try {
      const res = await adminApiFetch(API.admin.clearDriveFiles, {
        method: 'POST',
        headers
      });
      const data = await res.json();
      if (data.success) {
        toast.success('清空成功', data.message);
      } else {
        toast.error('操作失败', data.message || '清空失败');
      }
    } catch (e) { toast.error('清空失败'); }
    setBackupLoading(false);
  };

  const fetchDriveSettings = async () => {
    const authToken = token || userToken || localStorage.getItem('adminToken') || '';
    const adminHeaders = { 'Authorization': `Bearer ${authToken}` };
    try {
      const res = await adminApiFetch(API.admin.driveSettings, { headers: adminHeaders, requireCsrf: false });
      const data = await res.json();
      if (data.success) {
        setDriveSettings({
          storageType: data.data.storageType || 'r2',
          chatStorageType: data.data.chatStorageType || 'r2',
          r2: data.data.r2 || { bucket: '' },
          kv: data.data.kv || { namespace: '' },
          pcloud: data.data.pcloud || { token: '', folderId: '' },
          google: data.data.google || { token: '', folderId: '' }
        });
      }
    } catch (e) { console.error(e); }
  };

  const fetchDriveStats = async (storageType?: string) => {
    setTabLoading('drive', true);
    const authToken = token || userToken || localStorage.getItem('adminToken') || '';
    const adminHeaders = { 'Authorization': `Bearer ${authToken}` };
    try {
      const url = storageType 
        ? `${API.admin.driveStats}?storageType=${storageType}`
        : API.admin.driveStats;
      const res = await adminApiFetch(url, { headers: adminHeaders, requireCsrf: false });
      const data = await res.json();
      if (data.success) {
        setDriveStats(data.data);
      }
    } catch (e) { console.error(e); }
    setTabLoading('drive', false);
  };

  const handleSaveDriveSettings = async () => {
    // 如果文件夹ID为空，设置成对应的根目录ID
    const settingsToSave = { ...driveSettings };
    if (driveSettings.storageType === 'pcloud' && !driveSettings.pcloud.folderId) {
      settingsToSave.pcloud = { ...driveSettings.pcloud, folderId: '0' };
    }
    if (driveSettings.storageType === 'google' && !driveSettings.google.folderId) {
      settingsToSave.google = { ...driveSettings.google, folderId: 'root' };
    }
    
    setDriveSettingsLoading(true);
    try {
      const res = await adminApiFetch(API.admin.driveSettings, {
        method: 'POST',
        headers,
        body: JSON.stringify(settingsToSave)
      });
      const data = await res.json();
      if (data.success) {
        setDriveSettingsSaved(true);
        setTimeout(() => setDriveSettingsSaved(false), 3000);
      } else {
        toast.error('操作失败', data.message || '保存失败');
      }
    } catch (e) { toast.error('保存失败'); }
    setDriveSettingsLoading(false);
  };

  const fetchReports = async (forceRefresh = false) => {
    if (!forceRefresh && cacheLoaded.reports && reportsCache.length > 0) {
      setTabLoading('reports', false);
      return;
    }
    setTabLoading('reports', true);
    try {
      const params = new URLSearchParams({
        page: String(reportsPage),
        limit: String(reportsPageSize),
        status: reportStatus
      });
      const res = await adminApiFetch(`${API.admin.reports}?${params}`, { requireCsrf: false });
      const data = await res.json();
      if (data.success) {
        setReportsCache(Array.isArray(data.data) ? data.data : []);
        setReportsTotal(data.total || 0);
        setCacheLoaded(prev => ({ ...prev, reports: true }));
      }
    } catch (e) { console.error(e); }
    setTabLoading('reports', false);
  };

  const handleReport = async (reportId: string, action: 'dismiss' | 'delete_message' | 'ban_user') => {
    try {
      const res = await adminApiFetch(API.admin.report(reportId), {
        method: 'POST',
        headers,
        body: JSON.stringify({ action })
      });
      const data = await res.json();
      if (data.success) {
        toast.success(data.message || '处理成功');
        fetchReports(true);
      } else {
        toast.error('操作失败', data.message);
      }
    } catch (e) {
      toast.error('操作失败');
    }
  };

  const handleDeleteReport = async (reportId: string) => {
    if (!(await showConfirm({ title: '确认', message: '确定要删除该举报吗？', type: 'danger' }))) return;
    try {
      const res = await adminApiFetch(API.admin.reportDelete(reportId), {
        method: 'DELETE',
        headers
      });
      const data = await res.json();
      if (data.success) {
        toast.success('删除成功');
        fetchReports(true);
      } else {
        toast.error('操作失败', data.message);
      }
    } catch (e) {
      toast.error('操作失败');
    }
  };

  const handleBatchDeleteReports = async () => {
    if (selectedReports.size === 0) {
      toast.error('请选择要删除的举报');
      return;
    }
    if (!(await showConfirm({ title: '确认', message: `确定要删除选中的 ${selectedReports.size} 条举报吗？`, type: 'danger' }))) return;
    try {
      const res = await adminApiFetch(API.admin.batchDeleteReports, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ids: Array.from(selectedReports) })
      });
      const data = await res.json();
      if (data.success) {
        toast.success(data.message || '删除成功');
        setSelectedReports(new Set());
        fetchReports(true);
      } else {
        toast.error('操作失败', data.message);
      }
    } catch (e) {
      toast.error('操作失败');
    }
  };

  const fetchUserStorageList = async () => {
    try {
      setTabLoading('storage', true);
      const res = await adminApiFetch(API.admin.driveUsers, { requireCsrf: false });
      const data = await res.json();
      if (data.success) {
        setUserStorageList(data.data);
      }
    } catch (e) { console.error(e); } finally {
      setTabLoading('storage', false);
    }
  };

  const handleUpdateStorageLimit = async () => {
    if (!storageLimitUser) return;
    try {
      const res = await adminApiFetch(API.admin.driveUserLimit(storageLimitUser.id), {
        method: 'POST',
        headers,
        body: JSON.stringify({ storageLimit: parseInt(storageLimitValue) || 0 })
      });
      const data = await res.json();
      if (data.success) {
        toast.success('存储限制已更新');
        setShowStorageLimitModal(false);
        fetchUserStorageList();
      }
    } catch (e) { toast.error('更新失败'); }
  };

  useEffect(() => {
    setCurrentPage(1);
  }, [keyword, sessionType, activeTab]);

  // 从 localStorage 恢复 activeTab
  useEffect(() => {
    const savedTab = localStorage.getItem('adminActiveTab');
    if (savedTab && ['users', 'sessions', 'groups', 'stats', 'backup', 'drive', 'storage', 'reports'].includes(savedTab)) {
      setActiveTab(savedTab as any);
    }
  }, []);

  // 保存 activeTab 到 localStorage
  useEffect(() => {
    localStorage.setItem('adminActiveTab', activeTab);
  }, [activeTab]);

  // 切换页面时清除选择状态
  useEffect(() => {
    setSelectedUsers(new Set());
    setSelectedSessions(new Set());
    setSelectedGroups(new Set());
    // 重置所有 loading 状态
    setLoading({ users: false, sessions: false, groups: false, stats: false, backup: false, drive: false, storage: false, reports: false });
  }, [activeTab]);

  // 数据加载和缓存逻辑
  useEffect(() => {
    if (activeTab === 'users') {
      if (!cacheLoaded.users) {
        fetchUsers(true);
      } else {
        const filtered = getFilteredUsers();
        const paginated = getPaginatedData(filtered, currentPage);
        setUsers(paginated.list);
        setTotal(filtered.length);
      }
    }
    else if (activeTab === 'sessions') {
      if (!cacheLoaded.sessions) {
        fetchSessions(true);
      } else {
        const filtered = getFilteredSessions();
        const paginated = getPaginatedData(filtered, currentPage);
        setSessions(paginated.list);
        setTotal(filtered.length);
      }
      fetchAllUsers();
    }
    else if (activeTab === 'groups') {
      if (!cacheLoaded.groups) {
        fetchGroups(true);
      } else {
        const filtered = getFilteredGroups();
        const paginated = getPaginatedData(filtered, currentPage);
        setGroups(paginated.list);
        setTotal(filtered.length);
      }
    }
    else if (activeTab === 'stats') { 
      setTabLoading('stats', true);
      fetchDriveSettings().then(() => fetchStats()); 
    }
    else if (activeTab === 'backup') fetchBackups();
    else if (activeTab === 'drive') { 
      setTabLoading('drive', true);
      fetchDriveSettings().then(() => { fetchDriveStats(); }); 
    }
    else if (activeTab === 'storage') { fetchUserStorageList(); }
    else if (activeTab === 'reports') { fetchReports(true); }
  }, [activeTab, currentPage, keyword, sessionType, cacheLoaded.users, cacheLoaded.sessions, cacheLoaded.groups, reportsPage, reportStatus]);

  // 全局确认对话框订阅
  useEffect(() => {
    return subscribeConfirmDialog((state) => {
      setConfirmState({
        open: state.open,
        title: state.title,
        message: state.message,
        type: state.type || 'info'
      });
    });
  }, []);

  // 点击外部关闭菜单
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (showUserMenu || showSessionMenu || showGroupMenu || showReportMenu) {
        const target = e.target as HTMLElement;
        if (!target.closest('.user-action-menu') && !target.closest('.menu-btn') && !target.closest('.btn-more')) {
          setShowUserMenu(null);
          setShowSessionMenu(null);
          setShowGroupMenu(null);
          setShowReportMenu(null);
        }
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [showUserMenu, showSessionMenu, showGroupMenu, showReportMenu]);

  // 自动调整菜单位置确保在窗口内
  useEffect(() => {
    const adjustMenu = () => {
      const menus = document.querySelectorAll('.user-action-menu');
      menus.forEach(menu => {
        const el = menu as HTMLElement;
        const rect = el.getBoundingClientRect();
        const style = el.style;
        
        // 超出右边界
        if (rect.right > window.innerWidth) {
          style.left = `${window.innerWidth - rect.width - 80}px`;
        }
        // 超出下边界
        if (rect.bottom > window.innerHeight) {
          style.top = `${window.innerHeight - rect.height - 10}px`;
        }
      });
    };

    if (showUserMenu || showSessionMenu || showGroupMenu || showReportMenu) {
      setTimeout(adjustMenu, 0);
    }
  }, [showUserMenu, showSessionMenu, showGroupMenu, showReportMenu]);

  const handleConfirm = () => {
    resolveConfirm(true);
    setConfirmState({ open: false, title: '', message: '', type: 'info' });
  };

  const handleCancel = () => {
    resolveConfirm(false);
    setConfirmState({ open: false, title: '', message: '', type: 'info' });
  };

  const handleCreateUser = async () => {
    try {
      const res = await adminApiFetch(API.admin.users, {
        method: 'POST',
        headers,
        body: JSON.stringify(formData)
      });
      const data = await res.json();
      if (data.success) {
        setShowUserModal(false);
        setFormData({ name: '', username: '', password: '', status: 'online' });
        fetchUsers(true);
      } else {
        toast.error('操作失败', data.message);
      }
    } catch (e) { 
      const errorMessage = getErrorMessage(e);
      const title = isNetworkError(e) ? '网络错误' : isTimeoutError(e) ? '请求超时' : '操作失败';
      toast.error(title, errorMessage);
    }
  };

  const handleUpdateUser = async () => {
    if (!editingUser) return;
    try {
      const res = await adminApiFetch(`${API.admin.users}/${editingUser.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(formData)
      });
      const data = await res.json();
      if (data.success) {
        setEditingUser(null);
        setShowUserModal(false);
        setFormData({ name: '', username: '', password: '', status: 'online' });
        fetchUsers(true);
      } else {
        toast.error('操作失败', data.message);
      }
    } catch (e) { 
      const errorMessage = getErrorMessage(e);
      const title = isNetworkError(e) ? '网络错误' : isTimeoutError(e) ? '请求超时' : '操作失败';
      toast.error(title, errorMessage);
    }
  };

  // 角色变更
  const handleChangeUserRole = async (userId: string, role: string) => {
    try {
      const res = await adminApiFetch(API.admin.userRole(userId), {
        method: 'PUT',
        headers,
        body: JSON.stringify({ role })
      });
      const data = await res.json();
      setShowUserMenu(null);
      if (data.success) {
        toast.success('角色已更新');
        fetchUsers(true);
      } else {
        toast.error('操作失败', data.message || '未知错误');
      }
    } catch (e) { 
      setShowUserMenu(null);
      const errorMessage = getErrorMessage(e);
      const title = isNetworkError(e) ? '网络错误' : isTimeoutError(e) ? '请求超时' : '操作失败';
      toast.error(title, errorMessage);
    }
  };

  const handleGlobalMute = async (userId: string) => {
    const reason = await showInput({
      title: '全局禁言',
      message: '请输入禁言原因（可选）:',
      placeholder: '禁言原因（可选）',
      confirmText: '禁言',
      cancelText: '取消'
    });
    if (reason === null) return;
    try {
      const res = await adminApiFetch(API.admin.globalMute(userId), {
        method: 'POST',
        headers,
        body: JSON.stringify({ reason: reason || undefined })
      });
      const data = await res.json();
      setShowUserMenu(null);
      if (data.success) {
        toast.success('用户已被全局禁言');
        fetchUsers(true);
      } else {
        toast.error('操作失败', data.message || '未知错误');
      }
    } catch (e) { 
      setShowUserMenu(null);
      const errorMessage = getErrorMessage(e);
      const title = isNetworkError(e) ? '网络错误' : isTimeoutError(e) ? '请求超时' : '操作失败';
      toast.error(title, errorMessage);
    }
  };

  const handleGlobalUnmute = async (userId: string) => {
    try {
      const res = await adminApiFetch(API.admin.globalMute(userId), {
        method: 'DELETE',
        headers
      });
      const data = await res.json();
      setShowUserMenu(null);
      if (data.success) {
        toast.success('已解除全局禁言');
        fetchUsers(true);
      } else {
        toast.error('操作失败', data.message || '未知错误');
      }
    } catch (e) { 
      setShowUserMenu(null);
      const errorMessage = getErrorMessage(e);
      const title = isNetworkError(e) ? '网络错误' : isTimeoutError(e) ? '请求超时' : '操作失败';
      toast.error(title, errorMessage);
    }
  };

  const handleBanUser = async (userId: string) => {
    const reason = await showInput({
      title: '封禁用户',
      message: '请输入封禁原因（可选）:',
      placeholder: '封禁原因（可选）',
      confirmText: '封禁',
      cancelText: '取消'
    });
    if (reason === null) return;
    try {
      const res = await adminApiFetch(API.admin.bans, {
        method: 'POST',
        headers,
        body: JSON.stringify({ userId, reason: reason || '' })
      });
      const data = await res.json();
      setShowUserMenu(null);
      if (data.success) {
        toast.success('用户已封禁');
        fetchUsers(true);
      } else {
        toast.error('操作失败', data.message || '未知错误');
      }
    } catch (e) { 
      setShowUserMenu(null);
      const errorMessage = getErrorMessage(e);
      const title = isNetworkError(e) ? '网络错误' : isTimeoutError(e) ? '请求超时' : '操作失败';
      toast.error(title, errorMessage);
    }
  };

  const handleUnbanUser = async (userId: string) => {
    if (!(await showConfirm({ title: '确认', message: '确定要解除该用户的封禁吗？', type: 'info' }))) return;
    try {
      const res = await adminApiFetch(API.admin.ban(userId), {
        method: 'DELETE',
        headers
      });
      const data = await res.json();
      setShowUserMenu(null);
      if (data.success) {
        toast.success('已解除封禁');
        fetchUsers(true);
      } else {
        toast.error('操作失败', data.message || '未知错误');
      }
    } catch (e) { 
      setShowUserMenu(null);
      const errorMessage = getErrorMessage(e);
      const title = isNetworkError(e) ? '网络错误' : isTimeoutError(e) ? '请求超时' : '操作失败';
      toast.error(title, errorMessage);
    }
  };

  const handleDeleteUser = async (userId: string) => {
    if (!(await showConfirm({ title: '确认', message: '确定要删除该用户吗？此操作不可恢复。', type: 'danger' }))) return;
    try {
      const res = await adminApiFetch(`${API.admin.users}/${userId}`, {
        method: 'DELETE',
        headers
      });
      const data = await res.json();
      if (data.success) {
        toast.success('用户已删除');
        fetchUsers(true);
      } else {
        toast.error('操作失败', data.message || '未知错误');
      }
    } catch (e) { const errorMessage = getErrorMessage(e);
      const title = isNetworkError(e) ? '网络错误' : isTimeoutError(e) ? '请求超时' : '操作失败';
      toast.error(title, errorMessage); }
  };

  const handleBatchDeleteUsers = async () => {
    if (!(await showConfirm({ title: '确认', message: `确定要删除选中的 ${selectedUsers.size} 个用户吗？此操作不可恢复。`, type: 'danger' }))) return;
    try {
      const res = await adminApiFetch(`${API.admin.users}/batch-delete`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ids: Array.from(selectedUsers) })
      });
      const data = await res.json();
      if (data.success) {
        setSelectedUsers(new Set());
        fetchUsers(true);
      } else {
        toast.error('操作失败', data.message);
      }
    } catch (e) { 
      const errorMessage = getErrorMessage(e);
      const title = isNetworkError(e) ? '网络错误' : isTimeoutError(e) ? '请求超时' : '操作失败';
      toast.error(title, errorMessage);
    }
  };

  const handleBatchCreateUsers = async () => {
    if (!batchUserInput.trim()) { toast.error('请输入用户信息'); return; }
    try {
      const users = JSON.parse(batchUserInput);
      const res = await adminApiFetch(`${API.admin.users}/batch-create`, {
        method: 'POST',
        body: JSON.stringify({ users })
      });
      const data = await res.json();
      if (data.success) {
        setShowBatchUserModal(false);
        setBatchUserInput('');
        fetchUsers(true);
        toast.success(data.message);
      } else {
        toast.error('操作失败', data.message);
      }
    } catch (e) { toast.error('JSON格式错误，请检查输入'); }
  };

  const handleBatchCreateGroups = async () => {
    if (!batchGroupInput.trim()) { toast.error('请输入群组信息'); return; }
    try {
      const groups = JSON.parse(batchGroupInput);
      const res = await adminApiFetch(`${API.admin.groups}/batch-create`, {
        method: 'POST',
        body: JSON.stringify({ groups })
      });
      const data = await res.json();
      if (data.success) {
        setShowBatchGroupModal(false);
        setBatchGroupInput('');
        fetchGroups(true);
        toast.success(data.message);
      } else {
        toast.error('操作失败', data.message);
      }
    } catch (e) { toast.error('JSON格式错误，请检查输入'); }
  };

  const handleBatchCreateSessions = async () => {
    if (!batchSessionInput.trim()) { toast.error('请输入会话信息'); return; }
    try {
      const sessions = JSON.parse(batchSessionInput);
      const res = await adminApiFetch(`${API.admin.sessions}/batch-create`, {
        method: 'POST',
        body: JSON.stringify({ sessions })
      });
      const data = await res.json();
      if (data.success) {
        setShowBatchSessionModal(false);
        setBatchSessionInput('');
        fetchSessions(true);
        toast.success(data.message);
      } else {
        toast.error('操作失败', data.message);
      }
    } catch (e) { toast.error('JSON格式错误，请检查输入'); }
  };

  const handleCreateGroup = async () => {
    try {
      const res = await adminApiFetch(API.admin.groups, {
        method: 'POST',
        headers,
        body: JSON.stringify(groupFormData)
      });
      const data = await res.json();
      if (data.success) {
        setShowGroupModal(false);
        setGroupFormData({ name: '', announcement: '', memberIds: [] });
        fetchGroups(true);
      } else {
        toast.error('操作失败', data.message);
      }
    } catch (e) { 
      const errorMessage = getErrorMessage(e);
      const title = isNetworkError(e) ? '网络错误' : isTimeoutError(e) ? '请求超时' : '操作失败';
      toast.error(title, errorMessage);
    }
  };

  const handleUpdateGroup = async () => {
    if (!editingGroup) return;
    try {
      const res = await adminApiFetch(`${API.admin.groups}/${editingGroup.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(groupFormData)
      });
      const data = await res.json();
      if (data.success) {
        setShowGroupModal(false);
        setEditingGroup(null);
        setGroupFormData({ name: '', announcement: '', memberIds: [] });
        fetchGroups(true);
      } else {
        toast.error('操作失败', data.message);
      }
    } catch (e) { 
      const errorMessage = getErrorMessage(e);
      const title = isNetworkError(e) ? '网络错误' : isTimeoutError(e) ? '请求超时' : '操作失败';
      toast.error(title, errorMessage);
    }
  };

  const handleDeleteGroup = async (id: string) => {
    if (!(await showConfirm({ title: '确认', message: '确定要删除该群组吗？此操作不可恢复。', type: 'danger' }))) return;
    try {
      const res = await adminApiFetch(`${API.admin.groups}/${id}`, {
        method: 'DELETE',
        headers
      });
      const data = await res.json();
      if (data.success) fetchGroups(true);
      else toast.error('操作失败', data.message);
    } catch (e) { 
      const errorMessage = getErrorMessage(e);
      const title = isNetworkError(e) ? '网络错误' : isTimeoutError(e) ? '请求超时' : '操作失败';
      toast.error(title, errorMessage);
    }
  };

  const handleBatchDeleteGroups = async () => {
    if (!(await showConfirm({ title: '确认', message: `确定要删除选中的 ${selectedGroups.size} 个群组吗？此操作不可恢复。`, type: 'danger' }))) return;
    try {
      const res = await adminApiFetch(`${API.admin.groups}/batch-delete`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ids: Array.from(selectedGroups) })
      });
      const data = await res.json();
      if (data.success) {
        setSelectedGroups(new Set());
        fetchGroups(true);
      } else {
        toast.error('操作失败', data.message);
      }
    } catch (e) { 
      const errorMessage = getErrorMessage(e);
      const title = isNetworkError(e) ? '网络错误' : isTimeoutError(e) ? '请求超时' : '操作失败';
      toast.error(title, errorMessage);
    }
  };

  const handleBatchRemoveGroupMembers = async () => {
    if (!selectedGroups || selectedGroupMemberIds.size === 0) {
      toast.error('请先在群组详情中选择要移除的成员');
      return;
    }
    if (!(await showConfirm({ title: '确认', message: `确定要移除选中的 ${selectedGroupMemberIds.size} 个成员吗？`, type: 'danger' }))) return;
    try {
      for (const groupId of selectedGroups) {
        for (const userId of selectedGroupMemberIds) {
          await adminApiFetch(`${API.admin.groups}/${groupId}/members/${userId}`, {
            method: 'DELETE',
            headers
          });
        }
      }
      setSelectedGroupMemberIds(new Set());
      fetchGroups(true);
      toast.success('成员已移除');
    } catch (e) { 
      const errorMessage = getErrorMessage(e);
      const title = isNetworkError(e) ? '网络错误' : isTimeoutError(e) ? '请求超时' : '操作失败';
      toast.error(title, errorMessage);
    }
  };

  const handleCreateFriendSession = async () => {
    if (!sessionFormData.userId1 || !sessionFormData.userId2) {
      toast.error('请选择两个用户');
      return;
    }
    try {
      const res = await adminApiFetch(API.admin.sessionFriend, {
        method: 'POST',
        headers,
        body: JSON.stringify({ userId1: sessionFormData.userId1, userId2: sessionFormData.userId2 })
      });
      const data = await res.json();
      if (data.success) {
        setShowSessionModal(false);
        setSessionFormData({ name: '', userId1: '', userId2: '' });
        fetchSessions(true);
        toast.success('创建成功', data.message);
      } else {
        toast.error('操作失败', data.message);
      }
    } catch (e) { 
      const errorMessage = getErrorMessage(e);
      const title = isNetworkError(e) ? '网络错误' : isTimeoutError(e) ? '请求超时' : '操作失败';
      toast.error(title, errorMessage);
    }
  };

  const handleAddMembers = async () => {
    if (!selectedSession) return;
    if (!addMemberData.addAllUsers && addMemberData.userIds.length === 0) {
      toast.error('请选择要添加的成员');
      return;
    }
    try {
      const res = await adminApiFetch(API.admin.sessionMembers(selectedSession.id), {
        method: 'POST',
        headers,
        body: JSON.stringify({ userIds: addMemberData.userIds, addAllUsers: addMemberData.addAllUsers })
      });
      const data = await res.json();
      if (data.success) {
        setShowAddMemberModal(false);
        setAddMemberData({ userIds: [], addAllUsers: false });
        fetchSessions(true);
        toast.success(data.message);
      } else {
        toast.error('操作失败', data.message);
      }
    } catch (e) { 
      const errorMessage = getErrorMessage(e);
      const title = isNetworkError(e) ? '网络错误' : isTimeoutError(e) ? '请求超时' : '操作失败';
      toast.error(title, errorMessage);
    }
  };

  const handleRemoveMember = async (sessionId: string, userId: string) => {
    if (!(await showConfirm({ title: '确认', message: '确定要移除该成员吗？', type: 'warning' }))) return;
    try {
      const res = await adminApiFetch(`${API.admin.sessionMembers(sessionId)}/${userId}`, {
        method: 'DELETE',
        headers
      });
      const data = await res.json();
      if (data.success) {
        fetchSessions(true);
        // 重新获取会话详情以更新成员列表
        if (sessionDetail && sessionDetail.id === sessionId) {
          const detailRes = await adminApiFetch(API.admin.sessionInfo(sessionId), { requireCsrf: false });
          const detailData = await detailRes.json();
          if (detailData.success) {
            setSessionDetail(detailData.data);
          }
        }
      } else {
        toast.error('操作失败', data.message);
      }
    } catch (e) { 
      const errorMessage = getErrorMessage(e);
      const title = isNetworkError(e) ? '网络错误' : isTimeoutError(e) ? '请求超时' : '操作失败';
      toast.error(title, errorMessage);
    }
  };

  const handleDeleteSession = async (id: string) => {
    if (!(await showConfirm({ title: '确认', message: '确定要删除该会话吗？此操作不可恢复。', type: 'danger' }))) return;
    try {
      const res = await adminApiFetch(API.admin.sessionInfo(id), {
        method: 'DELETE',
        headers
      });
      const data = await res.json();
      if (data.success) fetchSessions(true);
      else toast.error('操作失败', data.message);
    } catch (e) { 
      const errorMessage = getErrorMessage(e);
      const title = isNetworkError(e) ? '网络错误' : isTimeoutError(e) ? '请求超时' : '操作失败';
      toast.error(title, errorMessage);
    }
  };

  const handleBatchDeleteSessions = async () => {
    if (!(await showConfirm({ title: '确认', message: `确定要删除选中的 ${selectedSessions.size} 个会话吗？此操作不可恢复。`, type: 'danger' }))) return;
    try {
      const res = await adminApiFetch(`${API.admin.sessions}/batch-delete`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ids: Array.from(selectedSessions) })
      });
      const data = await res.json();
      if (data.success) {
        setSelectedSessions(new Set());
        fetchSessions(true);
      } else {
        toast.error('操作失败', data.message);
      }
    } catch (e) { 
      const errorMessage = getErrorMessage(e);
      const title = isNetworkError(e) ? '网络错误' : isTimeoutError(e) ? '请求超时' : '操作失败';
      toast.error(title, errorMessage);
    }
  };

  const handleViewSessionDetail = async (session: Session) => {
    setSelectedSession(session);
    try {
      const res = await adminApiFetch(API.admin.sessionInfo(session.id), { requireCsrf: false });
      const data = await res.json();
      if (data.success) {
        setSessionDetail(data.data);
        setShowSessionDetailModal(true);
      }
    } catch (e) { console.error(e); }
  };

  const handleSetOwner = async (userId: string) => {
    if (!selectedSession) return;
    try {
      const res = await adminApiFetch(API.admin.sessionOwner(selectedSession.id), {
        method: 'PUT',
        headers,
        body: JSON.stringify({ userId, isOwner: true })
      });
      const data = await res.json();
      if (data.success) {
        toast.success(data.message);
        handleViewSessionDetail(selectedSession);
        fetchSessions(true);
      } else {
        toast.error('操作失败', data.message);
      }
    } catch (e) { 
      const errorMessage = getErrorMessage(e);
      const title = isNetworkError(e) ? '网络错误' : isTimeoutError(e) ? '请求超时' : '操作失败';
      toast.error(title, errorMessage);
    }
  };

  const handleAddOwner = async (userId: string) => {
    if (!selectedSession) return;
    try {
      const res = await adminApiFetch(API.admin.sessionOwner(selectedSession.id), {
        method: 'PUT',
        headers,
        body: JSON.stringify({ userId, isOwner: true })
      });
      const data = await res.json();
      if (data.success) {
        toast.success(data.message);
        handleViewSessionDetail(selectedSession);
        fetchSessions(true);
      } else {
        toast.error('操作失败', data.message);
      }
    } catch (e) { 
      const errorMessage = getErrorMessage(e);
      const title = isNetworkError(e) ? '网络错误' : isTimeoutError(e) ? '请求超时' : '操作失败';
      toast.error(title, errorMessage);
    }
  };

  const handleRemoveOwner = async (userId: string) => {
    if (!selectedSession) return;
    if (!(await showConfirm({ title: '确认', message: '确定要移除该用户的群主身份吗？', type: 'warning' }))) return;
    try {
      const res = await adminApiFetch(API.admin.sessionOwner(selectedSession.id), {
        method: 'PUT',
        headers,
        body: JSON.stringify({ userId, isOwner: false })
      });
      const data = await res.json();
      if (data.success) {
        toast.success(data.message);
        handleViewSessionDetail(selectedSession);
        fetchSessions(true);
      } else {
        toast.error('操作失败', data.message);
      }
    } catch (e) { 
      const errorMessage = getErrorMessage(e);
      const title = isNetworkError(e) ? '网络错误' : isTimeoutError(e) ? '请求超时' : '操作失败';
      toast.error(title, errorMessage);
    }
  };

  const handleViewUserMessages = async (user: User) => {
    setSelectedUser(user);
    try {
      const res = await adminApiFetch(API.admin.userMessages(user.id), { requireCsrf: false });
      const data = await res.json();
      
      if (data.success) {
        setUserMessages(data.data?.list || []);
      } else {
        toast.error('操作失败', data.message || '获取消息失败');
      }
    } catch (e) { 
      console.error('Error fetching messages:', e);
      toast.error('获取消息失败，请检查网络');
    }
    setShowUserMessages(true);
  };

  const handleDeleteMessage = async (messageId: string) => {
    if (!(await showConfirm({ title: '确认', message: '确定要删除该消息吗？', type: 'danger' }))) return;
    try {
      const res = await adminApiFetch(API.admin.messageDelete(messageId), {
        method: 'DELETE',
        headers
      });
      const data = await res.json();
      if (data.success) {
        toast.success('消息已删除');
        if (selectedUser) {
          handleViewUserMessages(selectedUser);
        }
      } else {
        toast.error(data.message || '删除失败');
      }
    } catch (e) { 
      const errorMessage = getErrorMessage(e);
      const title = isNetworkError(e) ? '网络错误' : isTimeoutError(e) ? '请求超时' : '操作失败';
      toast.error(title, errorMessage);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatTime = (timestamp: number) => {
    return formatTimestamp(getServerTimestamp(timestamp), 'datetime');
  };

  const formatLastLogin = (timestamp: number) => {
    // lastLoginAt 为 0 或很小的值（小于 1000 毫秒）表示从未登录
    // 因为正常时间戳都会大于 1970 年
    if (!timestamp || timestamp < 1000) {
      return '从未登录';
    }
    return formatTimestamp(getServerTimestamp(timestamp), 'datetime');
  };

  const openUserModal = (user?: User) => {
    if (user) {
      setEditingUser(user);
      setFormData({ name: user.name, username: user.username, password: '', status: user.status });
    } else {
      setEditingUser(null);
      setFormData({ name: '', username: '', password: '', status: 'online' });
    }
    setShowUserModal(true);
  };

  const openGroupModal = (group?: Group) => {
    if (group) {
      setEditingGroup(group);
      setGroupFormData({ name: group.name, announcement: group.announcement || '', memberIds: [] });
    } else {
      setEditingGroup(null);
      setGroupFormData({ name: '', announcement: '', memberIds: [] });
    }
    setShowGroupModal(true);
  };

  return (
    <div className="admin-panel">
      <div className="admin-header">
        <h1>管理系统</h1>
        <span className="admin-badge">{isSuperAdmin ? '超级管理员' : '普通管理员'}</span>
        {isSuperAdmin && <button className="btn-logout" onClick={onLogout}>退出登录</button>}
      </div>
      <div className="admin-container">
		  <div className="admin-tabs">
		    <button className={activeTab === 'users' ? 'active' : ''} onClick={() => setActiveTab('users')}><Users size={18} />用户管理</button>
		    <button className={activeTab === 'sessions' ? 'active' : ''} onClick={() => setActiveTab('sessions')}><MessageSquare size={18} />会话管理</button>
		    <button className={activeTab === 'groups' ? 'active' : ''} onClick={() => setActiveTab('groups')}><UsersRound size={18} />群组管理</button>
		    <button className={activeTab === 'reports' ? 'active' : ''} onClick={() => setActiveTab('reports')}><Flag size={18} />举报管理</button>
		    <button className={activeTab === 'drive' ? 'active' : ''} onClick={() => setActiveTab('drive')}><HardDrive size={18} />网盘设置</button>
		    <button className={activeTab === 'storage' ? 'active' : ''} onClick={() => setActiveTab('storage')}><Database size={18} />存储管理</button>
		    <button className={activeTab === 'stats' ? 'active' : ''} onClick={() => setActiveTab('stats')}><BarChart3 size={18} />系统统计</button>
		    {isSuperAdmin && <button className={activeTab === 'backup' ? 'active' : ''} onClick={() => setActiveTab('backup')}><Cloud size={18} />备份还原</button>}
		  </div>

		  <div className="admin-content">
		    <div className="admin-toolbar">
		    {activeTab === 'sessions' && (
				<div className="filter-bar">
				  <select value={sessionType} onChange={(e) => setSessionType(e.target.value)}>
				    <option value="">全部</option>
				    <option value="friend">私聊</option>
				    <option value="group">群聊</option>
				  </select>
				</div>
		    )}
		      {(activeTab === 'users' || activeTab === 'sessions' || activeTab === 'groups') && (
		        <>
		          <input
		            type="text"
		            placeholder="搜索..."
		            value={searchInput}
		            onChange={(e) => setSearchInput(e.target.value)}
		            onKeyDown={(e) => e.key === 'Enter' && setKeyword(searchInput)}
		            className="search-input"
		          />
		        </>
		      )}
		    {activeTab === 'users' && (
		        <button className="btn-add" onClick={() => openUserModal()}>+ 新增用户</button>
		      )}
		      {activeTab === 'users' && (
		        <button className="btn-add" onClick={() => setShowBatchUserModal(true)}>+ 批量创建</button>
		      )}
		      {activeTab === 'groups' && (
		        <button className="btn-add" onClick={() => openGroupModal()}>+ 新增群组</button>
		      )}
		      {activeTab === 'groups' && (
		        <button className="btn-add" onClick={() => setShowBatchGroupModal(true)}>+ 批量创建</button>
		      )}
		      {activeTab === 'sessions' && (
		        <button className="btn-add" onClick={() => setShowSessionModal(true)}>+ 创建私聊</button>
		      )}
		      {activeTab === 'sessions' && (
		        <button className="btn-add" onClick={() => setShowBatchSessionModal(true)}>+ 批量创建</button>
		      )}
		      {/* 用户批量删除 */}
		      {selectedUsers.size > 0 && (
		      	<button className="btn-danger" onClick={handleBatchDeleteUsers}>批量删除</button>
		      )}
		      {/* 会话批量删除 */}
		      {selectedSessions.size > 0 && (
		      	<button className="btn-danger" onClick={handleBatchDeleteSessions}>批量删除</button>
		      )}
		      {/* 群组批量删除 */}
		      {selectedGroups.size > 0 && (
		      	<button className="btn-danger" onClick={handleBatchDeleteGroups}>批量删除</button>
		      )}
		    </div>

		    {loading.users && activeTab === 'users' && (
		      <div className="loading-indicator" style={{ textAlign: 'center', padding: '20px' }}>
		        <span className="loading-spinner"></span>
		        <span>加载中...</span>
		      </div>
		    )}

		    {!loading.users && activeTab === 'users' && (
		      <>
		      	<div className="admin-item-list" ref={itemListRef}>
		      	  {selectedUsers.size > 0 && (
		      	    <div className="batch-actions" style={{ marginBottom: '10px' }}>
		      	      <span>已选择 {selectedUsers.size} 项</span>
		      	      
		      	    </div>
		      	)}
		        <table className="admin-table">
		          <thead>
		            <tr>
		              <th style={{ width: '40px' }}>
		                <input type="checkbox" checked={selectedUsers.size === users.length && users.length > 0} onChange={(e) => {
		                  if (e.target.checked) setSelectedUsers(new Set(users.map(u => u.id)));
		                  else setSelectedUsers(new Set());
		                }} />
		              </th>
		              <th>昵称</th>
		              <th>登入名称</th>
		              <th>角色</th>
		              <th>在线状态</th>
		              <th>账号状态</th>
		              <th>创建时间</th>
		              <th>最近登录</th>
		              <th>操作</th>
	            </tr>
	          </thead>
	          <tbody>
	            {users.map(user => (
	              <tr key={user.id}>
	                <td><input type="checkbox" checked={selectedUsers.has(user.id)} onChange={(e) => {
	                  const newSet = new Set(selectedUsers);
	                  if (e.target.checked) newSet.add(user.id);
	                  else newSet.delete(user.id);
	                  setSelectedUsers(newSet);
	                }} /></td>
	                <td>{user.name}</td>
	                <td>{user.username}</td>
	                <td><span className={`${user.role === 'admin' ? 'status-admin' : user.role === 'vip' ? 'status-vip' : 'status-user'}`}>{user.role || 'user'}</span></td>
	                <td><span className={`status-badge status-${user.status}`}>{user.status}</span></td>
	                <td>
                    {user.accountStatus === 'normal' ? <span className="status-badge status-normal">正常</span> : 
                     user.accountStatus === 'muted' ? <span className="status-badge status-muted">已禁言</span> : 
                     user.accountStatus === 'banned' ? <span className="status-badge status-banned">已封禁</span> : 
                     <span className="status-badge status-normal">正常</span>}
                  </td>
	                <td>{formatTime(user.createdAt)}</td>
	                <td>{formatLastLogin(user.lastLoginAt)}</td>
	                <td style={{ position: 'relative', width: '50px' }}>
		                  <button 
		                    className="menu-btn" 
		                    onClick={(e) => {
		                      e.stopPropagation();
		                      if (showUserMenu === user.id) {
		                        setShowUserMenu(null);
		                        setMenuPosition(null);
		                      } else {
		                        setShowUserMenu(user.id);
		                        setMenuPosition({ x: e.clientX, y: e.clientY });
		                      }
		                    }}
		                  >
		                    <MoreVertical size={16} />
		                  </button>
		                </td>
		              </tr>
		            ))}
		          </tbody>
		        </table>
		        </div>
		        
		        {/* 用户菜单 */}
		        {showUserMenu && menuPosition && (() => {
		          const user = users.find(u => u.id === showUserMenu);
		          if (!user) return null;
		          return (
		            <div 
		              className="user-action-menu"
		              style={{
		                position: 'fixed',
		                left: menuPosition.x,
		                top: menuPosition.y
		              }}
		            >
		              <button onClick={() => { setShowUserMenu(null); setMenuPosition(null); openUserModal(user); }}><Edit size={14} /> 编辑</button>
		              <button onClick={() => { setShowUserMenu(null); setMenuPosition(null); handleViewUserMessages(user); }}><MessageCircle size={14} /> 查看消息</button>
		              <div className="menu-divider"></div>
		              <button onClick={() => { setShowUserMenu(null); setMenuPosition(null); handleChangeUserRole(user.id, user.role === 'vip' ? 'user' : 'vip'); }}>
		                <UserCog size={14} /> {user.role === 'vip' ? '取消VIP' : '设为VIP'}
		              </button>
		              {isSuperAdmin && (
		                <button onClick={() => { setShowUserMenu(null); setMenuPosition(null); handleChangeUserRole(user.id, user.role === 'admin' ? 'user' : 'admin'); }}>
		                  <UserCog size={14} /> {user.role === 'admin' ? '取消管理员' : '设为管理员'}
		                </button>
		              )}
<div className="menu-divider"></div>
              {user.role !== 'admin' && (
                <>
                  {user.accountStatus === 'banned' ? (
                    <button className="btn-success" onClick={() => { setShowUserMenu(null); setMenuPosition(null); handleUnbanUser(user.id); }}><UserX size={14} /> 解封用户</button>
                  ) : (
                    <>
                      {user.accountStatus === 'muted' ? (
                        <button onClick={() => { setShowUserMenu(null); setMenuPosition(null); handleGlobalUnmute(user.id); }}><VolumeX size={14} /> 解除禁言</button>
                      ) : (
                        <button onClick={() => { setShowUserMenu(null); setMenuPosition(null); handleGlobalMute(user.id); }}><VolumeX size={14} /> 全局禁言</button>
                      )}
                      <button className="btn-warning" onClick={() => { setShowUserMenu(null); setMenuPosition(null); handleBanUser(user.id); }}><UserX size={14} /> 封禁用户</button>
                    </>
                  )}
                  <div className="menu-divider"></div>
                </>
              )}
              {/* 不能删除自己 */}
              {userToken !== user.id && (
                <button className="btn-danger" onClick={() => { setShowUserMenu(null); setMenuPosition(null); handleDeleteUser(user.id); }}><Trash2 size={14} /> 删除</button>
              )}
		            </div>
		          );
		        })()}
		        
		        {!keyword && total > pageSize && (
		          <div className="pagination">
		            <button disabled={currentPage === 1} onClick={() => setCurrentPage(1)}>首页</button>
		            <button disabled={currentPage === 1} onClick={() => setCurrentPage(p => p - 1)}>上一页</button>
		            <span>第 {currentPage} / {Math.ceil(total / pageSize)} 页 (共 {total} 条)</span>
		            <button disabled={currentPage >= Math.ceil(total / pageSize)} onClick={() => setCurrentPage(p => p + 1)}>下一页</button>
		            <button disabled={currentPage >= Math.ceil(total / pageSize)} onClick={() => setCurrentPage(Math.ceil(total / pageSize))}>末页</button>
		          </div>
		        )}
		      </>
		    )}

		    {loading.sessions && activeTab === 'sessions' && (
		      <div className="loading-indicator" style={{ textAlign: 'center', padding: '20px' }}>
		        <span className="loading-spinner"></span>
		        <span>加载中...</span>
		      </div>
		    )}

		    {!loading.sessions && activeTab === 'sessions' && (
		      <>
		        {selectedSessions.size > 0 && (
		          <div className="batch-actions" style={{ marginBottom: '10px' }}>
		            <span>已选择 {selectedSessions.size} 项</span>
		            
		          </div>
		        )}
		        <table className="admin-table">
		          <thead>
		            <tr>
		              <th style={{ width: '40px' }}>
		                <input type="checkbox" checked={selectedSessions.size === sessions.length && sessions.length > 0} onChange={(e) => {
		                  if (e.target.checked) setSelectedSessions(new Set(sessions.map(s => s.id)));
		                  else setSelectedSessions(new Set());
		                }} />
		              </th>
		              <th style={{ width: '80px' }}>类型</th>
		              <th>成员</th>
		              <th>最后消息</th>
		              <th>操作</th>
	            </tr>
	          </thead>
	          <tbody>
	            {sessions.map(session => (
	              <tr key={session.id}>
	                <td><input type="checkbox" checked={selectedSessions.has(session.id)} onChange={(e) => {
	                  const newSet = new Set(selectedSessions);
	                  if (e.target.checked) newSet.add(session.id);
	                  else newSet.delete(session.id);
	                  setSelectedSessions(newSet);
	                }} /></td>
	                <td><span className={`status-badge status-${session.type === 'group' ? 'online' : 'away'}`}>{session.type === 'group' ? '群聊' : '私聊'}</span></td>
	                <td>{session.participant_names || '-'}</td>
	                <td>{session.last_message ? truncateText(session.last_message, 20) : '-'}</td>
	                <td style={{ position: 'relative', width: '50px' }}>
	                  <button className="menu-btn" onClick={(e) => {
	                    e.stopPropagation();
	                    if (showSessionMenu === session.id) {
	                      setShowSessionMenu(null);
	                      setMenuPosition(null);
	                    } else {
	                      setShowSessionMenu(session.id);
	                      setMenuPosition({ x: e.clientX, y: e.clientY });
	                    }
	                  }}>
	                    <MoreVertical size={16} />
	                  </button>
	                </td>
		              </tr>
		            ))}
		          </tbody>
		        </table>
		        {!keyword && total > pageSize && (
		          <div className="pagination">
		            <button disabled={currentPage === 1} onClick={() => setCurrentPage(1)}>首页</button>
		            <button disabled={currentPage === 1} onClick={() => setCurrentPage(p => p - 1)}>上一页</button>
		            <span>第 {currentPage} / {Math.ceil(total / pageSize)} 页 (共 {total} 条)</span>
		            <button disabled={currentPage >= Math.ceil(total / pageSize)} onClick={() => setCurrentPage(p => p + 1)}>下一页</button>
		            <button disabled={currentPage >= Math.ceil(total / pageSize)} onClick={() => setCurrentPage(Math.ceil(total / pageSize))}>末页</button>
		          </div>
		        )}
		        
		        {/* 会话菜单 */}
		        {showSessionMenu && menuPosition && (() => {
		          const session = sessions.find(s => s.id === showSessionMenu);
		          if (!session) return null;
		          return (
		            <div 
		              className="user-action-menu"
		              style={{
		                position: 'fixed',
		                left: menuPosition.x,
		                top: menuPosition.y
		              }}
		            >
		              <button onClick={() => { setShowSessionMenu(null); setMenuPosition(null); handleViewSessionDetail(session); }}><MessageCircle size={14} /> 详情</button>
		              {session.type === 'group' && (
		                <button onClick={() => { setShowSessionMenu(null); setMenuPosition(null); setSelectedSession(session); setShowAddMemberModal(true); }}><UsersRound size={14} /> 添加成员</button>
		              )}
		              <button className="btn-danger" onClick={() => { setShowSessionMenu(null); setMenuPosition(null); handleDeleteSession(session.id); }}><Trash2 size={14} /> 删除</button>
		            </div>
		          );
		        })()}
		      </>
		    )}

		    {loading.groups && activeTab === 'groups' && (
		      <div className="loading-indicator" style={{ textAlign: 'center', padding: '20px' }}>
		        <span className="loading-spinner"></span>
		        <span>加载中...</span>
		      </div>
		    )}

		    {!loading.groups && activeTab === 'groups' && (
		      <>
		        {selectedGroups.size > 0 && (
		          <div className="batch-actions" style={{ marginBottom: '10px' }}>
		            <span>已选择 {selectedGroups.size} 项</span>
		          </div>
		        )}
		        <table className="admin-table">
		          <thead>
		            <tr>
		              <th style={{ width: '40px' }}>
		                <input type="checkbox" checked={selectedGroups.size === groups.length && groups.length > 0} onChange={(e) => {
		                  if (e.target.checked) setSelectedGroups(new Set(groups.map(g => g.id)));
		                  else setSelectedGroups(new Set());
		                }} />
		              </th>
		              <th>群名称</th>
		              <th>成员数</th>
		              <th>公告</th>
		              <th>创建时间</th>
		              <th>操作</th>
	            </tr>
	          </thead>
	          <tbody>
	            {groups.map(group => (
	              <tr key={group.id}>
	                <td><input type="checkbox" checked={selectedGroups.has(group.id)} onChange={(e) => {
	                  const newSet = new Set(selectedGroups);
	                  if (e.target.checked) newSet.add(group.id);
	                  else newSet.delete(group.id);
	                  setSelectedGroups(newSet);
	                }} /></td>
	                <td>{group.name}</td>
	                <td>{group.memberCount}</td>
	                <td>{group.announcement || '-'}</td>
	                <td>{formatTime(group.createdAt)}</td>
	                <td style={{ position: 'relative', width: '50px' }}>
	                  <button className="menu-btn" onClick={(e) => {
	                    e.stopPropagation();
	                    if (showGroupMenu === group.id) {
	                      setShowGroupMenu(null);
	                      setMenuPosition(null);
	                    } else {
	                      setShowGroupMenu(group.id);
	                      setMenuPosition({ x: e.clientX, y: e.clientY });
	                    }
	                  }}>
	                    <MoreVertical size={16} />
	                  </button>
	                </td>
	              </tr>
	            ))}
	          </tbody>
	        </table>
	        
	        {/* 群组菜单 */}
	        {showGroupMenu && menuPosition && (() => {
	          const group = groups.find(g => g.id === showGroupMenu);
	          if (!group) return null;
	          return (
	            <div 
	              className="user-action-menu"
	              style={{
	                position: 'fixed',
	                left: menuPosition.x,
	                top: menuPosition.y
	              }}
	            >
	              <button onClick={() => { setShowGroupMenu(null); setMenuPosition(null); openGroupModal(group); }}><Edit size={14} /> 编辑</button>
	              <button className="btn-danger" onClick={() => { setShowGroupMenu(null); setMenuPosition(null); handleDeleteGroup(group.id); }}><Trash2 size={14} /> 删除</button>
	            </div>
	          );
	        })()}
	        
	        {!keyword && total > pageSize && (
		          <div className="pagination">
		            <button disabled={currentPage === 1} onClick={() => setCurrentPage(1)}>首页</button>
		            <button disabled={currentPage === 1} onClick={() => setCurrentPage(p => p - 1)}>上一页</button>
		            <span>第 {currentPage} / {Math.ceil(total / pageSize)} 页 (共 {total} 条)</span>
		            <button disabled={currentPage >= Math.ceil(total / pageSize)} onClick={() => setCurrentPage(p => p + 1)}>下一页</button>
		            <button disabled={currentPage >= Math.ceil(total / pageSize)} onClick={() => setCurrentPage(Math.ceil(total / pageSize))}>末页</button>
		          </div>
		        )}
		      </>
		    )}

		    {loading.stats && activeTab === 'stats' && (
		      <div className="loading-indicator" style={{ textAlign: 'center', padding: '20px' }}>
		        <span className="loading-spinner"></span>
		        <span>加载中...</span>
		      </div>
		    )}

		    {!loading.stats && activeTab === 'stats' && (
		      <div className="stats-section">
		        <h3>聊天统计</h3>
		        <div className="stats-grid">
		          <div className="stat-card">
		            <div className="stat-label">用户总数</div>
		            <div className="stat-value">{stats.users}</div>
		          </div>
		          <div className="stat-card">
		            <div className="stat-label">群组总数</div>
		            <div className="stat-value">{stats.groups}</div>
		          </div>
		          <div className="stat-card">
		            <div className="stat-label">消息总数</div>
		            <div className="stat-value">{stats.messages}</div>
		          </div>
		          <div className="stat-card">
		            <div className="stat-label">会话总数</div>
		            <div className="stat-value">{stats.sessions}</div>
		          </div>
		          <div className="stat-card">
		            <div className="stat-label">上传文件大小</div>
		            <div className="stat-value">{formatBytes(diskInfo.uploads)}</div>
		          </div>
		          <div className="stat-card">
		            <div className="stat-label">数据库大小</div>
		            <div className="stat-value">{formatBytes(diskInfo.database)}</div>
		          </div>
		          <div className="stat-card highlight">
		            <div className="stat-label">磁盘总使用</div>
		            <div className="stat-value">{formatBytes(diskInfo.total)}</div>
		          </div>
		        </div>

		        <h3 style={{ marginTop: '30px' }}>网盘统计</h3>
		        <div className="stats-grid">
		          <div className="stat-card">
		            <div className="stat-label">当前存储类型</div>
		            <div className="stat-value">{driveStats.storageType === 'r2' ? 'Cloudflare R2' : driveStats.storageType === 'kv' ? 'Cloudflare KV' : driveStats.storageType === 'local' ? '本地存储' : driveStats.storageType === 'pcloud' ? 'pCloud' : driveStats.storageType === 'google' ? 'Google Drive' : driveStats.storageType || '未设置'}</div>
		          </div>
		          <div className="stat-card">
		            <div className="stat-label">文件总数</div>
		            <div className="stat-value">{driveStats.files + driveStats.folders}</div>
		          </div>
		          <div className="stat-card">
		            <div className="stat-label">文件夹</div>
		            <div className="stat-value">{driveStats.folders}</div>
		          </div>
		          <div className="stat-card">
		            <div className="stat-label">文件</div>
		            <div className="stat-value">{driveStats.files}</div>
		          </div>
		          <div className="stat-card">
		            <div className="stat-label">回收站</div>
            <div className="stat-value">{driveStats.trashed}</div>
          </div>
          <div className="stat-card highlight">
            <div className="stat-label">总使用空间</div>
            <div className="stat-value">{formatBytes(driveStats.totalSize)}</div>
          </div>
        </div>
		      </div>
		    )}

		    {activeTab === 'backup' && (
		      <div className="backup-panel">
            {/* 聊天数据管理 */}
            <div style={{ marginBottom: '24px', padding: '16px', background: '#f0f9ff', borderRadius: '8px' }}>
              <h4 style={{ margin: '0 0 12px 0', color: '#1e40af' }}>聊天数据管理</h4>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' }}>
                <button 
                  className="btn-add" 
                  onClick={handleChatBackup}
                  disabled={chatBackupLoading}
                >
                  {chatBackupLoading ? '备份中...' : '+ 备份聊天数据'}
                </button>
                <button 
                  className="btn-refresh" 
                  onClick={fetchBackups}
                  disabled={loading.backup}
                >
                  刷新
                </button>
                {isSuperAdmin && (
                  <button 
                    className="btn-danger" 
                    onClick={handleClearDatabase}
                    disabled={chatBackupLoading}
                  >
                    清空聊天记录
                  </button>
                )}
              </div>
            
              {(loading.backup || chatBackupLoading) && (
                <div className="loading-indicator" style={{ textAlign: 'center', padding: '10px' }}>
                  <span>加载中...</span>
                </div>
              )}

              {!loading.backup && !chatBackupLoading && (
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>聊天备份文件</th>
                      <th>大小</th>
                      <th>创建时间</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chatBackups.map(backup => (
                      <tr key={backup.key}>
                        <td>{backup.key}</td>
                        <td>{formatBytes(backup.size)}</td>
                        <td>{new Date(backup.uploaded).toLocaleString('zh-CN')}</td>
                        <td>
                          <button 
                            onClick={() => handleChatRestore(backup.key)}
                            disabled={chatRestoreLoading}
                            style={{ marginRight: '5px' }}
                          >
                            {chatRestoreLoading ? '还原中...' : '还原'}
                          </button>
                          <button 
                            onClick={() => handleChatDownload(backup.key)}
                            style={{ marginRight: '5px' }}
                          >
                            下载
                          </button>
                          <button 
                            className="btn-danger" 
                            onClick={() => handleChatDelete(backup.key)}
                          >
                            删除
                          </button>
                        </td>
                      </tr>
                    ))}
                    {chatBackups.length === 0 && (
                      <tr>
                        <td colSpan={4} style={{ textAlign: 'center', color: '#999' }}>暂无聊天备份</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
            
            {/* 网盘数据管理 */}
            <div style={{ padding: '16px', background: '#fef3c7', borderRadius: '8px' }}>
              <h4 style={{ margin: '0 0 12px 0', color: '#92400e' }}>网盘数据管理 (当前: {driveSettings?.storageType || 'r2'})</h4>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' }}>
                <button 
                  className="btn-add" 
                  onClick={handleDriveBackup}
                  disabled={driveBackupLoading}
                >
                  {driveBackupLoading ? '备份中...' : '+ 备份网盘数据'}
                </button>
                <button 
                  className="btn-refresh" 
                  onClick={fetchBackups}
                  disabled={loading.backup}
                >
                  刷新
                </button>
                {isSuperAdmin && (
                  <button 
                    className="btn-warning" 
                    onClick={handleClearDriveFiles}
                    disabled={driveBackupLoading}
                  >
                    清空网盘
                  </button>
                )}
              </div>
            
              {(loading.backup || driveBackupLoading) && (
                <div className="loading-indicator" style={{ textAlign: 'center', padding: '10px' }}>
                  <span>加载中...</span>
                </div>
              )}

              {!loading.backup && !driveBackupLoading && (
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>网盘备份文件</th>
                      <th>大小</th>
                      <th>创建时间</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {driveBackups.map(backup => (
                      <tr key={backup.key}>
                        <td>{backup.key}</td>
                        <td>{formatBytes(backup.size)}</td>
                        <td>{new Date(backup.uploaded).toLocaleString('zh-CN')}</td>
                        <td>
                          <button 
                            onClick={() => handleDriveRestore(backup.key)}
                            disabled={driveRestoreLoading}
                            style={{ marginRight: '5px' }}
                          >
                            {driveRestoreLoading ? '还原中...' : '还原'}
                          </button>
                          <button 
                            onClick={() => handleDriveDownload(backup.key)}
                            style={{ marginRight: '5px' }}
                          >
                            下载
                          </button>
                          <button 
                            className="btn-danger" 
                            onClick={() => handleDriveDelete(backup.key)}
                          >
                            删除
                          </button>
                        </td>
                      </tr>
                    ))}
                    {driveBackups.length === 0 && (
                      <tr>
                        <td colSpan={4} style={{ textAlign: 'center', color: '#999' }}>暂无网盘备份</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
		      </div>
		    )}

		    {activeTab === 'drive' && (
		      <div className="drive-settings-panel">
		        {loading.drive && (
		          <div className="loading-indicator" style={{ textAlign: 'center', padding: '20px' }}>
		            <span className="loading-spinner"></span>
		            <span>加载中...</span>
		          </div>
		        )}
		        {!loading.drive && (
		        <>
		        <h3>网盘存储设置</h3>
		        
		        <div className="drive-stats-cards">
		          <div className="stat-card">
		            <div className="stat-label">当前存储类型</div>
		            <div className="stat-value">{driveStats.storageType === 'r2' ? 'Cloudflare R2' : driveStats.storageType === 'kv' ? 'Cloudflare KV' : driveStats.storageType === 'pcloud' ? 'pCloud' : driveStats.storageType === 'google' ? 'Google Drive' : driveStats.storageType || 'R2'}</div>
		          </div>
		          <div className="stat-card">
		            <div className="stat-label">文件数</div>
		            <div className="stat-value">{driveStats.files}</div>
		          </div>
		          <div className="stat-card">
		            <div className="stat-label">文件夹</div>
		            <div className="stat-value">{driveStats.folders}</div>
		          </div>
		          <div className="stat-card">
		            <div className="stat-label">回收站</div>
		            <div className="stat-value">{driveStats.trashed}</div>
		          </div>
		          <div className="stat-card highlight">
		            <div className="stat-label">总大小</div>
		            <div className="stat-value">{formatBytes(driveStats.totalSize)}</div>
		          </div>
		        </div>

		        <div className="form-section">
		          <h4>存储类型</h4>
		          <div className="storage-type-selector">
		            <label className={`storage-type-option ${driveSettings.storageType === 'r2' ? 'selected' : ''}`}>
		              <input type="radio" name="storageType" value="r2" checked={driveSettings.storageType === 'r2'} onChange={(e) => { setDriveSettings({...driveSettings, storageType: e.target.value}); fetchDriveStats(e.target.value); }} />
		              <span className="storage-type-icon">☁️</span>
		              <span className="storage-type-name">Cloudflare R2</span>
		              <span className="storage-type-desc">默认存储方案</span>
		            </label>
		            <label className={`storage-type-option ${driveSettings.storageType === 'kv' ? 'selected' : ''}`}>
		              <input type="radio" name="storageType" value="kv" checked={driveSettings.storageType === 'kv'} onChange={(e) => { setDriveSettings({...driveSettings, storageType: e.target.value}); fetchDriveStats(e.target.value); }} />
		              <span className="storage-type-icon">🔑</span>
		              <span className="storage-type-name">Cloudflare KV</span>
		              <span className="storage-type-desc">适合小文件</span>
		            </label>
		            <label className={`storage-type-option ${driveSettings.storageType === 'pcloud' ? 'selected' : ''}`}>
		              <input type="radio" name="storageType" value="pcloud" checked={driveSettings.storageType === 'pcloud'} onChange={(e) => { setDriveSettings({...driveSettings, storageType: e.target.value, pcloud: { ...driveSettings.pcloud, folderId: driveSettings.pcloud.folderId || '0' }}); fetchDriveStats(e.target.value); }} />
		              <span className="storage-type-icon">📦</span>
		              <span className="storage-type-name">pCloud 网盘</span>
		              <span className="storage-type-desc">第三方云存储</span>
		            </label>
		            <label className={`storage-type-option ${driveSettings.storageType === 'google' ? 'selected' : ''}`}>
		              <input type="radio" name="storageType" value="google" checked={driveSettings.storageType === 'google'} onChange={(e) => { setDriveSettings({...driveSettings, storageType: e.target.value, google: { ...driveSettings.google, folderId: driveSettings.google.folderId || 'root' }}); fetchDriveStats(e.target.value); }} />
		              <span className="storage-type-icon">📁</span>
		              <span className="storage-type-name">Google 网盘</span>
		              <span className="storage-type-desc">Google云端硬盘</span>
		            </label>
		          </div>
		        </div>

		        {driveSettings.storageType === 'pcloud' && (
		          <div className="form-section">
		            <h4>pCloud 配置</h4>
		            <div className="form-group">
		              <label>rclone Token</label>
		              <textarea
		                value={driveSettings.pcloud.token || ''}
		                onChange={(e) => setDriveSettings({...driveSettings, pcloud: { ...driveSettings.pcloud, token: e.target.value }})}
		                placeholder="请输入 rclone 获取的 pCloud token"
		                rows={4}
		                style={{ width: '100%', padding: '10px', fontFamily: 'monospace', fontSize: '12px' }}
		              />
		            </div>
		            <div className="form-group">
		              <label>根文件夹ID (系统会自动在此创建 chat/files、drive/files 等目录结构)</label>
		              <input
		                type="text"
		                value={driveSettings.pcloud.folderId || ''}
		                onChange={(e) => setDriveSettings({...driveSettings, pcloud: { ...driveSettings.pcloud, folderId: e.target.value }})}
		                placeholder="pCloud 文件夹ID，0 为根目录"
		              />
		              <small style={{ color: '#666' }}>保存设置时会自动创建 chat/files、chat/avatar、drive/files 等目录结构</small>
		            </div>
		          </div>
		        )}

		        {driveSettings.storageType === 'google' && (
		          <div className="form-section">
		            <h4>Google Drive 配置</h4>
		            <div className="form-group">
		              <label>rclone Token</label>
		              <textarea
		                value={driveSettings.google.token || ''}
		                onChange={(e) => setDriveSettings({...driveSettings, google: { ...driveSettings.google, token: e.target.value }})}
		                placeholder="请输入 rclone 获取的 Google Drive token"
		                rows={4}
		                style={{ width: '100%', padding: '10px', fontFamily: 'monospace', fontSize: '12px' }}
		              />
		            </div>
		            <div className="form-group">
		              <label>根文件夹ID (系统会自动在此创建 chat/files、drive/files 等目录结构)</label>
		              <input
		                type="text"
		                value={driveSettings.google.folderId || ''}
		                onChange={(e) => setDriveSettings({...driveSettings, google: { ...driveSettings.google, folderId: e.target.value }})}
		                placeholder="Google Drive 文件夹ID，留空为根目录"
		              />
		              <small style={{ color: '#666' }}>保存设置时会自动创建 chat/files、chat/avatar、drive/files 等目录结构</small>
		            </div>
		          </div>
		        )}

		        <div className="form-actions">
		          <button className="btn-add" onClick={handleSaveDriveSettings} disabled={driveSettingsLoading}>
		            {driveSettingsLoading ? '保存中...' : '保存设置'}
		          </button>
		          {driveSettingsSaved && <span style={{ marginLeft: '10px', color: 'green' }}>✓ 保存成功</span>}
		        </div>
		        </>
		        )}
		    </div>
		    )}

		    {activeTab === 'storage' && (
		      <div className="storage-management-panel">
		        <h3>用户存储空间管理</h3>
		        
		        
		        
		        <table className="admin-table">
		          <thead>
		            <tr>
		              <th>用户</th>
		              <th>文件数</th>
		              <th>已用空间</th>
		              <th>存储限制</th>
		              <th>操作</th>
		            </tr>
		          </thead>
		          <tbody>
          {userStorageList.map((user) => {
              const diskValue = user.disk ?? 5 * 1024 * 1024 * 1024; // 默认5GB
              const limit = user.storageLimit || diskValue;
              const usagePercent = limit ? Math.min(100, (user.totalSize / limit) * 100) : 0;
		              return (
		                <tr key={user.id}>
		                  <td>{user.name} ({user.username})</td>
		                  <td>{user.fileCount}</td>
		                  <td>{formatBytes(user.totalSize)}</td>
		                  <td>{formatBytes(limit)}</td>
		                  <td>
		                    <button className="btn-sm" onClick={() => {
		                      setStorageLimitUser(user);
		                      setStorageLimitValue(String(user.storageLimit || ''));
		                      setShowStorageLimitModal(true);
		                    }}>
		                      设置限制
		                    </button>
		                  </td>
		                </tr>
		              );
		            })}
		            <tr>
		              <td colSpan={5} style={{ textAlign: 'center', padding: '20px' }}>
				        {loading.storage && (
						  <div className="loading-indicator" style={{ textAlign: 'center', padding: '20px' }}>
						    <span className="loading-spinner"></span>
						    <span>加载中...</span>
						  </div>
						) || (
						userStorageList.length === 0 && "暂无数据"
		            )}
		              </td>
		            </tr>
		          </tbody>
	        </table>
	      </div>
		    )}

		    {activeTab === 'reports' && (
		      <div className="reports-panel">
		        <h3>举报管理</h3>
		        
		        <div className="filter-bar" style={{ marginBottom: '16px' }}>
		          <select value={reportStatus} onChange={(e) => { setReportStatus(e.target.value); setReportsPage(1); setCacheLoaded(prev => ({ ...prev, reports: false })); }}>
		            <option value="all">全部</option>
		            <option value="pending">待处理</option>
		            <option value="dismissed">已驳回</option>
		            <option value="message_deleted">已删除消息</option>
		            <option value="user_banned">已封禁用户</option>
		          </select>
		          <button className="btn-refresh" onClick={() => fetchReports(true)} disabled={loading.reports}>
		            刷新
		          </button>
		          {selectedReports.size > 0 && (
		            <button className="btn-danger" onClick={handleBatchDeleteReports}>
		              删除所选 ({selectedReports.size})
		            </button>
		          )}
		        </div>

		        {loading.reports ? (
		          <div className="loading-indicator" style={{ textAlign: 'center', padding: '20px' }}>
		            <span className="loading-spinner"></span>
		            <span>加载中...</span>
		          </div>
		        ) : (
		          <>
		            <table className="admin-table">
		              <thead>
		                <tr>
		                  <th style={{ width: '40px' }}>
		                    <input type="checkbox" checked={(reportsCache || []).length > 0 && selectedReports.size === (reportsCache || []).length} onChange={(e) => {
		                      if (e.target.checked) setSelectedReports(new Set((reportsCache || []).map(r => r.id)));
		                      else setSelectedReports(new Set());
		                    }} />
		                  </th>
		                  <th>举报人</th>
		                  <th>被举报用户</th>
		                  <th>举报原因</th>
		                  <th>消息内容</th>
		                  <th>状态</th>
		                  <th>时间</th>
		                  <th style={{ width: '50px' }}>操作</th>
		                </tr>
		              </thead>
		              <tbody>
		                {(reportsCache || []).map(report => (
		                  <tr key={report.id}>
		                    <td><input type="checkbox" checked={selectedReports.has(report.id)} onChange={(e) => {
		                      const newSet = new Set(selectedReports);
		                      if (e.target.checked) newSet.add(report.id);
		                      else newSet.delete(report.id);
		                      setSelectedReports(newSet);
		                    }} /></td>
		                    <td>{report.reporterName || report.reporter_id || '-'}</td>
		                    <td>{report.reportedUserName || report.reported_user_id || '-'}</td>
		                    <td>{getReportReasonLabel(report.reason) || '-'}</td>
		                    <td style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
		                      {report.messageContent || report.content || '-'}
		                    </td>
		                    <td>
		                      <span className={`status-badge status-${report.status === 'pending' ? 'online' : report.status === 'dismissed' ? 'offline' : 'away'}`}>
		                        {report.status === 'pending' ? '待处理' : 
		                         report.status === 'dismissed' ? '已驳回' : 
		                         report.status === 'message_deleted' ? '已删除消息' : 
		                         report.status === 'user_banned' ? '已封禁用户' : report.status}
		                      </span>
		                    </td>
		                    <td>{report.createdAt ? new Date(report.createdAt).toLocaleString('zh-CN') : '-'}</td>
		                    <td style={{ position: 'relative', width: '50px' }}>
		                      <button className="menu-btn" onClick={(e) => {
		                        e.stopPropagation();
		                        if (showReportMenu === report.id) {
		                          setShowReportMenu(null);
		                          setMenuPosition(null);
		                        } else {
		                          setShowReportMenu(report.id);
		                          setMenuPosition({ x: e.clientX, y: e.clientY });
		                        }
		                      }}>
		                        <MoreVertical size={16} />
		                      </button>
		                    </td>
		                  </tr>
		                ))}
		                {(reportsCache || []).length === 0 && (
		                  <tr>
		                    <td colSpan={8} style={{ textAlign: 'center', padding: '20px', color: '#999' }}>暂无举报记录</td>
		                  </tr>
		                )}
		              </tbody>
		            </table>

		            {reportsTotal > reportsPageSize && (
		              <div className="pagination">
		                <button disabled={reportsPage === 1} onClick={() => setReportsPage(1)}>首页</button>
		                <button disabled={reportsPage === 1} onClick={() => setReportsPage(p => p - 1)}>上一页</button>
		                <span>第 {reportsPage} / {Math.ceil(reportsTotal / reportsPageSize)} 页 (共 {reportsTotal} 条)</span>
		                <button disabled={reportsPage >= Math.ceil(reportsTotal / reportsPageSize)} onClick={() => setReportsPage(p => p + 1)}>下一页</button>
		                <button disabled={reportsPage >= Math.ceil(reportsTotal / reportsPageSize)} onClick={() => setReportsPage(Math.ceil(reportsTotal / reportsPageSize))}>末页</button>
		              </div>
		            )}
		          </>
		        )}
		      </div>
		    )}

		    {/* 举报菜单 */}
		    {showReportMenu && menuPosition && (() => {
		      const report = (reportsCache || []).find(r => r.id === showReportMenu);
		      if (!report) return null;
		      return (
		        <div 
		          className="user-action-menu"
		          style={{
		            position: 'fixed',
		            left: menuPosition.x,
		            top: menuPosition.y
		          }}
		        >
		          {report.status === 'pending' && (
		            <>
		              <button onClick={() => { setShowReportMenu(null); setMenuPosition(null); handleReport(report.id, 'dismiss'); }}>
		                <Check size={14} /> 驳回
		              </button>
		              <button onClick={() => { setShowReportMenu(null); setMenuPosition(null); handleReport(report.id, 'delete_message'); }}>
		                <Trash2 size={14} /> 删除消息
		              </button>
		              <button onClick={() => { setShowReportMenu(null); setMenuPosition(null); handleReport(report.id, 'ban_user'); }}>
		                <Ban size={14} /> 封禁用户
		              </button>
		      <div className="menu-divider"></div>
		    </>
		  )}
		  <button className="btn-danger" onClick={() => { setShowReportMenu(null); setMenuPosition(null); handleDeleteReport(report.id); }}>
		    <Trash2 size={14} /> 删除举报
		  </button>
		</div>
	      );
	    })()}
		  </div>

		  {showUserModal && (
		    <div className="modal-overlay">
		      <div className="modal">
		        <h3>{editingUser ? '编辑用户' : '新增用户'}</h3>
		        <div className="form-group">
		          <label>昵称</label>
		          <input
		            type="text"
		            value={formData.name}
		            onChange={(e) => setFormData({...formData, name: e.target.value})}
		          />
		        </div>
		        <div className="form-group">
		          <label>登入名</label>
		          <input
		            type="text"
		            value={formData.username}
		            onChange={(e) => setFormData({...formData, username: e.target.value})}
		          />
		        </div>
		        <div className="form-group">
		          <label>密码 {editingUser && '(不修改留空)'}</label>
		          <div style={{ position: 'relative' }}>
		            <input
		              type={showPassword ? 'text' : 'password'}
		              value={formData.password}
		              onChange={(e) => setFormData({...formData, password: e.target.value})}
		              style={{ paddingRight: '40px' }}
		            />
		            <button
		              type="button"
		              onClick={() => setShowPassword(!showPassword)}
		              style={{
		                position: 'absolute',
		                right: '10px',
		                top: '50%',
		                transform: 'translateY(-50%)',
		                border: 'none',
		                background: 'none',
		                cursor: 'pointer',
		                fontSize: '16px'
		              }}
		            >
		              {showPassword ? '🙈' : '👁️'}
		            </button>
		          </div>
		        </div>
		        <div className="form-group">
		          <label>状态</label>
		          <select
		            value={formData.status}
		            onChange={(e) => setFormData({...formData, status: e.target.value})}
		          >
		            <option value="online">online</option>
		            <option value="away">away</option>
		            <option value="offline">offline</option>
		          </select>
		        </div>
		        <div className="modal-actions">
		          <button onClick={() => setShowUserModal(false)}>取消</button>
		          <button className="btn-primary" onClick={editingUser ? handleUpdateUser : handleCreateUser}>
		            {editingUser ? '保存' : '创建'}
		          </button>
		        </div>
		      </div>
		    </div>
		  )}

		  {showBatchUserModal && (
		    <div className="modal-overlay">
		      <div className="modal">
		        <h3>批量创建用户</h3>
		        <p style={{ fontSize: '12px', color: '#666', marginBottom: '10px' }}>
		          JSON数组格式（disk 单位为字节，5GB = 5368709120）：<br/>
		          [{'{'}username: "abc", password: "abc", name: "张三", disk: 5368709120{'}'}]
		        </p>
		        <textarea
		          value={batchUserInput}
		          onChange={(e) => setBatchUserInput(e.target.value)}
		          placeholder='[{"username":"abc","password":"abc","name":"张三","disk":5368709120}]'
		          rows={10}
		          style={{ width: '100%', padding: '10px', fontFamily: 'monospace' }}
		        />
		        <div className="modal-actions">
		          <button onClick={() => { setShowBatchUserModal(false); setBatchUserInput(''); }}>取消</button>
		          <button className="btn-primary" onClick={handleBatchCreateUsers}>批量创建</button>
		        </div>
		      </div>
		    </div>
		  )}

		  {showBatchGroupModal && (
		    <div className="modal-overlay">
		      <div className="modal">
		        <h3>批量创建群组</h3>
		        <p style={{ fontSize: '12px', color: '#666', marginBottom: '10px' }}>
		          JSON数组格式：[{'{'}name: "交流群", announcement: ""{'}'}]
		        </p>
		        <textarea
		          value={batchGroupInput}
		          onChange={(e) => setBatchGroupInput(e.target.value)}
		          placeholder='[{"name":"交流群","announcement":"欢迎加入"}]'
		          rows={10}
		          style={{ width: '100%', padding: '10px', fontFamily: 'monospace' }}
		        />
		        <div className="modal-actions">
		          <button onClick={() => { setShowBatchGroupModal(false); setBatchGroupInput(''); }}>取消</button>
		          <button className="btn-primary" onClick={handleBatchCreateGroups}>批量创建</button>
		        </div>
		      </div>
		    </div>
		  )}

		  {showBatchSessionModal && (
		    <div className="modal-overlay">
		      <div className="modal">
		        <h3>批量创建会话</h3>
		        <p style={{ fontSize: '12px', color: '#666', marginBottom: '10px' }}>
		          JSON数组格式：<br/>
		          friend: [{'{'}type: "friend", users: ["user1", "user2"], self: "user0"{'}'}] - 为user0创建与user1,user2的好友会话<br/>
		          group: [{'{'}type: "group", name: "群组名", users: ["user1", "user2"], owner: ["user1"]{'}'}] - owner指定群主
		        </p>
		        <textarea
		          value={batchSessionInput}
		          onChange={(e) => setBatchSessionInput(e.target.value)}
		          placeholder='[{"type":"friend","users":["user1","user2"],"self":"user0"},{"type":"group","name":"测试群","users":["user1","user2","user3"],"owner":["user1"]}]'
		          rows={10}
		          style={{ width: '100%', padding: '10px', fontFamily: 'monospace' }}
		        />
		        <div className="modal-actions">
		          <button onClick={() => { setShowBatchSessionModal(false); setBatchSessionInput(''); }}>取消</button>
		          <button className="btn-primary" onClick={handleBatchCreateSessions}>批量创建</button>
		        </div>
		      </div>
		    </div>
		  )}

		  {showGroupModal && (
		    <div className="modal-overlay">
		      <div className="modal">
		        <h3>{editingGroup ? '编辑群组' : '新增群组'}</h3>
		        <div className="form-group">
		          <label>群名称</label>
		          <input
		            type="text"
		            value={groupFormData.name}
		            onChange={(e) => setGroupFormData({...groupFormData, name: e.target.value})}
		          />
		        </div>
		        <div className="form-group">
		          <label>群公告</label>
		          <textarea
		            value={groupFormData.announcement}
		            onChange={(e) => setGroupFormData({...groupFormData, announcement: e.target.value})}
		          />
		        </div>
		        <div className="modal-actions">
		          <button onClick={() => setShowGroupModal(false)}>取消</button>
		          <button className="btn-primary" onClick={editingGroup ? handleUpdateGroup : handleCreateGroup}>
		            {editingGroup ? '保存' : '创建'}
		          </button>
		        </div>
		      </div>
		    </div>
		  )}

		  {showUserMessages && selectedUser && (
		    <div className="modal-overlay">
		      <div className="modal modal-large">
		        <h3>{selectedUser.name} 的消息记录</h3>
		        <div className="messages-list">
		          {userMessages.map(msg => (
		            <div key={msg.id} className="message-item">
		              <div className="message-info">
		                <span className="message-time">{convertServerTime(msg.time).toLocaleString()}</span>
		                <span className={`message-session type-${msg.sessionType}`}>
		                  {msg.sessionName} ({msg.sessionType === 'group' ? '群聊' : msg.sessionType === 'friend' ? '私聊' : '未知'})
		                </span>
		              </div>
		              <div className="message-content">{msg.content}</div>
		              <button className="btn-danger btn-small" onClick={() => handleDeleteMessage(msg.id)}>删除</button>
		            </div>
		          ))}
		          {userMessages.length === 0 && <div className="no-data">暂无消息</div>}
		        </div>
		        <div className="modal-actions">
		          <button onClick={() => setShowUserMessages(false)}>关闭</button>
		        </div>
		      </div>
		    </div>
		  )}

		  {showSessionModal && (
		    <div className="modal-overlay">
		      <div className="modal">
		        <h3>创建私聊会话</h3>
		        <div className="form-group">
		          <label>用户1</label>
		          <select
		            value={sessionFormData.userId1}
		            onChange={(e) => setSessionFormData({...sessionFormData, userId1: e.target.value})}
		          >
		            <option value="">选择用户</option>
		            {allUsers.map(u => (
		              <option key={u.id} value={u.id}>{u.name} ({u.username})</option>
		            ))}
		          </select>
		        </div>
		        <div className="form-group">
		          <label>用户2</label>
		          <select
		            value={sessionFormData.userId2}
		            onChange={(e) => setSessionFormData({...sessionFormData, userId2: e.target.value})}
		          >
		            <option value="">选择用户</option>
		            {allUsers.filter(u => u.id !== sessionFormData.userId1).map(u => (
		              <option key={u.id} value={u.id}>{u.name} ({u.username})</option>
		            ))}
		          </select>
		        </div>
		        <div className="modal-actions">
		          <button onClick={() => { setShowSessionModal(false); setSessionFormData({ name: '', userId1: '', userId2: '' }); }}>取消</button>
		          <button className="btn-primary" onClick={handleCreateFriendSession}>创建</button>
		        </div>
		      </div>
		    </div>
		  )}

		  {showAddMemberModal && selectedSession && (
		    <div className="modal-overlay">
		      <div className="modal">
		        <h3>添加成员到群组: {selectedSession.name}</h3>
		        <div className="form-group">
		          <label>
		            <input
		              type="checkbox"
		              checked={addMemberData.addAllUsers === true}
		              onChange={(e) => {
		                setAddMemberData({...addMemberData, addAllUsers: e.target.checked, userIds: e.target.checked ? [] : addMemberData.userIds});
		              }}
		            />
		            添加所有用户
		          </label>
		        </div>
		        {!addMemberData.addAllUsers && (
		        <div className="form-group">
		          <label>选择成员</label>
		          <div className="checkbox-list">
		            {allUsers.filter(u => !selectedSession.participant_names?.includes(u.name)).map(u => (
		              <label key={u.id} className="checkbox-item">
		                <input
		                  type="checkbox"
		                  checked={addMemberData.userIds.includes(u.id)}
		                  onChange={(e) => {
		                    if (e.target.checked) {
		                      setAddMemberData({...addMemberData, userIds: [...addMemberData.userIds, u.id]});
		                    } else {
		                      setAddMemberData({...addMemberData, userIds: addMemberData.userIds.filter(id => id !== u.id)});
		                    }
		                  }}
		                />
		                {u.name} ({u.username})
		              </label>
		            ))}
		          </div>
		        </div>
		        )}
		        <div className="modal-actions">
		          <button onClick={() => { setShowAddMemberModal(false); setAddMemberData({ userIds: [], addAllUsers: false }); }}>取消</button>
		          <button className="btn-primary" onClick={handleAddMembers}>添加</button>
		        </div>
		      </div>
		    </div>
		  )}

		  {showSessionDetailModal && sessionDetail && (
		    <div className="modal-overlay">
		      <div className="modal modal-large">
		        <h3>会话详情 {sessionDetail.type === 'group' ? `- ${sessionDetail.name}` : ''}</h3>
		        
		        {sessionDetail.type === 'group' && (
		          <>
		            <div className="form-group">
		              <label>群公告</label>
		              <div className="announcement-display">
		                <p>{sessionDetail.announcement || '暂无公告'}</p>
		              </div>
		            </div>
		            
		            <div className="form-group">
		              <label>群主列表</label>
		              <div className="owners-list">
		                {sessionDetail.ownerIds?.length > 0 ? (
		                  sessionDetail.ownerIds.map((ownerId: string) => {
		                    const owner = sessionDetail.members?.find((m: any) => m.id === ownerId);
		                    return owner ? (
		                      <div key={ownerId} className="owner-item">
		                        <span>{owner.name} ({owner.username})</span>
		                        <button 
		                          className="btn-danger btn-small"
		                          onClick={() => handleRemoveOwner(ownerId)}
		                        >
		                          移除
		                        </button>
		                      </div>
		                    ) : null;
		                  })
		                ) : (
		                  <p style={{ color: '#999' }}>暂无群主</p>
		                )}
		              </div>
		            </div>

		            <div className="form-group">
		              <label>添加群主</label>
		              <select
		                value=""
		                onChange={(e) => {
		                  if (e.target.value) {
		                    handleAddOwner(e.target.value);
		                    e.target.value = '';
		                  }
		                }}
		              >
		                <option value="">选择成员设为群主</option>
		                {sessionDetail.members
		                  ?.filter((m: any) => !sessionDetail.ownerIds?.includes(m.id))
		                  .map((m: any) => (
		                    <option key={m.id} value={m.id}>{m.name} ({m.username})</option>
		                  ))}
		              </select>
		            </div>
		          </>
		        )}
		        
		        <div className="form-group">
		          <label>成员列表 ({sessionDetail.members?.length || 0})</label>
		          <div className="members-admin-list">
		            {sessionDetail.members?.map((member: any) => {
		              const isOwner = sessionDetail.ownerIds?.includes(member.id);
		              return (
		              <div key={member.id} className="member-admin-item">
		                <div className="member-info">
		                  <span className="member-name">{member.name}</span>
		                  <span className="member-username">({member.username})</span>
		                  {isOwner && <span className="owner-badge">群主</span>}
		                </div>
		                {sessionDetail.type === 'group' && (
		                  <button 
		                    className="btn-danger btn-small"
		                    onClick={() => handleRemoveMember(sessionDetail.id, member.id)}
		                  >
		                    移除
		                  </button>
		                )}
		              </div>
		            )})}
		          </div>
		        </div>
		        
		        <div className="modal-actions">
		          <button onClick={() => { setShowSessionDetailModal(false); setSessionDetail(null); }}>关闭</button>
		        </div>
		      </div>
		    </div>
		  )}

		  {showStorageLimitModal && storageLimitUser && (
		    <div className="modal-overlay">
		      <div className="modal">
		        <h3>设置用户存储限制 - {storageLimitUser.name}</h3>
		        <div className="form-group">
		          <label>存储空间限制 (字节)</label>
		          <input
		            type="number"
		            value={storageLimitValue}
		            onChange={(e) => setStorageLimitValue(e.target.value)}
		            placeholder="输入数值（0或空为无限制）"
		          />
		          <p style={{ fontSize: '12px', color: '#666', marginTop: '5px' }}>
		            当前已用：{formatBytes(storageLimitUser.totalSize)}
		          </p>
		        </div>
		        <div className="modal-actions">
		          <button onClick={() => { setShowStorageLimitModal(false); setStorageLimitUser(null); }}>取消</button>
		          <button className="btn-primary" onClick={handleUpdateStorageLimit}>保存</button>
		        </div>
		      </div>
		    </div>
		  )}

      {/* 确认对话框 */}
      <ConfirmDialog
        open={confirmState.open}
        title={confirmState.title}
        message={confirmState.message}
        type={confirmState.type}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
		</div>
	  </div>
    );
  };
