/* 
 * 聊天应用主组件 - App.tsx
 * 
 * 功能说明：
 * 1. 用户登录/登出
 * 2. 会话列表管理（用户列表）
 * 3. 消息收发
 * 4. WebSocket实时通信
 * 5. 群组管理
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ChatWindow } from './components/ChatWindow';
import { UserList } from './components/UserList';
import { MessageInput } from './components/MessageInput';
import AIAssistant from './components/AIAssistant';
import { subscribeToToast, removeToastById, toast } from './utils/toast';
import { DrivePanel } from './components/DrivePanel';
import StatsPanel from './components/StatsPanel';
import { SharedViewPage } from './components/SharedViewPage';
import SettingsPanel from './components/SettingsPanel';
import { User, Message } from './types';
import { truncateText, generateId, getErrorMessage, isNetworkError, isTimeoutError } from './utils/helpers';
import { useLocalStorage } from './hooks';
import { Login } from './components/Login';
import { BackgroundAnimation } from './components/BackgroundAnimation';
import { ProgressFloat } from './components/ProgressFloat';
import { ToastContainer } from './components/ToastContainer';
import { subscribeGlobalUploads, getGlobalUploads, clearGlobalUploads, updateGlobalUploadStatus, addGlobalUpload, updateGlobalUpload, removeGlobalUpload } from './utils/globalUploads';
import { ConfirmDialog, subscribeConfirmDialog, resolveConfirm } from './components/ConfirmDialog';
import { KeyModal } from './components/KeyModal';
import { InputDialog, subscribeInputDialog, resolveInput } from './components/InputDialog';
import { AdminLogin } from './components/admin/AdminLogin';
import { AdminPanel } from './components/admin/AdminPanel';
import HeaderMenu from './components/HeaderMenu';
import NotificationPanel from './components/NotificationPanel';
import { MessageCircle, HardDrive, Settings, LogOut, BarChart3, Shield, KeyRound, Bell } from 'lucide-react';
import { CONFIG, API_BASE_URL, API, initSiteConfig, loadSiteConfig, SiteConfig } from './config/api';
import { getAvatarUrl } from './utils/tools';
import { 
  parseKeysFromUrl, 
  saveKeysToStorage, 
  loadKeysFromStorage, 
  encrypt, 
  tryDecrypt,
  encryptFileChunkedWithYield,
  decryptFileChunkedWithKeysYield,
  EncryptionKeys,
  generateEncryptionKey
} from './utils/crypto';
import { getTimestamp, setTimezoneOffset, convertServerTime, getServerTimestamp } from './utils/time';
import { initAppSettings, loadAppSettingsFromDb, applyAppSettings } from './utils/settings';
import cfSocket from './utils/cfSocket';
import { TaskService } from './utils/TaskService';
import { startCsrfRefresh, stopCsrfRefresh, apiFetch, refreshCsrfToken } from './utils/csrf';
import { playNotificationSound, playMentionSound, checkMentioned } from './utils/notificationSound';

// ==================== 类型定义 ====================
// 会话类型（好友聊天或群聊）
interface Conversation {
  id: string;           // 会话ID
  type: 'friend' | 'group';  // 会话类型：friend=私聊，group=群聊
  name: string;         // 会话名称（群名为群名称，私聊为对方名字）
  avatar?: string;      // 头像
  status?: string;      // 在线状态（online/offline）
  otherUserId?: string; // 私聊时对方的用户ID
  lastMessage?: string; // 最后一条消息内容
  lastMessageIsEncrypted?: boolean; // 最后一条消息是否加密
  lastMessageDecryptFailed?: boolean; // 最后一条消息是否解密失败
  lastTime?: number;    // 最后消息时间戳
  unread?: number;      // 未读消息数量
  isPinned?: boolean;  // 是否置顶
  role?: string;       // 用户角色（admin/vip/user）
  signature?: string;   // 个性签名
  username?: string;    // 用户名
}

const MAX_FILE_SIZE = CONFIG.MAX_UPLOAD_SIZE;
setTimezoneOffset(8);

// 在组件渲染之前就读取密钥，如果没有则生成随机密钥
const INITIAL_ENCRYPTION_KEY = (() => {
  try {
    const keys = loadKeysFromStorage();
    if (keys?.currentKey) {
      localStorage.setItem('encryptionKey', keys.currentKey);
      return keys.currentKey;
    }
  } catch (e) {}
  const storedKey = localStorage.getItem('encryptionKey');
  if (storedKey) return storedKey;
  // 没有密钥则生成随机密钥
  const newKey = generateEncryptionKey();
  localStorage.setItem('encryptionKey', newKey);
  return newKey;
})();

const App: React.FC = () => {
  // ==================== 状态管理 ====================
  const savedPanel = typeof window !== 'undefined' ? (localStorage.getItem('activePanel') as 'chat' | 'drive' | 'settings' | 'shared' | 'stats' | 'admin' | 'login' | null) : null;
  
  const [currentUser, setCurrentUser] = useState<User | null>(null);       // 当前登录用户
  const [activeChat, setActiveChat] = useState<Conversation | null>(null); // 当前选中的会话
  const [activePanel, setActivePanel] = useState<'chat' | 'drive' | 'settings' | 'shared' | 'stats' | 'admin' | 'login'>(savedPanel === 'login' ? 'login' : 'chat');  // 当前面板
  const [isSharedView, setIsSharedView] = useState(false);  // 是否是分享链接访问
  const [conversations, setConversations] = useState<Conversation[]>([]); // 会话列表（左侧用户列表）
  const [messages, setMessages] = useState<Message[]>([]);                // 当前会话的消息列表
  const [messagePage, setMessagePage] = useState(1);  // 当前消息页码
  const [hasMoreMessages, setHasMoreMessages] = useState(true);  // 是否还有更多消息
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);  // 是否正在加载消息
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);  // 当前正在加载的会话ID
  const [isLoadingConversations, setIsLoadingConversations] = useState(false);  // 是否正在加载会话列表
  const [groupInfo, setGroupInfo] = useState<any>(null);                // 群组信息
  const [replyTo, setReplyTo] = useState<{ id: string; name: string; content: string } | null>(null);  // 回复的消息
  const [encryptionKey, setEncryptionKey] = useState(INITIAL_ENCRYPTION_KEY);  // 加密密钥
  const [showEncryptionKey, setShowEncryptionKey] = useState(false);  // 显示/隐藏加密密钥
  const [legacyKeys, setLegacyKeys] = useState<string[]>([]);  // 历史密钥列表
  const [globalMuted, setGlobalMuted] = useState(false);  // 全局禁言状态
  const [pendingEncryptionKey, setPendingEncryptionKey] = useState('');  // 待应用的加密密钥
  const [showLegacyKeys, setShowLegacyKeys] = useState<boolean[]>([]);  // 显示历史密钥列表
  const [showKeyModal, setShowKeyModal] = useState(false);  // 显示密钥弹窗
  const [uploads, setUploads] = useState<any[]>([]);  // 上传文件列表
  const [showProgressFloat, setShowProgressFloat] = useState(false);  // 显示上传进度窗口
  const [taskService, setTaskService] = useState<TaskService | null>(null);  // 文件服务
  const [activeChatId, setActiveChatId] = useState<string | null>(null);  // 当前聊天ID（保存以在回调中使用）
  const [notifications, setNotifications] = useState<{id: string; type: 'success' | 'error' | 'warning' | 'info'; title: string; message: string}[]>([]);  // 通知列表
  const [searchKeyword, setSearchKeyword] = useState('');  // 搜索关键词
  const [showAdmin, setShowAdmin] = useState(false);  // 是否显示管理界面
  const [adminToken, setAdminToken] = useLocalStorage<string | null>('adminToken', null);  // 管理员令牌
  const [isInitializing, setIsInitializing] = useState(true);  // 初始加载状态
  const [showAIAssistant, setShowAIAssistant] = useState(false);  // 是否显示 AI 助手面板
  const [isMuted, setIsMuted] = useState(false);  // 当前用户是否被禁言
  const [muteReason, setMuteReason] = useState('');  // 禁言原因
  const [showProfilePopup, setShowProfilePopup] = useState(false);  // 是否显示个人资料悬浮窗
  const [showNewChat, setShowNewChat] = useState(false);  // 是否显示新建会话弹窗
  const [allUsers, setAllUsers] = useState<any[]>([]);  // 所有用户列表（用于新建会话）
  const [typingUsers, setTypingUsers] = useState<{ userId: string; userName: string; timeout: NodeJS.Timeout }[]>([]);  // 正在输入的用户
  const [showNotificationPanel, setShowNotificationPanel] = useState(false);  // 是否显示通知面板
  const [notificationUnreadCount, setNotificationUnreadCount] = useState(0);  // 未读通知数量
  const [confirmState, setConfirmState] = useState<{ open: boolean; title: string; message: string; type?: 'danger' | 'warning' | 'info' }>({ open: false, title: '', message: '' });
  const [inputState, setInputState] = useState<{ open: boolean; title: string; message?: string; placeholder?: string; defaultValue?: string; confirmText?: string; cancelText?: string }>({ open: false, title: '', message: '', placeholder: '' });
  const [isLoggingOut, setIsLoggingOut] = useState(false);  // 登出状态
  
  // 页面数据缓存（避免重复请求）
  const [panelCache, setPanelCache] = useState<{
    stats?: { loginStats: any[]; chatStats: any[]; loginSummary: any };
    drive?: { files: any[]; folders: any[] };
  }>({});

  // 全局确认对话框
  useEffect(() => {
    return subscribeConfirmDialog((state) => {
      setConfirmState(state);
    });
  }, []);

  // 全局输入对话框
  useEffect(() => {
    return subscribeInputDialog((state) => {
      setInputState(state);
    });
  }, []);

  // 初始化应用设置
  useEffect(() => {
    loadAppSettingsFromDb().then(settings => {
      applyAppSettings(settings);
    }).catch(() => {
      initAppSettings();
    });
  }, []);

  // 定时检查未读通知数量
  useEffect(() => {
    if (!currentUser?.id) return;
    const fetchUnreadCount = async () => {
      try {
        const res = await apiFetch(`${API.notifications.notifications}?page=1&limit=1`);
        const data = await res.json();
        if (data.success) {
          setNotificationUnreadCount(data.unreadCount || 0);
        }
      } catch (e) {}
    };
    fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, 30000);
    return () => clearInterval(interval);
  }, [currentUser?.id]);

  const handleConfirm = () => {
    resolveConfirm(true);
    setConfirmState({ open: false, title: '', message: '' });
  };

  const handleCancel = () => {
    resolveConfirm(false);
    setConfirmState({ open: false, title: '', message: '' });
  };

  const handleInputConfirm = (value: string) => {
    resolveInput(value);
    setInputState({ open: false, title: '', message: '', placeholder: '' });
  };

  const handleInputCancel = () => {
    resolveInput(null);
    setInputState({ open: false, title: '', message: '', placeholder: '' });
  };

  const GlobalConfirmDialog = () => (
    <ConfirmDialog
      open={confirmState.open}
      title={confirmState.title}
      message={confirmState.message}
      type={confirmState.type}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    />
  );

  const GlobalInputDialog = () => (
    <InputDialog
      open={inputState.open}
      title={inputState.title}
      message={inputState.message}
      placeholder={inputState.placeholder}
      defaultValue={inputState.defaultValue}
      confirmText={inputState.confirmText}
      cancelText={inputState.cancelText}
      onConfirm={handleInputConfirm}
      onCancel={handleInputCancel}
    />
  );

  // 复制密钥
  const handleCopyKey = () => {
    navigator.clipboard.writeText(encryptionKey).then(() => {
      addNotification('info', '已复制', '加密密钥已复制到剪贴板');
    });
  };

  // 修改密钥（来自 KeyModal）
  const handleKeyChange = (newKey: string) => {
    const oldKey = localStorage.getItem('encryptionKey') || '';
    setEncryptionKey(newKey);
    localStorage.setItem('encryptionKey', newKey);
    encryptionKeyRef.current = newKey;

    if (oldKey !== newKey && oldKey) {
      const existingKeys = loadKeysFromStorage();
      if (existingKeys) {
        const newLegacy = [oldKey, ...existingKeys.legacyKeys.filter(k => k !== oldKey && k !== newKey)];
        const keys: EncryptionKeys = { currentKey: newKey, legacyKeys: newLegacy.slice(0, 10) };
        saveKeysToStorage(keys);
        setLegacyKeys(keys.legacyKeys);
      } else {
        saveKeysToStorage({ currentKey: newKey, legacyKeys: [] });
      }
    } else {
      saveKeysToStorage({ currentKey: newKey, legacyKeys: legacyKeys });
    }

    window.dispatchEvent(new CustomEvent('encryptionKeyUpdated', { detail: { key: newKey } }));
    fetchConversations();
    addNotification('success', '修改成功', '密钥已更新');
  };

  // 使用历史密钥
  const handleUseLegacyKey = (key: string) => {
    handleKeyChange(key);
  };

  // 删除历史密钥
  const handleDeleteLegacyKey = (index: number) => {
    const newLegacy = [...legacyKeys];
    newLegacy.splice(index, 1);
    const keys: EncryptionKeys = { currentKey: encryptionKey, legacyKeys: newLegacy };
    saveKeysToStorage(keys);
    setLegacyKeys(newLegacy);
    setShowLegacyKeys(new Array(newLegacy.length).fill(false));
    window.dispatchEvent(new CustomEvent('encryptionKeyUpdated', { detail: { key: encryptionKey } }));
    fetchConversations();
  };
  
  // ==================== Ref引用 ====================
  // 使用ref可以在回调中访问最新的状态值
  const socketRef = useRef<any>(null);           // WebSocket连接
  const encryptionKeyRef = useRef(encryptionKey);          // 加密密钥引用
  const currentUserRef = useRef<User | null>(null);        // 当前用户引用
  const activeChatRef = useRef<Conversation | null>(null); // 当前选中会话引用
  const conversationsRef = useRef<Conversation[]>([]);     // 会话列表引用
  const messagesRef = useRef<Message[]>([]);               // 消息池（存储所有消息，包括系统消息）
  const sentMessageIdsRef = useRef<Set<string>>(new Set()); // 自己发送的消息ID集合，用于已读回执更新
  const sentMsgNotifications = useRef<Set<string>>(new Set());  // 消息通知去重
  const sentStatusNotifications = useRef<Map<string, number>>(new Map());  // 状态通知去重，记录时间
  const lastMsgNotificationTime = useRef<number>(0);  // 上次消息通知时间
  const lastStatusRef = useRef<Map<string, string>>(new Map());  // 上次状态记录
  const lastMessageTimeRef = useRef<Map<string, number>>(new Map());  // 每个会话的最后消息时间，用于增量加载
  const shownNotificationsRef = useRef<Set<string>>(new Set());  // 已显示的通知去重（用于系统消息等）

  // 同步activeChat和currentUser到ref
  useEffect(() => {
    activeChatRef.current = activeChat;
  }, [activeChat]);

  // 加载历史密钥
  useEffect(() => {
    const keys = loadKeysFromStorage();
    if (keys && keys.legacyKeys) {
      setLegacyKeys(keys.legacyKeys);
      setShowLegacyKeys(new Array(keys.legacyKeys.length).fill(false));
    }
  }, []);

  // 检查是否是分享链接访问
  useEffect(() => {
    const path = window.location.pathname;
    if (path.startsWith('/drive/shared/')) {
      setIsSharedView(true);
      setActivePanel('shared');
    }
    setIsInitializing(false);
  }, []);

  // 同步 encryptionKey 到 ref
  useEffect(() => {
    encryptionKeyRef.current = encryptionKey;
  }, [encryptionKey]);

  useEffect(() => {
    currentUserRef.current = currentUser;
  }, [currentUser]);

  // 同步conversations到ref
  useEffect(() => {
    conversationsRef.current = conversations;
    currentUserRef.current = currentUser;
  }, [conversations]);

  // 保存当前面板到localStorage
  useEffect(() => {
    if (activePanel) {
      localStorage.setItem('activePanel', activePanel);
    }
  }, [activePanel]);

  // 检查并发送消息（当所有任务处理完成时调用）
  const checkAndSendMessage = (tempMessageId: string) => {
    const chatId = activeChatRef.current?.id;
    if (!chatId) {
      return;
    }
    
    const key = `sent_${tempMessageId}`;
    if ((window as any)[key]) {
      return;
    }
    
    const msg = messagesRef.current.find(m => m.id === tempMessageId);
    if (!msg || !socketRef.current) {
      return;
    }
    
    const allAttachments = (msg as any).attachments || [];
    // 通过 uploads 数组判断：没有 pending 或 uploading 的任务就可以发送
    const hasActiveUploads = uploads.some(u => u.tempMessageId === tempMessageId && (u.status === 'pending' || u.status === 'uploading'));
    const allProcessed = !hasActiveUploads;
    
if (allProcessed) {
      (window as any)[key] = true;
      
      // 只发送成功上传的附件（uploadFailed 为 false 且有 url）
      const successAttachments = allAttachments
        .filter((att: any) => !att.uploadFailed && att.url)
        .map((att: any) => ({
          type: att.type,
          name: att.name,
          size: att.size,
          url: att.url,
          encrypted: att.encrypted
        }));
       
      // 没有成功的附件也没有文本，不发送
      if (successAttachments.length === 0 && !msg.content?.trim()) {
        return;
      }
      
      const keys = loadKeysFromStorage();
      const currentKey = keys?.currentKey || encryptionKeyRef.current;
      const content = msg.content || '';
      const hasTextContent = content.trim().length > 0;
      const shouldEncrypt = hasTextContent && !!currentKey;
      const finalContent = shouldEncrypt ? encrypt(content, currentKey!) : content;
      
      const msgBurnAfterReading = (msg as any).burnAfterReading;
      const replyTo = (msg as any).replyTo;
      
      // 生成新的消息ID用于后端匹配
      const clientMessageId = `msg_${generateId()}`;
      
      socketRef.current.sendMessage(chatId, finalContent, {
        attachments: successAttachments,
        quoteId: replyTo?.id,
        isEncrypted: shouldEncrypt,
        timestamp: Date.now(),
        burnAfterReading: msgBurnAfterReading,
        clientMessageId
      });
      socketRef.current.joinSession(chatId);
      
      // 使用 setConversations 直接更新，不依赖闭包中的 conversations
      const now = Date.now();  // 临时消息使用本地时间
      const updated = conversationsRef.current.map(c => 
        c.id === chatId ? { ...c, lastMessage: msg.content || '[文件]', lastTime: now } : c
      );
      // 排序：置顶 > 未读 > 最后消息时间
      const sorted = [...updated].sort((a, b) => {
        const aPinned = a.isPinned ? 1 : 0;
        const bPinned = b.isPinned ? 1 : 0;
        if (aPinned !== bPinned) return bPinned - aPinned;
        const aUnread = a.unread || 0;
        const bUnread = b.unread || 0;
        if (aUnread !== bUnread) return bUnread - aUnread;
        return (b.lastTime || 0) - (a.lastTime || 0);
      });
      setConversations(sorted);
      
      // 从 bubble 中移除失败的附件
      setMessages(prev => prev.map(m => {
        if (m.id === tempMessageId && (m as any).attachments) {
          return { ...m, attachments: (m as any).attachments.filter((att: any) => !att.uploadFailed) };
        }
        return m;
      }));
    }
  };

  // 初始化 TaskService
  useEffect(() => {
    if (API_BASE_URL) {
      let service = TaskService.getInstanceSafe();
      if (!service) {
        service = TaskService.getInstance({
          apiBaseUrl: API_BASE_URL,
          onTaskUpdate: (task) => {
            // 检查任务是否已被取消，如果是则不更新
            const existingTask = getGlobalUploads().find(t => t.id === task.id);
            if (existingTask?.status === 'cancelled') {
              return;
            }
            
            // 有任务时显示 ProgressFloat
            setShowProgressFloat(true);
            
            // 更新全局状态
            if (existingTask) {
              updateGlobalUpload(task);
            } else {
              addGlobalUpload(task);
            }
            
            setUploads(prev => {
              const exists = prev.find(u => u.id === task.id);
              if (exists) {
                return prev.map(u => u.id === task.id ? task : u);
              }
              return [...prev, task];
            });
            
            // 更新消息气泡中的进度（上传）
            if (task.tempMessageId && task.type === 'upload') {
              if (task.status === 'completed' || task.status === 'error' || task.status === 'cancelled') {
                return;
              }
              setMessages(prev => prev.map(m => {
                if (m.id === task.tempMessageId && (m as any).attachments) {
                  const newAttachments = (m as any).attachments.map((att: any) => {
                    const match = att.id === task.attachmentId || att.uploading || att.isPending;
                    if (match) {
                      return { 
                        ...att, 
                        uploading: true, 
                        encrypting: task.progress > 0 ? false : (att.encrypting || false),
                        uploadProgress: task.progress 
                      };
                    }
                    return att;
                  });
                  return { ...m, attachments: newAttachments };
                }
                return m;
              }));
              messagesRef.current = messagesRef.current.map(m => {
                if (m.id === task.tempMessageId && (m as any).attachments) {
                  const newAttachments = (m as any).attachments.map((att: any) => {
                    if (att.id === task.attachmentId || att.uploading || att.isPending) {
                      return { 
                        ...att, 
                        uploading: true, 
                        encrypting: task.progress > 0 ? false : (att.encrypting || false),
                        uploadProgress: task.progress 
                      };
                    }
                    return att;
                  });
                  return { ...m, attachments: newAttachments };
                }
                return m;
              });
            }
            
            // 更新消息气泡中的下载进度
            if (task.tempMessageId && task.type === 'download') {
              if (task.status === 'completed' || task.status === 'error' || task.status === 'cancelled') {
                return;
              }
              const taskUrlKey = task.url.replace(/^.*\/api\/files\//, '') || task.url;
              setMessages(prev => prev.map(m => {
                if (m.id === task.tempMessageId && (m as any).attachments) {
                  const newAttachments = (m as any).attachments.map((att: any) => {
                    const attUrlKey = (att.url || '').replace(/^.*\/api\/files\//, '') || att.url;
                    if (att.id === task.attachmentId || attUrlKey === taskUrlKey || att.downloading) {
                      return { ...att, downloading: true, downloadProgress: task.progress };
                    }
                    return att;
                  });
                  return { ...m, attachments: newAttachments };
                }
                return m;
              }));
              messagesRef.current = messagesRef.current.map(m => {
                if (m.id === task.tempMessageId && (m as any).attachments) {
                  const newAttachments = (m as any).attachments.map((att: any) => {
                    const attUrlKey = (att.url || '').replace(/^.*\/api\/files\//, '') || att.url;
                    if (att.id === task.attachmentId || attUrlKey === taskUrlKey || att.downloading) {
                      return { ...att, downloading: true, downloadProgress: task.progress };
                    }
                    return att;
                  });
                  return { ...m, attachments: newAttachments };
                }
                return m;
              });
            }
          },
          onTaskComplete: (task, result) => {
            // 更新全局任务状态为完成
            updateGlobalUploadStatus(task.id, 'completed');
            
            // 处理下载任务的阅后即焚
            if (task.type === 'download' && task.isBurn && task.tempMessageId) {
              const isSelf = currentUser?.id === task.senderId;
              if (!isSelf) {
                window.dispatchEvent(new CustomEvent('burnAfterRead', {
                  detail: { messageId: task.tempMessageId, fileUrl: task.url }
                }));
              }
            }
            
            // 显示成功提示
            if (task.tempMessageId) {
              addNotification('success', task.type === 'upload' ? '上传成功' : '下载成功', task.filename);
            }
            
            // 更新消息中的附件状态
            const updateAttachmentStatus = (msgs: Message[]) => {
              return msgs.map(m => {
                if (m.id !== task.tempMessageId || !(m as any).attachments) return m;
                const newAttachments = (m as any).attachments.map((att: any) => {
                  // 上传：用 attachmentId 精确匹配
                  const isUploadMatch = task.type === 'upload' && att.id === task.attachmentId;
                  // 下载：用 url 匹配，或者正在下载中
                  const isDownloadMatch = task.type === 'download' && (att.downloading || att.url === task.url);
                  if (!isUploadMatch && !isDownloadMatch) return att;
                  
                  if (task.type === 'upload') {
                    // 上传：用 result 更新
                    return { 
                      ...att,
                      ...result,
                      uploading: false, 
                      encrypting: false,
                      uploadProgress: undefined, 
                      uploadFailed: false,
                      isPending: false 
                    };
                  } else {
                    // 下载：清理下载状态
                    return {
                      ...att,
                      downloading: false,
                      downloadProgress: undefined
                    };
                  }
                });
                return { ...m, attachments: newAttachments };
              });
            };
            
            if (task.tempMessageId) {
              const msgs = messagesRef.current;
              const updated = updateAttachmentStatus(msgs);
              
              if (task.type === 'upload') {
                setMessages(prev => updateAttachmentStatus(prev));
                messagesRef.current = updated;
                checkAndSendMessage(task.tempMessageId);
              } else {
                setMessages(prev => updateAttachmentStatus(prev));
              }
              
              // 下载完成时清理进度
              if (task.tempMessageId && task.type === 'download') {
                const taskUrlKey = task.url.replace(/^.*\/api\/files\//, '') || task.url;
                setMessages(prev => prev.map(m => {
                  if (m.id === task.tempMessageId && (m as any).attachments) {
                    const newAttachments = (m as any).attachments.map((att: any) => {
                      const attUrlKey = (att.url || '').replace(/^.*\/api\/files\//, '') || att.url;
                      if (att.id === task.attachmentId || attUrlKey === taskUrlKey || att.downloading) {
                        // console.log('[DEBUG] 下载完成清理状态:', { attUrlKey, taskUrlKey, attId: att.id, taskAttId: task.attachmentId });
                        return { ...att, downloadProgress: undefined, downloading: false };
                      }
                      return att;
                    });
                    return { ...m, attachments: newAttachments };
                  }
                  return m;
                }));
              }
            }

            // 网盘上传完成，刷新网盘文件列表
            if (task.type === 'upload' && task.customEndpoint?.includes('/api/drive/')) {
              window.dispatchEvent(new CustomEvent('refreshDriveFiles'));
            }
            
            // 群附件上传完成，刷新群附件列表
            const uploadUrl = result?.url || result?.data?.url;
            if (task.type === 'upload' && task.customEndpoint?.includes('/api/group-attachments/')) {
              window.dispatchEvent(new CustomEvent('refreshGroupAttachments'));
            }
            
            // 从 uploads 数组中移除已完成或已取消的任务
            setUploads(prev => prev.filter(u => u.id !== task.id && u.status !== 'cancelled'));
          },
          onTaskError: (task, error) => {
            if (error.message?.includes('已取消')) {
              // 取消时标记附件为失败
              if (task.tempMessageId && task.type === 'upload') {
                setMessages(prev => prev.map(m => {
                  if (m.id === task.tempMessageId && (m as any).attachments) {
                    return { 
                      ...m, 
                      attachments: ((m as any).attachments || []).map((a: any) => 
                        a.id === task.attachmentId 
                          ? { ...a, uploading: false, uploadFailed: true }
                          : a
                      )
                    };
                  }
                  return m;
                }));
                checkAndSendMessage(task.tempMessageId);
              }
              return;
            }
            
            // 阅后即焚文件被删除时，更新消息气泡
            if (task.isBurn && task.type === 'download' && error.message?.includes('已被删除')) {
              if (task.tempMessageId) {
                setMessages(prev => prev.map(m => {
                  if (m.id === task.tempMessageId) {
                    return { 
                      ...m, 
                      isSystem: true,
                      content: '阅后即焚文件已被删除',
                      attachments: []
                    } as any;
                  }
                  return m;
                }));
              }
              return;
            }
            
            addNotification('error', task.type === 'upload' ? '上传失败' : '下载失败', `${task.filename}: ${error.message}`);
            
            if (task.tempMessageId && task.type === 'upload') {
              setMessages(prev => prev.map(m => {
                if (m.id === task.tempMessageId && (m as any).attachments) {
                  const newAttachments = (m as any).attachments.map((att: any) => {
                    if (att.uploading) {
                      return { ...att, uploading: false, uploadFailed: true };
                    }
                    return att;
                  });
                  return { ...m, attachments: newAttachments };
                }
                return m;
              }));
              messagesRef.current = messagesRef.current.map(m => {
                if (m.id === task.tempMessageId && (m as any).attachments) {
                  const newAttachments = (m as any).attachments.map((att: any) => {
                    if (att.uploading) {
                      return { ...att, uploading: false, uploadFailed: true };
                    }
                    return att;
                  });
                  return { ...m, attachments: newAttachments };
                }
                return m;
              });
              checkAndSendMessage(task.tempMessageId);
            }
            
            // 下载失败时清理进度
            if (task.tempMessageId && task.type === 'download') {
              const taskUrlKey = task.url.replace(/^.*\/api\/files\//, '');
              setMessages(prev => prev.map(m => {
                if (m.id === task.tempMessageId && (m as any).attachments) {
                  const newAttachments = (m as any).attachments.map((att: any) => {
                    const attUrlKey = att.url.replace(/^.*\/api\/files\//, '');
                    if (att.id === task.attachmentId || attUrlKey === taskUrlKey || att.downloading) {
                      return { ...att, downloading: false };
                    }
                    return att;
                  });
                  return { ...m, attachments: newAttachments };
                }
                return m;
              }));
              messagesRef.current = messagesRef.current.map(m => {
                if (m.id === task.tempMessageId && (m as any).attachments) {
                  const newAttachments = (m as any).attachments.map((att: any) => {
                    const attUrlKey = att.url.replace(/^.*\/api\/files\//, '');
                    if (att.id === task.attachmentId || attUrlKey === taskUrlKey || att.downloading) {
                      return { ...att, downloading: false };
                    }
                    return att;
                  });
                  return { ...m, attachments: newAttachments };
                }
                return m;
              });
            }
            
            // 从 uploads 数组中移除失败的任务
            setUploads(prev => prev.filter(u => u.id !== task.id));
          }
        });
        setTaskService(service);
      }
    }
  }, []);

  // ==================== WebSocket连接 ====================
  // 当会话列表加载完成后，自动加入所有会话的WebSocket房间
  useEffect(() => {
    if (socketRef.current && conversations.length > 0) {
      conversations.forEach((conv: Conversation) => {
        socketRef.current?.joinSession(conv.id);
      });
    }
  }, [conversations]);

  // ==================== 通知系统 ====================

  // ==================== 通知系统 ====================
  // 添加通知（显示Toast提示）
  const addNotification = (type: 'success' | 'error' | 'warning' | 'info', title: string, message: string) => {
    // 同时调用全局 toast
    if (type === 'success') toast.success(title, message);
    else if (type === 'error') toast.error(title, message);
    else if (type === 'warning') toast.warning(title, message);
    else toast.info(title, message);
  };

  // 移除通知
  const removeNotification = (id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  };

  // ==================== 初始化 ====================
  // 页面加载时检查是否已登录
  useEffect(() => {
    // 初始化网站配置
    initSiteConfig();
    
    // 初始化主题
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    
    // 解析URL中的密钥（优先），然后清除URL中的hash
    const urlKeys = parseKeysFromUrl();
    if (urlKeys) {
      saveKeysToStorage(urlKeys);
      setEncryptionKey(urlKeys.currentKey);
      localStorage.setItem('encryptionKey', urlKeys.currentKey);
      // 清除URL中的hash
      window.history.replaceState(null, '', window.location.pathname);
    } else {
      // 从存储加载密钥
      const storedKeys = loadKeysFromStorage();
      if (storedKeys) {
        setEncryptionKey(storedKeys.currentKey);
        localStorage.setItem('encryptionKey', storedKeys.currentKey);
      } else {
        // 尝试直接从 encryptionKey 读取
        const ek = localStorage.getItem('encryptionKey');
        if (ek) {
          setEncryptionKey(ek);
        }
      }
    }
    
    // 清空所有状态，确保干净的开始
    setConversations([]);
    setMessages([]);
    messagesRef.current = [];
    setActiveChat(null);
    setGroupInfo(null);
    
    const userStr = localStorage.getItem('user');
    if (userStr) {
      const user = JSON.parse(userStr);
      
      // 先尝试从 currentUser 获取 accountStatus
      const savedUserStr = localStorage.getItem('currentUser');
      const savedUser = savedUserStr ? JSON.parse(savedUserStr) : null;
      let accountStatus = savedUser?.accountStatus || user.accountStatus;
      
      setCurrentUser({ 
        id: user.id, 
        name: user.name, 
        username: user.username || '', 
        avatar: user.avatar || '', 
        signature: user.signature || '',
        status: 'online',
        role: user.role || 'user',
        accountStatus: accountStatus
      });
      setGlobalMuted(accountStatus === 'muted');
      fetchConversations();  // 获取会话列表
      connectSocket(user.id); // 连接WebSocket
    }
  }, []);

  // ==================== WebSocket连接函数 ====================
  // 连接WebSocket服务器并设置事件监听
  const connectSocket = (userId: string) => {
    const token = localStorage.getItem('token');
    if (!token) return;

    // 使用 Cloudflare WebSocket
    const socket = cfSocket;
    socket.connect(token).catch(console.error);

    // 连接成功时
    socket.on('connect', () => {
      // WebSocket 连接成功后，加入所有会话
      if (conversationsRef.current.length > 0) {
        conversationsRef.current.forEach((conv: Conversation) => {
          socket.joinSession(conv.id);
        });
      }
    });

    socket.on('disconnect', (data: any) => {
    });

    // ==================== 真正离线处理（超过重连次数） ====================
    socket.on('trulyOffline', () => {
      // 遍历所有好友会话，标记为离线
      setConversations(prevConvs => 
        prevConvs.map(c => 
          c.type === 'friend' ? { ...c, status: 'offline' } : c
        )
      );
    });

    // ==================== 禁言/解除禁言通知处理 ====================
    socket.on('muted', (data: { groupId: string; groupName: string; reason: string }) => {
      // 去重：同一个群在短时间内只显示一次
      const notifyKey = `muted_${data.groupId}`;
      if (shownNotificationsRef.current.has(notifyKey)) {
        return;
      }
      shownNotificationsRef.current.add(notifyKey);
      
      addNotification('warning', '你被禁言了', `你在群 "${data.groupName}" 中被禁言${data.reason ? `，原因：${data.reason}` : ''}`);
      setIsMuted(true);
      setMuteReason(data.reason || '');
      
      // 5秒后移除去重标记，允许再次显示
      setTimeout(() => {
        shownNotificationsRef.current.delete(notifyKey);
      }, 5000);
    });

    socket.on('unmuted', (data: { groupId: string; groupName: string; message: string }) => {
      // 去重：同一个群在短时间内只显示一次
      const notifyKey = `unmuted_${data.groupId}`;
      if (shownNotificationsRef.current.has(notifyKey)) {
        return;
      }
      shownNotificationsRef.current.add(notifyKey);
      
      addNotification('success', '解除禁言', `你在群 "${data.groupName}" 中已被解除禁言，可以正常发言了`);
      setIsMuted(false);
      setMuteReason('');
      
      // 5秒后移除去重标记，允许再次显示
      setTimeout(() => {
        shownNotificationsRef.current.delete(notifyKey);
      }, 5000);
    });

    // ==================== 全局禁言/封禁事件处理 ====================
    socket.on('userMuted', (data: { userId: string; reason: string }) => {
      setGlobalMuted(true);
      if (currentUser) {
        setCurrentUser({ ...currentUser, accountStatus: 'muted' });
        localStorage.setItem('currentUser', JSON.stringify({ ...currentUser, accountStatus: 'muted' }));
      }
      addNotification('warning', '全局禁言', `您已被管理员全局禁言${data.reason ? `，原因：${data.reason}` : ''}`);
    });

    socket.on('userUnmuted', () => {
      setGlobalMuted(false);
      if (currentUser) {
        setCurrentUser({ ...currentUser, accountStatus: 'normal' });
        localStorage.setItem('currentUser', JSON.stringify({ ...currentUser, accountStatus: 'normal' }));
      }
      addNotification('success', '解除禁言', '您已被解除全局禁言，可以正常发言了');
    });

    socket.on('userBanned', (data: { userId: string; reason: string }) => {
      // 更新当前用户账号状态
      if (currentUser) {
        setCurrentUser({ ...currentUser, accountStatus: 'banned' });
        localStorage.setItem('currentUser', JSON.stringify({ ...currentUser, accountStatus: 'banned' }));
      }
      addNotification('error', '账号被封禁', `您的账号已被管理员封禁${data.reason ? `，原因：${data.reason}` : ''}`);
    });

    socket.on('userUnbanned', () => {
      // 更新当前用户账号状态
      if (currentUser) {
        setCurrentUser({ ...currentUser, accountStatus: 'normal' });
        localStorage.setItem('currentUser', JSON.stringify({ ...currentUser, accountStatus: 'normal' }));
      }
      addNotification('success', '解除封禁', '您的账号已被解除封禁');
    });

    // ==================== 强制登出处理 ====================
    socket.on('forceLogout', (data: { userId: string; reason: string; message: string }) => {
      // 清除登录状态
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      localStorage.removeItem('currentUser');
      
      // 显示提示
      addNotification('error', '账号被封禁', data.message || '您的账号已被封禁，请联系管理员');
      
      // 断开 WebSocket
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      
      // 跳转到登录页面
      setTimeout(() => {
        setCurrentUser(null);
        setActivePanel('login');
      }, 2000);
    });

    // ==================== 消息接收处理 ====================
    // 接收新消息事件
    socket.on('message', async (msg: any) => {
      
      
      // 确保消息有 sessionId
      if (!msg.sessionId) {
        
        return;
      }
      
      const sessionId = msg.sessionId;
      
      // 自动加入消息所属的会话房间，以便接收该会话的后续事件（如已读回执）
      if (socketRef.current) {
        socketRef.current.joinSession(sessionId);
      }
      
      // 检查消息是否属于当前会话
      const isCurrentChat = activeChatRef.current?.id === sessionId;
      
      
      // 判断消息是否是自己发的
      const isSelf = String(msg.sender?.id) === String(currentUserRef.current?.id);
      
      // 检查是否是系统消息
      const isSystemMessage = msg.isSystem || msg.is_system || msg.type === 'system';
      
      
      
      // 解密消息内容
      let displayContent = msg.content;
      const isContentLikelyEncrypted = msg.content && (msg.content.startsWith('U2FsdGVkX') || msg.content.startsWith('Salted__'));
      const isMsgEncrypted = msg.isEncrypted === true || msg.isEncrypted === 'true' || msg.encrypted === 1 || msg.encrypted === true || isContentLikelyEncrypted;
      const keys = loadKeysFromStorage();
      
      if (isMsgEncrypted && msg.content) {
        if (keys) {
          const result = tryDecrypt(msg.content);
          if (result.decrypted) {
            displayContent = result.content;
          } else {
            // 解密失败，显示提示
            displayContent = '🔒 解密失败，无法显示内容';
            msg.decryptFailed = true;
          }
        } else {
          // 没有密钥，显示提示
          displayContent = '🔒 解密失败，无法显示内容';
          msg.decryptFailed = true;
        }
      }
      
      // 更新会话列表的最后消息
      setConversations(prevConvs => {
        return prevConvs.map(c => {
          if (c.id === sessionId) {
            return { ...c, lastMessage: displayContent, lastTime: msg.timestamp };
          }
          return c;
        });
      });
      
      // 检查消息是否已存在
      const existsInRef = messagesRef.current.find(m => m.id === msg.id);
      if (existsInRef) {
        return;
      }
      
        // 如果是当前会话，添加消息到列表
      if (isCurrentChat) {
        const processedMsg = {
          ...msg,
          content: displayContent,
          burnAfterReading: msg.burnAfterReading,
          decryptFailed: msg.decryptFailed,
          timestamp: convertServerTime(msg.timestamp)
        };
        messagesRef.current = [...messagesRef.current, processedMsg];
        setMessages(prev => {
          const updated = [...prev, processedMsg];
          return updated.sort((a, b) => getTimestamp(a.timestamp) - getTimestamp(b.timestamp));
        });
        
        // 注意：已读回执由 ChatWindow 组件在消息可见时自动发送
        // 不在这里即时发送已读回执，避免消息不在可见区域时误发
        
        // 检查是否是禁言/解除禁言系统消息，更新禁言状态
        // 注意：禁言/解除禁言的提示通知只通过 WebSocket 发送，不在这里重复显示
        // 这里只更新禁言状态
        if (isSystemMessage && displayContent && isCurrentChat && displayContent.includes('你')) {
          if (displayContent.includes('被禁言')) {
            setIsMuted(true);
            setMuteReason('您已被群主禁言');
          } else if (displayContent.includes('解除禁言')) {
            setIsMuted(false);
            setMuteReason('');
          }
        }
      }
      
      // 如果不是当前会话，显示通知（每个会话最多每30秒通知一次）
      if (!isSelf && !isCurrentChat && !isSystemMessage) {
        const sessionKey = sessionId;
        const now = Date.now();
        
        // 每30秒重置一次通知记录
        if (now - lastMsgNotificationTime.current > 30000) {
          lastMsgNotificationTime.current = now;
          sentMsgNotifications.current.clear();
        }
        
        // 获取通知设置
        const notificationSettings = JSON.parse(localStorage.getItem('notificationSettings') || '{}');
        
        // 检查是否被@提及（通过会话类型判断）
        const currentUsername = currentUserRef.current?.username || '';
        const isGroupChat = msg.sessionType === 'group';
        const isMentioned = isGroupChat && checkMentioned(msg.content || '', currentUsername);
        
        // 播放提示音
        if (isMentioned) {
          playMentionSound();
        } else {
          playNotificationSound();
        }
        
        if (!sentMsgNotifications.current.has(sessionKey)) {
          sentMsgNotifications.current.add(sessionKey);
          const senderName = msg.sender?.name || '未知用户';
          
          // @提及显示特殊通知
          if (isMentioned) {
            addNotification('warning', '@提及', `${senderName} 在群聊中@了你`);
          } else {
            addNotification('info', '新消息', `${senderName}: ${truncateText(msg.content || '[图片/文件]', 20)}`);
          }
        }
      }
    });

    // ==================== 未读数更新处理 ====================
    socket.on('unreadUpdate', (data: { sessionId: string; unread: number }) => {
      const { sessionId, unread } = data;
      
      // 更新对应会话的未读数
      setConversations(prevConvs => {
        return prevConvs.map(c => {
          if (c.id === sessionId) {
            return { ...c, unread };
          }
          return c;
        });
      });
    });

    // ==================== 用户状态变化处理 ====================
    socket.on('userStatus', (data: { userId: string; status: string }) => {
      const { userId, status } = data;
      
      if (String(userId) === String(currentUserRef.current?.id)) {
        setConversations(prevConvs => 
          prevConvs.map(c => 
            (c.type === 'friend' && String((c as any).otherUserId) === String(userId)) 
              ? { ...c, status } : c
          )
        );
        setActiveChat(prev => {
          if (prev && prev.type === 'friend' && String((prev as any).otherUserId) === String(userId)) {
            return { ...prev, status };
          }
          return prev;
        });
        return;
      }
      
      const conv = conversationsRef.current.find(c => 
        c.type === 'friend' && String((c as any).otherUserId) === String(userId)
      );
      
      if (!conv) {
        return;
      }
      
      // 获取通知设置
      const notificationSettings = JSON.parse(localStorage.getItem('notificationSettings') || '{}');
      const userName = conv.name;
      const statusKey = `${userId}-${status}`;
      const lastNotifyTime = sentStatusNotifications.current.get(statusKey) || 0;
      const now = Date.now();
      
      // 用户上线和离线时显示通知（2分钟内不重复提示）
      if (now - lastNotifyTime > 120000) {
        sentStatusNotifications.current.set(statusKey, now);
        if (status === 'online' && notificationSettings.onlineNotify) {
          addNotification('success', '用户上线', `${userName} 已上线`);
        } else if (status === 'offline' && notificationSettings.offlineNotify) {
          addNotification('info', '用户离线', `${userName} 已离线`);
        }
      }
      
      setConversations(prevConvs => 
        prevConvs.map(c => 
          (c.type === 'friend' && String((c as any).otherUserId) === String(userId)) 
            ? { ...c, status } : c
        )
      );
      // 同时更新 activeChat
      setActiveChat(prev => {
        if (prev && prev.type === 'friend' && String((prev as any).otherUserId) === String(userId)) {
          return { ...prev, status };
        }
        return prev;
      });
    });

    // ==================== 群成员更新处理 ====================
    socket.on('groupMembersUpdate', (data: { groupId: string }) => {
      if (activeChatRef.current?.id === data.groupId) {
        fetchGroupInfo(data.groupId);
      }
    });

    // ==================== 被踢出群聊通知 ====================
    socket.on('kickedFromGroup', (data: { groupId: string; groupName: string; kickedBy: string }) => {
      // 去重：同一个群只显示一次通知
      const notifyKey = `kickedGroup_${data.groupId}`;
      if (shownNotificationsRef.current.has(notifyKey)) {
        return;
      }
      shownNotificationsRef.current.add(notifyKey);

      addNotification('warning', '被移出群聊', `你已被 ${data.kickedBy} 从 "${data.groupName}" 踢出群聊`);
      
      // 从会话列表中移除该群聊
      setConversations(prev => prev.filter(c => c.id !== data.groupId));
      
      // 如果当前正在该群聊天，切换到其他会话
      if (activeChatRef.current?.id === data.groupId) {
        setActiveChat(null);
        setMessages([]);
      }
      
      fetchConversations();
    });

    // ==================== 加入群聊通知 ====================
    socket.on('joinedGroup', (data: { groupId: string; groupName: string }) => {
      // 去重：同一个群只显示一次通知
      const notifyKey = `joinedGroup_${data.groupId}`;
      if (shownNotificationsRef.current.has(notifyKey)) {
        return;
      }
      shownNotificationsRef.current.add(notifyKey);

      addNotification('success', '加群成功', `你已加入群聊 "${data.groupName}"`);
      fetchConversations();
    });

    // ==================== 入群申请通知 ====================
    socket.on('joinRequestSubmitted', (data: { groupId: string; groupName: string; userName: string }) => {
      addNotification('info', '新的入群申请', `${data.userName} 申请加入群聊 "${data.groupName}"`);
      // 通知 ChatWindow 刷新申请数量
      window.dispatchEvent(new CustomEvent('newJoinRequest', { detail: { groupId: data.groupId } }));
    });

    socket.on('joinRequestApproved', (data: { groupId: string; groupName: string }) => {
      toast.success('入群申请已通过', `你已获准加入群聊 "${data.groupName}"`);
      fetchConversations();
      window.dispatchEvent(new CustomEvent('newJoinRequest', { detail: { groupId: data.groupId } }));
    });

    socket.on('joinRequestRejected', (data: { groupId: string; groupName: string; reason?: string }) => {
      toast.warning('入群申请被拒绝', `你在群聊 "${data.groupName}" 的入群申请被拒绝${data.reason ? `：${data.reason}` : ''}`);
      window.dispatchEvent(new CustomEvent('newJoinRequest', { detail: { groupId: data.groupId } }));
    });

    // ==================== 消息已读处理 ====================
    // 收到已读回执时刷新消息列表
    socket.on('messagesRead', (data: { readerId: string; readerName: string; sessionId: string; messageIds: string[] }) => {
      const { readerId, readerName, sessionId } = data;
      const isCurrentChat = activeChatRef.current?.id === sessionId;
      const currentUserId = currentUserRef.current?.id;
      
      // 更新本地消息的已读状态
      if (isCurrentChat && String(readerId) !== String(currentUserId)) {
        setMessages(prev => prev.map(m => {
          // 找到自己发的消息
          if (String(m.sender?.id) === String(currentUserId)) {
            return { ...m, read: true, readBy: readerName };
          }
          return m;
        }));
      }
    });

    // ==================== 会话列表更新处理 ====================
    socket.on('conversationsUpdate', () => {
      fetchConversations();
    });

    // ==================== 消息撤回/删除处理 ====================
    socket.on('messageRecalled', (data: { messageId: string; sessionId: string, originalSenderId: string; actorId: string; actorName: string }) => {
      
      const { messageId, sessionId, actorId, actorName } = data;
      const isCurrentChat = activeChatRef.current?.id === sessionId;
      
      if (isCurrentChat) {
        setMessages(prev => prev.map(m => {
          if (m.id === messageId) {
            const isActor = String(actorId) === String(currentUserRef.current?.id);
            const displayContent = isActor ? `你撤回了一条消息` : `${actorName || '对方'} 撤回了一条消息`;
            
            return { 
              ...m, 
              recalled: true,
              isSystem: true,
              content: displayContent,
              sender: { ...m.sender, id: actorId }
            } as any;
          }
          return m;
        }));
      }
      
      if (String(data.originalSenderId) === String(currentUserRef.current?.id) || String(actorId) === String(currentUserRef.current?.id)) {
        setConversations(prevConvs => {
          const conv = prevConvs.find(c => c.id === sessionId);
          if (conv) {
            const displayContent = String(actorId) === String(currentUserRef.current?.id) 
              ? '你撤回了一条消息' 
              : `${actorName || '对方'} 撤回了一条消息`;
            return prevConvs.map(c => 
              c.id === sessionId ? { ...c, lastMessage: displayContent } : c
            );
          }
          return prevConvs;
        });
      }
    });

    socket.on('messageDeleted', (data: { messageId: string; sessionId: string; originalSenderId: string; actorId: string; actorName: string; isBurnAfterRead?: boolean }) => {
      
      const { messageId, sessionId, actorId, actorName, isBurnAfterRead } = data;
      const currentUserId = currentUserRef.current?.id;
      const isOriginalSender = String(data.originalSenderId) === String(currentUserId);
      const isActor = String(actorId) === String(currentUserId);
      
      // 阅后即焚消息：isBurnAfterRead 为 true 时显示查看提示
      // isOriginalSender 为 true 表示这条消息是当前用户发送的
      const displayContent = isBurnAfterRead
        ? `${actorName || '对方'} 已查看阅后即焚的消息`
        : isOriginalSender && isActor
        ? `你删除了这条消息`
        : `${actorName || '对方'} 删除了你的一条消息`;
      
      
      
      // 更新消息列表
      setMessages(prev => prev.map(m => {
        if (m.id === messageId) {
          
          return { 
            ...m, 
            isSystem: true,
            content: displayContent,
            sender: { ...m.sender, id: actorId },
            attachments: []
          } as any;
        }
        return m;
      }));
      
      // 更新会话列表
      setConversations(prevConvs => {
        const conv = prevConvs.find(c => c.id === sessionId);
        if (conv) {
          return prevConvs.map(c => 
            c.id === sessionId ? { ...c, lastMessage: displayContent } : c
          );
        }
        return prevConvs;
      });
    });

    // ==================== 删除被阻止处理 ====================
    socket.on('deleteBlocked', (data: { messageId: string; reason: string }) => {
      const { reason } = data;
    
      if (reason === 'cannot_delete') {
        toast.error('该用户不允许删除消息');
      }
    });

    // ==================== 阅后即焚消息被查看处理 ====================
    socket.on('burnAfterRead', (data: { messageId: string; sessionId: string; originalSenderId: string; viewerId: string; viewerName: string }) => {
      const { messageId, sessionId, originalSenderId, viewerName } = data;
      const isOriginalSender = String(originalSenderId) === String(currentUserRef.current?.id);
      
      if (!isOriginalSender) return;
      
      const displayContent = `${viewerName || '对方'} 查看了阅后即焚消息`;
      
      // 更新消息列表：查找阅后即焚消息并更新
      setMessages(prev => {
        
        
        // 先直接匹配
        let targetMessage = prev.find(m => m.id === messageId);
        
        // 如果没找到，查找该会话中自己发送的阅后即焚消息
        if (!targetMessage) {
          const currentSessionMessages = prev.filter(m => 
            (m as any).sessionId === sessionId && 
            (m as any).burnAfterReading === true && 
            sentMessageIdsRef.current.has(m.id)
          );
          
          if (currentSessionMessages.length > 0) {
            targetMessage = currentSessionMessages[currentSessionMessages.length - 1]; // 取最新的
          }
        }
        
        if (targetMessage) {
          return prev.map(m => {
            if (m.id === targetMessage!.id) {
              return { 
                ...m, 
                isSystem: true,
                content: displayContent,
                attachments: []
              } as any;
            }
            return m;
          });
        }
        return prev;
      });
      
      // 更新会话列表中的最后消息
      setConversations(prevConvs => {
        const convIndex = prevConvs.findIndex(c => c.id === sessionId);
        if (convIndex !== -1) {
          return prevConvs.map(c => 
            c.id === sessionId ? { ...c, lastMessage: displayContent } : c
          );
        }
        return prevConvs;
      });
    });

    // ==================== 登录时通知处理 ====================
    socket.on('report', (data: any) => {
      // console.log('[report] 收到登录通知:', data);
      addNotification('warning', data.title || '新举报', data.content || '');
    });
    
    // ==================== 实时举报通知 ====================
    socket.on('newReport', (data: { messageId: string }) => {
      // console.log('[newReport] 收到举报通知:', data);
      addNotification('warning', '新举报', '有新的举报信息，请查看管理员面板');
    });

    socket.on('typing', (data: { userId: string; userName: string; sessionId: string }) => {
      if (data.sessionId !== activeChatRef.current?.id) return;
      if (data.userId === currentUserRef.current?.id) return;

      setTypingUsers(prev => {
        const existing = prev.find(u => u.userId === data.userId);
        if (existing) {
          clearTimeout(existing.timeout);
        }
        
        const timeout = setTimeout(() => {
          setTypingUsers(prev => prev.filter(u => u.userId !== data.userId));
        }, 3000);

        if (existing) {
          return prev.map(u => u.userId === data.userId ? { ...u, timeout } : u);
        }
        
        return [...prev, { userId: data.userId, userName: data.userName, timeout }];
      });
    });

    // 保存socket引用
    socketRef.current = socket;

    // 组件卸载时断开连接
    return () => {
      socket.disconnect();
    };
  };

  // ==================== 获取会话列表 ====================
  // 从服务器获取当前用户的会话列表（左侧用户列表）
  const fetchConversations = async () => {
    const token = localStorage.getItem('token');
    if (!token) return;

    setIsLoadingConversations(true);
    try {
      const response = await apiFetch(API.conversations.list, { requireCsrf: false });
      const data = await response.json();
      if (data.success) {
        let newConversations = data.data;
        
        // 服务器返回的是原始UTC时间戳，偏移+8小时转换为本地时间显示
        newConversations = newConversations.map((conv: any) => ({
          ...conv,
          lastTime: conv.lastTime ? getServerTimestamp(conv.lastTime) : conv.lastTime
        }));
        
        // 解密最后消息
        const keys = loadKeysFromStorage();
        // 解密会话列表的最后消息
        newConversations = newConversations.map((conv: any) => {
          if (!conv.lastMessage) return conv;
          
          // 检查是否可能是加密内容
          const isLikelyEncrypted = conv.lastMessage?.startsWith('U2FsdGVkX') || conv.lastMessage?.startsWith('Salted__');
          const isEncrypted = conv.lastMessageIsEncrypted === true || conv.lastMessageIsEncrypted === 1;
          
          // 如果可能是加密内容，尝试解密
          if ((isEncrypted || isLikelyEncrypted) && keys && conv.lastMessage) {
            const result = tryDecrypt(conv.lastMessage);
            if (result.decrypted) {
              return { ...conv, lastMessage: result.content, lastMessageDecryptFailed: false };
            } else {
              return { ...conv, lastMessage: '🔒 解密失败', lastMessageDecryptFailed: true };
            }
          }
          
          // 如果有加密标记但解密失败，也显示解密失败
          if (isEncrypted && keys && conv.lastMessage) {
            return { ...conv, lastMessage: '🔒 解密失败', lastMessageDecryptFailed: true };
          }
          
          // 如果看起来像加密内容但没有密钥，显示解密失败
          if (isLikelyEncrypted && !keys) {
            return { ...conv, lastMessage: '🔒 解密失败（无密钥）', lastMessageDecryptFailed: true };
          }
          
          return conv;
        });
        
        // 只更新状态记录，不发送通知（通知由 userStatus 事件统一处理）
        newConversations.forEach((conv: Conversation) => {
          if (conv.type === 'friend') {
            const userId = (conv as any).otherUserId;
            const newStatus = conv.status;
            lastStatusRef.current.set(userId, newStatus);
          }
        });
        
        const sorted = [...newConversations].sort((a, b) => {
          const aPinned = a.isPinned ? 1 : 0;
          const bPinned = b.isPinned ? 1 : 0;
          if (aPinned !== bPinned) return bPinned - aPinned;
          const aUnread = a.unread || 0;
          const bUnread = b.unread || 0;
          if (aUnread !== bUnread) return bUnread - aUnread;
          return (b.lastTime || 0) - (a.lastTime || 0);
        });
        setConversations(sorted);
        conversationsRef.current = sorted;
        
        // 自动加入所有会话，以便接收新消息
        if (socketRef.current) {
          newConversations.forEach((conv: Conversation) => {
            socketRef.current?.joinSession(conv.id);
          });
        }
      }
    } catch (error) {
      console.error('Failed to fetch conversations:', error);
    } finally {
      setIsLoadingConversations(false);
    }
  };

  // ==================== WebSocket 预热函数 ====================
  const warmupWebSocket = async () => {
    try {
      const token = localStorage.getItem('token');
      if (!token) return;
      
      const baseUrl = API_BASE_URL.replace(/\/$/, '');
      await fetch(`${baseUrl}/api/ws/warmup`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
      });
    } catch (e) {
      console.warn('[WebSocket] 预热失败:', e);
    }
  };

  // ==================== 登录处理 ====================
  const handleLogin = (user: any) => {
    // 先断开旧的WebSocket连接（使用 cfSocket 单例）
    cfSocket.disconnect();
    
    // 清空所有旧状态，确保重新登录时从头开始
    setConversations([]);
    setMessages([]);
    setActiveChat(null);
    setGroupInfo(null);
    setGlobalMuted(false);
    setCurrentUser({ 
      id: user.id, 
      name: user.name, 
      username: user.username || '', 
      avatar: user.avatar || '', 
      signature: user.signature || '',
      status: 'online',
      role: user.role || 'user',
      accountStatus: user.accountStatus || 'normal'
    });
    
    // 启动 CSRF token 自动刷新
    startCsrfRefresh();
    
    // 重新加载历史密钥
    const keys = loadKeysFromStorage();
    if (keys && keys.legacyKeys) {
      setLegacyKeys(keys.legacyKeys);
      setShowLegacyKeys(new Array(keys.legacyKeys.length).fill(false));
    }
    
    fetchConversations();
    
    // 加载用户设置
    loadAppSettingsFromDb().then(settings => {
      applyAppSettings(settings);
    }).catch(() => {
      initAppSettings();
    });
    
    // 预热 WebSocket Durable Object，等待 150ms 确保旧连接处理完成
    warmupWebSocket().then(() => {
      setTimeout(() => {
        connectSocket(user.id);  // 连接WebSocket
      }, 150);
    }).catch(() => {
      setTimeout(() => {
        connectSocket(user.id);  // 即使预热失败也尝试连接
      }, 150);
    });
  };

  // ==================== 选择会话（点击用户） ====================
  // 用户点击左侧某个会话时调用，获取该会话的消息历史
  const handleSelectChat = async (conv: Conversation) => {
    // 切换会话时清空消息和重置分页状态
    const loadingSessionId = conv.id;  // 保存当前加载的会话 ID
    messagesRef.current = [];
    setMessages([]);
    setMessagePage(1);
    setHasMoreMessages(true);
    
    setActiveChat(conv);
    setActiveChatId(conv.id);  // 同时保存 activeChatId
    activeChatRef.current = conv;  // 同时更新 ref
    (window as any).__activeChatId = conv.id;  // 同步到全局变量，供 MessageInput 使用
    
    // 检查禁言状态
    const token = localStorage.getItem('token');
    if (!token) return;
    
    if (conv.type === 'group') {
      try {
        const muteRes = await apiFetch(API.groups.muteStatus(conv.id), { requireCsrf: false });
        const muteData = await muteRes.json();
        setIsMuted(muteData.muted || false);
        setMuteReason(muteData.reason || '');
      } catch (e) {
        setIsMuted(false);
        setMuteReason('');
      }
    } else {
      setIsMuted(false);
      setMuteReason('');
    }
    
    setIsLoadingMessages(true);
    
    // 标记已读
    try {
      await apiFetch(API.conversations.read(conv.id), {
        method: 'POST'
      });
    } catch (e) {}

    // 获取消息历史
    const url = `${API.conversations.messages(conv.id)}?page=1&limit=50`;
    
    try {
      const response = await apiFetch(url, { requireCsrf: false });
      const data = await response.json();
      
      // 检查是否还是当前加载的会话（防止切换会话后旧请求返回）
      // 使用 loadingSessionId 而不是 activeChat，因为 activeChat 可能在异步期间被更新
      if (activeChatRef.current?.id !== loadingSessionId) {
        return;
      }
      
      if (data.success) {
        const keys = loadKeysFromStorage();
        // 后端已返回时间正序的消息，不再需要反转
        const rawMessages = data.data;
        const decryptedMessages = rawMessages.map((msg: any) => {
          const isContentLikelyEncrypted = msg.content && (msg.content.startsWith('U2FsdGVkX') || msg.content.startsWith('Salted__'));
          const isMsgEncrypted = msg.isEncrypted === true || msg.isEncrypted === 'true' || msg.encrypted === 1 || msg.encrypted === true || isContentLikelyEncrypted;
          
          // 如果内容是加密的，尝试解密
          if (isMsgEncrypted && msg.content) {
            if (keys) {
              const result = tryDecrypt(msg.content);
              if (result.decrypted) {
                return { ...msg, content: result.content, decryptKeyUsed: result.keyUsed, timestamp: convertServerTime(msg.timestamp) };
              }
            }
            // 解密失败，显示提示
            msg.decryptFailed = true;
            return { ...msg, content: '🔒 解密失败，无法显示内容', decryptFailed: true, timestamp: convertServerTime(msg.timestamp) };
          }
          return { ...msg, timestamp: convertServerTime(msg.timestamp) };
        });
        
        // 更新最后消息时间
        if (decryptedMessages.length > 0) {
          const latestTime = getServerTimestamp(decryptedMessages[decryptedMessages.length - 1].timestamp);
          lastMessageTimeRef.current.set(conv.id, latestTime);
        }
        
        // 直接替换：消息已存在就替换，不存在就添加
        // 直接使用消息ID来判断是否重复
        const existingMap = new Map<string, any>();
        messagesRef.current.forEach(m => {
          existingMap.set(m.id, m);
        });
        
        // 合并新消息
        decryptedMessages.forEach(m => {
          existingMap.set(m.id, m);
        });
        
        const allMessages = Array.from(existingMap.values()).sort(
          (a, b) => {
            // timestamp 已经是 Date 对象，直接用 getTimestamp 获取时间戳进行比较
            const timeA = getTimestamp(a.timestamp);
            const timeB = getTimestamp(b.timestamp);
            return timeA - timeB;
          }
        );
        
        // 更新消息状态
        messagesRef.current = allMessages;
        setMessages(allMessages);
        
        // 只有当消息数量达到每页上限时才显示"加载更多"
        // 如果返回的消息数量少于每页限制，说明没有更多消息了
        setHasMoreMessages(decryptedMessages.length >= 50);
      }
    } catch (error) {
      console.error('加载消息失败:', error);
    } finally {
      setIsLoadingMessages(false);
    }
    
    // 清空本地未读数
    setConversations(prev => prev.map(c => 
      c.id === conv.id ? { ...c, unread: 0 } : c
    ));
    
    // 群信息
    if (conv.type === 'group') {
      fetchGroupInfo(conv.id);
    }
    
    // 加入WebSocket房间
    if (socketRef.current) {
      socketRef.current.joinSession(conv.id);
    }
  };

  // 后台加载最新消息（缓存过期时使用）
  const loadMessagesInBackground = async (sessionId: string, token: string | null, existingMessages: any[]) => {
    if (!token) return;
    
    // 检查是否还是当前会话
    if (activeChat?.id !== sessionId) {
      return;
    }
    
    try {
      const response = await apiFetch(`${API.conversations.messages(sessionId)}?page=1&limit=50`, { requireCsrf: false });
      
      // 再次检查
      if (activeChat?.id !== sessionId) {
        return;
      }
      
      const data = await response.json();
      
      if (data.success) {
        const keys = loadKeysFromStorage();
        const rawMessages = data.data.reverse();
          const decryptedMessages = rawMessages.map((msg: any) => {
            const isContentLikelyEncrypted = msg.content && (msg.content.startsWith('U2FsdGVkX') || msg.content.startsWith('Salted__'));
            const isMsgEncrypted = msg.isEncrypted === true || msg.isEncrypted === 'true' || msg.encrypted === 1 || msg.encrypted === true || isContentLikelyEncrypted;
            const hasAttachments = msg.attachments && msg.attachments.length > 0;
            
            // 如果内容是加密的，尝试解密
            if (isMsgEncrypted && msg.content) {
              if (keys) {
                const result = tryDecrypt(msg.content);
                if (result.decrypted) {
                  return { ...msg, content: result.content, decryptKeyUsed: result.keyUsed, timestamp: convertServerTime(msg.timestamp) };
                }
              }
              // 有附件时不显示解密失败（附件可能正常），只标记
              if (!hasAttachments) {
                return { ...msg, content: '🔒 解密失败，无法显示内容', decryptFailed: true, timestamp: convertServerTime(msg.timestamp) };
              }
            }
            return { ...msg, timestamp: convertServerTime(msg.timestamp) };
          });
        
        // 检查是否有新消息
        const existingIds = new Set(existingMessages.map(m => m.id));
        const newMessages = decryptedMessages.filter(m => !existingIds.has(m.id));
        
        if (newMessages.length > 0) {
          const allMessages = [...existingMessages, ...newMessages].sort((a, b) => 
            getTimestamp(a.timestamp) - getTimestamp(b.timestamp)
          );
          messagesRef.current = allMessages;
          setMessages(allMessages);
        }
      }
    } catch (error) {
    }
  };

  // 加载更多消息（分页）
  // ==================== 加载更多消息（分页） ====================
  const loadMoreMessages = async () => {
    if (!activeChat) {
      return;
    }
    if (isLoadingMessages) {
      return;
    }
    if (!hasMoreMessages) {
      return;
    }
    
    setIsLoadingMessages(true);
    const nextPage = messagePage + 1;
    
    try {
      const response = await apiFetch(`${API.conversations.messages(activeChat.id)}?page=${nextPage}&limit=50`, { requireCsrf: false });
      const data = await response.json();
      
        if (data.success) {
        const keys = loadKeysFromStorage();
        const newMessages = data.data.map((msg: any) => {
          const isContentLikelyEncrypted = msg.content && (msg.content.startsWith('U2FsdGVkX') || msg.content.startsWith('Salted__'));
          const isMsgEncrypted = msg.isEncrypted === true || msg.isEncrypted === 'true' || msg.encrypted === 1 || msg.encrypted === true || isContentLikelyEncrypted;
          const hasAttachments = msg.attachments && msg.attachments.length > 0;
          
          if (isMsgEncrypted && msg.content) {
            if (keys) {
              const result = tryDecrypt(msg.content);
              if (result.decrypted) {
                return { ...msg, content: result.content, decryptKeyUsed: result.keyUsed, timestamp: convertServerTime(msg.timestamp) };
              } else if (!hasAttachments) {
                return { ...msg, content: '🔒 解密失败', decryptFailed: true, timestamp: convertServerTime(msg.timestamp) };
              }
            } else if (!hasAttachments) {
              return { ...msg, content: '🔒 解密失败', decryptFailed: true, timestamp: convertServerTime(msg.timestamp) };
            }
          }
          return { ...msg, timestamp: convertServerTime(msg.timestamp) };
        });
        
        if (newMessages.length < 50) {
          setHasMoreMessages(false);
        }
        
        setMessagePage(nextPage);
        
        const messagesContainer = document.querySelector('.messages-container') as HTMLElement;
        
        // 保存当前滚动位置和容器高度
        let currentScrollTop = 0;
        let currentHeight = 0;
        if (messagesContainer) {
          currentScrollTop = messagesContainer.scrollTop;
          currentHeight = messagesContainer.scrollHeight;
        }
        
        // 合并并排序所有消息
        const existingMap = new Map<string, any>();
        messages.forEach(m => existingMap.set(m.id, m));
        newMessages.forEach(m => existingMap.set(m.id, m));
        
        const newAllMessages = Array.from(existingMap.values()).sort(
          (a, b) => {
            const timeA = getTimestamp(a.timestamp);
            const timeB = getTimestamp(b.timestamp);
            return timeA - timeB;
          }
        );
        
        messagesRef.current = newAllMessages;
        setMessages(newAllMessages);
        
        // DOM 更新后调整滚动位置
        setTimeout(() => {
          if (messagesContainer) {
            const newHeight = messagesContainer.scrollHeight;
            const addedHeight = newHeight - currentHeight;
            // 新滚动位置 = 原位置 + 新消息高度（保持相对位置不变）
            messagesContainer.scrollTop = currentScrollTop + addedHeight;
          }
        }, 50);
      }
    } catch (error) {
      console.error('Failed to load more messages:', error);
    } finally {
      setIsLoadingMessages(false);
    }
  };

  // ==================== 更新会话的最后消息 ====================
  const updateConversationWithNewMessage = (sessionId: string, content: string, isNewMessage: boolean = false) => {
    const now = Date.now();  // 临时使用本地时间
    const updated = conversations.map(c => 
      c.id === sessionId ? { ...c, lastMessage: content, lastTime: now } : c
    );
    // 排序：置顶 > 未读 > 最后消息时间
    const sorted = [...updated].sort((a, b) => {
      const aPinned = a.isPinned ? 1 : 0;
      const bPinned = b.isPinned ? 1 : 0;
      if (aPinned !== bPinned) return bPinned - aPinned;
      const aUnread = a.unread || 0;
      const bUnread = b.unread || 0;
      if (aUnread !== bUnread) return bUnread - aUnread;
      return (b.lastTime || 0) - (a.lastTime || 0);
    });
    setConversations(sorted);
  };

  const fetchGroupInfo = async (groupId: string) => {
    const token = localStorage.getItem('token');
    if (!token) return;

    try {
      const response = await apiFetch(API.groups.info(groupId), { requireCsrf: false });
      const data = await response.json();
      if (data.success) {
        setGroupInfo(data.data);
      }
    } catch (error) {
      console.error('Failed to fetch group info:', error);
    }
  };

  const handleTogglePin = async (convId: string, isPinned: boolean) => {
    try {
      const res = await apiFetch(API.conversations.pin(convId), {
        method: 'POST',
        body: JSON.stringify({ isPinned })
      });
      const data = await res.json();
      if (data.success) {
        fetchConversations();
      } else {
        console.error('Failed to toggle pin:', data.message);
      }
    } catch (error) {
      console.error('Failed to toggle pin:', error);
    }
  };

  const handleToggleMute = async (convId: string, isMuted: boolean) => {
    try {
      const res = await apiFetch(API.conversations.mute(convId), {
        method: 'POST',
        body: JSON.stringify({ isMuted })
      });
      const data = await res.json();
      if (data.success) {
        fetchConversations();
      } else {
        console.error('Failed to toggle mute:', data.message);
      }
    } catch (error) {
      console.error('Failed to toggle mute:', error);
    }
  };

  const handleLogout = async () => {
    setIsLoggingOut(true);
    
    try {
      await apiFetch(API.auth.logout, { method: 'POST', requireCsrf: true });
    } catch (e) {
      console.error('Logout API error:', e);
    }
    
    // 停止 CSRF token 自动刷新
    stopCsrfRefresh();
    
    cfSocket.disconnect();
    socketRef.current = null;
    
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    localStorage.removeItem('activePanel');
    localStorage.removeItem('activeChatId');
    localStorage.removeItem('adminToken');
    localStorage.removeItem('adminEncryptionKey');
    localStorage.removeItem('adminActiveTab');
    
    sessionStorage.clear();
    TaskService.resetInstance();
    
    typingUsers.forEach(u => {
      if (u.timeout) clearTimeout(u.timeout);
    });
    
    setCurrentUser(null);
    setConversations([]);
    setMessages([]);
    setActiveChat(null);
    setGroupInfo(null);
    setActivePanel('chat');
    setActiveChatId(null);
    setReplyTo(null);
    setUploads([]);
    setTaskService(null);
    setNotifications([]);
    setSearchKeyword('');
    setMessagePage(1);
    setHasMoreMessages(true);
    setIsLoadingMessages(false);
    setIsLoadingConversations(false);
    setPendingEncryptionKey('');
    setShowLegacyKeys([]);
    setShowAdmin(false);
    setShowProgressFloat(false);
    setEncryptionKey(INITIAL_ENCRYPTION_KEY);
    setLegacyKeys([]);
    
    // 9. 清理未释放的 Blob URL
    const revokeBlobUrls = (window as any).__revokeBlobUrls;
    if (revokeBlobUrls) {
      revokeBlobUrls.forEach((url: string) => URL.revokeObjectURL(url));
      (window as any).__revokeBlobUrls = [];
    }
    
    // 10. 清理 URL.revokeObjectURL 相关缓存
    const revokedUrls = (window as any).__revokedUrls || new Set();
    revokedUrls.forEach((url: string) => URL.revokeObjectURL(url));
    (window as any).__revokedUrls = new Set();
    
    setIsLoggingOut(false);
  };

interface Attachment {
  id: string;
  type: 'image' | 'file';
  name: string;
  size: number;
  url: string;
  isPending?: boolean;
  previewUrl?: string;
  originalFile?: File;  // 保存原始 File 对象
  encrypted?: boolean;  // 是否加密
  encrypting?: boolean; // 是否正在加密
  uploading?: boolean;
  uploadProgress?: number;
  downloadProgress?: number;
  downloading?: boolean;
}

// 消息状态类型
type MessageStatus = 'sending' | 'sent' | 'failed';

const handleSendMessage = async (content: string, attachments?: Attachment[], mentions?: string[], burnAfterReading?: boolean) => {
    if (!activeChat || !currentUser) return;

// 检查用户是否被封禁或禁言
    if (globalMuted || currentUser?.accountStatus === 'banned') {
      addNotification('error', '发送失败', '您已被封禁，无法发送消息');
      return;
    }
    if (globalMuted || currentUser?.accountStatus === 'muted') {
      addNotification('error', '发送失败', '您已被禁言，无法发送消息');
      return;
    }

    // 确保 activeChatId 已设置
    if (!activeChatId) {
      setActiveChatId(activeChat.id);
    }

    // 分离已上传的附件和待上传的文件
    const uploadedAttachments: Attachment[] = [];
    const pendingAttachments: Attachment[] = [];
    
    if (attachments) {
      attachments.forEach(att => {
        if (att.isPending) {
          pendingAttachments.push(att);
        } else {
          uploadedAttachments.push(att);
        }
      });
    }

    // 如果有待上传的文件，先上传
    const tempMessageId = `temp_${generateId()}`;
    
    // 如果有待上传文件，先创建临时消息显示在界面上
    if (pendingAttachments.length > 0) {
      const keys = loadKeysFromStorage();
      const currentKey = keys?.currentKey || encryptionKeyRef.current;
      const hasKey = !!currentKey;
      
      const tempAttachments = pendingAttachments.map(att => ({
        ...att,
        url: att.previewUrl || '',
        uploading: true,
        encrypting: hasKey, // 如果有密钥，显示加密动画
        uploadProgress: 0
      }));
      
      // 保存回复信息
      const replyInfo = replyTo ? { replyTo } : undefined;
      
      const tempMessage: Message & { status?: MessageStatus; mentions?: string[]; burnAfterReading?: boolean } = {
        id: tempMessageId,
        content,
        sender: currentUser,
        receiver: { id: activeChat.id, name: activeChat.name, avatar: '', status: 'online' },
        timestamp: new Date(),
        read: false,
        status: 'sending',
        attachments: tempAttachments,
        burnAfterReading: burnAfterReading || undefined,
        ...replyInfo
      };
      
      // 添加临时消息到界面
      setMessages(prev => [...prev, tempMessage]);
      messagesRef.current = [...messagesRef.current, tempMessage];
      
      // 将文件添加到上传队列
      // 如果没有密钥，提示用户
      if (!currentKey && pendingAttachments.length > 0) {
        addNotification('warning', '未设置密钥', '当前没有设置密钥，文件不会被加密');
      }
      
      for (let i = 0; i < pendingAttachments.length; i++) {
        const att = pendingAttachments[i];
        const originalSize = att.size;
        // 只要有密钥就加密文件
        const isEncrypted = !!currentKey;
        // console.log('[DEBUG] 上传消息附件: isEncrypted=', isEncrypted, 'currentKey=', !!currentKey);
        
        let fileForUpload: File;
        
        if (att.originalFile) {
          fileForUpload = att.originalFile;
          // 使用 TaskService 添加上传任务
          taskService?.addUploadTask({
            filename: att.name,
            file: fileForUpload,
            totalSize: originalSize,
            tempMessageId,
            attachmentId: att.id,
            isEncrypted,
            customEndpoint: '/api/upload'
          });
        } else if (att.previewUrl) {
          // 如果是 blob URL，需要异步获取
          fetch(att.previewUrl).then(res => res.blob()).then(blob => {
            const file = new File([blob], att.name, { type: blob.type });
            // 使用 TaskService 添加上传任务
            taskService?.addUploadTask({
              filename: att.name,
              file: file,
              totalSize: originalSize,
              tempMessageId,
              attachmentId: att.id,
              isEncrypted,
              customEndpoint: '/api/upload'
            });
          });
        } else {
          fileForUpload = new File([''], att.name, { type: 'application/octet-stream' });
        }
      }
      return;
    }

    // 没有待上传文件，直接发送消息
    const messageId = `msg_${generateId()}`;

    // 加密消息内容
    const keys = loadKeysFromStorage();
    const currentKey = keys?.currentKey || encryptionKeyRef.current;
    const hasTextContent = content && content.trim().length > 0;
    const shouldEncrypt = hasTextContent && !!currentKey;
    
    // 直接加密，不做其他处理
    const finalContent = shouldEncrypt ? encrypt(content, currentKey!) : content;
    
    // 显示内容：尝试解密以验证
    let displayContent = finalContent;
    if (shouldEncrypt && currentKey) {
      const result = tryDecrypt(finalContent);
      if (result.decrypted) {
        displayContent = result.content;
      }
    }

    const newMessage: Message & { status?: MessageStatus; mentions?: string[]; burnAfterReading?: boolean } = {
      id: messageId,
      content: displayContent,
      sender: currentUser,
      receiver: { id: activeChat.id, name: activeChat.name, avatar: '', status: 'online' },
      timestamp: new Date(),
      read: false,
      status: 'sending'
    };

    // 记录自己发送的消息ID，用于已读回执时更新
    sentMessageIdsRef.current.add(messageId);

    if (uploadedAttachments.length > 0) {
      newMessage.attachments = uploadedAttachments;
    }

    // 如果有回复的消息，添加到消息对象中
    const replyId = replyTo?.id || null;
    if (replyTo) {
      newMessage.replyTo = replyTo;
    }

    // 添加提及
    if (mentions && mentions.length > 0) {
      newMessage.mentions = mentions;
    }

    // 阅后即焚
    if (burnAfterReading) {
      newMessage.burnAfterReading = true;
    }
    
    // 通过WebSocket发送消息
    if (socketRef.current) {
      socketRef.current.sendMessage(activeChat.id, finalContent, {
        attachments: uploadedAttachments,
        quoteId: replyId || undefined,
        mentions,
        burnAfterReading,
        isEncrypted: shouldEncrypt,
        timestamp: Date.now(),
        clientMessageId: messageId
      });
      socketRef.current.joinSession(activeChat.id);
    }

    // 显示消息
    setMessages(prev => [...prev, newMessage]);
    messagesRef.current = [...messagesRef.current, newMessage];
    updateConversationWithNewMessage(activeChat.id, displayContent);
    
    // 清空回复状态
    setReplyTo(null);
  };

    // 处理消息发送成功事件
    useEffect(() => {
      if (!socketRef.current) return;

      // 监听消息发送成功事件
      socketRef.current.on('messageSent', (data: { id: string; time: number; tempId?: string }) => {
        const targetId = data.tempId || messagesRef.current.find(m => m.status === 'sending')?.id;
        if (!targetId) return;
        
        // 将临时消息ID替换为真实消息ID，更新状态为已发送
        setMessages(prev => {
          const updated = prev.map(m => {
            if (m.id === targetId || (m.status === 'sending' && !prev.some(p => p.id === data.id))) {
              sentMessageIdsRef.current.add(m.id);
              sentMessageIdsRef.current.add(data.id);
              return { ...m, id: data.id, status: 'sent' as MessageStatus, timestamp: convertServerTime(data.time) };
            }
            return m;
          });
          // 重新排序确保顺序正确
          return updated.sort((a, b) => getTimestamp(a.timestamp) - getTimestamp(b.timestamp));
        });

        // 同时更新 messagesRef.current
        messagesRef.current = messagesRef.current.map(m => {
          if (m.id === targetId || (m.status === 'sending' && !messagesRef.current.some(p => p.id === data.id))) {
            sentMessageIdsRef.current.add(m.id);
            sentMessageIdsRef.current.add(data.id);
            return { ...m, id: data.id, status: 'sent' as MessageStatus, timestamp: convertServerTime(data.time) };
          }
          return m;
        });
        
        // 更新会话列表的 lastTime 为服务器时间
        if (activeChat?.id) {
          setConversations(prev => prev.map(c => {
            if (c.id === activeChat.id) {
              return { ...c, lastTime: getServerTimestamp(data.time) };
            }
            return c;
          }));
        }
      });

      // 监听发送失败（如被禁言）
    socketRef.current.on('error', (data: { message?: string; tempId?: string }) => {
      if (data?.message) {
        toast.error('发送失败', data.message);
        // 移除发送中的临时消息
        const tempId = data.tempId;
        if (tempId) {
          setMessages(prev => prev.filter(m => m.id !== tempId));
          messagesRef.current = messagesRef.current.filter(m => m.id !== tempId);
        }
      }
    });

    return () => {
      socketRef.current?.off('messageSent');
      socketRef.current?.off('error');
    };
  }, [activeChat]);

  // 重试发送失败的消息
  const handleRetryMessage = useCallback((messageId: string) => {
    const message = messagesRef.current.find(m => m.id === messageId);
    if (!message || !socketRef.current || !activeChat) {
      console.error('[Retry] Missing required data:', { message: !!message, socket: !!socketRef.current, chat: !!activeChat });
      return;
    }
    
    // 检查 WebSocket 连接状态
    if (!socketRef.current.isConnected) {
      // 更新状态为正在连接
      setMessages(prev => prev.map(m => 
        m.id === messageId ? { ...m, status: 'sending' as MessageStatus } : m
      ));
      messagesRef.current = messagesRef.current.map(m => 
        m.id === messageId ? { ...m, status: 'sending' as MessageStatus } : m
      );
      
      toast.warning('正在连接...', '请稍后');
      const token = localStorage.getItem('token');
      if (token) {
        socketRef.current.connect(token);
      }
      
      // 监听连接成功后再发送
      const onConnect = () => {
        socketRef.current?.off('connect', onConnect);
        socketRef.current?.off('disconnect', onDisconnect);
        // 连接成功后重新调用
        handleRetryMessage(messageId);
      };
      const onDisconnect = () => {
        socketRef.current?.off('connect', onConnect);
        socketRef.current?.off('disconnect', onDisconnect);
      };
      socketRef.current.on('connect', onConnect);
      socketRef.current.on('disconnect', onDisconnect);
      
      // 10秒后超时
      setTimeout(() => {
        socketRef.current?.off('connect', onConnect);
        socketRef.current?.off('disconnect', onDisconnect);
        // 标记为失败
        setMessages(prev => prev.map(m => 
          m.id === messageId ? { ...m, status: 'failed' as MessageStatus } : m
        ));
      }, 10000);
      return;
    }
    
    // 更新状态为发送中
    setMessages(prev => prev.map(m => 
      m.id === messageId ? { ...m, status: 'sending' as MessageStatus } : m
    ));
    messagesRef.current = messagesRef.current.map(m => 
      m.id === messageId ? { ...m, status: 'sending' as MessageStatus } : m
    );
    
    // 获取加密密钥
    const keys = loadKeysFromStorage();
    const currentKey = keys?.currentKey || encryptionKeyRef.current;
    const shouldEncrypt = !!currentKey;
    const finalContent = shouldEncrypt ? encrypt(message.content, currentKey!) : message.content;
    
    // 重新发送消息
    const newClientId = `msg_${generateId()}`;
    
    
    try {
      const success = socketRef.current.sendMessage(activeChat.id, finalContent, {
        attachments: message.attachments,
        quoteId: message.replyTo?.id || undefined,
        isEncrypted: shouldEncrypt,
        timestamp: Date.now(),
        clientMessageId: newClientId
      });
      
      if (!success) {
        toast.error('发送失败', '请检查网络连接');
        setMessages(prev => prev.map(m => 
          m.id === messageId ? { ...m, status: 'failed' as MessageStatus } : m
        ));
        messagesRef.current = messagesRef.current.map(m => 
          m.id === messageId ? { ...m, status: 'failed' as MessageStatus } : m
        );
      }
    } catch (err) {
      console.error('[Retry] Send error:', err);
      const errorMessage = getErrorMessage(err);
      const title = isNetworkError(err) ? '网络错误' : isTimeoutError(err) ? '请求超时' : '发送失败';
      toast.error(title, errorMessage);
      setMessages(prev => prev.map(m => 
        m.id === messageId ? { ...m, status: 'failed' as MessageStatus } : m
      ));
      messagesRef.current = messagesRef.current.map(m => 
        m.id === messageId ? { ...m, status: 'failed' as MessageStatus } : m
      );
    }
  }, [activeChat]);

  // 检测消息发送超时，自动重试3次后标记失败
  useEffect(() => {
    if (!activeChat?.id || !socketRef.current) return;

    const checkTimeout = () => {
      const now = Date.now();
      const timeoutMs = 15000; // 15秒超时
      const maxRetries = 3; // 最大重试次数

      const sendingMessages = messagesRef.current.filter(m => 
        m.status === 'sending' && m.timestamp
      );

      sendingMessages.forEach(m => {
        const sendTime = getTimestamp(m.timestamp);
        if (now - sendTime > timeoutMs) {
          // 检查是否有附件正在上传，如果有则跳过重试
          const hasUploadingAttachments = m.attachments?.some((att: any) => att.uploading);
          if (hasUploadingAttachments) {
            return; // 附件还在上传中，不重试消息
          }
          
          // 超时了，检查重试次数
          const retryCount = (m as any).retryCount || 0;
          if (retryCount < maxRetries) {
            // 自动重试
            // console.log(`[AutoRetry] Message ${m.id} timed out, retrying (${retryCount + 1}/${maxRetries})`);
            // 更新重试次数
            const updated = messagesRef.current.map(msg => 
              msg.id === m.id ? { ...msg, retryCount: retryCount + 1 } : msg
            );
            messagesRef.current = updated;
            setMessages(prev => prev.map(msg => 
              msg.id === m.id ? { ...msg, retryCount: retryCount + 1 } : msg
            ));

            // 重新发送
            if (socketRef.current?.isConnected) {
              const keys = loadKeysFromStorage();
              const currentKey = keys?.currentKey || encryptionKeyRef.current;
              const shouldEncrypt = !!currentKey;
              const finalContent = shouldEncrypt ? encrypt(m.content, currentKey!) : m.content;
              const newClientId = `msg_${generateId()}`;

              socketRef.current.sendMessage(activeChat.id, finalContent, {
                attachments: m.attachments,
                quoteId: (m as any).replyTo?.id || undefined,
                isEncrypted: shouldEncrypt,
                timestamp: Date.now(),
                clientMessageId: newClientId
              });
            }
          } else {
            // 超过最大重试次数，标记为失败
            // console.log(`[AutoRetry] Message ${m.id} failed after ${maxRetries} retries`);
            setMessages(prev => prev.map(msg => 
              msg.id === m.id ? { ...msg, status: 'failed' as MessageStatus, retryCount: 0 } : msg
            ));
            messagesRef.current = messagesRef.current.map(msg => 
              msg.id === m.id ? { ...msg, status: 'failed' as MessageStatus, retryCount: 0 } : msg
            );
            toast.error('发送超时', '消息发送失败，请检查网络后重试');
          }
        }
      });
    };

    const interval = setInterval(checkTimeout, 5000); // 每5秒检查一次
    return () => clearInterval(interval);
  }, [activeChat]);

  // 监听密钥更新事件，当密钥变化时重新解密当前会话消息
  useEffect(() => {
    const handleKeyUpdated = async () => {
      if (!activeChat?.id) return;
      
      const token = localStorage.getItem('token');
      if (!token) return;
      
      try {
        const response = await apiFetch(`${API.conversations.messages(activeChat.id)}?page=1&limit=50`, { requireCsrf: false });
        const data = await response.json();
        
        if (data.success) {
          const keys = loadKeysFromStorage();
          const rawMessages = data.data;
          const decryptedMessages = rawMessages.map((msg: any) => {
            const isContentLikelyEncrypted = msg.content && (msg.content.startsWith('U2FsdGVkX') || msg.content.startsWith('Salted__'));
            const isMsgEncrypted = msg.isEncrypted === true || msg.isEncrypted === 'true' || msg.encrypted === 1 || msg.encrypted === true || isContentLikelyEncrypted;
            const hasAttachments = msg.attachments && msg.attachments.length > 0;
            
            if (isMsgEncrypted && msg.content) {
              if (keys) {
                const result = tryDecrypt(msg.content);
                if (result.decrypted) {
                  return { ...msg, content: result.content, decryptKeyUsed: result.keyUsed, timestamp: convertServerTime(msg.timestamp) };
                } else if (!hasAttachments) {
                  return { ...msg, content: '🔒 解密失败，无法显示内容', timestamp: convertServerTime(msg.timestamp) };
                }
              } else if (!hasAttachments) {
                return { ...msg, content: '🔒 解密失败，无法显示内容', timestamp: convertServerTime(msg.timestamp) };
              }
            }
            return { ...msg, timestamp: convertServerTime(msg.timestamp) };
          });
          
          setMessages(decryptedMessages);
          messagesRef.current = decryptedMessages;
        }
      } catch (e) {
        console.error('密钥更新后重新解密失败:', e);
      }
    };
    
    window.addEventListener('encryptionKeyUpdated', handleKeyUpdated);
    return () => {
      window.removeEventListener('encryptionKeyUpdated', handleKeyUpdated);
    };
  }, [activeChat?.id]);

  const handleDeleteMessage = async (messageId: string) => {
    const msg = messagesRef.current.find(m => m.id === messageId);
    if (!msg) {
      // 尝试找临时消息
      const tempMsg = messages.find(m => m.id.startsWith('temp_') && m.content);
      if (!tempMsg) {
        toast.error('消息不存在');
        return;
      }
    }
    
    const msgToDelete = messagesRef.current.find(m => m.id === messageId);
    if (!msgToDelete) {
      toast.error('消息不存在');
      return;
    }
    
    if (socketRef.current && activeChat) {
      cfSocket.deleteMessage(messageId, activeChat.id, currentUser?.id || '', currentUser?.name || '对方', msgToDelete?.content || '');
    }
  };

  const handleRecallMessage = async (messageId: string) => {
    const msg = messagesRef.current.find(m => m.id === messageId);
    if (!msg) {
      const tempMsg = messagesRef.current.find(m => m.id.startsWith('temp_') && m.content === (messages.find(m => m.id === messageId)?.content || ''));
      if (!tempMsg) return;
    }
    
    const msgToRecall = msg || messagesRef.current.find(m => m.id.startsWith('temp_') && m.content === (messages.find(m => m.id === messageId)?.content || ''));
    if (!msgToRecall) return;
    
    if (socketRef.current && activeChat) {
      cfSocket.recallMessage(messageId, activeChat.id, currentUser?.id || '', currentUser?.name || '对方', msgToRecall?.content || '');
    }
  };

  const handleReplyMessage = (msg: Message) => {
    setReplyTo({
      id: msg.id,  // 使用消息ID而不是发送者ID
      name: msg.sender.name,
      content: msg.content
    });
  };

  const handleCancelReply = () => {
    setReplyTo(null);
  };

  const handleAddPendingFiles = (files: File[]) => {
    files.forEach(file => {
      if (file.size > MAX_FILE_SIZE) {
        addNotification('error', '文件过大', `文件 "${file.name}" 超过 ${MAX_FILE_SIZE} MB，无法上传`);
        return;
      }
    });
    // 调用 MessageInput 的方法添加文件
    const addFn = (window as any).__addPendingFiles;
    if (addFn) {
      addFn(files);
    }
  };

  const removeUpload = (id: string) => {
    const task = taskService?.getTask(id);
    if (task) {
      // 从消息气泡中移除对应的附件
      if (task.tempMessageId && task.type === 'upload') {
        setMessages(prev => prev.map(m => {
          if (m.id === task.tempMessageId && (m as any).attachments) {
            return { ...m, attachments: (m as any).attachments.filter((att: any) => att.name !== task.filename) };
          }
          return m;
        }));
        messagesRef.current = messagesRef.current.map(m => {
          if (m.id === task.tempMessageId && (m as any).attachments) {
            return { ...m, attachments: (m as any).attachments.filter((att: any) => att.name !== task.filename) };
          }
          return m;
        });
      }
    }
    // 从全局状态移除
    removeGlobalUpload(id);
    taskService?.removeTask(id);
  };

  const cancelUpload = (id: string) => {
    
    const task = taskService?.getTask(id);
    if (task) {
      // 从消息气泡中移除对应的附件
      if (task.tempMessageId && task.type === 'upload') {
        setMessages(prev => prev.map(m => {
          if (m.id === task.tempMessageId && (m as any).attachments) {
            return { ...m, attachments: (m as any).attachments.filter((att: any) => att.name !== task.filename) };
          }
          return m;
        }));
        messagesRef.current = messagesRef.current.map(m => {
          if (m.id === task.tempMessageId && (m as any).attachments) {
            return { ...m, attachments: (m as any).attachments.filter((att: any) => att.name !== task.filename) };
          }
          return m;
        });
      }
      taskService?.removeTask(id);
    }
    // 取消全局任务（包括 DrivePanel 的任务）- 这会真正停止 XHR/fetch
    updateGlobalUploadStatus(id, 'cancelled');
  };

  const cancelAllUploads = () => {
    
    // 从所有相关消息气泡中移除附件
    const allTasks = taskService?.getAllTasks() || [];
    
    allTasks.forEach(task => {
      if (task.tempMessageId && task.type === 'upload') {
        setMessages(prev => prev.map(m => {
          if (m.id === task.tempMessageId && (m as any).attachments) {
            return { ...m, attachments: (m as any).attachments.filter((att: any) => att.name !== task.filename) };
          }
          return m;
        }));
        messagesRef.current = messagesRef.current.map(m => {
          if (m.id === task.tempMessageId && (m as any).attachments) {
            return { ...m, attachments: (m as any).attachments.filter((att: any) => att.name !== task.filename) };
          }
          return m;
        });
      }
    });
    taskService?.cancelAll();
    // 取消全局上传任务（包括 DrivePanel 的任务）
    const globalTasks = getGlobalUploads();
    
    globalTasks.forEach(task => {
      if (task.status === 'uploading' || task.status === 'pending') {
        // 标记为已取消
        updateGlobalUploadStatus(task.id, 'cancelled');
      }
    });
    
  };

  const retryUpload = (id: string) => {
    taskService?.retryTask(id);
  };

  const handleUpdateGroupAnnouncement = async (announcement: string) => {
    const token = localStorage.getItem('token');
    if (!token || !activeChat) return;

    try {
      await apiFetch(API.groups.announcement(activeChat.id), {
        method: 'PUT',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ announcement })
      });
      setGroupInfo({ ...groupInfo, announcement });
    } catch (error) {
      console.error('Failed to update announcement:', error);
    }
  };

  // 初始加载时显示空白，避免闪现
  if (isInitializing) {
    return <div style={{ width: '100vw', height: '100vh' }}></div>;
  }

  // 分享链接访问优先
  if (isSharedView) {
    return <SharedViewPage />;
  }

  // 管理员入口（独立页面，不显示聊天界面）
  if (!currentUser && (showAdmin || adminToken || window.location.pathname === '/admin')) {
    if (adminToken) {
      return <AdminPanel token={adminToken} isSuperAdmin={!!adminToken} onLogout={() => { setAdminToken(null); localStorage.removeItem('adminToken'); }} />;
    }
    if (showAdmin || window.location.pathname === '/admin') {
      return (
        <>
          <BackgroundAnimation />
          <AdminLogin 
            onLogin={async (token) => { 
              setAdminToken(token); 
              setShowAdmin(false); 
              await refreshCsrfToken();
            }} 
            onBack={() => { 
              setShowAdmin(false); 
              if (window.location.pathname === '/admin') {
                window.location.href = '/';
              }
            }} 
          />
        </>
      );
    }
  }

  if (!currentUser) {
    return (
      <>
        <BackgroundAnimation />
        <div style={{ 
          width: '100%', 
          height: '100vh', 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center',
          position: 'relative',
          zIndex: 1
        }}>
          <Login onLogin={handleLogin} />
        </div>
      </>
    );
  }

  return (
    <div className="chat-container">
      {/* 登出 Loading */}
      {isLoggingOut && (
        <div className="logout-loading">
          <div className="logout-loading-spinner"></div>
          <span>正在退出...</span>
        </div>
      )}
      {/* 左侧导航栏 */}
      <div className="nav-sidebar">
        <div 
          className="nav-logo-wrapper"
          onClick={() => setShowProfilePopup(!showProfilePopup)}
          onMouseEnter={() => setShowProfilePopup(true)}
        >
          <div className="nav-logo" style={{ cursor: 'pointer' }}>
            {currentUser?.avatar ? (
              <img src={getAvatarUrl(currentUser.avatar)} alt="" style={{ width: '100%', height: '100%', borderRadius: '20%', objectFit: 'cover' }} />
            ) : (
              currentUser?.name?.charAt(0) || 'U'
            )}
          </div>
          {showProfilePopup && currentUser && (
            <div className="profile-popup" onClick={(e) => e.stopPropagation()}>
              <div className="profile-popup-avatar">
                {currentUser.avatar ? (
                  <img src={getAvatarUrl(currentUser.avatar)} alt="" style={{ width: '100%', height: '100%', borderRadius: '20%', objectFit: 'cover' }} />
                ) : (
                  currentUser.name?.charAt(0) || 'U'
                )}
              </div>
              <div className="profile-popup-info">
                <div className="profile-popup-name">{currentUser.name}</div>
                <div className="profile-popup-username">@{currentUser.username}</div>
                {(currentUser as any).signature && (
                  <div className="profile-popup-signature">"{ (currentUser as any).signature }"</div>
                )}
                <div className="profile-popup-status">在线</div>
              </div>
              <div className="profile-popup-actions">
                <button onClick={() => { 
                  setShowProfilePopup(false); 
                  setActivePanel('settings');
                }}>查看详情</button>
              </div>
            </div>
          )}
        </div>
        
        <div className="nav-items">
          <div className={`nav-item-wrapper ${activePanel === 'chat' ? 'active' : ''}`}>
            <button 
              className="nav-item"
              onClick={() => setActivePanel('chat')}
              title="消息"
            >
              <MessageCircle size={22} />
              {conversations.reduce((sum, c) => sum + (c.unread || 0), 0) > 0 && (
                <span className="nav-badge">
                  {conversations.reduce((sum, c) => sum + (c.unread || 0), 0)}
                </span>
              )}
            </button>
          </div>
          <div className={`nav-item-wrapper ${activePanel === 'drive' ? 'active' : ''}`}>
            <button 
              className="nav-item"
              onClick={() => setActivePanel('drive')}
              title="网盘"
            >
              <HardDrive size={22} />
            </button>
          </div>
          <div className={`nav-item-wrapper ${activePanel === 'stats' ? 'active' : ''}`}>
            <button 
              className="nav-item"
              onClick={() => setActivePanel('stats')}
              title="统计"
            >
              <BarChart3 size={22} />
            </button>
          </div>
          {currentUser?.role === 'admin' && (
            <div className={`nav-item-wrapper ${activePanel === 'admin' ? 'active' : ''}`}>
              <button 
                className="nav-item"
                onClick={() => setActivePanel('admin')}
                title={`管理后台 (role: ${currentUser.role})`}
                style={{ color: '#f59e0b' }}
              >
                <Shield size={22} />
              </button>
            </div>
          )}
          <div className="nav-item-wrapper">
            <button 
              className="nav-item"
              onClick={() => setShowKeyModal(true)}
              title="加密密钥"
            >
              <KeyRound size={22} />
            </button>
          </div>
          <div className="nav-item-wrapper" style={{ position: 'relative' }}>
            <button 
              className="nav-item"
              onClick={() => setShowNotificationPanel(true)}
              title="通知"
            >
              <Bell size={22} />
              {notificationUnreadCount > 0 && (
                <span style={{
                  position: 'absolute',
                  top: 2,
                  right: 2,
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: '#ff4d4f'
                }} />
              )}
            </button>
          </div>
          <div className={`nav-item-wrapper ${activePanel === 'settings' ? 'active' : ''}`}>
            <button 
              className="nav-item"
              onClick={() => setActivePanel('settings')}
              title="设置"
            >
              <Settings size={22} />
            </button>
          </div>
        </div>

        <button className="nav-logout" onClick={handleLogout} title="退出">
          <LogOut size={22} />
        </button>
      </div>

	  
      {/* 分享链接访问页面 */}
      {activePanel === 'shared' && (
        <SharedViewPage />
      )}

      {/* 聊天页面 */}
      {activePanel === 'chat' && (
        <>
          <div className="sidebar">
            <div className="sidebar-header">
              <div className="search-box">
                <input 
                  type="text" 
                  placeholder="搜索..." 
                  value={searchKeyword}
                  onChange={(e) => setSearchKeyword(e.target.value)}
                />
              </div>
              <HeaderMenu 
                onAddSuccess={fetchConversations}
                addNotification={addNotification}
                currentUser={currentUser}
                getAvatarUrl={getAvatarUrl}
                conversations={conversations}
              />
            </div>

            <UserList 
              onSelectUser={handleSelectChat} 
              activeUser={activeChat}
              conversations={conversations}
              onConversationsUpdate={setConversations}
              searchKeyword={searchKeyword}
              onTogglePin={handleTogglePin}
              onToggleMute={handleToggleMute}
              isLoading={isLoadingConversations}
            />
          </div>

          <div className="chat-area" style={{ 
            display: 'flex', 
            width: '100%', 
            overflow: 'hidden',
            '--scroll-btn-left': showAIAssistant ? 'calc(50% - 60px)' : '65%',
            '--scroll-btn-transform': showAIAssistant ? 'translateX(0)' : 'translateX(-50%)'
          } as any}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {activeChat ? (
              <>
                <ChatWindow 
                  messages={messages}
                  currentUser={currentUser}
                  activeChat={{
                    id: activeChat.id,
                    name: activeChat.name,
                    avatar: getAvatarUrl(activeChat.avatar) || '',
                    status: activeChat.status as any || 'online',
                    role: (activeChat as any).role
                  }}
                  chatType={activeChat.type}
                  groupInfo={groupInfo}
                  isGroupOwner={groupInfo?.ownerIds?.includes(currentUser?.id)}
                  uploads={uploads}
                  taskService={taskService}
                  onUpdateAnnouncement={handleUpdateGroupAnnouncement}
                  onDeleteMessage={handleDeleteMessage}
                  onReplyMessage={handleReplyMessage}
                  onRecallMessage={handleRecallMessage}
                  onAddPendingFiles={handleAddPendingFiles}
                  onDecryptError={(msg) => addNotification('error', '解密失败', msg)}
                  loadMoreMessages={loadMoreMessages}
                  hasMoreMessages={hasMoreMessages}
                  isLoadingMessages={isLoadingMessages}
                  onMessagesLoaded={() => {}}
                  onRefreshGroup={() => {
                    // 刷新会话列表
                    window.dispatchEvent(new CustomEvent('conversationsUpdate'));
                    // 如果是群聊，刷新群信息
                    if (activeChat.type === 'group') {
                      fetchGroupInfo(activeChat.id);
                    }
                  }}
                  typingUsers={typingUsers}
                  onUpdateMessage={(messageId, updates) => {
                    setMessages(prev => prev.map(m => m.id === messageId ? { ...m, ...updates } : m));
                    messagesRef.current = messagesRef.current.map(m => m.id === messageId ? { ...m, ...updates } : m);
                  }}
                  onRetry={handleRetryMessage}
                  onClearMessages={(deletedMessageIds?: string[]) => {
                    if (!deletedMessageIds || deletedMessageIds.length === 0) return;
                    // 从消息列表中移除被删除的消息
                    const deletedSet = new Set(deletedMessageIds);
                    setMessages(prev => prev.filter(m => !deletedSet.has(m.id)));
                    messagesRef.current = messagesRef.current.filter(m => !deletedSet.has(m.id));
                  }}
                  onVisibleMessagesRead={(messageIds) => {
                    if (messageIds.length === 0) return;
                    const token = localStorage.getItem('token');
                    if (!token) return;
                    
                    // 过滤出不是自己发送的消息
                    const unreadMessageIds = messageIds.filter(msgId => {
                      const msg = messages.find(m => m.id === msgId);
                      return msg && String(msg.sender?.id) !== String(currentUser?.id);
                    });
                    
                    if (unreadMessageIds.length > 0) {
                      // 发送已读回执
                      if (socketRef.current) {
                        socketRef.current.markRead(activeChat.id, unreadMessageIds);
                      }
                      
                      // 更新会话的未读数
                      setConversations(prev => prev.map(c => {
                        if (c.id === activeChat.id) {
                          return { ...c, unread: Math.max(0, (c.unread || 0) - unreadMessageIds.length) };
                        }
                        return c;
                      }));
                    }
                  }}
                />
                <MessageInput 
                  onSend={handleSendMessage} 
                  replyTo={replyTo}
                  onCancelReply={handleCancelReply}
                  chatType={activeChat.type}
                  groupMembers={groupInfo?.members?.map((m: any) => ({ id: m.id, name: m.name }))}
                  onAddPendingFiles={handleAddPendingFiles}
                  onUploadError={(message) => {
                    addNotification('error', '上传失败', message);
                  }}
                  showAIAssistant={showAIAssistant}
                  onToggleAIAssistant={() => setShowAIAssistant(!showAIAssistant)}
                  isMuted={isMuted}
                  muteReason={muteReason}
                />
              </>
            ) : (
              <div className="empty-chat">
                <div className="empty-chat-box">
                  <div className="empty-chat-icon">💬</div>
                  <h2>欢迎使用</h2>
                  <p>从左侧选择一个会话开始聊天</p>
                </div>
              </div>
            )}
            </div>
            
          </div>
        </>
      )}

      {/* 网盘页面 */}
	  {activePanel === 'drive' && (
	  	<DrivePanel />
	  )}
	  
      {/* 统计页面 */}
	  {activePanel === 'stats' && (
	  	<StatsPanel />
	  )}
      
	  {/* 管理后台页面 */}
	  {activePanel === 'admin' && currentUser?.role === 'admin' && (
	  	<AdminPanel token={adminToken || localStorage.getItem('token')} isSuperAdmin={!!adminToken} userToken={localStorage.getItem('token')} onLogout={() => setActivePanel('chat')} />
	  )}
      
      {/* 设置页面 */}
      {activePanel === 'settings' && (
        <SettingsPanel
          currentUser={currentUser}
          setCurrentUser={setCurrentUser}
          onLogout={handleLogout}
          addNotification={addNotification}
          getAvatarUrl={getAvatarUrl}
        />
      )}
      
      {/* AI 助手面板 - 显示在右侧 */}
      {showAIAssistant && (
        <div style={{
          width: '420px', 
          background: 'var(--chat)',
          borderLeft: '1px solid var(--border)',
          display: 'flex'
        }}>
          <AIAssistant onClose={() => setShowAIAssistant(false)} />
        </div>
      )}

      {/* 通知面板 */}
      {showNotificationPanel && (
        <NotificationPanel
          isOpen={showNotificationPanel}
          onClose={() => setShowNotificationPanel(false)}
          isAdmin={currentUser?.role === 'admin' || currentUser?.role === 'superadmin'}
          showToast={addNotification}
          onUnreadCountChange={setNotificationUnreadCount}
        />
      )}

      {/* Progress Float */}
      <ProgressFloat 
        uploads={uploads} 
        onRemove={removeUpload} 
        onRetry={retryUpload} 
        onCancelAll={cancelAllUploads}
        onClearAll={() => {
          // 取消所有任务并清空列表
          taskService?.cancelAll();
          setUploads([]);
        }}
        onClose={() => setShowProgressFloat(false)}
        useGlobalUploads={true}
      />

      {/* Toast Notifications */}
      <ToastContainer />

      {/* Confirm Dialog */}
      <ConfirmDialog
        open={confirmState.open}
        title={confirmState.title}
        message={confirmState.message}
        type={confirmState.type}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />

      {/* Input Dialog */}
      <InputDialog
        open={inputState.open}
        title={inputState.title}
        message={inputState.message}
        placeholder={inputState.placeholder}
        defaultValue={inputState.defaultValue}
        confirmText={inputState.confirmText}
        cancelText={inputState.cancelText}
        onConfirm={handleInputConfirm}
        onCancel={handleInputCancel}
      />

      {/* Key Modal */}
      <KeyModal
        isOpen={showKeyModal}
        onClose={() => setShowKeyModal(false)}
        encryptionKey={encryptionKey}
        legacyKeys={legacyKeys}
        onCopyKey={handleCopyKey}
        onChangeKey={handleKeyChange}
        onUseLegacyKey={handleUseLegacyKey}
        onDeleteLegacyKey={handleDeleteLegacyKey}
      />
    </div>
  );
};

export default App;
