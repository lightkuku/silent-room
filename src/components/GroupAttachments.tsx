import React, { useState, useEffect } from 'react';
import { API } from '../config/api';
import { loadKeysFromStorage, encrypt, decrypt, tryDecrypt } from '../utils/crypto';
import { TaskService } from '../utils/TaskService';
import { File, Download, Trash2, Paperclip, X, Lock, Loader2 } from 'lucide-react';
import { formatTimestamp, getServerTimestamp } from '../utils/time';
import { toast } from '../utils/toast';
import { showConfirm } from './ConfirmDialog';
import { apiFetch } from '../utils/csrf';
import './GroupAttachments.css';

const FileIcon = File;
const LockIcon = Lock;

interface GroupAttachment {
  id: string;
  sessionId: string;
  name: string;
  size: number;
  url: string;
  uploadedBy: string;
  uploadedByName: string;
  createdAt: number;
  encrypted?: boolean;
}

interface GroupAttachmentsProps {
  sessionId: string;
  isGroupOwner: boolean;
  onClose: () => void;
  onUploadProgress?: (progress: { id: string; filename: string; progress: number; status: 'uploading' | 'completed' | 'error'; type?: 'upload' | 'download' }) => void;
}

const GroupAttachments: React.FC<GroupAttachmentsProps> = ({ sessionId, isGroupOwner, onClose, onUploadProgress }) => {
  const [attachments, setAttachments] = useState<GroupAttachment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [decryptedNames, setDecryptedNames] = useState<Record<string, string>>({});
  const [decryptFailedNames, setDecryptFailedNames] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadAttachments();
    
    const handleRefresh = () => {
      // console.log('[DEBUG] 收到 refreshGroupAttachments 事件');
      loadAttachments();
    };
    window.addEventListener('refreshGroupAttachments', handleRefresh);
    return () => window.removeEventListener('refreshGroupAttachments', handleRefresh);
  }, [sessionId]);

  const loadAttachments = async () => {
    setIsLoading(true);
    try {
      const response = await apiFetch(`${API.baseUrl}/api/group-attachments/${sessionId}`, { requireCsrf: false });
      const data = await response.json();
      if (data.success) {
        setAttachments(data.data);
        // 解密文件名
        const keys = loadKeysFromStorage();
        const decrypted: Record<string, string> = {};
        const decryptFailed: string[] = [];
        data.data.forEach((att: GroupAttachment) => {
          // 如果名称为空或未定义，直接标记为解密失败
          if (!att.name || att.name.trim() === '') {
            decryptFailed.push(att.id);
            return;
          }
          const isEncryptedName = att.name.startsWith('U2FsdGVkX') || att.name.startsWith('Salted__');
          if (isEncryptedName && keys) {
            const result = tryDecrypt(att.name);
            if (result.decrypted) {
              decrypted[att.id] = result.content;
            } else {
              decryptFailed.push(att.id);
            }
          }
        });
        setDecryptedNames(decrypted);
        if (decryptFailed.length > 0) {
          setDecryptFailedNames(prev => new Set([...prev, ...decryptFailed]));
          toast.warning(`部分文件名解密失败 (${decryptFailed.length}个)，请检查密钥是否正确`);
        }
      }
    } catch (error) {
      console.error('加载群附件失败:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const taskService = TaskService.getInstanceSafe();
    if (!taskService) {
      toast.error('上传服务未初始化');
      return;
    }

    // 检查是否有密钥用于加密（统一使用 loadKeysFromStorage）
    const keys = loadKeysFromStorage();
    const hasKey = !!keys?.currentKey;
    // console.log('[DEBUG] 上传群附件: hasKey=', hasKey, 'keys=', !!keys);

    // 使用标准上传 API
    taskService.addUploadTask({
      filename: file.name,
      file: file,
      totalSize: file.size,
      isEncrypted: hasKey,
      customEndpoint: `/api/group-attachments/${sessionId}/upload`
    });
  };

  const handleDelete = async (id: string) => {
    if (!(await showConfirm({ title: '确认', message: '确定要删除这个附件吗？', type: 'danger' }))) return;

    try {
      const response = await apiFetch(`${API.baseUrl}/api/group-attachments/${id}/delete`, { method: 'DELETE' });
      const data = await response.json();
      if (data.success) {
        setAttachments(prev => prev.filter(a => a.id !== id));
      } else {
        toast.error('删除失败', data.message);
      }
    } catch (error) {
      console.error('删除失败:', error);
      toast.error('删除失败');
    }
  };

  const handleDownload = (attachment: GroupAttachment) => {
    // console.log('[DEBUG] 下载群附件:', attachment);
    
    // 处理URL格式
    let fullUrl = attachment.url;
    if (!attachment.url.startsWith('http')) {
      fullUrl = `${API.baseUrl}/api/group-attachments/${attachment.url}/download`;
    }
    // console.log('[DEBUG] 下载URL:', fullUrl);
    
    
    const keys = loadKeysFromStorage();
    // 检查名称是否有效
    const hasValidName = attachment.name && attachment.name.trim() !== '';
    const isEncryptedName = hasValidName && (attachment.name.startsWith('U2FsdGVkX') || attachment.name.startsWith('Salted__'));
    const isEncrypted = isEncryptedName;
    const filenameDecrypted = !!decryptedNames[attachment.id];
    const isDecryptFailed = decryptFailedNames.has(attachment.id);
    // console.log('[DEBUG] 加密状态:', { isEncryptedName, isEncrypted, filenameDecrypted });
    
    // 检查是否解密失败（包括空名称的情况）
    if (!hasValidName || (isEncrypted && !filenameDecrypted)) {
      toast.error('文件名解密失败，无法下载');
      return;
    }
    
    // 使用 TaskService 添加下载任务
    const taskService = TaskService.getInstanceSafe();
    if (!taskService) {
      console.error('TaskService 未初始化');
      toast.error('下载服务未初始化');
      return;
    }
    
    const filename = decryptedNames[attachment.id] || attachment.name;
    
    taskService.addDownloadTask({
      filename,
      url: attachment.url, // 传原始ID，让 TaskService 处理
      isEncrypted,
      totalSize: attachment.size,
      isBurn: false,
      customEndpoint: '/api/group-attachments' // 用于判断是群附件下载
    });
  };

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const formatDate = (timestamp: number): string => {
    return formatTimestamp(getServerTimestamp(timestamp), 'datetime');
  };

  return (
    <div className="group-attachments-modal">
      <div className="group-attachments-header">
        <h3>
          <Paperclip size={20} /> 群附件
        </h3>
        <button className="close-btn" onClick={onClose}>
          <X size={20} />
        </button>
      </div>

      <div className="group-attachments-content">
        <div className="upload-section">
          <label className="upload-btn">
            <input
              type="file"
              onChange={handleUpload}
              disabled={isUploading}
              style={{ display: 'none' }}
            />
            {isUploading ? '上传中...' : '+ 上传附件'}
          </label>
        </div>

        {isLoading ? (
          <div className="loading">
            <Loader2 size={32} className="animate-spin" style={{ color: 'var(--primary)' }} />
            <div>加载中...</div>
          </div>
        ) : attachments.length === 0 ? (
          <div className="empty">暂无附件</div>
        ) : (
          <div className="attachments-list">
            {attachments.map(attachment => {
              // 处理空名称的情况
              const hasValidName = attachment.name && attachment.name.trim() !== '';
              const isEncrypted = hasValidName && (attachment.name.includes('U2FsdGVkX') || attachment.name.includes('Salted__'));
              const displayName = decryptedNames[attachment.id] || (hasValidName ? attachment.name : '未知文件');
              const keys = loadKeysFromStorage();
              const filenameDecrypted = !!decryptedNames[attachment.id];
              const decryptFailed = decryptFailedNames.has(attachment.id);
              const canDownload = !isEncrypted || (isEncrypted && filenameDecrypted);
              
              return (
                <div key={attachment.id} className="attachment-item">
                  <div className="attachment-icon">
                    {decryptFailed ? (
                      <LockIcon size={24} />
                    ) : (
                      <FileIcon size={24} />
                    )}
                  </div>
                  <div className="attachment-info">
                    <div className="attachment-name">
                      {decryptFailed ? (
                        <>
                          <span className="encrypted-badge">🔒 </span>
                          <span style={{ color: '#dc3545', fontSize: '13px' }}>文件解密失败，无法显示（请检查密钥）</span>
                        </>
                      ) : (
                        <>
                          {/* isEncrypted && <span className="encrypted-badge">🔒 </span> */}
                          {displayName}
                        </>
                      )}
                    </div>
                    <div className="attachment-meta">
                      {formatSize(attachment.size)} · {attachment.uploadedByName} · {formatDate(attachment.createdAt)}
                    </div>
                  </div>
                  <div className="attachment-actions">
                    <button
                      className={`action-btn download ${!canDownload ? 'disabled' : ''}`}
                      onClick={() => canDownload && handleDownload(attachment)}
                      title={canDownload ? '下载' : '文件名解密失败'}
                      disabled={!canDownload}
                    >
                      <Download size={16} />
                    </button>
                    {isGroupOwner && (
                      <button
                        className="action-btn delete"
                        onClick={() => handleDelete(attachment.id)}
                        title="删除"
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default GroupAttachments;
