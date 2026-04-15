import React, { useState, useEffect } from 'react';
import { TURNSTILE_SITE_KEY, loadSiteConfig, API } from '../config/api';
import Turnstile, { resetTurnstile } from './Turnstile';
import { Eye, EyeOff } from 'lucide-react';
import { apiFetch } from '../utils/csrf'

interface LoginProps {
  onLogin: (user: any) => void;
  onAdminClick?: () => void;
}

export const Login: React.FC<LoginProps> = ({ onLogin, onAdminClick }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [showTurnstile, setShowTurnstile] = useState(false);
  const [turnstileVerified, setTurnstileVerified] = useState(false);
  const [turnstileError, setTurnstileError] = useState('');
  const [siteConfig, setSiteConfig] = useState(loadSiteConfig());

  useEffect(() => {
    if (TURNSTILE_SITE_KEY) {
      setShowTurnstile(true);
    }
    if (!localStorage.getItem('siteConfig')) {
      fetch(API.site.config)
        .then(res => res.json())
        .then(data => {
          if (data.success && data.data) {
            const config = data.data;
            setSiteConfig(config);
            localStorage.setItem('siteConfig', JSON.stringify(config));
            if (config.title) document.title = config.title;
            if (config.favicon) {
              const favicon = document.getElementById('favicon-link') as HTMLLinkElement;
              if (favicon) favicon.href = config.favicon;
            }
          }
        })
        .catch(() => {});
    }
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const response = await fetch(API.auth.login, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          username, 
          password: password,
          turnstileToken: showTurnstile ? turnstileToken : undefined
        })
      });
      
      let data;
      try {
        data = await response.json();
      } catch {
        setError('服务器响应格式错误');
        return;
      }
      
      if (data.success) {
        localStorage.setItem('token', data.data.token);
        localStorage.setItem('user', JSON.stringify(data.data.user));
        // 保存 CSRF token 到 sessionStorage
        if (data.data.csrfToken) {
          sessionStorage.setItem('csrfToken', data.data.csrfToken);
        }
        onLogin(data.data.user);
      } else {
        setError(data.message || '登录失败');
        if (showTurnstile) {
          resetTurnstile();
          setTurnstileToken('');
          setTurnstileVerified(false);
          setTurnstileError('');
        }
      }
    } catch (err) {
      setError('连接服务器失败，请检查网络');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-header">
        {siteConfig.logo ? (
          <img src={siteConfig.logo} alt="logo" style={{ width: 64, height: 64, marginBottom: 16 }} />
        ) : (
          <h1 style={{ marginBottom: 8 }}>{siteConfig.title || 'Lumen Chat'}</h1>
        )}
        <p>登录您的账户</p>
      </div>
      
      {error && <div style={{ color: '#ef4444', marginBottom: '15px' }}>{error}</div>}
      
      <form onSubmit={handleLogin}>
        <div className="input-group">
          <label>用户名</label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="请输入用户名"
            required
          />
        </div>
        
        <div className="input-group">
          <label>密码</label>
          <div style={{ position: 'relative' }}>
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="请输入密码"
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
        
        {showTurnstile && (
          <div style={{ marginBottom: '15px' }}>
            {turnstileToken ? (
              <div style={{
                padding: '10px 15px',
                backgroundColor: '#dcfce7',
                border: '1px solid #86efac',
                borderRadius: '8px',
                color: '#166534',
                fontSize: '14px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
              }}>
                <span style={{ fontSize: '16px' }}>✓</span>
                安全验证已通过
              </div>
            ) : turnstileError ? (
              <div 
                style={{
                  padding: '10px 15px',
                  backgroundColor: '#fee2e2',
                  border: '1px solid #fca5a5',
                  borderRadius: '8px',
                  color: '#991b1b',
                  fontSize: '14px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  cursor: 'pointer'
                }}
                onClick={() => {
                  setTurnstileError('');
                  setTurnstileToken('');
                  setTurnstileVerified(false);
                  resetTurnstile();
                }}
              >
                <span style={{ fontSize: '16px' }}>✗</span>
                {turnstileError}，点击重试
              </div>
            ) : (
              <Turnstile
                siteKey={TURNSTILE_SITE_KEY}
                mode="invisible"
                onVerify={(token) => {
                  setTurnstileToken(token);
                  setTurnstileVerified(true);
                  setTurnstileError('');
                }}
                onExpire={() => {
                  setTurnstileToken('');
                  setTurnstileVerified(false);
                  setTurnstileError('验证已过期');
                }}
                onError={() => {
                  setTurnstileError('验证失败');
                }}
                theme="auto"
              />
            )}
          </div>
        )}
        
        <button 
          type="submit" 
          className="login-button" 
          disabled={loading || (showTurnstile && !turnstileToken)}
        >
          {loading ? (
            <span>
              <span className="loading-spinner small"></span>
              登录中...
            </span>
          ) : '登 录'}
        </button>
      </form>
      
    </div>
  );
};

export default Login;
