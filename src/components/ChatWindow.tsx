import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Message, User } from '../types';
import { formatFileSize, truncateText, formatDate, getErrorMessage, isNetworkError, isTimeoutError, clamp } from '../utils/helpers';
import { CONFIG, API } from '../config/api';
import { loadKeysFromStorage, decrypt, tryDecrypt, decryptFileChunkedWithKeysYield } from '../utils/crypto';
import { cfSocket as socketClient } from '../utils/cfSocket';
import GroupAttachments from './GroupAttachments';
import { getAvatarUrl } from '../utils/tools';
import { TaskService } from '../utils/TaskService';
import { api } from '../services/api';
import { apiFetch } from '../utils/csrf';
import { File, Lock, ScrollText, Users, Paperclip, MoreHorizontal, Copy, MessageCircle, Globe, Link, Undo, Trash2, Loader2, Check, Square, X, Shield, Gem, Download, Crown, LogOut, Ban, UserPlus, UserMinus, BellRing, VolumeX, UserX, Star, AlertTriangle, Megaphone } from 'lucide-react';
import { formatTimestamp, convertServerTime } from '../utils/time';
import { toast } from '../utils/toast';
import { showConfirm } from './ConfirmDialog';
import { showInput } from './InputDialog';
import { ReportDialog } from './ReportDialog';

const FileIcon = File;

// Markdown 渲染组件
const MarkdownRenderer: React.FC<{ content: string; className?: string }> = ({ content, className = '' }) => (
  <div className={className}>
    <ReactMarkdown
      remarkPlugins={[]}
      components={{
        a: ({node, ...props}) => <a target="_blank" rel="noopener noreferrer" {...props} />,
        code: ({node, inline, className, children, ...props}) => {
          const codeContent = typeof children === 'string' ? children : children;
          return inline ? 
            <code className="markdown-inline-code" {...props}>{codeContent}</code> :
            <code className="markdown-code-block" {...props}>{codeContent}</code>;
        },
        img: ({node, ...props}) => <img {...props} alt={props.alt || ''} />,
        blockquote: ({node, children, ...props}) => <blockquote className="markdown-blockquote" {...props}>{children}</blockquote>,
        ul: ({node, children, ...props}) => <ul className="markdown-ul" {...props}>{children}</ul>,
        ol: ({node, children, ...props}) => <ol className="markdown-ol" {...props}>{children}</ol>,
        li: ({node, children, ...props}) => <li className="markdown-li" {...props}>{children}</li>,
        h1: ({node, children, ...props}) => <h1 className="markdown-h1" {...props}>{children}</h1>,
        h2: ({node, children, ...props}) => <h2 className="markdown-h2" {...props}>{children}</h2>,
        h3: ({node, children, ...props}) => <h3 className="markdown-h3" {...props}>{children}</h3>,
        p: ({node, children, ...props}) => <p {...props}>{children}</p>,
        br: ({node, ...props}) => <br {...props} />,
      }}
    >
      {content}
    </ReactMarkdown>
  </div>
);
const LockIcon = Lock;

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderMention(text: string): React.ReactNode {
  const parts = text.split(/(@\S+)/g);
  return parts.map((part, i) => {
    if (part.startsWith('@')) {
      return <span key={i} className="mention-text">{escapeHtml(part)}</span>;
    }
    return part;
  });
}

interface Attachment {
  id?: string;
  type: 'image' | 'file';
  name: string;
  size: number;
  url: string;
  encrypted?: boolean;
  uploading?: boolean;
  uploadProgress?: number;
  previewUrl?: string;
  decryptedUrl?: string;
  encryptedName?: string;
  downloading?: boolean;
  downloadProgress?: number;
}

interface ChatWindowProps {
  messages: Message[];
  currentUser: User;
  activeChat: User;
  chatType?: 'friend' | 'group';
  groupInfo?: {
    id?: string;
    name?: string;
    announcement?: string;
    members?: any[];
    memberCount?: number;
    ownerIds?: string[];
    requireApproval?: boolean;
  };
  isGroupOwner?: boolean;
  onUpdateAnnouncement?: (announcement: string) => void;
  onDeleteMessage?: (messageId: string) => void;
  onRecallMessage?: (messageId: string) => void;
  onReplyMessage?: (msg: Message) => void;
  onAddPendingFiles?: (files: File[]) => void;
  onDecryptError?: (message: string) => void;
  onUploadProgress?: (progress: { id: string; filename: string; progress: number; status: 'uploading' | 'completed' | 'error'; type: 'upload' | 'download' }) => void;
  uploads?: any[];
  taskService?: any;
  onUpdateMessage?: (messageId: string, updates: any) => void;
  loadMoreMessages?: () => void;
  hasMoreMessages?: boolean;
  isLoadingMessages?: boolean;
  onMessagesLoaded?: () => void;  // 消息加载完成回调
  onRefreshGroup?: () => void;  // 刷新群组信息
  cfSocket?: any;
  typingUsers?: { userId: string; userName: string; timeout: NodeJS.Timeout }[];
  onVisibleMessagesRead?: (messageIds: string[]) => void;  // 可见消息已读回调
  onRetry?: (messageId: string) => void;  // 重试发送消息
  onClearMessages?: (deletedMessageIds?: string[]) => void;  // 清空消息列表，传入要删除的消息ID
  onNewJoinRequest?: (groupId: string) => void;  // 收到新的入群申请通知
}

export const ChatWindow: React.FC<ChatWindowProps> = ({ 
  messages, 
  currentUser, 
  activeChat, 
  chatType = 'friend',
  groupInfo,
  isGroupOwner = false,
  onUpdateAnnouncement,
  onDeleteMessage,
  onRecallMessage,
  onReplyMessage,
  onAddPendingFiles,
  onDecryptError,
  onUploadProgress,
  uploads = [],
  taskService,
  onUpdateMessage,
  loadMoreMessages,
  hasMoreMessages = true,
  isLoadingMessages = false,
  onMessagesLoaded,
  onRefreshGroup,
  typingUsers = [],
  onVisibleMessagesRead,
  onRetry,
  onClearMessages,
  onNewJoinRequest
}) => {
  const [localTypingUsers, setLocalTypingUsers] = useState<{ userId: string; userName: string; timeout: NodeJS.Timeout }[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);  // 控制是否自动滚动
  const [showAnnouncement, setShowAnnouncement] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showMemberMenu, setShowMemberMenu] = useState<string | null>(null);
  const [editingAnnouncement, setEditingAnnouncement] = useState(false);
  const [announcementText, setAnnouncementText] = useState(groupInfo?.announcement || '');
  const [isLoadingGroupInfo, setIsLoadingGroupInfo] = useState(false);
  const [hoveredMessage, setHoveredMessage] = useState<string | null>(null);
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const [selectedMessages, setSelectedMessages] = useState<Set<string>>(new Set());
  const [previewImage, setPreviewImage] = useState<{url: string, messageId?: string, burnAfterReading?: boolean, encrypted?: boolean, decryptedUrl?: string, decryptedBlob?: Blob, senderId?: string, attachmentId?: string} | string | null>(null);
  const [encryptionKey, setEncryptionKey] = useState<string | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [showGroupAttachments, setShowGroupAttachments] = useState(false);
  const [decryptedImageUrls, setDecryptedImageUrls] = useState<{ [key: string]: string }>({});
  const [decryptedImageBlobs, setDecryptedImageBlobs] = useState<{ [key: string]: Blob }>({});
  const [decryptFailedImageUrls, setDecryptFailedImageUrls] = useState<Set<string>>(new Set());
  const [decryptFailedFileUrls, setDecryptFailedFileUrls] = useState<Set<string>>(new Set());
  const [showJoinRequests, setShowJoinRequests] = useState(false);
  const [joinRequests, setJoinRequests] = useState<any[]>([]);
  const [loadingJoinRequests, setLoadingJoinRequests] = useState(false);
  const [requireApproval, setRequireApproval] = useState(groupInfo?.requireApproval ?? true);
  const [reportingMessage, setReportingMessage] = useState<{ id: string; content: string; senderName: string } | null>(null);
  const [starredMessages, setStarredMessages] = useState<Set<string>>(new Set());

  const fetchStarredMessages = async () => {
    try {
      const res = await apiFetch(API.userContent.stars, { requireCsrf: false });
      const data = await res.json();
      if (data.success && data.data) {
        const starredIds: string[] = data.data.map((item: any) => item.messageId as string);
        setStarredMessages(new Set(starredIds));
      }
    } catch (e) {
      console.error('获取收藏消息失败:', e);
    }
  };

  useEffect(() => {
    fetchStarredMessages();
  }, []);

  useEffect(() => {
    if (groupInfo?.requireApproval !== undefined) {
      setRequireApproval(groupInfo.requireApproval);
    }
  }, [groupInfo?.requireApproval]);

  // 自动获取入群申请数据
  useEffect(() => {
    if ((groupInfo?.id || activeChat?.id) && isGroupOwner) {
      fetchJoinRequests();
    }
  }, [groupInfo?.id, activeChat?.id, isGroupOwner]);

  // 监听新的入群申请事件
  useEffect(() => {
    const handleNewJoinRequest = (event: CustomEvent) => {
      const { groupId } = event.detail;
      if (groupId === activeChat?.id || groupId === groupInfo?.id) {
        fetchJoinRequests();
      }
    };
    window.addEventListener('newJoinRequest', handleNewJoinRequest as EventListener);
    return () => {
      window.removeEventListener('newJoinRequest', handleNewJoinRequest as EventListener);
    };
  }, [activeChat?.id, groupInfo?.id]);

  // sessionStorage 键名前缀
  const DECRYPTED_IMG_PREFIX = 'decrypted_img_';
  const DECRYPTED_BLOB_PREFIX = 'decrypted_blob_';

  // 从 sessionStorage 加载已解密的图片
  const loadDecryptedImagesFromStorage = () => {
    try {
      const stored: { [key: string]: string } = {};
      const blobStored: { [key: string]: Blob } = {};
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key?.startsWith(DECRYPTED_IMG_PREFIX)) {
          const url = key.replace(DECRYPTED_IMG_PREFIX, '');
          const base64 = sessionStorage.getItem(key);
          if (base64) {
            const byteCharacters = atob(base64);
            const byteNumbers = new Array(byteCharacters.length);
            for (let j = 0; j < byteCharacters.length; j++) {
              byteNumbers[j] = byteCharacters.charCodeAt(j);
            }
            const byteArray = new Uint8Array(byteNumbers);
            const blob = new Blob([byteArray]);
            const objectUrl = URL.createObjectURL(blob);
            stored[url] = objectUrl;
            blobStored[url] = blob;
          }
        }
      }
      if (Object.keys(stored).length > 0) {
        setDecryptedImageUrls(stored);
        setDecryptedImageBlobs(blobStored);
        // 更新 ref
        Object.keys(stored).forEach(url => decryptedUrlsRef.current.add(url));
      }
    } catch (e) {
      console.error('Failed to load decrypted images from storage:', e);
    }
  };

  // 保存解密后的图片到 sessionStorage
  const saveDecryptedImageToStorage = (url: string, blob: Blob) => {
    try {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = (reader.result as string).split(',')[1];
        sessionStorage.setItem(DECRYPTED_IMG_PREFIX + url, base64);
      };
      reader.readAsDataURL(blob);
    } catch (e) {
      console.error('Failed to save decrypted image to storage:', e);
    }
  };

  // 初始化时加载已保存的解密图片
  useEffect(() => {
    loadDecryptedImagesFromStorage();
  }, [activeChat?.id]);
  const [showAddMemberModal, setShowAddMemberModal] = useState(false);
  const [allUsers, setAllUsers] = useState<any[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);  // 用于强制刷新
  const [translatingMsgId, setTranslatingMsgId] = useState<string | null>(null);
  const [messagesLoaded, setMessagesLoaded] = useState(false);  // 消息是否加载完成
  const messagesLoadedRef = useRef(false);  // 用于在解密函数中检测
  const decryptedUrlsRef = useRef<Set<string>>(new Set());  // 追踪已解密URL，避免重复解密
  const decryptedFailedRef = useRef<Set<string>>(new Set());  // 追踪解密失败URL
  const [translatedMessages, setTranslatedMessages] = useState<Record<string, string>>({});
  
  // 跟踪可视区域内的消息ID
  const visibleMessageIds = useRef<Set<string>>(new Set());

  // 缓存密钥，避免重复调用
  const cachedKeysRef = useRef<ReturnType<typeof loadKeysFromStorage> | null>(null);
  const getCachedKeys = () => {
    if (!cachedKeysRef.current) {
      cachedKeysRef.current = loadKeysFromStorage();
    }
    return cachedKeysRef.current;
  };
  const clearCachedKeys = () => {
    cachedKeysRef.current = null;
  };

  const scrollToBottom = (smooth = true, force = false) => {
    if (force || autoScrollRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: smooth ? "smooth" : "auto" });
    }
  };
  
  // 检查是否在底部附近
  const checkAtBottom = (threshold = 150) => {
    const container = messagesEndRef.current?.parentElement;
    if (!container) return true;
    return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
  };
  
  // 首次加载消息时滚动到底部
  const [initialScrollDone, setInitialScrollDone] = useState(false);
  const prevMessagesLengthRef = useRef(0);
  const lastMessageIdRef = useRef<string | null>(null);
  
  useEffect(() => {
    const currentLastMsgId = messages[messages.length - 1]?.id;
    
    // 首次加载消息
    if (!initialScrollDone && messages.length > 0) {
      scrollToBottom(true, true);
      setInitialScrollDone(true);
      lastMessageIdRef.current = currentLastMsgId || null;
      
      // 强制更新可见消息列表
      setTimeout(() => {
        handleScroll();
      }, 100);
    }
    // 新消息到来时（消息数增加 + 在底部附近 + 最后消息ID变化）
    else if (initialScrollDone && messages.length > prevMessagesLengthRef.current) {
      if (currentLastMsgId && currentLastMsgId !== lastMessageIdRef.current && checkAtBottom()) {
        scrollToBottom(true, true);
      }
      // 无论是否滚动，都更新可见消息列表
      handleScroll();
      lastMessageIdRef.current = currentLastMsgId || null;
    }
    prevMessagesLengthRef.current = messages.length;
  }, [messages]);
  
  // 切换会话时重置初始滚动标记
  useEffect(() => {
    setInitialScrollDone(false);
    prevMessagesLengthRef.current = 0;
    lastMessageIdRef.current = null;
  }, [activeChat?.id]);

  useEffect(() => {
    setAnnouncementText(groupInfo?.announcement || '');
    if (groupInfo) {
      setIsLoadingGroupInfo(false);
    }
  }, [groupInfo]);

  // 监听消息加载状态，当加载完成时触发解密
  useEffect(() => {
    if (!isLoadingMessages && messages.length > 0) {
      messagesLoadedRef.current = true;
      setMessagesLoaded(true);
      // 消息加载完成后触发解密
      setTimeout(() => decryptVisibleImages(), 100);
      if (onMessagesLoaded) {
        onMessagesLoaded();
      }
    }
  }, [isLoadingMessages]);

  useEffect(() => {
    if ((showAnnouncement || showMembers) && !groupInfo) {
      setIsLoadingGroupInfo(true);
    }
  }, [showAnnouncement, showMembers, groupInfo]);

  // 监听可见消息变化，发送已读回执
  const prevVisibleIdsRef = useRef<Set<string>>(new Set());
  const [visibleVersion, setVisibleVersion] = useState(0);
  
  useEffect(() => {
    if (!onVisibleMessagesRead) return;
    
    const currentVisibleIds = visibleMessageIds.current;
    const prevIds = prevVisibleIdsRef.current;
    
    // 找出新增的可见消息ID
    const newVisibleIds: string[] = [];
    currentVisibleIds.forEach(id => {
      if (!prevIds.has(id)) {
        newVisibleIds.push(id);
      }
    });
    
    if (newVisibleIds.length > 0) {
      onVisibleMessagesRead(newVisibleIds);
    }
    
    prevVisibleIdsRef.current = currentVisibleIds;
  }, [visibleVersion, onVisibleMessagesRead]);

  // 同步 typingUsers 从 props 到本地状态
  useEffect(() => {
    setLocalTypingUsers(typingUsers);
  }, [typingUsers]);

  // 初始化和监听密钥变化
  useEffect(() => {
    // 初始化密钥状态
    const keys = loadKeysFromStorage();
    if (keys?.currentKey) {
      setEncryptionKey(keys.currentKey);
    }
    
    // 监听 localStorage 变化（密钥更新时）
    const handleStorageChange = () => {
      clearCachedKeys();
      const newKeys = loadKeysFromStorage();
      if (newKeys?.currentKey) {
        setEncryptionKey(newKeys.currentKey);
        // 清除解密失败状态，触发重新解密
        setDecryptFailedImageUrls(new Set());
        setDecryptFailedFileUrls(new Set());
        decryptedFailedRef.current.clear();
        decryptedUrlsRef.current.clear();
        setRefreshKey(prev => prev + 1);
      }
    };
    
    // 监听自定义密钥更新事件
    const handleKeyUpdate = () => {
      clearCachedKeys();
      const newKeys = loadKeysFromStorage();
      if (newKeys?.currentKey) {
        setEncryptionKey(newKeys.currentKey);
        // 清除解密失败状态，触发重新解密
        setDecryptFailedImageUrls(new Set());
        setDecryptFailedFileUrls(new Set());
        decryptedFailedRef.current.clear();
        decryptedUrlsRef.current.clear();
        // 强制重新渲染以重新解密
        setRefreshKey(prev => prev + 1);
      }
    };
    
    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('encryptionKeyUpdated', handleKeyUpdate);
    
    // 定期检查密钥变化（同一标签页内）
    const intervalId = setInterval(() => {
      clearCachedKeys();
      const keys = getCachedKeys();
      if (keys?.currentKey) {
        setEncryptionKey(prev => prev !== keys.currentKey ? keys.currentKey : prev);
      }
    }, 3000);
    
    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('encryptionKeyUpdated', handleKeyUpdate);
      clearInterval(intervalId);
    };
  }, []);

  // 监听阅后即焚事件（来自 TaskService 下载完成）
  useEffect(() => {
    const handleBurnAfterReadEvent = (e: Event) => {
      const customEvent = e as CustomEvent;
      const { messageId, fileUrl } = customEvent.detail;
      handleBurnAfterRead(messageId, fileUrl);
    };
    
    window.addEventListener('burnAfterRead', handleBurnAfterReadEvent);
    return () => {
      window.removeEventListener('burnAfterRead', handleBurnAfterReadEvent);
    };
  }, []);

  // 解密可见区域的图片（直接在滚动时解密，不依赖 useEffect）
  const decryptVisibleImages = () => {
    const keys = getCachedKeys();
    if (!keys?.currentKey) return;
    
    const container = messagesContainerRef.current;
    if (!container) return;
    
    // 收集需要解密的所有图片
    const imageTasks: { att: any; url: string }[] = [];
    const containerRect = container.getBoundingClientRect();
    
    for (const msg of messages) {
      const attachments = (msg as any).attachments;
      if (!attachments || attachments.length === 0) continue;
      
      // 检查消息是否在可见区域
      const msgEl = document.getElementById(`msg-${msg.id}`);
      if (!msgEl) continue;
      
      const msgRect = msgEl.getBoundingClientRect();
      const isVisible = msgRect.top < containerRect.bottom + 100 && msgRect.bottom > containerRect.top - 100;
      
      if (!isVisible) continue;
      
      for (const att of attachments) {
        if (decryptedUrlsRef.current.has(att.url) || decryptedFailedRef.current.has(att.url)) continue;
        if (att.decryptFailed) {
          decryptedFailedRef.current.add(att.url);
          setDecryptFailedFileUrls(prev => new Set([...prev, att.url]));
          continue;
        }
        if (att.type === 'image' && att.encrypted) {
          // 检查文件名是否是加密格式
          const isEncryptedName = att.name && (att.name.startsWith('U2FsdGVkX') || att.name.startsWith('Salted__'));
          if (isEncryptedName) {
            if (!keys) {
              // 加密文件名但无密钥，标记失败
              decryptedFailedRef.current.add(att.url);
              setDecryptFailedImageUrls(prev => new Set([...prev, att.url]));
              continue;
            }
            
            // 有密钥，检查是否能解密
            const nameResult = tryDecrypt(att.name);
            
            if (!nameResult.decrypted) {
              // 文件名解密失败，标记为解密失败
              decryptedFailedRef.current.add(att.url);
              setDecryptFailedImageUrls(prev => new Set([...prev, att.url]));
              continue;
            }
          }
          // 文件名是明文或解密成功 -> 继续下载和解密文件内容
          const fullUrl = att.url.startsWith('http') ? att.url : API.files.get(att.url);
          imageTasks.push({ att, url: fullUrl });
        } else if (att.encrypted && att.type !== 'image') {
          // 检查文件附件的文件名
          const isEncryptedName = att.name && (att.name.startsWith('U2FsdGVkX') || att.name.startsWith('Salted__'));
          if (isEncryptedName) {
            if (!keys?.currentKey) {
              // 加密文件名但无密钥，标记失败
              decryptedFailedRef.current.add(att.url);
              setDecryptFailedFileUrls(prev => new Set([...prev, att.url]));
              continue;
            }
            // 有密钥，检查是否能解密
            const nameResult = tryDecrypt(att.name);
            if (!nameResult.decrypted) {
              // 文件名解密失败，标记为解密失败
              decryptedFailedRef.current.add(att.url);
              setDecryptFailedFileUrls(prev => new Set([...prev, att.url]));
              continue;
            }
          }
        }
      }
    }
    
    if (imageTasks.length === 0) return;
    
    const token = localStorage.getItem('token');
    const newDecryptedUrls: { [key: string]: string } = {};
    const newBlobs: { [key: string]: Blob } = {};
    const newFailedUrls: Set<string> = new Set();
    
    // 并行解密（限制并发数为3）
    const batchSize = 3;
    for (let i = 0; i < imageTasks.length; i += batchSize) {
      const batch = imageTasks.slice(i, i + batchSize);
      Promise.allSettled(
        batch.map(async ({ att, url }) => {
          const response = await fetch(url, {
            headers: token ? { 'Authorization': `Bearer ${token}` } : {}
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const blob = await response.blob();
          const result = await decryptFileChunkedWithKeysYield(blob, keys);
          return { att, blob: result.blob, url: att.url };
        })
      ).then(results => {
        results.forEach((r, idx) => {
          if (r.status === 'fulfilled') {
            const { att, blob, url } = r.value;
            const objectUrl = URL.createObjectURL(blob);
            newDecryptedUrls[url] = objectUrl;
            newBlobs[url] = blob;
            decryptedUrlsRef.current.add(url);
            // 保存到 sessionStorage
            saveDecryptedImageToStorage(url, blob);
          } else {
            newFailedUrls.add(batch[idx].att.url);
            decryptedFailedRef.current.add(batch[idx].att.url);
          }
        });
        
        if (Object.keys(newDecryptedUrls).length > 0) {
          setDecryptedImageUrls(prev => ({ ...prev, ...newDecryptedUrls }));
          setDecryptedImageBlobs(prev => ({ ...prev, ...newBlobs }));
        }
        if (newFailedUrls.size > 0) {
          setDecryptFailedImageUrls(prev => new Set([...prev, ...newFailedUrls]));
        }
      });
    }
  };

  // 监听typing事件
  useEffect(() => {
    const socket = socketClient;
    if (!socket) return;

    const handleTyping = (data: { userId: string; userName: string; sessionId: string }) => {
      if (data.sessionId !== activeChat?.id) return;
      if (data.userId === currentUser?.id) return;

      setLocalTypingUsers(prev => {
        const existing = prev.find(u => u.userId === data.userId);
        if (existing) {
          clearTimeout(existing.timeout);
        }
        
        const timeout = setTimeout(() => {
          setLocalTypingUsers(prev => prev.filter(u => u.userId !== data.userId));
        }, 3000);

        if (existing) {
          return prev.map(u => u.userId === data.userId ? { ...u, timeout } : u);
        }
        
        return [...prev, { userId: data.userId, userName: data.userName, timeout }];
      });
    };

    socket.on('typing', handleTyping);

    return () => {
      socket.off('typing', handleTyping);
    };
  }, [activeChat?.id, currentUser?.id]);

  const handleScroll = () => {
    const container = messagesContainerRef.current;
    if (container) {
      const atBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 50;
      setIsAtBottom(atBottom);
      setShowScrollToBottom(!atBottom);
      autoScrollRef.current = atBottom;
      
      // 更新可视区域内的消息ID
      const scrollTop = container.scrollTop;
      const clientHeight = container.clientHeight;
      const newVisibleIds: Set<string> = new Set();
      
      // 找出可视区域内的消息
      const msgElements = container.querySelectorAll('.message-row');
      msgElements.forEach((el) => {
        const rect = el.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        if (rect.top >= containerRect.top - 200 && rect.top <= containerRect.bottom + 200) {
          const msgId = el.id.replace('msg-', '');
          if (msgId) {
            newVisibleIds.add(msgId);
          }
        }
      });
      
      // 检查是否有新的可见消息需要标记已读
      const newVisibleArray = Array.from(newVisibleIds);
      visibleMessageIds.current = newVisibleIds;
      setVisibleVersion(prev => prev + 1);  // 触发 useEffect
      
      // 滚动时解密可见区域的图片
      decryptVisibleImages();
      
      if (container.scrollTop < 100 && hasMoreMessages && !isLoadingMessages && loadMoreMessages) {
        loadMoreMessages();
      }
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0 && onAddPendingFiles) {
      onAddPendingFiles(files);
    }
  };

  const formatTime = (timestamp: any) => {
    return formatTimestamp(timestamp, 'time');
  };

  const formatDate = (dateStr: any) => {
    if (typeof dateStr !== 'string') return '';
    // dateKey 格式是 "2026-3-29" 或 "2026-03-29"
    const parts = dateStr.split('-').map(Number);
    if (parts.length < 3) return '';
    const year = parts[0];
    const month = parts[1];
    const day = parts[2];
    // 使用日期字符串创建日期，避免月份溢出问题
    const date = new Date(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toDateString() === today.toDateString()) return '今天';
    if (date.toDateString() === yesterday.toDateString()) return '昨天';
    return `${month}月${day}日`;
  };

  const groupedMessages: { [key: string]: Message[] } = {};
  messages.forEach(msg => {
    // msg.timestamp 已经是 convertServerTime 处理过的 Date 对象，不需要再次偏移
    const date = msg.timestamp instanceof Date ? msg.timestamp : new Date(msg.timestamp);
    const dateKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    if (!groupedMessages[dateKey]) {
      groupedMessages[dateKey] = [];
    }
    groupedMessages[dateKey].push(msg);
  });

  const handleSaveAnnouncement = async () => {
    if (onUpdateAnnouncement) {
      onUpdateAnnouncement(announcementText);
    } else {
      try {
        const res = await apiFetch(API.groups.announcement(activeChat.id), {
          method: 'PUT',
          body: JSON.stringify({ announcement: announcementText })
        });
        const data = await res.json();
        if (data.success) {
          setEditingAnnouncement(false);
        } else {
          toast.error('保存失败', data.message);
        }
      } catch (error) {
        console.error('保存公告失败:', error);
        toast.error('保存失败', '请重试');
      }
    }
    setEditingAnnouncement(false);
  };

  const handleCopy = (content: string) => {
    navigator.clipboard.writeText(content);
    setHoveredMessage(null);
  };

  const isChinese = (text: string): boolean => {
    const chineseRegex = /[\u4e00-\u9fa5]/;
    return chineseRegex.test(text);
  };

  const handleTranslate = async (msgId: string, content: string) => {
    setHoveredMessage(null);
    if (translatedMessages[msgId]) {
      setTranslatedMessages(prev => {
        const updated = { ...prev };
        delete updated[msgId];
        return updated;
      });
      return;
    }
    
    setTranslatingMsgId(msgId);
    try {
      const targetLang = isChinese(content) ? 'en' : 'zh-CN';
      const response = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(content)}`);
      if (!response.ok) throw new Error('Translation service unavailable');
      const data = await response.json();
      if (data && data[0]) {
        const translatedText = data[0].map((item: any) => item[0]).join('');
        setTranslatedMessages(prev => ({ ...prev, [msgId]: translatedText }));
      }
    } catch (e) {
      console.error('Translation failed:', e);
      toast.error('翻译服务暂时不可用');
    }
    setTranslatingMsgId(null);
  };

  const handleReply = (msg: Message) => {
    setHoveredMessage(null);
    if (onReplyMessage) {
      onReplyMessage(msg);
    }
  };

  const handleRecall = async (msgId: string) => {
    setHoveredMessage(null);
    if (await showConfirm({ title: '确认', message: '确定要撤回这条消息吗？', type: 'warning' })) {
    	
      if (onRecallMessage) {
        onRecallMessage(msgId);
        
      }
    }
  };

  const handleDelete = async (msgId: string) => {
    if (await showConfirm({ title: '确认', message: '确定要删除这条消息吗？', type: 'danger' })) {
      if (onDeleteMessage) {
        onDeleteMessage(msgId);
      }
    }
    setHoveredMessage(null);
  };

  const handleToggleStar = async (msgId: string, content: string, senderName: string) => {
    setHoveredMessage(null);
    const isStarred = starredMessages.has(msgId);
    
    try {
      if (isStarred) {
        await apiFetch(API.messages.unstar(msgId), { method: 'DELETE' });
        setStarredMessages(prev => {
          const next = new Set(prev);
          next.delete(msgId);
          return next;
        });
        toast.success('已取消收藏');
      } else {
        await apiFetch(API.messages.star(msgId), { method: 'POST' });
        setStarredMessages(prev => new Set(prev).add(msgId));
        toast.success('已收藏');
      }
    } catch (error) {
      console.error('收藏操作失败:', error);
      toast.error('操作失败');
    }
  };

  const handleMultiSelect = (msgId: string) => {
    const newSelected = new Set(selectedMessages);
    if (newSelected.has(msgId)) {
      newSelected.delete(msgId);
    } else {
      newSelected.add(msgId);
    }
    setSelectedMessages(newSelected);
  };

  const handleBatchDelete = async () => {
    if (selectedMessages.size === 0) return;
    
    if (await showConfirm({ title: '确认', message: `确定要删除选中的 ${selectedMessages.size} 条消息吗？`, type: 'danger' })) {
      try {
        const response = await apiFetch(API.messages.batch, {
          method: 'DELETE',
          body: JSON.stringify({
            messageIds: Array.from(selectedMessages),
            sessionId: activeChat?.id
          })
        });
        
        const data = await response.json();
        if (data.success) {
          toast.success(`已删除 ${data.deleted} 条消息`);
          // 遍历选中的消息，使用 onUpdateMessage 更新
          selectedMessages.forEach(msgId => {
            if (onUpdateMessage) {
              onUpdateMessage(msgId, { 
                content: '你删除了这条消息', 
                isSystem: 1,
                recalled: 1,
                sender: { id: 'system', name: '系统' }
              });
            }
          });
        } else {
          toast.error(data.message || '删除失败');
        }
      } catch (error) {
        console.error('批量删除错误:', error);
        toast.error('删除失败');
      }
    }
    setIsMultiSelectMode(false);
    setSelectedMessages(new Set());
  };

  const cancelMultiSelect = () => {
    setIsMultiSelectMode(false);
    setSelectedMessages(new Set());
  };

  const handleDownload = (url: string, filename: string, messageId?: string, isBurn?: boolean, isEncrypted?: boolean, senderId?: string, originalSize?: number, attachmentId?: string) => {
    const isSelf = senderId === currentUser?.id;
    
    // 如果是blob URL（已解密），直接下载不需要服务器请求和解密
    if (url.startsWith('blob:')) {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      
      if (isBurn && messageId && !isSelf) {
        handleBurnAfterRead(messageId, url);
      }
      return;
    }
    
    // 使用 TaskService 添加下载任务
    if (!taskService) {
      console.error('TaskService 未初始化');
      return;
    }
    taskService.addDownloadTask({
      filename,
      url,
      totalSize: originalSize,
      tempMessageId: messageId,
      attachmentId,
      isEncrypted,
      senderId,
      originalSize,
      isBurn,
      skipSizeCheck: true,
      customEndpoint: '/api/files'
    });
  };

  const handleCopyFileLink = (url: string) => {
    const fullUrl = url.startsWith('http') ? url : API.files.get(url);
    navigator.clipboard.writeText(fullUrl).then(() => {
      toast.success('文件链接已复制到剪贴板');
    }).catch(() => {
      toast.error('复制失败');
    });
  };

  // 阅后即焚 - 查看后自动删除
  const handleBurnAfterRead = async (messageId: string, fileUrl: string) => {
    try {
      await apiFetch(API.uploadDelete, {
        method: 'POST',
        body: JSON.stringify({ url: fileUrl, messageId, sessionId: activeChat?.id })
      });
      if (onDeleteMessage) {
        onDeleteMessage(messageId);
      }
    } catch (error) {
      console.error('Burn after read error:', error);
    }
  };

  const handleQuitGroup = async () => {
    try {
      const res = await apiFetch(`${API.groups.members(activeChat.id)}/${currentUser.id}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (data.success) {
        toast.success('已退出群聊');
        // 通知父组件刷新会话列表
        onRefreshGroup?.();
      } else {
        toast.error('退出失败', data.message);
      }
    } catch (error) {
      console.error('退出群组失败:', error);
      toast.error('退出失败', '请重试');
    }
  };

  const handleRemoveMember = async (memberId: string, memberName: string) => {
    if (await showConfirm({ title: '确认', message: `确定要将 ${memberName} 移出群聊吗？`, type: 'danger' })) {
      try {
        const res = await apiFetch(`${API.groups.members(activeChat.id)}/${memberId}`, {
          method: 'DELETE'
        });
        const data = await res.json();
        if (data.success) {
          toast.success('已移出群聊');
          onRefreshGroup?.();
        } else {
          toast.error('操作失败', data.message);
        }
      } catch (error) {
        console.error('移出成员失败:', error);
        toast.error('操作失败', '请重试');
      }
    }
  };

  const [mutedMembers, setMutedMembers] = useState<Set<string>>(new Set());

  const fetchMutedMembers = async () => {
    if (chatType !== 'group' || !activeChat?.id) return;
    try {
      const res = await apiFetch(API.groups.mutes(activeChat.id), { requireCsrf: false });
      const data = await res.json();
      if (data.success) {
        const mutedIds = new Set<string>(data.data.map((m: any) => m.userId));
        setMutedMembers(mutedIds);
      }
    } catch (e) { console.error('获取禁言列表失败', e); }
  };

  useEffect(() => { if (chatType === 'group' && showMembers) fetchMutedMembers(); }, [chatType, showMembers, activeChat?.id]);

  const handleMuteMember = async (memberId: string, memberName: string) => {
    const reason = await showInput({
      title: '禁言成员',
      message: `请输入禁言 ${memberName} 的原因（可选）:`,
      placeholder: '禁言原因（可选）',
      confirmText: '禁言',
      cancelText: '取消'
    });
    if (reason === null) return;
    try {
      const res = await apiFetch(API.groups.mutes(activeChat.id), {
        method: 'POST',
        body: JSON.stringify({ userId: memberId, reason: reason || undefined })
      });
      const data = await res.json();
      if (data.success) {
        toast.success(`已禁言 ${memberName}`);
        // 先更新本地状态
        setMutedMembers(prev => new Set(prev).add(memberId));
        fetchMutedMembers();
      } else {
        toast.error('操作失败', data.message);
      }
    } catch (e) { 
      const errorMessage = getErrorMessage(e);
      const title = isNetworkError(e) ? '网络错误' : isTimeoutError(e) ? '请求超时' : '操作失败';
      toast.error(title, errorMessage);
    }
  };

  const handleUnmuteMember = async (memberId: string, memberName: string) => {
    if (!(await showConfirm({ title: '确认', message: `确定要解除 ${memberName} 的禁言吗？`, type: 'info' }))) return;
    try {
      // 找到禁言记录的ID
      const res = await apiFetch(API.groups.mutes(activeChat.id), { requireCsrf: false });
      const data = await res.json();
      if (data.success && data.data) {
        const muteRecord = data.data.find((m: any) => m.userId === memberId);
        if (muteRecord) {
          const deleteRes = await apiFetch(API.groups.muteRecord(activeChat.id, muteRecord.id), {
            method: 'DELETE'
          });
          const deleteData = await deleteRes.json();
          if (deleteData.success) {
            toast.success(`已解除 ${memberName} 的禁言`);
            // 只更新本地状态，不再调用fetchMutedMembers
            setMutedMembers(prev => {
              const newSet = new Set(prev);
              newSet.delete(memberId);
              return newSet;
            });
          } else {
            toast.error('操作失败', deleteData.message);
          }
        } else {
          toast.info('该成员未被禁言');
        }
      }
    } catch (e) { 
      console.error('解除禁言失败:', e);
      toast.error('操作失败'); 
    }
  };

  const handleAddMember = async () => {
    const input = await showInput({
      title: '添加成员',
      message: '请输入要添加的成员的用户ID或用户名：',
      placeholder: '用户ID或用户名',
      confirmText: '添加',
      cancelText: '取消'
    });
    if (!input) return;
    
    try {
      // 先根据用户名查找用户
      const searchRes = await apiFetch(`${API.user.search}?q=${encodeURIComponent(input)}`, { requireCsrf: false });
      const searchData = await searchRes.json();
      
      if (!searchData.success || !searchData.data?.length) {
        toast.error('未找到该用户');
        return;
      }
      
      const targetUser = searchData.data[0];
      
      if (await showConfirm({ title: '确认', message: `确定要添加 ${targetUser.name} 到群聊吗？` })) {
        const res = await apiFetch(API.groups.members(activeChat.id), {
          method: 'POST',
          body: JSON.stringify({ memberId: targetUser.id })
        });
        const data = await res.json();
        if (data.success) {
          toast.success(`${targetUser.name} 已成功加入群聊`);
          // 刷新群成员列表
          onRefreshGroup?.();
        } else {
          toast.error('添加失败', data.message);
        }
      }
    } catch (error) {
      console.error('添加成员失败:', error);
      toast.error('添加失败', '请重试');
    }
  };

  const fetchJoinRequests = async () => {
    if (!groupInfo?.id && !activeChat?.id) return;
    setLoadingJoinRequests(true);
    try {
      const groupId = groupInfo?.id || activeChat.id;
      const res = await api.group.getJoinRequests(groupId);
      if (res.success) {
        setJoinRequests(res.data || []);
      }
    } catch (err) {
      console.error('获取入群申请失败:', err);
      toast.error('获取入群申请失败');
    } finally {
      setLoadingJoinRequests(false);
    }
  };

  const handleApproveRequest = async (requestId: string) => {
    if (!groupInfo?.id && !activeChat?.id) return;
    try {
      const groupId = groupInfo?.id || activeChat.id;
      const res = await api.group.approveJoinRequest(groupId, requestId);
      if (res.success) {
        toast.success('已同意入群申请');
        setJoinRequests(prev => prev.map(r => r.id === requestId ? { ...r, status: 'approved' } : r));
        onRefreshGroup?.();
        window.dispatchEvent(new CustomEvent('joinRequestProcessed', { detail: { groupId } }));
      }
    } catch (err: any) {
      toast.error(err.message || '操作失败');
    }
  };

  const handleRejectRequest = async (requestId: string) => {
    if (!groupInfo?.id && !activeChat?.id) return;
    try {
      const groupId = groupInfo?.id || activeChat.id;
      const res = await api.group.rejectJoinRequest(groupId, requestId);
      if (res.success) {
        toast.success('已拒绝入群申请');
        setJoinRequests(prev => prev.map(r => r.id === requestId ? { ...r, status: 'rejected' } : r));
        window.dispatchEvent(new CustomEvent('joinRequestProcessed', { detail: { groupId } }));
      }
    } catch (err: any) {
      toast.error(err.message || '操作失败');
    }
  };

  const isGroup = chatType === 'group';

  const handleClearHistory = async () => {
    // 检查是否是群主
    if (isGroup) {
      const isOwner = groupInfo?.ownerIds?.includes(currentUser?.id);
      if (!isOwner) {
        toast.error('只有群主才能清除历史记录');
        return;
      }
    }
    
    try {
      const res = await apiFetch(API.conversations.clearHistory(activeChat.id), {
        method: 'DELETE'
      });
      const data = await res.json();
      if (data.success) {
        toast.success(`已清除${data.deletedCount || 0}条记录`);
        // 根据返回的消息ID过滤消息，保留未删除的消息
        if (data.deletedMessageIds && data.deletedMessageIds.length > 0) {
          onClearMessages?.(data.deletedMessageIds);
        }
      } else {
        toast.error('清除失败', data.message);
      }
    } catch (error) {
      console.error('清除历史记录失败:', error);
      toast.error('清除失败', '请重试');
    }
  };

  const handleExportHistory = async () => {
    try {
      const keys = getCachedKeys();
      
      // 首先获取总数
      toast.info('正在导出...', '准备中');
      
      const firstRes = await apiFetch(`${API.conversations.exportHistory(activeChat.id)}?page=1&limit=100`, { requireCsrf: false });
      const firstData = await firstRes.json();
      
      if (!firstData.success) {
        toast.error('导出失败', firstData.message);
        return;
      }
      
      const pagination = firstData.data?.pagination;
      const allMessages: any[] = [...(firstData.data?.messages || [])];
      const totalPages = pagination?.totalPages || 1;
      const total = pagination?.total || allMessages.length;
      
      if (total === 0) {
        toast.info('暂无聊天记录');
        return;
      }
      
      // 分页获取所有消息
      for (let page = 2; page <= totalPages; page++) {
        toast.info('正在导出...', `${allMessages.length}/${total}`);
        
        const pageRes = await apiFetch(`${API.conversations.exportHistory(activeChat.id)}?page=${page}&limit=100`, { requireCsrf: false });
        const pageData = await pageRes.json();
        
        if (pageData.success && pageData.data?.messages) {
          allMessages.push(...pageData.data.messages);
        }
      }
      
      toast.info('正在生成文件...');
      
      // 生成导出内容
      let content = `${isGroup ? groupInfo?.name : activeChat.name} 聊天记录\n`;
      content += `导出时间: ${new Date().toLocaleString()}\n`;
      content += `共 ${allMessages.length} 条消息\n`;
      content += '========================================\n\n';
      
      allMessages.forEach((msg: any) => {
        // msg.timestamp 已经是偏移后的 Date 对象
        const time = msg.timestamp instanceof Date ? msg.timestamp.toLocaleString() : new Date(msg.timestamp).toLocaleString();
        const sender = msg.senderName || '未知';
        
        // 解密消息内容（只解密普通消息，系统消息不解密）
        let msgContent = msg.content || '';
        const isEncrypted = msg.encrypted === 1 || msg.encrypted === true || msg.encrypted === '1';
        const isSystem = (msg as any).isSystem === true || (msg as any).isSystem === 1 || (msg as any).isSystem === '1';
        
        if (isEncrypted && keys?.currentKey && !isSystem) {
          const result = tryDecrypt(msg.content);
          if (result.decrypted) {
            msgContent = result.content;
          } else {
            msgContent = '[解密失败]';
          }
        }
        
        // 处理撤回消息
        if (msg.recalled === true || msg.recalled === 1) {
          msgContent = '[该消息已被撤回]';
        }
        
        // 解密附件名称（只解密普通消息，系统消息不解密）
        let attachmentsInfo = '';
        if (msg.attachments && msg.attachments.length > 0) {
          const attachmentNames = msg.attachments.map((a: any) => {
            const attEncrypted = a.encrypted === 1 || a.encrypted === true || a.encrypted === '1';
            if (attEncrypted && keys?.currentKey && !isSystem) {
              const result = tryDecrypt(a.name);
              return result.decrypted ? result.content : '[解密失败]';
            }
            return a.name;
          });
          attachmentsInfo = ' [附件: ' + attachmentNames.join(', ') + ']';
        }
        
        content += `[${time}] ${sender}:\n${msgContent}${attachmentsInfo}\n\n`;
      });
      
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `聊天记录_${isGroup ? groupInfo?.name : activeChat.name}_${formatDate(new Date())}.txt`;
      a.click();
      URL.revokeObjectURL(url);
      
      toast.success('导出成功', `共导出 ${allMessages.length} 条消息`);
    } catch (error) {
      console.error('导出历史记录失败:', error);
      toast.error('导出失败', '请重试');
    }
  };

  return (
    <div className="chat-area">
      {/* 聊天头部 */}
      <div className="chat-header">
          <div className="chat-header-info">
          <div className="avatar" style={{ position: 'relative' }}>
            {isGroup ? (
              '👥'
            ) : activeChat.avatar ? (
              <img src={activeChat.avatar} alt="" style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} />
            ) : (
              <span style={{ width: '100%', height: '100%', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {activeChat.name?.charAt(0) || '?'}
              </span>
            )}
            {!isGroup && activeChat.status !== 'online' && (
              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(128,128,128,0.5)', borderRadius: '50%' }}></div>
            )}
            {(!isGroup && activeChat.role && activeChat.role !== 'user') && (
              <div style={{ position: 'absolute', bottom: -2, left: -2, background: activeChat.role === 'admin' ? '#ff4757' : '#ffa502', borderRadius: '50%', width: '16px', height: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {activeChat.role === 'admin' ? <Shield size={10} color="#fff" /> : <Gem size={10} color="#fff" />}
              </div>
            )}
            {!isGroup && activeChat.status === 'muted' && (
              <div style={{ position: 'absolute', top: -4, left: -4, background: '#f97316', borderRadius: '50%', width: '18px', height: '18px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid white' }} title="已被禁言"><VolumeX size={10} color="#fff" /></div>
            )}
            {!isGroup && activeChat.status === 'banned' && (
              <div style={{ position: 'absolute', top: -4, left: -4, background: '#dc2626', borderRadius: '50%', width: '18px', height: '18px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid white' }} title="已被封禁"><UserX size={10} color="#fff" /></div>
            )}
            {!isGroup && <div className={`status-indicator ${activeChat?.status === 'online' ? 'status-online' : 'status-offline'}`}></div>}
          </div>
          <div className="chat-header-content">
            <div className="chat-title-text">
              {isGroup ? groupInfo?.name : activeChat.name}
              {isGroup && groupInfo?.memberCount && <span className="member-count"> ({groupInfo.memberCount}人)</span>}
            </div>
            {!isGroup && activeChat?.signature && (
              <div className="chat-header-signature">"{activeChat.signature}"</div>
            )}
            {isGroup ? (
              <div className="chat-status-text">
                {groupInfo?.announcement ? (
                  <MarkdownRenderer content={groupInfo.announcement} className="announcement-markdown-inline" />
                ) : '暂无公告'}
              </div>
            ) : (
              <div className={`chat-status-text ${activeChat?.status === 'online' ? '' : activeChat?.status === 'muted' ? 'muted' : activeChat?.status === 'banned' ? 'banned' : 'offline'}`}>
                {activeChat?.status === 'online' ? '在线' : 
                 activeChat?.status === 'muted' ? '已被禁言' :
                 activeChat?.status === 'banned' ? '已被封禁' : '离线'}
              </div>
            )}
            </div>
            </div>
        
        {/* 群聊功能按钮 - 只在群聊时显示 */}
        {isGroup && (
          <div className="chat-header-actions">
            <button 
              className="action-icon" 
              title="群公告"
              onClick={() => {
                setShowAnnouncement(!showAnnouncement);
                setShowMembers(false);
                setShowMoreMenu(false);
              }}
            >
              <ScrollText size={18} />
            </button>
            <button 
              className="action-icon" 
              title="群成员"
              onClick={() => {
                setShowMembers(!showMembers);
                setShowAnnouncement(false);
                setShowMoreMenu(false);
              }}
            >
              <Users size={18} />
            </button>
            {chatType === 'group' && (
              <button 
                className="action-icon" 
                title="群附件"
                onClick={() => setShowGroupAttachments(true)}
              >
                <Paperclip size={18} />
              </button>
            )}
            {isGroupOwner && (
              <button 
                className="action-icon" 
                title="入群申请"
                onClick={() => {
                  setShowJoinRequests(true);
                  setShowAnnouncement(false);
                  setShowMembers(false);
                  setShowMoreMenu(false);
                  fetchJoinRequests();
                }}
              >
                {joinRequests.filter(r => r.status === 'pending').length > 0 ? (
                  <>
                    <BellRing size={18} style={{ animation: 'bellRing 1s ease-in-out infinite' }} />
                    <span className="notification-badge" style={{animation: 'pulse 1s ease-in-out infinite'}}>{joinRequests.filter(r => r.status === 'pending').length}</span>
                  </>
                ) : (
                  <BellRing size={18} />
                )}
              </button>
            )}
            <div style={{ position: 'relative' }}>
              <button 
                className="action-icon" 
                title="更多"
                onClick={() => setShowMoreMenu(!showMoreMenu)}
              >
                <MoreHorizontal size={18} />
              </button>
              {showMoreMenu && (
                <div className="more-menu">
                  <button 
                    onClick={async () => {
                      if (await showConfirm({ title: '确认', message: '确定要退出群聊吗？', type: 'warning' })) {
                        handleQuitGroup();
                      }
                      setShowMoreMenu(false);
                    }}
                  >
                    <LogOut size={18} />
                    退出群组
                  </button>
                  <button 
                    onClick={() => {
                      handleExportHistory();
                      setShowMoreMenu(false);
                    }}
                  >
                    <Download size={18} />
                    导出历史记录
                  </button>
                  {isGroupOwner && (
                    <button 
                      onClick={async () => {
                        if (await showConfirm({ title: '确认', message: '确定要清除聊天记录吗？此操作不可恢复。', type: 'danger' })) {
                          handleClearHistory();
                        }
                        setShowMoreMenu(false);
                      }}
                    >
                      <Trash2 size={18} />
                      清除历史记录
                    </button>
                  )}
                  {isGroupOwner && (
                    <button 
                      onClick={() => {
                        setShowTransferModal(true);
                        setShowMoreMenu(false);
                      }}
                    >
                      <Crown size={18} />
                      转让群主
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* 私聊功能按钮 - 只在私聊时显示 */}
        {!isGroup && (
          <div className="chat-header-actions">
            <div style={{ position: 'relative' }}>
              <button 
                className="action-icon" 
                title="更多"
                onClick={() => setShowMoreMenu(!showMoreMenu)}
              >
                <MoreHorizontal size={18} />
              </button>
              {showMoreMenu && (
                <div className="more-menu">
                  <button 
                    onClick={async () => {
                      if (await showConfirm({ title: '确认', message: '确定要清除聊天记录吗？默认会删除3天前的历史记录，此操作不可恢复。', type: 'danger' })) {
                        handleClearHistory();
                      }
                      setShowMoreMenu(false);
                    }}
                  >
                    <Trash2 size={16} />
                    清除历史记录
                  </button>
                  <button 
                    onClick={() => {
                      handleExportHistory();
                      setShowMoreMenu(false);
                    }}
                  >
                    <Download size={20} />
                    导出历史记录
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 群公告面板 - 只在群聊时显示 */}
      {isGroup && showAnnouncement && (
        <div className="group-settings-panel">
          <div className="group-settings-header">
            <h3>群公告</h3>
            <button className="close-btn" onClick={() => setShowAnnouncement(false)}>×</button>
          </div>
          <div className="group-settings-content">
            {isLoadingGroupInfo ? (
              <div className="loading-indicator" style={{ padding: '20px', textAlign: 'center' }}>
                <span className="loading-spinner"></span>
                <span style={{ marginLeft: '8px' }}>加载中...</span>
              </div>
            ) : (
              <>
                {editingAnnouncement ? (
                  <div className="announcement-editor">
                    <textarea 
                      value={announcementText}
                      onChange={(e) => setAnnouncementText(e.target.value)}
                      placeholder="输入群公告..."
                      rows={3}
                    />
                    <div className="editor-actions">
                      <button onClick={() => setEditingAnnouncement(false)}>取消</button>
                      <button className="primary" onClick={handleSaveAnnouncement}>保存</button>
                    </div>
                  </div>
                ) : (
                  <div className="announcement-display">
                    {groupInfo?.announcement ? (
                      <MarkdownRenderer content={groupInfo.announcement} className="announcement-markdown" />
                    ) : (
                      <p style={{ color: '#999' }}>暂无公告</p>
                    )}
                    {isGroupOwner && (
                      <button className="edit-btn" onClick={() => setEditingAnnouncement(true)}>
                        {groupInfo?.announcement ? '编辑' : '添加公告'}
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* 群成员面板 - 只在群聊时显示 */}
      {isGroup && showMembers && (
        <div className="group-settings-panel">
          <div className="group-settings-header">
            <h3>群成员 ({groupInfo?.members?.length || 0})</h3>
            <button className="close-btn" onClick={() => setShowMembers(false)}>×</button>
          </div>
          <div className="group-settings-content">
            {isLoadingGroupInfo ? (
              <div className="loading-indicator" style={{ padding: '20px', textAlign: 'center' }}>
                <span className="loading-spinner"></span>
                <span style={{ marginLeft: '8px' }}>加载中...</span>
              </div>
            ) : (
              <>
                <div className="members-list">
                  {groupInfo?.members?.map((member: any, index: number) => {
                    const isOwner = groupInfo?.ownerIds?.includes(member.id);
                    const isSelf = member.id === currentUser.id;
                    return (
                      <div key={index} className="member-item">
                        <div className="member-avatar">
                          {member.avatar ? (
                            <img src={getAvatarUrl(member.avatar)} alt="" style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} />
                          ) : (
                            member.name?.charAt(0) || '?'
                          )}
                        </div>
                        <div className="member-name">{member.name}</div>
                        <div className="member-status">
                          {member?.status === "online" ? (<span className="online">在线</span>) : 
                           member?.status === "muted" ? (<span style={{color: '#f97316'}}>已被禁言</span>) :
                           member?.status === "banned" ? (<span style={{color: '#dc2626'}}>已被封禁</span>) :
                           (<span className="offline">离线</span>)}
                        </div>
                        {isOwner && <span className="owner-badge">群主</span>}
                        {isGroupOwner && !isSelf && !isOwner && (
                          <div style={{ position: 'relative' }}>
                            <button 
                              className="member-context-menu-toggle"
                              onClick={() => setShowMemberMenu(showMemberMenu === member.id ? null : member.id)}
                            >
                              <MoreHorizontal size={14} />
                            </button>
                            {showMemberMenu === member.id && (
                              <div className="member-context-menu">
                                {mutedMembers.has(member.id) ? (
                                  <button onClick={() => { handleUnmuteMember(member.id, member.name); setShowMemberMenu(null); }}>
                                    <Ban size={16} />
                                    解除禁言
                                  </button>
                                ) : (
                                  <button onClick={() => { handleMuteMember(member.id, member.name); setShowMemberMenu(null); }}>
                                    <Ban size={16} />
                                    禁言
                                  </button>
                                )}
                                <button className="danger" onClick={() => { handleRemoveMember(member.id, member.name); setShowMemberMenu(null); }}>
                                  <UserMinus size={16} />
                                  移除
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {!groupInfo?.members?.length && <div className="no-members">暂无成员信息</div>}
                </div>
                {isGroupOwner && (
                  <div className="add-member-section">
                    <button 
                      className="add-member-btn"
                      onClick={handleAddMember}
                    >
                      <UserPlus size={16} />
                      添加成员
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* 入群申请面板 - 仅群主可见 */}
      {isGroup && showJoinRequests && (
        <div className="group-settings-panel">
          <div className="group-settings-header">
            <h3>入群申请</h3>
            <button className="close-btn" onClick={() => setShowJoinRequests(false)}>×</button>
          </div>
          <div className="group-settings-content">
            <div className="approval-toggle">
              <label>
                <input 
                  type="checkbox" 
                  checked={requireApproval}
                  onChange={async (e) => {
                    const newValue = e.target.checked;
                    setRequireApproval(newValue);
                    try {
                      await api.group.updateApprovalSetting(groupInfo?.id || activeChat.id, newValue);
                      toast.success(newValue ? '已开启入群审核' : '已关闭入群审核');
                    } catch (err: any) {
                      setRequireApproval(!newValue);
                      toast.error(err.message || '设置失败');
                    }
                  }}
                />
                <span>开启入群审核</span>
              </label>
            </div>
            <div className="join-requests-list">
              {loadingJoinRequests ? (
                <div className="loading-indicator" style={{ padding: '20px', textAlign: 'center' }}>
                  <span className="loading-spinner"></span>
                  <span style={{ marginLeft: '8px' }}>加载中...</span>
                </div>
              ) : joinRequests.length === 0 ? (
                <div className="no-requests">暂无入群申请</div>
              ) : (
                joinRequests.map((request) => (
                  <div key={request.id} className="join-request-item">
                    <div className="request-user">
                      <div className="request-avatar">
                        {request.userName?.charAt(0) || '?'}
                      </div>
                      <div className="request-info">
                        <div className="request-name">{request.userName}</div>
                        <div className="request-time">{formatTimestamp(convertServerTime(request.createdAt))}</div>
                        {request.reason && <div className="request-reason">{request.reason}</div>}
                      </div>
                    </div>
                    <div className="request-actions">
                      {request.status === 'pending' ? (
                        <>
                          <button 
                            className="btn-approve"
                            onClick={() => handleApproveRequest(request.id)}
                          >
                            <Check size={16} />
                          </button>
                          <button 
                            className="btn-reject"
                            onClick={() => handleRejectRequest(request.id)}
                          >
                            <X size={16} />
                          </button>
                        </>
                      ) : (
                        <span className={`request-status ${request.status}`}>
                          {request.status === 'approved' ? '已同意' : '已拒绝'}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* 消息区域 */}
      <div 
        className={`messages-container ${isDragging ? 'dragging' : ''}`} 
        ref={messagesContainerRef} 
        onScroll={handleScroll}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* 加载更多消息的提示 - 放在顶部，用户滚动到顶部时可见 */}
        {isLoadingMessages && (
          <div className="loading-indicator" style={{ padding: '20px', textAlign: 'center' }}>
          	<span className="loading-spinner"></span>
            <span>加载更多消息...</span>
          </div>
        )}
        {!isLoadingMessages && !hasMoreMessages && messages.length > 0 && (
          <div className="no-more-messages" style={{ padding: '10px', textAlign: 'center', color: '#999', fontSize: '12px' }}>
            <span>没有更多消息了</span>
          </div>
        )}
        
        {Object.entries(groupedMessages).map(([dateKey, msgs]) => (
          <React.Fragment key={dateKey}>
            <div className="date-divider">
              <span>{formatDate(dateKey)}</span>
            </div>
              {msgs.map((msg) => {
              const isSelf = msg.sender.id === currentUser.id;
              const isSystem = (msg as any).isSystem === true || (msg as any).isSystem === 1 || (msg as any).is_system === 1;
              const isRecalled = (msg as any).recalled === true || (msg as any).recalled === 1;
              const attachments = (msg as any).attachments as Attachment[] | undefined;
              
              // System message - display centered
              if (isSystem) {
                return (
                  <div key={msg.id} className="system-message">
                    
                    <span><Megaphone size={16} /> {msg.content}</span>
                  </div>
                );
              }
              
              return (
                <div 
                  key={msg.id} 
                  id={`msg-${msg.id}`}
                  className={`message-row ${isSelf ? 'sent' : 'received'} ${isRecalled ? 'recalled' : ''}`}
                  onMouseEnter={() => setHoveredMessage(msg.id)}
                  onMouseLeave={() => setHoveredMessage(null)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setHoveredMessage(msg.id);
                  }}
                >
                  {/* 撤回消息不显示头像 */}
                  {!isSelf && !isRecalled && (
                    <div className="message-avatar-wrapper">
                      <div className="message-avatar">
                        {(msg.sender as any).avatar ? (
                          <img 
                            src={getAvatarUrl((msg.sender as any).avatar)} 
                            alt="" 
                            style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} 
                          />
                        ) : (
                          msg.sender.name?.charAt(0) || '?'
                        )}
                      </div>
                    </div>
                  )}
                  <div className="message" id={`msg-${msg.id}`}>
                    {/* 多选模式复选框 */}
                    {isMultiSelectMode && !isRecalled && (
                      <button
                        className={`message-checkbox ${selectedMessages.has(msg.id) ? 'checked' : ''}`}
                        onClick={() => handleMultiSelect(msg.id)}
                      >
                        {selectedMessages.has(msg.id) ? <Check size={24} /> : <Square size={24} />}
                      </button>
                    )}
                    {isRecalled ? (
                      <div className="recalled-message">
                        <span className="recalled-text">{msg.content}</span>
                      </div>
                    ) : (
                      <div className="message-bubble">
                        {/* Reply indicator */}
                        {(msg as any).replyTo && (
                          <div 
                            className="message-reply" 
                            onClick={() => {
                              const replyMsgId = (msg as any).replyTo?.id;
                              if (replyMsgId) {
                                const element = document.getElementById(`msg-${replyMsgId}`);
                                if (element) {
                                  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                  element.classList.add('highlight-message');
                                  setTimeout(() => element.classList.remove('highlight-message'), 2000);
                                }
                              }
                            }}
                          >
                            {(() => {
                              const replyContent = (msg as any).replyTo?.content;
                              const keys = getCachedKeys();
                              let displayReplyContent = replyContent;
                              let replyDecryptFailed = false;
                              if (replyContent) {
                                const isLikelyEncrypted = replyContent.startsWith('U2FsdGVkX') || replyContent.startsWith('Salted__');
                                if (isLikelyEncrypted) {
                                  if (keys) {
                                    const result = tryDecrypt(replyContent);
                                    if (result.decrypted) {
                                      displayReplyContent = result.content;
                                    } else {
                                      replyDecryptFailed = true;
                                    }
                                  } else {
                                    replyDecryptFailed = true;
                                  }
                                }
                              }
                              return (
                                <div className="reply-header">
                                  回复 {(msg as any).replyTo?.name}: {replyDecryptFailed ? '🔒 解密失败' : displayReplyContent}
                                </div>
                              );
                            })()}
                          </div>
                        )}
                    
                        {/* Attachments */}
                          {attachments && attachments.length > 0 && (
                            <div className="message-attachments">
                              {attachments.map((att, idx) => {
                                const isUploading = (att as any).uploading;
                                const isDownloading = (att as any).downloading;
                                const hasProgress = (att as any).uploadProgress !== undefined || (att as any).downloadProgress !== undefined;
                                const isDecrypted = !!decryptedImageUrls[att.url];
                                const isImageFailed = decryptFailedImageUrls.has(att.url);
                                const keys = getCachedKeys();
                               
                              // 检查图片是否需要解密
                              const needsDecryption = att.encrypted === 1 || att.encrypted === true;
                              const showDecryptError = isImageFailed || (needsDecryption && !keys);
                              
                              return (
                                <div key={idx} className="message-attachment">
                                  {(msg as any).burnAfterReading && (
                                    <div className="burn-tag">🔥 阅后即焚</div>
                                  )}
                                  {att.type === 'image' ? (
                                    att.encrypted ? (
                                      showDecryptError ? (
                                        <div className="message-content decrypt-error">
                                          🔒 图片解密失败，无法显示内容（请检查密钥）
                                        </div>
                                      ) : !isDecrypted ? (
                                        <div className="message-image encrypted-image-placeholder">
                                          <div className="loading-spinner large"></div>
                                          <span className="encrypted-label">解密中</span>
                                        </div>
                                      ) : (
                                        <img 
                                          src={decryptedImageUrls[att.url]}
                                          alt={att.name} 
                                          className="message-image"
                                          loading="lazy"
                                          onClick={() => {
                                            setPreviewImage({ url: decryptedImageUrls[att.url], messageId: msg.id, burnAfterReading: (msg as any).burnAfterReading, encrypted: true, decryptedUrl: decryptedImageUrls[att.url], decryptedBlob: decryptedImageBlobs[att.url], senderId: msg.sender.id, attachmentId: att.id });
                                            if ((msg as any).burnAfterReading && !isSelf) {
                                              handleBurnAfterRead(msg.id, att.url);
                                            }
                                          }}
                                        />
                                      )
                                    ) : isUploading || isDownloading ? (
                                      <div className="message-image-wrapper">
                                        <img 
                                          src={att.url || (att as any).previewUrl} 
                                          alt={att.name} 
                                          className="message-image"
                                          loading="lazy"
                                          style={{ opacity: 0.5 }}
                                        />
                                        <div className="upload-progress-overlay">
                                          <span className="upload-progress-text">{(att as any).uploadProgress?.toFixed(0) || 0}%</span>
                                        </div>
                                      </div>
                                    ) : !isDecrypted ? (
                                      <div className="message-image-wrapper">
                                        <img 
                                          src={att.url || (att as any).previewUrl} 
                                          alt={att.name} 
                                          className="message-image"
                                          loading="lazy"
                                        />
                                      </div>
                                    ) : (
                                      <img 
                                        src={decryptedImageUrls[att.url]} 
                                        alt={att.name} 
                                        className="message-image"
                                        loading="lazy"
                                        onClick={() => {
                                          setPreviewImage({ url: decryptedImageUrls[att.url], messageId: msg.id, burnAfterReading: (msg as any).burnAfterReading, encrypted: true, decryptedUrl: decryptedImageUrls[att.url], decryptedBlob: decryptedImageBlobs[att.url], senderId: msg.sender.id, attachmentId: att.id });
                                          if ((msg as any).burnAfterReading && !isSelf) {
                                            handleBurnAfterRead(msg.id, att.url);
                                          }
                                        }}
                                      />
                                    )
                                  ) : (
                                    <div 
                                      className={`message-file ${att.encrypted && decryptFailedFileUrls.has(att.url) ? 'decrypt-failed' : ''} ${isUploading || isDownloading ? 'uploading' : ''}`}
                                      onClick={() => {
                                        if (isUploading || isDownloading) return;
                                        
                                        // console.log('[Debug] handleFileDownload:', {
                                        //   name: att.name,
                                        //   encrypted: att.encrypted,
                                        //   url: att.url
                                        // });
                                        
                                        let canDownload = true;
                                        let finalName = att.name;
                                        if (att.encrypted) {
                                          const localKeys = getCachedKeys();
                                          // console.log('[Debug] keys:', localKeys ? 'has keys' : 'no keys');
                                          if (localKeys) {
                                            const result = tryDecrypt(att.name);
                                            // console.log('[Debug] tryDecrypt result:', result);
                                            if (result.decrypted) {
                                              finalName = result.content;
                                            } else {
                                              canDownload = false;
                                            }
                                          } else {
                                            canDownload = false;
                                          }
                                        }
                                        
                                         if (!canDownload) {
                                           toast.error('文件名解密失败，无法下载');
                                           return;
                                         }
                                         
                                         const downloadUrl = att.type === 'image' && decryptedImageUrls[att.url] ? decryptedImageUrls[att.url] : att.url;
                                         const isAlreadyDecrypted = att.type === 'image' && decryptedImageUrls[att.url];
                                         // 如果解密成功，使用解密后的文件名保存，但下载时需要知道原始文件名是否加密
                                         // 下载任务需要知道是否需要解密文件内容
                                         handleDownload(downloadUrl, att.encrypted ? finalName : att.name, msg.id, (msg as any).burnAfterReading, att.encrypted && !isAlreadyDecrypted, msg.sender.id, att.size, att.id);
                                       }}
                                    >
                                    {/* 根据文件名判断是否显示加密图标还是文件图标 */}
                                      <span className="file-icon">
                                        {(() => {
                                             if (!att.encrypted) return <FileIcon size={28} />;
                                             const isEncryptedName = att.name && (att.name.startsWith('U2FsdGVkX') || att.name.startsWith('Salted__'));
                                             if (!isEncryptedName) return <FileIcon size={28} />;
                                             // 优先检查解密失败状态
                                             if (decryptFailedFileUrls.has(att.url)) return <LockIcon size={28} />;
                                             const keys = getCachedKeys();
                                             if (!keys?.currentKey) return <LockIcon size={28} />;
                                             const result = tryDecrypt(att.name);
                                             return result.decrypted ? <FileIcon size={28} /> : <LockIcon size={28} />;
                                           })()}
                                      </span>
                                      <div className="file-details">
                                        <span className="file-name">
                                          {(() => {
                                            if (!att.encrypted) return att.name;
                                            const isEncryptedName = att.name && (att.name.startsWith('U2FsdGVkX') || att.name.startsWith('Salted__'));
                                            if (!isEncryptedName) return att.name;
                                            // 优先检查解密失败状态
                                            if (decryptFailedFileUrls.has(att.url)) return '文件名解密失败';
                                            const keys = getCachedKeys();
                                            if (!keys?.currentKey) return '🔒 请先设置密钥';
                                            const result = tryDecrypt(att.name);
                                            return result.decrypted ? result.content : '文件名解密失败';
                                          })()}
                                        </span>
                                        <span className="file-size">{formatFileSize(att.size)}</span>
                                        {/* 上传失败显示 */}
                                        {(att as any).uploadFailed && (
                                          <span className="upload-failed-tag">⚠️ 上传失败</span>
                                        )}
                                        {(isUploading || isDownloading) && (
                                          <div className="file-upload-progress">
                                            <div className="file-progress-bar">
                                              {(att as any).encrypting ? (
                                                <div className="file-progress-fill marquee"></div>
                                              ) : (
                                                <div className="file-progress-fill" style={{ width: `${(att as any).uploadProgress || (att as any).downloadProgress || 0}%` }}></div>
                                              )}
                                            </div>
                                            <span className="file-progress-text">
                                              {(att as any).encrypting ? '加密中...' : `${((att as any).uploadProgress || (att as any).downloadProgress || 0).toFixed(1)}%`}
                                            </span>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                      )}

                        <div className="message-content" style={{ color: (msg as any).decryptFailed ? '#dc3545' : undefined }}>
                          {(msg as any).decryptFailed || (typeof msg.content === 'string' && (msg.content.startsWith('U2FsdGVkX') || msg.content.startsWith('Salted__'))) ? (
                            <span>🔒 解密失败，无法显示内容</span>
                          ) : translatedMessages[msg.id] ? (
                            <div className="translated-content">
                              <div className="original-content" style={{ opacity: 0.6, fontSize: '12px' }}>
                                {typeof msg.content === 'string' && msg.content.includes('@') ? (
                                  <span>{renderMention(msg.content)}</span>
                                ) : (
                                  msg.content
                                )}
                              </div>
                              <div className="translated-text" style={{ marginTop: '4px' }}>
                                🌐 {translatedMessages[msg.id]}
                              </div>
                            </div>
                            ) : (
                              typeof msg.content === 'string' ? (
                                <div className="message-markdown-content">
                                  <ReactMarkdown
                                    remarkPlugins={[]}
                                    components={{
                                      a: ({node, ...props}) => <a target="_blank" rel="noopener noreferrer" {...props} />,
                                      code: ({node, inline, className, children, ...props}) => {
                                        const codeContent = typeof children === 'string' ? escapeHtml(children) : children;
                                        return inline ? 
                                          <code className="markdown-inline-code" {...props}>{codeContent}</code> :
                                          <code className="markdown-code-block" {...props}>{codeContent}</code>;
                                      },
                                      img: ({node, ...props}) => {
                                        return <img {...props} alt={props.alt || ''} />;
                                      },
                                      blockquote: ({node, children, ...props}) => {
                                        return <blockquote className="markdown-blockquote" {...props}>{children}</blockquote>;
                                      },
                                      ul: ({node, children, ...props}) => {
                                        return <ul className="markdown-ul" {...props}>{children}</ul>;
                                      },
                                      ol: ({node, children, ...props}) => {
                                        return <ol className="markdown-ol" {...props}>{children}</ol>;
                                      },
                                      li: ({node, children, ...props}) => {
                                        return <li className="markdown-li" {...props}>{children}</li>;
                                      },
                                      h1: ({node, children, ...props}) => {
                                        return <h1 className="markdown-h1" {...props}>{children}</h1>;
                                      },
                                      h2: ({node, children, ...props}) => {
                                        return <h2 className="markdown-h2" {...props}>{children}</h2>;
                                      },
                                      h3: ({node, children, ...props}) => {
                                        return <h3 className="markdown-h3" {...props}>{children}</h3>;
                                      },
                                      p: ({node, children, ...props}) => {
                                        // 处理 @ 引用
                                        const content = children;
                                        if (typeof content === 'string') {
                                          const parts = content.split(/(@\S+)/g);
                                          return (
                                            <p {...props}>
                                              {parts.map((part, i) => 
                                                part.startsWith('@') ? 
                                                  <span key={i} className="mention-text">{part}</span> : 
                                                  part
                                              )}
                                            </p>
                                          );
                                        }
                                        return <p {...props}>{children}</p>;
                                      },
                                      br: ({node, ...props}) => {
                                        return <br {...props} />;
                                      }
                                    }}
                                  >
                                    {msg.content}
                                  </ReactMarkdown>
                                </div>
                              ) : (
                                msg.content
                              )
                            )}
                        </div>
                        <div className="message-info">
                          {isSelf ? (
                            <span className="message-sender">你</span>
                          ) : (
                            <span className="message-sender">{msg.sender.name}</span>
                          )}
                          <span className="message-time">{formatTime(msg.timestamp)}</span>
                          {starredMessages.has(msg.id) && (
                            <span className="starred-indicator" title="已收藏">⭐</span>
                          )}
                          {isSelf && (
                            <span className={`message-status ${(msg as any).read ? 'read' : 'unread'}`}>
                              {(msg as any).status === 'sending' ? (
                                <span className="status-sending">发送中...</span>
                              ) : (msg as any).status === 'failed' ? (
                                <span className="status-failed" onClick={() => onRetry?.(msg.id)} title="点击重试">⚠️ 发送失败，点击重试</span>
                              ) : (msg as any).read ? ((msg as any).readBy ? `✓ ${(msg as any).readBy}已读` : '✓ 已读') : '○ 未读'}
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  {isSelf && (
                    <div className="message-avatar-wrapper">
                      <div className="message-avatar">
                        {(currentUser as any).avatar ? (
                          <img 
                            src={getAvatarUrl((currentUser as any).avatar)} 
                            alt="" 
                            style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} 
                          />
                        ) : (
                          msg.sender.name?.charAt(0) || '?'
                        )}
                      </div>
                    </div>
                  )}
                  
                  {/* Hover menu */}
                  {hoveredMessage === msg.id && !isRecalled && (
                    <div className="message-hover-menu">
                      {isMultiSelectMode ? (
                        <>
                          <button 
                            title={selectedMessages.has(msg.id) ? "取消选择" : "选择"}
                            onClick={() => handleMultiSelect(msg.id)}
                          >
                            {selectedMessages.has(msg.id) ? <Check size={14} /> : <Square size={14} />}
                          </button>
                          <button 
                            title={`删除选中的 ${selectedMessages.size} 条消息`}
                            onClick={handleBatchDelete}
                            style={{ color: selectedMessages.size > 0 ? 'var(--danger)' : undefined }}
                          >
                            <Trash2 size={14} />
                          </button>
                          <button title="取消" onClick={cancelMultiSelect}>
                            <X size={14} />
                          </button>
                        </>
                      ) : (
                        <>
                          <button title="多选" onClick={() => setIsMultiSelectMode(true)}><Square size={14} /></button>
                          <button title="复制" onClick={() => handleCopy(msg.content)}><Copy size={14} /></button>
                          <button title="回复" onClick={() => handleReply(msg)}><MessageCircle size={14} /></button>
                          <button 
                            title={starredMessages.has(msg.id) ? "已收藏" : "收藏"}
                            onClick={() => handleToggleStar(msg.id, msg.content, (msg as any).sender?.name || '未知用户')}
                            style={{ color: starredMessages.has(msg.id) ? 'var(--warning)' : undefined }}
                          >
                            <Star size={14} fill={starredMessages.has(msg.id) ? 'currentColor' : 'none'} />
                          </button>
                          {!isSelf && (
                            <button 
                              title="举报"
                              onClick={() => {
                                setReportingMessage({ id: msg.id, content: msg.content, senderName: (msg as any).sender?.name || '未知用户' });
                              }}
                            >
                              <AlertTriangle size={14} />
                            </button>
                          )}
                          <button 
                            title={translatedMessages[msg.id] ? "显示原文" : "翻译"} 
                            onClick={() => handleTranslate(msg.id, msg.content)}
                          >
                            {translatingMsgId === msg.id ? <Loader2 size={14} className="ai-spinner" /> : <Globe size={14} />}
                          </button>
                          {(msg as any).attachments && (msg as any).attachments.length > 0 && (
                            <button title="复制文件链接" onClick={() => handleCopyFileLink((msg as any).attachments[0].url)}><Link size={14} /></button>
                          )}
                          {isSelf ? (
                            <button title="撤回" onClick={() => handleRecall(msg.id)}><Undo size={14} /></button>
                          ) : (
                            <button title="删除" onClick={() => handleDelete(msg.id)}><Trash2 size={14} /></button>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </React.Fragment>
        ))}
        <div ref={messagesEndRef} />
        
        {/* 回到底部按钮 */}
        {showScrollToBottom && (
          <button 
            className="scroll-to-bottom-btn"
            onClick={() => scrollToBottom(true, true)}
            title="回到底部"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12l7 7 7-7" />
            </svg>
          </button>
        )}
      </div>

      {/* Typing状态显示 - 在聊天头部下方 */}
      {localTypingUsers.length > 0 && (
        <div className="typing-indicator-header">
          <span className="typing-dots">
            <span></span><span></span><span></span>
          </span>
          <span className="typing-text">
            {localTypingUsers.map(u => u.userName).join(', ')} 正在输入...
          </span>
        </div>
      )}

      {/* Fullscreen image preview */}
      {previewImage && (
        <div 
          className="image-preview-overlay" 
          onClick={() => {
            if (typeof previewImage === 'object' && previewImage.decryptedUrl) {
              URL.revokeObjectURL(previewImage.decryptedUrl);
            }
            setPreviewImage(null);
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="image-preview-header">
            <button 
              className="preview-close" 
              onClick={(e) => { 
                e.stopPropagation(); 
                if (typeof previewImage === 'object' && previewImage.decryptedUrl) {
                  URL.revokeObjectURL(previewImage.decryptedUrl);
                }
                setPreviewImage(null); 
              }}
            >
              ×
            </button>
            <button 
              className="preview-save"
              onClick={(e) => { 
                e.stopPropagation();
                const previewData = typeof previewImage === 'object' ? previewImage : { url: previewImage };
                const isBurn = previewData.burnAfterReading;
                const msgId = previewData.messageId;
                const attachmentId = previewData.attachmentId;
                // 如果已经有decryptedUrl，说明图片已解密，不需要再解密
                const isEncrypted = previewData.encrypted && !previewData.decryptedUrl;
                // 优先使用保存的blob
                const savedBlob = previewData.decryptedBlob || decryptedImageBlobs[previewData.url];
                // 使用 attachmentId 查找附件
                const msg = messages.find(m => m.id === msgId);
                const att = attachmentId ? msg?.attachments?.find((a: any) => a.id === attachmentId) : undefined;
                let filename = att?.name || 'image.png';
                // 如果是加密文件，尝试解密文件名
                if (att?.encrypted && filename) {
                  const isEncryptedName = filename.startsWith('U2FsdGVkX') || filename.startsWith('Salted__');
                  if (isEncryptedName) {
                    const localKeys = getCachedKeys();
                    if (localKeys) {
                      const nameResult = tryDecrypt(filename);
                      if (nameResult.decrypted) {
                        filename = nameResult.content;
                      }
                    }
                  }
                }
                const senderId = previewData.senderId;
                
                if (savedBlob) {
                  // 使用保存的blob直接下载
                  const blobUrl = URL.createObjectURL(savedBlob);
                  const a = document.createElement('a');
                  a.href = blobUrl;
                  a.download = filename;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(blobUrl);
                } else {
                  // 如果没有保存的blob，使用URL下载
                  let downloadUrl = previewData.decryptedUrl || previewData.url;
                  if (!downloadUrl.startsWith('http') && !downloadUrl.startsWith('blob:')) {
                    downloadUrl = API.files.get(downloadUrl);
                  }
                  handleDownload(downloadUrl, filename, msgId, isBurn, isEncrypted, senderId, undefined, att?.id);
                }
              }}
            >
              另存为
            </button>
            {/* 阅后即焚图片不显示手动焚毁按钮，对方看完后自动删除 */}
          </div>
          <div 
            className="image-preview-container"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              const img = e.currentTarget.querySelector('img') as HTMLImageElement;
              if (!img) return;
              
              let startX = e.clientX;
              let startY = e.clientY;
              let imgX = 0;
              let imgY = 0;
              
              const maxX = (img.offsetWidth - window.innerWidth) / 2;
              const maxY = (img.offsetHeight - window.innerHeight) / 2;
              
              const onMouseMove = (moveEvent: MouseEvent) => {
                const deltaX = moveEvent.clientX - startX;
                const deltaY = moveEvent.clientY - startY;
                imgX += deltaX;
                imgY += deltaY;
                img.style.transform = `translate(${imgX}px, ${imgY}px) scale(${img.dataset.scale || '1'})`;
                startX = moveEvent.clientX;
                startY = moveEvent.clientY;
              };
              
              const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
              };
              
              document.addEventListener('mousemove', onMouseMove);
              document.addEventListener('mouseup', onMouseUp);
            }}
            onWheel={(e) => {
              e.preventDefault();
              const img = e.currentTarget.querySelector('img') as HTMLImageElement;
              if (!img) return;
              
              let scale = parseFloat(img.dataset.scale || '1');
              scale += e.deltaY > 0 ? -0.1 : 0.1;
              scale = clamp(scale, 0.5, 3);
              img.dataset.scale = scale.toString();
              img.style.transform = `translate(${img.style.transform.match(/translate\(([^)]+)\)/)?.[1] || '0px, 0px'}) scale(${scale})`;
            }}
          >
            <img src={typeof previewImage === 'object' ? (previewImage.decryptedUrl || (previewImage.url.startsWith('http') ? previewImage.url : API.files.get(previewImage.url))) : (previewImage.startsWith('http') ? previewImage : API.files.get(previewImage))} alt="Preview" className="image-preview-img" />
          </div>
          <div className="image-preview-hint">
            滚轮缩放 · 拖拽移动 · 点击空白处关闭
          </div>
        </div>
      )}

      {/* 转让群主弹窗 */}
      {showTransferModal && (
        <div className="modal-overlay" onClick={() => setShowTransferModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>转让群主</h3>
              <button className="close-btn" onClick={() => setShowTransferModal(false)}>×</button>
            </div>
            <div className="modal-body">
              <p>选择新群主（转让后您将退出群主身份）：</p>
              <div className="member-select-list">
                {groupInfo?.members?.filter((m: any) => m.id !== currentUser.id).map((member: any) => (
                  <div 
                    key={member.id} 
                    className="member-select-item"
                    onClick={async () => {
                      if (await showConfirm({ title: '确认', message: `确定要将群主转让给 ${member.name} 吗？转让后您将不再是群主。`, type: 'warning' })) {
                        try {
                          // 1. 添加新群主
                          const addRes = await apiFetch(API.groups.owners(activeChat.id), {
                            method: 'POST',
                            body: JSON.stringify({ memberId: member.id })
                          });
                          const addData = await addRes.json();
                          
                          if (addData.success) {
                            // 2. 移除自己
                            const removeRes = await apiFetch(`${API.groups.owners(activeChat.id)}/${currentUser.id}`, {
                              method: 'DELETE'
                            });
                            const removeData = await removeRes.json();
                            
                            if (removeData.success) {
                              toast.success('群主转让成功');
                              setShowTransferModal(false);
                              // 刷新群信息
                              onRefreshGroup?.();
                              // 触发会话列表更新
                              window.dispatchEvent(new CustomEvent('conversationsUpdate'));
                            } else {
                              toast.error('退出群主失败', removeData.message);
                            }
                          } else {
                            toast.error('添加群主失败', addData.message);
                          }
                        } catch (error) {
                          console.error('转让群主失败:', error);
                          toast.error('转让失败', '请重试');
                        }
                      }
                    }}
                  >
                    <div className="member-avatar">
                      {member.avatar ? (
                        <img src={getAvatarUrl(member.avatar)} alt="" style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} />
                      ) : (
                        member.name?.charAt(0) || '?'
                      )}
                    </div>
                    <span>{member.name}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 群附件弹窗 */}
      {showGroupAttachments && activeChat && (
        <GroupAttachments
          sessionId={activeChat.id}
          isGroupOwner={isGroupOwner}
          onClose={() => setShowGroupAttachments(false)}
          onUploadProgress={onUploadProgress}
        />
      )}

      {/* 举报对话框 */}
      {reportingMessage && (
        <ReportDialog
          messageId={reportingMessage.id}
          messageContent={reportingMessage.content}
          senderName={reportingMessage.senderName}
          onClose={() => setReportingMessage(null)}
        />
      )}
    </div>
  );
};

export default ChatWindow;
