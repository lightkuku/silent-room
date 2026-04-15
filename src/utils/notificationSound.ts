// 消息提示音工具

let audioContext: AudioContext | null = null;

// 获取或创建音频上下文
function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  return audioContext;
}

// 生成提示音（使用 Web Audio API 生成简单的音效）
export function playNotificationSound(): void {
  try {
    const settings = JSON.parse(localStorage.getItem('notificationSettings') || '{}');
    
    // 检查是否启用了消息提示音
    if (settings.messageSound === false) {
      return;
    }
    
    const ctx = getAudioContext();
    
    // 创建一个简单的"滴"声
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);
    
    oscillator.frequency.value = 800; // 800Hz
    oscillator.type = 'sine';
    
    gainNode.gain.setValueAtTime(0.3, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
    
    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + 0.3);
  } catch (e) {
    console.error('播放提示音失败:', e);
  }
}

// 播放@提及提示音（与普通消息不同的音效）
export function playMentionSound(): void {
  try {
    const settings = JSON.parse(localStorage.getItem('notificationSettings') || '{}');
    
    // 群聊@提及检查（如果设置了这个选项）
    if (settings.groupMention === false) {
      return;
    }
    
    const ctx = getAudioContext();
    
    // 创建更明显的提示音
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);
    
    // 更高的频率，更急促
    oscillator.frequency.value = 1200;
    oscillator.type = 'square';
    
    gainNode.gain.setValueAtTime(0.2, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
    
    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + 0.5);
  } catch (e) {
    console.error('播放@提及提示音失败:', e);
  }
}

// 检查消息内容是否@了当前用户
export function checkMentioned(content: string, currentUsername: string): boolean {
  if (!content || !currentUsername) return false;
  const mentionPattern = new RegExp(`@${currentUsername}\\b|@all\\b|@everyone\\b`, 'i');
  return mentionPattern.test(content);
}
