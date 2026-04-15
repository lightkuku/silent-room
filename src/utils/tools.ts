import { CONFIG, API_BASE_URL } from '../config/api';

// 处理头像URL，添加API_BASE_URL前缀
export const getAvatarUrl = (avatar: string | undefined): string => {
  if (!avatar) return '';
  // 去掉 .json 后缀
  const cleanAvatar = avatar.replace(/\.json$/, '');
  if (cleanAvatar.startsWith('/api/avatar/')) {
    return `${API_BASE_URL}${cleanAvatar}`;
  }
  if (!cleanAvatar.includes('/')) {
    return `${API_BASE_URL}/api/avatar/${cleanAvatar}`;
  }
  return cleanAvatar;
};
