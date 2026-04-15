import { useState, useEffect } from 'react';
import { Bell, CheckCheck, Trash2, X } from 'lucide-react';
import { API } from '../config/api';
import { apiFetch } from '../utils/csrf';
import { formatTimestamp } from '../utils/time';

const getTheme = () => {
  if (typeof window !== 'undefined') {
    return document.documentElement.getAttribute('data-theme') || 'light';
  }
  return 'light';
};

const getThemeColors = (theme: string) => {
  if (theme === 'dark') {
    return {
      bg: '#1a1a2e',
      bgSecondary: '#16213e',
      bgTertiary: '#1e2a4a',
      border: '#3a3a5c',
      text: '#fff',
      textSecondary: '#aaa',
      overlay: 'rgba(0,0,0,0.5)',
    };
  }
  return {
    bg: '#ffffff',
    bgSecondary: '#f8fafc',
    bgTertiary: '#f1f5f9',
    border: '#e2e8f0',
    text: '#1e293b',
    textSecondary: '#64748b',
    overlay: 'rgba(0,0,0,0.3)',
  };
};

interface Notification {
  id: string;
  userId: string;
  type: string;
  title: string;
  content: string;
  data: string;
  read: number;
  createdAt: number;
}

interface NotificationPanelProps {
  isOpen: boolean;
  onClose: () => void;
  isAdmin?: boolean;
  showToast?: (type: 'success' | 'error' | 'warning' | 'info', title: string, message: string) => void;
  onUnreadCountChange?: (count: number) => void;
}

const getTypeLabel = (type: string) => {
  const labels: Record<string, string> = { report: '举报', join: '入群', system: '系统' };
  return labels[type] || type;
};

export default function NotificationPanel({ isOpen, onClose, isAdmin = false, showToast, onUnreadCountChange }: NotificationPanelProps) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [unreadCount, setUnreadCount] = useState(0);
  const [filter, setFilter] = useState<'all' | 'unread' | 'read'>('all');
  const [theme] = useState(getTheme());
  const colors = getThemeColors(theme);

  useEffect(() => {
    if (isOpen) fetchNotifications();
  }, [isOpen, page, filter]);

  const fetchNotifications = async () => {
    setLoading(true);
    try {
      let url = `${API.notifications.notifications}?page=${page}&limit=20`;
      if (filter === 'unread') url += '&read=0';
      else if (filter === 'read') url += '&read=1';
      
      const res = await apiFetch(url);
      // console.log('[通知] filter:', filter, 'status:', res.status);
      
      if (!res.ok) {
        const errText = await res.text();
        console.error('[通知] error:', res.status, errText);
        return;
      }
      
      const text = await res.text();
      // console.log('[通知] response:', text.substring(0, 200));
      const data = JSON.parse(text);
      
      if (data.success) {
        setNotifications(data.data || []);
        const count = data.unreadCount || 0;
        setUnreadCount(count);
        onUnreadCountChange?.(count);
      }
    } catch (e) {
      console.error('获取通知失败:', e);
    } finally {
      setLoading(false);
    }
  };

  const markAsRead = async (id: string) => {
    const res = await apiFetch(API.notifications.markRead(id), { method: 'PUT' });
    const data = await res.json();
    if (data.success) {
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: 1 } : n));
      setUnreadCount(prev => Math.max(0, prev - 1));
      showToast?.('success', '已标记', '通知已标记为已读');
    } else {
      showToast?.('error', '操作失败', data.message || '标记已读失败');
    }
  };

  const markAllAsRead = async () => {
    const res = await apiFetch(API.notifications.readAll, { method: 'PUT' });
    const data = await res.json();
    if (data.success) {
      setNotifications(prev => prev.map(n => ({ ...n, read: 1 })));
      setUnreadCount(0);
      showToast?.('success', '已标记', '所有通知已标记为已读');
    } else {
      showToast?.('error', '操作失败', data.message || '标记全部已读失败');
    }
  };

  const deleteNotification = async (id: string) => {
    const res = await apiFetch(API.notifications.deleteNotification(id), { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      const deleted = notifications.find(n => n.id === id);
      setNotifications(prev => prev.filter(n => n.id !== id));
      if (deleted && deleted.read === 0) setUnreadCount(prev => Math.max(0, prev - 1));
      showToast?.('success', '已删除', '通知已删除');
    } else {
      showToast?.('error', '操作失败', data.message || '删除失败');
    }
  };

  const deleteReadNotifications = async () => {
    const res = await apiFetch(API.notifications.deleteRead, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      setNotifications(prev => prev.filter(n => n.read === 0));
      showToast?.('success', '已删除', '已删除所有已读通知');
    } else {
      showToast?.('error', '操作失败', data.message || '删除失败');
    }
  };

  const deleteAllNotifications = async () => {
    if (!confirm('确定要删除所有通知吗？此操作不可恢复。')) return;
    const res = await apiFetch(API.notifications.deleteAll, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      setNotifications([]);
      setUnreadCount(0);
      showToast?.('success', '已删除', '已删除所有通知');
    } else {
      showToast?.('error', '操作失败', data.message || '删除失败');
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, background: colors.overlay, zIndex: 999 }} onClick={onClose} />
      <div style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
        background: colors.bg, borderRadius: 12, width: '90%', maxWidth: 500, maxHeight: '80vh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden', zIndex: 1000, color: colors.text
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottom: `1px solid ${colors.border}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 18, fontWeight: 600 }}>
            <Bell size={20} />
            <span>通知中心</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 14, color: colors.textSecondary }}>
              {notifications.length} 条
            </span>
            {unreadCount > 0 && (
              <span style={{ background: '#ef4444', color: '#fff', fontSize: 12, padding: '2px 6px', borderRadius: 8 }}>
                {unreadCount} 未读
              </span>
            )}
          </div>
          <button style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: colors.textSecondary }} onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div style={{ display: 'flex', gap: 8, padding: '12px 16px', borderBottom: `1px solid ${colors.border}` }}>
          <select value={filter} onChange={e => setFilter(e.target.value as any)}
            style={{ padding: '6px 12px', borderRadius: 6, border: `1px solid ${colors.border}`, background: colors.bgSecondary, color: colors.text }}>
            <option value="all">全部</option>
            <option value="unread">未读</option>
            <option value="read">已读</option>
          </select>
          {notifications.length > 0 && (
            <button onClick={deleteAllNotifications} title="删除全部" style={{ padding: 6, borderRadius: 6, border: `1px solid ${colors.border}`, background: colors.bgSecondary, color: colors.textSecondary, cursor: 'pointer' }}>
              <Trash2 size={16} />
            </button>
          )}
          {unreadCount > 0 && (
            <button onClick={markAllAsRead} title="全部标记已读" style={{ padding: 6, borderRadius: 6, border: `1px solid ${colors.border}`, background: colors.bgSecondary, color: colors.textSecondary, cursor: 'pointer' }}>
              <CheckCheck size={16} />
            </button>
          )}
          <button onClick={deleteReadNotifications} title="删除已读" style={{ padding: 6, borderRadius: 6, border: `1px solid ${colors.border}`, background: colors.bgSecondary, color: colors.textSecondary, cursor: 'pointer' }}>
            <Trash2 size={16} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
          {loading ? (
            <div className="loading-spinner" style={{ margin: 40, alignSelf: 'center' }} />
          ) : notifications.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 40, color: colors.textSecondary }}>暂无通知</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {notifications.map(n => (
                <div key={n.id} style={{
                  display: 'flex', padding: 12, borderRadius: 8,
                  background: n.read === 0 ? colors.bgTertiary : colors.bgSecondary,
                  borderLeft: n.read === 0 ? '3px solid #3b82f6' : '3px solid transparent'
                }} onClick={() => markAsRead(n.id)}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ fontSize: 12, color: '#3b82f6', background: 'rgba(59,130,246,0.1)', padding: '2px 8px', borderRadius: 4 }}>
                        {getTypeLabel(n.type)}
                      </span>
                      <span style={{ fontSize: 12, color: colors.textSecondary }}>{formatTimestamp(n.createdAt, 'relative')}</span>
                    </div>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>{n.title}</div>
                    <div style={{ fontSize: 14, color: colors.textSecondary }}>{n.content}</div>
                  </div>
                  <button onClick={e => { e.stopPropagation(); deleteNotification(n.id); }}
                    style={{ padding: 8, background: 'none', border: 'none', color: colors.textSecondary, cursor: 'pointer' }}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {notifications.length >= 20 && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 16, padding: 12, borderTop: `1px solid ${colors.border}` }}>
            <button disabled={page === 1} onClick={() => setPage(p => Math.max(1, p - 1))}
              style={{ padding: '6px 16px', borderRadius: 6, border: `1px solid ${colors.border}`, background: colors.bgSecondary, color: colors.text, cursor: 'pointer' }}>
              上一页
            </button>
            <span style={{ fontSize: 14, color: colors.text }}>第 {page} 页</span>
            <button onClick={() => setPage(p => p + 1)}
              style={{ padding: '6px 16px', borderRadius: 6, border: `1px solid ${colors.border}`, background: colors.bgSecondary, color: colors.text, cursor: 'pointer' }}>
              下一页
            </button>
          </div>
        )}
      </div>
    </>
  );
}
