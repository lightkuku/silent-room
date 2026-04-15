import React, { useState, useEffect, useRef } from 'react';
import { Folder, File as FileIcon, Download, ArrowLeft, Lock, Upload as UploadIcon, Eye, EyeOff } from 'lucide-react';
import { drive } from '../services/api';
import { decrypt, encrypt, loadKeysFromStorage } from '../utils/crypto';
import { encryptFileChunkedAsync } from '../utils/cryptoAsync';
import { formatTimestamp, convertServerTime, getServerTimestamp } from '../utils/time';
import { toast } from '../utils/toast';
import ProgressFloat from './ProgressFloat';

interface SharedItem {
  id: string;
  name: string;
  type: 'folder' | 'file';
  size?: number;
  modified: number;
  ownerId: string;
  ownerName: string;
  parentId: string | null;
  sharePermission: string;
  url?: string;
  isEncrypted?: boolean;
  decryptFailed?: boolean;
}

interface Breadcrumb {
  id: string | null;
  name: string;
}

export const SharedViewPage: React.FC = () => {
  const [items, setItems] = useState<SharedItem[]>([]);
  const [currentPath, setCurrentPath] = useState<Breadcrumb[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [keyError, setKeyError] = useState(false);
  const [permission, setPermission] = useState<string>('view');
  const [encryptionKey, setEncryptionKey] = useState<string>('');
  const [inputKey, setInputKey] = useState<string>('');
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [decryptedName, setDecryptedName] = useState<string>('');
  const [itemType, setItemType] = useState<'folder' | 'file'>('folder');
  const [rawEncryptedPerm, setRawEncryptedPerm] = useState<string>('');
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [shareToken, setShareToken] = useState<string>('');
  const [isDragging, setIsDragging] = useState(false);
  const [activeDownloads, setActiveDownloads] = useState<{id: string; name: string; progress: number; totalSize?: number; loadedSize?: number; abortController?: AbortController}[]>([]);
  const [activeUploads, setActiveUploads] = useState<{id: string; name: string; progress: number; totalSize?: number; loadedSize?: number; xhr?: XMLHttpRequest}[]>([]);
  const uploadCancelRef = useRef<Record<string, boolean>>({});

  // 初始化：验证分享链接并设置 token
  useEffect(() => {
    const init = async () => {
      const path = window.location.pathname;
      const match = path.match(/^\/drive\/shared\/([^\/]+)/);
      if (!match) {
        setError('分享链接无效');
        setIsLoading(false);
        setShowKeyInput(false);
        return;
      }
      
      const token = match[1];
      setShareToken(token);
      
      // 先验证分享链接是否有效
      try {
        const result = await drive.getSharedFilesWithPath(token, '');
        if (!result.success) {
          setError(result.message || '分享链接无效');
          setIsLoading(false);
          setShowKeyInput(false);
          return;
        }
        if (result.data && result.data.isDeleted === 1) {
          setError('分享链接已失效');
          setIsLoading(false);
          setShowKeyInput(false);
          return;
        }
      } catch (err) {
        setError('分享链接无效');
        setIsLoading(false);
        setShowKeyInput(false);
        return;
      }
      
      // 链接有效，继续初始化
      const hash = window.location.hash.slice(1);
      if (hash) {
        setRawEncryptedPerm(hash);
      }
      
      const storedKey = localStorage.getItem('encryption_currentKey') || localStorage.getItem('encryptionKey');
      if (storedKey) {
        if (hash) {
          const decryptedPerm = decrypt(hash, storedKey);
          if (decryptedPerm && ['view', 'edit', 'upload'].includes(decryptedPerm)) {
            setEncryptionKey(storedKey);
            setShowKeyInput(false);
          } else {
            localStorage.removeItem('encryption_currentKey');
            setShowKeyInput(true);
          }
        } else {
          setEncryptionKey(storedKey);
          setShowKeyInput(false);
        }
      } else {
        setShowKeyInput(true);
      }
    };
    
    init();
  }, []);

  const handleKeySubmit = () => {
    if (inputKey.trim()) {
      const key = inputKey.trim();
      
      // 验证密钥：尝试解密加密的权限
      if (rawEncryptedPerm) {
        const decryptedPerm = decrypt(rawEncryptedPerm, key);
        if (!decryptedPerm || !['view', 'edit', 'upload'].includes(decryptedPerm)) {
          setKeyError(true);
          return; // 密钥错误，不进入
        }
      }
      
      // 密钥验证通过
      setEncryptionKey(key);
      setShowKeyInput(false);
      localStorage.setItem('encryption_currentKey', key);
      setKeyError(false);
    }
  };

  const loadFiles = async (folderId?: string) => {
    const isFirst = !folderId;
    setIsLoading(true);
    setError('');
    setKeyError(false);
    setSelectedItems(new Set());
    try {
      // 始终使用shareToken访问，通过 folderId 获取子目录内容
      const result = await drive.getSharedFilesWithPath(shareToken, folderId);
      
      if (result.success) {
        const data = result.data;
        let itemsData: any[] = [];
        
        if (data.children) {
          itemsData = data.children;
        } else if (Array.isArray(data)) {
          itemsData = data;
        } else if (data.type === 'file') {
          itemsData = [data];
        }
        
        if (rawEncryptedPerm && encryptionKey) {
          const decryptedPerm = decrypt(rawEncryptedPerm, encryptionKey);
          if (!decryptedPerm || !['view', 'edit', 'upload'].includes(decryptedPerm)) {
            setKeyError(true);
            setShowKeyInput(true);
            setIsLoading(false);
            return;
          }
        }
        
        const formattedItems = itemsData.map((item: any) => {
          let decryptedName = item.name;
          let decryptFailed = false;
          if (item.isEncrypted && encryptionKey) {
            const decrypted = decrypt(item.name, encryptionKey);
            if (decrypted && decrypted !== item.name) {
              decryptedName = decrypted;
            } else {
              decryptFailed = true;
              decryptedName = '🔒 文件解密失败，无法显示内容（请检查密钥）';
            }
          } else if (item.isEncrypted && !encryptionKey) {
            decryptFailed = true;
            decryptedName = '🔒 加密文件（请先设置密钥）';
          }
          return {
            id: item.id,
            name: decryptedName,
            type: item.type,
            size: item.size,
            modified: getServerTimestamp(item.updatedAt || item.createdAt),
            ownerId: item.ownerId,
            ownerName: item.ownerName || '我',
            parentId: item.parentId,
            sharePermission: item.sharePermission || 'view',
            url: item.url,
            isEncrypted: item.isEncrypted,
            decryptFailed: decryptFailed,
          };
        });
        setItems(formattedItems);
        
        // 始终使用分享链接根目录的权限，不使用子目录的权限
        let finalPerm = 'view';
        if (rawEncryptedPerm && encryptionKey) {
          const decrypted = decrypt(rawEncryptedPerm, encryptionKey);
          if (decrypted && ['view', 'edit', 'upload'].includes(decrypted)) {
            finalPerm = decrypted;
          }
        }
        setPermission(finalPerm);
        
        let displayName = data.name || data[0]?.name || '分享';
        if ((data.isEncrypted || data[0]?.isEncrypted) && encryptionKey) {
          const decrypted = decrypt(data.name || data[0]?.name, encryptionKey);
          if (decrypted) {
            displayName = decrypted;
            setDecryptedName(decrypted);
          }
        }
        
        if (isFirst) {
          setCurrentPath([{ id: data.id, name: displayName }]);
        }
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    const path = window.location.pathname;
    const match = path.match(/^\/drive\/shared\/([^\/]+)/);
    if (match) {
      const token = match[1];
      setShareToken(token);
      loadFiles();
      setCurrentPath([{ id: token, name: '加载中...' }]);
    }
  }, [encryptionKey]);

  const handleFolderClick = (folder: SharedItem) => {
    const newPath = [...currentPath, { id: folder.id, name: folder.name }];
    setCurrentPath(newPath);
    loadFiles(folder.id);
  };

  const handleBreadcrumbClick = (index: number) => {
    const newPath = currentPath.slice(0, index + 1);
    setCurrentPath(newPath);
    const folderId = newPath[newPath.length - 1].id;
    loadFiles(folderId);
  };

  const handleGoBack = () => {
    if (currentPath.length > 1) {
      const newPath = currentPath.slice(0, -1);
      setCurrentPath(newPath);
      const folderId = newPath[newPath.length - 1].id;
      loadFiles(folderId);
    } else {
      const path = window.location.pathname;
      const match = path.match(/^\/drive\/shared\/([^\/]+)/);
      if (match) {
        const token = match[1];
      loadFiles();
        setCurrentPath([{ id: token, name: '加载中...' }]);
      }
    }
  };

  const handleSelectAll = () => {
    if (selectedItems.size === items.length) {
      setSelectedItems(new Set());
    } else {
      setSelectedItems(new Set(items.map(i => i.id)));
    }
  };

  const handleSelectItem = (id: string) => {
    const newSelected = new Set(selectedItems);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedItems(newSelected);
  };

  const handleDownload = async (item: SharedItem) => {
    if (!shareToken) {
      toast.error('分享链接无效');
      return;
    }
    
    if (!item || item.type !== 'file') {
      toast.error('文件夹不支持单独下载，请使用打包下载功能');
      return;
    }
    
    if (item.isEncrypted && item.decryptFailed) {
      toast.error('文件解密失败，无法下载，请检查密钥是否正确');
      return;
    }
    
    const abortController = new AbortController();
    const downloadId = `shared_download_${Date.now()}`;
    setActiveDownloads(prev => [...prev, { 
      id: downloadId, 
      name: item.name, 
      progress: 0,
      totalSize: item.size,
      loadedSize: 0,
      abortController
    }]);
    
    try {
      await drive.sharedDownload(item.id, shareToken, (progress, loaded, total) => {
        setActiveDownloads(prev => prev.map(d => d.id === downloadId ? { 
          ...d, 
          progress,
          loadedSize: loaded,
          totalSize: total || item.size
        } : d));
      }, item.name, item.isEncrypted, encryptionKey, abortController.signal);
      // 下载完成后设置为完成状态
      setActiveDownloads(prev => prev.map(d => d.id === downloadId ? { ...d, progress: 100 } : d));
    } catch (err: any) {
      console.error('下载失败:', err);
    }
  };

  const handleDownloadFolder = async (folder: SharedItem) => {
    if (!shareToken) {
      return;
    }
    
    const abortController = new AbortController();
    const downloadId = `shared_download_${Date.now()}`;
    setActiveDownloads(prev => [...prev, { 
      id: downloadId, 
      name: `${folder.name}.zip`, 
      progress: 0,
      totalSize: undefined,
      loadedSize: 0,
      abortController
    }]);
    
    try {
      await drive.sharedDownload(folder.id, shareToken, (progress, loaded, total) => {
        setActiveDownloads(prev => prev.map(d => d.id === downloadId ? { 
          ...d, 
          progress,
          loadedSize: loaded,
          totalSize: total
        } : d));
      }, `${folder.name}.zip`, folder.isEncrypted, encryptionKey, abortController.signal);
      // 下载完成后设置为完成状态
      setActiveDownloads(prev => prev.map(d => d.id === downloadId ? { ...d, progress: 100 } : d));
    } catch (err: any) {
      console.error('打包下载失败:', err);
    }
  };

  const handleDownloadSelected = async () => {
    const filesToDownload = items.filter(i => selectedItems.has(i.id) && i.type === 'file');
    const foldersToDownload = items.filter(i => selectedItems.has(i.id) && i.type === 'folder');
    
    if (filesToDownload.length === 0 && foldersToDownload.length === 0) {
      return;
    }
    
    if (foldersToDownload.length > 0) {
      // 文件夹使用打包下载
    }
    
    // 先添加所有任务到列表中，状态为"准备中"
    const newDownloads: typeof activeDownloads = [];
    
    for (const item of filesToDownload) {
      const abortController = new AbortController();
      newDownloads.push({
        id: `shared_download_${item.id}_${Date.now()}`,
        name: item.name,
        progress: -1, // -1 表示准备中
        totalSize: item.size,
        loadedSize: 0,
        abortController
      });
    }
    
    for (const folder of foldersToDownload) {
      const abortController = new AbortController();
      newDownloads.push({
        id: `shared_download_folder_${folder.id}_${Date.now()}`,
        name: `${folder.name}.zip`,
        progress: -1,
        totalSize: undefined,
        loadedSize: 0,
        abortController
      });
    }
    
    setActiveDownloads(prev => [...prev, ...newDownloads]);
    
    // 逐个下载文件
    for (let i = 0; i < filesToDownload.length; i++) {
      const item = filesToDownload[i];
      const downloadId = newDownloads[i].id;
      const abortController = newDownloads[i].abortController!;
      
      // 检查任务是否被取消
      const task = newDownloads.find(d => d.id === downloadId);
      if (!task || task.progress === -3) {
        continue; // 跳过已取消的任务
      }
      
      // 更新状态为下载中
      setActiveDownloads(prev => prev.map(d => d.id === downloadId ? { ...d, progress: 0 } : d));
      
      try {
        await drive.sharedDownload(item.id, shareToken, (progress, loaded, total) => {
          // 检查是否被取消
          const currentTask = newDownloads.find(d => d.id === downloadId);
          if (currentTask && currentTask.progress === -3) {
            abortController.abort();
            return;
          }
          setActiveDownloads(prev => prev.map(d => d.id === downloadId ? { 
            ...d, 
            progress,
            loadedSize: loaded,
            totalSize: total || item.size
          } : d));
        }, item.name, item.isEncrypted, encryptionKey, abortController.signal);
        // 下载完成后设置为完成状态
        setActiveDownloads(prev => prev.map(d => d.id === downloadId ? { ...d, progress: 100 } : d));
      } catch (err: any) {
        if (err.message === 'The user aborted a request.') {
          // 用户取消
        } else {
          setActiveDownloads(prev => prev.map(d => d.id === downloadId ? { ...d, progress: -2 } : d)); // -2 表示失败
          console.error('下载失败:', err);
        }
      }
    }
    
    // 逐个下载文件夹
    for (let i = 0; i < foldersToDownload.length; i++) {
      const folder = foldersToDownload[i];
      const downloadId = newDownloads[filesToDownload.length + i].id;
      const abortController = newDownloads[filesToDownload.length + i].abortController!;
      
      // 检查任务是否被取消
      const task = newDownloads.find(d => d.id === downloadId);
      if (!task || task.progress === -3) {
        continue; // 跳过已取消的任务
      }
      
      // 更新状态为下载中
      setActiveDownloads(prev => prev.map(d => d.id === downloadId ? { ...d, progress: 0 } : d));
      
      try {
        await drive.sharedDownload(folder.id, shareToken, (progress, loaded, total) => {
          // 检查是否被取消
          const currentTask = newDownloads.find(d => d.id === downloadId);
          if (currentTask && currentTask.progress === -3) {
            abortController.abort();
            return;
          }
          setActiveDownloads(prev => prev.map(d => d.id === downloadId ? { 
            ...d, 
            progress,
            loadedSize: loaded,
            totalSize: total
          } : d));
        }, `${folder.name}.zip`, false, undefined, abortController.signal);
        // 下载完成后设置为完成状态
        setActiveDownloads(prev => prev.map(d => d.id === downloadId ? { ...d, progress: 100 } : d));
      } catch (err: any) {
        if (err.message === 'The user aborted a request.') {
          // 用户取消
        } else {
          setActiveDownloads(prev => prev.map(d => d.id === downloadId ? { ...d, progress: -2 } : d)); // -2 表示失败
          console.error('下载失败:', err);
        }
      }
    }
  };

  const handleUpload = async (files: FileList) => {
    if (!shareToken || !canUpload) {
      toast.error('您没有上传权限');
      return;
    }
    
    const currentFolderId = currentPath[currentPath.length - 1]?.id;
    const keys = loadKeysFromStorage();
    const currentKey = keys?.currentKey || encryptionKey || '';
    
    // 添加所有上传任务
    const newUploads: typeof activeUploads = [];
    for (let i = 0; i < files.length; i++) {
      const uploadId = `shared_upload_${Date.now()}_${i}`;
      newUploads.push({
        id: uploadId,
        name: files[i].name,
        progress: -1, // -1 表示准备中
        totalSize: files[i].size,
        loadedSize: 0,
        xhr: undefined
      });
      // 使用 ref 跟踪取消状态
      uploadCancelRef.current[uploadId] = false;
    }
    setActiveUploads(prev => [...prev, ...newUploads]);
    
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const uploadId = newUploads[i].id;
        const originalFileName = file.name;
        const totalSize = file.size;
        
        // 检查任务是否被取消
        if (uploadCancelRef.current[uploadId]) {
          continue;
        }
        
        // 更新为上传中
        setActiveUploads(prev => prev.map(u => u.id === uploadId ? { ...u, progress: 0 } : u));
        
        let fileToUpload = file;
        let encryptedFileName = originalFileName;
        let isEncrypted = false;
        
        if (currentKey && currentKey.trim()) {
          try {
            encryptedFileName = encrypt(originalFileName, currentKey);
            const { encrypted } = await encryptFileChunkedAsync(file, currentKey, (progress) => {
              // 检查是否被取消
              if (uploadCancelRef.current[uploadId]) {
                throw new Error('canceled');
              }
              const loaded = Math.round(progress * totalSize * 0.8);
              setActiveUploads(prev => prev.map(u => u.id === uploadId ? { ...u, progress: Math.round(progress * 0.8 * 80), loadedSize: loaded } : u));
            });
            
            if (uploadCancelRef.current[uploadId]) {
              continue;
            }
            
            // 文件名已经单独加密了，需要加.enc后缀
            fileToUpload = new File([encrypted], originalFileName + '.enc', { type: 'application/octet-stream' });
            isEncrypted = true;
          } catch (err: any) {
            if (err.message === 'canceled') {
              continue;
            }
            console.error('加密失败:', err);
            // 加密失败，使用原始文件名，不加密
            encryptedFileName = originalFileName;
            isEncrypted = false;
            fileToUpload = file;
          }
        }
        
        // 创建 xhr ref 用于取消
        const xhrRef = { current: null as XMLHttpRequest | null };
        
        try {
          // 检查是否已被取消
          if (uploadCancelRef.current[uploadId]) {
            delete uploadCancelRef.current[uploadId];
            continue;
          }
          
          await drive.sharedUpload(shareToken, fileToUpload, currentFolderId !== shareToken ? currentFolderId : undefined, encryptedFileName, isEncrypted, (progress) => {
            // 检查是否被取消
            if (uploadCancelRef.current[uploadId]) {
              if (xhrRef.current) {
                xhrRef.current.abort();
              }
              return;
            }
            const loaded = Math.round(80 * totalSize / 100 + progress * totalSize * 0.2);
            setActiveUploads(prev => prev.map(u => u.id === uploadId ? { ...u, progress: 80 + Math.round(progress * 0.2), loadedSize: loaded } : u));
          }, xhrRef, totalSize);
          
          // 检查是否在上传过程中被取消
          if (uploadCancelRef.current[uploadId]) {
            delete uploadCancelRef.current[uploadId];
            continue;
          }
          
          // 上传完成
          setActiveUploads(prev => prev.map(u => u.id === uploadId ? { ...u, progress: 100, status: 'completed', loadedSize: totalSize } : u));
        } catch (err: any) {
          if (err.message === 'upload canceled' || err.message === '上传已取消' || uploadCancelRef.current[uploadId]) {
            // 清除取消标记
            delete uploadCancelRef.current[uploadId];
            continue;
          }
          throw err;
        }
      }
      
      loadFiles();
    } catch (err: any) {
      console.error('上传失败:', err);
    }
  };

  const formatSize = (bytes?: number) => {
    if (!bytes) return '-';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  };

  const formatDate = (date: Date | number | string) => {
    if (!date) return '-';
    if (date instanceof Date) {
      if (isNaN(date.getTime())) return '-';
      return formatTimestamp(date.getTime(), 'time');
    }
    return formatTimestamp(Number(date), 'time');
  };

  const renderBreadcrumb = () => {
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

  const getBreadcrumbPath = () => {
    return '/' + currentPath.map(p => p.name).join('/');
  };

  // 密钥输入
  if (showKeyInput || !encryptionKey) {
    return (
      <div className="shared-view shared-view-loading">
        <Lock size={48} style={{ marginBottom: '16px', color: '#666' }} />
        <p style={{ marginBottom: '16px', color: '#333' }}>请输入密钥访问此分享</p>
        {keyError && (
          <p style={{ marginBottom: '16px', color: '#ff4444', fontSize: '14px' }}>密钥错误，请重新输入</p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', alignItems: 'center' }}>
          <div style={{ position: 'relative', width: '300px' }}>
            <input
              type={showPassword ? 'text' : 'password'}
              placeholder="输入密钥"
              value={inputKey}
              onChange={(e) => { setInputKey(e.target.value); setKeyError(false); }}
              style={{ padding: '10px 40px 10px 16px', borderRadius: '8px', border: keyError ? '1px solid #ff4444' : '1px solid #ddd', width: '100%', boxSizing: 'border-box' }}
              onKeyPress={(e) => e.key === 'Enter' && handleKeySubmit()}
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px', color: '#666' }}
            >
              {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
          <button 
            onClick={handleKeySubmit}
            style={{ padding: '10px 24px', borderRadius: '8px', border: 'none', background: '#0066cc', color: 'white', cursor: 'pointer' }}
          >
            确认
          </button>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="shared-view shared-view-loading">
        <div className="loading-spinner"></div>
        <p>加载中...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="shared-view shared-view-error">
        <p>{error}</p>
        <button 
          onClick={handleGoBack}
          style={{ marginTop: '16px', padding: '10px 24px', borderRadius: '8px', border: 'none', background: '#0066cc', color: 'white', cursor: 'pointer' }}
        >
          返回
        </button>
      </div>
    );
  }

  const canUpload = permission === 'upload';

  return (
    <div className="shared-view">
      {/* 顶部工具栏 */}
      <div className="shared-view-header">
        <div className="shared-view-title">
          <span>分享链接</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {selectedItems.size > 0 && (
            <button className="drive-btn drive-btn-primary" onClick={handleDownloadSelected}>
              <Download size={16} />
              下载 ({selectedItems.size})
            </button>
          )}
          {canUpload && (
            <label className="drive-btn drive-btn-primary" style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <UploadIcon size={16} />
              上传文件
              <input 
                type="file" 
                multiple 
                style={{ display: 'none' }}
                onChange={(e) => e.target.files && handleUpload(e.target.files)}
              />
            </label>
          )}
          <div className="shared-view-permission">
            {permission === 'view' && '👁 只读'}
            {permission === 'edit' && '✏️ 可编辑'}
            {permission === 'upload' && '⬆️ 可上传'}
          </div>
        </div>
      </div>
      
      {/* 面包屑导航 */}
      <div className="shared-view-breadcrumb">
        {currentPath.map((item, index) => (
          <span 
            key={item.id || 'root'} 
            className="breadcrumb-item"
            onClick={() => handleBreadcrumbClick(index)}
          >
            {item.name}
          </span>
        ))}
      </div>

      {/* 文件列表 */}
      <div 
        className={`shared-view-list ${isDragging ? 'drive-panel-dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (canUpload) setIsDragging(true);
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
          if (canUpload && e.dataTransfer.files.length > 0) {
            await handleUpload(e.dataTransfer.files);
          }
        }}
      >
        {items.length === 0 ? (
          <div className="shared-view-empty">
            <Folder size={64} />
            <p>暂无文件</p>
          </div>
        ) : (
          <div className="shared-view-items">
            {items.map(item => (
              <div 
                key={item.id} 
                className={`shared-view-item ${selectedItems.has(item.id) ? 'selected' : ''}`}
              >
                <input 
                  type="checkbox" 
                  checked={selectedItems.has(item.id)}
                  onChange={() => handleSelectItem(item.id)}
                  onClick={e => e.stopPropagation()}
                  style={{ marginRight: '12px' }}
                />
                <div className="shared-view-item-icon">
                  {item.type === 'folder' ? (
                    <Folder size={24} className="folder-icon" />
                  ) : (
                    <FileIcon size={24} className="file-icon" />
                  )}
                </div>
                <div 
                  className="shared-view-item-name"
                  onClick={() => item.type === 'folder' && handleFolderClick(item)}
                  style={{ cursor: item.type === 'folder' ? 'pointer' : 'default' }}
                >
                  {item.name}
                </div>
                <div className="shared-view-item-size">{item.type === 'file' ? formatSize(item.size) : '-'}</div>
                <div className="shared-view-item-time">{formatDate(item.modified)}</div>
                <div className="shared-view-item-action" onClick={e => e.stopPropagation()}>
                  {item.type === 'file' && (
                    <button onClick={() => handleDownload(item)} title="下载">
                      ⬇️
                    </button>
                  )}
                  {item.type === 'folder' && (
                    <button onClick={() => handleDownloadFolder(item)} title="打包下载">
                      ⬇️
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      
      {/* 进度条 */}
      {(activeUploads.length > 0 || activeDownloads.length > 0) && (
        <ProgressFloat 
          uploads={[
            ...activeUploads.map(d => ({
              id: d.id,
              filename: d.name,
              progress: d.progress < 0 ? 0 : d.progress,
              status: d.progress === 100 ? 'completed' as const : (d.progress === -2 ? 'error' as const : (d.progress === -1 ? 'preparing' as const : 'uploading' as const)),
              type: 'upload' as const,
              loadedSize: d.loadedSize,
              totalSize: d.totalSize
            })),
            ...activeDownloads.map(d => ({
              id: d.id,
              filename: d.name,
              progress: d.progress < 0 ? 0 : d.progress,
              status: d.progress === 100 ? 'completed' as const : (d.progress === -2 ? 'error' as const : (d.progress === -1 ? 'preparing' as const : 'uploading' as const)),
              type: 'download' as const,
              loadedSize: d.loadedSize,
              totalSize: d.totalSize
            }))
          ]}
          onRemove={(id) => {
            // 标记上传任务为已取消
            uploadCancelRef.current[id] = true;
            // 取消上传任务
            const upload = activeUploads.find(u => u.id === id);
            if (upload && upload.xhr) {
              upload.xhr.abort();
            }
            // 取消下载任务
            const download = activeDownloads.find(d => d.id === id);
            if (download && download.abortController) {
              download.abortController.abort();
            }
            // 移除任务
            setActiveUploads(prev => prev.filter(u => u.id !== id));
            setActiveDownloads(prev => prev.filter(d => d.id !== id));
          }}
          onCancelAll={() => {
            // 标记所有上传任务为已取消
            activeUploads.forEach(u => {
              uploadCancelRef.current[u.id] = true;
            });
            // 取消所有上传
            activeUploads.forEach(u => {
              if (u.xhr) {
                u.xhr.abort();
              }
            });
            // 取消所有下载
            activeDownloads.forEach(d => {
              if (d.abortController) {
                d.abortController.abort();
              }
            });
            // 清除所有任务
            setActiveUploads([]);
            setActiveDownloads([]);
          }}
        />
      )}
    </div>
  );
};
