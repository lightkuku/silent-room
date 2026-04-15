import CryptoJS from 'crypto-js';
import type { EncryptionKeys } from '../types';
export type { EncryptionKeys };

// 生成随机加密密钥
export function generateEncryptionKey(): string {
  return CryptoJS.lib.WordArray.random(16).toString();
}

export function getChunkSize(fileSize: number): number {
  if (fileSize < 10 * 1024 * 1024) return 2 * 1024 * 1024;   // <10MB → 2MB
  if (fileSize < 50 * 1024 * 1024) return 4 * 1024 * 1024;  // <50MB → 4MB
  if (fileSize < 200 * 1024 * 1024) return 8 * 1024 * 1024; // <200MB → 8MB
  return 16 * 1024 * 1024;                                  // ≥200MB → 16MB
}

function isLikelyEncrypted(text: string): boolean {
  if (!text) return false;
  return text.startsWith('U2FsdGVkX') || text.startsWith('Salted__');
}

export function parseKeysFromUrl(): EncryptionKeys | null {
  try {
    let hash = window.location.hash.slice(1);
    if (!hash || hash.length < 5) {
      return null;
    }
    
    try {
      hash = decodeURIComponent(hash);
    } catch (e) {
    }
    
    const parsed = JSON.parse(hash);
    const currentKey = parsed.currentKey || parsed.currentkey || parsed.currentkey2 || '';
    if (currentKey) {
      return {
        currentKey: currentKey,
        legacyKeys: parsed.legacyKeys || parsed.legacykeys || parsed.legacyKeys2 || []
      };
    }
    return null;
  } catch (e) {
    return null;
  }
}

export function saveKeysToStorage(keys: EncryptionKeys): void {
  localStorage.setItem('encryption_currentKey', keys.currentKey);
  localStorage.setItem('encryption_legacyKeys', JSON.stringify(keys.legacyKeys));
}

export function loadKeysFromStorage(): EncryptionKeys | null {
  const currentKeyStr = localStorage.getItem('encryption_currentKey');
  const legacyKeysStr = localStorage.getItem('encryption_legacyKeys');
  const encryptionKeyStr = localStorage.getItem('encryptionKey');
  
  if (!currentKeyStr && !encryptionKeyStr) return null;
  
  let currentKey = currentKeyStr || encryptionKeyStr || '';
  let legacyKeys: string[] = [];
  
  if (currentKeyStr) {
    try {
      const parsed = JSON.parse(currentKeyStr);
      if (typeof parsed === 'object' && parsed !== null) {
        currentKey = parsed.currentKey || parsed.currentkey || '';
        legacyKeys = parsed.legacyKeys || parsed.legacykeys || [];
      }
    } catch {
    }
  }
  
  if (encryptionKeyStr && !currentKey) {
    try {
      const parsed = JSON.parse(encryptionKeyStr);
      if (typeof parsed === 'object' && parsed !== null) {
        currentKey = parsed.currentKey || parsed.currentkey || '';
        legacyKeys = parsed.legacyKeys || parsed.legacykeys || [];
      }
    } catch {
      currentKey = encryptionKeyStr;
    }
  }
  
  if (legacyKeysStr) {
    try {
      legacyKeys = JSON.parse(legacyKeysStr);
    } catch (e) {
    }
  }
  
  if (!currentKey) return null;
  
  return { currentKey, legacyKeys };
}

export function clearKeysFromStorage(): void {
  localStorage.removeItem('encryption_currentKey');
  localStorage.removeItem('encryption_legacyKeys');
}

export function addLegacyKey(newKey: string): void {
  const current = loadKeysFromStorage();
  if (!current) return;
  
  if (!current.legacyKeys.includes(newKey)) {
    current.legacyKeys.unshift(newKey);
    if (current.legacyKeys.length > 10) {
      current.legacyKeys.pop();
    }
    saveKeysToStorage(current);
  }
}

export function encrypt(plainText: string, key: string): string {
  if (!key) return plainText;
  return CryptoJS.AES.encrypt(plainText, key).toString();
}

export function decrypt(cipherText: string, key: string): string | null {
  if (!key) return cipherText;
  try {
    const bytes = CryptoJS.AES.decrypt(cipherText, key);
    const result = bytes.toString(CryptoJS.enc.Utf8);
    if (result === cipherText) {
      return null;
    }
    return result;
  } catch (e) {
    return null;
  }
}

export function decryptWithKeys(cipherText: string, keys: EncryptionKeys): { result: string | null; keyUsed: string | null; failed: boolean } {
  const keysToTry = [keys.currentKey, ...keys.legacyKeys];
  
  for (const key of keysToTry) {
    if (!key) continue;
    try {
      const result = decrypt(cipherText, key);
      if (result !== null && result !== cipherText) {
        return { result, keyUsed: key, failed: false };
      }
    } catch (e) {
    }
  }
  
  return { result: null, keyUsed: null, failed: true };
}

export function tryDecrypt(cipherText: string): { content: string; keyUsed: string | null; decrypted: boolean } {
  if (!cipherText || cipherText.length === 0) {
    return { content: cipherText, keyUsed: null, decrypted: false };
  }
  
  const keys = loadKeysFromStorage();
  if (!keys) return { content: cipherText, keyUsed: null, decrypted: false };
  
  const isLikelyEncrypted = (text: string): boolean => {
    if (!text) return false;
    return text.startsWith('U2FsdGVkX') || text.startsWith('Salted__');
  };
  
  if (!isLikelyEncrypted(cipherText)) {
    return { content: cipherText, keyUsed: null, decrypted: false };
  }
  
  let result = decrypt(cipherText, keys.currentKey);
  if (result && result.length > 0) {
    return { content: result, keyUsed: keys.currentKey, decrypted: true };
  }
  
  for (const legacyKey of keys.legacyKeys) {
    result = decrypt(cipherText, legacyKey);
    if (result && result.length > 0) {
      return { content: result, keyUsed: legacyKey, decrypted: true };
    }
  }
  
  return { content: cipherText, keyUsed: null, decrypted: false };
}

export function canDecryptWithKeys(cipherText: string, keys: EncryptionKeys | null): boolean {
  if (!keys || !cipherText) return false;
  
  const isLikelyEncrypted = (text: string): boolean => {
    return text.startsWith('U2FsdGVkX') || text.startsWith('Salted__');
  };
  
  if (!isLikelyEncrypted(cipherText)) return false;
  
  let result = decrypt(cipherText, keys.currentKey);
  if (result && result.length > 0) return true;
  
  for (const legacyKey of keys.legacyKeys) {
    result = decrypt(cipherText, legacyKey);
    if (result && result.length > 0) return true;
  }
  
  return false;
}

// ============ Web Crypto API 优化 ============

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = encoder.encode(password);
  const saltBuffer = new Uint8Array(salt).buffer;
  
  return crypto.subtle.importKey(
    'raw',
    keyMaterial,
    'PBKDF2',
    false,
    ['deriveKey']
  ).then(baseKey => {
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: saltBuffer,
        iterations: 100000,
        hash: 'SHA-256'
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  });
}

export async function encryptNative(data: ArrayBuffer, password: string): Promise<ArrayBuffer> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    data
  );
  
  const result = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
  result.set(salt, 0);
  result.set(iv, salt.length);
  result.set(new Uint8Array(encrypted), salt.length + iv.length);
  
  return result.buffer;
}

export async function decryptNative(data: ArrayBuffer, password: string): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(data);
  const salt = bytes.slice(0, 16);
  const iv = bytes.slice(16, 28);
  const encrypted = bytes.slice(28);
  
  const key = await deriveKey(password, salt);
  
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    encrypted
  );
}

export async function encryptFileNative(
  file: File,
  key: string,
  onProgress?: (progress: number) => void
): Promise<Blob> {
  if (!key) return file;
  
  const CHUNK = 1024 * 1024;
  const chunks: ArrayBuffer[] = [];
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyObj = await deriveKey(key, salt);
  
  let offset = 0;
  let processed = 0;
  
  while (offset < file.size) {
    const chunk = file.slice(offset, offset + CHUNK);
    const buffer = await chunk.arrayBuffer();
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      keyObj,
      buffer
    );
    chunks.push(encrypted);
    processed += chunk.size;
    if (onProgress) onProgress(Math.round((processed / file.size) * 50));
    
    await new Promise(resolve => setTimeout(resolve, 0));
    offset += CHUNK;
  }
  
  const combined = new Uint8Array(chunks.reduce((sum, c) => sum + c.byteLength, 0));
  let pos = 0;
  for (const chunk of chunks) {
    combined.set(new Uint8Array(chunk), pos);
    pos += chunk.byteLength;
  }
  
  const result = new Uint8Array(salt.length + iv.length + combined.length);
  result.set(salt, 0);
  result.set(iv, salt.length);
  result.set(combined, salt.length + iv.length);
  
  if (onProgress) onProgress(100);
  
  return new Blob([result], { type: 'application/octet-stream' });
}

export async function decryptFileNative(
  encryptedBlob: Blob,
  key: string,
  onProgress?: (progress: number) => void
): Promise<Blob> {
  if (!key) return encryptedBlob;
  
  const buffer = await encryptedBlob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const salt = bytes.slice(0, 16);
  const iv = bytes.slice(16, 28);
  const encrypted = bytes.slice(28);
  
  const keyObj = await deriveKey(key, salt);
  
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv },
    keyObj,
    encrypted
  );
  
  if (onProgress) onProgress(100);
  
  return new Blob([decrypted], { type: 'application/octet-stream' });
}

// 带 yield 的分块加密，防止大文件卡顿
export async function encryptFileChunkedWithYield(
  file: File,
  key: string,
  onProgress?: (progress: number) => void,
  chunkSize?: number
): Promise<Blob> {
  if (!key) return file;
  
  const actualChunkSize = chunkSize || getChunkSize(file.size);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyObj = await deriveKey(key, salt);
  
  // 元数据：存储每块的 IV（每块使用不同的 IV）
  const chunkIVs: Uint8Array[] = [];
  const encryptedChunks: ArrayBuffer[] = [];
  let offset = 0;
  let processed = 0;
  
  while (offset < file.size) {
    const chunk = file.slice(offset, Math.min(offset + actualChunkSize, file.size));
    const chunkData = new Uint8Array(await chunk.arrayBuffer());
    
    // 每块使用不同的 IV（基于计数器）
    const iv = new Uint8Array(12);
    const counter = Math.floor(offset / actualChunkSize);
    iv[0] = counter & 0xff;
    iv[1] = (counter >> 8) & 0xff;
    iv[2] = (counter >> 16) & 0xff;
    iv[3] = (counter >> 24) & 0xff;
    
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      keyObj,
      chunkData
    );
    
    chunkIVs.push(iv);
    encryptedChunks.push(encrypted);
    processed += chunk.size;
    
    if (onProgress) {
      onProgress(Math.round((processed / file.size) * 100));
    }
    
    await new Promise(resolve => setTimeout(resolve, 0));
    offset += actualChunkSize;
  }
  
  // 构建文件格式：
  // salt(16) + chunkCount(4) + [chunk1_iv(12) + chunk1_size(4) + chunk1_data, ...]
  
  const chunks: Uint8Array[] = [];
  chunks.push(new Uint8Array(salt));
  
  // 写入块数量 (小端序)
  const countBytes = new Uint8Array(4);
  new DataView(countBytes.buffer).setUint32(0, chunkIVs.length, true);
  chunks.push(countBytes);
  
  // 写入每块的数据
  for (let i = 0; i < chunkIVs.length; i++) {
    chunks.push(new Uint8Array(chunkIVs[i]));
    const sizeBytes = new Uint8Array(4);
    new DataView(sizeBytes.buffer).setUint32(0, encryptedChunks[i].byteLength, true);
    chunks.push(sizeBytes);
    chunks.push(new Uint8Array(encryptedChunks[i]));
  }
  
  // 合并所有数据
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let pos = 0;
  for (const chunk of chunks) {
    result.set(chunk, pos);
    pos += chunk.length;
  }
  
  return new Blob([result], { type: 'application/octet-stream' });
}

// 带 yield 的分块解密，防止大文件卡顿
export async function decryptFileChunkedWithYield(
  encryptedBlob: Blob,
  key: string,
  onProgress?: (progress: number) => void
): Promise<Blob> {
  if (!key) return encryptedBlob;
  
  const buffer = await encryptedBlob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  
  // 读取 salt
  const salt = bytes.slice(0, 16);
  const keyObj = await deriveKey(key, salt);
  
  // 读取块数量
  const chunkCount = view.getUint32(16, true);
  
  const decryptedChunks: Uint8Array[] = [];
  let pos = 20; // 跳过 salt + count
  
  for (let i = 0; i < chunkCount; i++) {
    // 读取 IV
    const iv = bytes.slice(pos, pos + 12);
    pos += 12;
    
    // 读取块大小
    const chunkSize = view.getUint32(pos, true);
    pos += 4;
    
    // 读取加密数据
    const encryptedChunk = bytes.slice(pos, pos + chunkSize);
    pos += chunkSize;
    
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv },
      keyObj,
      encryptedChunk
    );
    
    decryptedChunks.push(new Uint8Array(decrypted));
    
    if (onProgress) {
      onProgress(Math.round(((i + 1) / chunkCount) * 100));
    }
    
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  
  // 合并所有块
  const totalLength = decryptedChunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let resultPos = 0;
  for (const chunk of decryptedChunks) {
    result.set(chunk, resultPos);
    resultPos += chunk.length;
  }
  
  return new Blob([result], { type: 'application/octet-stream' });
}

export async function decryptFileChunkedWithKeysYield(
  encryptedBlob: Blob,
  keys: EncryptionKeys,
  onProgress?: (progress: number) => void
): Promise<{ blob: Blob; keyUsed: string }> {
  const keysToTry = [keys.currentKey, ...keys.legacyKeys];
  
  for (const key of keysToTry) {
    if (!key) continue;
    
    try {
      const blob = await decryptFileChunkedWithYield(encryptedBlob, key, onProgress);
      return { blob, keyUsed: key };
    } catch (e) {
      // 尝试下一个 key
    }
  }
  
  throw new Error('Failed to decrypt file with any available key');
}



export const hashPassword = async (password: string): Promise<string> => {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
};
