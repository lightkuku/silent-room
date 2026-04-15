import React, { useState, useEffect } from 'react';
import { ListChecks, X } from 'lucide-react';
import { API } from '../config/api';
import { apiFetch } from '../utils/csrf';
import './CandidatePanel.css';

interface CandidatePanelProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectCandidate: (text: string) => void;
}

const CandidatePanel: React.FC<CandidatePanelProps> = ({ isOpen, onClose, onSelectCandidate }) => {
  const [searchText, setSearchText] = useState('');
  const [customCandidates, setCustomCandidates] = useState<string[]>([]);
  const [commonCandidates, setCommonCandidates] = useState<string[]>([]);
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // 从后端获取短语
  useEffect(() => {
    if (isOpen) {
      fetchPhrases();
    }
  }, [isOpen]);

  const fetchPhrases = async () => {
    setIsLoading(true);
    try {
      const response = await apiFetch(API.phrases.list, { requireCsrf: false });
      const result = await response.json();
      if (result.success) {
        const common = result.data.filter((p: any) => !p.user_id).map((p: any) => p.phrase);
        const custom = result.data.filter((p: any) => p.user_id).map((p: any) => p.phrase);
        setCommonCandidates(common);
        setCustomCandidates(custom);
      }
    } catch (error) {
      console.error('获取短语失败:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // 过滤候选词
  const filteredCandidates = searchText
    ? commonCandidates.filter(phrase => phrase.includes(searchText))
    : commonCandidates;

  // 添加自定义候选词
  const addCustomCandidate = async () => {
    if (customInput.trim() && !customCandidates.includes(customInput.trim())) {
      try {
        const response = await apiFetch(API.phrases.list, {
          method: 'POST',
          body: JSON.stringify({ phrase: customInput.trim() })
        });
        const result = await response.json();
        if (result.success) {
          setCustomCandidates(prev => [customInput.trim(), ...prev]);
          setCustomInput('');
        }
      } catch (error) {
        console.error('添加短语失败:', error);
      }
    }
    setShowCustomInput(false);
  };

  // 删除自定义候选词
  const removeCustomCandidate = async (phrase: string) => {
    try {
      const response = await apiFetch(API.phrases.list, { requireCsrf: false });
      const result = await response.json();
      if (result.success) {
        const phraseData = result.data.find((p: any) => p.phrase === phrase && p.user_id);
        if (phraseData) {
          await apiFetch(API.phrases.phrase(phraseData.id), {
            method: 'DELETE'
          });
        }
      }
      setCustomCandidates(prev => prev.filter(p => p !== phrase));
    } catch (error) {
      console.error('删除短语失败:', error);
    }
  };

  // 选择候选词
  const handleSelect = (phrase: string) => {
    onSelectCandidate(phrase);
    setSearchText('');
  };

  if (!isOpen) return null;

  return (
    <div className="candidate-panel">
      <div className="candidate-header">
        <span className="candidate-title">
          <ListChecks size={16} /> 快捷短语
        </span>
        <button className="candidate-close" onClick={onClose}>
          <X size={16} />
        </button>
      </div>

      {/* 搜索框 */}
      <div className="candidate-search">
        <input
          type="text"
          placeholder="搜索短语..."
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          className="candidate-search-input"
        />
      </div>

      {/* 自定义短语按钮 */}
      {!showCustomInput ? (
        <button
          className="candidate-add-btn"
          onClick={() => setShowCustomInput(true)}
        >
          + 添加自定义短语
        </button>
      ) : (
        <div className="candidate-add-form">
          <input
            type="text"
            placeholder="输入自定义短语"
            value={customInput}
            onChange={(e) => setCustomInput(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && addCustomCandidate()}
            className="candidate-add-input"
            autoFocus
          />
          <button onClick={addCustomCandidate} className="candidate-add-confirm">添加</button>
          <button onClick={() => { setShowCustomInput(false); setCustomInput(''); }} className="candidate-add-cancel">取消</button>
        </div>
      )}

      {/* 自定义短语列表 */}
      {customCandidates.length > 0 && (
        <div className="custom-candidate">
          <div className="candidate-section-title">我的短语</div>
          <div className="candidate-list">
            {customCandidates.map((phrase, index) => (
              <div key={index} className="candidate-item custom">
                <span onClick={() => handleSelect(phrase)}>{phrase}</span>
                <button className="candidate-remove" onClick={() => removeCustomCandidate(phrase)}>×</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 常用短语 */}
      <div className="candidate-section">
        <div className="candidate-section-title">常用短语</div>
        {isLoading ? (
          <div className="candidate-loading">
            <span className="loading-spinner"></span>
            <span>加载中...</span>
          </div>
        ) : (
          <div className="candidate-list">
            {filteredCandidates.map((phrase, index) => (
              <button
                key={index}
                className="candidate-item"
                onClick={() => handleSelect(phrase)}
              >
                {phrase}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default CandidatePanel;
