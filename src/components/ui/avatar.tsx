import React from 'react';

interface AvatarProps {
  children?: React.ReactNode;
  className?: string;
}

export const Avatar: React.FC<AvatarProps> = ({ children, className = '' }) => {
  const style: React.CSSProperties = {
    width: '40px',
    height: '40px',
    borderRadius: '50%',
    background: '#e5e7eb',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '14px',
    fontWeight: 500,
    color: '#6b7280',
  };
  return <div style={style} className={className}>{children}</div>;
};

export const AvatarFallback: React.FC<AvatarProps> = ({ children, className = '' }) => {
  const style: React.CSSProperties = {
    width: '40px',
    height: '40px',
    borderRadius: '50%',
    background: '#4f46e5',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '14px',
    fontWeight: 500,
    color: 'white',
  };
  return <div style={style} className={className}>{children}</div>;
};
