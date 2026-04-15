function generateId(): string {
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

export function getChunkSize(fileSize: number): number {
  if (fileSize < 10 * 1024 * 1024) return 2 * 1024 * 1024;   // <10MB → 2MB
  if (fileSize < 50 * 1024 * 1024) return 4 * 1024 * 1024;  // <50MB → 4MB
  if (fileSize < 200 * 1024 * 1024) return 8 * 1024 * 1024; // <200MB → 8MB
  return 16 * 1024 * 1024;                                  // ≥200MB → 16MB
}

export async function encryptFileChunkedAsync(
  file: File,
  key: string,
  onProgress?: (progress: number, processedSize?: number, totalSize?: number) => void
): Promise<{ encrypted: Blob; chunks: number; totalSize: number }> {
  if (!key) {
    return { encrypted: file, chunks: 1, totalSize: file.size };
  }

  const chunkSize = getChunkSize(file.size);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyObj = await deriveKey(key, salt);
  
  const chunkIVs: Uint8Array[] = [];
  const encryptedChunks: ArrayBuffer[] = [];
  let offset = 0;
  let processed = 0;

  while (offset < file.size) {
    const chunk = file.slice(offset, Math.min(offset + chunkSize, file.size));
    const chunkData = new Uint8Array(await chunk.arrayBuffer());
    
    const iv = new Uint8Array(12);
    const counter = Math.floor(offset / chunkSize);
    iv[0] = counter & 0xff;
    iv[1] = (counter >> 8) & 0xff;
    iv[2] = (counter >> 16) & 0xff;
    iv[3] = (counter >> 24) & 0xff;
    
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      keyObj,
      chunkData
    );
    
    chunkIVs.push(iv);
    encryptedChunks.push(encrypted);
    processed += chunk.size;
    
    if (onProgress) {
      onProgress(Math.round((processed / file.size) * 100), processed, file.size);
    }
    
    offset += chunkSize;
  }
  
  const resultChunks: Uint8Array[] = [];
  resultChunks.push(new Uint8Array(salt));
  
  const countBytes = new Uint8Array(4);
  new DataView(countBytes.buffer).setUint32(0, chunkIVs.length, true);
  resultChunks.push(countBytes);
  
  for (let i = 0; i < chunkIVs.length; i++) {
    resultChunks.push(new Uint8Array(chunkIVs[i]));
    const sizeBytes = new Uint8Array(4);
    new DataView(sizeBytes.buffer).setUint32(0, encryptedChunks[i].byteLength, true);
    resultChunks.push(sizeBytes);
    resultChunks.push(new Uint8Array(encryptedChunks[i]));
  }
  
  const totalLength = resultChunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let pos = 0;
  for (const chunk of resultChunks) {
    result.set(chunk, pos);
    pos += chunk.length;
  }
  
  return {
    encrypted: new Blob([result], { type: 'application/octet-stream' }),
    chunks: chunkIVs.length,
    totalSize: result.length
  };
}

export async function decryptFileChunkedAsync(
  encryptedBlob: Blob,
  key: string,
  onProgress?: (progress: number) => void
): Promise<Blob> {
  if (!key) return encryptedBlob;

  const buffer = await encryptedBlob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  const salt = bytes.slice(0, 16);
  const keyObj = await deriveKey(key, salt);

  const chunkCount = view.getUint32(16, true);

  const decryptedChunks: Uint8Array[] = [];
  let pos = 20;

  for (let i = 0; i < chunkCount; i++) {
    const iv = bytes.slice(pos, pos + 12);
    pos += 12;

    const chunkSize = view.getUint32(pos, true);
    pos += 4;

    const encryptedChunk = bytes.slice(pos, pos + chunkSize);
    pos += chunkSize;

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      keyObj,
      encryptedChunk
    );

    decryptedChunks.push(new Uint8Array(decrypted));

    if (onProgress) {
      onProgress(Math.round(((i + 1) / chunkCount) * 100));
    }
  }

  const totalLength = decryptedChunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let resultPos = 0;
  for (const chunk of decryptedChunks) {
    result.set(chunk, resultPos);
    resultPos += chunk.length;
  }

  return new Blob([result], { type: 'application/octet-stream' });
}

import type { EncryptionKeys } from '../types';
export type { EncryptionKeys };

export async function decryptFileChunkedWithKeysAsync(
  encryptedBlob: Blob,
  keys: EncryptionKeys,
  onProgress?: (progress: number) => void
): Promise<{ blob: Blob; keyUsed: string }> {
  const keysToTry = [keys.currentKey, ...keys.legacyKeys];

  for (const key of keysToTry) {
    if (!key) continue;

    try {
      const blob = await decryptFileChunkedAsync(encryptedBlob, key, onProgress);
      return { blob, keyUsed: key };
    } catch (e) {
      // 尝试下一个 key
    }
  }

  throw new Error('Failed to decrypt file with any available key');
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = encoder.encode(password);
  const saltBuffer = new Uint8Array(salt).buffer;

  const baseKey = await crypto.subtle.importKey(
    'raw',
    keyMaterial,
    'PBKDF2',
    false,
    ['deriveKey']
  );

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
}
