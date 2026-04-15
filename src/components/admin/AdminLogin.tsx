import React, { useState } from 'react';
import { API } from '../../config/api';
import { ArrowLeft, Eye, EyeOff } from 'lucide-react';
import { BackgroundAnimation } from '../BackgroundAnimation';

interface AdminLoginProps {
  onLogin: (token: string, isSuperAdmin: boolean) => void;
  onBack?: () => void;
}

export const AdminLogin: React.FC<AdminLoginProps> = ({ onLogin, onBack }) => {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
	  
    try {
      const response = await fetch(API.admin.login, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password })
      });
      const data = await response.json();

      if (data.success) {
        localStorage.setItem('adminToken', data.data.token);
        onLogin(data.data.token);
      } else {
        setError(data.message || '登录失败');
      }
    } catch (err) {
      setError('网络错误，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="admin-login" style={{zIndex: 1}}>
      <div className="admin-login-box">
        {onBack && (
          <button className="back-btn" onClick={onBack}>
            <ArrowLeft size={18} /> 返回
          </button>
        )}
        <h2>管理员登录</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>密码</label>
            <div style={{ position: 'relative' }}>
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="请输入管理员密码"
                required
                style={{ paddingRight: '40px' }}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                style={{
                  position: 'absolute',
                  right: '10px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  border: 'none',
                  background: 'none',
                  cursor: 'pointer',
                  fontSize: '16px',
                  color: 'var(--dark)',
                }}
              >
                {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
              </button>
            </div>
          </div>
          {error && <div className="error-message">{error}</div>}
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? (
              <span>
                <span className="loading-spinner small"></span>
                登录中...
              </span>
            ) : '登录'}
          </button>
        </form>
      </div>
    </div>
  );
};
