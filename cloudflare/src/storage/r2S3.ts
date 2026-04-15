/**
 * R2 S3 兼容 API 客户端
 * 支持真正的 Range 请求，提高大文件下载速度
 */

export interface R2S3Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
}

export interface RangeResult {
  data: Uint8Array;
  contentType: string;
  contentLength: number;
  contentRange?: string;
  status: number;
}

export interface MultipartUploadResult {
  uploadId: string;
  key: string;
}

export interface UploadPartResult {
  etag: string;
  partNumber: number;
}

export class R2S3Client {
  private accountId: string;
  private accessKeyId: string;
  private secretAccessKey: string;
  private bucketName: string;

  constructor(config: R2S3Config) {
    this.accountId = config.accountId;
    this.accessKeyId = config.accessKeyId;
    this.secretAccessKey = config.secretAccessKey;
    this.bucketName = config.bucketName;
  }

  private async generateSignature(method: string, path: string, headers: Record<string, string>): Promise<string> {
    const date = new Date();
    const dateStamp = date.toISOString().split('T')[0].replace(/-/g, '');
    const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';

    const host = `${this.accountId}.r2.cloudflarestorage.com`;

    headers['x-amz-date'] = amzDate;
    headers['host'] = host;

    const canonicalUri = path;
    const canonicalQuerystring = '';

    const sortedHeaders = Object.keys(headers).sort().map(k => `${k.toLowerCase()}:${headers[k]}`).join('\n');
    const signedHeaders = Object.keys(headers).sort().join(';');

    const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuerystring,
      sortedHeaders,
      signedHeaders,
      payloadHash
    ].join('\n');

    const algorithm = 'AWS4-HMAC-SHA256';
    const credentialScope = `${dateStamp}/auto/s3/aws4_request`;
    const stringToSign = [
      algorithm,
      amzDate,
      credentialScope,
      await this.sha256(canonicalRequest)
    ].join('\n');

    const signingKey = await this.getSignatureKey(
      this.secretAccessKey,
      dateStamp,
      this.accountId,
      's3'
    );

    const signature = await this.hmacSha256(signingKey, stringToSign);
    const authHeader = `${algorithm} Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return authHeader;
  }

  private async sha256(data: string): Promise<string> {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  private async hmacSha256(key: CryptoKey, data: string): Promise<string> {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const signature = await crypto.subtle.sign('HMAC', key, dataBuffer);
    const signatureArray = Array.from(new Uint8Array(signature));
    return signatureArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  private async getSignatureKey(key: string, dateStamp: string, region: string, service: string): Promise<CryptoKey> {
    const encoder = new TextEncoder();
    const kDate = await crypto.subtle.importKey(
      'raw',
      encoder.encode('AWS4' + key),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const kRegion = await crypto.subtle.sign('HMAC', kDate, encoder.encode(region));
    const kService = await crypto.subtle.importKey(
      'raw',
      kRegion,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const kSigning = await crypto.subtle.sign('HMAC', kService, encoder.encode(service));
    return crypto.subtle.importKey(
      'raw',
      kSigning,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
  }

  async getObject(key: string, options?: {
    range?: { start: number; end?: number };
  }): Promise<RangeResult> {
    const path = `/${this.bucketName}/${encodeURIComponent(key)}`;
    const headers: Record<string, string> = {};

    if (options?.range) {
      const { start, end } = options.range;
      if (end !== undefined) {
        headers['Range'] = `bytes=${start}-${end}`;
      } else {
        headers['Range'] = `bytes=${start}-`;
      }
    }

    const signature = await this.generateSignature('GET', path, headers);
    headers['Authorization'] = signature;

    const url = `https://${this.accountId}.r2.cloudflarestorage.com${path}`;

    const response = await fetch(url, { headers });

    const contentType = response.headers.get('Content-Type') || 'application/octet-stream';
    const contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);
    const contentRange = response.headers.get('Content-Range') || undefined;

    const arrayBuffer = await response.arrayBuffer();

    return {
      data: new Uint8Array(arrayBuffer),
      contentType,
      contentLength,
      contentRange,
      status: response.status
    };
  }

  async headObject(key: string): Promise<{
    contentLength: number;
    contentType: string;
    lastModified?: string;
  }> {
    const path = `/${this.bucketName}/${encodeURIComponent(key)}`;
    const headers: Record<string, string> = {};

    const signature = await this.generateSignature('HEAD', path, headers);
    headers['Authorization'] = signature;

    const url = `https://${this.accountId}.r2.cloudflarestorage.com${path}`;

    const response = await fetch(url, { method: 'HEAD', headers });

    return {
      contentLength: parseInt(response.headers.get('Content-Length') || '0', 10),
      contentType: response.headers.get('Content-Type') || 'application/octet-stream',
      lastModified: response.headers.get('Last-Modified') || undefined
    };
  }

  async createMultipartUpload(key: string, contentType?: string): Promise<MultipartUploadResult> {
    const path = `/${this.bucketName}/${encodeURIComponent(key)}`;
    const headers: Record<string, string> = {};
    if (contentType) {
      headers['Content-Type'] = contentType;
    }

    const signature = await this.generateSignature('POST', path + '?uploads', headers);
    headers['Authorization'] = signature;

    const url = `https://${this.accountId}.r2.cloudflarestorage.com${path}?uploads`;

    const response = await fetch(url, {
      method: 'POST',
      headers
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`CreateMultipartUpload failed: ${response.status} ${text}`);
    }

    const xml = await response.text();
    const uploadIdMatch = xml.match(/<UploadId>([^<]+)<\/UploadId>/);
    if (!uploadIdMatch) {
      throw new Error('Failed to parse UploadId from response');
    }

    return {
      uploadId: uploadIdMatch[1],
      key
    };
  }

  async uploadPart(key: string, uploadId: string, partNumber: number, data: Uint8Array): Promise<UploadPartResult> {
    const path = `/${this.bucketName}/${encodeURIComponent(key)}`;
    const queryString = `uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`;
    
    const payloadHash = await this.sha256ArrayBuffer(data);
    const headers: Record<string, string> = {
      'Content-Length': data.length.toString(),
      'x-amz-content-sha256': payloadHash
    };

    const signature = await this.generateSignature('PUT', path + '?' + queryString, headers);
    headers['Authorization'] = signature;

    const url = `https://${this.accountId}.r2.cloudflarestorage.com${path}?${queryString}`;

    const response = await fetch(url, {
      method: 'PUT',
      headers,
      body: data
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`UploadPart failed: ${response.status} ${text}`);
    }

    const etag = response.headers.get('ETag') || '';
    return {
      etag,
      partNumber
    };
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: { etag: string; partNumber: number }[]): Promise<string> {
    const path = `/${this.bucketName}/${encodeURIComponent(key)}`;
    const queryString = `uploadId=${encodeURIComponent(uploadId)}`;

    const xmlBody = `<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUpload>
${parts.map(p => `  <Part>
    <ETag>${p.etag}</ETag>
    <PartNumber>${p.partNumber}</PartNumber>
  </Part>`).join('\n')}
</CompleteMultipartUpload>`;

    const encoder = new TextEncoder();
    const bodyBytes = encoder.encode(xmlBody);

    const payloadHash = await this.sha256ArrayBuffer(bodyBytes);
    const headers: Record<string, string> = {
      'Content-Type': 'application/xml',
      'Content-Length': bodyBytes.length.toString(),
      'x-amz-content-sha256': payloadHash
    };

    const signature = await this.generateSignature('POST', path + '?' + queryString, headers);
    headers['Authorization'] = signature;

    const url = `https://${this.accountId}.r2.cloudflarestorage.com${path}?${queryString}`;

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: xmlBody
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`CompleteMultipartUpload failed: ${response.status} ${text}`);
    }

    return key;
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const path = `/${this.bucketName}/${encodeURIComponent(key)}`;
    const queryString = `uploadId=${encodeURIComponent(uploadId)}`;

    const headers: Record<string, string> = {};
    const signature = await this.generateSignature('DELETE', path + '?' + queryString, headers);
    headers['Authorization'] = signature;

    const url = `https://${this.accountId}.r2.cloudflarestorage.com${path}?${queryString}`;

    await fetch(url, {
      method: 'DELETE',
      headers
    });
  }

  private async sha256ArrayBuffer(data: Uint8Array): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }
}

let r2S3Client: R2S3Client | null = null;

export function initR2S3Client(config: R2S3Config): void {
  r2S3Client = new R2S3Client(config);
}

export function getR2S3Client(): R2S3Client | null {
  return r2S3Client;
}

export async function downloadFromR2WithRange(
  key: string,
  range?: { start: number; end?: number }
): Promise<RangeResult | null> {
  if (!r2S3Client) {
    return null;
  }

  try {
    return await r2S3Client.getObject(key, { range });
  } catch (e) {
    console.error('R2 S3 download failed:', e);
    return null;
  }
}

export async function getR2FileSize(key: string): Promise<number | null> {
  if (!r2S3Client) {
    return null;
  }

  try {
    const result = await r2S3Client.headObject(key);
    return result.contentLength;
  } catch (e) {
    console.error('R2 head failed:', e);
    return null;
  }
}
