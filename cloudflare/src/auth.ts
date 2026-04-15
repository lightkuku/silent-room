/**
 * JWT Token 认证工具
 */

const JWT_EXPIRES_IN = 3 * 24 * 60 * 60 * 1000;

type TokenPayload = {
  id: string;
  username?: string;
  role?: string;
  iat: number;
  exp: number;
};

// Base64 URL 编码
function base64UrlEncode(str: string): string {
  return btoa(str)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

// Base64 URL 解码
function base64UrlDecode(str: string): string {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return atob(s);
}

// HMAC SHA-256 签名
async function sign(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(data);
  
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
  const bytes = new Uint8Array(signature);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return base64UrlEncode(binary);
}

// 密码哈希 salt - 从环境变量读取，生产环境必须设置
export function getPasswordSalt(env?: { PASSWORD_SALT?: string }): string {
  if (!env.PASSWORD_SALT) {
  	throw new Error('PASSWORD_SALT is not configured. Please set it using wrangler secret put PASSWORD_SALT');
  }
  return env?.PASSWORD_SALT;
}

// 固定的二次加密盐
const SECONDARY_SALT = 'silent-room-secondary-salt-2024';

// 密码哈希公共函数 - 使用 PBKDF2
export async function hashPassword(password: string, env?: { PASSWORD_SALT?: string }): Promise<string> {
  const salt = getPasswordSalt(env);
  const encoder = new TextEncoder();
  
  // 第一次：PBKDF2(password, salt)
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  
  const firstHash = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: encoder.encode(salt),
      iterations: 100000,
      hash: 'SHA-256'
    },
    passwordKey,
    256
  );
  
  // 第二次：用固定盐再哈希一次
  const firstHashArray = new Uint8Array(firstHash);
  const secondData = encoder.encode(SECONDARY_SALT);
  const combined = new Uint8Array(firstHashArray.length + secondData.length);
  combined.set(firstHashArray);
  combined.set(secondData, firstHashArray.length);
  const secondHash = await crypto.subtle.digest('SHA-256', combined);
  const hashArray = Array.from(new Uint8Array(secondHash));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// 密码比较公共函数
export async function comparePassword(password: string, storedPassword: string, env?: { PASSWORD_SALT?: string }): Promise<boolean> {
  if (!password || !storedPassword) return false;
  
  // 计算输入密码的哈希
  const hashedInput = await hashPassword(password, env);
  
  if (hashedInput.length === storedPassword.length) {
    let result = 0;
    for (let i = 0; i < hashedInput.length; i++) {
      result |= hashedInput.charCodeAt(i) ^ storedPassword.charCodeAt(i);
    }
    return result === 0;
  }
  
  return false;
}

let jwtSecret: string | null = null;
let csrfSecret: string | null = null;

export function setAuthSecrets(jwt?: string, csrf?: string) {
  if (jwt && jwt.trim()) {
    jwtSecret = jwt.trim();
  }
  if (csrf && csrf.trim()) {
    csrfSecret = csrf.trim();
  }
}

export function getJwtSecret(): string {
  if (!jwtSecret) {
    throw new Error('JWT_SECRET_KEY is not configured. Please set it using wrangler secret put JWT_SECRET_KEY');
  }
  return jwtSecret;
}

export function getCsrfSecret(): string {
  if (!csrfSecret) {
    throw new Error('CSRF_SECRET_KEY is not configured. Please set it using wrangler secret put CSRF_SECRET_KEY');
  }
  return csrfSecret;
}

// 生成 JWT Token
export async function generateToken(payload: Omit<TokenPayload, 'iat' | 'exp'>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: TokenPayload = {
    ...payload,
    iat: now,
    exp: now + Math.floor(JWT_EXPIRES_IN / 1000)
  };
  
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payloadStr = base64UrlEncode(JSON.stringify(fullPayload));
  const signature = await sign(`${header}.${payloadStr}`, getJwtSecret());
  
  return `${header}.${payloadStr}.${signature}`;
}

// 验证 JWT Token
export async function verifyToken(token: string, secret?: string): Promise<TokenPayload | null> {
  try {
    const tokenStr = token.replace(/^Bearer\s+/i, '').trim();
    
    const parts = tokenStr.split('.');
    if (parts.length !== 3) {
      console.error('[JWT] Invalid token format, parts:', parts.length);
      return null;
    }
    
    const [headerB64, payloadB64, signatureB64] = parts;
    
    // 如果传入了 secret 参数，直接使用
    const jwtSecretValue = secret || getJwtSecret();
    const expectedSignature = await sign(`${headerB64}.${payloadB64}`, jwtSecretValue);
    
    if (expectedSignature !== signatureB64) {
      console.error('[JWT] Invalid signature');
      return null;
    }
    
    const payload = JSON.parse(base64UrlDecode(payloadB64)) as TokenPayload;
    
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      console.error('[JWT] Token expired, exp:', payload.exp, 'now:', now);
      return null;
    }
    
    return payload;
  } catch (e) {
    console.error('[JWT] Token verification failed:', e);
    return null;
  }
}

export type { TokenPayload };

// ==================== CSRF Token ====================

type CsrfPayload = {
  userId: string;
  iat: number;
  exp: number;
};

const CSRF_EXPIRES_IN = 60 * 60 * 1000;

export async function generateCsrfToken(userId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: CsrfPayload = {
    userId,
    iat: now,
    exp: now + Math.floor(CSRF_EXPIRES_IN / 1000)
  };
  
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'CSRF' }));
  const payloadStr = base64UrlEncode(JSON.stringify(payload));
  const signature = await sign(`${header}.${payloadStr}`, getCsrfSecret());
  
  return `${header}.${payloadStr}.${signature}`;
}

export async function verifyCsrfToken(token: string, userId: string): Promise<boolean> {
  try {
    const tokenStr = token.replace(/^Bearer\s+/i, '').trim();
    
    const parts = tokenStr.split('.');
    if (parts.length !== 3) return false;
    
    const [headerB64, payloadB64, signatureB64] = parts;
    
    const expectedSignature = await sign(`${headerB64}.${payloadB64}`, getCsrfSecret());
    if (expectedSignature !== signatureB64) {
      console.error('[CSRF] Invalid signature');
      return false;
    }
    
    const payload = JSON.parse(base64UrlDecode(payloadB64)) as CsrfPayload;
    
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      console.error('[CSRF] Token expired');
      return false;
    }
    
    return payload.userId === userId;
  } catch {
    console.error('[CSRF] Token verification failed');
    return false;
  }
}
