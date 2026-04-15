const deriveKey = async (password: string, salt: Uint8Array): Promise<CryptoKey> => {
  const encoder = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt.buffer as ArrayBuffer,
      iterations: 100000,
      hash: 'SHA-256'
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
};

interface WorkerMessage {
  type: 'encrypt' | 'decrypt' | 'encrypt-file' | 'decrypt-file';
  id: string;
  data?: ArrayBuffer;
  file?: File;
  password: string;
  iv?: Uint8Array;
}

self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const { type, id, data, file, password, iv } = e.data;
  
  try {
    if (type === 'encrypt-file' && file) {
      const CHUNK_SIZE = 1024 * 1024;
      const chunks: ArrayBuffer[] = [];
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const fileIv = crypto.getRandomValues(new Uint8Array(12));
      const keyObj = await deriveKey(password, salt);
      
      let offset = 0;
      
      while (offset < file.size) {
        const chunkData = file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size));
        const buffer = await chunkData.arrayBuffer();
        const encrypted = await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv: fileIv },
          keyObj,
          buffer
        );
        chunks.push(encrypted);
        
        self.postMessage({
          type: 'progress',
          id,
          progress: Math.round(((offset + chunkData.size) / file.size) * 100)
        });
        
        offset += CHUNK_SIZE;
      }
      
      const combined = new Uint8Array(chunks.reduce((sum, c) => sum + c.byteLength, 0));
      let pos = 0;
      for (const chunk of chunks) {
        combined.set(new Uint8Array(chunk), pos);
        pos += chunk.byteLength;
      }
      
      const result = new Uint8Array(salt.length + fileIv.length + combined.length);
      result.set(salt, 0);
      result.set(fileIv, salt.length);
      result.set(combined, salt.length + fileIv.length);
      
      self.postMessage({ type: 'result', id, result: result.buffer, success: true }, { transfer: [result.buffer] });
    } else if (type === 'decrypt-file' && data) {
      const bytes = new Uint8Array(data);
      const salt = bytes.slice(0, 16);
      const fileIv = bytes.slice(16, 28);
      const encrypted = bytes.slice(28);
      
      const keyObj = await deriveKey(password, salt);
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fileIv.buffer as ArrayBuffer },
        keyObj,
        encrypted
      );
      
      self.postMessage({ type: 'result', id, result: decrypted, success: true }, { transfer: [decrypted] });
    } else if (type === 'encrypt' && data && iv) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const keyObj = await deriveKey(password, salt);
      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
        keyObj,
        data
      );
      self.postMessage({ type: 'result', id, result: encrypted, salt, success: true }, { transfer: [encrypted] });
    } else if (type === 'decrypt' && data && iv) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const keyObj = await deriveKey(password, salt);
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
        keyObj,
        data
      );
      self.postMessage({ type: 'result', id, result: decrypted, success: true }, { transfer: [decrypted] });
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};
