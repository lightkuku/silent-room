import React, { useState, useRef, useEffect } from 'react';
import { User, Palette, Shield, Bell, Info, Key, ChevronRight, Upload, Trash2, Moon, Sun, Monitor, Check, Copy, Eye, EyeOff, Lock, Download, AlertTriangle, LogOut, UserCog, MessageCircle, ShieldCheck, Type, Image } from 'lucide-react';
import API from '../config/api';
import { apiFetch } from '../utils/csrf';
import { showConfirm } from './ConfirmDialog';
import { Jimp } from 'jimp';
import { loadAppSettings, saveAppSettings, applyAppSettings, getTimezoneOptions, AppSettings, generateTwoFactorSecret, generateTwoFactorCode, verifyTwoFactorCode, getTwoFactorSecretFromStorage, setTwoFactorSecretToStorage, removeTwoFactorSecretFromStorage, loadNotificationSettings, saveNotificationSettingsToDb, NotificationSettings, saveAppSettingsToDb } from '../utils/settings';
import TwoFactorModal from './TwoFactorModal';

interface SettingsPanelProps {
  currentUser: any;
  setCurrentUser: (user: any) => void;
  onLogout: () => void;
  addNotification: (type: 'success' | 'error' | 'info' | 'warning', title: string, message: string) => void;
  getAvatarUrl: (avatar: string, timestamp?: number) => string;
}

type TabKey = 'profile' | 'appearance' | 'chat' | 'security' | 'account' | 'notifications' | 'about';

const SettingsPanel: React.FC<SettingsPanelProps> = ({
  currentUser,
  setCurrentUser,
  onLogout,
  addNotification,
  getAvatarUrl
}) => {
  // 从 localStorage 读取 siteConfig
  const siteConfig = JSON.parse(localStorage.getItem('siteConfig') || '{}');
  const [activeTab, setActiveTab] = useState<TabKey>('profile');
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [editAvatar, setEditAvatar] = useState<string>(currentUser?.avatar || '');
  const [pendingUsername, setPendingUsername] = useState<string>(currentUser?.username || '');
  const [pendingNickname, setPendingNickname] = useState<string>(currentUser?.name || '');
  const [pendingSignature, setPendingSignature] = useState<string>(currentUser?.signature || '');
  const [settingsChanged, setSettingsChanged] = useState(false);
  const [saving, setSaving] = useState(false);
  
  // 应用设置
  const [appSettings, setAppSettings] = useState<AppSettings>(loadAppSettings);
  
  const theme = appSettings.theme || 'light';
  
  const [notifications, setNotifications] = useState<NotificationSettings>(loadNotificationSettings);

  // 保存通知设置
  const handleNotificationChange = (key: keyof NotificationSettings, value: number) => {
    const newSettings = { ...notifications, [key]: value };
    setNotifications(newSettings);
    saveNotificationSettingsToDb(newSettings).then((success) => {
      if (success) {
        addNotification('success', '设置已保存', '通知设置已更新');
      } else {
        addNotification('error', '保存失败', '无法保存通知设置');
      }
    }).catch(() => {
      addNotification('error', '保存失败', '无法保存通知设置');
    });
  };

  // 密码修改弹窗
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [passwordChanging, setPasswordChanging] = useState(false);

  // 两步验证弹窗
  const [showTwoFactorModal, setShowTwoFactorModal] = useState(false);
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [twoFactorStep, setTwoFactorStep] = useState<'choose' | 'enable' | 'disable'>('choose');
  const [verifying2FA, setVerifying2FA] = useState(false);
  const [twoFactorSecret, setTwoFactorSecret] = useState<string>('');
  const [currentCode, setCurrentCode] = useState<string>('');

  // 账号删除弹窗
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const [deleting, setDeleting] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const tabs = [
    { key: 'profile' as TabKey, label: '个人资料', icon: User },
    { key: 'appearance' as TabKey, label: '外观', icon: Palette },
    { key: 'chat' as TabKey, label: '聊天', icon: MessageCircle },
    { key: 'security' as TabKey, label: '隐私与安全', icon: Shield },
    { key: 'account' as TabKey, label: '帐号', icon: UserCog },
    { key: 'notifications' as TabKey, label: '通知', icon: Bell },
    { key: 'about' as TabKey, label: '关于', icon: Info },
  ];

  useEffect(() => {
    setPendingUsername(currentUser?.username || '');
    setPendingNickname(currentUser?.name || '');
    setPendingSignature(currentUser?.signature || '');
  }, [currentUser]);

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      // 使用 jimp 处理图片
      const arrayBuffer = await file.arrayBuffer();
      const image = await Jimp.read(arrayBuffer);
      
      // 获取原始尺寸
      const width = image.width;
      const height = image.height;
      
      // 计算居中裁剪区域（取较小的边）
      const size = Math.min(width, height);
      const x = Math.floor((width - size) / 2);
      const y = Math.floor((height - size) / 2);
      
      // 裁剪并缩放到 100x100
      image.crop({ x, y, w: size, h: size });
      image.resize({ w: 100, h: 100 });
      
      // 转换为 base64 用于预览
      const result = await image.getBase64('image/jpeg');
      setAvatarPreview(result);
      setEditAvatar(result);
      setSettingsChanged(true);
    } catch (err) {
      console.error('头像处理失败:', err);
      // 失败时使用原始图片
      const reader = new FileReader();
      reader.onload = (event) => {
        const base64 = event.target?.result as string;
        setAvatarPreview(base64);
        setEditAvatar(base64);
        setSettingsChanged(true);
      };
      reader.readAsDataURL(file);
    }
  };

  // 裁剪图片（保存时调用，此时 editAvatar 已经是处理好的 base64）
  const cropImage = async (base64: string): Promise<Blob> => {
    try {
      // 从 data:image/jpeg;base64,... 提取 base64 数据
      const base64Data = base64.split(',')[1];
      const binaryString = atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return new Blob([bytes], { type: 'image/jpeg' });
    } catch (err) {
      console.error('[cropImage] error:', err);
      throw err;
    }
  };

  const handleSaveProfile = async () => {
    if (!pendingUsername.trim()) {
      addNotification('error', '保存失败', '请输入用户名');
      return;
    }
    if (!pendingNickname.trim()) {
      addNotification('error', '保存失败', '请输入昵称');
      return;
    }

    setSaving(true);
    try {
      const token = localStorage.getItem('token');
      let finalAvatar = currentUser?.avatar;

      // 如果 editAvatar 是 base64 格式（以 data:image 开头），先处理再上传
      if (editAvatar && editAvatar.startsWith('data:image')) {
        try {
          // 先压缩调整尺寸
          const resizedBlob = await cropImage(editAvatar);
          const byteArray = new Uint8Array(await resizedBlob.arrayBuffer());

          // 上传裁剪后的图片
          const avatarRes = await apiFetch(API.user.avatar, {
            method: 'POST',
            headers: { 
              'Content-Type': 'image/jpeg'
            },
            body: byteArray,
            requireCsrf: true
          });
          const avatarData = await avatarRes.json();
          if (avatarData.success) {
            finalAvatar = avatarData.data.avatar;
          } else {
            addNotification('error', '上传失败', avatarData.message || '头像上传失败');
            setSaving(false);
            return;
          }
        } catch (err) {
          console.error('头像裁剪失败:', err);
          addNotification('error', '上传失败', '头像处理失败');
          setSaving(false);
          return;
        }
      }

      // 更新用户信息
      const res = await apiFetch(API.user.info, {
        method: 'PUT',
        body: JSON.stringify({
          username: pendingUsername.trim(),
          name: pendingNickname.trim(),
          signature: pendingSignature.trim(),
          avatar: finalAvatar
        })
      });
      const data = await res.json();

      if (data.success) {
        const newUser = { ...currentUser, ...data.data };
        setCurrentUser(newUser);
        localStorage.setItem('user', JSON.stringify(newUser));
        setAvatarPreview(null);
        setEditAvatar('');
        setSettingsChanged(false);
        addNotification('success', '保存成功', '个人资料已更新');
      } else {
        addNotification('error', '保存失败', data.message || '保存失败');
      }
    } catch (e) {
      console.error('Save profile error:', e);
      addNotification('error', '保存失败', '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteAvatar = async () => {
    if (!currentUser?.avatar) return;
    
    const confirmed = await showConfirm({
      title: '删除头像',
      message: '确定要删除头像吗？',
      type: 'warning'
    });
    if (!confirmed) return;

    try {
      const res = await apiFetch(`${API.user.avatar}/${currentUser.avatar}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (data.success) {
        const newUser = { ...currentUser, avatar: '' };
        setCurrentUser(newUser);
        localStorage.setItem('user', JSON.stringify(newUser));
        addNotification('success', '删除成功', '头像已删除');
      }
    } catch (e) {
      addNotification('error', '删除失败', '删除失败');
    }
  };

  const handleCopyId = () => {
    if (currentUser?.id) {
      navigator.clipboard.writeText(currentUser.id);
      addNotification('success', '已复制', '用户ID已复制到剪贴板');
    }
  };

  const handleThemeChange = (newTheme: string) => {
    const finalTheme = newTheme === 'system' ? 'light' : newTheme;
    const newSettings = { ...appSettings, theme: finalTheme as 'light' | 'dark' };
    setAppSettings(newSettings);
    document.documentElement.setAttribute('data-theme', finalTheme);
    localStorage.setItem('theme', finalTheme);
    saveAppSettingsToDb({ theme: finalTheme as 'light' | 'dark' }).then(() => {
      addNotification('success', '主题已更改', `已切换到${newTheme === 'light' ? '浅色' : newTheme === 'dark' ? '深色' : '跟随系统'}主题`);
    }).catch(() => {
      addNotification('error', '保存失败', '无法保存主题设置');
    });
  };

  const handleExportData = async () => {
    try {
      addNotification('info', '正在导出', '正在准备您的数据...');
      
      // 获取用户信息
      const userRes = await apiFetch(API.user.info, { requireCsrf: false });
      const userData = await userRes.json();
      
      // 获取会话列表
      const convRes = await apiFetch(API.conversations.list, { requireCsrf: false });
      const convData = await convRes.json();
      
      const exportData = {
        exportTime: new Date().toISOString(),
        user: userData.data,
        conversations: convData.data?.list || [],
      };
      
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `flue-chat-export-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      
      addNotification('success', '导出成功', '数据已导出为 JSON 文件');
    } catch (e) {
      console.error('Export error:', e);
      addNotification('error', '导出失败', '导出数据时发生错误');
    }
  };

  const handleClearCache = async () => {
    const confirmed = await showConfirm({
      title: '清除缓存',
      message: '确定要清除缓存吗？这不会删除您的聊天记录和登录状态。',
      type: 'warning'
    });
    if (!confirmed) return;
    
    const cacheKeys = [
      'conversationsCache',
      'messagesCache',
      'groupsCache',
    ];
    
    let cleared = 0;
    cacheKeys.forEach(key => {
      if (localStorage.getItem(key)) {
        localStorage.removeItem(key);
        cleared++;
      }
    });
    
    addNotification('success', '清除成功', `已清除 ${cleared} 项缓存数据`);
  };

  const handleChangePassword = async () => {
    if (!currentPassword || !newPassword || !confirmPassword) {
      addNotification('error', '修改失败', '请填写所有密码字段');
      return;
    }
    if (newPassword !== confirmPassword) {
      addNotification('error', '修改失败', '两次输入的密码不一致');
      return;
    }
    if (newPassword.length < 6) {
      addNotification('error', '修改失败', '新密码长度不能少于6位');
      return;
    }

    setPasswordChanging(true);
    try {
      const res = await apiFetch(`${API.user.info}/password`, {
        method: 'PUT',
        body: JSON.stringify({
          currentPassword,
          newPassword
        })
      });
      const data = await res.json();
      if (data.success) {
        addNotification('success', '修改成功', '密码已成功修改');
        setShowPasswordModal(false);
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } else {
        addNotification('error', '修改失败', data.message || '当前密码不正确');
      }
    } catch (e) {
      console.error('Change password error:', e);
      addNotification('error', '修改失败', '修改密码时发生错误');
    } finally {
      setPasswordChanging(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (deleteConfirmText !== 'DELETE') {
      addNotification('error', '删除失败', '请输入 DELETE 确认删除');
      return;
    }
    if (!deletePassword) {
      addNotification('error', '删除失败', '请输入当前密码');
      return;
    }

    setDeleting(true);
    try {
      const res = await apiFetch(`${API.user.info}/delete`, {
        method: 'DELETE',
        body: JSON.stringify({ password: deletePassword })
      });
      const data = await res.json();
      if (data.success) {
        addNotification('success', '账号已删除', '您的账号已被永久删除');
        localStorage.clear();
        window.location.href = '/';
      } else {
        addNotification('error', '删除失败', data.message || '密码不正确');
      }
    } catch (e) {
      console.error('Delete account error:', e);
      addNotification('error', '删除失败', '删除账号时发生错误');
    } finally {
      setDeleting(false);
    }
  };

  // 两步验证相关处理
  const handleTwoFactorSetup = () => {
    if (appSettings.privacy.twoFactorEnabled) {
      setTwoFactorStep('disable');
      const secret = getTwoFactorSecretFromStorage();
      if (secret) {
        setTwoFactorSecret(secret);
        setCurrentCode(generateTwoFactorCode(secret));
      }
    } else {
      setTwoFactorStep('enable');
      const secret = generateTwoFactorSecret();
      setTwoFactorSecret(secret);
      setTwoFactorSecretToStorage(secret);
      setCurrentCode(generateTwoFactorCode(secret));
    }
    setShowTwoFactorModal(true);
  };

  const handleGenerateSecret = () => {
    const secret = generateTwoFactorSecret();
    setTwoFactorSecret(secret);
    setTwoFactorSecretToStorage(secret);
    setCurrentCode(generateTwoFactorCode(secret));
  };

  const handleGetCurrentCode = () => {
    const secret = getTwoFactorSecretFromStorage();
    if (secret) {
      setCurrentCode(generateTwoFactorCode(secret));
    }
  };

  const handleTwoFactorEnable = async (code: string): Promise<void> => {
    setVerifying2FA(true);
    try {
      const secret = getTwoFactorSecretFromStorage();
      if (!secret) {
        throw new Error('密钥不存在，请重新开启');
      }
      
      const isValid = verifyTwoFactorCode(secret, code);
      if (!isValid) {
        throw new Error('验证码不正确');
      }
      
      const newSettings = saveAppSettings({ privacy: { ...appSettings.privacy, twoFactorEnabled: true } });
      setAppSettings(newSettings);
      addNotification('success', '启用成功', '两步验证已开启');
    } catch (e: any) {
      throw new Error(e.message || '两步验证启用失败');
    } finally {
      setVerifying2FA(false);
    }
  };

  const handleTwoFactorDisable = async (code: string): Promise<void> => {
    setVerifying2FA(true);
    try {
      const secret = getTwoFactorSecretFromStorage();
      if (!secret) {
        throw new Error('密钥不存在，请重新尝试');
      }
      
      const isValid = verifyTwoFactorCode(secret, code);
      if (!isValid) {
        throw new Error('验证码不正确');
      }
      
      const newSettings = saveAppSettings({ privacy: { ...appSettings.privacy, twoFactorEnabled: false } });
      setAppSettings(newSettings);
      removeTwoFactorSecretFromStorage();
      addNotification('success', '已关闭', '两步验证已关闭');
    } catch (e: any) {
      throw new Error(e.message || '两步验证关闭失败');
    } finally {
      setVerifying2FA(false);
    }
  };

  const handleCloseTwoFactorModal = () => {
    setShowTwoFactorModal(false);
    setTwoFactorCode('');
    setTwoFactorStep('choose');
    setTwoFactorSecret('');
    setCurrentCode('');
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'profile':
        return (
          <div className="settings-tab-content">
            <h3>个人资料</h3>
            <p className="settings-tab-desc">管理您的个人信息和头像</p>

            <div className="settings-avatar-section">
              <div className="settings-avatar-large">
                {avatarPreview ? (
                  <img src={avatarPreview} alt="avatar" />
                ) : currentUser?.avatar ? (
                  <img src={getAvatarUrl(currentUser.avatar)} alt="avatar" />
                ) : (
                  <span>{currentUser?.name?.charAt(0) || 'U'}</span>
                )}
                <label className="avatar-upload-overlay">
                  <Upload size={24} />
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleAvatarChange}
                    hidden
                  />
                </label>
              </div>
              <div className="settings-avatar-actions">
                <button className="settings-btn-secondary" onClick={() => fileInputRef.current?.click()}>
                  <Upload size={16} /> 上传头像
                </button>
                {currentUser?.avatar && (
                  <button className="settings-btn-danger" onClick={handleDeleteAvatar}>
                    <Trash2 size={16} /> 删除头像
                  </button>
                )}
              </div>
            </div>

            <div className="settings-form">
              <div className="settings-form-group">
                <label>用户ID</label>
                <div className="settings-input-with-action">
                  <input type="text" value={currentUser?.id || ''} disabled />
                  <button className="settings-btn-copy" onClick={handleCopyId} title="复制ID">
                    <Copy size={16} />
                  </button>
                </div>
              </div>
              <div className="settings-form-group">
                <label>用户名</label>
                <input
                  type="text"
                  value={pendingUsername}
                  onChange={(e) => {
                    setPendingUsername(e.target.value);
                    setSettingsChanged(true);
                  }}
                  placeholder="输入用户名"
                />
              </div>
              <div className="settings-form-group">
                <label>昵称</label>
                <input
                  type="text"
                  value={pendingNickname}
                  onChange={(e) => {
                    setPendingNickname(e.target.value);
                    setSettingsChanged(true);
                  }}
                  placeholder="输入昵称"
                />
              </div>
              <div className="settings-form-group">
                <label>个性签名</label>
                <textarea
                  value={pendingSignature}
                  onChange={(e) => {
                    setPendingSignature(e.target.value);
                    setSettingsChanged(true);
                  }}
                  placeholder="输入个性签名"
                  rows={3}
                />
              </div>
            </div>

            {settingsChanged && (
              <div className="settings-actions">
                <button className="settings-btn-primary" onClick={handleSaveProfile} disabled={saving}>
                  {saving ? '保存中...' : '保存更改'}
                </button>
                <button className="settings-btn-secondary" onClick={() => {
                  setPendingUsername(currentUser?.username || '');
                  setPendingNickname(currentUser?.name || '');
                  setPendingSignature(currentUser?.signature || '');
                  setAvatarPreview(null);
                  setSettingsChanged(false);
                }}>
                  取消
                </button>
              </div>
            )}
            </div>
          );

      case 'appearance':
        return (
          <div className="settings-tab-content">
            <h3>外观</h3>
            <p className="settings-tab-desc">自定义应用的外观和显示效果</p>

            <div className="settings-section">
              <h4>主题</h4>
              <div className="theme-options">
                {[
                  { value: 'light', label: '浅色', icon: Sun },
                  { value: 'dark', label: '深色', icon: Moon },
                  { value: 'system', label: '跟随系统', icon: Monitor }
                ].map(({ value, label, icon: Icon }) => (
                  <button
                    key={value}
                    className={`theme-option ${theme === value ? 'active' : ''}`}
                    onClick={() => handleThemeChange(value)}
                  >
                    <div className={`theme-preview ${value}`}>
                      <Icon size={20} />
                    </div>
                    <span>{label}</span>
                    {theme === value && <Check size={16} className="theme-check" />}
                  </button>
                ))}
              </div>
            </div>
          </div>
        );

      case 'chat':
        return (
          <div className="settings-tab-content">
            <h3>聊天设置</h3>
            <p className="settings-tab-desc">自定义聊天体验</p>

            <div className="settings-section">
              <h4>字体大小</h4>
              <div className="font-size-options">
                {[
                  { value: 'small', label: '小', size: 16 },
                  { value: 'medium', label: '中', size: 18 },
                  { value: 'large', label: '大', size: 22 }
                ].map(({ value, label, size }) => (
                  <button
                    key={value}
                    className={`font-size-option ${appSettings.chat.fontSize === value ? 'active' : ''}`}
                    onClick={() => {
                      const newSettings = saveAppSettings({ chat: { ...appSettings.chat, fontSize: value as 'small' | 'medium' | 'large' } });
                      setAppSettings(newSettings);
                      addNotification('success', '设置已更改', `字体大小已设为${label}`);
                    }}
                  >
                    <Type size={size} />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        );
       
      case 'account':
      	return (
      		<div className="settings-tab-content">
		        <h3>帐号设置</h3>
		        <p className="settings-tab-desc">管理您的账号安全和隐私设置</p>
		  		
		  		<div className="settings-section">
		          <h4>账号</h4>
		          <div className="settings-menu-list">
		            <button className="settings-menu-item settings-menu-item-logout" onClick={async () => {
		              const confirmed = await showConfirm({
		                title: '退出登录',
		                message: '确定要退出登录吗？',
		                type: 'warning'
		              });
		              if (confirmed) {
		                onLogout();
		              }
		            }}>
		              <LogOut size={20} />
		              <div className="settings-menu-item-content">
		                <span className="settings-menu-item-title">退出登录</span>
		                <span className="settings-menu-item-desc">退出当前账号</span>
		              </div>
		              <ChevronRight size={18} />
		            </button>
		          </div>
		        </div>
		        
		        <div className="settings-danger-zone">
		          <h4>危险操作</h4>
		          <button className="settings-btn-danger-full" onClick={() => setShowDeleteModal(true)}>
		            <AlertTriangle size={18} />
		            删除账号
		          </button>
		          <p className="danger-hint">删除账号后，所有数据将被永久清除，无法恢复</p>
		        </div>
		     </div>
      	)

      case 'security':
        return (
          <div className="settings-tab-content">
            <h3>隐私与安全</h3>
            <p className="settings-tab-desc">管理您的账号安全和隐私设置</p>

            <div className="settings-section">
              <h4>账号安全</h4>
              <div className="settings-menu-list">
                <button className="settings-menu-item" onClick={() => setShowPasswordModal(true)}>
                  <Key size={20} />
                  <div className="settings-menu-item-content">
                    <span className="settings-menu-item-title">修改密码</span>
                    <span className="settings-menu-item-desc">更新您的账号密码</span>
                  </div>
                  <ChevronRight size={18} />
                </button>
                <button className="settings-menu-item" onClick={handleTwoFactorSetup}>
                  <ShieldCheck size={20} />
                  <div className="settings-menu-item-content">
                    <span className="settings-menu-item-title">两步验证</span>
                    <span className="settings-menu-item-desc">{appSettings.privacy.twoFactorEnabled ? '已开启' : '未开启'}</span>
                  </div>
                  <ChevronRight size={18} />
                </button>
                <button className="settings-menu-item" onClick={handleExportData}>
                  <Download size={20} />
                  <div className="settings-menu-item-content">
                    <span className="settings-menu-item-title">导出数据</span>
                    <span className="settings-menu-item-desc">导出您的聊天记录和数据</span>
                  </div>
                  <ChevronRight size={18} />
                </button>
              </div>
            </div>

            <div className="settings-section">
              <h4>存储</h4>
              <div className="settings-menu-list">
                <button className="settings-menu-item" onClick={handleClearCache}>
                  <Trash2 size={20} />
                  <div className="settings-menu-item-content">
                    <span className="settings-menu-item-title">清除缓存</span>
                    <span className="settings-menu-item-desc">清除本地缓存，保留聊天记录</span>
                  </div>
                  <ChevronRight size={18} />
                </button>
              </div>
            </div>
            
            <div className="settings-section">
              <h4>隐私</h4>
              <div className="settings-toggle-list">
                <div className="settings-toggle-item">
                  <div className="settings-toggle-content">
                    <span className="settings-toggle-title">不允许对方删除消息</span>
                    <span className="settings-toggle-desc">开启之后其他人不能删除我的消息</span>
                  </div>
                  <label className="settings-switch">
                    <input
                      type="checkbox"
                      checked={!!notifications.cannotDelete}
                      onChange={(e) => handleNotificationChange('cannotDelete', e.target?.checked ? 1 : 0)}
                    />
                    <span className="settings-slider"></span>
                  </label>
                </div>
              </div>
            </div>
          </div>
        );

      case 'notifications':
        return (
          <div className="settings-tab-content">
            <h3>通知</h3>
            <p className="settings-tab-desc">管理消息通知和提醒方式</p>

            <div className="settings-section">
              <div className="settings-toggle-list">
                {[
                  { key: 'messageSound', title: '消息提示音', desc: '收到新消息时播放提示音' },
                  { key: 'groupMention', title: '群聊@提及', desc: '有人在群聊中@您时发送通知' },
                  { key: 'onlineNotify', title: '上线通知', desc: '好友上线时发送通知' },
                  { key: 'offlineNotify', title: '离线通知', desc: '好友离线时发送通知' }
                ].map(({ key, title, desc }) => (
                  <div key={key} className="settings-toggle-item">
                    <div className="settings-toggle-content">
                      <span className="settings-toggle-title">{title}</span>
                      <span className="settings-toggle-desc">{desc}</span>
                    </div>
                    <label className="settings-switch">
                      <input
                        type="checkbox"
                        checked={!!notifications[key as keyof NotificationSettings]}
                        onChange={(e) => handleNotificationChange(key as keyof NotificationSettings, e.target?.checked ? 1 : 0)}
                      />
                      <span className="settings-slider"></span>
                    </label>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );

      case 'about':
        return (
          <div className="settings-tab-content">
            <h3>关于</h3>
            <p className="settings-tab-desc">了解更多关于应用的信息</p>

            <div className="settings-about">
              <div className="settings-about-logo">
                <div className="logo-icon">{siteConfig?.logo ? <img src={siteConfig.logo} alt="logo" /> : '💬'}</div>
                <h4>{siteConfig?.title || 'Flue Chat'}</h4>
                <p className="version">版本 {siteConfig?.version || '1.0.0'}</p>
                {siteConfig?.description && <p className="about-description">{siteConfig.description}</p>}
              </div>

              <div className="settings-about-info">
                {[
                  { label: '开发者', value: `${siteConfig?.title || 'Flue Chat'} Team` },
                  { label: '技术支持', value: 'React, Cloudflare Workers, Pages, D1, R2' },
                  { label: '构建时间', value: String(new Date().getFullYear()) }
                ].map(({ label, value }) => (
                  <div key={label} className="about-item">
                    <span className="about-label">{label}</span>
                    <span className="about-value">{value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="settings-panel-new">
      <div className="settings-sidebar">
        <div className="settings-sidebar-header">
          <h2>设置</h2>
        </div>
        <nav className="settings-nav">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              className={`settings-nav-item ${activeTab === tab.key ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              <tab.icon size={20} />
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>
        <div className="settings-sidebar-footer">
          <div className="settings-user-card">
            <div className="settings-user-avatar">
              {currentUser?.avatar ? (
                <img src={getAvatarUrl(currentUser.avatar)} alt="" />
              ) : (
                <span>{currentUser?.name?.charAt(0) || 'U'}</span>
              )}
            </div>
            <div className="settings-user-info">
              <span className="settings-user-name">{currentUser?.name}</span>
              <span className="settings-user-status">在线</span>
            </div>
          </div>
        </div>
      </div>
      <div className="settings-main">
        {renderTabContent()}
      </div>

      {/* 修改密码弹窗 */}
      {showPasswordModal && (
        <div className="settings-modal-overlay" onClick={() => setShowPasswordModal(false)}>
          <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
            <h3><Lock size={20} /> 修改密码</h3>
            <div className="settings-modal-content">
              <div className="settings-form-group">
                <label>当前密码</label>
                <div className="settings-password-input">
                  <input
                    type={showCurrentPassword ? 'text' : 'password'}
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="请输入当前密码"
                  />
                  <button className="password-toggle" onClick={() => setShowCurrentPassword(!showCurrentPassword)}>
                    {showCurrentPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>
              <div className="settings-form-group">
                <label>新密码</label>
                <div className="settings-password-input">
                  <input
                    type={showNewPassword ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="请输入新密码（至少6位）"
                  />
                  <button className="password-toggle" onClick={() => setShowNewPassword(!showNewPassword)}>
                    {showNewPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>
              <div className="settings-form-group">
                <label>确认新密码</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="请再次输入新密码"
                />
              </div>
            </div>
            <div className="settings-modal-actions">
              <button className="settings-btn-secondary" onClick={() => setShowPasswordModal(false)}>
                取消
              </button>
              <button className="settings-btn-primary" onClick={handleChangePassword} disabled={passwordChanging}>
                {passwordChanging ? '修改中...' : '确认修改'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除账号弹窗 */}
      {showDeleteModal && (
        <div className="settings-modal-overlay" onClick={() => setShowDeleteModal(false)}>
          <div className="settings-modal settings-modal-danger" onClick={(e) => e.stopPropagation()}>
            <h3><AlertTriangle size={20} /> 删除账号</h3>
            <div className="settings-modal-content">
              <div className="delete-warning">
                <p>警告：此操作不可逆！</p>
                <ul>
                  <li>您的所有聊天记录将被永久删除</li>
                  <li>您的所有群组将被永久删除</li>
                  <li>您的所有文件将被永久删除</li>
                  <li>您的账号将被永久删除</li>
                </ul>
              </div>
              <div className="settings-form-group">
                <label>输入 <strong>DELETE</strong> 确认删除</label>
                <input
                  type="text"
                  value={deleteConfirmText}
                  onChange={(e) => setDeleteConfirmText(e.target.value)}
                  placeholder="请输入 DELETE"
                />
              </div>
              <div className="settings-form-group">
                <label>输入当前密码确认操作</label>
                <input
                  type="password"
                  value={deletePassword}
                  onChange={(e) => setDeletePassword(e.target.value)}
                  placeholder="请输入当前密码"
                />
              </div>
            </div>
            <div className="settings-modal-actions">
              <button className="settings-btn-secondary" onClick={() => setShowDeleteModal(false)}>
                取消
              </button>
              <button className="settings-btn-danger-full" onClick={handleDeleteAccount} disabled={deleting || deleteConfirmText !== 'DELETE'}>
                {deleting ? '删除中...' : '确认删除账号'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 两步验证弹窗 */}
      <TwoFactorModal
        isOpen={showTwoFactorModal}
        onClose={handleCloseTwoFactorModal}
        step={twoFactorStep}
        isEnabled={appSettings.privacy.twoFactorEnabled}
        onEnable={handleTwoFactorEnable}
        onDisable={handleTwoFactorDisable}
        isLoading={verifying2FA}
        onSetStep={setTwoFactorStep}
        secret={twoFactorSecret}
        currentCode={currentCode}
        onGenerateSecret={handleGenerateSecret}
        onGetCurrentCode={handleGetCurrentCode}
      />
    </div>
  );
};

export default SettingsPanel;
