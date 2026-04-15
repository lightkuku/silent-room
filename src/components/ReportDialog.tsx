import React, { useState } from 'react';
import { AlertTriangle, X, Send } from 'lucide-react';
import { apiFetch } from '../utils/csrf';
import { toast } from '../utils/toast';
import { REPORT_REASONS } from '../utils/report';
import API from '../config/api';

interface ReportDialogProps {
  messageId: string;
  messageContent: string;
  senderName: string;
  onClose: () => void;
}

export const ReportDialog: React.FC<ReportDialogProps> = ({
  messageId,
  messageContent,
  senderName,
  onClose,
}) => {
  const [reason, setReason] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!reason) {
      toast.error('请选择举报原因');
      return;
    }

    setSubmitting(true);
    try {
      const response = await apiFetch(API.messages.report(messageId), {
        method: 'POST',
        body: JSON.stringify({ reason, description }),
      });
      const data = await response.json();
      
      if (data.success) {
        toast.success('举报成功，我们会尽快处理');
        onClose();
      } else {
        toast.error(data.message || '举报失败');
      }
    } catch (error) {
      console.error('举报失败:', error);
      toast.error('举报失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content report-dialog" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <AlertTriangle size={20} />
          <span>举报消息</span>
          <button className="modal-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          <div className="report-message-preview">
            <div className="report-sender">发送者：{senderName}</div>
            <div className="report-content">
              {messageContent.length > 100 
                ? messageContent.substring(0, 100) + '...' 
                : messageContent}
            </div>
          </div>

          <div className="report-reason-section">
            <label>举报原因 *</label>
            <div className="reason-options">
              {REPORT_REASONS.map(r => (
                <label key={r.value} className="reason-option">
                  <input
                    type="radio"
                    name="reason"
                    value={r.value}
                    checked={reason === r.value}
                    onChange={e => setReason(e.target.value)}
                  />
                  <span>{r.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="report-description-section">
            <label>补充说明（可选）</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="请描述具体情况..."
              rows={3}
            />
          </div>
        </div>

        <div className="modal-footer">
          <button className="drive-btn drive-btn-outline" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button className="drive-btn drive-btn-primary" onClick={handleSubmit} disabled={submitting}>
            <Send size={16} />
            {submitting ? '提交中...' : '提交举报'}
          </button>
        </div>
      </div>
    </div>
  );
};
