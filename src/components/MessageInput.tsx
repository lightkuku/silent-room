import React, { useState, useRef } from 'react';
import { CONFIG } from '../config/api';
import { formatFileSize, truncateText } from '../utils/helpers';
import cfSocket from '../utils/cfSocket';
import HandwritingPanel from './HandwritingPanel';
import CandidatePanel from './CandidatePanel';
import AIAssistant from './AIAssistant';
import { Smile, Paperclip, Image, Camera, PenLine, FileText, Flame, Send, Sparkles, X } from 'lucide-react';
import { toast } from '../utils/toast';

interface Attachment {
  id: string;
  type: 'image' | 'file';
  name: string;
  size: number;
  url: string;
  isPending?: boolean;
  previewUrl?: string;
  originalFile?: File;
  encrypted?: boolean;
}

interface ReplyInfo {
  id: string;
  name: string;
  content: string;
}

interface MessageInputProps {
  onSend: (content: string, attachments?: Attachment[], mentions?: string[], burnAfterReading?: boolean) => void;
  replyTo?: ReplyInfo | null;
  onCancelReply?: () => void;
  onUploadProgress?: (progress: { id: string; filename: string; progress: number; status: 'uploading' | 'completed' | 'error'; type: 'upload' | 'download' }) => void;
  onUploadError?: (message: string) => void;
  groupMembers?: { id: string; name: string }[];
  chatType?: 'friend' | 'group';
  onAddPendingFiles?: (files: File[]) => void;
  showAIAssistant?: boolean;
  onToggleAIAssistant?: () => void;
  isMuted?: boolean;
  muteReason?: string;
}

const MAX_FILE_SIZE = CONFIG.MAX_UPLOAD_SIZE;

const EMOJIS = [
  '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '😊',
  '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😋', '😛', '😜',
  '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🤐', '🤨', '😐',
  '😑', '😶', '😏', '😒', '🙄', '😬', '🤥', '😌', '😔', '😪',
  '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮', '🤧', '🥵', '🥶',
  '🥴', '😵', '🤯', '🤠', '🥳', '😎', '🤓', '🧐', '😕', '😟',
  '🙁', '☹️', '😮', '😯', '😲', '😳', '🥺', '😦', '😧', '😨',
  '😰', '😥', '😢', '😭', '😱', '😖', '😣', '😞', '😓', '😩',
  '😫', '🥱', '😤', '😡', '😠', '🤬', '😈', '👿', '💀', '☠️',
  '💩', '🤡', '👹', '👺', '👻', '👽', '👾', '🤖', '👍', '👎',
  '👏', '🙌', '🤝', '🙏', '💪', '✌️', '🤞', '🤟', '🤘', '👌',
  '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '💔', '❣️', '💕',
  '💞', '💓', '💗', '💖', '💘', '💝', '⭐', '🌟', '✨', '🔥',
  '💯', '🎉', '🎊', '🎈', '🏆', '🥇', '🎯', '🎮', '🎲', '🎸',
  '🎤', '🎧', '🎼', '🎹', '🥁', '🎷', '🎺', '🎻', '🍕', '🍔',
  '🍟', '🍿', '🍩', '🍪', '☕', '🍵', '🍺', '🍻', '🥂', '🍷'
];

export const MessageInput: React.FC<MessageInputProps> = ({ onSend, replyTo, onCancelReply, onUploadProgress, onUploadError, groupMembers, chatType, onAddPendingFiles, showAIAssistant, onToggleAIAssistant, isMuted, muteReason }) => {
  const [message, setMessage] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showMentionList, setShowMentionList] = useState(false);
  const [showHandwriting, setShowHandwriting] = useState(false);
  const [showCandidate, setShowCandidate] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [burnAfterReading, setBurnAfterReading] = useState(false);
  
  // 使用 props 或默认值
  const isAIAssistantOpen = showAIAssistant !== undefined ? showAIAssistant : false;
  const toggleAIAssistantFn = onToggleAIAssistant || (() => {});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const messageInputRef = useRef<HTMLInputElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastTypingTimeRef = useRef<number>(0);

  // 选择手写文字
  const handleHandwritingSelect = (text: string) => {
    setMessage(prev => prev + text);
    setShowHandwriting(false);
    messageInputRef.current?.focus();
  };

  // 选择候选词
  const handleCandidateSelect = (text: string) => {
    setMessage(prev => prev + text);
    setShowCandidate(false);
    messageInputRef.current?.focus();
  };

  // 添加待上传文件（拖拽或点击按钮）
  const addPendingFiles = (files: File[]) => {
    const validFiles = files.filter(file => file.size <= MAX_FILE_SIZE);
    if (validFiles.length !== files.length) {
      if (onUploadError) {
        onUploadError('部分文件超过大小限制');
      }
    }
    
    const newAttachments: Attachment[] = validFiles.map(file => ({
      id: `att_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: file.type.startsWith('image/') ? 'image' as const : 'file' as const,
      name: file.name,
      size: file.size,
      url: '',  // 待上传文件没有URL
      isPending: true,
      previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
      originalFile: file,  // 保存原始 File 对象
      encrypted: false  // 默认不加密，稍后根据密钥状态更新
    }));
    
    setAttachments(prev => [...prev, ...newAttachments]);
  };

  // 截图功能
  const handleScreenshot = async () => {
    try {
      // 使用屏幕捕获 API
      const stream = await navigator.mediaDevices.getDisplayMedia({ 
        video: { 
          displaySurface: 'monitor',
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        } 
      });
      
      // 创建 video 元素来播放流
      const video = document.createElement('video');
      video.srcObject = stream;
      video.play();
      
      // 等待视频加载
      await new Promise<void>((resolve) => {
        video.onloadedmetadata = () => {
          video.onloadedmetadata = null;
          resolve();
        };
      });
      
      // 创建 canvas 并截图
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        
        // 停止流
        stream.getTracks().forEach(track => track.stop());
        
        // 转换为 blob
        canvas.toBlob((blob) => {
          if (blob) {
            // 生成文件名
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `screenshot-${timestamp}.png`;
            
            // 创建 File 对象
            const file = new File([blob], filename, { type: 'image/png' });
            
            // 添加到附件
            addPendingFiles([file]);
          }
        }, 'image/png');
      }
    } catch (err) {
      console.error('截图失败:', err);
      // 用户取消或出错时不显示错误
    }
  };

  // 外部调用添加文件
  React.useEffect(() => {
    if (onAddPendingFiles) {
      (window as any).__addPendingFiles = addPendingFiles;
    }
    return () => {
      delete (window as any).__addPendingFiles;
    };
  }, [onAddPendingFiles]);

  // 提取@提及的用户
  const extractMentions = (text: string): string[] => {
    const mentionRegex = /@(\S+)/g;
    const mentions: string[] = [];
    let match;
    while ((match = mentionRegex.exec(text)) !== null) {
      // 检查是否是@所有人
      if (match[1] === '所有人' || match[1] === 'all') {
        mentions.push('__all__');
        continue;
      }
      const member = groupMembers?.find(m => m.name === match[1]);
      if (member) {
        mentions.push(member.id);
      }
    }
    return mentions;
  };

  // 处理输入变化，检测@提及
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setMessage(value);
    
    // 发送typing状态（每3秒最多发送一次）
    const now = Date.now();
    if (now - lastTypingTimeRef.current > 3000) {
      lastTypingTimeRef.current = now;
      const activeChatId = (window as any).__activeChatId;
      if (activeChatId) {
        cfSocket.sendTyping(activeChatId);
      }
    }
    
    // 检测@输入
    const lastAtIndex = value.lastIndexOf('@');
    if (lastAtIndex !== -1) {
      const textAfterAt = value.slice(lastAtIndex + 1);
      // 如果输入@all或@所有人，添加到提及列表
      if (textAfterAt.toLowerCase().startsWith('all') || textAfterAt.includes('所有人')) {
        setMentionFilter('@all');
        setShowMentionList(true);
      } else if (!textAfterAt.includes(' ') && chatType === 'group') {
        setMentionFilter(textAfterAt.toLowerCase());
        setShowMentionList(true);
      } else {
        setShowMentionList(false);
      }
    } else {
      setShowMentionList(false);
    }
  };

  // 选择提及的用户或@所有人
  const selectMention = (member: { id: string; name: string } | 'all') => {
    const lastAtIndex = message.lastIndexOf('@');
    let newMessage: string;
    if (member === 'all') {
      newMessage = message.slice(0, lastAtIndex) + '@所有人 ';
    } else {
      newMessage = message.slice(0, lastAtIndex) + '@' + member.name + ' ';
    }
    setMessage(newMessage);
    setShowMentionList(false);
    messageInputRef.current?.focus();
  };

  // 选择@所有人
  const selectMentionAll = () => {
    selectMention('all');
  };

  // 过滤后的群成员
  const filteredMembers = groupMembers?.filter(m => 
    m.name.toLowerCase().includes(mentionFilter === '@all' ? '' : mentionFilter)
  ) || [];
  
  // 是否显示@所有人选项
  const showMentionAll = chatType === 'group' && (
    mentionFilter === '@all' || 
    mentionFilter === '' || 
    '所有人'.includes(mentionFilter) ||
    'all'.includes(mentionFilter.toLowerCase())
  );

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (isMuted) {
      toast.error('无法发送', muteReason || '您已被禁言，无法发送消息');
      return;
    }
    if (message.trim() || attachments.length > 0) {
      const mentions = extractMentions(message);
      onSend(message, attachments, mentions, burnAfterReading);
      setMessage('');
      setAttachments([]);
      setBurnAfterReading(false);
      if (replyTo) {
        onCancelReply?.();
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    addPendingFiles(Array.from(files));
    e.target.value = '';
  };

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const addEmoji = (emoji: string) => {
    setMessage(prev => prev + emoji);
    setShowEmojiPicker(false);
  };

  return (
    <div className="message-input-wrapper">
      {/* Reply indicator */}
      {replyTo && (
        <div className="reply-indicator">
          <div className="reply-info">
            <span className="reply-label">回复 </span>
            <span className="reply-name">{replyTo.name}</span>
            <span className="reply-content">: {truncateText(replyTo.content, 30)}</span>
          </div>
          <button className="cancel-reply" onClick={onCancelReply}>×</button>
        </div>
      )}

      {/* Attachment preview - includes both uploaded and pending attachments */}
      {attachments.length > 0 && (
        <div className="attachment-preview">
          {attachments.map((att, index) => (
            <div key={index} className="attachment-item">
              {att.type === 'image' ? (
                <img src={att.isPending && att.previewUrl ? att.previewUrl : att.url} alt={att.name} className="attachment-image-preview" />
              ) : (
                <div className="attachment-file-preview">
                  <span className="file-icon">📄</span>
                  <div className="file-info">
                    <span className="file-name">{att.name}</span>
                    <span className="file-size">{formatFileSize(att.size)}</span>
                  </div>
                </div>
              )}
              <button className="remove-attachment" onClick={() => removeAttachment(index)}>×</button>
            </div>
          ))}
        </div>
      )}

	  <div className="input-actions">
          <div className="input-action-wrapper">
            <button 
              className="input-action" 
              title="表情"
              onClick={() => setShowEmojiPicker(!showEmojiPicker)}
            >
              <Smile size={20} />
            </button>
            {showEmojiPicker && (
              <div className="emoji-picker">
                <div className="emoji-grid">
                  {EMOJIS.map((emoji, index) => (
                    <button 
                      key={index} 
                      className="emoji-btn"
                      onClick={() => addEmoji(emoji)}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <button className="input-action" title="文件" onClick={() => fileInputRef.current?.click()}>
            <Paperclip size={20} />
          </button>
          <button className="input-action" title="图片" onClick={() => imageInputRef.current?.click()}>
            <Image size={20} />
          </button>
          <button className="input-action" title="截图" onClick={handleScreenshot}>
            <Camera size={20} />
          </button>
          <div className="input-action-wrapper">
		      <button 
		        className={`input-action ${showHandwriting ? 'active' : ''}`} 
		        title="手写识别" 
		        onClick={() => { setShowHandwriting(!showHandwriting); setShowCandidate(false); }}
		      >
		        <PenLine size={20} />
		      </button>
		      {/* 手写识别面板 */}
			  <HandwritingPanel
				isOpen={showHandwriting}
				onClose={() => setShowHandwriting(false)}
				onSelectText={handleHandwritingSelect}
				onSendImage={(imageDataUrl) => {
				  // 关闭写字板
				  setShowHandwriting(false);
				  // 将base64图片转换为文件并压缩为JPG
				  const img = document.createElement('img');
				  img.onload = () => {
				    const canvas = document.createElement('canvas');
				    canvas.width = img.width;
				    canvas.height = img.height;
				    const ctx = canvas.getContext('2d');
				    if (ctx) {
				      ctx.fillStyle = '#ffffff';
				      ctx.fillRect(0, 0, canvas.width, canvas.height);
				      ctx.drawImage(img, 0, 0);
				      canvas.toBlob((blob) => {
				        if (blob) {
				          const file = new File([blob], 'handwriting.jpg', { type: 'image/jpeg' });
				          onAddPendingFiles?.([file]);
				        }
				      }, 'image/jpeg', 0.8);
				    }
				  };
				  img.src = imageDataUrl;
				}}
			  />
		  </div>
		  <div className="input-action-wrapper">
		      <button 
		        className={`input-action ${showCandidate ? 'active' : ''}`} 
		        title="快捷短语" 
		        onClick={() => { setShowCandidate(!showCandidate); setShowHandwriting(false); }}
		      >
		        <FileText size={20} />
		      </button>
		      {/* 快捷短语面板 */}
			  <CandidatePanel
				isOpen={showCandidate}
				onClose={() => setShowCandidate(false)}
				onSelectCandidate={handleCandidateSelect}
			  />
		  </div>
          <button 
            className={`input-action ${burnAfterReading ? 'active' : ''}`} 
            title="阅后即焚" 
            onClick={() => setBurnAfterReading(!burnAfterReading)}
            style={{ color: burnAfterReading ? '#ff4757' : undefined }}
          >
            <Flame size={20} />
          </button>
          <button 
            className={`input-action ${isAIAssistantOpen ? 'active' : ''}`} 
            title="AI 助手" 
            onClick={toggleAIAssistantFn}
            style={{ color: isAIAssistantOpen ? '#8b5cf6' : undefined }}
          >
            <Sparkles size={20} />
          </button>
        </div>

      <div className="message-input-area">
        
        
        <textarea
          ref={messageInputRef}
          className="message-input"
          placeholder={chatType === 'group' ? "输入消息... 使用@提及成员...按 Shift + 回车键换行" : "输入消息...按 Shift + 回车键换行"}
          value={message}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          rows={1}
        />
        
        {/* @提及成员列表 */}
        {showMentionList && (
          <div className="mention-list">
            {showMentionAll && (
              <div 
                className="mention-item mention-all"
                onClick={selectMentionAll}
              >
                @所有人
              </div>
            )}
            {filteredMembers.slice(0, 5).map(member => (
              <div 
                key={member.id} 
                className="mention-item"
                onClick={() => selectMention(member)}
              >
                {member.name}
              </div>
            ))}
          </div>
        )}
        
        <button 
          className="send-button" 
          onClick={() => handleSubmit()}
          disabled={!message.trim() && attachments.length === 0}
          title="发送"
        >
          <Send size={18} />
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        style={{ display: 'none' }}
        onChange={handleFileSelect}
      />
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={handleFileSelect}
      />
       
    </div>
  );
};

export default MessageInput;
