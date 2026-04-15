import React from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'outline' | 'ghost';
}

export const Button: React.FC<ButtonProps> = ({ 
  children, 
  variant = 'default',
  className = '',
  ...props 
}) => {
  const baseStyle: React.CSSProperties = {
    padding: '10px 20px',
    borderRadius: '6px',
    fontSize: '14px',
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 0.2s',
    border: variant === 'outline' ? '1px solid #e5e7eb' : 'none',
    background: variant === 'default' ? '#4f46e5' : variant === 'ghost' ? 'transparent' : 'white',
    color: variant === 'default' ? 'white' : '#374151',
  };

  return (
    <button style={baseStyle} {...props}>
      {children}
    </button>
  );
};
