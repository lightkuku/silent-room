export class ValidationError extends Error {
  constructor(
    message: string,
    public field?: string
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function validateRequired(value: any, fieldName: string): void {
  if (value === undefined || value === null || value === '') {
    throw new ValidationError(`${fieldName} 不能为空`, fieldName);
  }
}

export function validateString(
  value: any,
  fieldName: string,
  options: { min?: number; max?: number; pattern?: RegExp } = {}
): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`${fieldName} 必须是字符串`, fieldName);
  }
  
  const { min, max, pattern } = options;
  
  if (min !== undefined && value.length < min) {
    throw new ValidationError(`${fieldName} 长度不能少于 ${min} 个字符`, fieldName);
  }
  
  if (max !== undefined && value.length > max) {
    throw new ValidationError(`${fieldName} 长度不能超过 ${max} 个字符`, fieldName);
  }
  
  if (pattern && !pattern.test(value)) {
    throw new ValidationError(`${fieldName} 格式不正确`, fieldName);
  }
  
  return value;
}

export function validateEmail(value: any): string {
  const email = validateString(value, '邮箱', { max: 255 });
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(email)) {
    throw new ValidationError('邮箱格式不正确', 'email');
  }
  return email;
}

export function validatePassword(value: any, minLength = 6): string {
  const password = validateString(value, '密码', { min: minLength });
  if (password.length < minLength) {
    throw new ValidationError(`密码长度不能少于 ${minLength} 个字符`, 'password');
  }
  return password;
}

export function validateNumber(
  value: any,
  fieldName: string,
  options: { min?: number; max?: number; integer?: boolean } = {}
): number {
  const num = Number(value);
  
  if (isNaN(num)) {
    throw new ValidationError(`${fieldName} 必须是数字`, fieldName);
  }
  
  const { min, max, integer } = options;
  
  if (integer && !Number.isInteger(num)) {
    throw new ValidationError(`${fieldName} 必须是整数`, fieldName);
  }
  
  if (min !== undefined && num < min) {
    throw new ValidationError(`${fieldName} 不能小于 ${min}`, fieldName);
  }
  
  if (max !== undefined && num > max) {
    throw new ValidationError(`${fieldName} 不能大于 ${max}`, fieldName);
  }
  
  return num;
}

export function validateArray(
  value: any,
  fieldName: string,
  options: { min?: number; max?: number; itemValidator?: (item: any) => void } = {}
): any[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${fieldName} 必须是数组`, fieldName);
  }
  
  const { min, max, itemValidator } = options;
  
  if (min !== undefined && value.length < min) {
    throw new ValidationError(`${fieldName} 长度不能少于 ${min} 项`, fieldName);
  }
  
  if (max !== undefined && value.length > max) {
    throw new ValidationError(`${fieldName} 长度不能超过 ${max} 项`, fieldName);
  }
  
  if (itemValidator) {
    value.forEach((item, index) => {
      try {
        itemValidator(item);
      } catch (error) {
        if (error instanceof ValidationError) {
          throw new ValidationError(`${fieldName}[${index}]: ${error.message}`, `${fieldName}[${index}]`);
        }
        throw error;
      }
    });
  }
  
  return value;
}

export function validateEnum<T>(
  value: any,
  fieldName: string,
  allowedValues: T[]
): T {
  if (!allowedValues.includes(value)) {
    throw new ValidationError(
      `${fieldName} 必须是以下值之一: ${allowedValues.join(', ')}`,
      fieldName
    );
  }
  return value;
}

export function validateUUID(value: any, fieldName: string): string {
  const uuid = validateString(value, fieldName);
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(uuid)) {
    throw new ValidationError(`${fieldName} 必须是有效的 UUID`, fieldName);
  }
  return uuid;
}

export function validateObject(
  value: any,
  fieldName: string,
  schema: Record<string, (val: any) => any>
): Record<string, any> {
  if (typeof value !== 'object' || value === null) {
    throw new ValidationError(`${fieldName} 必须是对象`, fieldName);
  }
  
  const result: Record<string, any> = {};
  
  for (const [key, validator] of Object.entries(schema)) {
    try {
      result[key] = validator(value[key]);
    } catch (error) {
      if (error instanceof ValidationError) {
        throw new ValidationError(`${fieldName}.${key}: ${error.message}`, `${fieldName}.${key}`);
      }
      throw error;
    }
  }
  
  return result;
}

export function sanitizeString(str: string): string {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, 10000);
}

export function sanitizeHTML(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

export function isValidUsername(username: string): boolean {
  const pattern = /^[a-zA-Z0-9_-]{3,20}$/;
  return pattern.test(username);
}

export function isValidGroupName(name: string): boolean {
  return name.length >= 2 && name.length <= 50;
}

export function isValidMessageContent(content: string): boolean {
  return content.length > 0 && content.length <= 5000;
}

export function isValidFileName(filename: string): boolean {
  const pattern = /^[^\\/:*?"<>|]+$/;
  return pattern.test(filename) && filename.length <= 255;
}
