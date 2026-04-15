import React, { useState, useEffect, useRef, useMemo } from 'react';
import type { TaskItem } from '../types';
import { getGlobalUploads, subscribeGlobalUploads, cancelUpload, retryUpload, clearGlobalUploads } from '../utils/globalUploads';
import { clamp } from '../utils/helpers';
import { toast } from '../utils/toast';
import { Upload, Download, Loader2, CheckCircle, X, RotateCcw, Lock } from 'lucide-react';

interface ProgressFloatProps {
  uploads?: TaskItem[];
  onRemove?: (id: string) => void;
  onRetry?: (id: string) => void;
  onCancelAll?: () => void;
  onClearAll?: () => void;
  onClose?: () => void;
  useGlobalUploads?: boolean;
}

const formatSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

const formatSpeed = (bytesPerSecond: number): string => {
  if (bytesPerSecond === 0) return '0 B/s';
  const k = 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(bytesPerSecond) / Math.log(k));
  return parseFloat((bytesPerSecond / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

const STORAGE_KEY = 'progressFloatPosition_v2';

export const ProgressFloat: React.FC<ProgressFloatProps> = ({ 
  uploads: propUploads, 
  onRemove, 
  onCancelAll,
  onClearAll,
  onClose, 
  useGlobalUploads = false 
}) => {
  const [expanded, setExpanded] = useState(false);
  const [position, setPosition] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        return { x: window.innerWidth - 70, y: window.innerHeight - 70 };
      }
    }
    // 默认放左下角，避免在小窗口被遮挡
    return { x: 10, y: window.innerHeight - 70 };
  });

  // 确保位置在可视区域内（窗口调整大小时）
  useEffect(() => {
    const checkPosition = () => {
      setPosition((prev: { x: number; y: number }) => {
        const padding = 10;
        const maxX = window.innerWidth - padding;
        const maxY = window.innerHeight - padding;
        if (prev.x > maxX || prev.y > maxY) {
          return { x: Math.min(prev.x, maxX), y: Math.min(prev.y, maxY) };
        }
        return prev;
      });
    };
    window.addEventListener('resize', checkPosition);
    return () => window.removeEventListener('resize', checkPosition);
  }, []);
  const [isDragging, setIsDragging] = useState(false);
  
  const containerRef = useRef<HTMLDivElement>(null);
  const hasInitializedRef = useRef(false);
  const [globalUploads, setGlobalUploads] = useState<TaskItem[]>([]);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  
  useEffect(() => {
    if (useGlobalUploads) {
      // console.log('[DEBUG] ProgressFloat useEffect 订阅, getGlobalUploads()=', getGlobalUploads());
      setGlobalUploads(getGlobalUploads());
      const unsubscribe = subscribeGlobalUploads((uploads) => {
        // console.log('[DEBUG] ProgressFloat 收到更新, uploads=', uploads.map(u => ({ id: u.id, status: u.status, progress: u.progress })));
        setGlobalUploads([...uploads]);
      });
      return unsubscribe;
    }
  }, [useGlobalUploads]);

  const uploads = useMemo(() => {
    const allUploads = useGlobalUploads ? [...globalUploads, ...(propUploads || [])] : (propUploads || []);
    // console.log('[DEBUG] ProgressFloat uploads useMemo, globalUploads=', globalUploads.map(u => ({ id: u.id, status: u.status, progress: u.progress })));
    const seen = new Set<string>();
    return allUploads.filter(u => {
      if (seen.has(u.id)) return false;
      seen.add(u.id);
      return true;
    });
  }, [useGlobalUploads, globalUploads, propUploads]);

  const activeUploads = useMemo(() => 
    uploads.filter(u => u.status === 'uploading' || u.status === 'pending'), 
  [uploads]);
  
  const overallProgress = useMemo(() => {
    if (activeUploads.length === 0) return 0;
    return Math.round(activeUploads.reduce((acc, u) => acc + u.progress, 0) / activeUploads.length);
  }, [activeUploads]);

  useEffect(() => {
    if (uploads.length > 0) {
      hasInitializedRef.current = true;
    }
  }, [uploads]);

  const handleDragStart = (e: React.MouseEvent) => {
    setIsDragging(true);
    dragOffsetRef.current = {
      x: e.clientX - position.x,
      y: e.clientY - position.y
    };
    e.preventDefault();
  };

  const handleDragMove = (e: MouseEvent) => {
    if (!isDragging) return;
    setPosition({ 
      x: clamp(e.clientX - dragOffsetRef.current.x, 0, window.innerWidth - 60),
      y: clamp(e.clientY - dragOffsetRef.current.y, 0, window.innerHeight - 60)
    });
  };

  const handleDragEnd = () => {
    if (isDragging) {
      setIsDragging(false);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(position));
    }
  };

  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleDragMove);
      document.addEventListener('mouseup', handleDragEnd);
      return () => {
        document.removeEventListener('mousemove', handleDragMove);
        document.removeEventListener('mouseup', handleDragEnd);
      };
    }
  }, [isDragging]);

  const handleCancel = (upload: TaskItem, e: React.MouseEvent) => {
    e.stopPropagation();
    cancelUpload(upload.id);
  };

  const handleRetry = (upload: TaskItem, e: React.MouseEvent) => {
    e.stopPropagation();
    retryUpload(upload.id);
  };

  const getStatusText = (upload: TaskItem) => {
    switch (upload.status) {
      case 'pending': return '等待中';
      case 'uploading': return `${upload.progress}%`;
      case 'completed': return '完成';
      case 'error': return '失败';
      case 'cancelled': return '已取消';
      default: return '';
    }
  };

  const getStatusColor = (upload: TaskItem) => {
    switch (upload.status) {
      case 'completed': return '#22c55e';
      case 'error': return '#ef4444';
      case 'cancelled': return '#f59e0b';
      default: return 'var(--primary, #4361ee)';
    }
  };

  if (!hasInitializedRef.current && uploads.length === 0) {
    return null;
  }

  return (
    <div 
      ref={containerRef}
      className={`progress-float ${expanded ? 'expanded' : ''}`}
      style={{ 
        left: position.x,
        top: position.y,
      }}
    >
      {/* 悬浮球 */}
      <div 
        className="progress-ball"
        onMouseDown={handleDragStart}
        onClick={() => setExpanded(!expanded)}
        style={{ 
          background: activeUploads.length > 0 ? 'var(--primary, #4361ee)' : '#22c55e',
        }}
      >
        {activeUploads.length > 0 ? (
          <>
            <Loader2 size={20} className="animate-spin" />
            <span className="progress-text">{overallProgress}%</span>
          </>
        ) : (
          <CheckCircle size={20} />
        )}
      </div>
      
      {/* 展开面板 */}
      {expanded && (
        <div className="progress-panel" onClick={(e) => e.stopPropagation()}>
          <div className="panel-header">
            <span className="panel-title">
              {activeUploads.length > 0 
                ? `传输中 (${activeUploads.length})` 
                : uploads.length > 0 
                  ? `已完成 (${uploads.filter(u => u.status === 'completed').length})` 
                  : '暂无传输'}
            </span>
            <button className="panel-close" onClick={() => setExpanded(false)}>
              <X size={16} />
            </button>
          </div>
          
          <div className="panel-list">
            {uploads.length === 0 ? (
              <div className="panel-empty">暂无传输任务</div>
            ) : (
              uploads.map(upload => (
                <div key={upload.id} className="panel-item">
                  <div className="item-icon">
                    {upload.type === 'upload' ? (
                      <Upload size={16} />
                    ) : (
                      <Download size={16} />
                    )}
                  </div>
                  <div className="item-content">
                    <div className="item-name">{upload.filename}</div>
                    <div className="item-info">
                      {upload.status === 'uploading' && (
                        <>
                          <span className="item-size">
                            {formatSize(upload.loadedSize || 0)} / {formatSize(upload.totalSize || 0)}
                          </span>
                          {upload.speed > 0 && (
                            <span className="item-speed">{formatSpeed(upload.speed)}</span>
                          )}
                        </>
                      )}
                      <span className="item-status" style={{ color: getStatusColor(upload) }}>
                        {getStatusText(upload)}
                      </span>
                    </div>
                    {upload.status === 'uploading' && (
                      <div className="item-progress">
                        <div className="progress-bar" style={{ width: `${upload.progress}%` }} />
                      </div>
                    )}
                  </div>
                  {(upload.status === 'uploading' || upload.status === 'pending') && (
                    <>
                      <button 
                        className="item-cancel"
                        onClick={(e) => handleCancel(upload, e)}
                        title="取消"
                      >
                        <X size={14} />
                      </button>
                    </>
                  )}
                  {(upload.status === 'error' || upload.status === 'cancelled') && (
                    <button 
                      className="item-retry"
                      onClick={(e) => handleRetry(upload, e)}
                      title="重试"
                    >
                      <RotateCcw size={14} />
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
          
          {uploads.length > 0 && (
            <div className="panel-footer" style={{ display: 'flex', gap: '8px' }}>
              <button 
                className="btn-cancel-all"
                onClick={() => {
                  uploads.forEach(u => {
                    if (u.status === 'uploading' || u.status === 'pending') {
                      cancelUpload(u.id);
                    }
                  });
                  toast.info('已全部取消');
                }}
              >
                取消全部
              </button>
              <button 
                className="btn-remove-all"
                onClick={() => {
                  if (onClearAll) {
                    onClearAll();
                  }
                  clearGlobalUploads();
                  hasInitializedRef.current = false;
                  toast.info('已清空全部任务');
                }}
              >
                清空任务
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ProgressFloat;
