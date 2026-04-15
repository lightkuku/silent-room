/**
 * 简单的 API 限流工具
 * 使用内存 + KV 存储实现
 */

interface RateLimitRecord {
  count: number;
  resetTime: number;
}

// 内存中的限流记录（适用于单实例）
const memoryStore: Map<string, RateLimitRecord> = new Map();

// 限流配置
interface RateLimitConfig {
  maxRequests: number;      // 时间窗口内最大请求数
  windowMs: number;        // 时间窗口（毫秒）
}

/**
 * 通用限流检查
 * @param key 限流键（如 IP、用户ID）
 * @param config 限流配置
 * @returns { allowed: boolean, remaining: number, resetIn: number }
 */
export async function checkRateLimit(
  key: string,
  config: RateLimitConfig,
  kvStore?: KVNamespace
): Promise<{ allowed: boolean; remaining: number; resetIn: number }> {
  const now = Date.now();
  const windowKey = `ratelimit:${key}`;
  
  let record: RateLimitRecord;
  
  // 尝试从 KV 获取
  if (kvStore) {
    try {
      const stored = await kvStore.get(windowKey, 'json') as RateLimitRecord | null;
      if (stored && stored.resetTime > now) {
        record = stored;
      } else {
        record = { count: 0, resetTime: now + config.windowMs };
      }
    } catch {
      record = memoryStore.get(windowKey) || { count: 0, resetTime: now + config.windowMs };
    }
  } else {
    record = memoryStore.get(windowKey) || { count: 0, resetTime: now + config.windowMs };
  }
  
  // 检查是否过期
  if (record.resetTime <= now) {
    record = { count: 0, resetTime: now + config.windowMs };
  }
  
  // 增加计数
  record.count++;
  
  // 保存记录
  if (kvStore) {
    try {
      await kvStore.put(windowKey, JSON.stringify(record), { expirationTtl: Math.ceil(config.windowMs / 1000) + 60 });
    } catch {
      memoryStore.set(windowKey, record);
    }
  } else {
    memoryStore.set(windowKey, record);
  }
  
  const allowed = record.count <= config.maxRequests;
  const remaining = Math.max(0, config.maxRequests - record.count);
  const resetIn = Math.max(0, record.resetTime - now);
  
  return { allowed, remaining, resetIn };
}

/**
 * 清除限流记录
 */
export async function clearRateLimit(key: string, kvStore?: KVNamespace): Promise<void> {
  const windowKey = `ratelimit:${key}`;
  
  if (kvStore) {
    try {
      await kvStore.delete(windowKey);
    } catch {}
  }
  
  memoryStore.delete(windowKey);
}

// 预设的限流配置
export const RATE_LIMITS = {
  // 登录/注册：每10分钟最多 5 次
  AUTH: { maxRequests: 5, windowMs: 10 * 60 * 1000 },
  
  // 消息发送：每秒最多 10 条
  MESSAGE: { maxRequests: 10, windowMs: 1000 },
  
  // 消息获取：每秒最多 30 次
  MESSAGE_FETCH: { maxRequests: 30, windowMs: 1000 },
  
  // 文件上传：每分钟最多 20 次
  UPLOAD: { maxRequests: 20, windowMs: 60 * 1000 },
  
  // 常规 API：每秒最多 60 次
  GENERAL: { maxRequests: 60, windowMs: 1000 },
  
  // 管理操作：每秒最多 20 次
  ADMIN: { maxRequests: 20, windowMs: 1000 },
  
  // 好友操作：每分钟最多 30 次
  FRIEND: { maxRequests: 30, windowMs: 60 * 1000 },
  
  // 群组操作：每分钟最多 30 次
  GROUP: { maxRequests: 30, windowMs: 60 * 1000 },
  
  // 搜索操作：每秒最多 10 次
  SEARCH: { maxRequests: 10, windowMs: 1000 },
};

/**
 * 创建限流响应头
 */
export function createRateLimitHeaders(remaining: number, resetIn: number): Record<string, string> {
  return {
    'X-RateLimit-Remaining': String(remaining),
    'X-RateLimit-Reset': String(Math.ceil(resetIn / 1000)),
  };
}
