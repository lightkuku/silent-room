import React, { useState, useRef, useEffect } from 'react';
import { API } from '../config/api';
import { Plus, UserPlus, Users, Search, ArrowLeft, Check, X, UserCheck, Loader2, Clock } from 'lucide-react';
import './HeaderMenu.css';
import { api } from '../services/api';
import { apiFetch } from '../utils/csrf';
import { formatTimestamp, convertServerTime } from '../utils/time';

interface HeaderMenuProps {
  onAddSuccess: () => void;
  addNotification: (type: 'success' | 'error' | 'warning' | 'info', title: string, message: string) => void;
  currentUser: any;
  getAvatarUrl: (avatar: string) => string;
  conversations?: any[];
}

const HeaderMenu: React.FC<HeaderMenuProps> = ({ 
  onAddSuccess, 
  addNotification, 
  currentUser, 
  getAvatarUrl,
  conversations = []
}) => {
  const [showMenu, setShowMenu] = useState(false);
  const [menuMode, setMenuMode] = useState<'friend' | 'group' | 'createGroup' | 'joinGroup' | 'myRequests' | null>(null);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [allUsers, setAllUsers] = useState<any[]>([]);
  const [allGroups, setAllGroups] = useState<any[]>([]);
  const [groupName, setGroupName] = useState('');
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [showAllMembers, setShowAllMembers] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingUsers, setIsLoadingUsers] = useState(false);
  const [isLoadingGroups, setIsLoadingGroups] = useState(false);
  const [addingFriendId, setAddingFriendId] = useState<string | null>(null);
  const [joiningGroupId, setJoiningGroupId] = useState<string | null>(null);
  const [usersLoaded, setUsersLoaded] = useState(false);
  const [myJoinRequests, setMyJoinRequests] = useState<any[]>([]);
  const [loadingMyRequests, setLoadingMyRequests] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const usersCacheRef = useRef<any[]>([]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        handleCloseMenu();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (menuMode === 'friend' || menuMode === 'createGroup') {
      loadAllUsers();
    }
    if (menuMode === 'joinGroup') {
      loadAllGroups();
    }
    if (menuMode === 'myRequests') {
      fetchMyJoinRequests();
    }
  }, [menuMode, conversations]);

  const handleCloseMenu = () => {
    setShowMenu(false);
    setMenuMode(null);
    setSearchKeyword('');
    setAllUsers([]);
    setAllGroups([]);
    setGroupName('');
    setSelectedMembers([]);
    setShowAllMembers(true);
    usersCacheRef.current = [];
    setUsersLoaded(false);
  };

  const fetchMyJoinRequests = async () => {
    setLoadingMyRequests(true);
    try {
      const res = await api.group.getMyJoinRequests();
      if (res.success) {
        setMyJoinRequests(res.data || []);
      }
    } catch (err) {
      console.error('获取入群申请失败:', err);
    } finally {
      setLoadingMyRequests(false);
    }
  };

  const loadAllUsers = async () => {
    if (usersLoaded && usersCacheRef.current.length > 0) {
      const existingFriendIds = conversations
        .filter(c => c.type === 'friend' && (c as any).otherUserId)
        .map(c => (c as any).otherUserId);
      if (menuMode === 'friend') {
        setAllUsers(usersCacheRef.current.filter((u: any) => !existingFriendIds.includes(u.id)));
      } else {
        setAllUsers(usersCacheRef.current);
      }
      return;
    }
    
    setIsLoadingUsers(true);
    try {
      const res = await apiFetch(API.user.all, { requireCsrf: false });
      const data = await res.json();
      if (data.success) {
        usersCacheRef.current = data.data;
        setUsersLoaded(true);
        if (menuMode === 'friend') {
          const existingFriendIds = conversations
            .filter(c => c.type === 'friend' && (c as any).otherUserId)
            .map(c => (c as any).otherUserId);
          setAllUsers(data.data.filter((u: any) => !existingFriendIds.includes(u.id)));
        } else {
          setAllUsers(data.data);
        }
      }
    } catch (err) {
      console.error('加载用户列表失败:', err);
    } finally {
      setIsLoadingUsers(false);
    }
  };

  const loadAllGroups = async () => {
    setIsLoadingGroups(true);
    try {
      const res = await apiFetch(`${API.groups.search}?q=`, { requireCsrf: false });
      const data = await res.json();
      if (data.success) {
        const joinedGroupIds = conversations
          .filter(c => c.type === 'group')
          .map(c => c.id);
        setAllGroups(data.data.filter((g: any) => !joinedGroupIds.includes(g.id)));
      }
    } catch (err) {
      console.error('加载群组列表失败:', err);
    } finally {
      setIsLoadingGroups(false);
    }
  };

  const getFilteredUsers = () => {
    if (!searchKeyword.trim()) return allUsers;
    const keyword = searchKeyword.toLowerCase();
    return allUsers.filter(u => 
      u.name?.toLowerCase().includes(keyword) || 
      u.username?.toLowerCase().includes(keyword)
    );
  };

  const getFilteredGroups = () => {
    if (!searchKeyword.trim()) return allGroups;
    const keyword = searchKeyword.toLowerCase();
    return allGroups.filter(g => g.name?.toLowerCase().includes(keyword));
  };

  const handleAddFriend = async (userId: string, userName: string) => {
    if (addingFriendId) return;
    setAddingFriendId(userId);
    try {
      const res = await apiFetch(API.user.friends, {
        method: 'POST',
        body: JSON.stringify({ friendId: userId })
      });
      const data = await res.json();
      if (data.success) {
        addNotification('success', '添加成功', `已与 ${userName} 开始聊天`);
        handleCloseMenu();
        onAddSuccess();
      } else {
        addNotification('error', '添加失败', data.message || '添加好友失败');
      }
    } catch (err) {
      addNotification('error', '添加失败', '网络错误');
    } finally {
      setAddingFriendId(null);
    }
  };

  const toggleMemberSelection = (userId: string) => {
    setSelectedMembers(prev => 
      prev.includes(userId) 
        ? prev.filter(id => id !== userId)
        : [...prev, userId]
    );
  };

  const handleCreateGroup = async () => {
    if (!groupName.trim()) {
      addNotification('error', '创建失败', '请输入群组名称');
      return;
    }
    
    setIsLoading(true);
    try {
      const res = await apiFetch(API.groups.list, {
        method: 'POST',
        body: JSON.stringify({ 
          name: groupName.trim(),
          memberIds: selectedMembers
        })
      });
      const data = await res.json();
      if (data.success) {
        addNotification('success', '创建成功', `群组 "${groupName.trim()}" 已创建`);
        handleCloseMenu();
        onAddSuccess();
      } else {
        addNotification('error', '创建失败', data.message || '创建群组失败');
      }
    } catch (err) {
      addNotification('error', '创建失败', '网络错误');
    } finally {
      setIsLoading(false);
    }
  };

  const handleJoinGroup = async (groupId: string, groupName: string) => {
    if (joiningGroupId) return;
    setJoiningGroupId(groupId);
    try {
      const res = await apiFetch(API.groups.join(groupId), {
        method: 'POST'
      });
      const data = await res.json();
      if (data.success) {
        if (data.pending) {
          addNotification('info', '申请已提交', data.message || '请等待群主审核');
        } else {
          addNotification('success', '加群成功', `已加入群组 "${groupName}"`);
        }
        handleCloseMenu();
        onAddSuccess();
      } else {
        addNotification('error', '加群失败', data.message || '加入群组失败');
      }
    } catch (err) {
      addNotification('error', '加群失败', '网络错误');
    } finally {
      setJoiningGroupId(null);
    }
  };

  return (
    <div className="header-menu-container" ref={menuRef}>
      <button 
        className="header-menu-btn" 
        onClick={() => setShowMenu(!showMenu)}
        title="更多操作"
      >
        <Plus size={22} />
      </button>

      {showMenu && (
        <div className="header-menu-dropdown">
          {!menuMode ? (
            <>
              <div className="menu-item" onClick={() => setMenuMode('friend')}>
                <UserPlus size={18} className="menu-icon" />
                <span>添加好友</span>
              </div>
              <div className="menu-item" onClick={() => setMenuMode('createGroup')}>
                <Users size={18} className="menu-icon" />
                <span>创建群组</span>
              </div>
              <div className="menu-item" onClick={() => setMenuMode('joinGroup')}>
                <UserCheck size={18} className="menu-icon" />
                <span>加入群组</span>
              </div>
              <div className="menu-item" onClick={() => setMenuMode('myRequests')}>
                <Clock size={18} className="menu-icon" />
                <span>我的申请</span>
              </div>
            </>
          ) : menuMode === 'friend' ? (
            <div className="menu-content">
              <div className="menu-header">
                <button className="menu-back" onClick={handleCloseMenu}>
                  <ArrowLeft size={18} />
                </button>
                <span>添加好友</span>
              </div>
              <div className="menu-body">
                <div className="search-input-wrapper">
                  <Search size={16} className="search-icon" />
                  <input
                    type="text"
                    placeholder="搜索用户..."
                    value={searchKeyword}
                    onChange={(e) => setSearchKeyword(e.target.value)}
                    autoFocus
                  />
                </div>
                <div className="user-list">
                  {isLoadingUsers ? (
                    <div className="loading-state">
                      <Loader2 size={24} className="spin" />
                      <span>加载中...</span>
                    </div>
                  ) : getFilteredUsers().map((user) => (
                    <div 
                      key={user.id} 
                      className={`user-item clickable ${addingFriendId === user.id ? 'loading' : ''}`}
                      onClick={() => handleAddFriend(user.id, user.name)}
                    >
                      <div className="user-avatar">
                        {user.avatar ? (
                          <img src={getAvatarUrl(user.avatar)} alt="" />
                        ) : (
                          user.name?.charAt(0) || '?'
                        )}
                      </div>
                      <div className="user-info">
                        <div className="user-name">{user.name}</div>
                        <div className="user-status">@{user.username}</div>
                      </div>
                      {addingFriendId === user.id ? (
                        <Loader2 size={16} className="loading-icon spin" />
                      ) : (
                        <UserPlus size={16} className="add-icon" />
                      )}
                    </div>
                  ))}
                  {!isLoadingUsers && getFilteredUsers().length === 0 && (
                    <div className="no-results">
                      {searchKeyword ? '未找到用户' : '暂无可添加的用户'}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : menuMode === 'createGroup' ? (
            <div className="menu-content">
              <div className="menu-header">
                <button className="menu-back" onClick={handleCloseMenu}>
                  <ArrowLeft size={18} />
                </button>
                <span>创建群组</span>
              </div>
              <div className="menu-body">
                <div className="group-name-input">
                  <input
                    type="text"
                    placeholder="输入群组名称..."
                    value={groupName}
                    onChange={(e) => setGroupName(e.target.value)}
                    autoFocus
                  />
                </div>
                
                <div className="member-select-header">
                  <span className="member-select-label">选择成员</span>
                  <label className="select-all-checkbox">
                    <input
                      type="checkbox"
                      checked={showAllMembers}
                      onChange={(e) => {
                        const isAllMembers = e.target.checked;
                        setShowAllMembers(isAllMembers);
                        if (isAllMembers) {
                          const allMemberIds = usersCacheRef.current
                            .filter(u => u.id !== currentUser?.id)
                            .map(u => u.id);
                          setSelectedMembers(allMemberIds);
                        } else {
                          setSelectedMembers([]);
                        }
                      }}
                    />
                    <span>所有成员</span>
                  </label>
                </div>
                
                {!showAllMembers && (
                  <>
                    <div className="search-input-wrapper">
                      <Search size={16} className="search-icon" />
                      <input
                        type="text"
                        placeholder="搜索用户..."
                        value={searchKeyword}
                        onChange={(e) => setSearchKeyword(e.target.value)}
                      />
                    </div>
                    
                    {selectedMembers.length > 0 && (
                      <div className="selected-members">
                        {selectedMembers.map(memberId => {
                          const member = allUsers.find(u => u.id === memberId);
                          return member ? (
                            <span key={memberId} className="selected-member-tag">
                              {member.name}
                              <X 
                                size={12} 
                                onClick={() => toggleMemberSelection(memberId)}
                              />
                            </span>
                          ) : null;
                        })}
                      </div>
                    )}
                    
                    <div className="user-list selectable">
                      {isLoadingUsers ? (
                        <div className="loading-state">
                          <Loader2 size={24} className="spin" />
                          <span>加载中...</span>
                        </div>
                      ) : getFilteredUsers()
                        .filter(u => u.id !== currentUser?.id)
                        .map((user) => (
                          <div 
                            key={user.id} 
                            className={`user-item clickable ${selectedMembers.includes(user.id) ? 'selected' : ''}`}
                            onClick={() => toggleMemberSelection(user.id)}
                          >
                            <div className="user-avatar">
                              {user.avatar ? (
                                <img src={getAvatarUrl(user.avatar)} alt="" />
                              ) : (
                                user.name?.charAt(0) || '?'
                              )}
                            </div>
                            <div className="user-info">
                              <div className="user-name">{user.name}</div>
                              <div className="user-status">@{user.username}</div>
                            </div>
                            {selectedMembers.includes(user.id) && (
                              <Check size={16} className="check-icon" />
                            )}
                          </div>
                        ))}
                      {!isLoadingUsers && getFilteredUsers().filter(u => u.id !== currentUser?.id).length === 0 && (
                        <div className="no-results">暂无其他用户</div>
                      )}
                    </div>
                  </>
                )}
                
                <button 
                  className="create-btn" 
                  onClick={handleCreateGroup}
                  disabled={!groupName.trim() || isLoading}
                >
                  {isLoading ? '创建中...' : `创建群组${showAllMembers ? ` (${selectedMembers.length + 1}人)` : ' (所有成员)'}`}
                </button>
              </div>
            </div>
          ) : menuMode === 'joinGroup' ? (
            <div className="menu-content">
              <div className="menu-header">
                <button className="menu-back" onClick={handleCloseMenu}>
                  <ArrowLeft size={18} />
                </button>
                <span>加入群组</span>
              </div>
              <div className="menu-body">
                <div className="search-input-wrapper">
                  <Search size={16} className="search-icon" />
                  <input
                    type="text"
                    placeholder="搜索群组..."
                    value={searchKeyword}
                    onChange={(e) => setSearchKeyword(e.target.value)}
                    autoFocus
                  />
                </div>
                <div className="user-list">
                  {isLoadingGroups ? (
                    <div className="loading-state">
                      <Loader2 size={24} className="spin" />
                      <span>加载中...</span>
                    </div>
                  ) : getFilteredGroups().map((group) => (
                    <div 
                      key={group.id} 
                      className={`user-item clickable ${joiningGroupId === group.id ? 'loading' : ''}`}
                      onClick={() => handleJoinGroup(group.id, group.name)}
                    >
                      <div className="user-avatar group-avatar">
                        <Users size={18} />
                      </div>
                      <div className="user-info">
                        <div className="user-name">{group.name}</div>
                        <div className="user-status">{group.memberCount} 位成员</div>
                      </div>
                      {joiningGroupId === group.id ? (
                        <Loader2 size={16} className="loading-icon spin" />
                      ) : (
                        <UserPlus size={16} className="add-icon" />
                      )}
                    </div>
                  ))}
                  {!isLoadingGroups && getFilteredGroups().length === 0 && (
                    <div className="no-results">
                      {searchKeyword ? '未找到群组' : '暂无可加入的群组'}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : menuMode === 'myRequests' ? (
            <div className="menu-content">
              <div className="menu-header">
                <button className="menu-back" onClick={handleCloseMenu}>
                  <ArrowLeft size={18} />
                </button>
                <span>我的申请</span>
              </div>
              <div className="menu-body">
                {loadingMyRequests ? (
                  <div className="loading-state">
                    <Loader2 size={24} className="spin" />
                    <span>加载中...</span>
                  </div>
                ) : myJoinRequests.length === 0 ? (
                  <div className="no-results">
                    暂无入群申请
                  </div>
                ) : (
                  <div className="user-list">
                    {myJoinRequests.map((request) => (
                      <div key={request.id} className="user-item">
                        <div className="user-avatar group-avatar">
                          <Users size={18} />
                        </div>
                        <div className="user-info">
                          <div className="user-name">{request.groupName || '群聊'}</div>
                          <div className="user-status">
                            {request.status === 'pending' ? '待审核' : 
                             request.status === 'approved' ? '已通过' : '已拒绝'}
                          </div>
                          <div className="user-status" style={{ fontSize: '11px', marginTop: '2px' }}>
                            申请时间: {formatTimestamp(request.createdAt)}
                          </div>
                          {request.reason && (
                            <div className="user-status" style={{ fontSize: '11px', color: '#666' }}>
                              申请理由: {request.reason}
                            </div>
                          )}
                        </div>
                        <span className={`request-status-badge ${request.status}`}>
                          {request.status === 'pending' ? '待审' : 
                           request.status === 'approved' ? '通过' : '拒绝'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
};

export default HeaderMenu;
