import React, { useState, useRef, useEffect } from 'react';
import { Send, Trash2, Sparkles, Loader2, X, Copy, Check, Image, Upload } from 'lucide-react';
import { toast } from '../utils/toast';
import { ai } from '../services/api';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

const SYSTEM_PROMPT = `你是一个智能助手，名字叫 Lumen AI。

## 核心能力
1. 理解用户问题的真实意图
2. 提供详细、准确、有帮助的回答
3. 解释技术原理，让用户明白"为什么"
4. 给出清晰的操作步骤
5. **自动生成完整、可运行的代码**

## 回答格式要求

### 对于代码生成类问题，请这样回答：

**需求分析：**
[理解用户想要实现什么功能]

**代码实现：**
\`\`\`[语言类型]
[完整可运行的代码]
\`\`\`

**代码解释：**
[逐行或分段解释代码的作用]

**使用方法：**
1. 第一步：...
2. 第二步：...

### 对于技术/操作类问题，请这样回答：

**问题分析：**
[先用1-2句话概括问题的核心]

**原理说明：**
[解释相关技术原理，帮助用户理解]

**解决方案：**
1. 第一步：...
2. 第二步：...
3. 第三步：...

**完整示例：**
[如果有代码，给出完整可运行的示例，并解释每一行的作用]

### 对于概念/知识类问题，请这样回答：

**简要回答：**
[直接给出核心答案]

**详细解释：**
[深入解释相关知识点]

**补充信息：**
[可选的扩展知识或注意事项]

## 回答风格
- 用中文回答
- 保持逻辑清晰，条理分明
- 如果问题不明确，先确认用户意图再回答
- 不确定的问题如实告知，并提供可能的方向
- 代码要完整、可运行，不要只给出片段`;

export default function AIAssistant({ onClose }: { onClose?: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [uploadedImage, setUploadedImage] = useState<{ base64: string; mimeType: string } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  // 复制文本到剪贴板
  const handleCopy = async (content: string, msgId: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedId(msgId);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (e) {
      toast.error('复制失败');
    }
  };

  // 处理图片选择
  // 将文件转换为 base64
  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    if (!file.type.startsWith('image/')) {
      toast.error('请选择图片文件');
      return;
    }

    try {
      // 直接转换为 base64
      const base64 = await fileToBase64(file);
      setUploadedImage({ base64, mimeType: file.type });
    } catch (error) {
      console.error('图片处理错误:', error);
      toast.error('图片处理失败');
    } finally {
      if (imageInputRef.current) {
        imageInputRef.current.value = '';
      }
    }
  };

  // 移除上传的图片
  const removeImage = () => {
    setUploadedImage(null);
  };

  // 发送图片识别请求
  const handleVisionRequest = async () => {
    if (!uploadedImage?.base64 || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: input.trim() || '请详细描述这张图片的内容'
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const data = await ai.vision(
        uploadedImage.base64,
        input.trim() || '请详细描述这张图片的内容，并给出相关问题的解决方案'
      );

      if (data.success) {
        const assistantMessage: Message = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: data.message
        };
        setMessages(prev => [...prev, assistantMessage]);
      } else {
        toast.error(data.message || '图像识别失败');
      }
    } catch (error) {
      console.error('AI vision error:', error);
      toast.error('发送失败，请重试');
    } finally {
      setIsLoading(false);
      removeImage();
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = async () => {
    if (uploadedImage?.base64) {
      await handleVisionRequest();
      return;
    }

    if (!input.trim() || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: input.trim()
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const allMessages = messages.concat(userMessage).map(m => ({
        role: m.role,
        content: m.content
      }));
      
      const data = await ai.chat(allMessages, SYSTEM_PROMPT);

      if (data.success) {
        const assistantMessage: Message = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: data.message
        };
        setMessages(prev => [...prev, assistantMessage]);
      } else {
        toast.error(data.message || 'AI 服务暂时不可用');
      }
    } catch (error) {
      console.error('AI chat error:', error);
      toast.error('发送失败，请重试');
    } finally {
      setIsLoading(false);
    }
  };

  const handleClear = () => {
    setMessages([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    (e.target as HTMLTextAreaElement).style.height = 'auto';
    (e.target as HTMLTextAreaElement).style.height = (e.target as HTMLTextAreaElement).scrollHeight + 'px';
  };

  // 渲染带代码高亮的内容
  const renderContent = (content: string) => {
    // 处理代码块
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match;

    while ((match = codeBlockRegex.exec(content)) !== null) {
      // 添加代码块之前的文本
      if (match.index > lastIndex) {
        parts.push(content.slice(lastIndex, match.index));
      }

      const language = match[1] || '';
      const code = match[2].trim();
      parts.push(
        <pre key={match.index} className="ai-code-block">
          <code className={language ? `language-${language}` : ''}>{code}</code>
        </pre>
      );

      lastIndex = match.index + match[0].length;
    }

    // 添加剩余文本
    if (lastIndex < content.length) {
      parts.push(content.slice(lastIndex));
    }

    return parts.length > 0 ? parts : content;
  };

  return (
    <div className="ai-assistant-container">
      <div className="ai-assistant-header">
        <div className="ai-assistant-title">
          <Sparkles size={18} className="ai-icon" />
          <span>AI 助手</span>
        </div>
        <div className="ai-assistant-actions">
		    <button
		      className="ai-image-btn"
		      onClick={() => imageInputRef.current?.click()}
		      disabled={isLoading}
		      title="上传图片"
		    >
		      <Image size={18} />
		    </button>
          <button
            onClick={handleClear}
            disabled={messages.length === 0}
            className="ai-action-btn"
            title="清空对话"
          >
            <Trash2 size={16} />
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="ai-action-btn"
              title="关闭"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="ai-assistant-messages">
        {messages.length === 0 && (
          <div className="ai-empty">
            <Sparkles size={48} className="ai-empty-icon" />
            <p className="ai-empty-title">你好！我是 Lumen AI</p>
            <p className="ai-empty-subtitle">有什么我可以帮你的吗？</p>
          </div>
        )}
        
        {messages.map(msg => (
          <div
            key={msg.id}
            className={`ai-message ${msg.role === 'user' ? 'ai-message-user' : 'ai-message-assistant'}`}
          >
            <div className="ai-bubble">
              <div className="ai-bubble-text">{renderContent(msg.content)}</div>
              {msg.role === 'assistant' && (
                <button
                  className="ai-copy-btn"
                  onClick={() => handleCopy(msg.content, msg.id)}
                  title="复制"
                >
                  {copiedId === msg.id ? <Check size={14} /> : <Copy size={14} />}
                </button>
              )}
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="ai-message ai-message-assistant">
            <div className="ai-bubble ai-bubble-loading">
              <Loader2 size={18} className="ai-spinner" />
              <span>思考中...</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {uploadedImage && (
        <div className="ai-image-preview">
          <img src={uploadedImage.base64} alt="上传的图片" />
          <button className="ai-image-remove" onClick={removeImage}>
            <X size={14} />
          </button>
        </div>
      )}

      <div className="ai-assistant-input">
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={handleImageSelect}
        />
        <textarea
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder={uploadedImage ? "描述图片或提问..." : "输入问题..."}
          rows={1}
          className="ai-textarea"
        />
        <button
          onClick={handleSend}
          disabled={(!input.trim() && !uploadedImage) || isLoading}
          className="ai-send-btn"
        >
          <Send size={18} />
        </button>
      </div>
    </div>
  );
}
