/**
 * CSRF Token 管理工具
 */

import API from '../config/api';

// CSRF token 存储键名
const CSRF_TOKEN_KEY = 'csrfToken';

// CSRF token 刷新间隔（50分钟，token 有效期1小时）
const CSRF_REFRESH_INTERVAL = 50 * 60 * 1000;

// 获取 CSRF token
export function getCsrfToken(): string | null {
  return sessionStorage.getItem(CSRF_TOKEN_KEY);
}

// 获取 CSRF token（如果不存在则自动刷新）
export async function getCsrfTokenWithRefresh(): Promise<string | null> {
  let token = getCsrfToken();
  if (!token) {
    token = await refreshCsrfToken();
  }
  return token;
}

// 设置 CSRF token
export function setCsrfToken(token: string): void {
  sessionStorage.setItem(CSRF_TOKEN_KEY, token);
}

// 清除 CSRF token
export function clearCsrfToken(): void {
  sessionStorage.removeItem(CSRF_TOKEN_KEY);
}

// 刷新 CSRF token（从服务器获取新的）
export async function refreshCsrfToken(): Promise<string | null> {
  try {
    // 优先使用 adminToken，其次使用普通 token
    const token = localStorage.getItem('adminToken') || localStorage.getItem('token');
    if (!token) return null;

    const response = await fetch(API.auth.csrf, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    const data = await response.json();
    if (data.success && data.data.csrfToken) {
      setCsrfToken(data.data.csrfToken);
      return data.data.csrfToken;
    }
  } catch (e) {
    console.error('[CSRF] Refresh failed:', e);
  }
  return null;
}

// 自动刷新 CSRF token 的定时器
let refreshTimer: ReturnType<typeof setInterval> | null = null;

// 启动自动刷新
export function startCsrfRefresh(): void {
  // 先立即刷新一次
  refreshCsrfToken();
  
  // 设置定时刷新
  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      refreshCsrfToken();
    }, CSRF_REFRESH_INTERVAL);
  }
}

// 停止自动刷新
export function stopCsrfRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  clearCsrfToken();
}

// 添加 CSRF token 到 fetch 请求
export async function fetchWithCsrf(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const csrfToken = getCsrfToken();
  
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>)
  };
  
  // 如果是状态修改请求，添加 CSRF token
  const method = (options.method || 'GET').toUpperCase();
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    if (csrfToken) {
      headers['X-CSRF-Token'] = csrfToken;
    }
  }
  
  return fetch(url, {
    ...options,
    headers
  });
}

// 创建带 CSRF token 的请求头
export function createCsrfHeaders(): Record<string, string> {
  const csrfToken = getCsrfToken();
  const headers: Record<string, string> = {};
  
  if (csrfToken) {
    headers['X-CSRF-Token'] = csrfToken;
  }
  
  return headers;
}

// ==================== 统一 API 请求工具 ====================

export interface ApiRequestOptions extends RequestInit {
  requireAuth?: boolean;
  requireCsrf?: boolean;
  noAlert?: boolean;
}

// CSRF 过期回调（用于自动登出）
let onCsrfExpiredCallback: (() => void) | null = null;

export function setOnCsrfExpired(callback: () => void): void {
  onCsrfExpiredCallback = callback;
}

export async function apiFetch(
  url: string,
  options: ApiRequestOptions = {}
): Promise<Response> {
  const { requireAuth = true, requireCsrf, noAlert = false, ...fetchOptions } = options;
  
  // 自动刷新并重试的内部函数
  const doFetch = async (csrfToken: string | null): Promise<Response> => {
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string>)
    };
    
    // 添加 Authorization header
    if (requireAuth) {
      const authToken = localStorage.getItem('token');
      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }
    }
    
    // 添加 CSRF token
    if (csrfToken) {
      headers['X-CSRF-Token'] = csrfToken;
    }
    
    // 设置默认 Content-Type
    if (!headers['Content-Type'] && fetchOptions.body) {
      headers['Content-Type'] = 'application/json';
    }
    
    return fetch(url, {
      ...fetchOptions,
      headers
    });
  };
  
  // 确定是否需要 CSRF token
  const method = (fetchOptions.method || 'GET').toUpperCase();
  const needsCsrf = requireCsrf ?? ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  
  // 首次请求
  const csrfToken = needsCsrf ? getCsrfToken() : null;
  let response = await doFetch(csrfToken);
  
  // CSRF token 过期时自动刷新并重试
  if (response.status === 403 && needsCsrf) {
    try {
      const data = await response.clone().json();
      if (data.message && (
        data.message.includes('CSRF') || 
        data.message.includes('token') ||
        data.message.includes('无效') ||
        data.message.includes('过期')
      )) {
        // console.log('[CSRF] Token expired, refreshing...');
        
        // 刷新 CSRF token
        const newCsrfToken = await refreshCsrfToken();
        
        if (newCsrfToken) {
          // 使用新 token 重试
          response = await doFetch(newCsrfToken);
          
          // 如果仍然失败，提示用户
          if (response.status === 403) {
            throw new Error('CSRF token 刷新失败');
          }
          
          return response;
        }
        
        // 无法刷新 token
        throw new Error('无法获取新的 CSRF token');
      }
    } catch (e) {
      console.error('[CSRF] Auto-refresh failed:', e);
      
      // 如果设置了 noAlert（如登出操作），直接返回
      if (noAlert) {
        return response;
      }
      
      // 停止 CSRF 刷新
      stopCsrfRefresh();
      
      // 清除本地 token
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      sessionStorage.clear();
      
      // 触发回调
      if (onCsrfExpiredCallback) {
        onCsrfExpiredCallback();
      }
      
      // 刷新页面
      window.location.reload();
    }
  }
  
  return response;
}

// 管理员 API 请求函数
export async function adminApiFetch(
  url: string,
  options: ApiRequestOptions = {}
): Promise<Response> {
  const { requireCsrf, noAlert = false, ...fetchOptions } = options;
  
  // 自动刷新并重试的内部函数
  const doFetch = async (csrfToken: string | null): Promise<Response> => {
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string>)
    };
    
    // 如果调用者已提供 Authorization，使用它；否则使用 adminToken
    if (!headers['Authorization']) {
      const adminToken = localStorage?.getItem('adminToken') || localStorage.getItem('token');
      if (adminToken) {
        headers['Authorization'] = `Bearer ${adminToken}`;
      }
    }
    
    // 添加 CSRF token
    if (csrfToken) {
      headers['X-CSRF-Token'] = csrfToken;
    }
    
    // 设置默认 Content-Type
    if (!headers['Content-Type'] && fetchOptions.body) {
      headers['Content-Type'] = 'application/json';
    }
    
    return fetch(url, {
      ...fetchOptions,
      headers
    });
  };
  
  // 确定是否需要 CSRF token
  const method = (fetchOptions.method || 'GET').toUpperCase();
  const needsCsrf = requireCsrf ?? ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  
  // 首次请求
  const csrfToken = needsCsrf ? getCsrfToken() : null;
  let response = await doFetch(csrfToken);
  
  // CSRF token 过期时自动刷新并重试
  if (response.status === 403 && needsCsrf) {
    try {
      const data = await response.clone().json();
      if (data.message && (
        data.message.includes('CSRF') || 
        data.message.includes('token') ||
        data.message.includes('无效') ||
        data.message.includes('过期')
      )) {
        // console.log('[CSRF] Token expired, refreshing...');
        
        // 刷新 CSRF token
        const newCsrfToken = await refreshCsrfToken();
        
        if (newCsrfToken) {
          // 使用新 token 重试
          response = await doFetch(newCsrfToken);
          
          // 如果仍然失败，提示用户
          if (response.status === 403) {
            throw new Error('CSRF token 刷新失败');
          }
          
          return response;
        }
        
        // 无法刷新 token
        throw new Error('无法获取新的 CSRF token');
      }
    } catch (e) {
      console.error('[CSRF] Auto-refresh failed:', e);
      
      // 如果设置了 noAlert（如登出操作），直接返回
      if (noAlert) {
        return response;
      }
      
      // 停止 CSRF 刷新
      stopCsrfRefresh();
      
      // 清除本地 token
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      sessionStorage.clear();
      
      // 触发回调
      if (onCsrfExpiredCallback) {
        onCsrfExpiredCallback();
      }
      
      // 刷新页面
      window.location.reload();
    }
  }
  
  return response;
}
