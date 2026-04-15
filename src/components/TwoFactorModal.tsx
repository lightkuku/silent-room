import React, { useState, useEffect } from 'react';
import { ShieldCheck, X, Lock, Eye, EyeOff, CheckCircle, AlertCircle, Copy, RefreshCw, Key } from 'lucide-react';

interface TwoFactorModalProps {
  isOpen: boolean;
  onClose: () => void;
  step: 'choose' | 'enable' | 'disable';
  isEnabled: boolean;
  onEnable: (code: string) => Promise<void>;
  onDisable: (code: string) => Promise<void>;
  isLoading: boolean;
  onSetStep: (step: 'choose' | 'enable' | 'disable') => void;
  secret?: string;
  currentCode?: string;
  onGenerateSecret?: () => void;
  onGetCurrentCode?: () => void;
}

const TwoFactorModal: React.FC<TwoFactorModalProps> = ({
  isOpen,
  onClose,
  step,
  isEnabled,
  onEnable,
  onDisable,
  isLoading,
  onSetStep,
  secret,
  currentCode,
  onGenerateSecret,
  onGetCurrentCode
}) => {
  const [code, setCode] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (step === 'enable' && !secret && onGenerateSecret) {
      onGenerateSecret();
    }
    if (step !== 'choose' && currentCode && onGetCurrentCode) {
      onGetCurrentCode();
    }
  }, [step, secret]);

  if (!isOpen) return null;

  const handleSubmit = async () => {
    if (code.length !== 6) {
      setError('请输入6位验证码');
      return;
    }
    setError('');
    try {
      if (step === 'enable') {
        await onEnable(code);
      } else {
        await onDisable(code);
      }
      setCode('');
      onClose();
    } catch (err: any) {
      setError(err.message || '操作失败，请重试');
    }
  };

  const handleClose = () => {
    setCode('');
    setError('');
    onClose();
  };

  const handleCopySecret = () => {
    if (secret) {
      navigator.clipboard.writeText(secret);
    }
  };

  return (
    <div className="settings-modal-overlay" onClick={handleClose}>
      <div className="settings-modal two-factor-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-modal-header">
          <h3>
            <ShieldCheck size={20} />
            {step === 'enable' ? '启用两步验证' : step === 'disable' ? '关闭两步验证' : '两步验证'}
          </h3>
          <button className="modal-close" onClick={handleClose}>
            <X size={20} />
          </button>
        </div>

        <div className="settings-modal-content">
          {step === 'choose' ? (
            <div className="two-factor-choose">
              <div className="two-factor-status">
                <div className={`status-icon ${isEnabled ? 'enabled' : 'disabled'}`}>
                  {isEnabled ? <CheckCircle size={48} /> : <AlertCircle size={48} />}
                </div>
                <h4>{isEnabled ? '两步验证已开启' : '两步验证未开启'}</h4>
                <p>{isEnabled ? '您的账号已受两步验证保护' : '建议开启两步验证以保护账号安全'}</p>
              </div>
              <div className="two-factor-actions">
                {isEnabled ? (
                  <button className="settings-btn-danger" onClick={() => onSetStep('disable')}>
                    <Lock size={16} /> 关闭两步验证
                  </button>
                ) : (
                  <button className="settings-btn-primary" onClick={() => onSetStep('enable')}>
                    <ShieldCheck size={16} /> 启用两步验证
                  </button>
                )}
              </div>
              <div className="two-factor-info">
                <h5>什么是两步验证？</h5>
                <p>两步验证是一种基于TOTP（时间同步一次性密码）的安全保护措施。开启后，每次登录时需要输入动态生成的6位验证码。</p>
              </div>
            </div>
          ) : step === 'enable' ? (
            <div className="two-factor-setup">
              <div className="setup-step">
                <div className="step-number">1</div>
                <div className="step-content">
                  <h4>密钥已生成</h4>
                  <p>请保存以下密钥，用于生成验证码：</p>
                  <div className="secret-display">
                    <code>{secret || '正在生成...'}</code>
                    {secret && (
                      <button className="copy-btn" onClick={handleCopySecret} title="复制密钥">
                        <Copy size={16} />
                      </button>
                    )}
                  </div>
                  <p className="secret-tip">建议截图保存，关闭后将无法查看</p>
                </div>
              </div>

              <div className="setup-step">
                <div className="step-number">2</div>
                <div className="step-content">
                  <h4>输入当前验证码</h4>
                  <p>使用密钥生成当前验证码：</p>
                  <div className="current-code-display">
                    <span className="code-label">当前验证码：</span>
                    <span className="code-value">{currentCode || '正在生成...'}</span>
                    {currentCode && (
                      <button className="refresh-btn" onClick={onGetCurrentCode} title="刷新验证码">
                        <RefreshCw size={16} />
                      </button>
                    )}
                  </div>
                  <div className="setup-form">
                    <div className="settings-form-group">
                      <label>输入验证码确认启用</label>
                      <div className="settings-code-input">
                        <input
                          type={showCode ? 'text' : 'password'}
                          value={code}
                          onChange={(e) => {
                            const val = e.target.value.replace(/\D/g, '').slice(0, 6);
                            setCode(val);
                            setError('');
                          }}
                          placeholder="请输入6位验证码"
                          maxLength={6}
                        />
                        <button 
                          className="code-toggle"
                          onClick={() => setShowCode(!showCode)}
                        >
                          {showCode ? <EyeOff size={18} /> : <Eye size={18} />}
                        </button>
                      </div>
                      {error && <span className="input-error">{error}</span>}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="two-factor-setup">
              <div className="setup-info">
                <div className="info-icon disable">
                  <Lock size={40} />
                </div>
                <h4>关闭两步验证</h4>
                <p>请输入当前验证码以确认关闭</p>
              </div>

              <div className="setup-form">
                <div className="current-code-display">
                  <span className="code-label">当前验证码：</span>
                  <span className="code-value">{currentCode || '正在生成...'}</span>
                  {currentCode && (
                    <button className="refresh-btn" onClick={onGetCurrentCode} title="刷新验证码">
                      <RefreshCw size={16} />
                    </button>
                  )}
                </div>
                <div className="settings-form-group">
                  <label>输入验证码确认关闭</label>
                  <div className="settings-code-input">
                    <input
                      type={showCode ? 'text' : 'password'}
                      value={code}
                      onChange={(e) => {
                        const val = e.target.value.replace(/\D/g, '').slice(0, 6);
                        setCode(val);
                        setError('');
                      }}
                      placeholder="请输入6位验证码"
                      maxLength={6}
                    />
                    <button 
                      className="code-toggle"
                      onClick={() => setShowCode(!showCode)}
                    >
                      {showCode ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                  {error && <span className="input-error">{error}</span>}
                </div>
              </div>
            </div>
          )}
        </div>

        {step !== 'choose' && (
          <div className="settings-modal-actions">
            <button className="settings-btn-secondary" onClick={handleClose} disabled={isLoading}>
              取消
            </button>
            <button 
              className="settings-btn-primary" 
              onClick={handleSubmit}
              disabled={isLoading || code.length !== 6}
            >
              {isLoading ? '验证中...' : step === 'enable' ? '启用' : '关闭'}
            </button>
          </div>
        )}
      </div>

      <style>{`
        .two-factor-modal {
          max-width: 480px;
        }

        .settings-modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding-bottom: 16px;
          border-bottom: 1px solid var(--border);
          margin-bottom: 20px;
        }

        .settings-modal-header h3 {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 18px;
          font-weight: 600;
          color: var(--dark);
        }

        .modal-close {
          background: none;
          border: none;
          cursor: pointer;
          color: var(--gray);
          padding: 4px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 6px;
          transition: all 0.2s;
        }

        .modal-close:hover {
          background: var(--hover-bg);
          color: var(--dark);
        }

        .two-factor-choose {
          text-align: center;
        }

        .two-factor-status {
          padding: 24px;
          background: var(--hover-bg);
          border-radius: 12px;
          margin-bottom: 24px;
        }

        .status-icon {
          width: 80px;
          height: 80px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          margin: 0 auto 16px;
        }

        .status-icon.enabled {
          background: var(--success-light);
          color: var(--success);
        }

        .status-icon.disabled {
          background: var(--light-gray);
          color: var(--gray);
        }

        .two-factor-status h4 {
          font-size: 18px;
          font-weight: 600;
          color: var(--dark);
          margin-bottom: 8px;
        }

        .two-factor-status p {
          color: var(--gray);
          font-size: 14px;
        }

        .two-factor-actions {
          margin-bottom: 24px;
        }

        .two-factor-info {
          text-align: left;
          padding: 16px;
          background: var(--light);
          border-radius: 10px;
          border: 1px solid var(--border);
        }

        .two-factor-info h5 {
          font-size: 14px;
          font-weight: 600;
          color: var(--dark);
          margin-bottom: 8px;
        }

        .two-factor-info p {
          font-size: 13px;
          color: var(--gray);
          line-height: 1.6;
        }

        .two-factor-setup {
          text-align: left;
        }

        .setup-step {
          display: flex;
          gap: 16px;
          margin-bottom: 24px;
          padding: 16px;
          background: var(--light);
          border-radius: 12px;
          border: 1px solid var(--border);
        }

        .step-number {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          background: var(--primary);
          color: white;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 600;
          flex-shrink: 0;
        }

        .step-content {
          flex: 1;
        }

        .step-content h4 {
          font-size: 15px;
          font-weight: 600;
          color: var(--dark);
          margin-bottom: 8px;
        }

        .step-content p {
          font-size: 13px;
          color: var(--gray);
          margin-bottom: 12px;
        }

        .secret-display {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 12px;
          background: var(--hover-bg);
          border-radius: 8px;
          margin-bottom: 8px;
        }

        .secret-display code {
          font-family: monospace;
          font-size: 14px;
          letter-spacing: 1px;
          color: var(--dark);
          flex: 1;
          word-break: break-all;
        }

        .copy-btn {
          background: none;
          border: none;
          cursor: pointer;
          color: var(--gray);
          padding: 4px;
          display: flex;
          align-items: center;
        }

        .copy-btn:hover {
          color: var(--primary);
        }

        .secret-tip {
          font-size: 12px;
          color: var(--warning);
        }

        .current-code-display {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 12px;
          background: var(--primary-light);
          border-radius: 8px;
          margin-bottom: 16px;
        }

        .code-label {
          font-size: 14px;
          color: var(--gray);
        }

        .code-value {
          font-size: 20px;
          font-weight: 700;
          letter-spacing: 4px;
          color: var(--primary);
          flex: 1;
        }

        .refresh-btn {
          background: none;
          border: none;
          cursor: pointer;
          color: var(--primary);
          padding: 4px;
          display: flex;
          align-items: center;
        }

        .refresh-btn:hover {
          transform: rotate(180deg);
          transition: transform 0.3s;
        }

        .setup-form {
          text-align: left;
        }

        .settings-code-input {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .settings-code-input input {
          flex: 1;
          padding: 12px 16px;
          font-size: 18px;
          letter-spacing: 8px;
          text-align: center;
          font-weight: 600;
        }

        .code-toggle {
          background: none;
          border: none;
          cursor: pointer;
          color: var(--gray);
          padding: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .code-toggle:hover {
          color: var(--primary);
        }

        .input-error {
          display: block;
          color: var(--danger);
          font-size: 13px;
          margin-top: 8px;
        }

        .setup-info {
          text-align: center;
          padding: 20px;
          background: var(--light);
          border-radius: 12px;
          margin-bottom: 24px;
        }

        .info-icon {
          width: 64px;
          height: 64px;
          border-radius: 50%;
          background: var(--primary);
          color: white;
          display: flex;
          align-items: center;
          justify-content: center;
          margin: 0 auto 16px;
        }

        .info-icon.disable {
          background: var(--danger-light);
          color: var(--danger);
        }

        .setup-info h4 {
          font-size: 16px;
          font-weight: 600;
          color: var(--dark);
          margin-bottom: 8px;
        }

        .setup-info p {
          font-size: 13px;
          color: var(--gray);
        }
      `}</style>
    </div>
  );
};

export default TwoFactorModal;