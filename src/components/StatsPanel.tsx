import { useState, useEffect, useRef, useCallback } from 'react';
import { API } from '../config/api';
import { apiFetch } from '../utils/csrf';
import { TrendingUp, Users, MessageCircle } from 'lucide-react';


interface StatsData {
  date: string;
  count: number;
}

interface TooltipData {
  x: number;
  y: number;
  date: string;
  count: number;
}

interface LoginSummary {
  totalUsers: number;
  loggedInToday: number;
  notLoggedIn: number;
}

export default function StatsPanel() {
  const [loginStats, setLoginStats] = useState<StatsData[]>([]);
  const [chatStats, setChatStats] = useState<StatsData[]>([]);
  const [days, setDays] = useState(7);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [userRole, setUserRole] = useState('');
  const [userName, setUserName] = useState('');
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const [activeChart, setActiveChart] = useState<string | null>(null);
  const [loginSummary, setLoginSummary] = useState<LoginSummary | null>(null);
  const chartRefs = useRef<{ [key: string]: HTMLDivElement | null }>({});

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setError('');
    const token = localStorage.getItem('token');
    const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
    setUserRole(currentUser.role || '');
    setUserName(currentUser.name || '');

    try {
      const [loginRes, chatRes] = await Promise.all([
        apiFetch(API.stats.login(days), { requireCsrf: false }),
        apiFetch(API.stats.chat(days), { requireCsrf: false })
      ]);
      
      const loginData = await loginRes.json();
      const chatData = await chatRes.json();
      
      if (loginData.success) {
        setLoginStats(loginData.data);
        if (loginData.summary) {
          setLoginSummary(loginData.summary);
        }
      }
      
      if (chatData.success) {
        setChatStats(chatData.data);
      }
      
      if (!loginData.success && !chatData.success) {
        setError(loginData.message || '获取统计数据失败');
      } else {
        setError('');
      }
    } catch (e) {
      setError('获取统计数据失败');
    }
    
    setLoading(false);
  }, [days]);

  const lastDaysRef = useRef<number | null>(null);

  useEffect(() => {
    // 防止 React 严格模式重复调用
    if (lastDaysRef.current === days && lastDaysRef.current !== null) return;
    lastDaysRef.current = days;
    fetchStats();
  }, [fetchStats]);

  const handleMouseMove = (e: React.MouseEvent, data: StatsData[], chartId: string) => {
    const chartEl = chartRefs.current[chartId];
    if (!chartEl || data.length === 0) return;
    
    const rect = chartEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    const padding = { left: 60, right: 30, top: 20, bottom: 50 };
    const chartWidth = rect.width - padding.left - padding.right;
    const chartHeight = rect.height - padding.top - padding.bottom;
    
    const relativeX = x - padding.left;
    if (relativeX < 0 || relativeX > chartWidth) {
      setTooltip(null);
      return;
    }
    
    const index = Math.round((relativeX / chartWidth) * (data.length - 1));
    if (index >= 0 && index < data.length) {
      setTooltip({
        x: e.clientX,
        y: e.clientY,
        date: data[index].date,
        count: data[index].count
      });
      setActiveChart(chartId);
    }
  };

  const handleMouseLeave = () => {
    setTooltip(null);
    setActiveChart(null);
  };

  const renderLineChart = (data: StatsData[], title: string, color: string, icon: React.ReactNode, chartId: string) => {
    const chartStyle: React.CSSProperties = {
      minHeight: '200px'
    };

    if (data.length === 0) {
      return (
        <div className="stats-card" style={chartStyle}>
          <div className="stats-card-header">
            {icon}
            <h3>{title}</h3>
          </div>
          <div className="stats-empty">暂无数据</div>
        </div>
      );
    }

    const maxCount = Math.max(...data.map(d => d.count), 1);
    const minCount = 0;
    const range = maxCount - minCount || 1;
    
    const width = 800;
    const height = 320;
    const padding = { left: 60, right: 30, top: 20, bottom: 50 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    const points = data.map((item, index) => {
      const x = padding.left + (index / (data.length - 1 || 1)) * chartWidth;
      const y = padding.top + chartHeight - ((item.count - minCount) / range) * chartHeight;
      return { x, y, ...item };
    });

    const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
    const areaPath = `${linePath} L ${points[points.length - 1].x} ${height - padding.bottom} L ${padding.left} ${height - padding.bottom} Z`;

    const gridLines = [0, 0.25, 0.5, 0.75, 1].map(ratio => {
      const yVal = padding.top + chartHeight * (1 - ratio);
      const value = Math.round(minCount + range * ratio);
      return { y: yVal, value };
    });

    const xLabels = [];
    const labelStep = Math.max(1, Math.ceil(data.length / 7));
    for (let i = 0; i < data.length; i += labelStep) {
      xLabels.push({
        x: padding.left + (i / (data.length - 1 || 1)) * chartWidth,
        label: data[i].date
      });
    }

    const total = data.reduce((sum, d) => sum + d.count, 0);
    const avg = Math.round(total / data.length);

    return (
      <div className="stats-card">
        <div className="stats-card-header">
          {icon}
          <h3>{title}</h3>
        </div>
        <div className="stats-summary">
          <div className="stats-total">
            <span className="stats-value">{total}</span>
            <span className="stats-label">总计</span>
          </div>
          <div className="stats-avg">
            <span className="stats-value">{avg}</span>
            <span className="stats-label">日均</span>
          </div>
          <div className="stats-peak">
            <span className="stats-value">{maxCount}</span>
            <span className="stats-label">峰值</span>
          </div>
        </div>
        <div 
          className="stats-chart-container" 
          ref={(el) => { chartRefs.current[chartId] = el; }}
          onMouseMove={(e) => handleMouseMove(e, data, chartId)}
          onMouseLeave={handleMouseLeave}
        >
          <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="stats-svg">
            {gridLines.map((line, i) => (
              <g key={i}>
                <line 
                  x1={padding.left} 
                  y1={line.y} 
                  x2={width - padding.right} 
                  y2={line.y} 
                  stroke="var(--border)" 
                  strokeWidth="1" 
                />
                <text 
                  x={padding.left - 8} 
                  y={line.y + 4} 
                  fontSize="12" 
                  fill="var(--text-secondary)"
                  textAnchor="end"
                >
                  {line.value}
                </text>
              </g>
            ))}
            
            {xLabels.map((label, i) => (
              <text 
                key={i}
                x={label.x} 
                y={height - padding.bottom + 20} 
                fontSize="11" 
                fill="var(--text-secondary)"
                textAnchor="middle"
              >
                {label.label}
              </text>
            ))}
            
            <path 
              d={areaPath} 
              fill={color} 
              fillOpacity="0.2" 
            />
            
            <path 
              d={linePath} 
              fill="none" 
              stroke={color} 
              strokeWidth="3" 
              strokeLinecap="round" 
              strokeLinejoin="round"
            />
            
            {points.map((point, i) => (
              <g key={i}>
                <circle 
                  cx={point.x} 
                  cy={point.y} 
                  r="5" 
                  fill="var(--light)" 
                  stroke={color} 
                  strokeWidth="2"
                />
              </g>
            ))}
          </svg>
        </div>
      </div>
    );
  };

  if (error) {
    return (
      <div className="stats-panel">
        <div className="stats-error">
          <TrendingUp size={48} />
          <p>{error}</p>
        </div>
      </div>
    );
  }

  const isAdminOrVip = userRole === 'admin' || userRole === 'vip';

  return (
    <div className="stats-panel">
      <div className="stats-header">
        <h2>
          <TrendingUp size={24} />
          数据统计
          {userName && <span className="stats-user-name">- {userName}</span>}
        </h2>
        <div className="stats-header-right">
          <span className={`stats-role-badge ${isAdminOrVip ? 'admin' : 'user'}`} style={{ display: 'inline-block', whiteSpace: 'nowrap' }}>
            {isAdminOrVip ? '管理员' : '个人'}
          </span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>最近7天</option>
            <option value={30}>最近30天</option>
            <option value={90}>最近90天</option>
          </select>
          <button onClick={fetchStats} className="stats-refresh-btn" disabled={loading} style={{ display: 'inline-flex', whiteSpace: 'nowrap' }}>
            {loading ? '刷新中...' : '刷新'}
          </button>
        </div>
      </div>
      
      {tooltip && activeChart && (
        <div 
          className="stats-tooltip"
          style={{ 
            left: tooltip.x + 10, 
            top: tooltip.y - 40 
          }}
        >
          <div className="tooltip-date">{tooltip.date}</div>
          <div className="tooltip-count">
            数量: <strong>{tooltip.count}</strong>
          </div>
        </div>
      )}
      
      {loading ? (
        <div className="stats-loading">
          <div className="loading-spinner"></div>
          <span>加载中...</span>
        </div>
      ) : (
        <div className="stats-vertical">
          {isAdminOrVip && loginSummary && (
            <div className="stats-card">
              <div className="stats-card-header">
                <Users size={20} />
                <h3>登录概览</h3>
              </div>
              <div className="stats-summary">
                <div className="stats-total">
                  <span className="stats-value">{loginSummary.totalUsers}</span>
                  <span className="stats-label">总用户</span>
                </div>
                <div className="stats-avg">
                  <span className="stats-value">{loginSummary.loggedInToday}</span>
                  <span className="stats-label">今日登录</span>
                </div>
                <div className="stats-peak">
                  <span className="stats-value">{loginSummary.notLoggedIn}</span>
                  <span className="stats-label">未登录</span>
                </div>
              </div>
            </div>
          )}
          {renderLineChart(loginStats, isAdminOrVip ? '用户登录统计' : '我的登录统计', '#10B981', <Users size={20} />, 'login')}
          {renderLineChart(chatStats, isAdminOrVip ? '聊天消息统计' : '我的消息统计', '#3B82F6', <MessageCircle size={20} />, 'chat')}
        </div>
      )}
    </div>
  );
}
