import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Folder, File as FileIcon, Upload, Search, Plus, Trash2, ChevronRight, Clock, Users, HardDrive, FolderPlus, Check, X, ArrowLeft, Link, Share2, MoreVertical, Download, Edit, RotateCcw, User, MessageSquare, LayoutGrid, List } from 'lucide-react';
import { drive } from '../services/api';
import { encrypt, decrypt, decryptWithKeys, loadKeysFromStorage } from '../utils/crypto';
import { encryptFileChunkedAsync } from '../utils/cryptoAsync';
import { FRONTEND_URL } from '../config/api';
import { formatTimestamp, convertServerTime, getServerTimestamp } from '../utils/time';
import { toast } from '../utils/toast';
import { showConfirm } from './ConfirmDialog';
import { addGlobalUpload, updateGlobalUpload, removeGlobalUpload, registerUploadXhr, registerDownloadController, cancelUpload, getGlobalUploads, subscribeGlobalUploads, retryUpload, cancelledTasks } from '../utils/globalUploads';
import { TaskService } from '../utils/TaskService';
import { API } from '../config/api';
import { apiFetch } from '../utils/csrf';

interface DriveItem {
  id: string;
  name: string;
  type: 'folder' | 'file';
  size?: number;
  modified: number;
  ownerId: string;
  ownerName: string;
  parentId: string | null;
  isShared?: boolean;
  sharePermission?: 'view' | 'edit' | 'upload';
  shareToUsers?: string[];
  shareToGroups?: string[];
  shareLinkToken?: string;
  isDeleted?: boolean;
  url?: string;
  isEncrypted?: boolean;
  encrypted?: boolean; // 支持两个字段
  decryptFailed?: boolean;
}

interface Breadcrumb {
  id: string | null;
  name: string;
}

type DriveView = 'my' | 'shared' | 'recent' | 'trash';

interface ShareModalProps {
  item: DriveItem;
  onClose: () => void;
  onShare: (itemId: string, share: boolean, permission: string, shareToUsers: string[], shareToGroups: string[]) => Promise<any>;
  onSuccess?: () => void;
  isSubmitting?: boolean;
  setIsSubmitting?: (v: boolean) => void;
}

interface ShareOption {
  id: string;
  name: string;
  type: 'user' | 'group';
}

// 生成分享链接 - 用密钥加密权限信息
const generateShareLink = (token: string, perm: string) => {
  const keys = loadKeysFromStorage();
  const key = keys?.currentKey || localStorage.getItem('encryptionKey') || '';
  const encryptedPerm = key ? encrypt(perm, key) : perm;
  // 使用前端当前域名
  const baseUrl = window.location.origin;
  return `${baseUrl}/drive/shared/${token}#${encryptedPerm}`;
};

const ShareModal: React.FC<ShareModalProps> = ({ item, onClose, onShare, onSuccess }) => {
  const [isShared, setIsShared] = useState(item.isShared || false);
  const [permission, setPermission] = useState(item.sharePermission || 'view');
  const [shareToUsers, setShareToUsers] = useState<string[]>(item.shareToUsers || []);
  const [shareToGroups, setShareToGroups] = useState<string[]>(item.shareToGroups || []);
  const [shareToAll, setShareToAll] = useState(shareToUsers.includes('__all__') || shareToUsers.includes('*'));
  const [shareOptions, setShareOptions] = useState<ShareOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [showLinkModal, setShowLinkModal] = useState(false);
  
  const [shareLink, setShareLink] = useState(item.shareLinkToken ? generateShareLink(item.shareLinkToken, item.sharePermission || 'view') : '');

  useEffect(() => {
    setIsShared(item.isShared || false);
    setPermission(item.sharePermission || 'view');
    setShareToUsers(item.shareToUsers || []);
    setShareToGroups(item.shareToGroups || []);
    setShareToAll(item.shareToUsers?.includes('__all__') || item.shareToUsers?.includes('*') || false);
    setShareLink(item.shareLinkToken ? generateShareLink(item.shareLinkToken, item.sharePermission || 'view') : '');
  }, [item]);

  useEffect(() => {
    const loadOptions = async () => {
      try {
        const result = await drive.getShareOptions();
        if (result.success) {
          const options: ShareOption[] = [
            ...result.data.users.map((u: any) => ({ id: u.id, name: u.name, type: 'user' as const })),
            ...result.data.groups.map((g: any) => ({ id: g.id, name: g.name, type: 'group' as const }))
          ];
          setShareOptions(options);
        }
      } catch (error) {
        console.error('加载共享选项失败:', error);
      }
    };
    loadOptions();
  }, []);

  const handleSave = async () => {
    setLoading(true);
    try {
      // 处理"共享给所有人" - 保存所有私聊好友ID
      let finalShareToUsers = [...shareToUsers];
      if (shareToAll) {
        const allFriendIds = shareOptions.filter(o => o.type === 'user').map(o => o.id);
        finalShareToUsers = allFriendIds;
      } else {
        finalShareToUsers = finalShareToUsers.filter(u => u !== '__all__' && u !== '*');
      }
      
      // 处理"共享给所有群组" - 保存所有群组ID
      let finalShareToGroups = [...shareToGroups];
      if (shareToGroups.includes('__all__')) {
        const allGroupIds = shareOptions.filter(o => o.type === 'group').map(o => o.id);
        finalShareToGroups = allGroupIds;
      } else {
        finalShareToGroups = finalShareToGroups.filter(g => g !== '__all__');
      }
      
      const result = await drive.shareFile(item.id, isShared, permission, finalShareToUsers, finalShareToGroups);
      if (result.success) {
        if (result.shareLink) {
          setShareLink(generateShareLink(result.shareLink, permission));
        }
        toast.success(result.message);
        onClose();
        if (onSuccess) onSuccess();
      }
    } catch (error) {
      console.error('保存共享设置失败:', error);
      toast.error('保存失败');
    }
    setLoading(false);
  };

  const toggleShareToAll = () => {
    const newShareToAll = !shareToAll;
    setShareToAll(newShareToAll);
    if (newShareToAll) {
      const allFriendIds = shareOptions.filter(o => o.type === 'user').map(o => o.id);
      setShareToUsers(allFriendIds);
    }
  };

  const toggleShareToAllGroups = () => {
    const hasAllGroups = shareToGroups.includes('__all__');
    if (hasAllGroups) {
      setShareToGroups(shareToGroups.filter(g => g !== '__all__'));
    } else {
      const allGroupIds = shareOptions.filter(o => o.type === 'group').map(o => o.id);
      setShareToGroups(['__all__', ...allGroupIds]);
    }
  };

  const toggleUser = (id: string) => {
    setShareToAll(false);
    setShareToUsers(prev => 
      prev.includes(id) ? prev.filter(u => u !== id) : [...prev, id]
    );
  };

  const toggleGroup = (id: string) => {
    setShareToGroups(prev => 
      prev.includes('__all__') ? [id] : prev.includes(id) ? prev.filter(g => g !== id) : [...prev, id]
    );
  };

  const userOptions = shareOptions.filter(o => o.type === 'user');
  const groupOptions = shareOptions.filter(o => o.type === 'group');

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content share-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>共享设置</h3>
          <button className="modal-close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="modal-body">
          <div className="share-item-info">
            {item.type === 'folder' ? (
              <Folder size={40} className="share-item-icon folder" />
            ) : (
              <FileIcon size={40} className="share-item-icon file" />
            )}
            <div className="share-item-name">{item.name}</div>
          </div>
          
          <div className="share-toggle">
            <div className="share-toggle-label">
              <Share2 size={18} />
              <span>开启共享</span>
            </div>
            <button 
              className={`share-toggle-btn ${isShared ? 'active' : ''}`}
              onClick={() => setIsShared(!isShared)}
            >
              <div className="share-toggle-slider"></div>
            </button>
          </div>

          {isShared && (
            <>
              <div className="share-permission">
                <div className="share-permission-label">共享权限</div>
                <div className="share-permission-options">
                  <label className={`share-permission-option ${permission === 'view' ? 'active' : ''}`}>
                    <input 
                      type="radio" 
                      name="permission" 
                      value="view"
                      checked={permission === 'view'}
                      onChange={(e) => setPermission(e.target.value)}
                    />
                    <span className="permission-text">
                      <span className="permission-title">只读</span>
                      <span className="permission-desc">对方只能查看和下载</span>
                    </span>
                  </label>
                  <label className={`share-permission-option ${permission === 'edit' ? 'active' : ''}`}>
                    <input 
                      type="radio" 
                      name="permission" 
                      value="edit"
                      checked={permission === 'edit'}
                      onChange={(e) => setPermission(e.target.value)}
                    />
                    <span className="permission-text">
                      <span className="permission-title">允许修改</span>
                      <span className="permission-desc">对方可以下载、改名、删除</span>
                    </span>
                  </label>
                  {item.type === 'folder' && (
                    <label className={`share-permission-option ${permission === 'upload' ? 'active' : ''}`}>
                      <input 
                        type="radio" 
                        name="permission" 
                        value="upload"
                        checked={permission === 'upload'}
                        onChange={(e) => setPermission(e.target.value)}
                      />
                      <span className="permission-text">
                        <span className="permission-title">允许上传</span>
                        <span className="permission-desc">对方可以上传文件到文件夹</span>
                      </span>
                    </label>
                  )}
                </div>
              </div>

              <div className="share-users">
                <div className="share-users-label">
                  <User size={16} />
                  <span>共享给用户</span>
                </div>
                <div className="share-users-list">
                  <label className={`share-user-item ${shareToAll ? 'active' : ''}`}>
                    <input 
                      type="checkbox" 
                      checked={shareToAll}
                      onChange={toggleShareToAll}
                    />
                    <span>所有人</span>
                  </label>
                  {!shareToAll && (
                    userOptions.length === 0 ? (
                      <div className="share-users-empty">暂无其他用户</div>
                    ) : (
                      userOptions.map(user => (
                        <label key={user.id} className={`share-user-item ${shareToUsers.includes(user.id) ? 'active' : ''}`}>
                          <input 
                            type="checkbox" 
                            checked={shareToUsers.includes(user.id)}
                            onChange={() => toggleUser(user.id)}
                          />
                          <span>{user.name}</span>
                        </label>
                      ))
                    )
                  )}
                </div>
              </div>

              <div className="share-groups">
                <div className="share-groups-label">
                  <MessageSquare size={16} />
                  <span>共享给群组</span>
                </div>
                <div className="share-groups-list">
                  <label className={`share-group-item ${shareToGroups.includes('__all__') ? 'active' : ''}`}>
                    <input 
                      type="checkbox" 
                      checked={shareToGroups.includes('__all__')}
                      onChange={toggleShareToAllGroups}
                    />
                    <span>所有群组成员</span>
                  </label>
                  {!shareToGroups.includes('__all__') && (
                    groupOptions.length === 0 ? (
                      <div className="share-groups-empty">暂无群组</div>
                    ) : (
                      groupOptions.map(group => (
                        <label key={group.id} className={`share-group-item ${shareToGroups.includes(group.id) ? 'active' : ''}`}>
                          <input 
                            type="checkbox" 
                            checked={shareToGroups.includes(group.id)}
                            onChange={() => toggleGroup(group.id)}
                          />
                          <span>{group.name}</span>
                        </label>
                      ))
                    )
                  )}
                </div>
              </div>

              {isShared && shareLink && (
                <div className="share-link">
                  <div className="share-link-label">分享链接</div>
                  <div className="share-link-box">
                    <input 
                      type="text" 
                      className="share-link-input"
                      value={shareLink}
                      readOnly
                    />
                    <button className="share-link-copy" onClick={() => {
                      navigator.clipboard.writeText(shareLink);
                    }}>
                      <Link size={16} />
                    </button>
                  </div>
                  <p style={{ marginTop: '8px', fontSize: '12px', color: '#999' }}>
                    链接访问权限与当前共享权限一致
                  </p>
                </div>
              )}
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="drive-btn drive-btn-outline" onClick={onClose}>
            关闭
          </button>
          <button className="drive-btn drive-btn-primary" onClick={handleSave} disabled={loading}>
            {loading ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
};

export const DrivePanel: React.FC = () => {
  const [currentView, setCurrentView] = useState<DriveView>('my');
  const [items, setItems] = useState<DriveItem[]>([]);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [currentPath, setCurrentPath] = useState<Breadcrumb[]>([{ id: null, name: '我的网盘' }]);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [searchTerm, setSearchTerm] = useState('');
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showNewFolderModal, setShowNewFolderModal] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [linkModalItem, setLinkModalItem] = useState<DriveItem | null>(null);
  const [renameItem, setRenameItem] = useState<DriveItem | null>(null);
  const [newName, setNewName] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [menuOpenAbove, setMenuOpenAbove] = useState(false);
  const [shareItem, setShareItem] = useState<DriveItem | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // 缓存每个视图的文件列表
  const [viewCache, setViewCache] = useState<Record<DriveView, { items: DriveItem[]; path: Breadcrumb[]; timestamp: number }>>({
    my: { items: [], path: [{ id: null, name: '我的网盘' }], timestamp: 0 },
    shared: { items: [], path: [{ id: null, name: '与我共享' }], timestamp: 0 },
    recent: { items: [], path: [{ id: null, name: '最近文件' }], timestamp: 0 },
    trash: { items: [], path: [{ id: null, name: '回收站' }], timestamp: 0 },
  });
  const [storageUsed, setStorageUsed] = useState(0);
  const [storageLimit, setStorageLimit] = useState(10 * 1024 * 1024 * 1024); // 默认10GB
  const [isDragging, setIsDragging] = useState(false);
  const [currentFolderPermission, setCurrentFolderPermission] = useState<'view' | 'edit' | 'upload' | null>(null);
  const requestIdRef = useRef<number>(0);
  const uploadCancelRef = useRef<Record<string, boolean>>({});
  const uploadXhrRef = useRef<Record<string, XMLHttpRequest | null>>({});
  
  // 获取当前用户ID
  const currentUserId = React.useMemo(() => {
    try {
      const user = localStorage.getItem('user');
      return user ? JSON.parse(user).id : null;
    } catch {
      return null;
    }
  }, []);

  // 重试上传单个文件
  const retryDriveUpload = async (upload: any) => {
    const parentId = currentPath[currentPath.length - 1]?.id;
    const keys = loadKeysFromStorage();
    const currentKey = keys?.currentKey || localStorage.getItem('encryptionKey') || '';
    const uploadId = upload.id;
    const originalFileName = upload.filename;
    const totalSize = upload.totalSize;
    
    // console.log('[DEBUG] retryDriveUpload 开始, id=', uploadId);
    
    // 清除所有可能的取消状态
    cancelledTasks.delete(uploadId);
    uploadXhrRef.current[uploadId] = null;
    const taskService = TaskService.getInstanceSafe();
    if (taskService) {
      taskService.clearCancelledTask(uploadId);
    }
    
    try {
      let fileToUpload = upload.file;
      let encryptedFileName = originalFileName;
      let isEncrypted = false;
      let actualFileSize = totalSize;
      
      if (currentKey && upload.encrypted) {
        encryptedFileName = encrypt(originalFileName, currentKey);
        const { encrypted } = await encryptFileChunkedAsync(upload.file, currentKey, () => {});
        fileToUpload = new File([encrypted], encryptedFileName, { type: 'application/octet-stream' });
        actualFileSize = fileToUpload.size;
        isEncrypted = true;
      }
      
      // 先设置为上传中，进度0
      updateGlobalUpload({ id: uploadId, filename: originalFileName, progress: 0, status: 'uploading', type: 'upload', totalSize, loadedSize: 0, createdAt: Date.now() });
      // console.log('[DEBUG] retryDriveUpload 设置状态为 uploading');
      
      const xhrRef = { current: null as XMLHttpRequest | null };
      
      await drive.uploadFile(fileToUpload, parentId || null, (progress) => {
        // console.log('[DEBUG] retryDriveUpload 进度回调, progress=', progress);
        const globalTask = getGlobalUploads().find(t => t.id === uploadId);
        if (globalTask?.status === 'cancelled') {
          // console.log('[DEBUG] retryDriveUpload 检测到 cancelled, abort xhr');
          if (xhrRef.current) {
            xhrRef.current.abort();
          }
          return;
        }
        const progressValue = Math.round(progress);
        // console.log('[DEBUG] retryDriveUpload 更新进度, progressValue=', progressValue);
        updateGlobalUpload({ id: uploadId, filename: originalFileName, progress: progressValue, status: 'uploading', type: 'upload', totalSize, loadedSize: Math.round(totalSize * progressValue / 100), createdAt: Date.now() });
        // console.log('[DEBUG] retryDriveUpload 更新后的任务=', getGlobalUploads().find(t => t.id === uploadId));
      }, isEncrypted, encryptedFileName, actualFileSize, xhrRef);
      
      // console.log('[DEBUG] retryDriveUpload 上传完成');
      const globalTask = getGlobalUploads().find(t => t.id === uploadId);
      if (globalTask?.status === 'cancelled') {
        return;
      }
      
      updateGlobalUpload({ id: uploadId, filename: originalFileName, progress: 100, status: 'completed', type: 'upload', totalSize, loadedSize: totalSize, createdAt: Date.now() });
      toast.success('上传成功', originalFileName);
      await loadFiles();
    } catch (error: any) {
      console.error('上传失败:', error);
      const globalTask = getGlobalUploads().find(t => t.id === uploadId);
      if (globalTask?.status === 'cancelled') {
        return;
      }
      updateGlobalUpload({ id: uploadId, filename: originalFileName, progress: 0, status: 'error', type: 'upload', totalSize, loadedSize: 0, createdAt: Date.now() });
      toast.error('上传失败', `${originalFileName}: ${error.message || '请重试'}`);
    }
  };

  // 监听全局上传状态变化，处理重试
  useEffect(() => {
    let isProcessing = false;
    let currentUploadId: string | null = null;
    
    const checkRetryUploads = async () => {
      // 防止并发处理
      if (isProcessing) return;
      
      const uploads = getGlobalUploads();
      const pendingUploads = uploads.filter(u => u.status === 'pending' && u.file && u.id.startsWith('drive_'));
      
      // 如果有正在处理的任务，跳过
      if (currentUploadId && isProcessing) return;
      
      for (const upload of pendingUploads) {
        // 跳过正在处理的任务
        if (currentUploadId === upload.id) continue;
        
        isProcessing = true;
        currentUploadId = upload.id;
        
        // console.log('[DEBUG] 检测到pending状态任务:', upload.id, 'file=', !!upload.file);
        // 清除取消标记
        const taskService = TaskService.getInstanceSafe();
        if (taskService) {
          taskService.clearCancelledTask(upload.id);
        }
        
        try {
          await retryDriveUpload(upload);
        } finally {
          currentUploadId = null;
          isProcessing = false;
        }
      }
    };
    
    const unsubscribe = subscribeGlobalUploads(checkRetryUploads);
    return () => unsubscribe();
  }, [currentPath]);

  const handleUpload = async (files: FileList) => {
    const keys = loadKeysFromStorage();
    const currentKey = keys?.currentKey || localStorage.getItem('encryptionKey') || '';
    const parentId = currentPath[currentPath.length - 1]?.id;
    
    // 使用 TaskService 统一处理上传
    for (let i = 0; i < files.length; i++) {
      const uploadId = `drive_${Date.now()}_${i}`;
      const originalFileName = files[i].name;
      const totalSize = files[i].size;
      
      // 使用 TaskService 添加上传任务（TaskService 会自动更新 globalUploads）
      const taskService = TaskService.getInstanceSafe();
      if (taskService) {
        // 构造带 parentId 的 endpoint
        const endpoint = parentId ? `/api/drive/upload?parentId=${parentId}` : '/api/drive/upload';
        taskService.addUploadTask({
          filename: originalFileName,
          file: files[i],
          totalSize: totalSize,
          attachmentId: uploadId,
          isEncrypted: !!currentKey,
          customEndpoint: endpoint
        });
      }
    }
    setShowUploadModal(false);
  };

  const loadFiles = useCallback(async () => {
    const currentRequestId = ++requestIdRef.current;
    setIsLoading(true);
    try {
      const parentId = currentPath[currentPath.length - 1]?.id;
      
      // 并行获取存储信息和文件列表
      const promises: Promise<any>[] = [drive.getFiles(parentId, currentView)];
      if (currentView === 'my') {
        promises.push(drive.getStorage());
      }
      
      const [filesResult, storageResult] = await Promise.all(promises);
      
      // 处理存储信息
      if (currentView === 'my' && storageResult?.success) {
        setStorageUsed(storageResult.data.used);
        setStorageLimit(storageResult.data.limit);
      }
      
      const result = filesResult;
      
      if (currentRequestId !== requestIdRef.current) {
        return;
      }
      
      if (result.success) {
        // 获取当前密钥 - 使用聊天相同的逻辑
        const keys = loadKeysFromStorage();
        
        
        const formattedItems = result.data.map((item: any) => {
          let decryptedName = item.name;
          const isEncrypted = item.isEncrypted === 1 || item.isEncrypted === true || item.is_encrypted === 1 || item.is_encrypted === true;
          // 检测文件名是否以加密前缀开头（CryptoJS AES 加密后的文件名也需解密）
          const nameStartsWithAES = item.name && item.name.startsWith('U2FsdGVkX1');
          
          let decryptFailed = false;
          let usedKey = null;

          // 解密文件名：要么 isEncrypted 标记为 true，要么文件名以 AES 加密前缀开头
          if ((isEncrypted || nameStartsWithAES) && keys) {
            // 尝试所有密钥
            const keysToTry = [keys.currentKey, ...(keys.legacyKeys || [])];
            for (const key of keysToTry) {
              if (!key) continue;
              const decrypted = decrypt(item.name, key);
              if (decrypted && decrypted !== item.name) {
                decryptedName = decrypted;
                usedKey = key;
                decryptFailed = false;
                
                break;
              }
            }
            if (!usedKey) {
              decryptFailed = true;
              decryptedName = '🔒 文件解密失败，无法显示内容（请检查密钥）';
              
            }
          } else if ((isEncrypted || nameStartsWithAES) && !keys) {
            decryptFailed = true;
            decryptedName = '🔒 加密文件（请先设置密钥）';
          } else {
            // 非加密文件，使用原始名称
            
          }
          
          return {
            id: item.id,
            name: decryptedName,
            usedKey: usedKey,
            type: item.type,
            size: item.size,
            modified: getServerTimestamp(item.updatedAt || item.createdAt || item.updated_at || item.created_at),
            ownerId: item.ownerId || item.owner_id,
            ownerName: item.ownerId === currentUserId || item.owner_id === currentUserId 
              ? '我' 
              : (item.ownerName || item.owner_name || '未知'),
            parentId: item.parentId || item.parent_id,
            isShared: item.isShared === 1 || item.is_shared === 1,
            sharePermission: item.sharePermission || item.share_permission || 'view',
            shareToUsers: item.shareToUsers || (item.share_to_users ? JSON.parse(item.share_to_users) : []),
            shareToGroups: item.shareToGroups || (item.share_to_groups ? JSON.parse(item.share_to_groups) : []),
            shareLinkToken: item.shareLinkToken || item.share_link_token,
            isDeleted: item.isDeleted === 1 || item.is_deleted === 1,
            url: item.url,
            isEncrypted: isEncrypted,
            encrypted: isEncrypted,
            decryptFailed: decryptFailed,
          };
        });
        setItems(formattedItems);
        
        // 监听网盘文件刷新事件
        window.addEventListener('refreshDriveFiles', loadFiles);
        
        // Set current folder permission for shared view
        if (currentView === 'shared' && result.data.length > 0) {
          // Check if this folder was shared with upload permission
          const firstItem = result.data[0];
          if (firstItem.parent_share_permission) {
            setCurrentFolderPermission(firstItem.parent_share_permission);
          } else if (parentId === null && currentPath.length === 1) {
            // Root of shared view - check first item's share_permission
            const sharedItems = result.data.filter((item: any) => item.is_shared === 1);
            if (sharedItems.length > 0) {
              setCurrentFolderPermission(sharedItems[0].share_permission || 'view');
            }
          }
        } else if (currentView !== 'shared') {
          setCurrentFolderPermission(null);
        }
      }
    } catch (error) {
      console.error('加载文件失败:', error);
    } finally {
      setIsLoading(false);
    }
  }, [currentPath, currentView]);

  const lastLoadRef = useRef<string>('');

  useEffect(() => {
    const loadKey = JSON.stringify({ path: currentPath.map(p => p.id), view: currentView });
    if (lastLoadRef.current === loadKey) return;
    lastLoadRef.current = loadKey;
    loadFiles();
  }, [loadFiles]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpenId(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleCreateFolder = async () => {
    if (!newFolderName.trim() || isSubmitting) return;
    setIsSubmitting(true);
    const keys = loadKeysFromStorage();
    const currentKey = keys?.currentKey || localStorage.getItem('encryptionKey') || '';
    
    try {
      const parentId = currentPath[currentPath.length - 1]?.id;
      // 有密钥才加密，没有密钥不加密
      const nameToUse = currentKey ? encrypt(newFolderName, currentKey) : newFolderName;
      const isEncrypted = !!currentKey;
      const result = await drive.createFolder(nameToUse, parentId || null, isEncrypted);
      if (result.success) {
        toast.success('创建成功');
      } else {
        toast.error('创建失败', result.message);
      }
      await loadFiles();
    } catch (error: any) {
      console.error('创建文件夹失败:', error);
      toast.error('创建失败', error.message);
    } finally {
      setNewFolderName('');
      setShowNewFolderModal(false);
      setIsSubmitting(false);
    }
  };

  const handleRename = async () => {
    if (!renameItem || !newName.trim() || isSubmitting) return;
    setIsSubmitting(true);
    try {
      // 如果文件是加密的，新名称需要加密
      let finalName = newName.trim();
      if (renameItem.isEncrypted && !newName.startsWith('U2FsdGVkX')) {
        const keys = loadKeysFromStorage();
        if (keys?.currentKey) {
          finalName = encrypt(newName.trim(), keys.currentKey);
        }
      }
      
      let result;
      // 如果在分享视图，使用 sharedRename
      if (currentView === 'shared' && renameItem.shareLinkToken) {
        result = await drive.sharedRename(renameItem.shareLinkToken, renameItem.id, finalName);
      } else {
        result = await drive.renameFile(renameItem.id, finalName);
      }
      
      if (result.success) {
        toast.success('重命名成功');
      } else {
        toast.error('重命名失败', result.message);
      }
      await loadFiles();
    } catch (error: any) {
      console.error('重命名失败:', error);
      toast.error('重命名失败', error.message);
    } finally {
      setNewName('');
      setRenameItem(null);
      setShowRenameModal(false);
      setIsSubmitting(false);
    }
  };

  const handleOpenRename = (item: DriveItem) => {
    setRenameItem(item);
    setNewName(item.name);
    setShowRenameModal(true);
    setMenuOpenId(null);
  };

  const handleDelete = async () => {
    if (selectedItems.size === 0 || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const ids = Array.from(selectedItems);
      const res = await apiFetch(API.drive.batchDelete, {
        method: 'POST',
        body: JSON.stringify({ ids })
      });
      const data = await res.json();
      if (data.success) {
        toast.success(data.message || '删除成功');
        await loadFiles();
      } else {
        toast.error(data.message || '删除失败');
      }
    } catch (error: any) {
      console.error('删除失败:', error);
      toast.error('删除失败');
    } finally {
      setSelectedItems(new Set());
      setIsSubmitting(false);
    }
  };

  const handleRestore = async () => {
    if (selectedItems.size === 0) return;
    let failedCount = 0;
    try {
      for (const id of selectedItems) {
        try {
          await drive.restoreFile(id);
        } catch (error: any) {
          console.error('恢复失败:', id, error);
          failedCount++;
        }
      }
      await loadFiles();
      if (failedCount > 0) {
        toast.error('恢复部分失败', `恢复了 ${selectedItems.size - failedCount} 个文件，${failedCount} 个失败`);
      }
    } catch (error: any) {
      console.error('恢复失败:', error);
    }
    setSelectedItems(new Set());
  };

  const handlePermanentDelete = async () => {
    if (selectedItems.size === 0) return;
    try {
      const ids = Array.from(selectedItems);
      const res = await apiFetch(API.drive.batchPermanentDelete, {
        method: 'POST',
        body: JSON.stringify({ ids })
      });
      const data = await res.json();
      if (data.success) {
        toast.success(data.message || '删除成功');
        await loadFiles();
      } else {
        toast.error(data.message || '删除失败');
      }
    } catch (error: any) {
      console.error('永久删除失败:', error);
      toast.error('删除失败');
    }
    setSelectedItems(new Set());
  };

  const handleEmptyTrash = async () => {
    if (!await showConfirm({ title: '清空回收站', message: '确定要清空回收站吗？此操作不可恢复！', type: 'danger' })) return;
    try {
      const res = await apiFetch(API.drive.emptyTrash, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        toast.success(data.message || '已清空回收站');
        await loadFiles();
      } else {
        toast.error(data.message || '删除失败');
      }
    } catch (error: any) {
      console.error('清空回收站失败:', error);
      toast.error('删除失败');
    }
  };

  const handleShare = async (itemId: string, share: boolean, permission: string = 'view', shareToUsers: string[] = [], shareToGroups: string[] = []) => {
    try {
      await drive.shareFile(itemId, share, permission, shareToUsers, shareToGroups);
      await loadFiles();
    } catch (error: any) {
      console.error('共享失败:', error);
      toast.error('共享失败', error.message);
    }
  };

  const handleDownload = async (item: DriveItem) => {
    // 如果文件已加密但解密失败，不能下载
    if (item.isEncrypted && item.decryptFailed) {
      toast.warning('解密失败', '无法下载加密文件，请检查密钥是否正确');
      return;
    }
    
    // 使用解密后的名称（显示的名称就是解密后的）
    // 如果是加密文件，item.name 已经是解密后的名称
    setMenuOpenId(null);
    const downloadId = `drive_download_${Date.now()}`;
    const downloadName = item.type === 'folder' ? `${item.name}.zip` : item.name;
    const totalSize = item.size || 0;
    
    // 使用 TaskService 处理下载
    const taskService = TaskService.getInstanceSafe();
    if (taskService) {
      // 先添加到 globalUploads 显示
      addGlobalUpload({
        id: downloadId,
        filename: downloadName,
        originalName: downloadName,
        progress: 0,
        status: 'pending' as const,
        type: 'download' as const,
        totalSize,
        size: totalSize,
        loadedSize: 0,
        createdAt: Date.now(),
        encrypted: item.isEncrypted,
        isEncrypted: item.isEncrypted,
        speed: 0,
        attachmentId: downloadId,
      });
      
      // 使用 TaskService 添加下载任务
      taskService.addDownloadTask({
        filename: downloadName,
        url: item.id,
        totalSize: totalSize,
        isEncrypted: item.isEncrypted,
        senderId: item.ownerId,
        originalSize: totalSize,
        attachmentId: downloadId,
        encrypted: item.isEncrypted, // 额外传递 encrypted 字段（用于 TaskService 解密判断）
        customEndpoint: '/api/drive/files', // 用于判断是网盘下载
      });
    }
  };

  const handleGetLink = (item: DriveItem) => {
    const key = (() => {
      const keys = loadKeysFromStorage();
      return keys?.currentKey || localStorage.getItem('encryptionKey') || '';
    })();
    // 用密钥对权限信息进行加密
    const permInfo = item.sharePermission || 'view';
    const encryptedPerm = key ? encrypt(permInfo, key) : permInfo;
    // 使用前端当前的 URL
    const baseUrl = window.location.origin;
    // 优先使用 shareLinkToken，如果没有则使用 item.id
    const linkToken = item.shareLinkToken || item.id;
    const link = `${baseUrl}/drive/shared/${linkToken}${key ? '#' + encryptedPerm : ''}`;
    setLinkModalItem(item);
    setShowLinkModal(true);
    setMenuOpenId(null);
  };

  const renderMenu = (item: DriveItem) => {
    if (menuOpenId !== item.id) return null;
    const isSharedView = currentView === 'shared';
    const permission = item.sharePermission || currentFolderPermission;
    const isUploadOnly = permission === 'upload';
    const canEdit = permission === 'edit';
    
    return (
      <div className="drive-item-menu" ref={menuRef} style={{
        top: menuOpenAbove ? 'auto' : 40,
        bottom: menuOpenAbove ? 'calc(100% - 40px)' : 'auto'
      }}>
        {isSharedView && isUploadOnly ? (
          <div className="drive-menu-item drive-menu-item-disabled" style={{ cursor: 'default', opacity: 0.6 }}>
            <Upload size={14} />
            <span>只有上传权限，无法操作文件</span>
          </div>
        ) : (
          <>
            {currentView !== 'trash' && (
              <button className="drive-menu-item" onClick={() => handleDownload(item)}>
                <Download size={14} />
                <span>下载</span>
              </button>
            )}
            {!isSharedView && currentView !== 'trash' && (
              <>
                <button className="drive-menu-item" onClick={() => { setShareItem(item); setMenuOpenId(null); }}>
                  <Share2 size={14} />
                  <span>共享</span>
                </button>
                <button className="drive-menu-item" onClick={() => handleOpenRename(item)}>
                  <Edit size={14} />
                  <span>重命名</span>
                </button>
                <button className="drive-menu-item" onClick={() => handleGetLink(item)}>
                  <Link size={14} />
                  <span>获取链接</span>
                </button>
              </>
            )}
            {isSharedView && canEdit && (
              <>
                <button className="drive-menu-item" onClick={() => handleOpenRename(item)}>
                  <Edit size={14} />
                  <span>重命名</span>
                </button>
              </>
            )}
          </>
        )}
        {currentView === 'trash' && (
          <button className="drive-menu-item" onClick={async () => {
            try {
              await drive.restoreFile(item.id);
              await loadFiles();
            } catch (error: any) {
              console.error('恢复失败:', error);
              toast.error('恢复失败', error.message);
            }
            setMenuOpenId(null);
          }}>
            <RotateCcw size={14} />
            <span>还原</span>
          </button>
        )}
        {currentView === 'trash' && (
          <button className="drive-menu-item drive-menu-item-danger" onClick={async () => {
            if (await showConfirm({ title: '确认', message: '确定要永久删除吗？此操作不可恢复！', type: 'danger' })) {
              try {
                await drive.permanentDelete(item.id);
                await loadFiles();
              } catch (error: any) {
                console.error('永久删除失败:', error);
                toast.error('永久删除失败', error.message);
              }
            }
            setMenuOpenId(null);
          }}>
            <Trash2 size={14} />
            <span>永久删除</span>
          </button>
        )}
        {!isSharedView && currentView !== 'trash' && (
          <button className="drive-menu-item drive-menu-item-danger" onClick={async () => {
            if (!(await showConfirm({ title: '确认', message: '确定要删除吗？', type: 'danger' }))) {
              setMenuOpenId(null);
              return;
            }
            try {
              await drive.deleteFile(item.id);
              await loadFiles();
              toast.success('删除成功');
            } catch (error: any) {
              console.error('删除失败:', error);
              toast.error('删除失败', error.message);
            }
            setMenuOpenId(null);
          }}>
            <Trash2 size={14} />
            <span>删除</span>
          </button>
        )}
        {isSharedView && canEdit && (
          <button className="drive-menu-item drive-menu-item-danger" onClick={async () => {
            try {
              await drive.deleteFile(item.id);
              await loadFiles();
            } catch (error: any) {
              console.error('删除失败:', error);
              toast.error('删除失败', error.message);
            }
            setMenuOpenId(null);
          }}>
            <Trash2 size={14} />
            <span>删除</span>
          </button>
        )}
      </div>
    );
  };

  const formatSize = (bytes?: number) => {
    if (!bytes) return '-';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  };

  const formatDate = (date: Date | number | string) => {
    if (date instanceof Date) {
      return formatTimestamp(date.getTime(), 'time');
    }
    return formatTimestamp(Number(date), 'time');
  };

  const handleFolderClick = (folder: DriveItem) => {
    // Set permission when entering a shared folder
    if (currentView === 'shared' && folder.sharePermission) {
      setCurrentFolderPermission(folder.sharePermission);
    }
    setCurrentPath([...currentPath, { id: folder.id, name: folder.name }]);
    setSelectedItems(new Set());
  };

  const handleBreadcrumbClick = (index: number) => {
    if (index < currentPath.length - 1) {
      setCurrentPath(currentPath.slice(0, index + 1));
      setSelectedItems(new Set());
      if (currentView === 'shared' && index === 0) {
        setCurrentFolderPermission(null);
      }
    }
  };

  const getBreadcrumbPath = () => {
    if (currentView === 'my') {
      return '/' + currentPath.map(c => c.name).join('/');
    } else if (currentView === 'shared') {
      return '/与我共享' + (currentPath.length > 1 ? currentPath.slice(1).map(c => '/' + c.name).join('') : '');
    } else if (currentView === 'recent') {
      return '/最近新增';
    } else if (currentView === 'trash') {
      return '/回收站';
    }
    return '/';
  };

  const renderBreadcrumb = () => {
    if (currentView === 'trash' || currentView === 'recent') {
      return <span className="drive-breadcrumb-path">{getBreadcrumbPath()}</span>;
    }
    
    return (
      <div className="drive-breadcrumb">
        {currentPath.map((item, index) => (
          <span key={item.id || 'root'} className="drive-breadcrumb-item">
            <span 
              className="drive-breadcrumb-link"
              onClick={() => handleBreadcrumbClick(index)}
            >
              {item.name}
            </span>
            {index < currentPath.length - 1 && <span className="drive-breadcrumb-sep">/</span>}
          </span>
        ))}
      </div>
    );
  };

  const handleSelectItem = (id: string) => {
    const newSelected = new Set(selectedItems);
    if (newSelected.has(id)) newSelected.delete(id);
    else newSelected.add(id);
    setSelectedItems(newSelected);
  };

  const handleSelectAll = () => {
    if (selectedItems.size === filteredItems.length) setSelectedItems(new Set());
    else setSelectedItems(new Set(filteredItems.map(i => i.id)));
  };

  const currentFolderId = currentPath[currentPath.length - 1]?.id;

  const filteredItems = items.filter(item => {
    
    if (searchTerm && !item.name.toLowerCase().includes(searchTerm.toLowerCase())) return false;
    if (currentView === 'trash') {
      return item.isDeleted;
    }
    if (!item.isDeleted) return true;
    return false;
  });

  const goBack = () => {
    if (currentPath.length > 1) handleBreadcrumbClick(currentPath.length - 2);
  };

  return (
    <div 
      className="drive-panel"
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
          if (currentView !== 'trash') {
            setIsDragging(true);
          }
        }}
      onDragLeave={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
      }}
      onDrop={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
        const files = e.dataTransfer.files;
        if (files.length > 0 && currentView !== 'trash') {
          if (currentView === 'shared' && currentFolderPermission !== 'upload') {
            toast.warning('权限不足', '只有共享权限为"允许上传"时才能上传文件');
            return;
          }
          toast.info('正在上传', `${files.length} 个文件...`);
          await handleUpload(files);
        }
      }}
    >
      {/* 左侧边栏 */}
      <div className="drive-sidebar">
        {/* 存储空间 */}
        <div className="drive-storage">
          <div className="drive-storage-header">
            <span className="drive-storage-label">存储空间</span>
          </div>
          <div className="drive-storage-bar">
            <div className="drive-storage-fill" style={{ width: `${Math.min((storageUsed / storageLimit) * 100, 100)}%` }}></div>
          </div>
          <span className="drive-storage-text">{formatSize(storageUsed)} / {formatSize(storageLimit)}</span>
        </div>

        {/* 导航菜单 */}
        <nav className="drive-nav">
          <button
            onClick={() => { setCurrentView('my'); setCurrentPath([{ id: null, name: '我的网盘' }]); }}
            className={`drive-nav-item ${currentView === 'my' ? 'active' : ''}`}
          >
            <HardDrive size={20} />
            <span>个人空间</span>
          </button>
          
          <button
            onClick={() => { setCurrentView('shared'); setCurrentPath([{ id: null, name: '与我共享' }]); }}
            className={`drive-nav-item ${currentView === 'shared' ? 'active' : ''}`}
          >
            <Users size={20} />
            <span>与我共享</span>
          </button>
          
          <button
            onClick={() => { setCurrentView('recent'); setCurrentPath([{ id: null, name: '最近新增' }]); }}
            className={`drive-nav-item ${currentView === 'recent' ? 'active' : ''}`}
          >
            <Clock size={20} />
            <span>最近新增</span>
          </button>
          
          <button
            onClick={() => { setCurrentView('trash'); setCurrentPath([{ id: null, name: '回收站' }]); }}
            className={`drive-nav-item ${currentView === 'trash' ? 'active' : ''}`}
          >
            <Trash2 size={20} />
            <span>回收站</span>
          </button>
        </nav>
      </div>

      {/* 右侧主内容区 */}
      <div className="drive-main">
        {/* 顶部工具栏 */}
        <div className="drive-toolbar">
          <div className="drive-toolbar-left">
            {currentPath.length > 1 && (
              <button className="drive-back-btn" onClick={goBack}>
                <ArrowLeft size={18} />
              </button>
            )}
            {renderBreadcrumb()}
          </div>

          {/* 选中文件时显示的工具栏 */}
          {selectedItems.size > 0 ? (
            <div className="drive-toolbar-center">
              <span className="drive-selected-count">已选择 {selectedItems.size} 项</span>
               <button className="drive-btn drive-btn-primary" onClick={() => {
				  // 批量下载 - 实现下载功能
				  const selectedList = filteredItems.filter(item => selectedItems.has(item.id));
				  selectedList.forEach(item => handleDownload(item));
				}}>
                <Download size={16} />
                下载
              </button>
              {currentView === 'trash' ? (
                <>
                  <button className="drive-btn drive-btn-outline" onClick={handleRestore}>
                    <RotateCcw size={16} />
                    还原
                  </button>
                  <button className="drive-btn drive-btn-danger" onClick={handlePermanentDelete}>
                    <Trash2 size={16} />
                    永久删除
                  </button>
                </>
              ) : (
                <button className="drive-btn drive-btn-danger" onClick={handleDelete}>
                  <Trash2 size={16} />
                  删除
                </button>
              )}
              <button className="drive-btn drive-btn-outline" onClick={() => setSelectedItems(new Set())}>
                <X size={16} />
                取消
              </button>
            </div>
          ) : (
            <div className="drive-toolbar-right">
              <div className="drive-search">
                <Search size={16} className="drive-search-icon" />
                <input
                  type="text"
                  placeholder="搜索文件..."
                  className="drive-search-input"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
              {currentView === 'trash' && (
              	<button className="drive-btn drive-btn-danger" onClick={handleEmptyTrash} style={{ marginLeft: 'auto' }}>
			      <Trash2 size={14} />
			      清空回收站
			    </button>
			  )}
              
              {currentView !== 'trash' && (
                <>
                  <div className="drive-view-toggle">
                    <button 
                      className={`drive-view-btn ${viewMode === 'list' ? 'active' : ''}`}
                      onClick={() => setViewMode('list')}
                      title="列表视图"
                    >
                      <List size={16} />
                    </button>
                    <button 
                      className={`drive-view-btn ${viewMode === 'grid' ? 'active' : ''}`}
                      onClick={() => setViewMode('grid')}
                      title="网格视图"
                    >
                      <LayoutGrid size={16} />
                    </button>
                  </div>
                  {currentView !== 'shared' && (
                    <button className="drive-btn drive-btn-outline" onClick={() => setShowNewFolderModal(true)}>
                      <FolderPlus size={16} />
                      新建文件夹
                    </button>
                  )}
                  {(currentView !== 'shared' || currentFolderPermission === 'upload') && (
                    <button className="drive-btn drive-btn-primary" onClick={() => setShowUploadModal(true)}>
                      <Upload size={16} />
                      上传
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* 文件列表 */}
        <div className={`drive-content ${isDragging ? 'drive-panel-dragging' : ''}`}>
          {isLoading ? (
            <div className="drive-empty">
              <div className="loading-spinner large"></div>
              <p className="drive-empty-title">加载中...</p>
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="drive-empty">
              <Folder size={64} className="drive-empty-icon" />
              <p className="drive-empty-title">暂无文件</p>
              <p className="drive-empty-text">点击上方"上传"按钮添加文件</p>
            </div>
          ) : (
            <div className="drive-list">
              {/* 表头 */}
              <div className="drive-list-header">
                <div className="drive-list-col drive-list-col-check">
                  <button
                    onClick={handleSelectAll}
                    className={`drive-checkbox ${selectedItems.size === filteredItems.length && filteredItems.length > 0 ? 'checked' : ''}`}
                  >
                    {selectedItems.size === filteredItems.length && filteredItems.length > 0 && <Check size={12} />}
                  </button>
                </div>
                <div className="drive-list-col drive-list-col-name">名称</div>
                <div className="drive-list-col drive-list-col-owner">所有者</div>
                <div className="drive-list-col drive-list-col-time">修改时间</div>
                <div className="drive-list-col drive-list-col-size">大小</div>
                <div className="drive-list-col drive-list-col-action"></div>
              </div>

              {/* 文件列表 */}
              <div className={`drive-list-body ${viewMode === 'grid' ? 'drive-grid-view' : ''}`}>
                {filteredItems.map(item => (
                  viewMode === 'grid' ? (
                    <div
                      key={item.id}
                      data-item-id={item.id}
                      className={`drive-grid-item ${selectedItems.has(item.id) ? 'selected' : ''}`}
                    >
                      <button
                        onClick={(e) => { e.stopPropagation(); handleSelectItem(item.id); }}
                        className={`drive-checkbox drive-grid-checkbox ${selectedItems.has(item.id) ? 'checked' : ''}`}
                      >
                        {selectedItems.has(item.id) && <Check size={12} />}
                      </button>
                      <div className="drive-grid-item-content" onClick={() => item.type === 'folder' && handleFolderClick(item)}>
                        <div className="drive-grid-item-icon">
                          {item.type === 'folder' ? (
                            <Folder size={48} className="drive-item-icon drive-item-folder" />
                          ) : (
                            <FileIcon size={48} className="drive-item-icon drive-item-file" />
                          )}
                        </div>
                        <span className="drive-item-name" title={item.name}>{item.name}</span>
                        <span className="drive-item-size">{item.type === 'folder' ? '-' : formatSize(item.size)}</span>
                      </div>
                    </div>
                  ) : (
                    <div
                      key={item.id}
                      data-item-id={item.id}
                      className={`drive-list-row ${selectedItems.has(item.id) ? 'selected' : ''}`}
                    >
                      <div className="drive-list-col drive-list-col-check">
                        <button
                        onClick={() => handleSelectItem(item.id)}
                        className={`drive-checkbox ${selectedItems.has(item.id) ? 'checked' : ''}`}
                      >
                        {selectedItems.has(item.id) && <Check size={12} />}
                      </button>
                    </div>
                    <div className="drive-list-col drive-list-col-name">
                      {item.type === 'folder' ? (
                        <Folder
                          size={24}
                          className="drive-item-icon drive-item-folder"
                          style={{ cursor: 'pointer' }}
                          onClick={(e) => { e.stopPropagation(); handleFolderClick(item); }}
                        />
                      ) : (
                        <FileIcon size={24} className="drive-item-icon drive-item-file" />
                      )}
                      <span 
                        className="drive-item-name" 
                        style={{ cursor: item.type === 'folder' ? 'pointer' : 'default' }}
                        onClick={(e) => { 
                          e.stopPropagation(); 
                          if (item.type === 'folder') handleFolderClick(item); 
                        }}
                        title={item.type === 'folder' ? '点击进入文件夹' : ''}
                      >
                        {item.name}
                      </span>
                      {item.isShared && (
                        <span className="drive-item-shared">共享</span>
                      )}
                    </div>
                    <div className="drive-list-col drive-list-col-owner">
                      {item.ownerName}
                    </div>
                    <div className="drive-list-col drive-list-col-time">
                      {formatDate(item.modified)}
                    </div>
                    <div className="drive-list-col drive-list-col-size">
                      {item.type === 'folder' ? '-' : formatSize(item.size)}
                    </div>
                    <div className="drive-list-col drive-list-col-action" style={{ position: 'relative' }}>
                      <button 
                        className="drive-more-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (menuOpenId === item.id) {
                            setMenuOpenId(null);
                          } else {
                            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                            const viewportHeight = window.innerHeight;
                            const menuHeight = 250;
                            
                            // 检测是否需要向上展开（下方空间不足）
                            const openAbove = rect.bottom + menuHeight > viewportHeight - 20;
                            setMenuOpenAbove(openAbove);
                            setMenuOpenId(item.id);
                          }
                        }}
                      >
                        <MoreVertical size={16} />
                      </button>
                      {renderMenu(item)}
                    </div>
                  </div>
                )
              ))}
              </div>
            </div>
          )}
        </div>

        {/* 底部状态栏 */}
        <div className="drive-status">
          已选择 {selectedItems.size} 项，共 {filteredItems.length} 个项目
        </div>
      </div>

      {/* 新建文件夹弹窗 */}
      {showNewFolderModal && (
        <div className="modal-overlay" onClick={() => setShowNewFolderModal(false)}>
          <div className="modal-content drive-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>新建文件夹</h3>
              <button className="modal-close" onClick={() => setShowNewFolderModal(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <input
                type="text"
                className="drive-input"
                placeholder="请输入文件夹名称"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleCreateFolder()}
                autoFocus
              />
            </div>
            <div className="modal-footer">
              <button className="drive-btn drive-btn-outline" onClick={() => setShowNewFolderModal(false)} disabled={isSubmitting}>
                取消
              </button>
              <button
                className="drive-btn drive-btn-primary"
                onClick={handleCreateFolder}
                disabled={!newFolderName.trim() || isSubmitting}
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 改名弹窗 */}
      {showRenameModal && renameItem && (
        <div className="modal-overlay" onClick={() => setShowRenameModal(false)}>
          <div className="modal-content drive-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>重命名</h3>
              <button className="modal-close" onClick={() => setShowRenameModal(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <input
                type="text"
                className="drive-input"
                placeholder="请输入新名称"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleRename()}
                autoFocus
              />
            </div>
            <div className="modal-footer">
              <button className="drive-btn drive-btn-outline" onClick={() => setShowRenameModal(false)} disabled={isSubmitting}>
                取消
              </button>
              <button
                className="drive-btn drive-btn-primary"
                onClick={handleRename}
                disabled={!newName.trim() || newName === renameItem.name || isSubmitting}
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 上传弹窗 */}
      {showUploadModal && (
        <div className="modal-overlay" onClick={() => setShowUploadModal(false)}>
          <div className="modal-content drive-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>上传文件</h3>
              <button className="modal-close" onClick={() => setShowUploadModal(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <div 
                className="drive-upload-zone"
                onDragOver={(e) => { e.preventDefault(); }}
                onDrop={async (e) => {
                  e.preventDefault();
                  // Check upload permission in shared view
                  if (currentView === 'shared' && currentFolderPermission !== 'upload') {
                    toast.warning('权限不足', '只有共享权限为"允许上传"时才能上传文件');
                    return;
                  }
                  const files = e.dataTransfer.files;
                  if (files.length > 0) {
                    await handleUpload(files);
                  }
                }}
              >
                <Upload size={48} className="drive-upload-icon" />
                <p className="drive-upload-text">将文件拖放到此处上传</p>
                <p className="drive-upload-hint">或者</p>
                <label className="drive-btn drive-btn-outline drive-upload-btn">
                  选择文件
                  <input 
                    type="file" 
                    multiple 
                    className="hidden" 
                    ref={fileInputRef}
                    onChange={async (e) => {
                      // Check upload permission in shared view
                      if (currentView === 'shared' && currentFolderPermission !== 'upload') {
                        toast.warning('权限不足', '只有共享权限为"允许上传"时才能上传文件');
                        return;
                      }
                      const files = e.target.files;
                      if (files && files.length > 0) {
                        await handleUpload(files);
                      }
                    }}
                  />
                </label>
              </div>
            </div>
            <div className="modal-footer">
              <button className="drive-btn drive-btn-outline" onClick={() => setShowUploadModal(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 共享弹窗 */}
      {shareItem && (
        <ShareModal 
          item={shareItem} 
          onClose={() => setShareItem(null)} 
          onShare={handleShare}
          onSuccess={() => loadFiles()}
        />
      )}

      {/* 链接弹窗 */}
      {showLinkModal && linkModalItem && (
        <div className="modal-overlay" onClick={() => setShowLinkModal(false)}>
          <div className="modal-content drive-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>分享链接</h3>
              <button className="modal-close" onClick={() => setShowLinkModal(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <p style={{ marginBottom: '10px', color: '#666' }}>复制链接分享给其他人</p>
              <div className="share-link-box" style={{ display: 'flex', gap: '10px' }}>
                <input 
                  type="text" 
                  className="share-link-input"
                  value={generateShareLink(linkModalItem.shareLinkToken || linkModalItem.id, linkModalItem.sharePermission || 'view')}
                  readOnly
                />
                <button 
                  className="drive-btn drive-btn-primary"
                  onClick={() => {
                    const link = generateShareLink(linkModalItem.shareLinkToken || linkModalItem.id, linkModalItem.sharePermission || 'view');
                    navigator.clipboard.writeText(link);
                    toast.success('链接已复制到剪贴板');
                  }}
                >
                  复制
                </button>
              </div>
              <p style={{ marginTop: '10px', fontSize: '12px', color: '#999' }}>
                链接访问权限与当前共享设置一致
              </p>
            </div>
            <div className="modal-footer">
              <button className="drive-btn drive-btn-outline" onClick={() => setShowLinkModal(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
