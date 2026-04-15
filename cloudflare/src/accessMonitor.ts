/**
 * 访问监控和日志记录类
 * 用于记录 API 访问日志、可疑访问检测
 */

export class AccessMonitor {
  constructor(env) {
    this.env = env;
    this.logPrefix = '[AccessMonitor]';
    this.logBuffer = [];
    this.bufferFlushInterval = 5000;
    this.maxBufferSize = 50;
    this.lastFlushTime = Date.now();
    this.enabled = env.ENVIRONMENT !== 'production';
  }

  logAccess(data, ctx = null) {
    if (!this.enabled) return;
    
    try {
      const logData = {
        timestamp: new Date().toISOString(),
        ...data
      };

      console.log(`${this.logPrefix}:`, JSON.stringify(logData));

      this.logBuffer.push(logData);

      const shouldFlush = 
        this.logBuffer.length >= this.maxBufferSize ||
        (Date.now() - this.lastFlushTime) >= this.bufferFlushInterval;

      if (shouldFlush && ctx) {
        ctx.waitUntil(this.flushLogBuffer());
      }
    } catch (e) {
      console.error(`${this.logPrefix} 日志记录失败:`, e);
    }
  }

  async flushLogBuffer() {
    if (this.logBuffer.length === 0) return;

    try {
      const logsToFlush = [...this.logBuffer];
      this.logBuffer = [];
      this.lastFlushTime = Date.now();

      console.log(`${this.logPrefix} 本次刷新 ${logsToFlush.length} 条日志`);
    } catch (e) {
      console.error(`${this.logPrefix} 刷新日志失败:`, e);
    }
  }

  async forceFlush() {
    await this.flushLogBuffer();
  }

  logSuspiciousAccess(data, ctx = null) {
    const suspiciousData = {
      type: 'SUSPICIOUS',
      severity: 'HIGH',
      ...data
    };

    this.logAccess(suspiciousData, ctx);
  }

  logApiAccess(request, userId, ip, path, method, status, duration, ctx = null) {
    const accessData = {
      type: 'API_ACCESS',
      userId: userId || 'anonymous',
      ip: ip || 'unknown',
      path: path,
      method: method,
      status: status,
      duration: duration,
      userAgent: request.headers.get('user-agent') || ''
    };

    this.logAccess(accessData, ctx);
  }

  logAuthEvent(event, userId, ip, success, reason = '', ctx = null) {
    const authData = {
      type: 'AUTH_EVENT',
      event: event,
      userId: userId || 'unknown',
      ip: ip || 'unknown',
      success: success,
      reason: reason
    };

    this.logAccess(authData, ctx);
  }

  logSecurityEvent(event, ip, path, details = '', ctx = null) {
    const securityData = {
      type: 'SECURITY',
      event: event,
      ip: ip || 'unknown',
      path: path || '',
      details: details
    };

    this.logAccess(securityData, ctx);
  }
}