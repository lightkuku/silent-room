import React, { useState } from 'react';
import { Key, Copy, X, Eye, EyeOff, Trash2, RotateCcw, ChevronDown, ChevronUp } from 'lucide-react';

interface KeyModalProps {
  isOpen: boolean;
  onClose: () => void;
  encryptionKey: string;
  legacyKeys: string[];
  onCopyKey: () => void;
  onChangeKey: (newKey: string) => void;
  onUseLegacyKey: (key: string) => void;
  onDeleteLegacyKey: (index: number) => void;
}

export const KeyModal: React.FC<KeyModalProps> = ({
  isOpen,
  onClose,
  encryptionKey,
  legacyKeys,
  onCopyKey,
  onChangeKey,
  onUseLegacyKey,
  onDeleteLegacyKey
}) => {
  const [showKey, setShowKey] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [showLegacyKeys, setShowLegacyKeys] = useState<boolean[]>([]);
  const [legacyExpanded, setLegacyExpanded] = useState(false);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content key-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3><Key size={20} /> 加密密钥</h3>
          <button className="modal-close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="modal-body">
          <div className="key-section">
            <label>消息加密密钥</label>
            <div className="key-display">
              <input
                type={showKey ? 'text' : 'password'}
                value={encryptionKey}
                readOnly
                onFocus={onCopyKey}
                className="key-input"
              />
              <button
                className="key-btn"
                onClick={() => setShowKey(!showKey)}
              >
                {showKey ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            <small className="key-tip">用于加密发送的消息、文件和图片</small>
          </div>

          <div className="key-section">
            <label>修改密钥</label>
            <div className="key-change">
              <input
                type="text"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder="输入新密钥（至少8位）"
                className="key-input"
              />
              <button
                className="key-btn secondary"
                onClick={() => {
                  const randomKey = Math.random().toString(36).substring(2, 18) + 
                          Math.random().toString(36).substring(2, 18) + 
                          Math.random().toString(36).substring(2, 18);
                  setNewKey(randomKey);
                }}
                title="随机生成密钥"
              >
                <RotateCcw size={18} />
              </button>
              <button
                className="key-btn primary"
                onClick={() => {
                  if (newKey && newKey.length >= 8) {
                    onChangeKey(newKey);
                    setNewKey('');
                  }
                }}
                disabled={!newKey || newKey.length < 8}
              >
                应用
              </button>
            </div>
          </div>

          {legacyKeys.length > 0 && (
            <div className="key-section">
              <div className="legacy-header" onClick={() => setLegacyExpanded(!legacyExpanded)}>
                <label>历史密钥 ({legacyKeys.length})</label>
                {legacyExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
              </div>
              {legacyExpanded && (
                <div className="legacy-keys-list">
                  {legacyKeys.map((key, index) => (
                    <div key={index} className="legacy-key-item">
                      <div className="legacy-key-row">
                        <span className="legacy-index">{index + 1}.</span>
                        <input
                          type={showLegacyKeys[index] ? 'text' : 'password'}
                          value={key}
                          readOnly
                          className="key-input small"
                        />
                        <button
                          className="key-btn small"
                          onClick={() => {
                            const newShow = [...showLegacyKeys];
                            newShow[index] = !newShow[index];
                            setShowLegacyKeys(newShow);
                          }}
                        >
                          {showLegacyKeys[index] ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                        <button
                          className="key-btn small primary"
                          onClick={() => onUseLegacyKey(key)}
                        >
                          使用
                        </button>
                        <button
                          className="key-btn small danger"
                          onClick={() => onDeleteLegacyKey(index)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <small className="key-tip">当当前密钥无法解密消息时，系统会自动尝试使用历史密钥解密</small>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
