/* 
 * 用户列表组件 - UserList.tsx
 * 
 * 功能：显示会话列表（左侧边栏）
 * - 显示所有会话/好友/群聊/未读消息
 * - 显示每个会话的最后一条消息和时间
 * - 显示未读消息数量
 */

import React, { useState, useEffect } from 'react';
import { User } from '../types';
import { API } from '../config/api';
import { getAvatarUrl } from '../utils/tools';
import { formatTimestamp, convertServerTime } from '../utils/time';
import { Shield, Gem, BellRing, VolumeX, UserX } from 'lucide-react';
import { api } from '../services/api';


// ==================== 属性类型 ====================
interface UserListProps {
  onSelectUser: (user: User) => void;          // 选择用户/会话的回调
  activeUser: User | null;                       // 当前选中的会话
  conversations?: any[];                         // 会话列表（从父组件传入）
  onConversationsUpdate?: (convs: any[]) => void;  // 更新会话列表的回调
  searchKeyword?: string;                       // 搜索关键词
  onTogglePin?: (convId: string, isPinned: boolean) => void;  // 置顶回调
  onToggleMute?: (convId: string, isMuted: boolean) => void;  // 免打扰回调
  isLoading?: boolean;                          // 是否正在加载
}

// ==================== 组件定义 ====================
export const UserList: React.FC<UserListProps> = ({ 
  onSelectUser, 
  activeUser, 
  conversations = [],
  onConversationsUpdate,
  searchKeyword = '',
  isLoading = false,
  onTogglePin,
  onToggleMute
}) => {
  const [localConvs, setLocalConvs] = useState(conversations);  // 本地会话列表
  const [activeTab, setActiveTab] = useState<'all' | 'friends' | 'groups' | 'unread'>('all');  // 当前标签页
  const [contextMenu, setContextMenu] = useState<{x: number, y: number, conv: any} | null>(null);
  const [hoveredUser, setHoveredUser] = useState<{x: number, y: number, conv: any} | null>(null);
  const [userDetails, setUserDetails] = useState<{role?: string; signature?: string; username?: string; name?: string} | null>(null);
  const [pendingRequests, setPendingRequests] = useState<{ [groupId: string]: number }>({});  // 每个群的待处理申请数量

  // 获取所有群的待处理入群申请数量
  const fetchPendingRequests = async () => {
    try {
      const res = await api.group.getOwnedJoinRequests();
      if (res.success && res.data) {
        const counts: { [groupId: string]: number } = {};
        res.data.forEach((req: any) => {
          if (req.status === 'pending') {
            counts[req.groupId] = (counts[req.groupId] || 0) + 1;
          }
        });
        setPendingRequests(counts);
      }
    } catch (err) {
      console.error('获取待处理申请失败:', err);
    }
  };

  // 监听新的入群申请事件
  useEffect(() => {
    const handleNewJoinRequest = () => {
      fetchPendingRequests();
    };
    window.addEventListener('newJoinRequest', handleNewJoinRequest);
    return () => {
      window.removeEventListener('newJoinRequest', handleNewJoinRequest);
    };
  }, []);

  // 监听处理入群申请事件
  useEffect(() => {
    const handleJoinRequestProcessed = () => {
      fetchPendingRequests();
    };
    window.addEventListener('joinRequestProcessed', handleJoinRequestProcessed);
    return () => {
      window.removeEventListener('joinRequestProcessed', handleJoinRequestProcessed);
    };
  }, []);

  // 初始化时获取一次
  useEffect(() => {
    fetchPendingRequests();
  }, []);

  // 当会话列表或搜索关键词更新时，重新过滤和排序
  useEffect(() => {
    let filtered = [...conversations];
    
    // 搜索过滤
    if (searchKeyword.trim()) {
      const keyword = searchKeyword.toLowerCase();
      filtered = filtered.filter(conv => 
        conv.name?.toLowerCase().includes(keyword) ||
        conv.lastMessage?.toLowerCase().includes(keyword)
      );
    }
    
    // 按置顶优先，然后按最后消息时间倒序排列
    filtered.sort((a, b) => {
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return 1;
      return (b.lastTime || 0) - (a.lastTime || 0);
    });
    setLocalConvs(filtered);
  }, [conversations, searchKeyword]);

  // ==================== 筛选会话 ====================
  // 根据当前标签页筛选会话列表
  const getFilteredConversations = () => {
    let filtered = localConvs;
    
    switch (activeTab) {
      case 'friends':  // 仅好友私聊
        filtered = localConvs.filter(c => c.type === 'friend');
        break;
      case 'groups':  // 仅群聊
        filtered = localConvs.filter(c => c.type === 'group');
        break;
      case 'unread':  // 有未读消息的
        filtered = localConvs.filter(c => c.unread > 0);
        break;
      default:        // 全部
        filtered = localConvs;
    }
    
    return filtered;
  };

  // ==================== 统计数量 ====================
  const getCounts = () => {
    return {
      all: localConvs.length,
      friends: localConvs.filter(c => c.type === 'friend').length,
      groups: localConvs.filter(c => c.type === 'group').length,
      unread: localConvs.filter(c => c.unread > 0).length
    };
  };

  const counts = getCounts();
  const filteredConvs = getFilteredConversations();

  const formatTime = (timestamp: number) => {
    return formatTimestamp(timestamp, 'time');
  };

  const getStatusClass = (status?: string) => {
    switch (status) {
      case 'online': return 'status-online';
      case 'away': return 'status-away';
      case 'muted': return 'status-muted';
      case 'banned': return 'status-banned';
      default: return 'status-offline';
    }
  };

  const handleSelect = (conv: any) => {
    onSelectUser({ 
      id: conv.id, 
      name: conv.name, 
      avatar: getAvatarUrl(conv.avatar) || '', 
      status: conv.status || 'online',
      type: conv.type,
      role: conv.role,
      signature: conv.signature,
      username: conv.username,
      otherUserId: conv.otherUserId
    });
    setContextMenu(null);
  };

  const handleContextMenu = (e: React.MouseEvent, conv: any) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, conv });
  };

  const handleTogglePin = () => {
    if (contextMenu && onTogglePin) {
      onTogglePin(contextMenu.conv.id, !contextMenu.conv.isPinned);
      setContextMenu(null);
    }
  };

  const handleToggleMute = () => {
    if (contextMenu && onToggleMute) {
      onToggleMute(contextMenu.conv.id, !contextMenu.conv.isMuted);
      setContextMenu(null);
    }
  };

  // 点击其他地方关闭右键菜单
  const handleContainerClick = () => {
    if (contextMenu) {
      setContextMenu(null);
    }
  };

  // 悬停头像显示详情 - 直接从会话数据中获取
  const handleMouseEnter = (e: React.MouseEvent, conv: any) => {
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    setHoveredUser({
      x: rect.left,
      y: rect.top,
      conv
    });
    
    // 直接从会话数据中获取用户信息（包含 role, username, signature）
    if (conv.type === 'friend') {
      setUserDetails({ 
        role: conv.role || 'user', 
        signature: conv.signature || '', 
        username: conv.username || '',
        name: conv.name || ''
      });
    }
  };

  const handleMouseLeave = () => {
    setHoveredUser(null);
    setUserDetails(null);
  };
  
  // 移除不需要的 API 调用

  return (
    <div className="user-list-container" onClick={handleContainerClick}>
      {/* Tabs */}
      <div className="tabs">
        <span 
          className={`tab-item ${activeTab === 'all' ? 'active' : ''}`}
          onClick={() => setActiveTab('all')}
        >
          全部 {counts.all}
        </span>
        <span 
          className={`tab-item ${activeTab === 'friends' ? 'active' : ''}`}
          onClick={() => setActiveTab('friends')}
        >
          好友 {counts.friends}
        </span>
        <span 
          className={`tab-item ${activeTab === 'groups' ? 'active' : ''}`}
          onClick={() => setActiveTab('groups')}
        >
          群聊 {counts.groups}
        </span>
        <span 
          className={`tab-item ${activeTab === 'unread' ? 'active' : ''}`}
          onClick={() => setActiveTab('unread')}
          style={{ position: 'relative' }}
        >
          未读 {counts.unread}
          {counts.unread > 0 && activeTab !== 'unread' && (
            <span style={{
              position: 'absolute',
              top: '-2px',
              right: '5px',
              width: '8px',
              height: '8px',
              backgroundColor: '#ff4757',
              borderRadius: '50%'
            }}></span>
          )}
        </span>
      </div>

      {/* Contact list */}
      <div className="contacts">
        {filteredConvs.map((conv) => (
            <div
              key={conv.id}
              className={`contact ${activeUser?.id === conv.id ? 'active' : ''}`}
              onClick={() => handleSelect(conv)}
              onContextMenu={(e) => handleContextMenu(e, conv)}
              style={{ opacity: conv.isMuted ? 0.7 : 1 }}
            >
              <div className="avatar" onMouseEnter={(e) => handleMouseEnter(e, conv)} onMouseLeave={handleMouseLeave}>
                {conv.isPinned && (
                  <div style={{ 
                    position: 'absolute', 
                    top: '-4px', 
                    right: '-4px', 
                    background: 'var(--primary)', 
                    borderRadius: '50%', 
                    width: '18px', 
                    height: '18px', 
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'center',
                    boxShadow: 'var(--shadow-sm)',
                    zIndex: 5,
                    color: 'white',
                    fontSize: '10px'
                  }}>
                    📌
                  </div>
                )}
                {conv.avatar ? (
                  <img 
                    src={getAvatarUrl(conv.avatar)} 
                    alt="" 
                    style={{ 
                      width: '100%', 
                      height: '100%', 
                      borderRadius: '50%', 
                      objectFit: 'cover'
                    }} 
                  />
                ) : (
                  <span style={{ width: '100%', height: '100%', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {conv.name?.charAt(0) || '?'}
                  </span>
                )}
                {conv.type === 'friend' && conv.status !== 'online' && (
                  <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(128,128,128,0.5)', borderRadius: '50%' }}></div>
                )}
                {conv.type === 'friend' && conv.role === 'admin' && (
                  <div style={{ position: 'absolute', bottom: -2, left: -2, background: '#ff4757', borderRadius: '50%', width: '16px', height: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Shield size={10} color="#fff" /></div>
                )}
                {conv.type === 'friend' && conv.role === 'vip' && (
                  <div style={{ position: 'absolute', bottom: -2, left: -2, background: '#ffa502', borderRadius: '50%', width: '16px', height: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Gem size={10} color="#fff" /></div>
                )}
                {conv.type === 'friend' && conv.status === 'muted' && (
                  <div style={{ position: 'absolute', top: -4, left: -4, background: 'var(--muted)', borderRadius: '50%', width: '16px', height: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid white', zIndex: 10 }} title="已被禁言"><VolumeX size={8} color="#fff" /></div>
                )}
                {conv.type === 'friend' && conv.status === 'banned' && (
                  <div style={{ position: 'absolute', top: -4, left: -4, background: 'var(--banned)', borderRadius: '50%', width: '16px', height: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid white', zIndex: 10 }} title="已被封禁"><UserX size={8} color="#fff" /></div>
                )}
                {conv.type === 'friend' && <div className={`status-indicator ${getStatusClass(conv.status)}`}></div>}
              </div>
            <div className="contact-info">
              <div className="contact-name">{conv.name}</div>
              <div className="contact-message">
                {conv.type === 'group' && <span style={{color: '#7209b7'}}>【群】</span>}
                {conv.lastMessage || '暂无消息'}
              </div>
            </div>
            <div className="contact-time">
              {conv.type === 'group' && pendingRequests[conv.id] > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '2px' }}>
                  <BellRing 
                    size={20} 
                    color="#dc2626"
                    style={{ animation: 'bellRing 1s ease-in-out infinite' }}
                  />
                  <span style={{ fontSize: '14px', color: '#dc2626', fontWeight: 500, animation: 'pulse 1s ease-in-out infinite' }}>{pendingRequests[conv.id]}</span>
                </div>
              )}
              {formatTime(conv.lastTime)}
              {conv.unread > 0 && <div className="unread-badge">{conv.unread}</div>}
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="loading-indicator" style={{ padding: '20px', textAlign: 'center' }}>
            <span className="loading-spinner"></span>
          </div>
        ) || (
			filteredConvs.length === 0 && (
			  <div style={{ padding: '20px', textAlign: 'center', color: '#6c757d' }}>
			    暂无会话
			  </div>
			)
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div 
          className="context-menu"
          style={{ 
            position: 'fixed', 
            left: contextMenu.x, 
            top: contextMenu.y,
            zIndex: 1000
          }}
        >
          <div onClick={handleTogglePin}>
            {contextMenu.conv.isPinned ? '📌 取消置顶' : '📌 置顶会话'}
          </div>
          <div onClick={handleToggleMute}>
            {contextMenu.conv.isMuted ? '🔔 开启通知' : '🔕 免打扰'}
          </div>
        </div>
      )}

      {/* Hover Card */}
      {hoveredUser && hoveredUser.conv.type === 'friend' && (
        <div 
          className="user-hover-card"
          style={{ 
            position: 'fixed',
            left: hoveredUser.x + 50,
            top: hoveredUser.y,
            zIndex: 1000,
            borderRadius: '8px',
            padding: '12px',
            boxShadow: '0 2px 12px rgba(0,0,0,0.15)',
            minWidth: '180px'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
            <div style={{ width: '40px', height: '40px', borderRadius: '50%', overflow: 'hidden', flexShrink: 0, position: 'relative' }}>
              {hoveredUser.conv.avatar ? (
                <img src={getAvatarUrl(hoveredUser.conv.avatar)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <div style={{ width: '100%', height: '100%', background: '#4a90d9', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px' }}>
                  {hoveredUser.conv.name?.charAt(0) || '?'}
                </div>
              )}
              {hoveredUser.conv.type === 'friend' && hoveredUser.conv.status !== 'online' && (
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(128,128,128,0.5)', borderRadius: '50%' }}></div>
              )}
            </div>
            <div>
              <div style={{ fontWeight: 'bold', fontSize: '14px' }}>{hoveredUser.conv.name}</div>
            </div>
          </div>
          <div style={{ fontSize: '12px', borderTop: '1px solid', paddingTop: '8px', marginTop: '4px', opacity: 0.8 }}>
            {userDetails?.signature && (
              <div style={{ marginBottom: '4px', wordBreak: 'break-all' }}>签名：{userDetails.signature}</div>
            )}
            {userDetails?.username && (
            	<div style={{ display: 'flex', justifyContent: 'space-between' }}>
		          <span>用户名：</span>
		          <span style={{ fontSize: '14px', color: '#999' }}>
		            {userDetails.username}
		          </span>
		        </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
              <span>角色：</span>
              <span style={{ 
                color: (userDetails?.role || 'user') === 'admin' ? '#ff4757' : (userDetails?.role || 'user') === 'vip' ? '#ffa502' : 'inherit',
                fontWeight: userDetails?.role ? 'bold' : 'normal'
              }}>
                {(userDetails?.role || 'user') === 'admin' ? '管理员' : (userDetails?.role || 'user') === 'vip' ? 'VIP' : '普通用户'}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>状态：</span>
              <span style={{ 
                color: hoveredUser.conv.status === 'online' ? '#2ed573' : 
                       hoveredUser.conv.status === 'muted' ? '#f97316' : 
                       hoveredUser.conv.status === 'banned' ? '#dc2626' : 'inherit',
                fontWeight: hoveredUser.conv.status === 'muted' || hoveredUser.conv.status === 'banned' ? 'bold' : 'normal'
              }}>
                {hoveredUser.conv.status === 'online' ? '在线' : 
                 hoveredUser.conv.status === 'muted' ? '已被禁言' : 
                 hoveredUser.conv.status === 'banned' ? '已被封禁' : '离线'}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default UserList;
