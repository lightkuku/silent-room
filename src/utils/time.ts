/**
 * 时间格式化工具
 * 统一处理前端时间显示 - 使用本地时间（RTC）
 */

// 服务器时间偏移量（小时）- 服务器返回的是UTC时间，需要加8小时转为UTC+8
const SERVER_TIME_OFFSET_HOURS = 8;

// 将服务器时间戳转换为本地Date对象
export function convertServerTime(timestamp: number | string | Date): Date {
  if (timestamp instanceof Date) {
    return new Date(timestamp.getTime() + SERVER_TIME_OFFSET_HOURS * 60 * 60 * 1000);
  }
  const ts = Number(timestamp);
  return new Date(ts + SERVER_TIME_OFFSET_HOURS * 60 * 60 * 1000);
}

// 获取服务器时间戳（毫秒）
export function getServerTimestamp(timestamp?: number | string | Date): number {
  if (!timestamp) return Date.now();
  if (timestamp instanceof Date) return timestamp.getTime();
  const ts = Number(timestamp);
  return ts + SERVER_TIME_OFFSET_HOURS * 60 * 60 * 1000;
}

// 可配置的时区偏移量（小时），默认 null 使用浏览器时区
// 如果浏览器时区设置错误，可以调用 setTimezoneOffset 设置
let TIMEZONE_OFFSET_HOURS: number | null = null;

// 设置时区偏移量（小时），例如 +8 表示 UTC+8
export function setTimezoneOffset(hours: number): void {
  TIMEZONE_OFFSET_HOURS = hours;
  
}

// 获取时区偏移量
function getTimezoneOffsetHours(): number {
  if (TIMEZONE_OFFSET_HOURS !== null) {
    return TIMEZONE_OFFSET_HOURS;
  }
  const offsetMinutes = new Date().getTimezoneOffset();
  return -offsetMinutes / 60;
}

// 将 UTC 时间戳转换为本地时间字符串
function formatLocalTime(timestamp: number, format: 'time' | 'date' | 'datetime'): string {
  // timestamp 已经是经过 convertServerTime 处理过的偏移后时间
  const date = new Date(timestamp);
  const now = new Date();
  
  const pad = (n: number) => String(n).padStart(2, '0');
  
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;
  const dateStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  
  switch (format) {
    case 'time':
      if (dateStart === todayStart) {
        return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
      }
      if (dateStart === yesterdayStart) {
        return '昨天';
      }
      if (date.getFullYear() === now.getFullYear()) {
        return `${date.getMonth() + 1}-${date.getDate()}`;
      }
      return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
      
    case 'date':
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
      
    case 'datetime':
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
      
    default:
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
}

// 将时间戳转换为指定格式的字符串
export function formatTimestamp(
  timestamp: number | string | Date, 
  format: 'time' | 'date' | 'datetime' | 'relative' = 'time'
): string {
  const ts = timestamp instanceof Date ? timestamp.getTime() : Number(timestamp);
  
  if (!ts || isNaN(ts) || ts < 0) {
    return '--';
  }
  
  switch (format) {
    case 'time':
    case 'date':
    case 'datetime':
      return formatLocalTime(ts, format);
      
    case 'relative':
      const now = new Date();
      const diff = now.getTime() - ts;
      if (diff < 60000) return '刚刚';
      if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
      if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
      if (diff < 604800000) return `${Math.floor(diff / 86400000)}天前`;
      return formatLocalTime(ts, 'date');
      
    default:
      return formatLocalTime(ts, 'time');
  }
}

// 获取时间戳
export function getTimestamp(value?: number | string | Date): number {
  if (!value) return Date.now();
  if (value instanceof Date) return value.getTime();
  return Number(value);
}

// 检查时间戳是否有效
export function isValidTimestamp(timestamp: any): boolean {
  const ts = Number(timestamp);
  return !isNaN(ts) && ts > 0 && ts < 4102444800000;
}

// 获取用户本地时区
export function getLocalTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
