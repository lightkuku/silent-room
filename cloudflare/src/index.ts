import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and, desc, sql, like, or, ne } from 'drizzle-orm';
import * as schema from './schema';
import { registerDriveRoutes } from './drive';
import { registerNotificationRoutes } from './notifications';
import { FileManager } from './file';
import { initDatabase } from './db-init';
import { generateToken, verifyToken, generateCsrfToken, verifyCsrfToken, TokenPayload, setAuthSecrets, getPasswordSalt, hashPassword, comparePassword } from './auth';
import { verifyTurnstileToken } from './turnstile';
import { validateString, validatePassword, isValidUsername, ValidationError } from './validation';
import { checkRateLimit, RATE_LIMITS, createRateLimitHeaders } from './rateLimit';
import { AccessMonitor } from './accessMonitor';

declare global {
  var wsServer: any;
}

type Bindings = {
  DB: D1Database;
  UPLOADS: KVNamespace;
  CHAT: DurableObjectNamespace;
  R2: R2Bucket;
  ADMIN_PASSWORD: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_AI_TOKEN: string;
  TURNSTILE_SECRET_KEY: string;
  ALLOWED_DOMAINS?: string;
  JWT_SECRET_KEY: string;
  CSRF_SECRET_KEY: string;
  PASSWORD_SALT?: string;
};

const DEFAULT_PHRASES = [
  '好的', '收到', '明白', '谢谢', '不客气', '抱歉', '对不起', '没关系',
  '可以', '不行', '是的', '不是', '知道了', '没问题', '一会儿', '现在',
  '明天', '后天', '下次', '等一下', '等会儿', '好的知道了', '再见', 'Bye',
  '辛苦了', '谢谢你', '不用谢', '不好意思', '麻烦你了', 'See you',
  '在工作', '在忙', '不在', '在休息', '出去了', '回来了', '在开会',
  '在吃饭', '在路上', '快到了', '马上到', '稍等片刻'
];

const fileManager = new FileManager('chat/files');

const app = new Hono<{ Bindings: Bindings }>();

// 访问监控实例
let accessMonitor: AccessMonitor | null = null;

let tablesInitialized = false;
let authInitialized = false;

// 自动初始化数据库（表、索引、管理员）
app.use('*', async (c, next) => {
  try {
    const jwtSecret = c.env.JWT_SECRET_KEY;
    const csrfSecret = c.env.CSRF_SECRET_KEY;
    
    // 始终设置 secrets，确保 WebSocket 路由能获取到（每个请求都要设置）
    setAuthSecrets(jwtSecret, csrfSecret);
    authInitialized = true;
    
    // 初始化访问监控
    if (!accessMonitor) {
      accessMonitor = new AccessMonitor(c.env);
    }
    c.set('accessMonitor', accessMonitor);
    
    if (!tablesInitialized) {
      // console.log('[DB] 开始初始化数据库, ADMIN_PASSWORD:', c.env.ADMIN_PASSWORD ? '已设置' : '未设置');
      await initDatabase(c.env.DB, c.env.ADMIN_PASSWORD, c.env);
      tablesInitialized = true;
      // console.log('[DB] 数据库初始化完成');
    }
    await next();
  } catch (error) {
    console.error('[DB] Initialization error:', error);
    await next();
  }
});

// CORS 配置 - 从环境变量读取允许的域名
app.options('*', async (c) => {
  const requestOrigin = c.req.header('origin');
  const allowedOrigins = (c.env.ALLOWED_DOMAINS || '').split(',').map(s => s.trim()).filter(Boolean);
  
  if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    c.res.headers.set('Access-Control-Allow-Origin', requestOrigin);
    c.res.headers.set('Access-Control-Allow-Credentials', 'true');
  }
  
  c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  c.res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token, x-csrf-token, Upgrade, Sec-WebSocket-Key, Sec-WebSocket-Version, Sec-WebSocket-Extensions');
  
  return new Response(null, { status: 204 });
});

app.use('*', async (c, next) => {
  const requestOrigin = c.req.header('origin');
  const allowedOrigins = (c.env.ALLOWED_DOMAINS || '').split(',').map(s => s.trim()).filter(Boolean);
  
  if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    c.res.headers.set('Access-Control-Allow-Origin', requestOrigin);
    c.res.headers.set('Access-Control-Allow-Credentials', 'true');
  }
  
  c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  c.res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token, x-csrf-token, Upgrade, Sec-WebSocket-Key, Sec-WebSocket-Version, Sec-WebSocket-Extensions');
  
  await next();
});

// 安全响应头中间件（包含 CORS 和访问日志）
app.use('*', async (c, next) => {
  const startTime = Date.now();
  const path = c.req.path;
  const method = c.req.method;
  const ip = c.req.header('CF-Connecting-IP') || '';
  
  await next();
  
  const duration = Date.now() - startTime;
  const status = c.res.status;
  const userId = c.get('userId') || '';
  const accessMonitor = c.get('accessMonitor') as AccessMonitor | undefined;
  
  // 记录 API 访问日志（仅生产环境或特定路径）
  if (accessMonitor && path.startsWith('/api/')) {
    const ctx = { waitUntil: (p: Promise<any>) => c.executionCtx.waitUntil(p) };
    accessMonitor.logApiAccess(c.req.raw, userId, ip, path, method, status, duration, ctx);
  }
  
  const origin = c.req.header('origin') || '';
  const allowedOrigins = getAllowedOrigins(c.env);
  
  // 如果是允许的域名，添加 CORS 头
  if (origin && allowedOrigins.includes(origin)) {
    c.res.headers.set('Access-Control-Allow-Origin', origin);
    c.res.headers.set('Access-Control-Allow-Credentials', 'true');
  }
  
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('X-Frame-Options', 'DENY');
  c.res.headers.set('X-XSS-Protection', '1; mode=block');
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // Content-Security-Policy
  c.res.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https: blob:; connect-src 'self' https: wss:; frame-src https://challenges.cloudflare.com;");
  // Strict-Transport-Security (强制 HTTPS)
  c.res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
});



// ==================== 工具函数 ====================

// 获取允许的域名列表
function getAllowedOrigins(env: Bindings): string[] {
  return (env.ALLOWED_DOMAINS || '').split(',').map(o => o.trim()).filter(Boolean);
}

// 获取 CORS 响应头（仅 CORS 相关）
function getCorsHeaders(env: Bindings, request: Request): Record<string, string> {
  const origin = request.headers.get('origin') || '';
  const allowedOrigins = getAllowedOrigins(env);
  
  // 如果是允许的域名，添加 CORS 头
  if (origin && allowedOrigins.includes(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-CSRF-Token, x-csrf-token, Upgrade, Sec-WebSocket-Key, Sec-WebSocket-Version, Sec-WebSocket-Extensions'
    };
  }
  
  return {};
}

// 获取 UTC 时间戳（毫秒）
const utcNow = (): number => Date.now();

// 加载聊天存储设置
async function getChatStorageType(DB: D1Database): Promise<string> {
  try {
    const db = drizzle(DB);
    const row = await db.select({ value: schema.system_settings.value })
      .from(schema.system_settings)
      .where(eq(schema.system_settings.key, 'storageType'))
      .get();
    return row?.value || 'r2';
  } catch (e) {
    console.error('加载聊天存储设置失败:', e);
    return 'r2';
  }
}

// 下载文件(支持第三方网盘存储)
async function upload(c, file, encrypted = false, encryptedName?: string): Promise<string> {
    let fileUrl: string;
    const db = drizzle(c.env.DB);
    await fileManager.initAsync(db, c.env.R2, c.env.UPLOADS);

    if (!file) {
        return c.json({ success: false, message: '没有文件' }, 400);
    }

    // 存储key使用时间戳+uuid，不包含文件名
    const key = `${utcNow()}-${crypto.randomUUID()}`;
    const arrayBuffer = await file.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);

    try {
        fileUrl = await fileManager.uploadToStorage(key, uint8Array, file.type);
        return fileUrl;
    } catch (e) {
        console.error('文件上传失败:', e);
        return false;
    }
}

// Mime类型到扩展名的映射
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/tiff': 'tiff',
  'image/tif': 'tif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/ogg': 'ogv',
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/aac': 'aac',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/x-rar-compressed': 'rar',
  'application/x-7z-compressed': '7z',
  'application/json': 'json',
  'application/xml': 'xml',
  'text/plain': 'txt',
  'text/html': 'html',
  'text/css': 'css',
  'text/javascript': 'js',
  'application/javascript': 'js',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

// 从MIME类型获取文件扩展名
function getExtensionFromMimeType(mimeType: string): string | null {
  return MIME_TO_EXT[mimeType] || null;
}

// 从文件数据（Uint8Array）检测文件类型
function detectFileType(data: Uint8Array): string | null {
  if (data.length < 4) return null;
  
  // 检查文件头签名
  const header = data[0] << 24 | data[1] << 16 | data[2] << 8 | data[3];
  
  // JPEG: FF D8 FF
  if (data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) return 'image/jpeg';
  // PNG: 89 50 4E 47
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) return 'image/png';
  // GIF: 47 49 46 38
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return 'image/gif';
  // WebP: 52 49 46 46 (RIFF) + 57 45 42 50 (WEBP)
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
      data[4] === 0x57 && data[5] === 0x45 && data[6] === 0x42 && data[7] === 0x50) return 'image/webp';
  // PDF: 25 50 44 46
  if (data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46) return 'application/pdf';
  // ZIP: 50 4B 03 04
  if (data[0] === 0x50 && data[1] === 0x4B && data[2] === 0x03 && data[3] === 0x04) return 'application/zip';
  // MP3: 49 44 33 或 FF FB
  if (data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) return 'audio/mpeg';
  if (data[0] === 0xFF && (data[1] === 0xFB || data[1] === 0xF3 || data[1] === 0xF2)) return 'audio/mpeg';
  // WAV: 52 49 46 46 + 57 41 56 45
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
      data[8] === 0x57 && data[9] === 0x41 && data[10] === 0x56 && data[11] === 0x45) return 'audio/wav';
  // BMP: 42 4D
  if (data[0] === 0x42 && data[1] === 0x4D) return 'image/bmp';
  // ICO: 00 00 01 00
  if (data[0] === 0x00 && data[1] === 0x00 && data[2] === 0x01 && data[3] === 0x00) return 'image/x-icon';
  
  return null;
}

// timing-safe 字符串比较
const timingSafeCompare = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
};

const encrypt = (text: string, key: string): string => {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  return btoa(String.fromCharCode(...data));
};

// 认证中间件
const auth = async (c: any, next: () => Promise<void>) => {
  let token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (token?.startsWith('"')) {
    token = token.substring(1);
  }
  if (token?.endsWith('"')) {
    token = token.slice(0, -1);
  }
  const jwtSecret = c.env.JWT_SECRET_KEY;
  if (!jwtSecret) {
    return c.json({ success: false, message: '服务器错误' }, 500);
  }
  const decoded = await verifyToken(token || '', jwtSecret);
  if (!decoded) return c.json({ success: false, message: '未登录' }, 401);
  c.set('userId', decoded.id);
  c.set('username', decoded.username);
  c.set('userRole', decoded.role);
  c.set('userExp', decoded.exp);
  await next();
};

// 管理员中间件
const adminAuth = async (c: any, next: () => Promise<void>) => {
  let token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (token?.startsWith('"')) {
    token = token.substring(1);
  }
  if (token?.endsWith('"')) {
    token = token.slice(0, -1);
  }
  const jwtSecret = c.env.JWT_SECRET_KEY;
  if (!jwtSecret) {
    return c.json({ success: false, message: '服务器错误' }, 500);
  }
  const decoded = await verifyToken(token || '', jwtSecret);
  if (!decoded) {
    return c.json({ success: false, message: '权限不足' }, 403);
  }
  
  // 支持两种角色：admin（用户角色）或 super_admin（管理员角色）
  if (decoded.role !== 'admin' && decoded.role !== 'super_admin') {
    return c.json({ success: false, message: '权限不足' }, 403);
  }
  
  c.set('adminId', decoded.id);
  c.set('isSuperAdmin', decoded.role === 'super_admin');
  await next();
};

// 超级管理员专用中间件
const superAdminAuth = async (c: any, next: () => Promise<void>) => {
  const isSuperAdmin = c.get('isSuperAdmin');
  if (!isSuperAdmin) {
    return c.json({ success: false, message: '需要超级管理员权限' }, 403);
  }
  await next();
};

// CSRF 验证中间件（仅对状态修改请求生效）
const csrfProtection = async (c: any, next: () => Promise<void>) => {
  // 仅对 POST/PUT/PATCH/DELETE 请求验证 CSRF
  const method = c.req.method;
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    await next();
    return;
  }

  // 获取 CSRF token（从头部或 body 中）
  const csrfToken = c.req.header('X-CSRF-Token') || 
                    c.req.header('x-csrf-token') ||
                    (await c.req.json().catch(() => ({})))._csrf;

  if (!csrfToken) {
    console.error('[CSRF] Missing token');
    return c.json({ success: false, message: 'CSRF token 缺失' }, 403);
  }

  // 验证 CSRF token
  const userId = c.get('userId');
  if (!userId) {
    await next();
    return;
  }

  const isValid = await verifyCsrfToken(csrfToken, userId);
  if (!isValid) {
    console.error('[CSRF] Invalid token for user:', userId);
    return c.json({ success: false, message: 'CSRF token 无效或已过期' }, 403);
  }

  await next();
};

// ==================== 用户认证 ====================

app.post('/api/auth/logout', auth, async (c) => {
  try {
    const userId = c.get('userId');
    const db = drizzle(c.env.DB);

    // 检查用户是否被封禁或禁言，保持相应状态
    const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
    const banRecord = await db.select().from(schema.userBans).where(eq(schema.userBans.userId, userId)).get();
    
    let newStatus = 'offline';
    if (banRecord) {
      newStatus = 'banned';
    } else if (user?.status === 'muted') {
      newStatus = 'muted';
    }
    
    // console.log('[Logout] userId:', userId, 'newStatus:', newStatus);

    // 更新用户状态
    await db.update(schema.users)
      .set({ status: newStatus })
      .where(eq(schema.users.id, userId));

    // 通过 Durable Object 广播用户离线状态
    try {
      const chatId = c.env.CHAT.idFromName('global');
      const chatStub = c.env.CHAT.get(chatId);
      
      await chatStub.fetch('https://dummy/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'userStatus',
          data: { userId, status: newStatus }
        })
      });
    } catch (broadcastError) {
      console.error('[Logout] Broadcast error:', broadcastError);
    }

    return c.json({ success: true, message: '登出成功' });
  } catch (e) {
    console.error('Logout error:', e);
    return c.json({ success: false, message: '登出失败' }, 500);
  }
});

app.post('/api/auth/login', async (c) => {
  try {
    // 登录限流：基于 IP
    const clientIP = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown';
    const rateLimitKey = `login:${clientIP}`;
    const { allowed, remaining, resetIn } = await checkRateLimit(rateLimitKey, RATE_LIMITS.AUTH);

    // 设置限流响应头
    const rateLimitHeaders = createRateLimitHeaders(remaining, resetIn);
    
    if (!allowed) {
      return c.json({ 
        success: false, 
        message: '登录过于频繁，请稍后再试' 
      }, 429, {
        'X-RateLimit-Remaining': String(remaining),
        'X-RateLimit-Reset': String(Math.ceil(resetIn / 1000)),
        'Retry-After': String(Math.ceil(resetIn / 1000)),
      });
    }
    
    const { username, password, turnstileToken } = await c.req.json();
    const db = drizzle(c.env.DB);
    
    // 验证 Turnstile token（如果配置了密钥）
    if (c.env.TURNSTILE_SECRET_KEY) {
      const verifyResult = await verifyTurnstileToken(
        turnstileToken,
        c.env.TURNSTILE_SECRET_KEY,
        c.req.header('CF-Connecting-IP') || undefined
      );
      
      if (!verifyResult.success) {
        return c.json({ success: false, message: '验证失败，请重试' }, 403);
      }
    }
    
    const user = await db.select().from(schema.users).where(eq(schema.users.username, username)).get();
    
    if (!user) {
      // 访问监控 - 记录登录失败（用户不存在）
      const accessMonitor = c.get('accessMonitor') as AccessMonitor | undefined;
      if (accessMonitor) {
        accessMonitor.logAuthEvent('LOGIN_FAILED', '', c.req.header('CF-Connecting-IP') || '', false, 'User not found');
      }
      return c.json({ success: false, message: '账号或密码错误' }, 401);
    }
    
    const storedPassword = user.password;

    // 验证密码（前端 SHA-256 哈希，后端直接比对）
    const isValidPassword = await comparePassword(password, storedPassword, c.env);
    
    if (!isValidPassword) {
      // 访问监控 - 记录登录失败（密码错误）
      const accessMonitor = c.get('accessMonitor') as AccessMonitor | undefined;
      if (accessMonitor) {
        accessMonitor.logAuthEvent('LOGIN_FAILED', user.id, c.req.header('CF-Connecting-IP') || '', false, 'Invalid password');
      }
      return c.json({ success: false, message: '账号或密码错误' }, 401);
    }

    // 自动迁移旧密码到新格式（如果使用的是旧格式）
    const newPasswordHash = await hashPassword(password, c.env);
    if (timingSafeCompare(password, storedPassword) && !timingSafeCompare(newPasswordHash, storedPassword)) {
      await db.update(schema.users).set({ password: newPasswordHash }).where(eq(schema.users.id, user.id));
    }
    
    // 检查用户是否被封禁
    const banCheck = await db.select().from(schema.userBans).where(eq(schema.userBans.userId, user.id)).get();
    if (banCheck) {
      return c.json({ success: false, message: '您的账号已被封禁，无法登录' }, 403);
    }
    
    // 更新在线状态和最后登录时间
    await db.update(schema.users).set({ status: 'online', lastLoginAt: utcNow() }).where(eq(schema.users.id, user.id));
    
    // 记录登录统计
    await db.insert(schema.loginStats).values({
      id: crypto.randomUUID(),
      userId: user.id,
      loginAt: utcNow(),
      ipAddress: c.req.header('CF-Connecting-IP') || '',
      deviceInfo: c.req.header('User-Agent') || ''
    });

    // 访问监控 - 记录登录成功
    const accessMonitor = c.get('accessMonitor') as AccessMonitor | undefined;
    if (accessMonitor) {
      accessMonitor.logAuthEvent('LOGIN_SUCCESS', user.id, c.req.header('CF-Connecting-IP') || '', true, '', { waitUntil: (p: Promise<any>) => c.executionCtx.waitUntil(p) });
    }
    
    // 自动清除7天前的历史记录（异步执行，不阻塞登录）
    (async () => {
      try {
        const clearDaysAgo = utcNow() - 7 * 24 * 60 * 60 * 1000;
        
        // 获取用户参与的所有会话
        const userSessions = await db.select()
          .from(schema.session_participants)
          .where(eq(schema.session_participants.userId, user.id))
          .all();
        
        for (const us of userSessions) {
          // 批量删除消息读取记录
          await db.delete(schema.message_reads)
            .where(and(
              sql`${schema.message_reads.messageId} IN (SELECT id FROM messages WHERE session_id = ${us.sessionId} AND time < ${clearDaysAgo})`
            ))
            .run();
          
          // 批量删除附件
          await db.delete(schema.attachments)
            .where(and(
              sql`${schema.attachments.messageId} IN (SELECT id FROM messages WHERE session_id = ${us.sessionId} AND time < ${clearDaysAgo})`
            ))
            .run();
          
          // 删除消息
          await db.delete(schema.messages)
            .where(and(
              eq(schema.messages.sessionId, us.sessionId),
              sql`${schema.messages.time} < ${clearDaysAgo}`
            ))
            .run();
        }
      } catch (clearError) {
        console.error('Auto clear history error:', clearError);
      }
    })();
    
    const token = await generateToken({ id: user.id, username: user.username, role: user.role || 'user' });
    const csrfToken = await generateCsrfToken(user.id);
    return c.json({
      success: true,
      data: {
        token,
        csrfToken,
        user: { id: user.id, name: user.name, username: user.username, avatar: user.avatar, signature: user.signature || '', status: user.status, accountStatus: user.accountStatus, role: user.role || 'user' }
      }
    });
  } catch (e) {
    console.error('Login error:', e);
    return c.json({ success: false, message: '登录失败: ' + String(e) }, 500);
  }
});

app.post('/api/auth/register', async (c) => {
  try {
    // 注册限流：基于 IP
    const clientIP = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown';
    const rateLimitKey = `register:${clientIP}`;
    const { allowed, remaining, resetIn } = await checkRateLimit(rateLimitKey, RATE_LIMITS.AUTH);
    
    if (!allowed) {
      return c.json({ 
        success: false, 
        message: '注册过于频繁，请稍后再试' 
      }, 429, {
        'X-RateLimit-Remaining': String(remaining),
        'X-RateLimit-Reset': String(Math.ceil(resetIn / 1000)),
        'Retry-After': String(Math.ceil(resetIn / 1000)),
      });
    }
    
    const { name, username, password, turnstileToken } = await c.req.json();
    const db = drizzle(c.env.DB);
    
    // 输入验证
    try {
      validateString(name, '昵称', { min: 2, max: 50 });
      validateString(username, '用户名', { min: 3, max: 20 });
      if (!isValidUsername(username)) {
        return c.json({ success: false, message: '用户名只能包含字母、数字、下划线和连字符，长度3-20个字符' }, 400);
      }
      validatePassword(password, 6);
    } catch (error) {
      if (error instanceof ValidationError) {
        return c.json({ success: false, message: error.message }, 400);
      }
      throw error;
    }
    
    // 验证 Turnstile token（如果配置了密钥）
    if (c.env.TURNSTILE_SECRET_KEY) {
      const verifyResult = await verifyTurnstileToken(
        turnstileToken,
        c.env.TURNSTILE_SECRET_KEY,
        c.req.header('CF-Connecting-IP') || undefined
      );
      
      if (!verifyResult.success) {
        return c.json({ success: false, message: '验证失败，请重试' }, 403);
      }
    }
    
    const existing = await db.select().from(schema.users).where(eq(schema.users.username, username)).get();
    if (existing) {
      return c.json({ success: false, message: '用户名已注册' }, 400);
    }
    
    // 前端已加密，后端直接哈希存储
    const storedPassword = await hashPassword(password, c.env);
    const id = crypto.randomUUID();
    const now = utcNow();
    
    await db.insert(schema.users).values({
      id,
      name,
      username,
      password: storedPassword,
      avatar: '',
      status: 'offline',
      createdAt: now
    });
    
    const token = await generateToken({ id, username });
    const csrfToken = await generateCsrfToken(id);
    
    return c.json({
      success: true,
      data: { 
        token,
        csrfToken, 
        user: { id, name, username, avatar: '' } 
      }
    });
  } catch (e) {
    console.error('Register error:', e);
    return c.json({ success: false, message: '注册失败: ' + String(e) }, 500);
  }
});

app.get('/api/user/info', auth, async (c) => {
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user) return c.json({ success: false, message: '用户不存在' }, 404);
  
  return c.json({ success: true, data: user });
});

// 刷新 CSRF Token（同时支持普通用户和管理员）
app.get('/api/auth/csrf', async (c) => {
  let token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (token?.startsWith('"')) {
    token = token.substring(1);
  }
  if (token?.endsWith('"')) {
    token = token.slice(0, -1);
  }
  if (!token) return c.json({ success: false, message: '未登录' }, 401);
  const decoded = await verifyToken(token, c.env.JWT_SECRET_KEY);
  if (!decoded) return c.json({ success: false, message: '未登录' }, 401);
  const userId = decoded.id;
  const csrfToken = await generateCsrfToken(userId);
  return c.json({ success: true, data: { csrfToken } });
});

// 搜索用户
app.get('/api/users/search', auth, async (c) => {
  const db = drizzle(c.env.DB);
  const query = c.req.query('q') as string;
  
  if (!query || query.length < 1) {
    return c.json({ success: false, message: '请输入搜索关键词' }, 400);
  }
  
  const users = await db.select({
    id: schema.users.id,
    name: schema.users.name,
    username: schema.users.username,
    avatar: schema.users.avatar,
    signature: schema.users.signature
  })
  .from(schema.users)
  .where(or(
    like(schema.users.name, `%${query}%`),
    like(schema.users.username, `%${query}%`)
  ))
  .limit(10)
  .all();
  
  return c.json({ success: true, data: users });
});

app.put('/api/user/info', auth, csrfProtection, async (c) => {
    const { username, name, avatar, signature } = await c.req.json();
    const db = drizzle(c.env.DB);
    const userId = c.get('userId');

    const updates: any = {};
    if (username) updates.username = username;
    if (name) updates.name = name;
    if (avatar !== undefined) updates.avatar = avatar;
    if (signature !== undefined) updates.signature = signature;

    if (Object.keys(updates).length > 0) {
        await db.update(schema.users).set(updates).where(eq(schema.users.id, userId));
    }

    const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
    return c.json({ success: true, data: user });
});

// 修改密码
app.put('/api/user/info/password', auth, csrfProtection, async (c) => {
    const { currentPassword, newPassword } = await c.req.json();
    const db = drizzle(c.env.DB);
    const userId = c.get('userId');

  try {
    if (!currentPassword || !newPassword) {
        return c.json({ success: false, message: '请填写所有密码字段' }, 400);
    }
    
    if (newPassword.length < 6) {
        return c.json({ success: false, message: '新密码长度不能少于6位' }, 400);
    }
    
    // 获取当前用户
    const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
    if (!user) {
        return c.json({ success: false, message: '用户不存在' }, 404);
    }
    
    // 验证当前密码
    const hashedPassword = await hashPassword(currentPassword, c.env);
    if (user.password !== hashedPassword) {
        return c.json({ success: false, message: '当前密码不正确' }, 400);
    }
    
    // 更新密码
    const newHashedPassword = await hashPassword(newPassword, c.env);
    await db.update(schema.users).set({ password: newHashedPassword }).where(eq(schema.users.id, userId));
    
    return c.json({ success: true, message: '密码修改成功' });
  } catch (e) {
    console.error('修改密码错误:', e);
    return c.json({ success: false, message: '修改密码失败' }, 500);
  }
});

// 删除用户账号
app.delete('/api/user/info/delete', auth, csrfProtection, async (c) => {
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  try {
    const { password } = await c.req.json();
    
    // 获取用户信息验证密码
    const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
    if (!user) {
      return c.json({ success: false, message: '用户不存在' }, 404);
    }
    
    // 验证密码
    const hashedInputPassword = await hashPassword(password, c.env);
    if (hashedInputPassword !== user.password) {
      return c.json({ success: false, message: '密码不正确' });
    }
    
    // 删除用户相关的所有数据
    // 1. 先删除用户发送的消息（附件会级联删除）
    await db.delete(schema.messages).where(eq(schema.messages.senderId, userId));
    
    // 2. 删除会话参与者关系
    await db.delete(schema.session_participants).where(eq(schema.session_participants.userId, userId));
    
    // 3. 删除其他用户相关数据
    await db.delete(schema.message_reads).where(eq(schema.message_reads.userId, userId));
    await db.delete(schema.notifications).where(eq(schema.notifications.userId, userId));
    await db.delete(schema.userBans).where(eq(schema.userBans.userId, userId));
    await db.delete(schema.groupMutes).where(eq(schema.groupMutes.userId, userId));
    await db.delete(schema.userSettings).where(eq(schema.userSettings.userId, userId));
    await db.delete(schema.drive_files).where(eq(schema.drive_files.userId, userId));
    await db.delete(schema.group_join_requests).where(eq(schema.group_join_requests.userId, userId));
    await db.delete(schema.message_reactions).where(eq(schema.message_reactions.userId, userId));
    await db.delete(schema.message_reports).where(eq(schema.message_reports.reporterId, userId));
    
    // 4. 删除用户
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    
    return c.json({ success: true, message: '账号已删除' });
  } catch (e) {
    console.error('删除账号错误:', e);
    return c.json({ success: false, message: '删除账号失败' }, 500);
  }
});

// 上传头像到存储并resize为64x64
app.post('/api/user/avatar', auth, csrfProtection, async (c) => {
    const db = drizzle(c.env.DB);
    await fileManager.initAsync(db, c.env.R2, c.env.UPLOADS);
    fileManager.setPrefix(`chat/avatar`);

  try {
    const userId = c.get('userId');
    const contentType = c.req.header('Content-Type') || 'image/jpeg';
    const avatarId = crypto.randomUUID();
    const arrayBuffer = await c.req.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);

    const ext = getExtensionFromMimeType(contentType) || 'jpg';
    const avatarKey = `${avatarId}.${ext}`;
    
    // 先删除旧头像
    try {
      await fileManager.deleteFromStorage(avatarKey);
    } catch (e) {
      // 忽略删除错误
    }
    
    await fileManager.uploadToStorage(avatarKey, uint8Array, contentType);
    
    // 去掉 .json 后缀
    const dbAvatarKey = avatarKey.replace(/\.json$/, '');
    await db.update(schema.users).set({ avatar: dbAvatarKey }).where(eq(schema.users.id, userId));
    
    return c.json({ success: true, data: { avatar: dbAvatarKey } });
  } catch (e) {
    console.error('Avatar upload error:', e);
    return c.json({ success: false, message: '头像上传失败: ' + String(e) }, 500);
  }
});

// 删除头像
app.delete('/api/user/avatar/:key', auth, csrfProtection, async (c) => {
    const db = drizzle(c.env.DB);
    const key = c.req.param('key');
	const userId = c.get('userId');
    await fileManager.initAsync(db, c.env.R2, c.env.UPLOADS);
    fileManager.setPrefix(`chat/avatar`);

    try {
        await fileManager.deleteFromStorage(key);

        // 更新数据库，将头像设为空
        await db.update(schema.users).set({ avatar: '' }).where(eq(schema.users.id, userId));

        return c.json({ success: true, message: '头像已删除' });
    } catch (e) {
        console.error('Avatar delete error:', e);
        return c.json({ success: false, message: '删除头像失败: ' + String(e) }, 500);
    }
});

// 获取用户设置
app.get('/api/user/settings', auth, async (c) => {
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  const settings = await db.select().from(schema.userSettings).where(eq(schema.userSettings.userId, userId)).get();
  
  if (settings) {
    return c.json({
      success: true,
      data: {
        theme: settings.theme || 'light',
        chat: {
          fontSize: settings.fontSize || 'medium'
        },
        privacy: {
          twoFactorEnabled: false,
          onlineStatus: 'everyone',
          readReceipts: true,
          allowContact: 'everyone'
        },
        language: {
          language: 'zh-CN',
          timeFormat: '24h',
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
        },
        notifications: {
          messageSound: settings.messageSound || 1,
          groupMention: settings.groupMention || 1,
          onlineNotify: settings.onlineNotify || 1,
          offlineNotify: settings.offlineNotify || 0,
          cannotDelete: settings.cannotDelete || 0
        }
      }
    });
  }
  
  // 返回默认设置
  return c.json({
    success: true,
    data: {
      theme: 'light',
      chat: {
        fontSize: 'medium'
      },
      privacy: {
        twoFactorEnabled: false,
        onlineStatus: 'everyone',
        readReceipts: true,
        allowContact: 'everyone'
      },
      language: {
        language: 'zh-CN',
        timeFormat: '24h',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
      },
      notifications: {
        messageSound: 1,
        groupMention: 1,
        onlineNotify: 1,
        offlineNotify: 1,
        cannotDelete: 0
      }
    }
  });
});

// 保存用户设置
app.put('/api/user/settings', auth, csrfProtection, async (c) => {
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  const body = await c.req.json();
  
  const theme = body.theme || 'light';
  const chat = body.chat || {};
  const notifications = body.notifications || {};

  const newSettings = {
    theme,
    fontSize: chat.fontSize || 'medium',
    messageSound: notifications.messageSound ? 1 : 0,
    groupMention: notifications.groupMention ? 1 : 0,
    onlineNotify: notifications.onlineNotify ? 1 : 0,
    offlineNotify: notifications.offlineNotify ? 1 : 0,
    cannotDelete: notifications.cannotDelete ? 1 : 0,
    updatedAt: Date.now()
  };
   
  // 先查询是否存在记录
  const existing = await db.select()
    .from(schema.userSettings)
    .where(eq(schema.userSettings.userId, userId))
    .get();
  
  if (existing) {
    // 存在则更新
    await db.update(schema.userSettings)
      .set(newSettings)
      .where(eq(schema.userSettings.userId, userId));
  } else {
    // 不存在则插入
    await db.insert(schema.userSettings).values({
      userId,
      ...newSettings,
      createdAt: Date.now()
    });
  }
     
  return c.json({ success: true, message: '设置已保存' });
});

// 提供头像访问
app.get('/api/avatar/:key', async (c) => {
    const db = drizzle(c.env.DB);
    let key = c.req.param('key');

    await fileManager.initAsync(db, c.env.R2, c.env.UPLOADS);
    fileManager.setPrefix('chat/avatar');
     
    // 验证 key 格式，防止路径遍历
    // 头像 key 应该是 userId.jpg/png/gif 等格式
    if (!key || !/^[a-zA-Z0-9_-]+\.(jpg|jpeg|png|gif|webp)$/i.test(key)) {
        return c.text('Invalid avatar key', 400);
    }

    try {
        let fileData: ArrayBuffer | null = null;
        let contentType = 'image/jpeg';

        // 根据文件扩展名设置 content-type
        const ext = key.split('.').pop()?.toLowerCase();
        if (ext === 'png') contentType = 'image/png';
        else if (ext === 'gif') contentType = 'image/gif';
        else if (ext === 'webp') contentType = 'image/webp';

        fileData = await fileManager.downloadFromStorage(key);

        if (!fileData) {
            return c.text('Avatar not found', 404);
        }

        return new Response(fileData, {
          headers: {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=31536000',
            'X-Content-Type-Options': 'nosniff',
            ...getCorsHeaders(c.env, c.req.raw)
          }
        });
    } catch (e) {
        console.error('Avatar fetch error:', e);
        return c.text('Error', 500);
    }
});

// ==================== 好友与会话 ====================

app.get('/api/friends', auth, async (c) => {
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  const allUsers = await db.select()
    .from(schema.users)
    .where(sql`${schema.users.id} != ${userId}`)
    .all();
  
  return c.json({ success: true, data: allUsers });
});

app.post('/api/friends', auth, csrfProtection, async (c) => {
  const { friendId } = await c.req.json();
  
  // 好友操作限流
  const rateLimitKey = `friend:${c.get('userId')}`;
  const { allowed: friendAllowed, remaining: friendRemaining, resetIn: friendResetIn } = await checkRateLimit(rateLimitKey, RATE_LIMITS.FRIEND);
  if (!friendAllowed) {
    return c.json({ success: false, message: '操作过于频繁，请稍后再试' }, 429, createRateLimitHeaders(friendRemaining, friendResetIn));
  }
  
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  const friend = await db.select().from(schema.users).where(eq(schema.users.id, friendId)).get();
  if (!friend) {
    return c.json({ success: false, message: '用户不存在' }, 404);
  }
  
  // 检查是否已存在私聊会话（确保双方都在该会话中）
  const existing = await db.select()
    .from(schema.sessions)
    .innerJoin(schema.session_participants, eq(schema.sessions.id, schema.session_participants.sessionId))
    .where(and(
      eq(schema.sessions.type, 'friend'),
      eq(schema.session_participants.userId, userId),
      sql`EXISTS (SELECT 1 FROM session_participants sp2 WHERE sp2.session_id = sessions.id AND sp2.user_id = ${friendId})`
    ))
    .get();
  
  if (existing) {
    return c.json({ success: true, data: existing.sessions });
  }
  
  const sessionId = crypto.randomUUID();
  const now = utcNow();
  
  await db.insert(schema.sessions).values({
    id: sessionId,
    type: 'friend',
    lastMessage: '',
    lastTime: now
  });
  
  await db.insert(schema.session_participants).values([
    { sessionId: sessionId, userId: userId },
    { sessionId: sessionId, userId: friendId }
  ]);
  
  return c.json({ success: true, data: { id: sessionId, type: 'friend' } });
});

// ==================== 会话列表 ====================

app.get('/api/conversations', auth, async (c) => {
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  // 1. 获取用户所有会话
  const userSessions = await db.select()
    .from(schema.sessions)
    .innerJoin(schema.session_participants, eq(schema.sessions.id, schema.session_participants.sessionId))
    .where(eq(schema.session_participants.userId, userId))
    .all();
  
  const sessionIds = userSessions.map(us => us.sessions.id);
  
  if (sessionIds.length === 0) {
    return c.json({ success: true, data: [] });
  }
  
  // 2. 批量获取所有参与者的用户ID
  const allParticipants = await db.select()
    .from(schema.session_participants)
    .where(sql`${schema.session_participants.sessionId} IN ${sessionIds}`)
    .all();
  
  // 按会话分组参与者
  const participantsBySession = new Map<string, typeof allParticipants>();
  const allUserIds = new Set<string>();
  for (const p of allParticipants) {
    if (!participantsBySession.has(p.sessionId)) {
      participantsBySession.set(p.sessionId, []);
    }
    participantsBySession.get(p.sessionId)!.push(p);
    allUserIds.add(p.userId);
  }
  
  // 3. 批量获取所有相关用户
  const allUsers = await db.select()
    .from(schema.users)
    .where(sql`${schema.users.id} IN ${[...allUserIds]}`)
    .all();
  const usersById = new Map(allUsers.map(u => [u.id, u]));
  
  // 4. 批量获取未读消息数
  const unreadResults = await db.select({
    sessionId: schema.messages.sessionId,
    count: sql<number>`count(*)`
  })
    .from(schema.messages)
    .leftJoin(schema.message_reads, and(
      eq(schema.messages.id, schema.message_reads.messageId),
      eq(schema.message_reads.userId, userId)
    ))
    .where(and(
      sql`${schema.messages.sessionId} IN ${sessionIds}`,
      sql`${schema.messages.senderId} != ${userId}`,
      eq(schema.messages.isSystem, 0),
      eq(schema.messages.recalled, 0),
      sql`${schema.message_reads.messageId} IS NULL`
    ))
    .groupBy(schema.messages.sessionId)
    .all();
  const unreadBySession = new Map(unreadResults.map((r: any) => [r.sessionId, r.count]));
  
  // 5. 组装会话列表
  const conversations = userSessions.map(us => {
    const session = us.sessions;
    const participants = participantsBySession.get(session.id) || [];
    const participantIds = participants.map(p => p.userId);
    let otherUser = null;
    let otherUserId = null;
    
    if (session.type === 'friend') {
      otherUserId = participantIds.find(id => id !== userId);
      if (otherUserId) {
        otherUser = usersById.get(otherUserId) || null;
      }
    }
    
    return {
      id: session.id,
      type: session.type,
      name: session.type === 'group' ? session.name : (otherUser?.name || '未知'),
      avatar: session.type === 'group' ? '' : (otherUser?.avatar || ''),
      status: otherUser?.status || 'offline',
      signature: otherUser?.signature || '',
      role: otherUser?.role || 'user',
      username: otherUser?.username || '',
      otherUserId,
      lastMessage: session.lastMessage,
      lastMessageIsEncrypted: session.lastMessageEncrypted === 1,
      lastTime: session.lastTime,
      unread: unreadBySession.get(session.id) || 0,
      isPinned: session.isPinned === 1,
      isMuted: session.isMuted === 1
    };
  });
  
  conversations.sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return (b.lastTime || 0) - (a.lastTime || 0);
  });
  
  return c.json({ success: true, data: conversations });
});

// ==================== 导出历史记录 ====================

app.get('/api/conversations/:id/export-history', auth, async (c) => {
  try {
    const sessionId = c.req.param('id');
    const db = drizzle(c.env.DB);
    const userId = c.get('userId');
    
    // 获取分页参数
    const page = Math.max(1, parseInt(c.req.query('page') || '1'));
    const limit = Math.min(500, Math.max(1, parseInt(c.req.query('limit') || '100')));
    const format = c.req.query('format') || 'json';
    const afterTime = c.req.query('after');
    
    // 权限检查
    const participant = await db.select().from(schema.session_participants)
      .where(and(
        eq(schema.session_participants.sessionId, sessionId),
        eq(schema.session_participants.userId, userId)
      ))
      .get();
    
    if (!participant) {
      return c.json({ success: false, message: '无权访问此会话' }, 403);
    }
    
    // 获取会话信息
    const sessionInfo = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
    
    // 构建查询条件
    const conditions = [eq(schema.messages.sessionId, sessionId)];
    if (afterTime) {
      const afterTimestamp = parseInt(afterTime);
      if (!isNaN(afterTimestamp)) {
        conditions.push(sql`${schema.messages.time} > ${afterTimestamp}`);
      }
    }
    
    // 获取总数
    const totalResult = await db.select({ count: sql<number>`count(*)` })
      .from(schema.messages)
      .where(and(...conditions))
      .get();
    const total = totalResult?.count || 0;
    
    if (total === 0) {
      return c.json({ 
        success: true, 
        data: {
          messages: [],
          pagination: { page, limit, total, totalPages: 0, hasMore: false }
        }
      });
    }
    
    const totalPages = Math.ceil(total / limit);
    const offset = (page - 1) * limit;
    
    // 获取分页消息
    const messagesData = await db.select()
      .from(schema.messages)
      .where(and(...conditions))
      .orderBy(schema.messages.time)
      .limit(limit)
      .offset(offset)
      .all();
    
    // 收集需要的 IDs
    const senderIds = [...new Set(messagesData.map(m => m.senderId))];
    const messageIds = messagesData.map(m => m.id);
    
    // 并行查询发送者和附件
    const [allSenders, allAttachments] = await Promise.all([
      senderIds.length > 0 ? db.select().from(schema.users).where(sql`${schema.users.id} IN ${senderIds}`).all() : [],
      messageIds.length > 0 ? db.select().from(schema.attachments).where(sql`${schema.attachments.messageId} IN ${messageIds}`).all() : []
    ]);
    
    // 构建 Map 用于快速查找
    const sendersById = new Map(allSenders.map(s => [s.id, s]));
    const attachmentsByMsg = new Map<string, typeof allAttachments>();
    for (const att of allAttachments) {
      const list = attachmentsByMsg.get(att.messageId) || [];
      list.push(att);
      attachmentsByMsg.set(att.messageId, list);
    }
    
    // 格式化消息
    const formattedMessages = messagesData.map((msg: any) => ({
      id: msg.id,
      timestamp: msg.time,
      senderName: sendersById.get(msg.senderId)?.name || '未知',
      senderId: msg.senderId,
      content: msg.content,
      encrypted: msg.encrypted,
      recalled: msg.recalled === 1,
      attachments: (attachmentsByMsg.get(msg.id) || []).map(a => ({
        id: a.id,
        name: a.name,
        url: a.url,
        size: a.size,
        encrypted: a.encrypted
      }))
    }));

    return c.json({ 
      success: true, 
      data: {
        sessionId,
        sessionName: sessionInfo?.name || '聊天记录',
        sessionType: sessionInfo?.type || 'friend',
        messages: formattedMessages,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasMore: page < totalPages
        }
      }
    });
  } catch (error) {
    console.error('[Export] Error:', error);
    return c.json({ success: false, message: '导出失败: ' + String(error) }, 500);
  }
});

// ==================== 消息 ====================

// 获取消息时不解密，让客户端自己解密（端对端加密）
// 只有系统消息需要处理

app.get('/api/conversations/:id/messages', auth, async (c) => {
  const sessionId = c.req.param('id');
  const { page = '1', limit = '50', after } = c.req.query();
  
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  // 检查权限
  const participant = await db.select()
    .from(schema.session_participants)
    .where(and(
      eq(schema.session_participants.sessionId, sessionId),
      eq(schema.session_participants.userId, userId)
    ))
    .get();
  
  if (!participant) {
    return c.json({ success: false, message: '无权访问此会话' }, 403);
  }
  
  let query = db.select()
    .from(schema.messages)
    .where(eq(schema.messages.sessionId, sessionId));
  
  // 增量加载：只获取指定时间之后的新消息
  if (after) {
    const afterTime = parseInt(after as string);
    if (!isNaN(afterTime)) {
      query = query.where(and(
        eq(schema.messages.sessionId, sessionId),
        sql`${schema.messages.time} > ${afterTime}`
      ));
    }
  }
  
  // 分页查询：page=1 返回最新消息
  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);
  const offsetNum = (pageNum - 1) * limitNum;
  
  if (pageNum === 1) {
    query = query.orderBy(desc(schema.messages.time))
      .limit(limitNum);
  } else {
    query = query.orderBy(schema.messages.time)
      .limit(limitNum)
      .offset(offsetNum);
  }
  
  const messagesData = await query.all();
  
  // 如果是第一页，反转成时间正序
  const sortedMessages = pageNum === 1 ? messagesData.reverse() : messagesData;
  
  // 批量获取所有需要的数据（消除 N+1 查询）
  const messageIds = messagesData.map(m => m.id);
  const senderIds = [...new Set(messagesData.map(m => m.senderId))];
  const replyToIds = messagesData.map(m => m.replyToId).filter(Boolean);
  const quoteIds = messagesData.map(m => m.quoteId).filter(Boolean);
  
  // 先并行查询不需要依赖其他结果的数据
  const [attachmentsList, sendersMap, replyMessages, quoteMessages, messageReads, myReadMessages] = await Promise.all([
    // 1. 批量获取附件
    messageIds.length > 0 
      ? db.select().from(schema.attachments).where(sql`${schema.attachments.messageId} IN ${messageIds}`).all()
      : [],
    // 2. 批量获取发送者信息
    senderIds.length > 0
      ? db.select().from(schema.users).where(sql`${schema.users.id} IN ${senderIds}`).all()
      : [],
    // 3. 批量获取回复消息
    replyToIds.length > 0
      ? db.select().from(schema.messages).where(sql`${schema.messages.id} IN ${replyToIds}`).all()
      : [],
    // 4. 批量获取引用消息
    quoteIds.length > 0
      ? db.select().from(schema.messages).where(sql`${schema.messages.id} IN ${quoteIds}`).all()
      : [],
    // 5. 批量获取消息的已读状态（发给其他人的消息）
    messageIds.length > 0
      ? db.select().from(schema.message_reads).where(sql`${schema.message_reads.messageId} IN ${messageIds}`).all()
      : [],
    // 6. 获取我已读的消息ID（只获取当前会话的，避免返回大量数据）
    messageIds.length > 0
      ? db.select().from(schema.message_reads).where(and(
          eq(schema.message_reads.userId, userId),
          sql`${schema.message_reads.messageId} IN ${messageIds}`
        )).all()
      : []
  ]);
  
  // 单独查询所有相关发送者（在 replyMessages 和 quoteMessages 已知之后）
  let allRelatedSenderIds: any[] = [];
  if (replyToIds.length > 0 || quoteIds.length > 0) {
    const relatedSenderIds = new Set<string>();
    for (const m of replyMessages || []) {
      relatedSenderIds.add(m.senderId);
    }
    for (const m of quoteMessages || []) {
      relatedSenderIds.add(m.senderId);
    }
    if (relatedSenderIds.size > 0) {
      const senderIdArr = [...relatedSenderIds];
      const result = db.select().from(schema.users).where(sql`${schema.users.id} IN ${senderIdArr}`).all();
      allRelatedSenderIds = Array.isArray(result) ? result : [];
    }
  }
  
  // 构建映射表
  const sendersById = new Map(sendersMap.map(s => [s.id, s]));
  const attachmentsByMsg = new Map<string, typeof attachmentsList>();
  for (const att of attachmentsList) {
    if (!attachmentsByMsg.has(att.messageId)) {
      attachmentsByMsg.set(att.messageId, []);
    }
    attachmentsByMsg.get(att.messageId)!.push(att);
  }
  const replyById = new Map(replyMessages.map(m => [m.id, m]));
  const quoteById = new Map(quoteMessages.map(m => [m.id, m]));
  const myReadIds = new Set(myReadMessages.map(m => m.messageId));
  
  // 使用统一的发送者映射
  const allSendersById = new Map(allRelatedSenderIds.map(s => [s.id, s]));
  
  // 构建已读状态映射
  const readsByMsg = new Map<string, string[]>();
  for (const mr of messageReads) {
    if (!readsByMsg.has(mr.messageId)) {
      readsByMsg.set(mr.messageId, []);
    }
    readsByMsg.get(mr.messageId)!.push(mr.userId);
  }
  
  // 格式化消息
  const formattedMessages = sortedMessages.map(msg => {
    const sender = sendersById.get(msg.senderId);
    const attachmentsLst = attachmentsByMsg.get(msg.id) || [];
    
    // 回复消息
    let replyTo = null;
    if (msg.replyToId && replyById.has(msg.replyToId)) {
      const repliedMsg = replyById.get(msg.replyToId)!;
      // 优先使用 allSendersById（包含回复/引用消息的发送者），备用 sendersById
      const repliedUser = allSendersById.get(repliedMsg.senderId) || sendersById.get(repliedMsg.senderId);
      replyTo = {
        id: msg.replyToId,
        name: repliedUser?.name || '未知用户',
        content: repliedMsg.content
      };
    }
    
    // 引用消息
    let quote = null;
    if (msg.quoteId && quoteById.has(msg.quoteId)) {
      const quotedMsg = quoteById.get(msg.quoteId)!;
      // 优先使用 allSendersById（包含回复/引用消息的发送者），备用 sendersById
      const quotedUser = allSendersById.get(quotedMsg.senderId) || sendersById.get(quotedMsg.senderId);
      quote = {
        id: quotedMsg.id,
        msg_id: quotedMsg.id,
        from_id: quotedMsg.senderId,
        sender: { id: quotedUser?.id, name: quotedUser?.name },
        content: quotedMsg.content,
        type: quotedMsg.type,
        createdAt: quotedMsg.time
      };
    }
    
    // 已读状态
    let isRead = false;
    let readByName = '';
    if (msg.senderId === userId) {
      const readers = readsByMsg.get(msg.id) || [];
      isRead = readers.length > 0;
      if (readers.length > 0) {
        const firstReader = sendersById.get(readers[0]);
        readByName = firstReader?.name || '';
      }
    } else {
      isRead = myReadIds.has(msg.id);
    }
    
    // 系统消息处理
    let displayContent = msg.content;
    if (msg.isSystem === 1 && msg.encrypted) {
      if (displayContent.includes('|')) {
        const parts = displayContent.split('|');
        const isActor = String(msg.senderId) === String(userId);
        displayContent = isActor ? parts[0] : parts[1];
      }
    }
    
    return {
      id: msg.id,
      msg_id: msg.id,
      from_id: msg.senderId,
      sender: { id: sender?.id, name: sender?.name, avatar: sender?.avatar },
      content: displayContent,
      type: msg.type,
      is_revoked: !!msg.recalled,
      recalled: !!msg.recalled,
      isSystem: !!msg.isSystem,
      createdAt: msg.time,
      timestamp: msg.time,
      read: isRead,
      readBy: readByName,
      isEncrypted: !!msg.encrypted,
      encrypted: msg.encrypted,
      quote,
      replyTo,
      burnAfterReading: !!msg.burnAfterReading,
      attachments: attachmentsLst.map(a => ({
        id: a.id,
        type: a.type,
        name: a.name,
        size: a.size,
        url: a.url,
        encrypted: !!a.encrypted
      }))
    };
  });
  
  return c.json({ success: true, data: formattedMessages });
});

// 修改 getMessageById 函数，不解密内容
async function getMessageById(db: any, messageId: string, userId?: string) {
  const msg = await db.select()
    .from(schema.messages)
    .where(eq(schema.messages.id, messageId))
    .get();
  
  if (!msg) return null;
  
  const sender = await db.select()
    .from(schema.users)
    .where(eq(schema.users.id, msg.senderId))
    .get();
  
  // 后端不解密，直接返回加密内容
  return {
    id: msg.id,
    msg_id: msg.id,
    from_id: msg.senderId,
    sender: { id: sender?.id, name: sender?.name },
    content: msg.content,
    type: msg.type,
    createdAt: msg.time
  };
}

app.post('/api/conversations/:id/messages', auth, csrfProtection, async (c) => {
  const sessionId = c.req.param('id');
  const { content, attachments, quoteId, isEncrypted } = await c.req.json();
  
  // 消息发送限流
  const rateLimitKey = `message:${c.get('userId')}`;
  const { allowed: msgAllowed, remaining: msgRemaining, resetIn: msgResetIn } = await checkRateLimit(rateLimitKey, RATE_LIMITS.MESSAGE);
  if (!msgAllowed) {
    return c.json({ success: false, message: '发送消息过于频繁，请稍后再试' }, 429, createRateLimitHeaders(msgRemaining, msgResetIn));
  }
  
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  const messageId = crypto.randomUUID();
  const now = utcNow();
  
  // 前端已经处理加密，后端直接存储加密内容
  const storedContent = content || '';
  const encrypted = isEncrypted ? 1 : 0;
  
  await db.insert(schema.messages).values({
    id: messageId,
    sessionId: sessionId,
    senderId: userId,
    content: storedContent, // 存储前端传来的（已加密的）内容
    encrypted: encrypted,     // 标记为已加密
    time: now,
    quote_id: quoteId || null,
    replyToId: quoteId || null
  });
  
  // 记录聊天统计 - 使用 UTC 计算当天开始时间
  const todayStart = Math.floor(now / (24 * 60 * 60 * 1000)) * (24 * 60 * 60 * 1000);
  
  // 查询该用户今天的统计记录
  const existingRecord = await db.select()
    .from(schema.chatStats)
    .where(and(
      eq(schema.chatStats.userId, userId),
      eq(schema.chatStats.chatDate, todayStart)
    ))
    .get();
  
  if (existingRecord) {
    const currentCount = Number(existingRecord.messageCount) || 0;
    await db.update(schema.chatStats)
      .set({ messageCount: currentCount + 1 })
      .where(eq(schema.chatStats.id, existingRecord.id));
  } else {
    await db.insert(schema.chatStats).values({
      id: crypto.randomUUID(),
      userId: userId,
      sessionId: sessionId,
      messageCount: 1,
      chatDate: todayStart
    });
  }
  
  await db.update(schema.sessions)
    .set({ 
      lastMessage: content.substring(0, 50), 
      lastMessageEncrypted: encrypted,
      lastTime: now 
    })
    .where(eq(schema.sessions.id, sessionId));
  
  // 批量存储附件
  if (attachments && attachments.length > 0) {
    await db.insert(schema.attachments).values(
      attachments.map((att: any) => ({
        id: crypto.randomUUID(),
        messageId: messageId,
        type: att.type,
        name: att.name,
        size: att.size,
        url: att.url,
        encrypted: att.encrypted ? 1 : 0
      }))
    );
  }
  
  // 获取发送者信息
  const sender = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  
  // 通过 Durable Object 广播消息（统一使用 'global' Durable Object）
  try {
    // 获取会话类型
    const session = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
    
    const chatId = c.env.CHAT.idFromName('global');
    const chatStub = c.env.CHAT.get(chatId);
    await chatStub.fetch('https://broadcast', {
      method: 'POST',
      body: JSON.stringify({
        type: 'message',
        data: {
          id: messageId,
          content: storedContent, // 发送加密内容
          sender: { id: sender?.id, name: sender?.name, avatar: sender?.avatar },
          timestamp: now,
          sessionId,
          sessionType: session?.type || 'private',
          attachments,
          isEncrypted: !!encrypted
        },
        senderId: userId
      })
    });
  } catch (e) {
    console.error('Broadcast error:', e);
  }
  
  // 获取被回复的消息 - 不解密
  let replyToData = null;
  if (quoteId) {
    replyToData = await getMessageById(db, quoteId, userId);
  }
  
  return c.json({
    success: true,
    data: {
      id: messageId,
      content: storedContent, // 返回加密内容
      sender,
      timestamp: now,
      read: false,
      attachments,
      isEncrypted: !!encrypted,
      replyTo: replyToData
    }
  });
});

// 标记已读
app.post('/api/conversations/:id/read', auth, csrfProtection, async (c) => {
  const sessionId = c.req.param('id');
  
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  const participant = await db.select()
    .from(schema.session_participants)
    .where(and(
      eq(schema.session_participants.sessionId, sessionId),
      eq(schema.session_participants.userId, userId)
    ))
    .get();
  
  if (!participant) {
    return c.json({ success: false, message: '无权访问此会话' }, 403);
  }
  
  const unreadMessages = await db.select()
    .from(schema.messages)
    .where(and(
      eq(schema.messages.sessionId, sessionId),
      sql`${schema.messages.senderId} != ${userId}`,
      eq(schema.messages.isSystem, 0),
      eq(schema.messages.recalled, 0)
    ))
    .all();
  
  const now = utcNow();
  for (const msg of unreadMessages) {
    await db.insert(schema.message_reads)
      .values({
        messageId: msg.id,
        userId: userId,
        read_at: now
      })
      .onConflictDoNothing();
  }
  
  // 获取用户信息用于显示已读
  const reader = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  const readerName = reader?.name || '未知';
  
  // 广播消息已读事件给会话中的其他用户（统一使用 'global' Durable Object）
  try {
    const chatId = c.env.CHAT.idFromName('global');
    const chatStub = c.env.CHAT.get(chatId);
    await chatStub.fetch('https://broadcast', {
      method: 'POST',
      body: JSON.stringify({
        type: 'messagesRead',
        data: {
          readerId: userId,
          readerName: readerName,
          sessionId,
          messageIds: unreadMessages.map(m => m.id)
        }
      })
    });
  } catch (e) {
    console.error('Broadcast read status error:', e);
  }
  
  return c.json({ success: true, markedCount: unreadMessages.length });
});

// 清除历史记录 - 清除3天前的历史记录
app.delete('/api/conversations/:id/clear-history', auth, csrfProtection, async (c) => {
  const sessionId = c.req.param('id');
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  const participant = await db.select()
    .from(schema.session_participants)
    .where(and(
      eq(schema.session_participants.sessionId, sessionId),
      eq(schema.session_participants.userId, userId)
    ))
    .get();
  
  if (!participant) {
    return c.json({ success: false, message: '无权访问此会话' }, 403);
  }
  
  const CLEAR_HISTORY_DAYS = c.env.CLEAR_HISTORY_DAYS;
  const clearDaysAgo = utcNow() - CLEAR_HISTORY_DAYS * 24 * 60 * 60 * 1000;
  
  // 获取3天前的已读消息（排除自己未读的）
  const messagesToDelete = await db.select({ 
    id: schema.messages.id,
    senderId: schema.messages.senderId
  })
    .from(schema.messages)
    .where(and(
      eq(schema.messages.sessionId, sessionId),
      sql`${schema.messages.time} < ${clearDaysAgo}`
    ))
    .all();
  
  // 过滤：只删除自己发送的消息，或者对方发送但已读的
  const deletableMessageIds: string[] = [];
  
  for (const msg of messagesToDelete) {
    // 如果是自己发送的，可以删除
    if (msg.senderId === userId) {
      deletableMessageIds.push(msg.id);
    } else {
      // 如果是对方发送的，检查是否已读
      const readRecord = await db.select()
        .from(schema.message_reads)
        .where(and(
          eq(schema.message_reads.messageId, msg.id),
          eq(schema.message_reads.userId, userId)
        ))
        .get();
      if (readRecord) {
        deletableMessageIds.push(msg.id);
      }
    }
  }
  
  const deletedCount = deletableMessageIds.length;
  
  if (deletedCount > 0) {
    // 批量删除消息读取记录
    await db.delete(schema.message_reads)
      .where(sql`${schema.message_reads.messageId} IN (SELECT id FROM messages WHERE session_id = ${sessionId} AND time < ${clearDaysAgo})`)
      .run();
    
    // 批量删除附件记录
    await db.delete(schema.attachments)
      .where(sql`${schema.attachments.messageId} IN (SELECT id FROM messages WHERE session_id = ${sessionId} AND time < ${clearDaysAgo})`)
      .run();
    
    // 删除消息
    await db.delete(schema.messages)
      .where(and(
        eq(schema.messages.sessionId, sessionId),
        sql`${schema.messages.time} < ${clearDaysAgo}`
      ))
      .run();
  }
  
  return c.json({ 
    success: true, 
    deletedCount: deletableMessageIds.length, 
    deletedMessageIds: deletableMessageIds,
    message: `已清除${CLEAR_HISTORY_DAYS}天前的记录` 
  });
});

// 撤回消息
app.post('/api/messages/:id/recall', auth, csrfProtection, async (c) => {
  const messageId = c.req.param('id');
  const { sessionId } = await c.req.json();
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  const msg = await db.select()
    .from(schema.messages)
    .where(eq(schema.messages.id, messageId))
    .get();
  
  if (!msg) {
    return c.json({ success: false, message: '消息不存在' }, 404);
  }
  
  if (msg.senderId !== userId) {
    return c.json({ success: false, message: '只能撤回自己的消息' }, 403);
  }
  
  if (msg.recalled === 1) {
    return c.json({ success: false, message: '消息已撤回' }, 400);
  }
  
  const sender = await db.select()
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();
  
  const displayForDeleter = '你撤回了一条消息';
  const displayForOther = `${sender?.name || '对方'} 撤回了一条消息`;
  
  await db.update(schema.messages)
    .set({
      content: `${displayForDeleter}|${displayForOther}`,
      isSystem: 1,
      recalled: 1,
      encrypted: 0,
      senderId: userId
    })
    .where(eq(schema.messages.id, messageId));
  
  // 广播消息撤回事件（统一使用 'global' Durable Object）
  try {
    const chatId = c.env.CHAT.idFromName('global');
    const chatStub = c.env.CHAT.get(chatId);
    
    const response = await chatStub.fetch('https://broadcast', {
      method: 'POST',
      body: JSON.stringify({
        type: 'messageRecalled',
        data: {
          messageId,
          sessionId,
          originalSenderId: userId,
          actorId: userId,
          actorName: sender?.name || '对方'
        }
      })
    });
    
  } catch (e) {
    console.error('[Recall] Broadcast error:', e);
  }
  
  return c.json({ success: true });
});

// 批量删除消息（必须放在单个删除消息路由之前）
app.delete('/api/messages/batch', auth, csrfProtection, async (c) => {
  const { messageIds, sessionId } = await c.req.json();
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
    return c.json({ success: false, message: '请选择要删除的消息' }, 400);
  }
  
  const sender = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  const displayForDeleter = '你删除了这条消息';
  const displayForOther = `${sender?.name || '对方'} 删除了你的一条消息`;
  
  let deletedCount = 0;
  let skippedCount = 0;
  
  for (const messageId of messageIds) {
    const msg = await db.select()
      .from(schema.messages)
      .where(eq(schema.messages.id, messageId))
      .get();
    
    if (!msg) continue;
    if (msg.isDeleted === 1) continue;
    
    // 如果不是消息发送者，检查发送者是否开启了"不允许删除"设置
    if (msg.senderId !== userId) {
      const senderSettings = await db.select()
        .from(schema.userSettings)
        .where(eq(schema.userSettings.userId, msg.senderId))
        .get();
      
      if (senderSettings?.cannotDelete === 1) {
        skippedCount++; // 计数跳过
        continue; // 跳过这条消息
      }
    }
    
    const msgSender = await db.select().from(schema.users).where(eq(schema.users.id, msg.senderId)).get();
    const displayForDeleter = '你删除了这条消息';
    const displayForOther = `${msgSender?.name || '对方'} 删除了你的一条消息`;
    
    await db.update(schema.messages)
      .set({
        content: `${displayForDeleter}|${displayForOther}`,
        isSystem: 1,
        isDeleted: 1,
        encrypted: 0,
        senderId: msg.senderId
      })
      .where(eq(schema.messages.id, messageId));
    
    deletedCount++;
  }
  
  try {
    const chatId = c.env.CHAT.idFromName('global');
    const chatStub = c.env.CHAT.get(chatId);
    
    // 为每条消息发送删除广播
    for (const messageId of messageIds) {
      await chatStub.fetch('https://broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'messageDeleted',
          data: { messageId, sessionId, actorId: userId, actorName: sender?.name || '用户' }
        })
      });
    }
  } catch (e) {}
  
  return c.json({ success: true, deleted: deletedCount });
});

// ==================== 消息举报 ====================
// 举报消息
app.post('/api/messages/:id/report', auth, csrfProtection, async (c) => {
  const messageId = c.req.param('id');
  const { reason, description } = await c.req.json();
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  if (!reason) {
    return c.json({ success: false, message: '请选择举报原因' }, 400);
  }
  
  const msg = await db.select()
    .from(schema.messages)
    .where(eq(schema.messages.id, messageId))
    .get();
  
  if (!msg) {
    return c.json({ success: false, message: '消息不存在' }, 404);
  }
  
  const reporter = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  const reportedUser = await db.select().from(schema.users).where(eq(schema.users.id, msg.senderId)).get();
  
  // 检查是否已经举报过这条消息（只阻止待处理的举报）
  const existingReport = await db.select()
    .from(schema.message_reports)
    .where(and(
      eq(schema.message_reports.messageId, messageId),
      eq(schema.message_reports.reporterId, userId),
      eq(schema.message_reports.status, 'pending')
    ))
    .get();
  
  if (existingReport) {
    return c.json({ success: false, message: '您已经举报过这条消息（待处理）' }, 400);
  }
  
await db.insert(schema.message_reports).values({
    id: crypto.randomUUID(),
    messageId,
    reporterId: userId,
    reporterName: reporter?.name || '',
    reportedUserId: msg.senderId,
    reportedUserName: reportedUser?.name || '',
    reason,
    description: description || '',
    status: 'pending',
    createdAt: utcNow()
  });
  
  // 通知所有管理员有新举报
  // console.log('[举报] 触发通知:', { reporterName: reporter?.name, reason, reportedUserName: reportedUser?.name });
  
  // 获取所有管理员用户ID
  const adminUsers = await db.select()
    .from(schema.users)
    .where(or(
      eq(schema.users.role, 'admin'),
      eq(schema.users.role, 'superadmin')
    ));
  
  // console.log('[举报] 管理员列表:', adminUsers.map(u => u.id));
  
  // 批量存储到 notifications 表（避免 N+1）
  try {
    if (adminUsers.length > 0) {
      await db.insert(schema.notifications).values(
        adminUsers.map(admin => ({
          id: crypto.randomUUID(),
          userId: admin.id,
          type: 'report',
          title: '新举报',
          content: `${reporter?.name || '未知'} 举报了用户 "${reportedUser?.name || '未知'}"，原因：${reason}`,
          createdAt: utcNow()
        }))
      );
      // console.log('[举报] 已存储到通知表:', adminUsers.length);
    }
  } catch (e) {
    console.error('[举报] 存储通知失败:', e);
  }
  
  // 通过 WebSocket 通知在线管理员（只发送信号，不发送具体内容，避免重复提示）
  try {
    const chatId = c.env.CHAT.idFromName('global');
    const chatStub = c.env.CHAT.get(chatId);
    await chatStub.fetch('https://broadcast/broadcast', {
      method: 'POST',
      body: JSON.stringify({
        type: 'newReport',
        data: { messageId }
      })
    });
    // console.log('[举报] WebSocket 广播成功');
  } catch (e) {
    console.error('[举报通知] 失败:', e);
  }
  
  return c.json({ success: true, message: '举报成功，我们会尽快处理' });
});

// 获取我举报的消息列表
app.get('/api/reports/my', auth, async (c) => {
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '20');
  const offset = (page - 1) * limit;
  
  const reports = await db.select()
    .from(schema.message_reports)
    .where(eq(schema.message_reports.reporterId, userId))
    .orderBy(sql`${schema.message_reports.createdAt} DESC`)
    .limit(limit)
    .offset(offset)
    .all();
  
  // 获取消息详情
  const reportsWithMessages = await Promise.all(reports.map(async (report) => {
    const msg = await db.select()
      .from(schema.messages)
      .where(eq(schema.messages.id, report.messageId))
      .get();
    return { ...report, message: msg };
  }));
  
  return c.json({ success: true, data: reportsWithMessages });
});

// ==================== 消息收藏 ====================
// 收藏消息
app.post('/api/messages/:id/star', auth, csrfProtection, async (c) => {
  const messageId = c.req.param('id');
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  const msg = await db.select()
    .from(schema.messages)
    .where(eq(schema.messages.id, messageId))
    .get();
  
  if (!msg) {
    return c.json({ success: false, message: '消息不存在' }, 404);
  }
  
  // 检查是否已收藏
  const existing = await db.select()
    .from(schema.message_reactions)
    .where(and(
      eq(schema.message_reactions.messageId, messageId),
      eq(schema.message_reactions.userId, userId),
      eq(schema.message_reactions.emoji, '⭐')
    ))
    .get();
  
  if (existing) {
    return c.json({ success: false, message: '已经收藏过了' }, 400);
  }
  
  await db.insert(schema.message_reactions).values({
    id: crypto.randomUUID(),
    messageId,
    userId,
    emoji: '⭐',
    createdAt: utcNow()
  });
  
  return c.json({ success: true, message: '收藏成功' });
});

// 取消收藏
app.delete('/api/messages/:id/star', auth, csrfProtection, async (c) => {
  const messageId = c.req.param('id');
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  await db.delete(schema.message_reactions)
    .where(and(
      eq(schema.message_reactions.messageId, messageId),
      eq(schema.message_reactions.userId, userId),
      eq(schema.message_reactions.emoji, '⭐')
    ));
  
  return c.json({ success: true, message: '已取消收藏' });
});

// 获取我收藏的消息
app.get('/api/stars/my', auth, async (c) => {
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '20');
  const offset = (page - 1) * limit;
  
  const stars = await db.select()
    .from(schema.message_reactions)
    .where(and(
      eq(schema.message_reactions.userId, userId),
      eq(schema.message_reactions.emoji, '⭐')
    ))
    .orderBy(schema.message_reactions.createdAt)
    .limit(limit)
    .offset(offset)
    .all();
  
  // 获取消息详情
  const starsWithMessages = await Promise.all(stars.map(async (star) => {
    const msg = await db.select()
      .from(schema.messages)
      .where(eq(schema.messages.id, star.messageId))
      .get();
    
    if (!msg) return null;
    
    const sender = await db.select()
      .from(schema.users)
      .where(eq(schema.users.id, msg.senderId))
      .get();
    
    const session = await db.select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, msg.sessionId))
      .get();
    
    return {
      ...star,
      message: {
        ...msg,
        sender: sender ? { id: sender.id, name: sender.name, avatar: sender.avatar } : null,
        sessionName: session?.name
      }
    };
  }));
  
  const filtered = starsWithMessages.filter(s => s !== null);
  
  return c.json({ success: true, data: filtered });
});

// 检查消息是否被收藏
app.get('/api/messages/:id/starred', auth, async (c) => {
  const messageId = c.req.param('id');
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  const existing = await db.select()
    .from(schema.message_reactions)
    .where(and(
      eq(schema.message_reactions.messageId, messageId),
      eq(schema.message_reactions.userId, userId),
      eq(schema.message_reactions.emoji, '⭐')
    ))
    .get();
  
  return c.json({ success: true, starred: !!existing });
});

// 删除消息
app.delete('/api/messages/:id', auth, csrfProtection, async (c) => {
  const messageId = c.req.param('id');
  const { sessionId } = await c.req.json();
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  const msg = await db.select()
    .from(schema.messages)
    .where(eq(schema.messages.id, messageId))
    .get();
  
  if (!msg) {
    return c.json({ success: false, message: '消息不存在' }, 404);
  }
  
  if (msg.senderId !== userId) {
    // 检查消息发送者是否开启了"不允许删除"设置
    const senderSettings = await db.select()
      .from(schema.userSettings)
      .where(eq(schema.userSettings.userId, msg.senderId))
      .get();
    
      if (senderSettings?.cannotDelete === 1) {
        return c.json({ success: false, message: '该用户不允许删除消息' }, 403);
      }
  }
  
  if (msg.isDeleted === 1) {
    return c.json({ success: false, message: '消息已删除' }, 400);
  }
  
  const sender = await db.select()
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();
  
  const displayForDeleter = '你删除了这条消息';
  const displayForOther = `${sender?.name || '对方'} 删除了你的一条消息`;
  
  await db.update(schema.messages)
    .set({
      content: `${displayForDeleter}|${displayForOther}`,
      isSystem: 1,
      isDeleted: 1,
      encrypted: 0,
      senderId: userId
    })
    .where(eq(schema.messages.id, messageId));
  
  // 广播消息删除事件（统一使用 'global' Durable Object）
  try {
    const chatId = c.env.CHAT.idFromName('global');
    const chatStub = c.env.CHAT.get(chatId);
    await chatStub.fetch('https://broadcast', {
      method: 'POST',
      body: JSON.stringify({
        type: 'messageDeleted',
        data: {
          messageId,
          sessionId,
          originalSenderId: userId,
          actorId: userId,
          actorName: sender?.name || '对方'
        }
      })
    });
  } catch (e) {}
  
  return c.json({ success: true });
});

// ==================== 群组管理 ====================

// 创建群组
app.post('/api/groups', auth, csrfProtection, async (c) => {
  try {
    const { name, memberIds } = await c.req.json();
    
    // 群组操作限流
    const rateLimitKey = `group:${c.get('userId')}`;
    const { allowed: groupAllowed, remaining: groupRemaining, resetIn: groupResetIn } = await checkRateLimit(rateLimitKey, RATE_LIMITS.GROUP);
    if (!groupAllowed) {
      return c.json({ success: false, message: '操作过于频繁，请稍后再试' }, 429, createRateLimitHeaders(groupRemaining, groupResetIn));
    }
    
    const db = drizzle(c.env.DB);
    const userId = c.get('userId');
    
    if (!name || !name.trim()) {
      return c.json({ success: false, message: '群名称不能为空' }, 400);
    }
    
    const groupId = crypto.randomUUID();
    const now = utcNow();
    
    await db.insert(schema.sessions).values({ 
      id: groupId, 
      type: 'group', 
      name: name.trim(), 
      announcement: '', 
      ownerIds: JSON.stringify([userId]), 
      lastMessage: '', 
      createdAt: now 
    });
    
    // 创建者自动成为群主和成员
    await db.insert(schema.session_participants).values({ sessionId: groupId, userId });
    
    // 添加其他成员（批量插入）
    if (memberIds && memberIds.length > 0) {
      const otherMemberIds = memberIds.filter(id => id !== userId);
      if (otherMemberIds.length > 0) {
        await db.insert(schema.session_participants).values(
          otherMemberIds.map(memberId => ({ sessionId: groupId, userId: memberId }))
        ).onConflictDoNothing();
      }
    }
    
    // 发送系统消息
    const memberCount = (memberIds?.length || 0) + 1;
    const systemMessage = {
      id: crypto.randomUUID(),
      sessionId: groupId,
      senderId: 'system',
      senderName: '系统',
      content: `群聊已创建，当前有 ${memberCount} 位成员`,
      type: 1,
      time: now,
      timestamp: now,
      read: 0,
      recalled: 0,
      isSystem: 1,
      isDeleted: 0
    };
    await db.insert(schema.messages).values(systemMessage);
    
    // 广播会话列表更新
    try {
      const chatId = c.env.CHAT.idFromName('global');
      const chatStub = c.env.CHAT.get(chatId);
      await chatStub.fetch('https://broadcast', {
        method: 'POST',
        body: JSON.stringify({
          type: 'conversationsUpdate',
          data: { userId }
        })
      });
    } catch (e) {
      console.error('Broadcast error:', e);
    }
    
    return c.json({ success: true, data: { id: groupId, name: name.trim(), type: 'group' } });
  } catch (e) {
    console.error('Create group error:', e);
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// 搜索群组
app.get('/api/groups/search', auth, async (c) => {
  const db = drizzle(c.env.DB);
  const query = c.req.query('q') as string;
  const userId = c.get('userId');
  
  let groups;
  if (query && query.length >= 1) {
    groups = await db.select()
      .from(schema.sessions)
      .where(and(
        eq(schema.sessions.type, 'group'),
        like(schema.sessions.name, `%${query}%`)
      ))
      .limit(20)
      .all();
  } else {
    groups = await db.select()
      .from(schema.sessions)
      .where(eq(schema.sessions.type, 'group'))
      .limit(50)
      .all();
  }
  
  // 批量获取所有群的成员数量
  const groupIds = groups.map(g => g.id);
  const allParticipants = groupIds.length > 0
    ? await db.select().from(schema.session_participants).where(sql`${schema.session_participants.sessionId} IN ${groupIds}`).all()
    : [];
  
  const participantsByGroup = new Map<string, typeof allParticipants>();
  for (const p of allParticipants) {
    if (!participantsByGroup.has(p.sessionId)) {
      participantsByGroup.set(p.sessionId, []);
    }
    participantsByGroup.get(p.sessionId)!.push(p);
  }
  
  const groupsWithCount = groups.map(group => {
    const members = participantsByGroup.get(group.id) || [];
    const isJoined = members.some(m => m.userId === userId);
    
    return {
      id: group.id,
      name: group.name,
      memberCount: members.length,
      announcement: group.announcement || '',
      isJoined
    };
  });
  
  return c.json({ success: true, data: groupsWithCount });
});

// 获取所有用户（用于创建群组选择成员）
app.get('/api/users/all', auth, async (c) => {
  const db = drizzle(c.env.DB);
  const currentUserId = c.get('userId');
  
  const users = await db.select({
    id: schema.users.id,
    name: schema.users.name,
    username: schema.users.username,
    avatar: schema.users.avatar,
    signature: schema.users.signature
  })
  .from(schema.users)
  .where(ne(schema.users.id, currentUserId))
  .all();
  
  return c.json({ success: true, data: users });
});

// 获取单个用户详情
app.get('/api/users/:id', auth, async (c) => {
  const db = drizzle(c.env.DB);
  const targetUserId = c.req.param('id');
  
  const user = await db.select({
    id: schema.users.id,
    name: schema.users.name,
    username: schema.users.username,
    avatar: schema.users.avatar,
    signature: schema.users.signature,
    status: schema.users.status,
    role: schema.users.role
  })
  .from(schema.users)
  .where(eq(schema.users.id, targetUserId))
  .get();
  
  if (!user) {
    return c.json({ success: false, message: '用户不存在' }, 404);
  }
  
  return c.json({ success: true, data: user });
});

// 申请加入群组
app.post('/api/groups/:id/join', auth, csrfProtection, async (c) => {
  const groupId = c.req.param('id');
  const { reason } = await c.req.json().catch(() => ({}));
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  const group = await db.select()
    .from(schema.sessions)
    .where(and(
      eq(schema.sessions.id, groupId),
      eq(schema.sessions.type, 'group')
    ))
    .get();
  
  if (!group) {
    return c.json({ success: false, message: '群不存在' }, 404);
  }
  
  // 检查是否已在群中
  const existing = await db.select()
    .from(schema.session_participants)
    .where(and(
      eq(schema.session_participants.sessionId, groupId),
      eq(schema.session_participants.userId, userId)
    ))
    .get();
  
  if (existing) {
    return c.json({ success: false, message: '已在群中' }, 400);
  }
  
  // 检查是否有待处理的申请
  const pendingRequest = await db.select()
    .from(schema.group_join_requests)
    .where(and(
      eq(schema.group_join_requests.groupId, groupId),
      eq(schema.group_join_requests.userId, userId),
      eq(schema.group_join_requests.status, 'pending')
    ))
    .get();
  
  if (pendingRequest) {
    return c.json({ success: false, message: '已有待处理的申请' }, 400);
  }
  
  // 检查群组是否需要审核
  if (group.requireApproval === 1) {
    // 获取用户信息
    const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
    
    // 创建加入申请
    await db.insert(schema.group_join_requests).values({
      id: crypto.randomUUID(),
      groupId,
      userId,
      userName: user?.name || '',
      status: 'pending',
      reason: reason || '',
      createdAt: utcNow()
    });
    
    // 获取群主信息并发送通知
    const ownerIds = JSON.parse(group.ownerIds || '[]');
    for (const ownerId of ownerIds) {
      await db.insert(schema.notifications).values({
        id: crypto.randomUUID(),
        userId: ownerId,
        type: 'join_request',
        title: '加群申请',
        content: `用户 ${user?.name || '未知用户'} 申请加入群聊 "${group.name}"`,
        data: JSON.stringify({ groupId, applicantId: userId, applicantName: user?.name }),
        createdAt: utcNow()
      });
    }
    
    // 通知群主（通过 WebSocket）
    try {
      const chatId = c.env.CHAT.idFromName('global');
      const chatStub = c.env.CHAT.get(chatId);
      await chatStub.fetch(new Request('https://broadcast/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'joinRequestSubmitted',
          data: { groupId, groupName: group.name, userId, userName: user?.name || '', ownerIds }
        })
      }));
    } catch (e: any) {
      console.error('[JoinRequest] Broadcast error:', e?.message || e);
    }
    
    return c.json({ success: true, message: '申请已提交，等待群主审核', pending: true });
  }
  
  // 不需要审核，直接加入
  await db.insert(schema.session_participants).values({ sessionId: groupId, userId }).onConflictDoNothing();
  
  // 获取用户信息
  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  
  // 发送系统消息
  const now = utcNow();
  const systemMessage = {
    id: crypto.randomUUID(),
    sessionId: groupId,
    senderId: 'system',
    senderName: '系统',
    content: `${user?.name || '未知用户'} 加入了群聊`,
    type: 1,
    time: now,
    timestamp: now,
    read: 0,
    recalled: 0,
    isSystem: 1,
    isDeleted: 0
  };
  await db.insert(schema.messages).values(systemMessage);
  
  // 更新会话的最后消息
  await db.update(schema.sessions)
    .set({ lastMessage: systemMessage.content, lastTime: now })
    .where(eq(schema.sessions.id, groupId));
  
  // 广播消息给群里所有成员
  try {
    const chatId = c.env.CHAT.idFromName('global');
    const chatStub = c.env.CHAT.get(chatId);
    await chatStub.fetch('https://broadcast', {
      method: 'POST',
      body: JSON.stringify({
        type: 'newMessage',
        data: { ...systemMessage, sender: { id: 'system', name: '系统' } }
      })
    });
  } catch (e) {
    console.error('Broadcast error:', e);
  }
  
  // 广播会话列表更新
  try {
    const chatId = c.env.CHAT.idFromName('global');
    const chatStub = c.env.CHAT.get(chatId);
    await chatStub.fetch('https://broadcast', {
      method: 'POST',
      body: JSON.stringify({
        type: 'conversationsUpdate',
        data: { userId }
      })
    });
  } catch (e) {}
  
  return c.json({ success: true, message: '加入成功' });
});

// 获取我的加群申请列表（只返回最近2天和待审核的申请）
app.get('/api/groups/join-requests/my', auth, async (c) => {
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  const now = Date.now();
  const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;
  
  // 清理超过2天的已处理申请（已通过或已拒绝），待审核的永久保留
  await db.delete(schema.group_join_requests)
    .where(and(
      eq(schema.group_join_requests.userId, userId),
      sql`${schema.group_join_requests.createdAt} < ${twoDaysAgo}`,
      ne(schema.group_join_requests.status, 'pending')
    ));
  
  // 返回所有待审核的申请 + 最近2天已处理的申请
  const requests = await db.select()
    .from(schema.group_join_requests)
    .where(sql`${schema.group_join_requests.userId} = ${userId} AND (${schema.group_join_requests.status} = 'pending' OR ${schema.group_join_requests.createdAt} >= ${twoDaysAgo})`)
    .orderBy(sql`CASE WHEN ${schema.group_join_requests.status} = 'pending' THEN 0 ELSE 1 END, ${schema.group_join_requests.createdAt} DESC`)
    .all();
  
  // 获取群组信息
  const requestsWithGroup = await Promise.all(requests.map(async (req) => {
    const group = await db.select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, req.groupId))
      .get();
    return {
      ...req,
      groupName: group?.name || '未知群组'
    };
  }));
  
  return c.json({ success: true, data: requestsWithGroup });
});

// 获取我作为群主的群的待处理入群申请（所有群）
app.get('/api/groups/join-requests/owned', auth, async (c) => {
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  // 获取用户拥有的所有群组
  const ownedGroups = await db.select()
    .from(schema.sessions)
    .where(eq(schema.sessions.type, 'group'))
    .all();
  
  // 筛选用户是群主的群组
  const ownedGroupIds = ownedGroups
    .filter(group => {
      const ownerIds = JSON.parse(group.ownerIds || '[]');
      return ownerIds.includes(userId);
    })
    .map(group => group.id);
  
  if (ownedGroupIds.length === 0) {
    return c.json({ success: true, data: [], groupIds: [] });
  }
  
  // 获取这些群的所有待处理申请
  const pendingRequests = await db.select()
    .from(schema.group_join_requests)
    .where(and(
      sql`${schema.group_join_requests.groupId} IN (${sql.join(ownedGroupIds.map(id => sql`${id}`), sql`, `)})`,
      eq(schema.group_join_requests.status, 'pending')
    ))
    .orderBy(schema.group_join_requests.createdAt)
    .all();
  
  // 添加群组名称
  const groupMap = new Map(ownedGroups.map(g => [g.id, g]));
  const requestsWithGroup = pendingRequests.map(req => ({
    ...req,
    groupName: groupMap.get(req.groupId)?.name || '未知群组'
  }));
  
  return c.json({ success: true, data: requestsWithGroup, groupIds: ownedGroupIds }, 200, {
    'Cache-Control': 'no-store, no-cache, must-revalidate'
  });
});

// 获取群组的加群申请列表（群主/管理员）
app.get('/api/groups/:id/join-requests', auth, async (c) => {
  const groupId = c.req.param('id');
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  // 获取群组信息
  const group = await db.select()
    .from(schema.sessions)
    .where(and(
      eq(schema.sessions.id, groupId),
      eq(schema.sessions.type, 'group')
    ))
    .get();
  
  if (!group) {
    return c.json({ success: false, message: '群不存在' }, 404);
  }
  
  // 检查是否是群主或管理员
  const ownerIds = JSON.parse(group.ownerIds || '[]');
  const isAdmin = ownerIds.includes(userId) || (await db.select().from(schema.admins).where(eq(schema.admins.id, userId)).get());
  
  if (!isAdmin) {
    return c.json({ success: false, message: '无权查看' }, 403);
  }
  
  // 获取待处理的申请
  const pendingRequests = await db.select()
    .from(schema.group_join_requests)
    .where(and(
      eq(schema.group_join_requests.groupId, groupId),
      eq(schema.group_join_requests.status, 'pending')
    ))
    .orderBy(schema.group_join_requests.createdAt)
    .all();
  
  return c.json({ success: true, data: pendingRequests });
});

// 批准加群申请
app.post('/api/groups/:id/join-requests/:rid/approve', auth, csrfProtection, async (c) => {
  const groupId = c.req.param('id');
  const requestId = c.req.param('rid');
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  // 获取群组信息
  const group = await db.select()
    .from(schema.sessions)
    .where(and(
      eq(schema.sessions.id, groupId),
      eq(schema.sessions.type, 'group')
    ))
    .get();
  
  if (!group) {
    return c.json({ success: false, message: '群不存在' }, 404);
  }
  
  // 检查是否是群主或管理员
  const ownerIds = JSON.parse(group.ownerIds || '[]');
  const isAdmin = ownerIds.includes(userId) || (await db.select().from(schema.admins).where(eq(schema.admins.id, userId)).get());
  
  if (!isAdmin) {
    return c.json({ success: false, message: '无权操作' }, 403);
  }
  
  // 获取申请信息
  const request = await db.select()
    .from(schema.group_join_requests)
    .where(eq(schema.group_join_requests.id, requestId))
    .get();
  
  if (!request || request.groupId !== groupId) {
    return c.json({ success: false, message: '申请不存在' }, 404);
  }
  
  if (request.status !== 'pending') {
    return c.json({ success: false, message: '申请已被处理' }, 400);
  }
  
  // 添加用户到群组
  await db.insert(schema.session_participants).values({
    sessionId: groupId,
    userId: request.userId
  }).onConflictDoNothing();
  
  // 更新申请状态
  await db.update(schema.group_join_requests)
    .set({
      status: 'approved',
      reviewedBy: userId,
      reviewedAt: utcNow()
    })
    .where(eq(schema.group_join_requests.id, requestId));
  
  // 发送系统消息
  const now = utcNow();
  const systemMessage = {
    id: crypto.randomUUID(),
    sessionId: groupId,
    senderId: 'system',
    senderName: '系统',
    content: `${request.userName || '未知用户'} 加入了群聊`,
    type: 1,
    time: now,
    timestamp: now,
    read: 0,
    recalled: 0,
    isSystem: 1,
    isDeleted: 0
  };
  await db.insert(schema.messages).values(systemMessage);
  
  // 更新会话的最后消息
  await db.update(schema.sessions)
    .set({ lastMessage: systemMessage.content, lastTime: now })
    .where(eq(schema.sessions.id, groupId));
  
  // 通知申请人
  await db.insert(schema.notifications).values({
    id: crypto.randomUUID(),
    userId: request.userId,
    type: 'join_approved',
    title: '加群申请通过',
    content: `你的加群申请已通过，欢迎加入群聊 "${group.name}"`,
    data: JSON.stringify({ groupId }),
    createdAt: utcNow()
  });
  
  // 广播消息给群里所有成员
  try {
    const chatId = c.env.CHAT.idFromName('global');
    const chatStub = c.env.CHAT.get(chatId);
    await chatStub.fetch('https://broadcast', {
      method: 'POST',
      body: JSON.stringify({
        type: 'newMessage',
        data: { ...systemMessage, sender: { id: 'system', name: '系统' } }
      })
    });
  } catch (e) {}
  
  // 通知申请人（通过 WebSocket）
  try {
    const chatId = c.env.CHAT.idFromName('global');
    const chatStub = c.env.CHAT.get(chatId);
    await chatStub.fetch(new Request('https://broadcast/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'joinRequestApproved',
        data: { groupId, groupName: group.name, userId: request.userId }
      })
    }));
  } catch (e: any) {
    console.error('[JoinRequest] Approve error:', e?.message || e);
  }
  
  return c.json({ success: true, message: '已批准申请' });
});

// 拒绝加群申请
app.post('/api/groups/:id/join-requests/:rid/reject', auth, csrfProtection, async (c) => {
  const groupId = c.req.param('id');
  const requestId = c.req.param('rid');
  const { reason } = await c.req.json().catch(() => ({}));
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  // 获取群组信息
  const group = await db.select()
    .from(schema.sessions)
    .where(and(
      eq(schema.sessions.id, groupId),
      eq(schema.sessions.type, 'group')
    ))
    .get();
  
  if (!group) {
    return c.json({ success: false, message: '群不存在' }, 404);
  }
  
  // 检查是否是群主或管理员
  const ownerIds = JSON.parse(group.ownerIds || '[]');
  const isAdmin = ownerIds.includes(userId) || (await db.select().from(schema.admins).where(eq(schema.admins.id, userId)).get());
  
  if (!isAdmin) {
    return c.json({ success: false, message: '无权操作' }, 403);
  }
  
  // 获取申请信息
  const request = await db.select()
    .from(schema.group_join_requests)
    .where(eq(schema.group_join_requests.id, requestId))
    .get();
  
  if (!request || request.groupId !== groupId) {
    return c.json({ success: false, message: '申请不存在' }, 404);
  }
  
  if (request.status !== 'pending') {
    return c.json({ success: false, message: '申请已被处理' }, 400);
  }
  
  // 更新申请状态
  await db.update(schema.group_join_requests)
    .set({
      status: 'rejected',
      reviewedBy: userId,
      reviewedAt: utcNow(),
      reason: reason || request.reason || ''
    })
    .where(eq(schema.group_join_requests.id, requestId));
  
  // 通知申请人
  await db.insert(schema.notifications).values({
    id: crypto.randomUUID(),
    userId: request.userId,
    type: 'join_rejected',
    title: '加群申请被拒绝',
    content: `你的加群申请已被拒绝${reason ? '：' + reason : ''}`,
    data: JSON.stringify({ groupId }),
    createdAt: utcNow()
  });
  
  // 通知申请人（通过 WebSocket）
  try {
    const chatId = c.env.CHAT.idFromName('global');
    const chatStub = c.env.CHAT.get(chatId);
    await chatStub.fetch(new Request('https://broadcast/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'joinRequestRejected',
        data: { groupId, groupName: group.name, userId: request.userId, reason: reason || '' }
      })
    }));
  } catch (e: any) {
    console.error('[JoinRequest] Reject error:', e?.message || e);
  }
  
  return c.json({ success: true, message: '已拒绝申请' });
});

// 设置群组的审核模式
app.put('/api/groups/:id/settings/approval', auth, csrfProtection, async (c) => {
  const groupId = c.req.param('id');
  const { requireApproval } = await c.req.json();
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  // 获取群组信息
  const group = await db.select()
    .from(schema.sessions)
    .where(and(
      eq(schema.sessions.id, groupId),
      eq(schema.sessions.type, 'group')
    ))
    .get();
  
  if (!group) {
    return c.json({ success: false, message: '群不存在' }, 404);
  }
  
  // 检查是否是群主
  const ownerIds = JSON.parse(group.ownerIds || '[]');
  if (!ownerIds.includes(userId)) {
    return c.json({ success: false, message: '只有群主可以修改设置' }, 403);
  }
  
  // 更新设置
  await db.update(schema.sessions)
    .set({ requireApproval: requireApproval ? 1 : 0 })
    .where(eq(schema.sessions.id, groupId));
  
  return c.json({ success: true, message: '设置已更新' });
});

// 获取群信息
app.get('/api/groups/:id', auth, async (c) => {
  const groupId = c.req.param('id');
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  const group = await db.select()
    .from(schema.sessions)
    .where(and(
      eq(schema.sessions.id, groupId),
      eq(schema.sessions.type, 'group')
    ))
    .get();
  
  if (!group) {
    return c.json({ success: false, message: '群不存在' }, 404);
  }
  
  const members = await db.select()
    .from(schema.users)
    .innerJoin(schema.session_participants, eq(schema.users.id, schema.session_participants.userId))
    .where(eq(schema.session_participants.sessionId, groupId))
    .all();
  
  const ownerIds = group.ownerIds ? JSON.parse(group.ownerIds) : [];
  
  return c.json({
    success: true,
    data: {
      id: group.id,
      name: group.name,
      announcement: group.announcement || '',
      members: members.map(m => m.users),
      memberCount: members.length,
      ownerIds
    }
  });
});

// 更新群公告
app.put('/api/groups/:id/announcement', auth, csrfProtection, async (c) => {
  const groupId = c.req.param('id');
  const { announcement } = await c.req.json();
  const db = drizzle(c.env.DB);
  
  const group = await db.select()
    .from(schema.sessions)
    .where(and(
      eq(schema.sessions.id, groupId),
      eq(schema.sessions.type, 'group')
    ))
    .get();
  
  if (!group) {
    return c.json({ success: false, message: '群不存在' }, 404);
  }
  
  const ownerIds = group.ownerIds ? JSON.parse(group.ownerIds) : [];
  const userId = c.get('userId');
  
  if (!ownerIds.includes(userId)) {
    return c.json({ success: false, message: '只有群主可以修改群公告' }, 403);
  }
  
  await db.update(schema.sessions)
    .set({ announcement })
    .where(eq(schema.sessions.id, groupId));
  
  return c.json({ success: true });
});

// 置顶会话
app.post('/api/conversations/:id/pin', auth, csrfProtection, async (c) => {
  const sessionId = c.req.param('id');
  const { isPinned } = await c.req.json();
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  const participant = await db.select()
    .from(schema.session_participants)
    .where(and(
      eq(schema.session_participants.sessionId, sessionId),
      eq(schema.session_participants.userId, userId)
    ))
    .get();
  
  if (!participant) {
    return c.json({ success: false, message: '无权操作此会话' }, 403);
  }
  
  await db.update(schema.sessions)
    .set({ isPinned: isPinned ? 1 : 0 })
    .where(eq(schema.sessions.id, sessionId));
  
  return c.json({ success: true });
});

// 免打扰
app.post('/api/conversations/:id/mute', auth, csrfProtection, async (c) => {
  const sessionId = c.req.param('id');
  const { isMuted } = await c.req.json();
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  const participant = await db.select()
    .from(schema.session_participants)
    .where(and(
      eq(schema.session_participants.sessionId, sessionId),
      eq(schema.session_participants.userId, userId)
    ))
    .get();
  
  if (!participant) {
    return c.json({ success: false, message: '无权操作此会话' }, 403);
  }
  
  await db.update(schema.sessions)
    .set({ isMuted: isMuted ? 1 : 0 })
    .where(eq(schema.sessions.id, sessionId));
  
  return c.json({ success: true });
});

// 退出群聊
app.delete('/api/groups/:id/members/:memberId', auth, csrfProtection, async (c) => {
  const groupId = c.req.param('id');
  const memberId = c.req.param('memberId');
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  const group = await db.select()
    .from(schema.sessions)
    .where(and(
      eq(schema.sessions.id, groupId),
      eq(schema.sessions.type, 'group')
    ))
    .get();
  
  if (!group) {
    return c.json({ success: false, message: '群不存在' }, 404);
  }
  
  const ownerIds = group.ownerIds ? JSON.parse(group.ownerIds) : [];
  const isOwner = ownerIds.includes(userId);
  const isSelf = userId === memberId;
  
  if (!isOwner && !isSelf) {
    return c.json({ success: false, message: '没有权限' }, 403);
  }
  
  if (isOwner && isSelf) {
    return c.json({ success: false, message: '群主不能退出群聊，请先转让群主' }, 400);
  }
  
  // 获取被移除成员的名称
  const leavingMember = await db.select().from(schema.users).where(eq(schema.users.id, memberId)).get();
  const leavingName = leavingMember?.name || '未知成员';
  
  // 获取操作者（踢人者或退出者自己）的名称
  const operator = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  const operatorName = operator?.name || '未知';
  
  
  
  // 先检查是否存在
  const existing = await db.select()
    .from(schema.session_participants)
    .where(and(
      eq(schema.session_participants.sessionId, groupId),
      eq(schema.session_participants.userId, memberId)
    ))
    .all();
  
  
  // 删除成员
  const deleteResult = await db.delete(schema.session_participants)
    .where(and(
      eq(schema.session_participants.sessionId, groupId),
      eq(schema.session_participants.userId, memberId)
    ))
    .run();
  

  // 验证删除后的状态
  const afterDelete = await db.select()
    .from(schema.session_participants)
    .where(and(
      eq(schema.session_participants.sessionId, groupId),
      eq(schema.session_participants.userId, memberId)
    ))
    .all();
  
  
  // 判断是主动退出还是被踢
  let systemContent: string;
  if (isSelf) {
    // 自己主动退出
    systemContent = `${leavingName} 退出了群聊`;
  } else {
    // 被群主踢出
    systemContent = `${leavingName} 被 ${operatorName} 移出了群聊`;
  }
  
  // 发送系统消息
  const systemMessage = {
    id: crypto.randomUUID(),
    sessionId: groupId,
    senderId: 'system',
    senderName: '系统',
    content: systemContent,
    type: 1,
    time: utcNow(),
    timestamp: utcNow(),
    read: 0,
    recalled: 0,
    isSystem: 1,
    isDeleted: 0,
    kickedUserId: memberId  // 被踢的用户ID，用于前端判断是否显示通知
  };
  await db.insert(schema.messages).values(systemMessage);
  
  // 广播系统消息给群里所有人
  try {
    
    const chatId = c.env.CHAT.idFromName('global');
    const chatStub = c.env.CHAT.get(chatId);
    await chatStub.fetch(new Request('https://broadcast/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'broadcastToAll',
        data: { 
          ...systemMessage, 
          sender: { id: 'system', name: '系统' }
        }
      })
    }));
    
  } catch (e) {
    console.error('Broadcast error:', e);
  }

  // 发送踢人通知（只给被踢的用户）
  if (!isSelf) {
    const chatId = c.env.CHAT.idFromName('global');
    const chatStub = c.env.CHAT.get(chatId);
    
    // 同时保存到数据库（确保用户重新登录后能收到通知）
    await db.insert(schema.notifications).values({
      id: crypto.randomUUID(),
      userId: memberId,
      type: 'kickedFromGroup',
      title: '被移出群聊',
      content: `你已被 ${operatorName} 从 "${group.name}" 移出`,
      data: JSON.stringify({ groupId, groupName: group.name, kickedBy: operatorName }),
      createdAt: utcNow()
    });
    
    // 尝试通过 WebSocket 发送实时通知
    try {
      await chatStub.fetch(new Request('https://broadcast/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'kickedFromGroup',
          data: { groupId, groupName: group.name, kickedBy: operatorName, targetUserId: memberId }
        })
      }));
    } catch (e) {
      console.error('Failed to send kicked notification via WebSocket:', e);
    }
  }
  
  // 广播会话列表更新给退出者（用于刷新会话列表，移除退出的群聊）
  try {
    const chatId = c.env.CHAT.idFromName('global');
    const chatStub = c.env.CHAT.get(chatId);
    await chatStub.fetch(new Request('https://broadcast/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'conversationsUpdate',
        data: { userId: userId }
      })
    }));
  } catch (e) {
    console.error('Broadcast error:', e);
  }
  
  return c.json({ success: true });
});

// 添加群成员
app.post('/api/groups/:id/members', auth, csrfProtection, async (c) => {
  const groupId = c.req.param('id');
  const { memberId } = await c.req.json();
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  const group = await db.select()
    .from(schema.sessions)
    .where(and(
      eq(schema.sessions.id, groupId),
      eq(schema.sessions.type, 'group')
    ))
    .get();
  
  if (!group) {
    return c.json({ success: false, message: '群不存在' }, 404);
  }
  
  const ownerIds = group.ownerIds ? JSON.parse(group.ownerIds) : [];
  const isOwner = ownerIds.includes(userId);
  
  if (!isOwner) {
    return c.json({ success: false, message: '只有群主可以添加成员' }, 403);
  }
  
  const newMember = await db.select().from(schema.users).where(eq(schema.users.id, memberId)).get();
  if (!newMember) {
    return c.json({ success: false, message: '用户不存在' }, 404);
  }
  
  await db.insert(schema.session_participants).values({ sessionId: groupId, userId: memberId }).onConflictDoNothing();
  
  // 发送系统消息
  const systemMessage = {
    id: crypto.randomUUID(),
    sessionId: groupId,
    senderId: 'system',
    senderName: '系统',
    content: `欢迎 ${newMember.name} 加入群聊`,
    type: 1,
    time: utcNow(),
    timestamp: utcNow(),
    read: 0,
    recalled: 0,
    isSystem: 1,
    isDeleted: 0,
    joinedUserId: memberId  // 新加入的用户ID，用于前端判断是否显示通知
  };
  await db.insert(schema.messages).values(systemMessage);
  
  // 广播欢迎消息给群里所有人
  try {
    const chatId = c.env.CHAT.idFromName('global');
    const chatStub = c.env.CHAT.get(chatId);
    await chatStub.fetch(new Request('https://broadcast/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'broadcastToAll',
        data: { 
          ...systemMessage, 
          sender: { id: 'system', name: '系统' }
        }
      })
    }));
  } catch (e) {
    console.error('Broadcast error:', e);
  }

  // 广播群成员更新
  try {
    const chatId = c.env.CHAT.idFromName('global');
    const chatStub = c.env.CHAT.get(chatId);
    await chatStub.fetch(new Request('https://broadcast/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'groupMembersUpdate',
        data: { groupId }
      })
    }));
  } catch (e) {
    console.error('Group members update error:', e);
  }

  // 发送加群通知（只给被加入的用户）
  const chatId = c.env.CHAT.idFromName('global');
  const chatStub = c.env.CHAT.get(chatId);
  
  // 同时保存到数据库（确保用户重新登录后能收到通知）
  await db.insert(schema.notifications).values({
    id: crypto.randomUUID(),
    userId: memberId,
    type: 'joinedGroup',
    title: '加群成功',
    content: `你已加入群聊 "${group.name}"`,
    data: JSON.stringify({ groupId, groupName: group.name }),
    createdAt: utcNow()
  });
  
  // 尝试通过 WebSocket 发送实时通知
  try {
    await chatStub.fetch(new Request('https://broadcast/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'joinedGroup',
        data: { groupId, groupName: group.name, targetUserId: memberId }
      })
    }));
  } catch (e) {
    console.error('Failed to send joined notification via WebSocket:', e);
  }
  
  return c.json({ success: true });
});

// 添加群主
app.post('/api/groups/:id/owners', auth, csrfProtection, async (c) => {
  const groupId = c.req.param('id');
  const { memberId } = await c.req.json();
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  const group = await db.select().from(schema.sessions).where(eq(schema.sessions.id, groupId)).get();
  if (!group) {
    return c.json({ success: false, message: '群不存在' }, 404);
  }
  
  const ownerIds = group.ownerIds ? JSON.parse(group.ownerIds) : [];
  if (!ownerIds.includes(userId)) {
    return c.json({ success: false, message: '只有群主可以添加群主' }, 403);
  }
  
  // 检查新群主是否在群中
  const isInGroup = await db.select()
    .from(schema.session_participants)
    .where(and(
      eq(schema.session_participants.sessionId, groupId),
      eq(schema.session_participants.userId, memberId)
    ))
    .get();
  
  if (!isInGroup) {
    return c.json({ success: false, message: '该用户不在群中' }, 400);
  }
  
  // 添加新群主
  if (!ownerIds.includes(memberId)) {
    ownerIds.push(memberId);
    await db.update(schema.sessions)
      .set({ ownerIds: JSON.stringify(ownerIds) })
      .where(eq(schema.sessions.id, groupId))
      .run();
  }
  
  return c.json({ success: true });
});

// 移除群主
app.delete('/api/groups/:id/owners/:memberId', auth, csrfProtection, async (c) => {
  const groupId = c.req.param('id');
  const memberId = c.req.param('memberId');
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  const group = await db.select().from(schema.sessions).where(eq(schema.sessions.id, groupId)).get();
  if (!group) {
    return c.json({ success: false, message: '群不存在' }, 404);
  }
  
  // 只有群主可以移除群主身份
  const ownerIds = group.ownerIds ? JSON.parse(group.ownerIds) : [];
  if (!ownerIds.includes(userId)) {
    return c.json({ success: false, message: '只有群主可以移除群主' }, 403);
  }
  
  // 不能移除最后一个群主
  if (ownerIds.length === 1 && ownerIds.includes(memberId)) {
    return c.json({ success: false, message: '不能移除最后一个群主' }, 400);
  }
  
  // 移除群主
  const newOwnerIds = ownerIds.filter(id => id !== memberId);
  await db.update(schema.sessions)
    .set({ ownerIds: JSON.stringify(newOwnerIds) })
    .where(eq(schema.sessions.id, groupId))
    .run();
  
  return c.json({ success: true });
});

// ==================== 群禁言管理 ====================

// 获取群禁言列表
app.get('/api/groups/:id/mutes', auth, async (c) => {
  const groupId = c.req.param('id');
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  const group = await db.select().from(schema.sessions).where(eq(schema.sessions.id, groupId)).get();
  if (!group) {
    return c.json({ success: false, message: '群不存在' }, 404);
  }
  
  const ownerIds = group.ownerIds ? JSON.parse(group.ownerIds) : [];
  if (!ownerIds.includes(userId)) {
    return c.json({ success: false, message: '只有群主可以查看禁言列表' }, 403);
  }
  
  const mutes = await db.select().from(schema.groupMutes).where(eq(schema.groupMutes.sessionId, groupId)).all();
  
  const userIds = [...new Set(mutes.map(m => m.userId).concat(mutes.map(m => m.mutedBy)))];
  const users = await db.select().from(schema.users).where(sql`${schema.users.id} IN ${userIds}`).all();
  const userMap = new Map(users.map(u => [u.id, u]));
  
  const result = mutes.map(mute => {
    const user = userMap.get(mute.userId);
    const mutedByUser = userMap.get(mute.mutedBy);
    return {
      ...mute,
      user: user ? { id: user.id, name: user.name, username: user.username, avatar: user.avatar } : null,
      mutedByUser: mutedByUser ? { id: mutedByUser.id, name: mutedByUser.name } : null
    };
  });
  
  return c.json({ success: true, data: result });
});

// 禁言用户
app.post('/api/groups/:id/mutes', auth, csrfProtection, async (c) => {
  const groupId = c.req.param('id');
  const { userId: targetUserId, reason } = await c.req.json();
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  if (!targetUserId) {
    return c.json({ success: false, message: '请指定要禁言的用户' }, 400);
  }
  
  const group = await db.select().from(schema.sessions).where(eq(schema.sessions.id, groupId)).get();
  if (!group) {
    return c.json({ success: false, message: '群不存在' }, 404);
  }
  
  const ownerIds = group.ownerIds ? JSON.parse(group.ownerIds) : [];
  if (!ownerIds.includes(userId)) {
    return c.json({ success: false, message: '只有群主可以禁言用户' }, 403);
  }
  
  const [member, existingMute] = await Promise.all([
    db.select().from(schema.session_participants).where(and(
      eq(schema.session_participants.sessionId, groupId),
      eq(schema.session_participants.userId, targetUserId)
    )).get(),
    db.select().from(schema.groupMutes).where(and(
      eq(schema.groupMutes.sessionId, groupId),
      eq(schema.groupMutes.userId, targetUserId)
    )).get()
  ]);
    
  if (!member) {
    return c.json({ success: false, message: '用户不在群中' }, 400);
  }
  
  if (existingMute) {
    return c.json({ success: false, message: '用户已被禁言' }, 400);
  }
  
  const now = utcNow();
  
  await db.insert(schema.groupMutes).values({
    id: crypto.randomUUID(),
    sessionId: groupId,
    userId: targetUserId,
    mutedBy: userId,
    reason: reason || '',
    createdAt: now
  });
  
  const operator = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  const targetUser = await db.select().from(schema.users).where(eq(schema.users.id, targetUserId)).get();
  const operatorName = operator?.name || '群主';
  const targetUserName = targetUser?.name || '成员';
  
  // 插入禁言记录
  await db.insert(schema.groupMutes).values({
    id: crypto.randomUUID(),
    sessionId: groupId,
    userId: targetUserId,
    mutedBy: userId,
    reason: reason || '',
    createdAt: now
  });
  
  // 插入1条系统消息到数据库
  const systemMessage = {
    id: crypto.randomUUID(),
    sessionId: groupId,
    senderId: 'system',
    senderName: '系统',
    content: `${targetUserName}被 ${operatorName} 禁言了`,
    type: 1,
    time: now,
    timestamp: now,
    read: 0,
    recalled: 0,
    isSystem: 1,
    isDeleted: 0
  };
  await db.insert(schema.messages).values(systemMessage);
  
  // 广播系统消息给群里所有人
  try {
    const chatId = c.env.CHAT.idFromName('global');
    const chatStub = c.env.CHAT.get(chatId);
    await chatStub.fetch(new Request('https://broadcast/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'broadcastToAll',
        data: { ...systemMessage, sender: { id: 'system', name: '系统' } }
      })
    }));
  } catch (e) {}
  
  // 单独通知被禁言的人
  try {
    const chatId = c.env.CHAT.idFromName('global');
    const chatStub = c.env.CHAT.get(chatId);
    await chatStub.fetch(new Request('https://broadcast/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'muted',
        data: {
          groupId,
          groupName: group.name,
          reason: reason || '',
          targetUserId: targetUserId
        }
      })
    }));
  } catch (e) {}
  
  return c.json({ success: true, message: '用户已禁言' });
});

// 解除禁言
app.delete('/api/groups/:id/mutes/:muteId', auth, csrfProtection, async (c) => {
  const groupId = c.req.param('id');
  const muteId = c.req.param('muteId');
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  const group = await db.select().from(schema.sessions).where(eq(schema.sessions.id, groupId)).get();
  if (!group) {
    return c.json({ success: false, message: '群不存在' }, 404);
  }
  
  const ownerIds = group.ownerIds ? JSON.parse(group.ownerIds) : [];
  if (!ownerIds.includes(userId)) {
    return c.json({ success: false, message: '只有群主可以解除禁言' }, 403);
  }
  
  const mute = await db.select().from(schema.groupMutes).where(eq(schema.groupMutes.id, muteId)).get();
  if (!mute) {
    return c.json({ success: false, message: '禁言记录不存在' }, 404);
  }
  
  // 删除该用户在群中的所有禁言记录（避免重复记录问题）
  await db.delete(schema.groupMutes).where(and(
    eq(schema.groupMutes.sessionId, groupId),
    eq(schema.groupMutes.userId, mute.userId)
  ));
  
  const now = utcNow();
  const targetUser = await db.select().from(schema.users).where(eq(schema.users.id, mute.userId)).get();
  const operator = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  const operatorName = operator?.name || '群主';
  const targetUserName = targetUser?.name || '成员';
  
  // 插入1条系统消息到数据库
  const systemMessage = {
    id: crypto.randomUUID(),
    sessionId: groupId,
    senderId: 'system',
    senderName: '系统',
    content: `${targetUserName}已被 ${operatorName} 解除禁言了`,
    type: 1,
    time: now,
    timestamp: now,
    read: 0,
    recalled: 0,
    isSystem: 1,
    isDeleted: 0
  };
  await db.insert(schema.messages).values(systemMessage);
  
  // 广播系统消息给群里所有人
  try {
    const chatId = c.env.CHAT.idFromName('global');
    const chatStub = c.env.CHAT.get(chatId);
    await chatStub.fetch(new Request('https://broadcast/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'broadcastToAll',
        data: { ...systemMessage, sender: { id: 'system', name: '系统' } }
      })
    }));
  } catch (e) {}
  
  // 单独通知被解除禁言的人
  try {
    const chatId = c.env.CHAT.idFromName('global');
    const chatStub = c.env.CHAT.get(chatId);
    await chatStub.fetch(new Request('https://broadcast/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'unmuted',
        data: {
          groupId,
          groupName: group.name,
          message: systemMessage.content,
          targetUserId: mute.userId
        }
      })
    }));
  } catch (e) {}
  
  return c.json({ success: true, message: '已解除禁言' });
});

// 检查用户在群中是否被禁言
app.get('/api/groups/:id/mute-status', auth, async (c) => {
  const groupId = c.req.param('id');
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  const mute = await db.select()
    .from(schema.groupMutes)
    .where(and(
      eq(schema.groupMutes.sessionId, groupId),
      eq(schema.groupMutes.userId, userId)
    ))
    .get();
  
  return c.json({ 
    success: true, 
    muted: !!mute,
    reason: mute?.reason || ''
  });
});

// ==================== 系统管理 ====================

// 清除指定天数的消息
app.post('/api/system/clear-messages', adminAuth, csrfProtection, async (c) => {
  try {
    const { days = 7 } = await c.req.json();
    const db = drizzle(c.env.DB);
    
    if (typeof days !== 'number' || days < 1 || days > 365) {
      return c.json({ success: false, message: '天数必须为1-365之间的数字' }, 400);
    }
    
    const cutoffTime = utcNow() - days * 24 * 60 * 60 * 1000;
    
    // 批量删除关联记录
    await db.delete(schema.message_reads)
      .where(sql`${schema.message_reads.messageId} IN (SELECT id FROM messages WHERE time < ${cutoffTime})`)
      .run();
    
    await db.delete(schema.attachments)
      .where(sql`${schema.attachments.messageId} IN (SELECT id FROM messages WHERE time < ${cutoffTime})`)
      .run();
    
    const result = await db.delete(schema.messages)
      .where(sql`${schema.messages.time} < ${cutoffTime}`)
      .run();
    const deletedCount = result.meta.changes || 0;
    
    return c.json({ 
      success: true, 
      message: `已清除${deletedCount}条${days}天前的消息`,
      deletedCount,
      days
    });
  } catch (e) {
    console.error('Error in /api/system/clear-messages:', e);
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// ==================== 管理员 ====================

app.post('/api/admin/login', async (c) => {
  // 登录限流：基于 IP
  const clientIP = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown';
  const rateLimitKey = `admin-login:${clientIP}`;
  const { allowed, remaining, resetIn } = await checkRateLimit(rateLimitKey, RATE_LIMITS.AUTH);
  
  const rateLimitHeaders = createRateLimitHeaders(remaining, resetIn);
  
  if (!allowed) {
    return c.json({ 
      success: false, 
      message: '登录过于频繁，请稍后再试' 
    }, 429, rateLimitHeaders);
  }
  
  const { password } = await c.req.json();
  const db = drizzle(c.env.DB);
  
  // 必须配置环境变量
  const adminPassword = c.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return c.json({ success: false, message: '管理员未配置，请设置 ADMIN_PASSWORD 环境变量' }, 500);
  }
  
  // 获取管理员数据
  let admin = await db.select().from(schema.admins).get();
  if (!admin) {
    return c.json({ success: false, message: '未找到管理员用户，无法登入' }, 500);
  }
  // 验证密码
  const isValidPassword = await comparePassword(password, admin.password, c.env);
  if (!isValidPassword) {
    return c.json({ success: false, message: '密码错误' }, 401);
  }
  
  const token = await generateToken({ id: admin.id, role: admin.role || 'super_admin' });
  const csrfToken = await generateCsrfToken(admin.id);
  return c.json({ success: true, data: { token, csrfToken, admin: { id: admin.id, role: admin.role || 'super_admin' } } });
});

// 管理员初始化/重置端点（临时使用）
app.post('/api/admin/init', async (c) => {
  const db = drizzle(c.env.DB);
  const adminPassword = c.env.ADMIN_PASSWORD;
  
  if (!adminPassword) {
    return c.json({ success: false, message: '管理员未配置' }, 500);
  }
  
  // 删除现有管理员
  await db.delete(schema.admins);
  
  // 创建新管理员
  const hashedPassword = await hashPassword(adminPassword, c.env);
  await db.insert(schema.admins).values({ 
    id: crypto.randomUUID(), 
    password: hashedPassword, 
    createdAt: utcNow() 
  });
  
  const admin = await db.select().from(schema.admins).get();
  
  return c.json({ success: true, message: '管理员已初始化', admin: { id: admin?.id } });
});

app.get('/api/admin/users', adminAuth, async (c) => {
  try {
    const { page = '1', limit = '20', keyword = '' } = c.req.query();
    const db = drizzle(c.env.DB);
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    let users;
    if (keyword) {
      users = await db.select().from(schema.users).where(sql`${schema.users.name} LIKE ${`%${keyword}%`} OR ${schema.users.username} LIKE ${`%${keyword}%`}`).orderBy(desc(schema.users.createdAt)).limit(parseInt(limit)).offset(offset).all();
    } else {
      users = await db.select().from(schema.users).orderBy(desc(schema.users.createdAt)).limit(parseInt(limit)).offset(offset).all();
    }
    
    // 映射所有字段，确保 status 和 accountStatus 被正确返回
    const mappedUsers = users.map(u => ({
      id: u.id,
      name: u.name,
      username: u.username,
      avatar: u.avatar,
      signature: u.signature,
      status: u.status,
      accountStatus: u.accountStatus,
      role: u.role || 'user',
      disk: u.disk,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt
    }));
    
    const total = await db.select({ count: sql<number>`count(*)` }).from(schema.users).get();
    return c.json({ success: true, data: { list: mappedUsers, total: total?.count || 0 } });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

app.post('/api/admin/users', adminAuth, csrfProtection, async (c) => {
  const { name, username, password } = await c.req.json();
  const db = drizzle(c.env.DB);
  
  if (!name || !username || !password) {
    return c.json({ success: false, message: '缺少必要参数' }, 400);
  }
  
  const existing = await db.select().from(schema.users).where(eq(schema.users.username, username)).get();
  if (existing) {
    return c.json({ success: false, message: '用户名已存在' }, 400);
  }
  
  const id = crypto.randomUUID();
  const now = utcNow();
  await db.insert(schema.users).values({ id, name, username, password: await hashPassword(password, c.env), avatar: '', status: 'offline', createdAt: now});
  
  return c.json({ success: true, data: { id, name, username, avatar: '', status: 'offline', createdAt: now } });
});

app.put('/api/admin/users/:id', adminAuth, csrfProtection, async (c) => {
  const { name, username, password, status } = await c.req.json();
  const userId = c.req.param('id');
  const db = drizzle(c.env.DB);
  
  const updates: any = {};
  if (name) updates.name = name;
  if (username) updates.username = username;
  if (password) updates.password = await hashPassword(password, c.env);
  if (status) updates.status = status;
  
  if (Object.keys(updates).length > 0) {
    await db.update(schema.users).set(updates).where(eq(schema.users.id, userId));
  }
  
  return c.json({ success: true });
});

app.delete('/api/admin/users/:id', adminAuth, csrfProtection, async (c) => {
  const userId = c.req.param('id');
  const db = drizzle(c.env.DB);
  const adminId = c.get('adminId');
  
  // 防止删除自己
  if (userId === adminId) {
    return c.json({ success: false, message: '不能删除自己的账号' }, 400);
  }
  
  // 先删除用户发送的消息（同时会通过外键级联删除附件）
  await db.delete(schema.messages).where(eq(schema.messages.senderId, userId));
  
  // 删除其他用户相关数据
  await db.delete(schema.session_participants).where(eq(schema.session_participants.userId, userId));
  await db.delete(schema.message_reads).where(eq(schema.message_reads.userId, userId));
  await db.delete(schema.notifications).where(eq(schema.notifications.userId, userId));
  await db.delete(schema.userBans).where(eq(schema.userBans.userId, userId));
  await db.delete(schema.groupMutes).where(eq(schema.groupMutes.userId, userId));
  await db.delete(schema.userSettings).where(eq(schema.userSettings.userId, userId));
  await db.delete(schema.drive_files).where(eq(schema.drive_files.ownerId, userId));
  await db.delete(schema.group_join_requests).where(eq(schema.group_join_requests.userId, userId));
  await db.delete(schema.message_reactions).where(eq(schema.message_reactions.userId, userId));
  await db.delete(schema.message_reports).where(eq(schema.message_reports.reporterId, userId));
  
  // 最后删除用户
  await db.delete(schema.users).where(eq(schema.users.id, userId));
  
  return c.json({ success: true });
});

// 批量创建用户
app.post('/api/admin/users/batch-create', adminAuth, csrfProtection, async (c) => {
  try {
    const { users } = await c.req.json();
    const db = drizzle(c.env.DB);
    const userList = typeof users === 'string' ? JSON.parse(users) : users;
    let created = 0;
    let failed = 0;
    
    for (const u of userList) {
      const username = u.username?.trim();
      const password = u.password?.trim();
      const name = u.name?.trim() || username;
      // disk 字段直接按字节计算，默认 5GB = 5368709120 字节
      const disk = u.disk || 5368709120;
      
      if (!username || !password) { failed++; continue; }
      
      const hashedPassword = await hashPassword(password, c.env);
      const userId = crypto.randomUUID();
      
      try {
        await db.insert(schema.users).values({
          id: userId,
          name: name,
          username: username,
          password: hashedPassword,
          disk: disk,
          createdAt: utcNow()
        });
        created++;
      } catch (e) { 
        console.error('创建用户失败:', e);
        failed++; 
      }
    }
    
    return c.json({ success: true, message: `成功创建 ${created} 个用户，失败 ${failed} 个` });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// 批量创建群组
app.post('/api/admin/groups/batch-create', adminAuth, csrfProtection, async (c) => {
  try {
    const { groups } = await c.req.json();
    const db = drizzle(c.env.DB);
    const groupList = typeof groups === 'string' ? JSON.parse(groups) : groups;
    let created = 0;
    let failed = 0;
    
    
    
    for (const g of groupList) {
      const name = g.name;
      const announcement = g.announcement || '';
      
      
      
      if (!name) { failed++; continue; }
      
      try {
        const existingGroup = await db.select().from(schema.sessions).where(and(eq(schema.sessions.name, name), eq(schema.sessions.type, 'group'))).get();
        if (existingGroup) { 
          
          failed++; continue; 
        }
        
        const groupId = crypto.randomUUID();
        
        await db.insert(schema.sessions).values({
          id: groupId,
          type: 'group',
          name: name,
          announcement: announcement,
          ownerIds: '[]',
          lastMessage: '',
          lastTime: utcNow(),
          createdAt: utcNow()
        });
        created++;
      } catch (e) { 
        console.error('[batch-create-groups] 创建群组失败:', e);
        failed++; 
      }
    }
    
    return c.json({ success: true, message: `成功创建 ${created} 个群组，失败 ${failed} 个` });
  } catch (e) {
    console.error('[batch-create-groups] 错误:', e);
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// 批量创建会话
app.post('/api/admin/sessions/batch-create', adminAuth, csrfProtection, async (c) => {
  try {
    const { sessions } = await c.req.json();
    const db = drizzle(c.env.DB);
    const sessionList = typeof sessions === 'string' ? JSON.parse(sessions) : sessions;
    let created = 0;
    let failed = 0;
    
    for (const sess of sessionList) {
      const type = sess.type;
      
      try {
        if (type === 'friend') {
          const users = sess.users || [];
          const selfUsername = sess.self;
          
          if (!selfUsername || users.length === 0) { failed++; continue; }
          
          let selfUser = await db.select().from(schema.users).where(eq(schema.users.username, selfUsername)).get();
          if (!selfUser) selfUser = await db.select().from(schema.users).where(eq(schema.users.name, selfUsername)).get();
          
          if (!selfUser) { failed++; continue; }
          
          for (const friendUsername of users) {
            let friendUser = await db.select().from(schema.users).where(eq(schema.users.username, friendUsername)).get();
            if (!friendUser) friendUser = await db.select().from(schema.users).where(eq(schema.users.name, friendUsername)).get();
            
            if (friendUser && friendUser.id !== selfUser.id) {
              const sessionId = crypto.randomUUID();
              await db.insert(schema.sessions).values({
                id: sessionId,
                type: 'friend',
                createdAt: utcNow()
              });
              await db.insert(schema.session_participants).values([
                { sessionId: sessionId, userId: selfUser.id },
                { sessionId: sessionId, userId: friendUser.id }
              ]);
              created++;
            }
          }
        } else if (type === 'group') {
          const name = sess.name?.trim();
          const users = sess.users || [];
          const owners = sess.owner || [];
          
          if (!name) { failed++; continue; }
          
          let groupId: string;
          let ownerIdsStr = '[]';
          let sessionExists = false;
          
          const trimmedName = name.trim();
          const existingGroup = await db.select().from(schema.sessions)
            .where(sql`${schema.sessions.type} = 'group' AND TRIM(${schema.sessions.name}) = ${trimmedName}`)
            .get();
          
          if (existingGroup) {
            groupId = existingGroup.id;
            ownerIdsStr = existingGroup.ownerIds || '[]';
            sessionExists = true;
          } else {
            const ownerIds: string[] = [];
            for (const ownerName of owners) {
              let ownerUser = await db.select().from(schema.users).where(eq(schema.users.username, ownerName.trim())).get();
              if (!ownerUser) ownerUser = await db.select().from(schema.users).where(eq(schema.users.name, ownerName.trim())).get();
              if (ownerUser) ownerIds.push(ownerUser.id);
            }
            ownerIdsStr = JSON.stringify(ownerIds);
            
            groupId = crypto.randomUUID();
          }
          
          if (!sessionExists) {
            await db.insert(schema.sessions).values({
              id: groupId,
              type: 'group',
              name: name,
              announcement: '',
              ownerIds: ownerIdsStr,
              lastMessage: '',
              createdAt: utcNow()
            });
          }
          
          for (const username of users) {
            let user = await db.select().from(schema.users).where(eq(schema.users.username, username.trim())).get();
            if (!user) user = await db.select().from(schema.users).where(eq(schema.users.name, username.trim())).get();
            if (user) {
              await db.insert(schema.session_participants).values({
                sessionId: groupId,
                userId: user.id
              }).onConflictDoNothing();
            }
          }
          created++;
        } else {
          failed++;
        }
      } catch (e) { 
        console.error('创建会话失败:', e);
        failed++; 
      }
    }
    
    return c.json({ success: true, message: `成功创建 ${created} 个会话，失败 ${failed} 个` });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// 批量删除用户
app.post('/api/admin/users/batch-delete', adminAuth, csrfProtection, async (c) => {
  try {
    const { ids } = await c.req.json();
    const db = drizzle(c.env.DB);
    const adminId = c.get('adminId');
    
    // 过滤掉当前管理员自己
    const filteredIds = ids.filter((id: string) => id !== adminId);
    
    if (filteredIds.length === 0) {
      return c.json({ success: false, message: '不能删除自己的账号' }, 400);
    }
    
    for (const userId of filteredIds) {
      await db.delete(schema.session_participants).where(eq(schema.session_participants.userId, userId));
      await db.delete(schema.messages).where(eq(schema.messages.senderId, userId));
      await db.delete(schema.users).where(eq(schema.users.id, userId));
    }
    
    return c.json({ success: true, message: `已删除 ${filteredIds.length} 个用户` });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// 删除用户消息（管理员）
app.delete('/api/admin/messages/:id', adminAuth, async (c) => {
  try {
    const messageId = c.req.param('id');
    const db = drizzle(c.env.DB);
    
    // 真正删除消息
    await db.delete(schema.messages)
      .where(eq(schema.messages.id, messageId));
    
    return c.json({ success: true, message: '消息已删除' });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 400);
  }
});

// 获取用户发送的消息
app.get('/api/admin/users/:id/messages', adminAuth, async (c) => {
  try {
    const userId = c.req.param('id');
    const { page = '1', limit = '50' } = c.req.query();
    const db = drizzle(c.env.DB);
    
    const messages = await db.select()
      .from(schema.messages)
      .where(eq(schema.messages.senderId, userId))
      .orderBy(desc(schema.messages.time))
      .limit(parseInt(limit))
      .offset((parseInt(page) - 1) * parseInt(limit))
      .all();
    
    const total = await db.select({ count: sql<number>`count(*)` })
      .from(schema.messages)
      .where(eq(schema.messages.senderId, userId))
      .get();
    
    // 获取会话名称
    const sessionIds = [...new Set(messages.map(m => m.sessionId))];
    const sessions: Record<string, any> = {};
    for (const sid of sessionIds) {
      const session = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sid)).get();
      if (session) {
        const participants = await db.select().from(schema.session_participants).where(eq(schema.session_participants.sessionId, sid)).all();
        const participantIds = participants.map(p => p.userId);
        const otherUserId = participantIds.find(id => id !== userId);
        let otherUser = null;
        if (otherUserId) {
          otherUser = await db.select().from(schema.users).where(eq(schema.users.id, otherUserId)).get();
        }
        sessions[sid] = {
          id: session.id,
          type: session.type,
          name: session.type === 'group' ? session.name : (otherUser?.name || '未知')
        };
      }
    }
    
    const formattedMessages = messages.map((m) => ({
      ...m,
      sessionName: sessions[m.sessionId]?.name || '未知会话',
      sessionType: sessions[m.sessionId]?.type || 'unknown'
    }));
    
    return c.json({ success: true, data: { list: formattedMessages, total: total?.count || 0 } });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

app.get('/api/admin/groups', adminAuth, async (c) => {
  try {
    const { page = '1', limit = '20' } = c.req.query();
    const db = drizzle(c.env.DB);
    
    const groups = await db.select().from(schema.sessions).where(eq(schema.sessions.type, 'group')).limit(parseInt(limit)).offset((parseInt(page) - 1) * parseInt(limit)).all();
    const total = await db.select({ count: sql<number>`count(*)` }).from(schema.sessions).where(eq(schema.sessions.type, 'group')).get();
    
    const groupList = await Promise.all(groups.map(async (g) => {
      const members = await db.select().from(schema.users).innerJoin(schema.session_participants, eq(schema.users.id, schema.session_participants.userId)).where(eq(schema.session_participants.sessionId, g.id)).all();
      return { id: g.id, type: g.type, name: g.name, announcement: g.announcement, ownerIds: g.ownerIds ? JSON.parse(g.ownerIds) : [], lastMessage: g.lastMessage, lastTime: g.lastTime, isPinned: g.isPinned, isMuted: g.isMuted, created_at: g.createdAt, members: members.map(m => m.users), memberCount: members.length };
    }));
    
    return c.json({ success: true, data: { list: groupList, total: total?.count || 0 } });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

app.post('/api/admin/groups', adminAuth, csrfProtection, async (c) => {
  try {
    const { name, announcement, memberIds } = await c.req.json();
    const db = drizzle(c.env.DB);
    
    if (!name) {
      return c.json({ success: false, message: '群名称不能为空' }, 400);
    }
    
    const groupId = crypto.randomUUID();
    const now = utcNow();
    await db.insert(schema.sessions).values({ id: groupId, type: 'group', name, announcement: announcement || '', ownerIds: '[]', lastMessage: '', createdAt: now });
    
    const allMemberIds = [...(memberIds || [])];
    
    if (memberIds && memberIds.length > 0) {
      for (const userId of memberIds) {
        await db.insert(schema.session_participants).values({ sessionId: groupId, userId }).onConflictDoNothing();
      }
    }
    
    // 广播会话列表更新给所有群成员
    try {
      const chatId = c.env.CHAT.idFromName('global');
      const chatStub = c.env.CHAT.get(chatId);
      for (const userId of allMemberIds) {
        await chatStub.fetch('https://broadcast', {
          method: 'POST',
          body: JSON.stringify({
            type: 'conversationsUpdate',
            data: { userId }
          })
        });
      }
    } catch (e) {
      console.error('Broadcast error:', e);
    }
    
    return c.json({ success: true, data: { id: groupId, name, type: 'group' } });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

app.put('/api/admin/groups/:id', adminAuth, csrfProtection, async (c) => {
  const groupId = c.req.param('id');
  const { name, announcement } = await c.req.json();
  const db = drizzle(c.env.DB);
  
  const updates: any = {};
  if (name) updates.name = name;
  if (announcement !== undefined) updates.announcement = announcement;
  
  if (Object.keys(updates).length > 0) {
    await db.update(schema.sessions).set(updates).where(eq(schema.sessions.id, groupId));
  }
  
  return c.json({ success: true });
});

// ==================== 文件访问（支持 Range 请求） ====================
app.get('/api/files/:key', async (c) => {
    const key = c.req.param('key');
    const rangeHeader = c.req.header('range');
    const db = drizzle(c.env.DB);
    await fileManager.initAsync(db, c.env.R2, c.env.UPLOADS);

    try {
        const fileData = await fileManager.downloadFromStorage(key);
        const fileSize = fileData.length;
        
        // 只处理图片类型的 Content-Type
        const ext = key.split('.').pop()?.toLowerCase();
        let contentType = 'application/octet-stream';
        if (ext === 'jpg' || ext === 'jpeg') contentType = 'image/jpeg';
        else if (ext === 'png') contentType = 'image/png';
        else if (ext === 'gif') contentType = 'image/gif';
        else if (ext === 'webp') contentType = 'image/webp';
        else if (ext === 'svg') contentType = 'image/svg+xml';

        // 支持 Range 请求
        if (rangeHeader) {
            const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
            if (match) {
                const start = parseInt(match[1], 10);
                const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
                const chunkSize = end - start + 1;
                const chunk = fileData.slice(start, end + 1);
                
                return new Response(chunk, {
                    status: 206,
                    headers: {
                        'Content-Type': contentType,
                        'Content-Length': String(chunkSize),
                        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                        'Cache-Control': 'public, max-age=31536000',
                        ...getCorsHeaders(c.env, c.req.raw)
                    }
                });
            }
        }

        return new Response(fileData, {
            headers: {
              'Content-Type': contentType,
              'Content-Length': String(fileSize),
              'Cache-Control': 'public, max-age=31536000',
              ...getCorsHeaders(c.env, c.req.raw)
            }
        });
    } catch (e) {
        console.error('下载附件失败:', e);
        return c.json({ success: false, message: '下载失败' }, 500);
    }
});

// ==================== 文件上传 ====================
app.post('/api/upload', auth, async (c) => {
  // 文件上传限流
  const rateLimitKey = `upload:${c.get('userId')}`;
  const { allowed: uploadAllowed, remaining: uploadRemaining, resetIn: uploadResetIn } = await checkRateLimit(rateLimitKey, RATE_LIMITS.UPLOAD);
  if (!uploadAllowed) {
    return c.json({ success: false, message: '上传过于频繁，请稍后再试' }, 429, createRateLimitHeaders(uploadRemaining, uploadResetIn));
  }
  
  const formData = await c.req.formData();
  const file = formData.get('file') as File;
  const encrypted = formData.get('encrypted') === 'true';
  const encryptedName = formData.get('name') as string;
  const fileType = formData.get('fileType') as string;
  // console.log('[DEBUG] fileType from formData:', fileType, 'file.type:', file.type);
  let fileUrl: string;
  
  // 如果前端传递了 fileType（'image' 或 'image/jpeg'），优先使用；否则使用文件的实际类型
  const finalType = fileType || file.type;
  // 判断是否为图片：直接是 'image' 或以 'image/' 开头
  const isImage = finalType === 'image' || finalType.startsWith('image/');
  // console.log('[DEBUG] isImage:', isImage, 'finalType:', finalType);
  
  fileUrl = await upload(c, file, encrypted, encryptedName);
 
  if (!fileUrl) return c.json({success: false, message: "文件上传失败"}, 500);
  
  return c.json({
    success: true,
    data: {
      url: fileUrl,
      name: encrypted && encryptedName ? encryptedName : file.name,
      size: file.size,
      type: isImage ? 'image' : 'file',
      encrypted
    }
  });
});

app.post('/api/upload/chunk', auth, async (c) => {
  const rateLimitKey = `upload:${c.get('userId')}`;
  const { allowed, remaining, resetIn } = await checkRateLimit(rateLimitKey, RATE_LIMITS.UPLOAD);
  if (!allowed) {
    return c.json({ success: false, message: '上传过于频繁，请稍后再试' }, 429, createRateLimitHeaders(remaining, resetIn));
  }

  const formData = await c.req.formData();
  const chunk = formData.get('chunk') as File;
  const chunkIndex = parseInt(formData.get('chunkIndex') as string) || 0;
  const totalChunks = parseInt(formData.get('totalChunks') as string) || 1;
  const filename = formData.get('filename') as string || 'unknown';
  const encryptedName = formData.get('name') as string || filename;
  const resumeId = formData.get('resumeId') as string;
  const encrypted = formData.get('encrypted') === 'true';

  const userId = c.get('userId');
  const uploadId = resumeId;

  if (!uploadId) {
    return c.json({ success: false, message: '缺少上传ID' }, 400);
  }

  const db = drizzle(c.env.DB);
  await fileManager.initAsync(db, c.env.R2, c.env.UPLOADS);

  // 从 KV 获取分片状态
  let chunkState = await fileManager.getChunkState(uploadId);
  
  if (!chunkState) {
    return c.json({ success: false, message: '上传会话不存在，请重新初始化' }, 400);
  }

  // 检查分片是否已上传（使用单独的 KV key 避免并发覆盖问题）
  const chunkKey = `chunks/${uploadId}/${chunkIndex}`;
  const alreadyUploaded = await fileManager.isChunkUploaded(uploadId, chunkIndex);
  const uploadedChunks = await fileManager.getUploadedChunks(uploadId, totalChunks);
  
  if (alreadyUploaded) {
    return c.json({
      success: true,
      data: {
        resumeId: uploadId,
        uploadedChunks,
        totalChunks,
        skipped: true
      }
    });
  }

  // 读取分片数据
  const chunkBuffer = await chunk.arrayBuffer();
  const chunkData = new Uint8Array(chunkBuffer);

  // 直接上传分片到 R2（不经过 prefix）
  const { etag } = await fileManager.uploadChunkDirect(chunkKey, chunkData);

  // 使用单独的 KV key 标记分片完成（解决并发覆盖问题）
  const isNew = await fileManager.markChunkUploaded(uploadId, chunkIndex, etag);
  
  // 同时更新 chunkState（用于初始化时返回已上传列表）
  if (isNew && !chunkState.uploadedChunks.includes(chunkIndex)) {
    chunkState.uploadedChunks.push(chunkIndex);
    chunkState.uploadedChunks.sort((a, b) => a - b);
    await fileManager.saveChunkState(uploadId, chunkState);
  }
  
  // 检查所有分片是否已上传
  const allUploadedChunks = await fileManager.getUploadedChunks(uploadId, totalChunks);
  
  // console.log('[DEBUG] chunkIndex:', chunkIndex, 'totalChunks:', totalChunks, 'allUploadedChunks:', allUploadedChunks, 'length:', allUploadedChunks.length, 'isNew:', isNew);
  
  // 如果所有分片都已上传，合并文件（检查状态防止重复合并）
  if (allUploadedChunks.length === totalChunks && chunkState.status !== 'completed') {
    // console.log('[DEBUG] 触发合并！allUploadedChunks.length:', allUploadedChunks.length, 'totalChunks:', totalChunks);
    
    // 标记为合并中，防止其他请求重复合并
    chunkState.status = 'merging';
    await fileManager.saveChunkState(uploadId, chunkState);
    
    try {
      // 读取所有分片并合并
      const sortedChunks: Uint8Array[] = [];
      for (let i = 0; i < totalChunks; i++) {
        const tempKey = `chunks/${uploadId}/${i}`;
        const result = await fileManager.downloadChunkDirect(tempKey);
        if (!result) {
          throw new Error(`Missing chunk ${i}`);
        }
        sortedChunks.push(result.data);
      }

      // 合并分片
      const totalSize = sortedChunks.reduce((acc, c) => acc + c.length, 0);
      // console.log('[DEBUG] 合并后 totalSize:', totalSize, 'chunks count:', sortedChunks.length);
      const combined = new Uint8Array(totalSize);
      let offset = 0;
      for (const c of sortedChunks) {
        combined.set(c, offset);
        offset += c.length;
      }

      // 上传合并后的文件到最终位置
      const finalKey = chunkState.key;
      await fileManager.uploadToStorage(finalKey, combined, encrypted ? 'application/octet-stream' : 'application/octet-stream');

      // 清理临时分片
      for (let i = 0; i < totalChunks; i++) {
        const tempKey = `chunks/${uploadId}/${i}`;
        await fileManager.deleteChunkDirect(tempKey).catch(() => {});
      }
      
      // 清理 KV 状态
      await fileManager.deleteChunkState(uploadId);

      // 如果有 sessionId，说明是群附件，保存到数据库
      const sessionId = chunkState.metadata.sessionId;
      if (sessionId) {
        const db = drizzle(c.env.DB);
        const userId = c.get('userId');
        const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
        
        const finalName = chunkState.metadata.encryptedName || chunkState.metadata.filename;
        const id = crypto.randomUUID();
        const timestamp = utcNow();
        
        await db.insert(schema.group_attachments).values({
          id,
          sessionId,
          name: finalName,
          size: totalSize,
          url: finalKey,
          uploadedBy: user?.id || userId,
          uploadedByName: user?.name || '',
          createdAt: timestamp
        });
        
        // console.log('[DEBUG] 群附件保存成功, sessionId:', sessionId, 'id:', id);
        
        return c.json({
          success: true,
          data: {
            id,
            url: finalKey,
            name: finalName,
            size: totalSize,
            type: 'file',
            encrypted: chunkState.metadata.encrypted,
            isGroupAttachment: true
          }
        });
      }

      // 返回结果（返回加密后的文件名，用于数据库存储）
      // console.log('[DEBUG] 合并成功，准备返回响应:', { url: finalKey, name: chunkState.metadata.encryptedName, size: totalSize });
      return c.json({
        success: true,
        data: {
          url: finalKey,
          name: chunkState.metadata.encryptedName,
          size: totalSize,
          type: 'file',
          encrypted: chunkState.metadata.encrypted
        }
      });
    } catch (e: any) {
      // console.log('[DEBUG] 合并失败:', e.message, e.stack);
      
      // 合并失败时清理已上传的分片和KV状态
      try {
        for (let i = 0; i < totalChunks; i++) {
          const tempKey = `chunks/${uploadId}/${i}`;
          await fileManager.deleteChunkDirect(tempKey).catch(() => {});
        }
        await fileManager.deleteChunkState(uploadId);
      } catch (cleanupError) {
        console.error('清理失败的分片时出错:', cleanupError);
      }
      
      return c.json({ success: false, message: '文件合并失败: ' + e.message }, 500);
    }
  }
   
  // 使用 getUploadedChunks 获取准确的已上传分片列表
  const finalUploadedChunks = await fileManager.getUploadedChunks(uploadId, totalChunks);
   
  return c.json({
    success: true,
    data: {
      resumeId: uploadId,
      uploadedChunks: finalUploadedChunks,
      totalChunks
    }
  });
});

// ==================== 分片上传初始化 ====================
app.post('/api/upload/chunk/init', auth, async (c) => {
  try {
    const { filename, totalChunks, encrypted, fileSize, encryptedName, sessionId } = await c.req.json();
    
    const userId = c.get('userId');

    const db = drizzle(c.env.DB);
    await fileManager.initAsync(db, c.env.R2, c.env.UPLOADS);

    // 获取存储类型
    const storageType = fileManager.getStorageType();

    // KV 存储限制 25MB
    if (storageType === 'kv' && fileSize > 25 * 1024 * 1024) {
      return c.json({ success: false, message: 'KV 存储不支持超过 25MB 的文件' }, 400);
    }

    // 生成最终文件 key（加密文件使用 encryptedName，否则使用原始 filename）
    const finalFilename = encrypted && encryptedName ? encryptedName : filename;
    const key = `${utcNow()}-${crypto.randomUUID()}-${finalFilename}`;

    // R2 使用分片上传，其他存储使用普通上传
    if (storageType === 'r2') {
      // 生成 uploadId（基于文件名和用户，避免重复）
      const uploadId = `${userId}-${crypto.randomUUID()}`;

      // 检查是否已有上传中的分片（用于断点续传）
      const existingUploadedChunks = await fileManager.getUploadedChunks(uploadId, totalChunks);
      
      // 在 KV 中保存分片状态
      // encryptedName 保存加密后的文件名（用于数据库存储）
      // sessionId 用于群附件保存
      const chunkState = {
        key,
        metadata: {
          filename,
          encryptedName: encryptedName || filename,
          totalChunks,
          userId,
          createdAt: Date.now(),
          encrypted: encrypted || false,
          sessionId: sessionId || null  // 群附件需要
        },
        parts: [],
        uploadedChunks: existingUploadedChunks,
        status: 'uploading' as const
      };
      
      await fileManager.saveChunkState(uploadId, chunkState);

      return c.json({
        success: true,
        data: {
          uploadId,
          chunkSize: 5 * 1024 * 1024,
          totalChunks,
          key,
          storageType: 'r2',
          useChunkedUpload: true,
          uploadedChunks: []
        }
      });
    } else {
      // pCloud/Google 使用普通上传
      
      return c.json({
        success: true,
        data: {
          key,
          storageType,
          useChunkedUpload: false
        }
      });
    }
  } catch (e: any) {
    return c.json({ success: false, message: e.message }, 500);
  }
});

// ==================== 文件删除（阅后即焚） ====================
app.post('/api/upload/delete', auth, csrfProtection, async (c) => {
  const { url, messageId, sessionId } = await c.req.json();
  const key = url?.split('/').pop();
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  await fileManager.initAsync(db, c.env.R2, c.env.UPLOADS);

  if (key) {
    await fileManager.deleteFromStorage(key);
  }
  
  // 如果有消息ID，先获取消息信息，然后删除
  if (messageId) {
    // 先获取消息信息用于通知
    const msg = await db.select()
      .from(schema.messages)
      .where(eq(schema.messages.id, messageId))
      .get();
    
    if (msg) {
      const viewer = await db.select()
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .get();
      
      // 删除附件记录
      await db.delete(schema.attachments)
        .where(eq(schema.attachments.messageId, messageId));
      
      // 删除消息记录
      await db.delete(schema.messages)
        .where(eq(schema.messages.id, messageId));
      
      // 发送阅后即焚通知给消息发送者
      const burnAfterReadData = {
        type: 'burnAfterRead',
        data: {
          messageId,
          sessionId: msg.sessionId,
          originalSenderId: msg.senderId,
          viewerId: userId,
          viewerName: viewer?.name || '对方'
        }
      };
      
      try {
        const chatId = c.env.CHAT.idFromName('global');
        const chatStub = c.env.CHAT.get(chatId);
        
        const notifyRequest = new Request('https://dummy/notifySender', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetUserId: msg.senderId,
            message: burnAfterReadData
          })
        });
        
        await chatStub.fetch(notifyRequest);
      } catch (e) {
        console.error('burnAfterRead notification error:', e);
      }
    }
  }
  
  return c.json({ success: true });
});

app.delete('/api/admin/groups/:id', adminAuth, csrfProtection, async (c) => {
  try {
    const groupId = c.req.param('id');
    const db = drizzle(c.env.DB);
    
    await db.delete(schema.message_reads).where(sql`message_id IN (SELECT id FROM messages WHERE session_id = ${groupId})`);
    await db.delete(schema.attachments).where(sql`message_id IN (SELECT id FROM messages WHERE session_id = ${groupId})`);
    await db.delete(schema.messages).where(eq(schema.messages.sessionId, groupId));
    await db.delete(schema.session_participants).where(eq(schema.session_participants.sessionId, groupId));
    await db.delete(schema.sessions).where(eq(schema.sessions.id, groupId));
    
    return c.json({ success: true });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// 批量删除群组
app.post('/api/admin/groups/batch-delete', adminAuth, csrfProtection, async (c) => {
  try {
    const { ids } = await c.req.json();
    const db = drizzle(c.env.DB);
    
    // 并行删除所有群组的关联数据
    await Promise.all(ids.flatMap(groupId => [
      db.delete(schema.message_reads).where(sql`message_id IN (SELECT id FROM messages WHERE session_id = ${groupId})`),
      db.delete(schema.attachments).where(sql`message_id IN (SELECT id FROM messages WHERE session_id = ${groupId})`),
      db.delete(schema.messages).where(eq(schema.messages.sessionId, groupId)),
      db.delete(schema.session_participants).where(eq(schema.session_participants.sessionId, groupId)),
      db.delete(schema.sessions).where(eq(schema.sessions.id, groupId))
    ]));
    
    return c.json({ success: true, message: `已删除 ${ids.length} 个群组` });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

app.get('/api/admin/stats', adminAuth, async (c) => {
  const db = drizzle(c.env.DB);
  
  const userCount = await db.select({ count: sql<number>`count(*)` }).from(schema.users).get();
  const groupCount = await db.select({ count: sql<number>`count(*)` }).from(schema.sessions).where(eq(schema.sessions.type, 'group')).get();
  const messageCount = await db.select({ count: sql<number>`count(*)` }).from(schema.messages).get();
  const sessionCount = await db.select({ count: sql<number>`count(*)` }).from(schema.sessions).get();
  
  const driveFileCount = await db.select({ count: sql<number>`count(*)` }).from(schema.drive_files).where(eq(schema.drive_files.isDeleted, 0)).get();
  const driveFolderCount = await db.select({ count: sql<number>`count(*)` }).from(schema.drive_files).where(and(eq(schema.drive_files.type, 'folder'), eq(schema.drive_files.isDeleted, 0))).get();
  const driveSize = await db.select({ total: sql<number>`COALESCE(SUM(size), 0)` }).from(schema.drive_files).where(eq(schema.drive_files.isDeleted, 0)).get();
  const driveTrashedCount = await db.select({ count: sql<number>`count(*)` }).from(schema.drive_files).where(eq(schema.drive_files.isDeleted, 1)).get();
  
  return c.json({ 
    success: true, 
    data: { 
      users: userCount?.count || 0, 
      groups: groupCount?.count || 0, 
      messages: messageCount?.count || 0, 
      sessions: sessionCount?.count || 0,
      drive: {
        files: driveFileCount?.count || 0,
        folders: driveFolderCount?.count || 0,
        totalSize: driveSize?.total || 0,
        trashed: driveTrashedCount?.count || 0
      }
    }
  });
});

// ==================== 举报管理 ====================
// 获取举报列表
app.get('/api/admin/reports', adminAuth, async (c) => {
  const db = drizzle(c.env.DB);
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '20');
  const status = c.req.query('status');
  const offset = (page - 1) * limit;
  
  let conditions = [];
  if (status && status !== 'all') {
    conditions.push(eq(schema.message_reports.status, status));
  }
  
  const reports = await db.select()
    .from(schema.message_reports)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(sql`${schema.message_reports.createdAt} DESC`)
    .limit(limit)
    .offset(offset)
    .all();
  
  // 获取消息详情
  const reportsWithDetails = await Promise.all(reports.map(async (report) => {
    const msg = await db.select()
      .from(schema.messages)
      .where(eq(schema.messages.id, report.messageId))
      .get();
    return { ...report, message: msg };
  }));
  
  const totalCount = await db.select({ count: sql<number>`count(*)` })
    .from(schema.message_reports)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .get();
  
  return c.json({ success: true, data: reportsWithDetails, total: totalCount?.count || 0 });
});

// 处理举报
app.post('/api/admin/reports/:id/handle', adminAuth, csrfProtection, async (c) => {
  const reportId = c.req.param('id');
  const { action } = await c.req.json();
  const db = drizzle(c.env.DB);
  const adminId = c.get('userId');
  
  const report = await db.select()
    .from(schema.message_reports)
    .where(eq(schema.message_reports.id, reportId))
    .get();
  
  if (!report) {
    return c.json({ success: false, message: '举报不存在' }, 404);
  }
  
  let message = '处理成功';
  
  // 根据操作类型处理
  if (action === 'dismiss') {
    // 驳回举报
    await db.update(schema.message_reports)
      .set({
        status: 'dismissed',
        reviewedBy: adminId,
        reviewedAt: utcNow()
      })
      .where(eq(schema.message_reports.id, reportId));
    message = '已驳回该举报';
    
  } else if (action === 'delete_message') {
    // 删除被举报的消息
    const msg = await db.select()
      .from(schema.messages)
      .where(eq(schema.messages.id, report.messageId))
      .get();
    
    if (msg) {
      await db.update(schema.messages)
        .set({
          content: '该消息因违规已被删除',
          isSystem: 1,
          isDeleted: 1,
          encrypted: 0
        })
        .where(eq(schema.messages.id, report.messageId));
    }
    
    await db.update(schema.message_reports)
      .set({
        status: 'message_deleted',
        reviewedBy: adminId,
        reviewedAt: utcNow()
      })
      .where(eq(schema.message_reports.id, reportId));
    message = '已删除该消息';
    
  } else if (action === 'ban_user') {
    // 封禁用户
    const userId = report.reportedUserId;
    
    // 检查是否已经封禁
    const existingBan = await db.select()
      .from(schema.userBans)
      .where(eq(schema.userBans.userId, userId))
      .get();
    
    if (!existingBan) {
      // 添加封禁记录
      await db.insert(schema.userBans).values({
        id: crypto.randomUUID(),
        userId,
        reason: `因消息违规被举报：${report.reason}`,
        bannedBy: adminId,
        createdAt: utcNow()
      });
      
      // 更新用户状态为已封禁
      await db.update(schema.users)
        .set({ status: 'banned' })
        .where(eq(schema.users.id, userId));
      
      // 通知用户被封禁
      try {
        const chatId = c.env.CHAT.idFromName('global');
        const chatStub = c.env.CHAT.get(chatId);
        await chatStub.fetch('https://dummy/broadcast', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'forceLogout',
            data: { userId, reason: `因消息违规被举报：${report.reason}`, message: '您的账号因违规已被封禁' }
          })
        });
      } catch (e) {}
    }
    
    await db.update(schema.message_reports)
      .set({
        status: 'user_banned',
        reviewedBy: adminId,
        reviewedAt: utcNow()
      })
      .where(eq(schema.message_reports.id, reportId));
    message = '已封禁该用户';
  }
  
  return c.json({ success: true, message });
});

// 删除举报
app.delete('/api/admin/reports/:id', adminAuth, csrfProtection, async (c) => {
  const reportId = c.req.param('id');
  const db = drizzle(c.env.DB);
  
  await db.delete(schema.message_reports)
    .where(eq(schema.message_reports.id, reportId));
  
  return c.json({ success: true, message: '删除成功' });
});

// 批量删除举报
app.post('/api/admin/reports/batch-delete', adminAuth, csrfProtection, async (c) => {
  const { ids } = await c.req.json();
  const db = drizzle(c.env.DB);
  
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return c.json({ success: false, message: '请选择要删除的举报' }, 400);
  }
  
  for (const id of ids) {
    await db.delete(schema.message_reports)
      .where(eq(schema.message_reports.id, id));
  }
  
  return c.json({ success: true, message: `已删除 ${ids.length} 条举报` });
});

app.get('/api/admin/disk', adminAuth, async (c) => {
  const db = drizzle(c.env.DB);
  
  const uploadCount = await db.select({ count: sql<number>`count(*)` }).from(schema.attachments).get();
  
  const uploadsSize = await db.select({ total: sql<number>`COALESCE(SUM(size), 0)` }).from(schema.attachments).get();
  
  const messageCount = await db.select({ count: sql<number>`count(*)` }).from(schema.messages).get();
  
  return c.json({ 
    success: true, 
    data: { 
      uploads: uploadCount?.count || 0,
      database: messageCount?.count || 0,
      total: uploadsSize?.total || 0
    } 
  });
});

// ==================== 网盘设置管理 ====================

// 获取网盘设置
app.get('/api/admin/drive/settings', adminAuth, async (c) => {
  try {
    const db = drizzle(c.env.DB);
    
    // 从数据库获取设置
    const rows = await db.select({ key: schema.system_settings.key, value: schema.system_settings.value })
      .from(schema.system_settings)
      .all();
    
    const settingsMap: Record<string, string> = {};
    for (const row of rows) {
      try {
        settingsMap[row.key] = JSON.parse(row.value);
      } catch {
        settingsMap[row.key] = row.value;
      }
    }
    
    const settings = {
      storageType: settingsMap.storageType || 'r2',
      chatStorageType: settingsMap.chatStorageType || 'r2',
      r2: settingsMap.r2 || { bucket: '' },
      kv: settingsMap.kv || { namespace: '' },
      pcloud: settingsMap.pcloud || { enabled: false, token: '', folderId: '' },
      google: settingsMap.google || { enabled: false, token: '', folderId: '' }
    };
    
    // 获取R2存储使用情况
    let r2Usage = { used: 0, objects: 0 };
    try {
      const countRes = await c.env.DB.prepare('SELECT COUNT(*) as count FROM drive_files WHERE is_deleted = 0').get() as any;
      r2Usage = { used: 0, objects: countRes?.count || 0 };
    } catch (e) {}
    
    return c.json({
      success: true,
      data: { ...settings, r2Usage }
    });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// 保存网盘设置
app.post('/api/admin/drive/settings', adminAuth, csrfProtection, async (c) => {
  try {
    const settings = await c.req.json();
    const db = drizzle(c.env.DB);
    
    // 保存每个设置到数据库
    for (const [key, value] of Object.entries(settings)) {
      if (key !== 'r2Usage') {
        const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
        await db.insert(schema.system_settings)
          .values({ key, value: valueStr })
          .onConflictDoUpdate({ target: schema.system_settings.key, set: { value: valueStr } });
      }
    }
    
    // 如果是第三方网盘，自动初始化目录结构
    let initMessage = '';
    if (settings.storageType === 'pcloud' && settings.pcloud?.token) {
      const pcloudSettings = settings.pcloud;
      const { PCloudStorage } = await import('./storage/pcloud');
      const pcloud = new PCloudStorage({
        token: pcloudSettings.token,
        folderId: pcloudSettings.folderId || '0'
      });
      
      // 创建目录结构
      const folderIds: any = {};
      const rootFolderId = pcloudSettings.folderId || '0';
      
      try {
        // chat/files
        folderIds.chatFilesFolderId = await pcloud.createFolder('chat', rootFolderId);
        folderIds.chatFilesFolderId = await pcloud.createFolder('files', folderIds.chatFilesFolderId);
        
        // chat/avatar
        folderIds.chatAvatarFolderId = await pcloud.createFolder('chat', rootFolderId);
        folderIds.chatAvatarFolderId = await pcloud.createFolder('avatar', folderIds.chatAvatarFolderId);
        
        // chat/backup
        folderIds.chatBackupFolderId = await pcloud.createFolder('chat', rootFolderId);
        folderIds.chatBackupFolderId = await pcloud.createFolder('backup', folderIds.chatBackupFolderId);
        
        // drive/files
        const driveFolderId = await pcloud.createFolder('drive', rootFolderId);
        folderIds.driveFilesFolderId = await pcloud.createFolder('files', driveFolderId);
        
        
        // drive/backup
        const driveBackupFolderId = await pcloud.createFolder('drive', rootFolderId);
        folderIds.driveBackupFolderId = await pcloud.createFolder('backup', driveBackupFolderId);
        
        // 保存文件夹ID到数据库
        await db.insert(schema.system_settings)
          .values({ key: 'pcloud_folder_ids', value: JSON.stringify(folderIds) })
          .onConflictDoUpdate({ target: schema.system_settings.key, set: { value: JSON.stringify(folderIds) } });
        
        
        initMessage = 'pCloud目录初始化成功';
      } catch (e: any) {
        console.error('[Drive] pCloud目录初始化失败:', e);
        initMessage = `pCloud目录初始化失败: ${e.message}`;
      }
    }
    
    if (settings.storageType === 'google' && settings.google?.token) {
      const googleSettings = settings.google;
      const { GoogleDriveStorage } = await import('./storage/googleDrive');
      const google = new GoogleDriveStorage({
        token: googleSettings.token,
        folderId: googleSettings.folderId || 'root'
      });
      
      // 创建目录结构
      const folderIds: any = {};
      const rootFolderId = googleSettings.folderId || 'root';
      
      try {
        // chat/files
        folderIds.chatFilesFolderId = await google.createFolder('chat', rootFolderId);
        folderIds.chatFilesFolderId = await google.createFolder('files', folderIds.chatFilesFolderId);
        
        // chat/avatar
        folderIds.chatAvatarFolderId = await google.createFolder('chat', rootFolderId);
        folderIds.chatAvatarFolderId = await google.createFolder('avatar', folderIds.chatAvatarFolderId);
        
        // chat/backup
        folderIds.chatBackupFolderId = await google.createFolder('chat', rootFolderId);
        folderIds.chatBackupFolderId = await google.createFolder('backup', folderIds.chatBackupFolderId);
        
        // drive/files
        folderIds.driveFilesFolderId = await google.createFolder('drive', rootFolderId);
        folderIds.driveFilesFolderId = await google.createFolder('files', folderIds.driveFilesFolderId);
        
        // drive/backup
        folderIds.driveBackupFolderId = await google.createFolder('drive', rootFolderId);
        folderIds.driveBackupFolderId = await google.createFolder('backup', folderIds.driveBackupFolderId);
        
        // 保存文件夹ID到数据库
        await db.insert(schema.system_settings)
          .values({ key: 'google_folder_ids', value: JSON.stringify(folderIds) })
          .onConflictDoUpdate({ target: schema.system_settings.key, set: { value: JSON.stringify(folderIds) } });
        
        
        initMessage = initMessage ? initMessage + '; Google Drive目录初始化成功' : 'Google Drive目录初始化成功';
      } catch (e: any) {
        console.error('[Drive] Google Drive目录初始化失败:', e);
        initMessage = initMessage ? initMessage + `; Google Drive目录初始化失败: ${e.message}` : `Google Drive目录初始化失败: ${e.message}`;
      }
    }
    
    const message = initMessage ? `设置已保存。${initMessage}` : '设置已保存';
    return c.json({ success: true, message });
  } catch (e) {
    console.error('保存网盘设置失败:', e);
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// 获取网盘文件统计
app.get('/api/admin/drive/stats', adminAuth, async (c) => {
  try {
    const db = drizzle(c.env.DB);
    
    const queryStorageType = c.req.query('storageType') as string | null;
    
    let storageType: string;
    let displayType: string;
    
    if (queryStorageType) {
      storageType = queryStorageType;
      displayType = queryStorageType;
    } else {
      const storageTypeRow = await db.select({ value: schema.system_settings.value })
        .from(schema.system_settings)
        .where(eq(schema.system_settings.key, 'storageType'))
        .get();
      storageType = storageTypeRow?.value || 'r2';
      displayType = storageType;
    }
    
    const totalFiles = await db.select({ count: sql<number>`COUNT(*)` }).from(schema.drive_files).where(and(eq(schema.drive_files.isDeleted, 0), eq(schema.drive_files.type, 'file'), sql`storage_type = ${storageType}`)).get();
    const totalFolders = await db.select({ count: sql<number>`COUNT(*)` }).from(schema.drive_files).where(and(eq(schema.drive_files.type as any, 'folder'), eq(schema.drive_files.isDeleted, 0), sql`storage_type = ${storageType}`)).get();
    const totalSize = await db.select({ total: sql<number>`COALESCE(SUM(size), 0)` }).from(schema.drive_files).where(and(eq(schema.drive_files.isDeleted, 0), sql`storage_type = ${storageType}`)).get();
    const trashedCount = await db.select({ count: sql<number>`COUNT(*)` }).from(schema.drive_files).where(and(eq(schema.drive_files.isDeleted, 1), sql`storage_type = ${storageType}`)).get();
    
    return c.json({
      success: true,
      data: {
        storageType: displayType,
        files: totalFiles?.count || 0,
        folders: totalFolders?.count || 0,
        trashed: trashedCount?.count || 0,
        totalSize: totalSize?.total || 0
      }
    });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// 获取所有用户的网盘存储空间使用情况
app.get('/api/admin/drive/users', adminAuth, async (c) => {
  try {
    const db = drizzle(c.env.DB);
    
    // 获取所有用户
    const users = await db.select({
      id: schema.users.id,
      name: schema.users.name,
      username: schema.users.username,
      disk: schema.users.disk
    }).from(schema.users).all();
    
    if (!users || users.length === 0) {
      return c.json({ success: true, data: [] });
    }
    
    const userStats = await Promise.all(users.map(async (user) => {
      let fileCount = 0;
      let totalSize = 0;
      
      try {
        const result = await db.select({ 
          count: sql<number>`COUNT(*)`, 
          totalSize: sql<number>`COALESCE(SUM(size), 0)` 
        }).from(schema.drive_files).where(eq(schema.drive_files.ownerId, user.id)).get();
        fileCount = result?.count || 0;
        totalSize = result?.totalSize || 0;
      } catch (e) {
        // 表可能不存在
      }
      
      // 从KV获取用户存储限制
      let storageLimit = 0;
      try {
        const limitStr = await c.env.UPLOADS.get(`user_storage_limit_${user.id}`);
        storageLimit = limitStr ? parseInt(limitStr) : 0;
      } catch (e) {}
      
      return {
        id: user.id,
        name: user.name,
        username: user.username,
        fileCount,
        totalSize,
        disk: user.disk,
        storageLimit: storageLimit || undefined
      };
    }));
    
    return c.json({ success: true, data: userStats });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// 更新用户网盘存储空间限制
app.post('/api/admin/drive/users/:userId/limit', adminAuth, csrfProtection, async (c) => {
  try {
    const userId = c.req.param('userId');
    const { storageLimit } = await c.req.json();
    
    // 将用户存储限制保存到 KV
    await c.env.UPLOADS.put(`user_storage_limit_${userId}`, String(storageLimit || 0));
    
    return c.json({ success: true, message: '用户存储限制已更新' });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// ==================== 聊天备份还原 ====================

// 聊天数据库备份
app.get('/api/admin/backup/chat', adminAuth, async (c) => {
  try {
    const db = drizzle(c.env.DB);
    const storageType = await getChatStorageType(c.env.DB);

    const backupData: any = {
      version: '1.0',
      type: 'chat',
      timestamp: utcNow(),
      tables: {}
    };
    
    backupData.tables.users = await db.select().from(schema.users).all();
    backupData.tables.sessions = await db.select().from(schema.sessions).all();
    backupData.tables.session_participants = await db.select().from(schema.session_participants).all();
    backupData.tables.messages = await db.select().from(schema.messages).all();
    backupData.tables.attachments = await db.select().from(schema.attachments).all();
    backupData.tables.message_reads = await db.select().from(schema.message_reads).all();
    backupData.tables.admins = await db.select().from(schema.admins).all();
    
    const backupJson = JSON.stringify(backupData);
    const backupKey = `${utcNow()}.json`;
    
    if (storageType === "kv") {
    	await c.env.UPLOADS.put("chat/backup/"+backupKey, backupJson, {
		  metadata: { 
			  contentType: 'application/json', 
			  size: backupJson.length
		  }
		});
    }
    else if (storageType === "r2") {
    	await c.env.R2.put("chat/backup/"+backupKey, backupJson, {
		  httpMetadata: {
		    contentType: 'application/json'
		  }
		});
    }
    else {
    	await c.env.UPLOADS.put("chat/backup/"+backupKey, backupJson, {
		  metadata: { 
			  contentType: 'application/json', 
			  size: backupJson.length
		  }
		});
    }
    
    return c.json({ success: true, message: '聊天数据备份成功', key: backupKey });
  } catch (e) {
    console.error('Chat backup error:', e);
    return c.json({ success: false, message: '备份失败: ' + String(e) }, 500);
  }
});

// 聊天备份列表
app.get('/api/admin/backups/chat', adminAuth, async (c) => {
  try {
    const backups: { key: string; size: number; uploaded: number }[] = [];
    const storageType = await getChatStorageType(c.env.DB);

    let list = [];
    // await c.env.R2.list({ prefix: 'chat/backup/' });
    if (storageType === "kv") {
    	list = await c.env.UPLOADS.list({ prefix: 'chat/backup/' });
    	list = list.keys;
    }
    else if (storageType === "r2") {
    	list = await c.env.R2.list({ prefix: 'chat/backup/' });
    	list = list.objects;
    }
    // 第三方网盘就不用了，直接备份到KV中
    else {
    	list = await c.env.UPLOADS.list({ prefix: 'chat/backup/' });
    	list = list.keys;
    }

    for (const obj of list) {
      backups.push({
        key: obj?.key || obj?.name,
        size: obj?.size || obj?.metadata.size,
        uploaded: obj.uploaded?.getTime() || 0
      });
    }
    
    backups.sort((a, b) => b.uploaded - a.uploaded);
    
    return c.json({ success: true, data: backups });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// 聊天数据还原
app.post('/api/admin/restore/chat', adminAuth, csrfProtection, superAdminAuth, async (c) => {
  try {
    const { backupKey } = await c.req.json();
    const storageType = await getChatStorageType(c.env.DB);

    let backupJson: string | null = null;

    if (!backupKey) {
      return c.json({ success: false, message: '请提供备份文件名' }, 400);
    }
    
    if (storageType === "kv") {
      const data = await c.env.UPLOADS.get('chat/backup/'+backupKey, 'text');
      backupJson = data as string | null;
    }
    else if (storageType === "r2") {
      const obj = await c.env.R2.get("chat/backup/"+backupKey);
      if (obj) {
        backupJson = await obj.text();
      }
    }
    else {
      const data = await c.env.UPLOADS.get('chat/backup/'+backupKey, 'text');
      backupJson = data as string | null;
    }
    
    if (!backupJson) {
      return c.json({ success: false, message: '备份文件不存在' }, 404);
    }
 
    const backupData = JSON.parse(backupJson);

    if (backupData.type !== 'chat') {
      return c.json({ success: false, message: '备份文件类型不匹配' }, 400);
    }
    
    const db = drizzle(c.env.DB);
    
    // 清除现有聊天数据
    await db.delete(schema.message_reads).run();
    await db.delete(schema.attachments).run();
    await db.delete(schema.messages).run();
    await db.delete(schema.session_participants).run();
    await db.delete(schema.sessions).run();
    
    // 恢复数据
    if (backupData.tables.users) {
      for (const user of backupData.tables.users) {
        await db.insert(schema.users).values(user).onConflictDoNothing().run();
      }
    }
    if (backupData.tables.sessions) {
      for (const session of backupData.tables.sessions) {
        await db.insert(schema.sessions).values(session).onConflictDoNothing().run();
      }
    }
    if (backupData.tables.session_participants) {
      for (const sp of backupData.tables.session_participants) {
        await db.insert(schema.session_participants).values(sp).onConflictDoNothing().run();
      }
    }
    if (backupData.tables.messages) {
      for (const msg of backupData.tables.messages) {
        await db.insert(schema.messages).values(msg).onConflictDoNothing().run();
      }
    }
    if (backupData.tables.attachments) {
      for (const att of backupData.tables.attachments) {
        await db.insert(schema.attachments).values(att).onConflictDoNothing().run();
      }
    }
    if (backupData.tables.message_reads) {
      for (const mr of backupData.tables.message_reads) {
        await db.insert(schema.message_reads).values(mr).onConflictDoNothing().run();
      }
    }
    
    return c.json({ success: true, message: '聊天数据还原成功' });
  } catch (e) {
    console.error('Restore chat error:', e);
    return c.json({ success: false, message: '还原失败: ' + String(e) }, 500);
  }
});

// 聊天备份下载
app.get('/api/admin/download-backup/chat/:key', adminAuth, async (c) => {
  try {
    const backupKey = c.req.param('key');
    const storageType = await getChatStorageType(c.env.DB);
    let body: string | ArrayBuffer | null = null;

    if (!backupKey) {
      return c.json({ success: false, message: '请提供备份文件名' }, 400);
    }
    
    if (storageType === "kv") {
      body = await c.env.UPLOADS.get('chat/backup/'+backupKey, 'text');
    }
    else if (storageType === "r2") {
      const obj = await c.env.R2.get("chat/backup/"+backupKey);
      if (obj) {
        body = await obj.arrayBuffer();
      }
    }
    else {
      body = await c.env.UPLOADS.get('chat/backup/'+backupKey, 'text');
    }

    if (!body) {
      return c.json({ success: false, message: '备份文件不存在' }, 404);
    }
    
    return new Response(body, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${backupKey}"`,
        ...getCorsHeaders(c.env, c.req.raw)
      }
    });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// 聊天备份删除
app.delete('/api/admin/backups/chat/:key', adminAuth, csrfProtection, async (c) => {
  try {
    const backupKey = c.req.param('key');
    const storageType = await getChatStorageType(c.env.DB);

    let backupFile = null;

    if (!backupKey) {
      return c.json({ success: false, message: '请提供备份文件名' }, 400);
    }
    
    // await c.env.R2.list({ prefix: 'chat/backup/' });
    if (storageType === "kv") {
    	backupFile = await c.env.UPLOADS.delete('chat/backup/'+backupKey);
    }
    else if (storageType === "r2") {
    	backupFile = await c.env.R2.delete("chat/backup/"+backupKey);
    }
    // 第三方网盘就不用了，直接备份到KV中
    else {
    	backupFile = await c.env.UPLOADS.delete('chat/backup/'+backupKey);
    }

    return c.json({ success: true, message: '删除成功' });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// ==================== 网盘备份还原 ====================

// 网盘数据库备份
app.get('/api/admin/backup/drive', adminAuth, async (c) => {
  try {
    const db = drizzle(c.env.DB);

    // 获取当前存储类型
    const storageType = await getChatStorageType(c.env.DB);
    
    const backupData: any = {
      version: '1.0',
      type: 'drive',
      storageType: storageType,
      timestamp: utcNow(),
      tables: {}
    };
    
    // 只备份当前存储类型的网盘文件记录
    backupData.tables.drive_files = await db.select().from(schema.drive_files)
      .where(sql`storage_type = ${storageType}`)
      .all();

    const backupJson = JSON.stringify(backupData);
    const backupKey = `${utcNow()}.json`;

    if (storageType === "kv") {
    	await c.env.UPLOADS.put("drive/backup/"+backupKey, backupJson, {
			metadata: { 
			  contentType: 'application/json', 
			  size: backupJson.length
		  	}
		});
    }
    else if (storageType === "r2") {
    	await c.env.R2.put("drive/backup/"+backupKey, backupJson, {
			  httpMetadata: {
				contentType: 'application/json'
			  }
			});
    }
    else {
    	await c.env.UPLOADS.put("drive/backup/"+backupKey, backupJson, {
			metadata: { 
			  contentType: 'application/json', 
			  size: backupJson.length
		  	}
		});
    }
    
    return c.json({ success: true, message: '网盘数据备份成功', key: backupKey });
  } catch (e) {
    console.error('Drive backup error:', e);
    return c.json({ success: false, message: '备份失败: ' + String(e) }, 500);
  }
});

// 网盘备份列表
app.get('/api/admin/backups/drive', adminAuth, async (c) => {
  try {
    const backups: { key: string; size: number; uploaded: number }[] = [];
    const storageType = await getChatStorageType(c.env.DB);
    
    if (storageType === "kv") {
      const list = await c.env.UPLOADS.list({ prefix: 'drive/backup/' });
      for (const obj of list.keys) {
        backups.push({
          key: obj.name,
          size: obj.metadata?.size || 0,
          uploaded: obj.expiration ? obj.expiration * 1000 : 0
        });
      }
    }
    else if (storageType === "r2") {
      const list = await c.env.R2.list({ prefix: 'drive/backup/' });
      for (const obj of list.objects) {
        backups.push({
          key: obj.key,
          size: obj.size,
          uploaded: obj.uploaded?.getTime() || 0
        });
      }
    }
    else {
      const list = await c.env.UPLOADS.list({ prefix: 'drive/backup/' });
      for (const obj of list.keys) {
        backups.push({
          key: obj.name,
          size: obj.metadata?.size || 0,
          uploaded: obj.expiration ? obj.expiration * 1000 : 0
        });
      }
    }
    
    backups.sort((a, b) => b.uploaded - a.uploaded);
    
    return c.json({ success: true, data: backups });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// 网盘数据还原
app.post('/api/admin/restore/drive', adminAuth, csrfProtection, superAdminAuth, async (c) => {
  try {
    const { backupKey } = await c.req.json();
    const storageType = await getChatStorageType(c.env.DB);
    let backupJson: string | null = null;

    if (!backupKey) {
      return c.json({ success: false, message: '请提供备份文件名' }, 400);
    }
    
    if (storageType === "kv") {
      const data = await c.env.UPLOADS.get("drive/backup/"+backupKey, 'text');
      backupJson = data as string | null;
    }
    else if (storageType === "r2") {
      const obj = await c.env.R2.get("drive/backup/"+backupKey);
      if (obj) {
        backupJson = await obj.text();
      }
    }
    else {
      const data = await c.env.UPLOADS.get("drive/backup/"+backupKey, 'text');
      backupJson = data as string | null;
    }
    
    if (!backupJson) {
      return c.json({ success: false, message: '备份文件不存在' }, 404);
    }
    
    const backupData = JSON.parse(backupJson);
    
    if (backupData.type !== 'drive') {
      return c.json({ success: false, message: '备份文件类型不匹配' }, 400);
    }
    
    const db = drizzle(c.env.DB);
    
    // 清除现有网盘数据
    await db.delete(schema.drive_files).where(sql`storage_type = ${storageType}`).run();
    
    // 恢复数据
    if (backupData.tables.drive_files) {
      for (const file of backupData.tables.drive_files) {
        await db.insert(schema.drive_files).values(file).onConflictDoNothing().run();
      }
    }
    
    return c.json({ success: true, message: '网盘数据还原成功' });
  } catch (e) {
    console.error('Restore drive error:', e);
    return c.json({ success: false, message: '还原失败: ' + String(e) }, 500);
  }
});

// 网盘备份下载
app.get('/api/admin/download-backup/drive/:key', adminAuth, async (c) => {
  try {
    const backupKey = c.req.param('key');
    const storageType = await getChatStorageType(c.env.DB);
    let body: string | ArrayBuffer | null = null;

    if (!backupKey) {
      return c.json({ success: false, message: '请提供备份文件名' }, 400);
    }
    
    if (storageType === "kv") {
      body = await c.env.UPLOADS.get("drive/backup/"+backupKey, 'text');
    }
    else if (storageType === "r2") {
      const obj = await c.env.R2.get("drive/backup/"+backupKey);
      if (obj) {
        body = await obj.arrayBuffer();
      }
    }
    else {
      body = await c.env.UPLOADS.get("drive/backup/"+backupKey, 'text');
    }
    
    if (!body) {
      return c.json({ success: false, message: '备份文件不存在' }, 404);
    }
    
    return new Response(body, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${backupKey}"`,
        ...getCorsHeaders(c.env, c.req.raw)
      }
    });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// 网盘备份删除
app.delete('/api/admin/backups/drive/:key', adminAuth, csrfProtection, async (c) => {
  try {
    const backupKey = c.req.param('key');
    const storageType = await getChatStorageType(c.env.DB);
    let backupFile = null;

    if (!backupKey) {
      return c.json({ success: false, message: '请提供备份文件名' }, 400);
    }
    
    if (storageType === "kv") {
    	await c.env.UPLOADS.delete("drive/backup/"+backupKey);
    }
    else if (storageType === "r2") {
    	await c.env.R2.delete("drive/backup/"+backupKey);
    }
    // 第三方网盘就不用了，直接备份到KV中
    else {
    	await c.env.UPLOADS.delete("drive/backup/"+backupKey);
    }

    return c.json({ success: true, message: '删除成功' });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// 清空网盘（删除实际文件 + 数据库记录）
app.post('/api/admin/clear-drive-files', adminAuth, csrfProtection, async (c) => {
  try {
    const db = drizzle(c.env.DB);
    
    // 从数据库获取当前存储类型设置
    const storageTypeRow = await db.select({ value: schema.system_settings.value })
      .from(schema.system_settings)
      .where(eq(schema.system_settings.key, 'storageType'))
      .get();
    
    const storageType = (storageTypeRow?.value as string) || 'r2';
    let deletedStorageCount = 0;
    let deletedDbCount = 0;
    
    // 获取所有网盘文件记录
    const driveFiles = await db.select({ id: schema.drive_files.id, url: schema.drive_files.url })
      .from(schema.drive_files)
      .where(sql`storage_type = ${storageType}`)
      .all();
    
    // 删除云存储中的实际文件
    if (storageType === 'r2') {
      for (const file of driveFiles) {
        if (file.url && !file.url.startsWith('http')) {
          try {
            await c.env.R2.delete(file.url);
            deletedStorageCount++;
          } catch (err) {
            console.error('删除R2文件失败:', err);
          }
        }
      }
      // 同时删除drive/files/前缀的文件
      const list = await c.env.R2.list({ prefix: 'drive/files/' });
      for (const obj of list.objects) {
        await c.env.R2.delete(obj.key);
        deletedStorageCount++;
      }
      while (list.truncated) {
        const next = await c.env.R2.list({ prefix: 'drive/files/', cursor: list.cursor });
        for (const obj of next.objects) {
          await c.env.R2.delete(obj.key);
          deletedStorageCount++;
        }
        Object.assign(list, next);
      }
    } else if (storageType === 'kv') {
      for (const file of driveFiles) {
        if (file.url) {
          try {
            await c.env.UPLOADS.delete(file.url);
            deletedStorageCount++;
          } catch (err) {
            console.error('删除KV文件失败:', err);
          }
        }
      }
      const list = await c.env.UPLOADS.list({ prefix: 'drive/files/' });
      for (const key of list.keys) {
        await c.env.UPLOADS.delete(key.name);
        deletedStorageCount++;
      }
      while (list.truncated) {
        const next = await c.env.UPLOADS.list({ prefix: 'drive/files/', cursor: list.cursor });
        for (const key of next.keys) {
          await c.env.UPLOADS.delete(key.name);
          deletedStorageCount++;
        }
        Object.assign(list, next);
      }
    }
    
    // 清空drive_files表中对应的记录
    const result = await db.delete(schema.drive_files).where(sql`storage_type = ${storageType}`).run();
    deletedDbCount = result.meta.changes || 0;
    
    return c.json({ 
      success: true, 
      message: `已清空 ${storageType} 网盘：存储文件 ${deletedStorageCount} 个，数据库记录 ${deletedDbCount} 条`,
      deletedStorageCount,
      deletedDbCount,
      storageType
    });
  } catch (e) {
    console.error('Clear drive files error:', e);
    return c.json({ success: false, message: '清空失败: ' + String(e) }, 500);
  }
});

// ==================== 数据库备份还原 ====================

app.get('/api/admin/backup/download', adminAuth, async (c) => {
  try {
    const db = drizzle(c.env.DB);
    
    const backupData: any = {
      version: '1.0',
      timestamp: utcNow(),
      tables: {}
    };
    
    backupData.tables.users = await db.select().from(schema.users).all();
    backupData.tables.sessions = await db.select().from(schema.sessions).all();
    backupData.tables.session_participants = await db.select().from(schema.session_participants).all();
    backupData.tables.messages = await db.select().from(schema.messages).all();
    backupData.tables.attachments = await db.select().from(schema.attachments).all();
    backupData.tables.message_reads = await db.select().from(schema.message_reads).all();
    backupData.tables.admins = await db.select().from(schema.admins).all();
    
    const backupJson = JSON.stringify(backupData);
    const backupKey = `backup/${utcNow()}.json`;
    
    // 同时保存到R2
    await c.env.R2.put(backupKey, backupJson, {
      httpMetadata: {
        contentType: 'application/json'
      }
    });
    
    // 返回给前端下载
    return new Response(backupJson, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${backupKey}"`,
        ...getCorsHeaders(c.env, c.req.raw)
      }
    });
  } catch (e) {
    console.error('Backup error:', e);
    return c.json({ success: false, message: '备份失败: ' + String(e) }, 500);
  }
});

app.get('/api/admin/backups', adminAuth, async (c) => {
  try {
    const backups: { key: string; size: number; uploaded: number }[] = [];
    
    const list = await c.env.R2.list({ prefix: 'backup_' });
    for (const obj of list.objects) {
      backups.push({
        key: obj.key,
        size: obj.size,
        uploaded: obj.uploaded?.getTime() || 0
      });
    }
    
    backups.sort((a, b) => b.uploaded - a.uploaded);
    
    return c.json({ success: true, data: backups });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

app.post('/api/admin/restore', adminAuth, csrfProtection, async (c) => {
  try {
    const { backupKey } = await c.req.json();
    
    if (!backupKey) {
      return c.json({ success: false, message: '请提供备份文件名' }, 400);
    }
    
    const backupFile = await c.env.R2.get(backupKey);
    
    if (!backupFile) {
      return c.json({ success: false, message: '备份文件不存在' }, 404);
    }
    
    const backupJson = await backupFile.text();
    const backupData = JSON.parse(backupJson);
    
    const db = drizzle(c.env.DB);
    
    await db.delete(schema.message_reads).run();
    await db.delete(schema.attachments).run();
    await db.delete(schema.messages).run();
    await db.delete(schema.session_participants).run();
    await db.delete(schema.sessions).run();
    await db.delete(schema.users).run();
    
    if (backupData.tables.users) {
      for (const user of backupData.tables.users) {
        await db.insert(schema.users).values(user).onConflictDoNothing();
      }
    }
    
    if (backupData.tables.sessions) {
      for (const session of backupData.tables.sessions) {
        await db.insert(schema.sessions).values(session).onConflictDoNothing();
      }
    }
    
    if (backupData.tables.session_participants) {
      for (const sp of backupData.tables.session_participants) {
        await db.insert(schema.session_participants).values(sp).onConflictDoNothing();
      }
    }
    
    if (backupData.tables.messages) {
      for (const msg of backupData.tables.messages) {
        await db.insert(schema.messages).values(msg).onConflictDoNothing();
      }
    }
    
    if (backupData.tables.attachments) {
      for (const att of backupData.tables.attachments) {
        await db.insert(schema.attachments).values(att).onConflictDoNothing();
      }
    }
    
    if (backupData.tables.message_reads) {
      for (const mr of backupData.tables.message_reads) {
        await db.insert(schema.message_reads).values(mr).onConflictDoNothing();
      }
    }
    
    return c.json({ success: true, message: '还原成功' });
  } catch (e) {
    console.error('Restore error:', e);
    return c.json({ success: false, message: '还原失败: ' + String(e) }, 500);
  }
});

app.delete('/api/admin/backups/:key', adminAuth, csrfProtection, async (c) => {
  try {
    const backupKey = c.req.param('key');
    await c.env.R2.delete(backupKey);
    return c.json({ success: true, message: '删除成功' });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// 清空数据库（保留表结构，只删除数据）
app.post('/api/admin/clear-database', adminAuth, csrfProtection, superAdminAuth, async (c) => {
  try {
    const db = drizzle(c.env.DB);
    const storageType = await getChatStorageType(c.env.DB);
    
    // 删除的表：sessions, session_participants, messages, attachments, message_reads, group_attachments, notifications, phrases
    await db.delete(schema.message_reads).run();
    await db.delete(schema.attachments).run();
    await db.delete(schema.messages).run();
    await db.delete(schema.session_participants).run();
    await db.delete(schema.sessions).run();
    await db.delete(schema.group_attachments).run();
    await db.delete(schema.notifications).run();
    await db.delete(schema.phrases).run();
    
    // 保留的表：users, admins, drive_files, system_settings
    
    // 删除聊天文件和群附件存储
    let deletedCount = 0;
    if (storageType === 'kv') {
      const chatFiles = await c.env.UPLOADS.list({ prefix: 'chat/files' });
      for (const file of chatFiles.objects) {
        await c.env.UPLOADS.delete(file.key);
        deletedCount++;
      }
    } else if (storageType === 'r2' || !storageType) {
   	  // 之删除文件目录下的文件，保留其他文件
      const chatFiles = await c.env.R2.list({ prefix: 'chat/files' });
      for (const file of chatFiles.objects) {
        await c.env.R2.delete(file.key);
        deletedCount++;
      }
    }
    // pcloud 和 google 存储的文件无法通过 API 批量删除
    
    return c.json({ success: true, message: `数据库已清空（用户、管理员、网盘文件保留），已删除 ${deletedCount} 个文件` });
  } catch (e) {
    console.error('Clear database error:', e);
    return c.json({ success: false, message: '清空失败: ' + String(e) }, 500);
  }
});

// 清空网盘文件（根据storageType设置清空对应存储和drive_files表）
app.post('/api/admin/clear-drive-files', adminAuth, csrfProtection, superAdminAuth, async (c) => {
  try {
    const db = drizzle(c.env.DB);
    
    // 从数据库获取当前存储类型设置
    const storageTypeRow = await db.select({ value: schema.system_settings.value })
      .from(schema.system_settings)
      .where(eq(schema.system_settings.key, 'storageType'))
      .get();
    
    const storageType = (storageTypeRow?.value as string) || 'r2';
    let deletedStorageCount = 0;
    let deletedDbCount = 0;
    
    // 清空对应存储中的文件
    if (storageType === 'r2') {
      const list = await c.env.R2.list({ prefix: 'drive/files/' });
      for (const obj of list.objects) {
        await c.env.R2.delete(obj.key);
        deletedStorageCount++;
      }
      while (list.truncated) {
        const next = await c.env.R2.list({ prefix: 'drive/files/', cursor: list.cursor });
        for (const obj of next.objects) {
          await c.env.R2.delete(obj.key);
          deletedStorageCount++;
        }
        Object.assign(list, next);
      }
    } else if (storageType === 'kv') {
      const list = await c.env.UPLOADS.list({ prefix: 'drive/files/' });
      for (const key of list.keys) {
        await c.env.UPLOADS.delete(key.name);
        deletedStorageCount++;
      }
      while (list.truncated) {
        const next = await c.env.UPLOADS.list({ prefix: 'drive/files/', cursor: list.cursor });
        for (const key of next.keys) {
          await c.env.UPLOADS.delete(key.name);
          deletedStorageCount++;
        }
        Object.assign(list, next);
      }
    } else if (storageType === 'pcloud' || storageType === 'google') {
      // 第三方网盘只清空数据库记录，不直接操作云端（需要token等复杂操作）
      deletedStorageCount = 0;
    }
    
    // 清空drive_files表中对应的记录
    const result = await db.delete(schema.drive_files).where(sql`storage_type = ${storageType}`).run();
    deletedDbCount = result.meta.changes || 0;
    
    return c.json({ 
      success: true, 
      message: `已清空 ${storageType} 网盘：存储文件 ${deletedStorageCount} 个，数据库记录 ${deletedDbCount} 条`,
      deletedStorageCount,
      deletedDbCount,
      storageType
    });
  } catch (e) {
    console.error('Clear drive files error:', e);
    return c.json({ success: false, message: '清空失败: ' + String(e) }, 500);
  }
});

app.get('/api/admin/download-backup/:key', adminAuth, async (c) => {
  try {
    const backupKey = c.req.param('key');
    const backupFile = await c.env.R2.get(backupKey);
    
    if (!backupFile) {
      return c.json({ success: false, message: '备份文件不存在' }, 404);
    }
    
    return new Response(backupFile.body, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${backupKey}"`,
        ...getCorsHeaders(c.env, c.req.raw)
      }
    });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

app.get('/api/admin/all-users', adminAuth, async (c) => {
  try {
    const db = drizzle(c.env.DB);
    const users = await db.select().from(schema.users).all();
    return c.json({ success: true, data: users });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

app.get('/api/admin/sessions', adminAuth, async (c) => {
  try {
    const { page = '1', limit = '20', type } = c.req.query();
    const db = drizzle(c.env.DB);
    
    let query = db.select().from(schema.sessions);
    if (type && type !== 'all') {
      query = query.where(eq(schema.sessions.type, type)) as any;
    }
    
    const sessions = await query.limit(parseInt(limit)).offset((parseInt(page) - 1) * parseInt(limit)).all();
    
    let totalQuery = db.select({ count: sql<number>`count(*)` }).from(schema.sessions);
    if (type && type !== 'all') {
      totalQuery = totalQuery.where(eq(schema.sessions.type, type)) as any;
    }
    const total = await totalQuery.get();
    
    const sessionList = await Promise.all(sessions.map(async (s) => {
      const members = await db.select().from(schema.users).innerJoin(schema.session_participants, eq(schema.users.id, schema.session_participants.userId)).where(eq(schema.session_participants.sessionId, s.id)).all();
      return { 
        id: s.id,
        type: s.type,
        name: s.type === 'group' ? s.name : '',
        participant_names: members.map(m => m.users.name).join(', '),
        lastMessage: s.lastMessage,
        lastTime: s.lastTime || s.createdAt,
        createdAt: s.createdAt
      };
    }));
    
    return c.json({ success: true, data: { list: sessionList, total: total?.count || 0 } });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

app.post('/api/admin/sessions/friend', adminAuth, csrfProtection, async (c) => {
  try {
    const { userId1, userId2 } = await c.req.json();
    const db = drizzle(c.env.DB);
    
    if (!userId1 || !userId2) {
      return c.json({ success: false, message: '缺少用户ID' }, 400);
    }
    
    const sessionId = crypto.randomUUID();
    await db.insert(schema.sessions).values({ id: sessionId, type: 'friend', lastMessage: '', lastTime: utcNow() });
    await db.insert(schema.session_participants).values([{ sessionId, userId: userId1 }, { sessionId, userId: userId2 }]);
    
    // 广播会话列表更新给双方
    
    try {
      const chatId = c.env.CHAT.idFromName('global');
      const chatStub = c.env.CHAT.get(chatId);
      await chatStub.fetch('https://broadcast', {
        method: 'POST',
        body: JSON.stringify({
          type: 'conversationsUpdate',
          data: { userId: userId1 }
        })
      });
      await chatStub.fetch('https://broadcast', {
        method: 'POST',
        body: JSON.stringify({
          type: 'conversationsUpdate',
          data: { userId: userId2 }
        })
      });
    } catch (e) {
      console.error('Broadcast error:', e);
    }
    
    return c.json({ success: true, data: { id: sessionId, type: 'friend' } });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

app.post('/api/admin/sessions/owner', adminAuth, csrfProtection, async (c) => {
  try {
    const { sessionId, userId, isOwner } = await c.req.json();
    const db = drizzle(c.env.DB);
    
    const session = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
    if (!session) {
      return c.json({ success: false, message: '会话不存在' }, 404);
    }
    
    let ownerIds = session.ownerIds ? JSON.parse(session.ownerIds) : [];
    if (isOwner && !ownerIds.includes(userId)) {
      ownerIds.push(userId);
    } else if (!isOwner) {
      ownerIds = ownerIds.filter((id: string) => id !== userId);
    }
    
    await db.update(schema.sessions).set({ ownerIds: JSON.stringify(ownerIds) }).where(eq(schema.sessions.id, sessionId));
    return c.json({ success: true });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

app.get('/api/admin/sessions/:id', adminAuth, async (c) => {
  try {
    const sessionId = c.req.param('id');
    const db = drizzle(c.env.DB);
    
    const session = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
    if (!session) {
      return c.json({ success: false, message: '会话不存在' }, 404);
    }
    
    const members = await db.select().from(schema.users).innerJoin(schema.session_participants, eq(schema.users.id, schema.session_participants.userId)).where(eq(schema.session_participants.sessionId, sessionId)).all();
    return c.json({ success: true, data: { ...session, members: members.map(m => m.users), ownerIds: session.ownerIds ? JSON.parse(session.ownerIds) : [] } });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

app.put('/api/admin/sessions/:id', adminAuth, csrfProtection, async (c) => {
  try {
    const sessionId = c.req.param('id');
    const { name } = await c.req.json();
    const db = drizzle(c.env.DB);
    
    if (name) {
      await db.update(schema.sessions).set({ name }).where(eq(schema.sessions.id, sessionId));
    }
    return c.json({ success: true });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

app.delete('/api/admin/sessions/:id', adminAuth, csrfProtection, async (c) => {
  try {
    const sessionId = c.req.param('id');
    const db = drizzle(c.env.DB);
    
    // 获取会话成员
    const participants = await db.select()
      .from(schema.session_participants)
      .where(eq(schema.session_participants.sessionId, sessionId))
      .all();
    
    await db.delete(schema.message_reads).where(sql`message_id IN (SELECT id FROM messages WHERE session_id = ${sessionId})`);
    await db.delete(schema.attachments).where(sql`message_id IN (SELECT id FROM messages WHERE session_id = ${sessionId})`);
    await db.delete(schema.messages).where(eq(schema.messages.sessionId, sessionId));
    await db.delete(schema.session_participants).where(eq(schema.session_participants.sessionId, sessionId));
    await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
    
    // 广播会话列表更新给所有成员
    try {
      const chatId = c.env.CHAT.idFromName('global');
      const chatStub = c.env.CHAT.get(chatId);
      for (const p of participants) {
        await chatStub.fetch('https://broadcast', {
          method: 'POST',
          body: JSON.stringify({
            type: 'conversationsUpdate',
            data: { userId: p.userId }
          })
        });
      }
    } catch (e) {
      console.error('Broadcast error:', e);
    }
    
    return c.json({ success: true });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// 批量删除会话
app.post('/api/admin/sessions/batch-delete', adminAuth, csrfProtection, async (c) => {
  try {
    const { ids } = await c.req.json();
    const db = drizzle(c.env.DB);
    
    for (const sessionId of ids) {
      await db.delete(schema.message_reads).where(sql`message_id IN (SELECT id FROM messages WHERE session_id = ${sessionId})`);
      await db.delete(schema.attachments).where(sql`message_id IN (SELECT id FROM messages WHERE session_id = ${sessionId})`);
      await db.delete(schema.messages).where(eq(schema.messages.sessionId, sessionId));
      await db.delete(schema.session_participants).where(eq(schema.session_participants.sessionId, sessionId));
      await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
    }
    
    return c.json({ success: true, message: `已删除 ${ids.length} 个会话` });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

app.get('/api/admin/sessions/:id/owner', adminAuth, async (c) => {
  const sessionId = c.req.param('id');
  const db = drizzle(c.env.DB);
  
  const session = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
  if (!session) {
    return c.json({ success: false, message: '会话不存在' }, 404);
  }
  
  const ownerIds = session.ownerIds ? JSON.parse(session.ownerIds) : [];
  return c.json({ success: true, data: ownerIds });
});

app.put('/api/admin/sessions/:id/owner', adminAuth, csrfProtection, async (c) => {
  try {
    const sessionId = c.req.param('id');
    const { userId, isOwner } = await c.req.json();
    const db = drizzle(c.env.DB);
    
    const session = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
    if (!session) {
      return c.json({ success: false, message: '会话不存在' }, 404);
    }
    
    let ownerIds = session.ownerIds ? JSON.parse(session.ownerIds) : [];
    if (isOwner && !ownerIds.includes(userId)) {
      ownerIds.push(userId);
    } else if (!isOwner) {
      ownerIds = ownerIds.filter((id: string) => id !== userId);
    }
    
    await db.update(schema.sessions).set({ ownerIds: JSON.stringify(ownerIds) }).where(eq(schema.sessions.id, sessionId));
    return c.json({ success: true, message: '修改成功' });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

app.get('/api/admin/sessions/:id/members', adminAuth, async (c) => {
  try {
    const sessionId = c.req.param('id');
    const db = drizzle(c.env.DB);
    
    const members = await db.select().from(schema.users).innerJoin(schema.session_participants, eq(schema.users.id, schema.session_participants.userId)).where(eq(schema.session_participants.sessionId, sessionId)).all();
    return c.json({ success: true, data: members.map(m => m.users) });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

app.post('/api/admin/sessions/:id/members', adminAuth, csrfProtection, async (c) => {
  try {
    const sessionId = c.req.param('id');
    const { userIds, addAllUsers } = await c.req.json();
    const db = drizzle(c.env.DB);
    
    let targetUserIds = userIds;
    
    if (addAllUsers) {
      const allUsers = await db.select({ id: schema.users.id }).from(schema.users).all();
      targetUserIds = allUsers.map(u => u.id);
    }
    
    if (!targetUserIds || !Array.isArray(targetUserIds) || targetUserIds.length === 0) {
      return c.json({ success: false, message: '需要用户ID数组或选择添加所有用户' }, 400);
    }
    
    for (const userId of targetUserIds) {
      await db.insert(schema.session_participants).values({ sessionId, userId }).onConflictDoNothing();
    }
    
    // 广播会话列表更新给新添加的成员
    try {
      const chatId = c.env.CHAT.idFromName('global');
      const chatStub = c.env.CHAT.get(chatId);
      for (const userId of targetUserIds) {
        await chatStub.fetch('https://broadcast', {
          method: 'POST',
          body: JSON.stringify({
            type: 'conversationsUpdate',
            data: { userId }
          })
        });
      }
    } catch (e) {
      console.error('Broadcast error:', e);
    }
    
    return c.json({ success: true, message: '添加成功' });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

app.delete('/api/admin/sessions/:id/members/:memberId', adminAuth, csrfProtection, async (c) => {
  try {
    const sessionId = c.req.param('id');
    const memberId = c.req.param('memberId');
    const db = drizzle(c.env.DB);
    
    await db.delete(schema.session_participants).where(and(eq(schema.session_participants.sessionId, sessionId), eq(schema.session_participants.userId, memberId)));
    
    // 广播会话列表更新给被移除的成员
    try {
      const chatId = c.env.CHAT.idFromName('global');
      const chatStub = c.env.CHAT.get(chatId);
      await chatStub.fetch('https://broadcast', {
        method: 'POST',
        body: JSON.stringify({
          type: 'conversationsUpdate',
          data: { userId: memberId }
        })
      });
    } catch (e) {
      console.error('Broadcast error:', e);
    }
    
    return c.json({ success: true });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// 群组添加成员
app.post('/api/admin/groups/:id/members', adminAuth, csrfProtection, async (c) => {
  try {
    const groupId = c.req.param('id');
    const { userIds, addAllUsers } = await c.req.json();
    const db = drizzle(c.env.DB);
    
    let targetUserIds = userIds;
    
    if (addAllUsers) {
      const allUsers = await db.select({ id: schema.users.id }).from(schema.users).all();
      targetUserIds = allUsers.map(u => u.id);
    }
    
    if (!targetUserIds || !Array.isArray(targetUserIds) || targetUserIds.length === 0) {
      return c.json({ success: false, message: '需要用户ID数组或选择添加所有用户' }, 400);
    }
    
    for (const userId of targetUserIds) {
      await db.insert(schema.session_participants).values({ sessionId: groupId, userId, role: 'member' }).onConflictDoNothing();
    }
    
    // 广播会话列表更新给新添加的成员
    try {
      const chatId = c.env.CHAT.idFromName('global');
      const chatStub = c.env.CHAT.get(chatId);
      for (const userId of targetUserIds) {
        await chatStub.fetch('https://broadcast', {
          method: 'POST',
          body: JSON.stringify({
            type: 'conversationsUpdate',
            data: { userId }
          })
        });
      }
    } catch (e) {
      console.error('Broadcast error:', e);
    }
    
    return c.json({ success: true, message: `成功添加 ${targetUserIds.length} 个成员` });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// 群组移除成员
app.delete('/api/admin/groups/:id/members/:memberId', adminAuth, csrfProtection, async (c) => {
  try {
    const groupId = c.req.param('id');
    const memberId = c.req.param('memberId');
    const db = drizzle(c.env.DB);
    
    await db.delete(schema.session_participants).where(and(eq(schema.session_participants.sessionId, groupId), eq(schema.session_participants.userId, memberId)));
    
    return c.json({ success: true, message: '成员已移除' });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// ==================== WebSocket ====================

app.get('/api/ws', async (c) => {
  const url = new URL(c.req.url);
  const token = url.searchParams.get('token');
  
  if (!token) {
    return c.json({ success: false, message: '需要token' }, 401);
  }
  
  // 直接使用环境变量验证，不依赖全局状态
  const jwtSecret = c.env.JWT_SECRET_KEY;
  const csrfSecret = c.env.CSRF_SECRET_KEY;
  
  if (!jwtSecret) {
    console.error('[WebSocket] JWT_SECRET_KEY is missing in env');
    return c.json({ success: false, message: '服务器未配置JWT密钥' }, 500);
  }
  
  // 验证前先设置 secrets
  setAuthSecrets(jwtSecret, csrfSecret);
  
  // 直接传入 jwtSecret，避免全局变量问题
  const decoded = await verifyToken(token, jwtSecret);
  if (!decoded) {
    return c.json({ success: false, message: '无效token' }, 401);
  }
  
  // 使用固定名称确保所有WebSocket连接到同一个Durable Object实例
  const chatId = c.env.CHAT.idFromName('global');
  const chatStub = c.env.CHAT.get(chatId);
  
  try {
    const wsResponse = await chatStub.fetch(c.req.raw.url, c.req.raw);
    
    if (wsResponse.status === 101) {
      // console.log('[WebSocket] Connection established successfully');
      return wsResponse;
    }
    
    console.error('[WebSocket] Upgrade failed, status:', wsResponse.status);
    return c.json({ success: false, message: 'WebSocket升级失败', status: wsResponse.status }, 500);
  } catch (e) {
    console.error('[WebSocket] 连接错误:', e);
    return c.json({ success: false, message: 'WebSocket连接错误: ' + String(e) }, 500);
  }
});

// WebSocket 预热端点
app.get('/api/ws/warmup', async (c) => {
  return c.json({ success: true });
});

// 自动创建索引的辅助函数
async function ensureIndexes(db: any) {
  try {
    await db.run(sql`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)`);
    await db.run(sql`CREATE INDEX IF NOT EXISTS idx_messages_session_time ON messages(session_id, time DESC)`);
    await db.run(sql`CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id)`);
    await db.run(sql`CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id)`);
    await db.run(sql`CREATE INDEX IF NOT EXISTS idx_message_reads_message ON message_reads(message_id)`);
    await db.run(sql`CREATE INDEX IF NOT EXISTS idx_message_reads_user ON message_reads(user_id)`);
    await db.run(sql`CREATE INDEX IF NOT EXISTS idx_session_participants_session ON session_participants(session_id)`);
    await db.run(sql`CREATE INDEX IF NOT EXISTS idx_session_participants_user ON session_participants(user_id)`);
    await db.run(sql`CREATE INDEX IF NOT EXISTS idx_drive_files_owner ON drive_files(owner_id)`);
    await db.run(sql`CREATE INDEX IF NOT EXISTS idx_drive_files_parent ON drive_files(parent_id)`);
    await db.run(sql`CREATE INDEX IF NOT EXISTS idx_drive_files_owner_parent ON drive_files(owner_id, parent_id, is_deleted)`);
    await db.run(sql`CREATE INDEX IF NOT EXISTS idx_drive_files_shared ON drive_files(is_deleted, storage_type)`);
    await db.run(sql`CREATE INDEX IF NOT EXISTS idx_drive_files_owner_recent ON drive_files(owner_id, is_deleted, storage_type, created_at)`);
    await db.run(sql`CREATE INDEX IF NOT EXISTS idx_drive_files_owner_trash ON drive_files(owner_id, is_deleted, storage_type)`);
    
  } catch (e) {
    // 忽略索引已存在的错误
  }
}

// 创建索引的API
app.post('/api/admin/create-indexes', async (c) => {
  const db = drizzle(c.env.DB);
  await ensureIndexes(db);
  return c.json({ success: true, message: 'Indexes created successfully' });
});

// 广播会话列表更新事件
app.post('/api/broadcast/conversations-update', auth, csrfProtection, async (c) => {
  const userId = c.get('userId');

  // 通过 Durable Object 广播会话更新
  try {
    const chatId = c.env.CHAT.idFromName('global');
    const chatStub = c.env.CHAT.get(chatId);
    await chatStub.fetch('https://broadcast', {
      method: 'POST',
      body: JSON.stringify({
        type: 'conversationsUpdate',
        data: { userId }
      })
    });
  } catch (e) {
    console.error('Broadcast conversations update error:', e);
  }
  
  return c.json({ success: true });
});

// ==================== 手写识别 API ====================

// 手动文字识别 - 使用 Workers AI
app.post('/api/ocr/handwriting', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  
  if (!token) {
    return c.json({ success: false, message: '未登录' }, 401);
  }

  try {
    // 获取图片数据 - 使用JSON格式
    const body = await c.req.json();
    const imageBase64 = body.image || '';
    
    if (!imageBase64) {
      return c.json({ success: false, message: '请提供图片数据' }, 400);
    }

    // 移除 data:image 前缀
    let base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    
    // 确保是有效的base64
    try {
      atob(base64Data);
    } catch (e) {
      return c.json({ success: false, message: '图片数据格式无效' }, 400);
    }

    // 将base64转为字节数组
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // 调用 Workers AI (Llama 3.2 Vision - 支持图片识别)
    const aiResponse = await fetch(
      'https://api.cloudflare.com/client/v4/accounts/' + c.env.CLOUDFLARE_ACCOUNT_ID + '/ai/run/@cf/meta/llama-3.2-11b-vision-instruct',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + c.env.CLOUDFLARE_AI_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: '这是一张手写文字或印刷文字的图片，文字会有些倾斜，需要准确识别图片中所有的文字，只返回文字内容，不要任何解释。如果无法识别，请返回"无法识别"。' },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Data}` } }
              ]
            }
          ],
          max_tokens: 512
        })
      }
    );

    const aiResult = await aiResponse.json();
    
    
    
    if (!aiResult.success) {
      console.error('OCR API错误:', aiResult);
      return c.json({ success: false, message: '识别服务出错: ' + JSON.stringify(aiResult.errors) }, 500);
    }

    const recognizedText = aiResult.result.response?.trim() || '';
    
    // 提取候选文字（提取所有中英文、数字）
    const candidates = recognizedText
      .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
      .split('')
      .filter((c, i, arr) => arr.indexOf(c) === i) // 去重
      .slice(0, 20); // 限制20个候选

    return c.json({
      success: true,
      text: recognizedText,
      candidates: candidates
    });

  } catch (error) {
    console.error('手写识别错误:', error);
    return c.json({ success: false, message: '识别失败: ' + (error as Error).message }, 500);
  }
});

// ==================== AI 助手 API ====================

// 导入 AI 处理模块
import { selectModel, callAIModel, parseAIResponse } from './ai';

// AI 对话 - 智能路由版本
app.post('/api/ai/chat', auth, csrfProtection, async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  
  if (!token) {
    return c.json({ success: false, message: '未登录' }, 401);
  }

  try {
    const { messages, systemPrompt } = await c.req.json();
    
    if (!messages || !Array.isArray(messages)) {
      return c.json({ success: false, message: '请提供消息列表' }, 400);
    }

    // 构建消息格式
    const chatMessages = [];
    
    // 添加系统提示
    if (systemPrompt) {
      chatMessages.push({
        role: 'system',
        content: systemPrompt
      });
    }
    
    // 添加对话历史
    for (const msg of messages) {
      chatMessages.push({
        role: msg.role || 'user',
        content: msg.content
      });
    }

    // 获取用户最新消息，用于选择模型
    const userMessage = messages.filter((m: any) => m.role === 'user').pop()?.content || '';
    
    // 智能选择模型
    const selectedModel = selectModel(userMessage);

    // 调用 AI
    const responseText = await callAIModel(
      c.env.CLOUDFLARE_ACCOUNT_ID,
      c.env.CLOUDFLARE_AI_TOKEN,
      selectedModel,
      chatMessages
    );

    return c.json({
      success: true,
      message: responseText,
      model: selectedModel.split('/').pop() // 返回使用的模型名称
    });

  } catch (error) {
    console.error('AI 对话错误:', error);
    return c.json({ success: false, message: 'AI 服务暂时不可用' }, 500);
  }
});

// ==================== AI 图像识别 API ====================
app.post('/api/ai/vision', auth, csrfProtection, async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  
  if (!token) {
    return c.json({ success: false, message: '未登录' }, 401);
  }

  try {
    const { imageUrl, question } = await c.req.json();
    
    if (!imageUrl) {
      return c.json({ success: false, message: '请提供图片 URL' }, 400);
    }

    // 使用图像识别模型
    const visionModel = '@cf/meta/llama-3.2-11b-vision-instruct';

    let base64Image = imageUrl;
    
    // 如果不是 base64 格式，则下载并转换
    if (!imageUrl.startsWith('data:')) {
      try {
        new URL(imageUrl);
      } catch {
        return c.json({ success: false, message: '无效的图片 URL' }, 400);
      }
      
      try {
        const imageResponse = await fetch(imageUrl);
        if (!imageResponse.ok) {
          throw new Error(`图片下载失败: ${imageResponse.status}`);
        }
        
        const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';
        
        const arrayBuffer = await imageResponse.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
        base64Image = `data:${contentType};base64,${base64}`;
      } catch (downloadError) {
        console.error('[AI Vision] 图片下载错误:', downloadError);
        return c.json({ success: false, message: '图片下载失败，请检查图片 URL 是否有效' }, 400);
      }
    }
    
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: question || "请详细描述这张图片的内容，并给出相关问题的解决方案。" },
          { type: 'image_url', image_url: { url: base64Image } }
        ]
      }
    ];

    // 调用视觉模型
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${c.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${visionModel}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${c.env.CLOUDFLARE_AI_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages,
          max_tokens: 4096,
          temperature: 0.7
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[AI Vision] API 错误:', response.status, errorText);
      throw new Error(`AI 图像识别失败: ${response.status}`);
    }

    const result = await response.json();
    const responseText = parseAIResponse(result);

    return c.json({
      success: true,
      message: responseText
    });

  } catch (error) {
    console.error('AI 图像识别错误:', error);
    return c.json({ success: false, message: 'AI 图像识别服务暂时不可用' }, 500);
  }
});

// ==================== 快捷短语 API ====================

// 获取短语列表
app.get('/api/phrases', auth, async (c) => {
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  try {
    // 获取公共短语和用户自定义短语
    let phrases = await db.select()
      .from(schema.phrases)
      .where(or(
        eq(schema.phrases.userId, userId),
        eq(schema.phrases.userId, '')
      ))
      .orderBy(desc(schema.phrases.createdAt))
      .all();
    
    // 如果没有公共短语，自动插入默认短语
    const hasCommonPhrases = phrases.some(p => !p.userId);
    if (!hasCommonPhrases) {      
      for (const phrase of DEFAULT_PHRASES) {
        await db.insert(schema.phrases).values({
          id: crypto.randomUUID(),
          userId: '',
          phrase,
          createdAt: 0
        });
      }
      
      phrases = await db.select()
        .from(schema.phrases)
        .where(or(
          eq(schema.phrases.userId, userId),
          eq(schema.phrases.userId, '')
        ))
        .orderBy(desc(schema.phrases.createdAt))
        .all();
    }
    
    return c.json({ success: true, data: phrases });
  } catch (error) {
    console.error('获取短语失败:', error);
    return c.json({ success: false, message: '获取失败' }, 500);
  }
});

// 添加短语
app.post('/api/phrases', auth, csrfProtection, async (c) => {
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  
  try {
    const { phrase } = await c.req.json();
    
    if (!phrase || !phrase.trim()) {
      return c.json({ success: false, message: '短语不能为空' }, 400);
    }
    
    // 检查是否已存在
    const existing = await db.select()
      .from(schema.phrases)
      .where(and(
        eq(schema.phrases.phrase, phrase.trim()),
        eq(schema.phrases.userId, userId)
      ))
      .get();
    
    if (existing) {
      return c.json({ success: false, message: '短语已存在' }, 400);
    }
    
    await db.insert(schema.phrases).values({
      id: crypto.randomUUID(),
      userId: userId,
      phrase: phrase.trim(),
      createdAt: utcNow()
    });
    
    return c.json({ success: true });
  } catch (error) {
    console.error('添加短语失败:', error);
    return c.json({ success: false, message: '添加失败' }, 500);
  }
});

// 删除短语
app.delete('/api/phrases/:id', auth, csrfProtection, async (c) => {
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  const id = c.req.param('id');
  
  try {
    await db.delete(schema.phrases)
      .where(and(
        eq(schema.phrases.id, id),
        eq(schema.phrases.userId, userId)
      ));
    
    return c.json({ success: true });
  } catch (error) {
    console.error('删除短语失败:', error);
    return c.json({ success: false, message: '删除失败' }, 500);
  }
});

// ==================== 语音识别 API ====================

app.post('/api/ocr/voice', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  
  if (!token) {
    return c.json({ success: false, message: '未登录' }, 401);
  }

  try {
    // 获取音频数据
    const body = await c.req.json();
    const audioBase64 = body.audio || '';
    
    if (!audioBase64) {
      return c.json({ success: false, message: '请提供音频数据' }, 400);
    }

    // 移除 data:audio 前缀（如果有）
    const base64Data = audioBase64.replace(/^data:audio\/\w+;base64,/, '');
    const audioBytes = Uint8Array.from(atob(base64Data), ch => ch.charCodeAt(0));

    // 调用 Whisper 进行语音识别
    const aiResponse = await fetch(
      'https://api.cloudflare.com/client/v4/accounts/' + c.env.CLOUDFLARE_ACCOUNT_ID + '/ai/run/@cf/openai/whisper-large-v3-turbo',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + c.env.CLOUDFLARE_AI_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          audio: Array.from(audioBytes),
          language: 'zh'  // 指定中文
        })
      }
    );

    const aiResult = await aiResponse.json();
    
    if (!aiResult.success) {
      console.error('语音识别API错误:', aiResult);
      return c.json({ success: false, message: '识别服务出错' }, 500);
    }

    const recognizedText = aiResult.result?.text?.trim() || '';
    
    return c.json({
      success: true,
      text: recognizedText
    });

  } catch (error) {
    console.error('语音识别错误:', error);
    return c.json({ success: false, message: '识别失败: ' + (error as Error).message }, 500);
  }
});

// ==================== 网盘路由 ====================
registerDriveRoutes(app);
registerNotificationRoutes(app);


// ==================== 群附件路由 ====================
// 下载群附件
app.get('/api/group-attachments/:key/download', async (c) => {
    const key = c.req.param('key');	// 文件url
    const db = drizzle(c.env.DB);
    // 初始化数据
    await fileManager.initAsync(db, c.env.R2, c.env.UPLOADS);

    try {
        const fileData = await fileManager.downloadFromStorage(key);
        
        // 只处理图片类型的 Content-Type
        const ext = key.split('.').pop()?.toLowerCase();
        let contentType = 'application/octet-stream';
        if (ext === 'jpg' || ext === 'jpeg') contentType = 'image/jpeg';
        else if (ext === 'png') contentType = 'image/png';
        else if (ext === 'gif') contentType = 'image/gif';
        else if (ext === 'webp') contentType = 'image/webp';
        else if (ext === 'svg') contentType = 'image/svg+xml';
        
        return new Response(fileData, {
          headers: {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=31536000',
            ...getCorsHeaders(c.env, c.req.raw)
          }
        });
    } catch (e) {
        console.error('下载群附件失败:', e);
        return c.json({ success: false, message: '下载失败' }, 500);
    }
});

// 获取群附件列表
app.get('/api/group-attachments/:sessionId', auth, async (c) => {
  const db = drizzle(c.env.DB);
  const sessionId = c.req.param('sessionId');
  const userId = c.get('userId');
  
  try {
    // 检查是否是群成员或群主
    const session = await db.select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .get();
    
    if (!session) {
      return c.json({ success: false, message: '群不存在' }, 404);
    }

    // 获取附件列表
    const attachments = await db.select()
      .from(schema.group_attachments)
      .where(eq(schema.group_attachments.sessionId, sessionId))
      .orderBy(desc(schema.group_attachments.createdAt));
    
    return c.json({ success: true, data: attachments });
  } catch (e) {
    console.error('获取群附件失败:', e);
    return c.json({ success: false, message: '获取失败' }, 500);
  }
});

// 上传群附件（支持分片上传）
app.post('/api/group-attachments/:sessionId/upload', auth, csrfProtection, async (c) => {
  const db = drizzle(c.env.DB);
  const sessionId = c.req.param('sessionId');
  const userId = c.get('userId');
  let url: string;
  await fileManager.initAsync(db, c.env.R2, c.env.UPLOADS);

  try {
    const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
    
    if (!user) {
      return c.json({ success: false, message: '用户不存在' }, 404);
    }
    
    const session = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
    
    if (!session) {
      return c.json({ success: false, message: '群不存在' }, 404);
    }

    const formData = await c.req.formData();
    const file = formData.get('file') as File;
    const encrypted = formData.get('encrypted') === 'true';
    const encryptedName = formData.get('name') as string;
    const resumeId = formData.get('resumeId') as string;
    const chunkIndex = parseInt(formData.get('chunkIndex') as string) || 0;
    const totalChunks = parseInt(formData.get('totalChunks') as string) || 1;

    if (!file) {
      return c.json({ success: false, message: '请选择文件' }, 400);
    }

    // 如果有 resumeId，说明是分片上传
    if (resumeId) {
      return await handleChunkedGroupAttachment(c, db, sessionId, user, file, resumeId, chunkIndex, totalChunks, encrypted, encryptedName);
    }

    // 普通上传
    const id = crypto.randomUUID();
    const arrayBuffer = await file.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    
    const timestamp = utcNow();
    const fileKey = `${timestamp}-${crypto.randomUUID()}`;
    url = await fileManager.uploadToStorage(fileKey, uint8Array, file.type || 'application/octet-stream');
    
    await db.insert(schema.group_attachments).values({
      id,
      sessionId,
      name: encrypted && encryptedName ? encryptedName : file.name,
      size: file.size,
      url: url,
      uploadedBy: user.id,
      uploadedByName: user.name,
      createdAt: timestamp
    });
    
    return c.json({ success: true, data: { id, name: encrypted && encryptedName ? encryptedName : file.name, size: file.size, url: url, uploadedBy: user.id, uploadedByName: user.name } });
  } catch (e) {
    console.error('上传群附件失败:', e);
    return c.json({ success: false, message: '上传失败' }, 500);
  }
});

// 处理群附件分片上传
async function handleChunkedGroupAttachment(
  c: any,
  db: any,
  sessionId: string,
  user: any,
  file: File,
  resumeId: string,
  chunkIndex: number,
  totalChunks: number,
  encrypted: boolean,
  encryptedName: string
) {
  const uploadId = resumeId;

  // 从 KV 获取分片状态
  let chunkState = await fileManager.getChunkState(uploadId);
  
  if (!chunkState) {
    return c.json({ success: false, message: '上传会话不存在，请重新初始化' }, 400);
  }

  // 检查分片是否已上传
  const alreadyUploaded = await fileManager.isChunkUploaded(uploadId, chunkIndex);
  const uploadedChunks = await fileManager.getUploadedChunks(uploadId, totalChunks);
  
  if (alreadyUploaded) {
    return c.json({
      success: true,
      data: {
        resumeId: uploadId,
        uploadedChunks,
        totalChunks,
        skipped: true
      }
    });
  }

  // 上传分片到 R2
  const chunkBuffer = await file.arrayBuffer();
  const chunkData = new Uint8Array(chunkBuffer);
  const chunkKey = `group_chunks/${uploadId}/${chunkIndex}`;
  const { etag } = await fileManager.uploadChunkDirect(chunkKey, chunkData);

  // 标记分片完成
  const isNew = await fileManager.markChunkUploaded(uploadId, chunkIndex, etag);
  
  if (isNew && !chunkState.uploadedChunks.includes(chunkIndex)) {
    chunkState.uploadedChunks.push(chunkIndex);
    chunkState.uploadedChunks.sort((a, b) => a - b);
    await fileManager.saveChunkState(uploadId, chunkState);
  }

  // 检查所有分片是否已上传
  const allUploadedChunks = await fileManager.getUploadedChunks(uploadId, totalChunks);
  
  // 如果所有分片都已上传，合并文件
  if (allUploadedChunks.length === totalChunks && chunkState.status !== 'completed') {
    chunkState.status = 'merging';
    await fileManager.saveChunkState(uploadId, chunkState);
    
    try {
      const sortedChunks: Uint8Array[] = [];
      for (let i = 0; i < totalChunks; i++) {
        const tempKey = `group_chunks/${uploadId}/${i}`;
        const result = await fileManager.downloadChunkDirect(tempKey);
        if (!result) {
          throw new Error(`Missing chunk ${i}`);
        }
        sortedChunks.push(result.data);
      }

      const totalSize = sortedChunks.reduce((acc, c) => acc + c.length, 0);
      const combined = new Uint8Array(totalSize);
      let offset = 0;
      for (const chunk of sortedChunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }

      // 上传合并后的文件
      const finalKey = chunkState.key;
      await fileManager.uploadToStorage(finalKey, combined, encrypted ? 'application/octet-stream' : 'application/octet-stream');

      // 清理临时分片
      for (let i = 0; i < totalChunks; i++) {
        const tempKey = `group_chunks/${uploadId}/${i}`;
        await fileManager.deleteChunkDirect(tempKey).catch(() => {});
      }
      
      await fileManager.deleteChunkState(uploadId);

      // 保存到数据库
      const finalName = encryptedName || chunkState.metadata.encryptedName || chunkState.metadata.filename;
      // console.log('[DEBUG] 保存群附件到数据库:', { finalName, encryptedName, metadataEncryptedName: chunkState.metadata.encryptedName, metadataFilename: chunkState.metadata.filename });
      const id = crypto.randomUUID();
      const timestamp = utcNow();
      
      await db.insert(schema.group_attachments).values({
        id,
        sessionId,
        name: finalName,
        size: totalSize,
        url: finalKey,
        uploadedBy: user.id,
        uploadedByName: user.name,
        createdAt: timestamp
      });
      
      // console.log('[DEBUG] 群附件保存成功, id:', id);

      return c.json({
        success: true,
        data: {
          id,
          url: finalKey,
          name: finalName,
          size: totalSize,
          uploadedBy: user.id,
          uploadedByName: user.name,
          encrypted: encrypted
        }
      });
    } catch (e: any) {
      console.error('合并群附件失败:', e.message);
      return c.json({ success: false, message: '文件合并失败: ' + e.message }, 500);
    }
  }

  const finalUploadedChunks = await fileManager.getUploadedChunks(uploadId, totalChunks);
  
  return c.json({
    success: true,
    data: {
      resumeId: uploadId,
      uploadedChunks: finalUploadedChunks,
      totalChunks
    }
  });
}

// 删除群附件（只有群主可以删除）
app.delete('/api/group-attachments/:id/delete', auth, csrfProtection, async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param('id');
  const userId = c.get('userId');
  // 初始化数据
  await fileManager.initAsync(db, c.env.R2, c.env.UPLOADS);

  try {
    const user = await db.select()
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .get();
    
    if (!user) {
      return c.json({ success: false, message: '用户不存在' }, 404);
    }
    
    // 获取附件信息
    const attachment = await db.select()
      .from(schema.group_attachments)
      .where(eq(schema.group_attachments.id, id))
      .get();
    
    if (!attachment) {
      return c.json({ success: false, message: '附件不存在' }, 404);
    }
    
    // 检查是否是群主
    const session = await db.select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, attachment.sessionId))
      .get();
    
    if (!session) {
      return c.json({ success: false, message: '群不存在' }, 404);
    }

    // 检查是否是群主
    const ownerIds = JSON.parse(session.ownerIds || '[]');
    if (!ownerIds.includes(user.id)) {
      return c.json({ success: false, message: '只有群主可以删除附件' }, 403);
    }

    // 从存储中删除
    await fileManager.deleteFromStorage(attachment.url);

    // 从数据库删除
    await db.delete(schema.group_attachments).where(eq(schema.group_attachments.id, id));
    
    return c.json({ success: true });
  } catch (e) {
    console.error('删除群附件失败:', e);
    return c.json({ success: false, message: '删除失败' }, 500);
  }
});

export default app;

// ==================== Durable Object ====================

export class ChatRoom implements DurableObject {
  private sessions: Map<string, WebSocket> = new Map();
  private userSessions: Map<string, Set<string>> = new Map();
  private db: ReturnType<typeof drizzle>;
  private messageRateLimit: Map<string, { count: number; resetTime: number }> = new Map();
  
  constructor(private state: DurableObjectState, private env: Bindings) {
    this.db = drizzle(env.DB);
    // 初始化数据
    fileManager.init(this.db, env.R2, env.UPLOADS);
  }
  
  private checkMessageRateLimit(userId: string): { allowed: boolean; remaining: number; resetIn: number } {
    const now = Date.now();
    const WINDOW_MS = 1000;
    const MAX_MESSAGES = 5;
    
    let record = this.messageRateLimit.get(userId);
    
    if (!record || record.resetTime <= now) {
      record = { count: 0, resetTime: now + WINDOW_MS };
    }
    
    record.count++;
    this.messageRateLimit.set(userId, record);
    
    const allowed = record.count <= MAX_MESSAGES;
    const remaining = Math.max(0, MAX_MESSAGES - record.count);
    const resetIn = Math.max(0, record.resetTime - now);
    
    return { allowed, remaining, resetIn };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    
    // 初始化路由
    if (request.method === 'POST' && url.pathname === '/init') {
      return new Response('OK');
    }
    
    if (request.method === 'POST' && url.pathname === '/broadcast') {
      try {
        const body = await request.json();
        const type = body.type;
        const targetUserId = body.data?.userId;

        
        
        if (type === 'conversationsUpdate') {
          // 发送会话列表更新给指定用户或所有人
          if (targetUserId) {
            const targetWs = this.sessions.get(targetUserId);
            
            if (targetWs && targetWs.readyState === WebSocket.OPEN) {
              targetWs.send(JSON.stringify({ type: 'conversationsUpdate', data: {} }));
              
            } else {
              
            }
          } else {
            // 广播给所有在线用户
            const messageStr = JSON.stringify({ type: 'conversationsUpdate', data: {} });
            this.sessions.forEach((ws) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(messageStr);
              }
            });
          }
        } else if (type === 'broadcastToAll') {
          // 广播给所有在线用户（用于系统消息等）
          
          
          const messageStr = JSON.stringify({ type: 'message', data: body.data });
          let sentCount = 0;
          this.sessions.forEach((ws) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(messageStr);
              sentCount++;
            }
          });
          
        } else if (type === 'groupMembersUpdate') {
          // 广播群成员更新给群里所有人
          
          const messageStr = JSON.stringify({ type: 'groupMembersUpdate', data: body.data });
          await this.broadcastToSession(body.data?.groupId, { type: 'groupMembersUpdate', data: body.data });
        } else if (type === 'kickedFromGroup') {
          // 只发给被踢的用户
          
          const targetWs = this.sessions.get(body.data?.targetUserId);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(JSON.stringify({ type: 'kickedFromGroup', data: body.data }));
          }
        } else if (type === 'joinedGroup') {
          // 只发给被加入的用户
          
          const targetWs = this.sessions.get(body.data?.targetUserId);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(JSON.stringify({ type: 'joinedGroup', data: body.data }));
          }
        } else if (type === 'userMuted') {
          // 全局禁言 - 只发给被禁言的用户
          const targetWs = this.sessions.get(body.data?.userId);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(JSON.stringify({ type: 'userMuted', data: body.data }));
          }
        } else if (type === 'userUnmuted') {
          // 解除全局禁言 - 只发给被解除禁言的用户
          const targetWs = this.sessions.get(body.data?.userId);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(JSON.stringify({ type: 'userUnmuted', data: body.data }));
          }
        } else if (type === 'userBanned') {
          // 封禁用户 - 只发给被封禁的用户
          const targetWs = this.sessions.get(body.data?.userId);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(JSON.stringify({ type: 'userBanned', data: body.data }));
          }
        } else if (type === 'forceLogout') {
          // 强制登出 - 只发给被封禁的用户
          const targetWs = this.sessions.get(body.data?.userId);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(JSON.stringify({ type: 'forceLogout', data: body.data }));
            // 主动断开连接
            targetWs.close();
            this.sessions.delete(body.data?.userId);
          }
        } else if (type === 'userUnbanned') {
          // 解除封禁 - 只发给被解除封禁的用户
          const targetWs = this.sessions.get(body.data?.userId);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(JSON.stringify({ type: 'userUnbanned', data: body.data }));
          }
        } else if (type === 'personalSystemMessage') {
          // 针对每个成员发送不同的系统消息，并通知被禁言的人
          const targetUserId = body.targetUserId;
          const shouldNotify = body.notifyTarget;
          const isUnmute = body.data?.content?.includes('解除禁言');
          
          const targetWs = this.sessions.get(targetUserId);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            // 发送系统消息
            const messageStr = JSON.stringify({ type: 'message', data: body.data });
            targetWs.send(messageStr);
            
            // 如果需要通知（被禁言/解除禁言的人），发送通知
            if (shouldNotify) {
              const notifyData = {
                groupId: body.data.sessionId,
                groupName: '', // 前端可以从会话列表获取
                reason: '',
                message: body.data.content
              };
              const notifyType = isUnmute ? 'unmuted' : 'muted';
              const notifyStr = JSON.stringify({ type: notifyType, data: notifyData });
              targetWs.send(notifyStr);
            }
          }
        } else if (type === 'joinRequestSubmitted') {
          // 入群申请 - 发送给所有群主
          // console.log('[DO Broadcast] joinRequestSubmitted received, data:', JSON.stringify(body.data));
          const targetOwnerIds = body.data?.ownerIds || [];
          // console.log('[DO Broadcast] Owner IDs:', targetOwnerIds);
          // console.log('[DO Broadcast] Current sessions:', Array.from(this.sessions.keys()));
          const messageStr = JSON.stringify({ type: 'joinRequestSubmitted', data: body.data });
          for (const ownerId of targetOwnerIds) {
            const targetWs = this.sessions.get(String(ownerId));
            // console.log('[DO Broadcast] Owner:', ownerId, 'found:', !!targetWs);
            if (targetWs && targetWs.readyState === WebSocket.OPEN) {
              targetWs.send(messageStr);
              // console.log('[DO Broadcast] Message sent to owner:', ownerId);
            }
          }
        } else if (type === 'joinRequestApproved') {
          const targetUserId = String(body.data?.userId);
          const targetWs = this.sessions.get(targetUserId);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(JSON.stringify({ type: 'joinRequestApproved', data: body.data }));
          }
        } else if (type === 'joinRequestRejected') {
          const targetWs = this.sessions.get(body.data?.userId);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(JSON.stringify({ type: 'joinRequestRejected', data: body.data }));
          }
        } else {
          // 其他类型的广播
          
          await this.broadcastToSession(body.data?.sessionId, body);
          
        }
      } catch (e) {
        console.error('Broadcast error:', e);
      }
      return new Response('OK');
    }
    
    if (request.method === 'POST' && url.pathname === '/joinSession') {
      try {
        const { userId, sessionId } = await request.json();
        this.joinSession(userId, sessionId);
      } catch {}
      return new Response('OK');
    }
    
    // 通知指定用户
    if (request.method === 'POST' && url.pathname === '/notifySender') {
      try {
        const { targetUserId, message } = await request.json();
        
        
        
        const targetWs = this.sessions.get(targetUserId);
        
        
        
        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
          const messageStr = JSON.stringify(message);
          
          targetWs.send(messageStr);
          
        } else {
          
        }
      } catch (e) {
        console.error('notifySender error:', e);
      }
      return new Response('OK');
    }
    
    if (url.pathname === '/api/ws') {
      return this.handleWebSocket(request);
    }
    
    
    return new Response('Not Found', { status: 404 });
  }
  
  private async joinSession(userId: string, sessionId: string) {
    if (!this.userSessions.has(userId)) {
      this.userSessions.set(userId, new Set());
    }
    this.userSessions.get(userId)!.add(sessionId);
    
    try {
      // 先检查用户是否真的在群里（数据库中是否存在记录）
      const existing = await this.db.select()
        .from(schema.session_participants)
        .where(and(
          eq(schema.session_participants.sessionId, sessionId),
          eq(schema.session_participants.userId, userId)
        ))
        .get();
      
      if (!existing) {
        
        return;
      }
      
      
    } catch (e) {
      console.error('Error adding session participant:', e);
    }
    
    
  }
  
  private shouldSendToUser(userId: string, targetSessionId?: string): boolean {
    if (!targetSessionId) return true; // 没有指定会话，发送给所有人
    const userSessionSet = this.userSessions.get(userId);
    const hasSession = userSessionSet?.has(targetSessionId) || false;
    
    return hasSession;
  }
  
  private async handleWebSocket(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    // WebSocket 认证：通过 URL 参数传递 token
    const token = url.searchParams.get('token');
    
    if (!token) return new Response('Unauthorized', { status: 401 });
    
    // 直接使用环境变量中的 secret
    const jwtSecret = this.env.JWT_SECRET_KEY;
    if (!jwtSecret) {
      console.error('[ChatRoom] JWT_SECRET_KEY not found in env');
      return new Response('Server error', { status: 500 });
    }
    
    const decoded = await verifyToken(token, jwtSecret);
    if (!decoded) return new Response('Invalid token', { status: 401 });
    
    // 验证 Origin
    const origin = request.headers.get('origin');
    const allowedOriginsStr = this.env.ALLOWED_DOMAINS || '';
    const allowedOrigins = allowedOriginsStr ? allowedOriginsStr.split(',').map(d => d.trim()).filter(d => d) : ['*'];
    
    if (origin && !allowedOrigins.includes(origin)) {
      console.warn('[WebSocket] Rejected connection from unauthorized origin:', origin);
      return new Response('Forbidden', { status: 403 });
    }
    
    const { 0: client, 1: server } = new WebSocketPair();
    const userId = decoded.id;
    
    this.sessions.set(userId, client);
    client.accept();
    
    // 异步更新用户状态、广播，并发送离线消息
    (async () => {
      try {
        const db = drizzle(this.env.DB);
        await db.update(schema.users)
          .set({ status: 'online' })
          .where(eq(schema.users.id, userId));
        this.broadcast({
          type: 'userStatus',
          data: { userId, status: 'online' }
        }, userId);

        // 自动将用户加入他参与的所有会话
        const userAllSessions = await db.select()
          .from(schema.session_participants)
          .where(eq(schema.session_participants.userId, userId))
          .all();
        
        for (const us of userAllSessions) {
          this.joinSession(userId, us.sessionId);
        }
        

        // 查询离线消息（排除系统消息和已撤回消息）- 使用 message_reads 表判断已读
        const offlineMessages = await db.select()
          .from(schema.messages)
          .innerJoin(schema.sessions, eq(schema.messages.sessionId, schema.sessions.id))
          .innerJoin(schema.session_participants, eq(schema.sessions.id, schema.session_participants.sessionId))
          .where(and(
            eq(schema.session_participants.userId, userId),
            sql`${schema.messages.senderId} != ${userId}`,
            sql`COALESCE(${schema.messages.recalled}, 0) = 0`,
            sql`COALESCE(${schema.messages.isSystem}, 0) = 0`,
            sql`NOT EXISTS (SELECT 1 FROM message_reads mr WHERE mr.message_id = messages.id AND mr.user_id = ${userId})`
          ))
          .orderBy(schema.messages.time);

        

        // 通过WebSocket发送离线消息给用户（加密内容不解密）
        if (offlineMessages && offlineMessages.length > 0) {
          
          for (const msg of offlineMessages) {
            const sender = await db.select()
              .from(schema.users)
              .where(eq(schema.users.id, msg.messages.senderId))
              .get();
            
            // 获取附件
            const attachments = await db.select()
              .from(schema.attachments)
              .where(eq(schema.attachments.messageId, msg.messages.id))
              .all();
            
            client.send(JSON.stringify({
              type: 'message',
              data: {
                id: msg.messages.id,
                content: msg.messages.content,
                sender: { id: sender?.id, name: sender?.name, avatar: sender?.avatar },
                timestamp: msg.messages.time,
                sessionId: msg.messages.sessionId,
                sessionType: msg.sessions?.type || 'private',
                isEncrypted: !!msg.messages.encrypted,
                attachments: attachments.map(a => ({
                  id: a.id,
                  type: a.type,
                  name: a.name,
                  size: a.size,
                  url: a.url,
                  encrypted: !!a.encrypted
                }))
              }
            }));
          }
        }
        
        // 查询并发送未读通知
        const unreadNotifications = await db.select()
          .from(schema.notifications)
          .where(and(
            eq(schema.notifications.userId, userId),
            eq(schema.notifications.read, 0)
          ))
          .orderBy(schema.notifications.createdAt)
          .all();
        
        if (unreadNotifications && unreadNotifications.length > 0) {
          
          for (const notification of unreadNotifications) {
            const notificationData = {
              type: notification.type,
              title: notification.title,
              content: notification.content,
              data: notification.data ? JSON.parse(notification.data) : {}
            };
            client.send(JSON.stringify(notificationData));
            
            // 标记通知为已读
            await db.update(schema.notifications)
              .set({ read: 1 })
              .where(eq(schema.notifications.id, notification.id));
          }
        }
      } catch (e) {
        console.error('Failed to update user status or send offline messages:', e);
      }
    })();
    
    client.addEventListener('message', async (event) => {
      try {
        const data = JSON.parse(event.data as string);
        
        // 处理心跳 ping
        if (data.type === 'ping') {
          client.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        
        await this.handleMessage(data, userId);
      } catch (e) {
        console.error('[WebSocket message] Error:', e);
      }
    });
    
    client.addEventListener('close', () => {
      this.sessions.delete(userId);
      // 异步更新用户状态和广播（不阻塞WebSocket关闭）
      (async () => {
        try {
          const db = drizzle(this.env.DB);
          
          // 检查用户是否被封禁或禁言，保持相应状态
          const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
          const banRecord = await db.select().from(schema.userBans).where(eq(schema.userBans.userId, userId)).get();
          
          let newStatus = 'offline';
          if (banRecord) {
            newStatus = 'banned';
          } else if (user?.status === 'muted') {
            newStatus = 'muted';
          }
          
          // console.log('[WebSocket Close] userId:', userId);
          // console.log('[WebSocket Close] user.status:', user?.status);
          // console.log('[WebSocket Close] banRecord:', banRecord ? 'exists' : 'none');
          // console.log('[WebSocket Close] newStatus:', newStatus);
          
          await db.update(schema.users)
            .set({ status: newStatus })
            .where(eq(schema.users.id, userId));
            
          // console.log('[WebSocket Close] Status updated to:', newStatus);
          
          this.broadcast({
            type: 'userStatus',
            data: { userId, status: newStatus }
          }, userId);
        } catch (e) {
          console.error('[WebSocket Close] Error:', e);
        }
      })();
    });
    
    client.send(JSON.stringify({ type: 'connected', userId }));
    
    return new Response(null, { status: 101, webSocket: server });
  }
  
  private async handleMessage(data: any, senderId: string) {
    const db = drizzle(this.env.DB);
    
    switch (data.type) {
      case 'joinSession':
        // 用户加入会话
        this.joinSession(senderId, data.sessionId);
        return;
        
      case 'message':
        // 检查用户是否被封禁
        const banCheck = await db.select().from(schema.userBans).where(eq(schema.userBans.userId, senderId)).get();
        if (banCheck) {
          const senderWs = this.sessions.get(senderId);
          if (senderWs) {
            senderWs.send(JSON.stringify({
              type: 'error',
              data: { code: 'BANNED', message: '您已被封禁，无法发送消息' }
            }));
          }
          return;
        }
        
        // 检查用户是否被全局禁言
        const userCheck = await db.select().from(schema.users).where(eq(schema.users.id, senderId)).get();
        if (userCheck && userCheck.status === 'muted') {
          const senderWs = this.sessions.get(senderId);
          if (senderWs) {
            senderWs.send(JSON.stringify({
              type: 'error',
              data: { code: 'MUTED', message: '您已被禁言，无法发送消息' }
            }));
          }
          return;
        }
        
        // WebSocket消息限流检查
        const rateLimit = this.checkMessageRateLimit(senderId);
        if (!rateLimit.allowed) {
          const senderWs = this.sessions.get(senderId);
          if (senderWs) {
            senderWs.send(JSON.stringify({
              type: 'error',
              data: { code: 'RATE_LIMIT', message: '发送消息过于频繁，请稍后再试', resetIn: rateLimit.resetIn }
            }));
          }
          return;
        }
        
        const messageId = crypto.randomUUID();
        // 始终使用服务器时间，不接受客户端时间戳，确保排序正确
        const now = utcNow();
        // 确保发送者被添加到会话参与者
        await db.insert(schema.session_participants)
          .values({ sessionId: data.sessionId, userId: senderId })
          .onConflictDoNothing();
        
        // 前端已经处理加密，后端直接存储
        const storedContent = data.content || '';
        const isEncrypted = data.isEncrypted ? 1 : 0;
        
        await db.insert(schema.messages).values({
          id: messageId,
          sessionId: data.sessionId,
          senderId: senderId,
          content: storedContent,
          encrypted: isEncrypted,
          type: data.type || 1,
          time: now,
          quote_id: data.quoteId || null,
          replyToId: data.quoteId || null,
          burnAfterReading: data.burnAfterReading ? 1 : 0
        });
        
        
        
        await db.update(schema.sessions)
          .set({ lastMessage: data.content?.substring(0, 100) || '', lastTime: now, lastMessageEncrypted: isEncrypted })
          .where(eq(schema.sessions.id, data.sessionId));
        
        // 更新聊天统计
        const todayStart = Math.floor(now / (24 * 60 * 60 * 1000)) * (24 * 60 * 60 * 1000);
        const existingChatStat = await db.select()
          .from(schema.chatStats)
          .where(and(
            eq(schema.chatStats.userId, senderId),
            eq(schema.chatStats.chatDate, todayStart)
          ))
          .get();
        
        if (existingChatStat) {
          const currentCount = Number(existingChatStat.messageCount) || 0;
          await db.update(schema.chatStats)
            .set({ messageCount: currentCount + 1 })
            .where(eq(schema.chatStats.id, existingChatStat.id));
        } else {
          await db.insert(schema.chatStats).values({
            id: crypto.randomUUID(),
            userId: senderId,
            sessionId: data.sessionId,
            messageCount: 1,
            chatDate: todayStart
          });
        }
        
        // 保存附件到数据库
        if (data.attachments && data.attachments.length > 0) {
          
          for (const att of data.attachments) {
            try {
              await db.insert(schema.attachments).values({
                id: crypto.randomUUID(),
                messageId: messageId,
                type: att.type,
                name: att.name, // 保存原始文件名
                size: att.size,
                url: att.url,
                encrypted: att.encrypted ? 1 : 0
              });
              
            } catch (e) {
              console.error('[HandleMessage] Failed to save attachment:', e);
            }
          }
        }
        
        // 从数据库获取保存后的附件信息
        
        const savedAttachments = await db.select()
          .from(schema.attachments)
          .where(eq(schema.attachments.messageId, messageId))
          .all();
        
        
        const sender = await db.select()
          .from(schema.users)
          .where(eq(schema.users.id, senderId))
          .get();
        
        
        // 获取回复的消息信息
        let replyTo = null;
        if (data.quoteId) {
          const repliedMsg = await db.select()
            .from(schema.messages)
            .where(eq(schema.messages.id, data.quoteId))
            .get();
          if (repliedMsg) {
            const repliedUser = await db.select()
              .from(schema.users)
              .where(eq(schema.users.id, repliedMsg.senderId))
              .get();
            replyTo = {
              id: repliedMsg.id,
              content: repliedMsg.content,
              sender: { id: repliedUser?.id, name: repliedUser?.name }
            };
          }
        }
        
        // 发送消息给会话中的所有在线用户（包括发送方自己，用于确认）
        
        // 获取会话类型
        const session = await db.select().from(schema.sessions).where(eq(schema.sessions.id, data.sessionId)).get();
        
        const messageData = {
          id: messageId,
          content: storedContent,
          sender: { id: sender?.id, name: sender?.name, avatar: sender?.avatar },
          timestamp: now,
          sessionId: data.sessionId,
          sessionType: session?.type || 'private',
          isEncrypted: !!isEncrypted,
          replyTo,
          burnAfterReading: data.burnAfterReading,
          attachments: savedAttachments.map(a => ({
            id: a.id,
            type: a.type,
            name: a.name,
            size: a.size,
            url: a.url,
            encrypted: !!a.encrypted
          }))
        };
        
        
        // 广播消息给会话中的其他人（排除发送者，发送者已经在本地显示消息）
        await this.broadcastToSession(data.sessionId, {
          type: 'message',
          data: messageData
        }, senderId); // 排除发送者
        
        // 给会话中的每个用户广播他们的未读数（排除发送者）
        const participants = await db.select()
          .from(schema.session_participants)
          .where(eq(schema.session_participants.sessionId, data.sessionId))
          .all();
        
        for (const p of participants) {
          if (p.userId === senderId) continue; // 排除发送者
          
          // 计算该用户的未读数
          const unreadResult = await db.select({ count: sql<number>`count(*)` })
            .from(schema.messages)
            .where(and(
              eq(schema.messages.sessionId, data.sessionId),
              sql`${schema.messages.senderId} != ${p.userId}`,
              eq(schema.messages.isSystem, 0),
              eq(schema.messages.recalled, 0),
              sql`NOT EXISTS (SELECT 1 FROM message_reads mr WHERE mr.message_id = messages.id AND mr.user_id = ${p.userId})`
            ))
            .get();
          
          // 发送未读数更新给该用户
          const targetWs = this.sessions.get(p.userId);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(JSON.stringify({
              type: 'unreadUpdate',
              data: {
                sessionId: data.sessionId,
                unread: unreadResult?.count || 0
              }
            }));
          }
        }
        
        // 发送确认给发送方
        const senderWs = this.sessions.get(senderId);
        if (senderWs && senderWs.readyState === WebSocket.OPEN) {
          senderWs.send(JSON.stringify({
            type: 'messageSent',
            data: { id: messageId, time: now, tempId: data.clientMessageId }
          }));
        }
        break;
        
      case 'markRead':
        const now2 = utcNow();
        
        // 获取读者信息
        const readerUser = await db.select().from(schema.users).where(eq(schema.users.id, senderId)).get();
        const readerName = readerUser?.name || '未知';
        
        // 标记消息为已读
        const messageIds = data.messageIds;
        for (const msgId of messageIds) {
          await db.insert(schema.message_reads)
            .values({ messageId: msgId, userId: senderId, read_at: now2 })
            .onConflictDoNothing();
        }
        
        // 广播给会话中的所有人（包括发送已读信号的人，用于更新发送者的消息状态）
        await this.broadcastToSession(data.sessionId, {
          type: 'messagesRead',
          data: { readerId: senderId, readerName, sessionId: data.sessionId, messageIds: data.messageIds }
        }, undefined); // 不排除任何人
        
        // 重新计算并推送未读数给会话中的所有参与者
        const sessionParticipants = await db.select()
          .from(schema.session_participants)
          .where(eq(schema.session_participants.sessionId, data.sessionId))
          .all();
        
        for (const p of sessionParticipants) {
          // 计算该用户的未读数
          const unreadResult = await db.select({ count: sql<number>`count(*)` })
            .from(schema.messages)
            .where(and(
              eq(schema.messages.sessionId, data.sessionId),
              sql`${schema.messages.senderId} != ${p.userId}`,
              eq(schema.messages.isSystem, 0),
              eq(schema.messages.recalled, 0),
              sql`NOT EXISTS (SELECT 1 FROM message_reads mr WHERE mr.message_id = messages.id AND mr.user_id = ${p.userId})`
            ))
            .get();
          
          // 发送未读数更新给该用户
          const targetWs = this.sessions.get(p.userId);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(JSON.stringify({
              type: 'unreadUpdate',
              data: {
                sessionId: data.sessionId,
                unread: unreadResult?.count || 0
              }
            }));
          }
        }
        break;

      case 'messageRecalled':
        const recalledMsg = await db.select()
          .from(schema.messages)
          .where(eq(schema.messages.id, data.messageId))
          .get();
        
        
        
        if (recalledMsg) {
          const isActor = String(recalledMsg.senderId) === String(data.senderId);
          const displayForDeleter = '你撤回了一条消息';
          const displayForOther = `${data.senderName || '对方'} 撤回了一条消息`;
          
          // 删除R2中的附件文件
          const recalledAttachments = await db.select()
            .from(schema.attachments)
            .where(eq(schema.attachments.messageId, data.messageId))
            .all();
          for (const att of recalledAttachments) {
            try {
              const fileKey = att.url;
              if (fileKey) {
                // 撤回消息删除存储的文件
                await fileManager.deleteFromStorage(fileKey);
              }
            } catch (e) {
              console.error('Failed to delete R2 file:', e);
            }
          }
          await db.delete(schema.attachments).where(eq(schema.attachments.messageId, data.messageId));
          
          await db.update(schema.messages)
            .set({
              content: `${displayForDeleter}|${displayForOther}`,
              isSystem: 1,
              recalled: 1,
              encrypted: 0,
              senderId: data.senderId
            })
            .where(eq(schema.messages.id, data.messageId));
          
          // 验证更新
          const updated = await db.select().from(schema.messages).where(eq(schema.messages.id, data.messageId)).get();
          
        }
        
        await this.broadcastToSession(data.sessionId, {
          type: 'messageRecalled',
          data: {
            messageId: data.messageId,
            sessionId: data.sessionId,
            originalSenderId: data.senderId,
            actorId: data.senderId,
            actorName: data.senderName
          }
        });
        
        break;

      case 'messageDeleted':
        
        const deletedMsg = await db.select()
          .from(schema.messages)
          .where(eq(schema.messages.id, data.messageId))
          .get();
        
        if (deletedMsg) {
          // 检查消息发送者是否开启了"不允许删除"设置
          if (String(deletedMsg.senderId) !== String(senderId)) {
            // 检查删除者是否是管理员（管理员可以删除任何消息）
            const deleter = await db.select().from(schema.users).where(eq(schema.users.id, senderId)).get();
            const isAdmin = deleter?.role === 'admin' || deleter?.role === 'superadmin';
            
            if (!isAdmin) {
              const senderSettings = await db.select()
                .from(schema.userSettings)
                .where(eq(schema.userSettings.userId, deletedMsg.senderId))
                .get();
              
              if (senderSettings?.cannotDelete === 1) {
                // 发送者开启了不允许删除，通知用户
                const senderWs = this.sessions.get(String(senderId));
                if (senderWs && senderWs.readyState === WebSocket.OPEN) {
                  senderWs.send(JSON.stringify({
                    type: 'deleteBlocked',
                    data: {
                      messageId: data.messageId,
                      reason: 'cannot_delete'
                    }
                  }));
                }
                break; // 阻止删除
              }
            }
          } else {
            // console.log('[messageDeleted] Sender is deleting own message, allowed');
          }
          
          const displayForDeleter = '你删除了这条消息';
          const displayForOther = `${data.senderName || '对方'} 删除了你的一条消息`;
          
          // 删除R2中的附件文件
          const deletedAttachments = await db.select()
            .from(schema.attachments)
            .where(eq(schema.attachments.messageId, data.messageId))
            .all();
          for (const att of deletedAttachments) {
            try {
              const fileKey = att.url;
              if (fileKey) {
                // 撤回消息删除存储的文件
                await fileManager.deleteFromStorage(fileKey);
              }
            } catch (e) {
              console.error('Failed to delete R2 file:', e);
            }
          }
          await db.delete(schema.attachments).where(eq(schema.attachments.messageId, data.messageId));
          
          await db.update(schema.messages)
            .set({
              content: `${displayForDeleter}|${displayForOther}`,
              isSystem: 1,
              isDeleted: 1,
              encrypted: 0,
              senderId: data.senderId
            })
            .where(eq(schema.messages.id, data.messageId));
        }
        
        await this.broadcastToSession(data.sessionId, {
          type: 'messageDeleted',
          data: {
            messageId: data.messageId,
            sessionId: data.sessionId,
            originalSenderId: data.senderId,
            actorId: data.senderId,
            actorName: data.senderName
          }
        });
        break;

      case 'typing':
        const typingUser = await db.select()
          .from(schema.users)
          .where(eq(schema.users.id, senderId))
          .get();
        
        this.broadcastToSession(data.sessionId, {
          type: 'typing',
          data: {
            userId: senderId,
            userName: typingUser?.name || '未知',
            sessionId: data.sessionId
          }
        }, senderId);
        break;

      case 'burnAfterRead':
        const burnMsg = await db.select()
          .from(schema.messages)
          .where(eq(schema.messages.id, data.messageId))
          .get();
        
        if (burnMsg) {
          const burnViewer = await db.select()
            .from(schema.users)
            .where(eq(schema.users.id, senderId))
            .get();
          
          const viewerName = burnViewer?.name || '对方';
          
          // 删除原阅后即焚消息的附件
          const burnAttachments = await db.select()
            .from(schema.attachments)
            .where(eq(schema.attachments.messageId, data.messageId))
            .all();
          for (const att of burnAttachments) {
            try {
              if (att.url) {
                await fileManager.deleteFromStorage(att.url);
              }
            } catch (e) {
              console.error('Failed to delete R2 file:', e);
            }
          }
          await db.delete(schema.attachments).where(eq(schema.attachments.messageId, data.messageId));
          
          // 将原消息标记为已删除
          await db.update(schema.messages)
            .set({
              content: `${viewerName} 已查看阅后即焚的消息`,
              isSystem: 1,
              isDeleted: 1,
              encrypted: 0,
              senderId: senderId
            })
            .where(eq(schema.messages.id, data.messageId));
          
          // 只发送一个事件：发送者收到 burnAfterRead，其他人收到 messageDeleted
          const messageStr = JSON.stringify({
            type: 'messageDeleted',
            data: {
              messageId: data.messageId,
              sessionId: data.sessionId,
              originalSenderId: burnMsg.senderId,
              actorId: senderId,
              actorName: viewerName,
              isBurnAfterRead: true
            }
          });
          
          // 发送给所有会话参与者（包括查看者）
          const broadcastData = {
            type: 'messageDeleted',
            data: {
              messageId: data.messageId,
              sessionId: data.sessionId,
              originalSenderId: burnMsg.senderId,
              actorId: senderId,
              actorName: viewerName,
              isBurnAfterRead: true
            }
          };
          
          await this.broadcastToSession(data.sessionId, broadcastData, senderId); // 排除查看者，不发送 messageDeleted
          
          // 单独通知发送者 burnAfterRead 事件
          const senderWs = this.sessions.get(burnMsg.senderId);
          if (senderWs && senderWs.readyState === WebSocket.OPEN) {
            senderWs.send(JSON.stringify({
              type: 'burnAfterRead',
              data: {
                messageId: data.messageId,
                sessionId: data.sessionId,
                originalSenderId: burnMsg.senderId,
                viewerId: senderId,
                viewerName: viewerName
              }
            }));
          }
        }
        break;
        
      case 'conversationsUpdate':
        // 通知指定用户刷新会话列表
        if (data.data?.userId) {
          const targetWs = this.sessions.get(data.data.userId);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(JSON.stringify({ type: 'conversationsUpdate', data: {} }));
          }
        } else {
          // 广播给所有人
          this.broadcast({ type: 'conversationsUpdate', data: {} });
        }
        break;
        
      case 'newReport':
        // 广播新举报通知给所有连接的用户
        // console.log('[newReport] 广播给所有用户，当前连接数:', this.sessions.size);
        this.broadcast({ type: 'newReport', data: data.data });
        break;
    }
  }
  
  private broadcast(message: any, excludeUserId?: string) {
    const messageStr = JSON.stringify(message);
    this.sessions.forEach((ws, userId) => {
      if (userId !== excludeUserId && ws.readyState === WebSocket.OPEN) {
        ws.send(messageStr);
      }
    });
  }
  
  private async broadcastToSession(sessionId: string | undefined, message: any, excludeUserId?: string) {
    const messageStr = JSON.stringify(message);
    
    
    if (!sessionId) {
      // 没有指定会话，广播给所有人
      this.sessions.forEach((ws, userId) => {
        if (userId !== excludeUserId && ws.readyState === WebSocket.OPEN) {
          ws.send(messageStr);
        }
      });
      return;
    }
    
    // 直接从数据库查询会话参与者，而不是依赖内存中的 userSessions
    try {
      const participants = await this.db.select()
        .from(schema.session_participants)
        .where(eq(schema.session_participants.sessionId, sessionId))
        .all();
      
      
      
      
      for (const p of participants) {
        if (p.userId === excludeUserId) continue;
        
        const ws = this.sessions.get(p.userId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(messageStr);
          
        } else {
          
        }
      }
    } catch (e) {
      console.error('[broadcastToSession] Error:', e);
      // 如果数据库查询失败，回退到使用 userSessions
      
      this.sessions.forEach((ws, userId) => {
        const shouldSend = this.shouldSendToUser(userId, sessionId);
        if (shouldSend && ws.readyState === WebSocket.OPEN && userId !== excludeUserId) {
          ws.send(messageStr);
        }
      });
    }
  }
}

// ==================== 统计API ====================

// 获取登录统计
app.get('/api/stats/login', auth, async (c) => {
  try {
    const db = drizzle(c.env.DB);
    const userId = c.get('userId');
    
    const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
    const isAdminOrVip = user?.role === 'admin' || user?.role === 'vip';
    
    const { days = '30' } = c.req.query();
    const daysNum = parseInt(days);
    const startTime = utcNow() - daysNum * 24 * 60 * 60 * 1000;
    
    const startTimeSec = Math.floor(startTime / 1000);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayStartSec = Math.floor(todayStart.getTime() / 1000);
    
    let stats;
    let summary = { totalUsers: 0, loggedInToday: 0, notLoggedIn: 0 };
    
    // 生成完整日期范围
    const generateDateRange = (startSec: number, endSec: number) => {
      const dates: { date: string; count: number }[] = [];
      const current = new Date(startSec * 1000);
      const end = new Date(endSec * 1000);
      while (current <= end) {
        const dateStr = current.toISOString().split('T')[0];
        dates.push({ date: dateStr, count: 0 });
        current.setDate(current.getDate() + 1);
      }
      return dates;
    };
    
    const endTimeSec = Math.floor(utcNow() / 1000);
    const fullDateRange = generateDateRange(startTimeSec, endTimeSec);
    
    if (isAdminOrVip) {
      const startTimeMs = startTime;
      const todayStartMs = todayStart.getTime();
      const [statsResult, totalUsersResult, loggedInUsersResult, loggedInTodayResult] = await Promise.all([
        db.select({
          date: sql<string>`date(datetime(login_at / 1000, 'unixepoch'))`,
          count: sql<number>`count(DISTINCT user_id)`
        })
        .from(schema.loginStats)
        .where(sql`${schema.loginStats.loginAt} >= ${startTimeMs}`)
        .groupBy(sql`date(datetime(login_at / 1000, 'unixepoch'))`)
        .orderBy(sql`date(datetime(login_at / 1000, 'unixepoch'))`)
        .all(),
        db.select({ cnt: sql<number>`count(*)` }).from(schema.users).all(),
        db.select({ cnt: sql<number>`count(DISTINCT user_id)` }).from(schema.loginStats).where(sql`login_at >= ${startTimeMs}`).all(),
        db.select({ cnt: sql<number>`count(DISTINCT user_id)` }).from(schema.loginStats).where(sql`login_at >= ${todayStartMs}`).all()
      ]);
      
      const totalUsers = totalUsersResult[0]?.cnt || 0;
      const loggedInUsers = loggedInUsersResult[0]?.cnt || 0;
      const loggedInToday = loggedInTodayResult[0]?.cnt || 0;
      
      // 从未登录的用户数量（lastLoginAt 为 0 或 null）
      const notLoggedInResult = await db.select({ cnt: sql<number>`count(*)` })
        .from(schema.users)
        .where(or(
          sql`${schema.users.lastLoginAt} IS NULL`,
          sql`${schema.users.lastLoginAt} = 0`
        ))
        .all();
      const notLoggedIn = notLoggedInResult[0]?.cnt || 0;
      
      // 合并数据
      const statsMap = new Map(statsResult.map(s => [s.date, s.count]));
      stats = fullDateRange.map(d => ({
        date: d.date,
        count: statsMap.get(d.date) || 0
      }));
      
      summary = {
        totalUsers,
        loggedInToday,
        notLoggedIn
      };
    } else {
      stats = await db.select({
        date: sql<string>`date(datetime(login_at / 1000, 'unixepoch'))`,
        count: sql<number>`count(*)`
      })
      .from(schema.loginStats)
      .where(and(
        sql`${schema.loginStats.loginAt} >= ${startTime}`,
        eq(schema.loginStats.userId, userId)
      ))
      .groupBy(sql`date(datetime(login_at / 1000, 'unixepoch'))`)
      .orderBy(sql`date(datetime(login_at / 1000, 'unixepoch'))`)
      .all();
      
      // 普通用户也填充完整日期
      const statsMap = new Map(stats.map(s => [s.date, s.count]));
      stats = fullDateRange.map(d => ({
        date: d.date,
        count: statsMap.get(d.date) || 0
      }));
    }
    
    return c.json({ success: true, data: stats, isAdmin: isAdminOrVip, summary });
  } catch (e: any) {
    console.error('Login stats error:', e);
    return c.json({ success: false, message: '获取登录统计失败: ' + e.message }, 500);
  }
});

// 获取聊天频率统计
app.get('/api/stats/chat', auth, async (c) => {
  try {
    const db = drizzle(c.env.DB);
    const userId = c.get('userId');
    
    const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
    const isAdminOrVip = user?.role === 'admin' || user?.role === 'vip';
    
    const { days = '30' } = c.req.query();
    const daysNum = parseInt(days);
    const startTime = utcNow() - daysNum * 24 * 60 * 60 * 1000;
    
    // 生成完整日期范围
    const generateDateRange = (startSec: number, endSec: number) => {
      const dates: { date: string; count: number }[] = [];
      const current = new Date(startSec * 1000);
      const end = new Date(endSec * 1000);
      while (current <= end) {
        const dateStr = current.toISOString().split('T')[0];
        dates.push({ date: dateStr, count: 0 });
        current.setDate(current.getDate() + 1);
      }
      return dates;
    };
    
    const endTimeMs = utcNow();
    const startTimeSec = Math.floor(startTime / 1000);
    const endTimeSec = Math.floor(endTimeMs / 1000);
    const fullDateRange = generateDateRange(startTimeSec, endTimeSec);
    
    // 管理员和VIP可以查看所有人的统计，普通用户只能看自己的
    // 日期使用北京时间（+8小时）
    const dateExpr = sql<string>`date(datetime(chat_date/1000, 'unixepoch', '+8 hours'))`;
    let stats;
    if (isAdminOrVip) {
      stats = await db.select({
        date: dateExpr,
        count: sql<number>`sum(message_count)`
      })
      .from(schema.chatStats)
      .where(sql`${schema.chatStats.chatDate} >= ${startTime}`)
      .groupBy(dateExpr)
      .orderBy(dateExpr)
      .all();
    } else {
      stats = await db.select({
        date: dateExpr,
        count: sql<number>`sum(message_count)`
      })
      .from(schema.chatStats)
      .where(and(
        sql`${schema.chatStats.chatDate} >= ${startTime}`,
        eq(schema.chatStats.userId, userId)
      ))
      .groupBy(dateExpr)
      .orderBy(dateExpr)
      .all();
    }
    
    // 填充完整日期范围
    const statsMap = new Map(stats.map(s => [s.date, Number(s.count) || 0]));
    stats = fullDateRange.map(d => ({
      date: d.date,
      count: statsMap.get(d.date) || 0
    }));
    
    return c.json({ success: true, data: stats, isAdmin: isAdminOrVip });
  } catch (e: any) {
    console.error('Chat stats error:', e);
    return c.json({ success: false, message: '获取聊天统计失败: ' + e.message }, 500);
  }
});

// 修改用户角色
app.put('/api/admin/users/:id/role', adminAuth, csrfProtection, async (c) => {
  const db = drizzle(c.env.DB);
  const targetUserId = c.req.param('id');
  const { role } = await c.req.json();
  
  await db.update(schema.users).set({ role }).where(eq(schema.users.id, targetUserId));
  
  return c.json({ success: true, message: '角色已更新' });
});

// 全局禁言用户
app.post('/api/admin/users/:id/global-mute', adminAuth, csrfProtection, async (c) => {
  const db = drizzle(c.env.DB);
  const targetUserId = c.req.param('id');
  const { reason } = await c.req.json();
  
  await db.update(schema.users).set({ accountStatus: 'muted' }).where(eq(schema.users.id, targetUserId));
  
  // 保存通知到数据库
  const notificationId = `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  await db.insert(schema.notifications).values({
    id: notificationId,
    userId: targetUserId,
    type: 'system',
    title: '全局禁言',
    content: `您已被管理员全局禁言${reason ? `，原因：${reason}` : '，禁止发送消息'}`,
    data: JSON.stringify({ reason }),
    read: 0,
    createdAt: Date.now()
  });
  
  // 通过 WebSocket 通知被禁言用户
  try {
    const chatId = c.env.CHAT.idFromName('global');
    const chatStub = c.env.CHAT.get(chatId);
    await chatStub.fetch('https://dummy/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'userMuted',
        data: { userId: targetUserId, reason: reason || '' }
      })
    });
  } catch (e) {
    console.error('[global-mute] Broadcast error:', e);
  }
  
  return c.json({ success: true, message: '用户已被全局禁言' });
});

// 解除全局禁言
app.delete('/api/admin/users/:id/global-mute', adminAuth, csrfProtection, async (c) => {
  const db = drizzle(c.env.DB);
  const targetUserId = c.req.param('id');
  
  await db.update(schema.users).set({ accountStatus: 'normal' }).where(eq(schema.users.id, targetUserId));
  
  // 保存通知到数据库
  const notificationId = `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  await db.insert(schema.notifications).values({
    id: notificationId,
    userId: targetUserId,
    type: 'system',
    title: '解除禁言',
    content: '您已被解除全局禁言，可以正常发言了',
    data: '{}',
    read: 0,
    createdAt: Date.now()
  });
  
  // 通过 WebSocket 通知被解除禁言用户
  try {
    const chatId = c.env.CHAT.idFromName('global');
    const chatStub = c.env.CHAT.get(chatId);
    await chatStub.fetch('https://dummy/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'userUnmuted',
        data: { userId: targetUserId }
      })
    });
  } catch (e) {
    console.error('[global-unmute] Broadcast error:', e);
  }
  
  return c.json({ success: true, message: '已解除全局禁言' });
});

// ==================== 用户封禁管理 ====================

// 封禁用户
app.post('/api/admin/bans', adminAuth, csrfProtection, async (c) => {
  const db = drizzle(c.env.DB);
  const { userId, reason } = await c.req.json();
  const adminId = c.get('adminId');
  
  if (!userId) {
    return c.json({ success: false, message: '用户ID不能为空' }, 400);
  }
  
  // 检查用户是否已存在
  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user) {
    return c.json({ success: false, message: '用户不存在' }, 404);
  }
  
  // 检查是否已被封禁
  const existingBan = await db.select().from(schema.userBans).where(eq(schema.userBans.userId, userId)).get();
  if (existingBan) {
    return c.json({ success: false, message: '该用户已被封禁' }, 400);
  }
  
  await db.insert(schema.userBans).values({
    id: crypto.randomUUID(),
    userId,
    reason: reason || '',
    bannedBy: adminId,
    createdAt: utcNow()
  });
  
  // 更新用户账号状态为已封禁
  await db.update(schema.users).set({ accountStatus: 'banned' }).where(eq(schema.users.id, userId));
  
  // 通过 WebSocket 通知被封禁用户并强制登出
  try {
    const chatId = c.env.CHAT.idFromName('global');
    const chatStub = c.env.CHAT.get(chatId);
    await chatStub.fetch('https://dummy/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'forceLogout',
        data: { userId, reason: reason || '', message: '您的账号已被封禁' }
      })
    });
  } catch (e) {
    console.error('[ban] Broadcast error:', e);
  }
  
  return c.json({ success: true, message: '用户已被封禁' });
});

// 解除封禁
app.delete('/api/admin/bans/:userId', adminAuth, csrfProtection, async (c) => {
  const db = drizzle(c.env.DB);
  const userId = c.req.param('userId');
  
  await db.delete(schema.userBans).where(eq(schema.userBans.userId, userId));
  
  // 更新用户账号状态为正常
  await db.update(schema.users).set({ accountStatus: 'normal' }).where(eq(schema.users.id, userId));
  
  // 通过 WebSocket 通知被解除封禁用户
  try {
    const chatId = c.env.CHAT.idFromName('global');
    const chatStub = c.env.CHAT.get(chatId);
    await chatStub.fetch('https://dummy/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'userUnbanned',
        data: { userId }
      })
    });
  } catch (e) {
    console.error('[unban] Broadcast error:', e);
  }
  
  return c.json({ success: true, message: '已解除封禁' });
});

// ==================== 网站配置 ====================

// 获取网站配置
app.get('/api/site/config', async (c) => {
  const siteConfig = {
    title: c.env.SITE_TITLE || 'Lumen Chat',
    description: c.env.SITE_DESCRIPTION || '安全加密的即时通讯应用',
    favicon: c.env.SITE_FAVICON || '/logo.svg',
    logo: c.env.SITE_LOGO || '/logo.svg',
    version: c.env.SITE_VERSION || '1.0.0'
  };
  
  return c.json({ success: true, data: siteConfig });
});
