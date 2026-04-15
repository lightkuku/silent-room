import React, { useState, useRef, useEffect } from 'react';
import { Pen, X } from 'lucide-react';
import { truncateText } from '../utils/helpers';
import './HandwritingPanel.css';
import { API } from '../config/api';
import { toast } from '../utils/toast';

interface HandwritingPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectText: (text: string) => void;
  onSendImage?: (imageDataUrl: string) => void;
}

const HandwritingPanel: React.FC<HandwritingPanelProps> = ({ isOpen, onClose, onSelectText, onSendImage }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [fullText, setFullText] = useState<string>('');
  const [isRecognizing, setIsRecognizing] = useState(false);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (isOpen && canvasRef.current) {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
      }
      setCandidates([]);
      setFullText('');
    }
  }, [isOpen]);

  const getPos = (e: React.MouseEvent | React.TouchEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    
    const rect = canvas.getBoundingClientRect();
    
    if ('touches' in e) {
      return {
        x: e.touches[0].clientX - rect.left,
        y: e.touches[0].clientY - rect.top
      };
    }
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  };

  const startDrawing = (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    const pos = getPos(e);
    lastPoint.current = pos;
    setIsDrawing(true);
  };

  const draw = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawing || !lastPoint.current) return;
    e.preventDefault();
    
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx || !canvas) return;

    const pos = getPos(e);
    
    ctx.beginPath();
    ctx.moveTo(lastPoint.current.x, lastPoint.current.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    
    lastPoint.current = pos;
  };

  const stopDrawing = () => {
    setIsDrawing(false);
    lastPoint.current = null;
  };

  const recognizeText = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    setIsRecognizing(true);
    setCandidates([]);
    setFullText('');

    try {
      // 使用 toBlob 代替 toDataURL
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('无法获取图片'));
        }, 'image/png');
      });
      
      // 转换为 base64
      const reader = new FileReader();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      
      const token = localStorage.getItem('token');
      const response = await fetch(API.ocr.handwriting, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ image: dataUrl })
      });
      
      const result = await response.json();
      
      if (result.success && result.text) {
        const chars = result.text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').split('').filter(c => c);
        const uniqueChars = [...new Set(chars)].slice(0, 12);
        const cleanText = result.text.replace(/[*#\n]/g, '').trim();
        
        setCandidates(uniqueChars);
        setFullText(cleanText);
      } else {
        console.error('识别失败:', result.message);
        toast.error('识别失败', result.message);
      }
    } catch (error) {
      console.error('OCR识别失败:', error);
      toast.error('识别失败，请重试或检查网络连接');
    } finally {
      setIsRecognizing(false);
    }
  };

  const handleSelectChar = (char: string) => {
    onSelectText(char);
    clearCanvas();
  };
  
  const handleUseFullText = () => {
    if (fullText) {
      onSelectText(fullText);
      clearCanvas();
    }
  };

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (ctx && canvas) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    setCandidates([]);
    setFullText('');
  };

  if (!isOpen) return null;

  return (
    <div className="handwriting-panel">
      <div className="handwriting-header">
        <span className="handwriting-title">
          <Pen size={16} /> 手写识别
        </span>
        <button className="handwriting-close" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      
      <canvas
        ref={canvasRef}
        width={480}
        height={200}
        className="handwriting-canvas"
        onMouseDown={startDrawing}
        onMouseMove={draw}
        onMouseUp={stopDrawing}
        onMouseLeave={stopDrawing}
        onTouchStart={startDrawing}
        onTouchMove={draw}
        onTouchEnd={stopDrawing}
      />
      
      <div className="handwriting-actions">
        <button className="handwriting-btn" onClick={clearCanvas}>
          清除
        </button>
        <button 
          className="handwriting-btn recognize" 
          onClick={recognizeText}
          disabled={isRecognizing}
        >
          {isRecognizing ? '识别中...' : '识别'}
        </button>
        {onSendImage && (
          <button 
            className="handwriting-btn" 
            onClick={() => {
              const canvas = canvasRef.current;
              if (canvas) {
                canvas.toBlob((blob) => {
                  if (blob) {
                    const reader = new FileReader();
                    reader.onload = () => {
                      onSendImage(reader.result as string);
                      clearCanvas();
                    };
                    reader.readAsDataURL(blob);
                  }
                }, 'image/png');
              }
            }}
          >
            发送图片
          </button>
        )}
      </div>
      
      {candidates.length > 0 && (
        <div className="handwriting-candidates">
          {fullText && (
            <button className="candidate-fulltext" onClick={handleUseFullText}>
              使用: {truncateText(fullText, 10)}
            </button>
          )}
          {candidates.map((char, index) => (
            <button
              key={index}
              className="candidate-char"
              onClick={() => handleSelectChar(char)}
            >
              {char}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default HandwritingPanel;
