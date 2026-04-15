import { API } from '../config/api'
import { apiFetch } from './csrf';

export interface NotificationSettings {
  messageSound: number;
  groupMention: number;
  onlineNotify: number;
  offlineNotify: number;
  cannotDelete: number;
}

export interface AppSettings {
  theme: 'light' | 'dark' | 'system';
  chat: {
    fontSize: 'small' | 'medium' | 'large';
  };
  privacy: {
    twoFactorEnabled: boolean;
    onlineStatus: 'everyone' | 'friends' | 'none';
    readReceipts: boolean;
    allowContact: 'everyone' | 'friends' | 'none';
  };
  language: {
    language: string;
    timeFormat: '12h' | '24h';
    timezone: string;
  };
  notifications: NotificationSettings;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  messageSound: 1,
  groupMention: 1,
  onlineNotify: 1,
  offlineNotify: 1,
  cannotDelete: 0,
};

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  chat: {
    fontSize: 'medium',
  },
  privacy: {
    twoFactorEnabled: false,
    onlineStatus: 'everyone',
    readReceipts: true,
    allowContact: 'everyone',
  },
  language: {
    language: 'zh-CN',
    timeFormat: '24h',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  },
  notifications: {
    messageSound: 1,
    groupMention: 1,
    onlineNotify: 1,
    offlineNotify: 1,
    cannotDelete: 0,
  },
};

export async function loadAppSettingsFromDb(): Promise<AppSettings> {
  try {
    const res = await apiFetch(API.user.settings, { requireCsrf: false });
    const data = await res.json();
    if (data.success && data.data) {
      const dbSettings = data.data;
      localStorage.setItem('appSettings', JSON.stringify(dbSettings));
      localStorage.setItem('notificationSettings', JSON.stringify(dbSettings.notifications || {}));
      return { ...DEFAULT_SETTINGS, ...dbSettings };
    }
  } catch (e) {
    console.error('加载设置失败:', e);
  }
  return loadAppSettings();
}

export function loadAppSettings(): AppSettings {
  try {
    const stored = localStorage.getItem('appSettings');
    if (stored) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
    }
  } catch (e) {}
  return { ...DEFAULT_SETTINGS };
}

export function loadNotificationSettings(): NotificationSettings {
  try {
    const stored = localStorage.getItem('notificationSettings');
    if (stored) {
      return { ...DEFAULT_NOTIFICATION_SETTINGS, ...JSON.parse(stored) };
    }
  } catch (e) {}
  return { ...DEFAULT_NOTIFICATION_SETTINGS };
}

export async function saveAppSettingsToDb(settings: Partial<AppSettings>) {
  const current = loadAppSettings();
  const newSettings = { ...current, ...settings };
  
  try {
    const res = await apiFetch(API.user.settings, {
      method: 'PUT',
      body: JSON.stringify(newSettings)
    });
    const data = await res.json();
    if (data.success) {
      localStorage.setItem('appSettings', JSON.stringify(newSettings));
      localStorage.setItem('notificationSettings', JSON.stringify(newSettings.notifications));
      applyAppSettings(newSettings);
      return newSettings;
    }
  } catch (e) {
    console.error('保存设置失败:', e);
  }
  
  localStorage.setItem('appSettings', JSON.stringify(newSettings));
  localStorage.setItem('notificationSettings', JSON.stringify(newSettings.notifications));
  applyAppSettings(newSettings);
  return newSettings;
}

export async function saveNotificationSettingsToDb(settings: NotificationSettings): Promise<boolean> {
  localStorage.setItem('notificationSettings', JSON.stringify(settings));
  
  const current = loadAppSettings();
  const newSettings = { ...current, notifications: settings };
  
  try {
    const res = await apiFetch(API.user.settings, {
      method: 'PUT',
      body: JSON.stringify(newSettings)
    });
    const data = await res.json();
    if (data.success) {
      localStorage.setItem('appSettings', JSON.stringify(newSettings));
      return true;
    }
  } catch (e) {
    console.error('保存通知设置失败:', e);
  }
  
  localStorage.setItem('appSettings', JSON.stringify(newSettings));
  return false;
}

export function saveAppSettings(settings: Partial<AppSettings>) {
  try {
    const current = loadAppSettings();
    const newSettings = { ...current, ...settings };
    localStorage.setItem('appSettings', JSON.stringify(newSettings));
    applyAppSettings(newSettings);
    
    saveAppSettingsToDb(settings).catch(console.error);
    
    return newSettings;
  } catch (e) {
    console.error('Failed to save settings:', e);
    return loadAppSettings();
  }
}

export function applyAppSettings(settings: AppSettings) {
  if (typeof document === 'undefined') return;
  
  const fontSizeMap = {
    small: '14px',
    medium: '16px',
    large: '18px',
  };
  
  document.documentElement.style.setProperty('--chat-font-size', fontSizeMap[settings.chat.fontSize]);
  document.documentElement.setAttribute('data-theme', settings.theme || 'light');
}

export function initAppSettings() {
  const settings = loadAppSettings();
  applyAppSettings(settings);
  return settings;
}

export function applyLanguageSettings(languageSettings: AppSettings['language']) {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = languageSettings.language;
}

export function getTimezoneOptions(): { value: string; label: string }[] {
  return [
    { value: 'Asia/Shanghai', label: '中国标准时间 (UTC+8)' },
    { value: 'Asia/Tokyo', label: '日本标准时间 (UTC+9)' },
    { value: 'Europe/London', label: '格林威治时间 (UTC+0)' },
    { value: 'America/New_York', label: '美国东部时间 (UTC-5)' },
  ];
}

const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function generateSecretKey(length: number = 16): string {
  let secret = '';
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  for (let i = 0; i < length; i++) {
    secret += BASE32_CHARS[array[i] % 32];
  }
  return secret;
}

function base32ToBytes(base32: string): Uint8Array {
  const cleaned = base32.toUpperCase().replace(/[^A-Z2-7]/g, '');
  const bits = cleaned.split('').map(c => BASE32_CHARS.indexOf(c));
  const bytes: number[] = [];
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5);
    bytes.push(
      (chunk[0] << 3) | (chunk[1] >> 2),
      ((chunk[1] & 3) << 6) | (chunk[2] << 1) | (chunk[3] >> 4),
      ((chunk[3] & 15) << 4) | (chunk[4] >> 1)
    );
  }
  return new Uint8Array(bytes.filter(b => b !== undefined));
}

function hmacSha1(key: Uint8Array, message: number[]): Uint8Array {
  const blockSize = 64;
  const key2 = new Uint8Array(blockSize);
  if (key.length > blockSize) {
    const hash = simpleSha1(Array.from(key));
    hash.forEach((v, i) => key2[i] = v);
  } else {
    key.forEach((v, i) => key2[i] = v);
  }
  
  const oKeyPad = new Uint8Array(blockSize);
  const iKeyPad = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i++) {
    oKeyPad[i] = 0x5c ^ key2[i];
    iKeyPad[i] = 0x36 ^ key2[i];
  }
  
  const inner = simpleSha1([...Array.from(iKeyPad), ...message]);
  const result = simpleSha1([...Array.from(oKeyPad), ...inner]);
  return new Uint8Array(result);
}

function simpleSha1(data: number[]): number[] {
  const f = (x: number, y: number, z: number) => (x & y) | (~x & z);
  const g = (x: number, y: number, z: number) => (x ^ y ^ z);
  const h = (x: number, y: number, z: number) => (x & y) | (x & z) | (y & z);
  const i = (x: number, y: number, z: number) => x ^ y ^ z;
  
  const rotl = (n: number, s: number) => (n << s) | (n >>> (32 - s));
  
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  
  const padded = [...data];
  padded.push(0x80);
  while ((padded.length % 64) !== 56) padded.push(0);
  const len = data.length * 8;
  padded.push(((len >>> 24) & 0xff), ((len >>> 16) & 0xff), ((len >>> 8) & 0xff), (len & 0xff));
  
  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    const w = new Array(80);
    for (let j = 0; j < 16; j++) {
      w[j] = (padded[chunk + j * 4] << 24) | (padded[chunk + j * 4 + 1] << 16) | 
             (padded[chunk + j * 4 + 2] << 8) | (padded[chunk + j * 4 + 3]);
    }
    for (let j = 16; j < 80; j++) {
      w[j] = rotl(w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16], 1);
    }
    
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let j = 0; j < 80; j++) {
      const temp = (rotl(a, 5) + (j < 20 ? f(b, c, d) : j < 40 ? g(b, c, d) : j < 60 ? h(b, c, d) : i(b, c, d)) + e + w[j] + (j < 20 ? 0x5a827999 : j < 40 ? 0x6ed9eba1 : j < 60 ? 0x8f1bbcdc : 0xca62c1d6)) | 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = temp;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  
  return [h0, h1, h2, h3, h4].flatMap(v => [
    (v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff
  ]);
}

export function generateTwoFactorSecret(): string {
  return generateSecretKey(16);
}

export function generateTwoFactorCode(secret: string): string {
  const epoch = Math.floor(Date.now() / 1000);
  const timeCounter = Math.floor(epoch / 30);
  
  const counterBytes: number[] = [];
  let temp = timeCounter;
  for (let i = 7; i >= 0; i--) {
    counterBytes[i] = temp & 0xff;
    temp >>>= 8;
  }
  
  const keyBytes = base32ToBytes(secret);
  const hash = hmacSha1(keyBytes, counterBytes);
  
  const offset = hash[hash.length - 1] & 0xf;
  const code = ((hash[offset] & 0x7f) << 24) | 
               ((hash[offset + 1] & 0xff) << 16) | 
               ((hash[offset + 2] & 0xff) << 8) | 
               (hash[offset + 3] & 0xff);
  
  return (code % 1000000).toString().padStart(6, '0');
}

export function verifyTwoFactorCode(secret: string, code: string): boolean {
  const currentCode = generateTwoFactorCode(secret);
  if (currentCode === code) return true;
  
  const prevCode = generateTwoFactorCodeWithCounter(secret, Math.floor(Date.now() / 1000 / 30) - 1);
  return prevCode === code;
}

function generateTwoFactorCodeWithCounter(secret: string, counter: number): string {
  const counterBytes: number[] = [];
  let temp = counter;
  for (let i = 7; i >= 0; i--) {
    counterBytes[i] = temp & 0xff;
    temp >>>= 8;
  }
  
  const keyBytes = base32ToBytes(secret);
  const hash = hmacSha1(keyBytes, counterBytes);
  
  const offset = hash[hash.length - 1] & 0xf;
  const code = ((hash[offset] & 0x7f) << 24) | 
               ((hash[offset + 1] & 0xff) << 16) | 
               ((hash[offset + 2] & 0xff) << 8) | 
               (hash[offset + 3] & 0xff);
  
  return (code % 1000000).toString().padStart(6, '0');
}

export function getTwoFactorSecretFromStorage(): string | null {
  return localStorage.getItem('twoFactorSecret');
}

export function setTwoFactorSecretToStorage(secret: string): void {
  localStorage.setItem('twoFactorSecret', secret);
}

export function removeTwoFactorSecretFromStorage(): void {
  localStorage.removeItem('twoFactorSecret');
}

export { DEFAULT_SETTINGS };
