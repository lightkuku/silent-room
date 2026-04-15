#!/usr/bin/env python3
"""
密码哈希计算工具
使用 PBKDF2 + 二次盐（与 Cloudflare Workers 后端一致）
"""
import hashlib
import sys

PASSWORD_SALT = 'dIP0aAoi5wrhOcIQoB4UOglx5nkCsyOGDmXPeNI7'
SECONDARY_SALT = 'silent-room-secondary-salt-2024'

def hash_password(password: str) -> str:
    password_bytes = password.encode('utf-8')
    salt_bytes = PASSWORD_SALT.encode('utf-8')
    
    # 第一次：PBKDF2 (100000 次迭代)
    first_hash = hashlib.pbkdf2_hmac('sha256', password_bytes, salt_bytes, 100000)
    
    # 第二次：用固定盐再哈希
    second_salt = SECONDARY_SALT.encode('utf-8')
    combined = first_hash + second_salt
    second_hash = hashlib.sha256(combined).digest()
    
    return second_hash.hex()

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("用法: python update_passwords.py <密码>")
        sys.exit(1)
    
    password = sys.argv[1]
    hashed = hash_password(password)
    print(f"密码: {password}")
    print(f"哈希: {hashed}")
