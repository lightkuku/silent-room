import React from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export const Input: React.FC<InputProps> = ({ 
  className = '',
  style,
  ...props 
}) => {
  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px 14px',
    fontSize: '14px',
    borderRadius: '6px',
    border: '1px solid #e5e7eb',
    outline: 'none',
    transition: 'border-color 0.2s',
    ...style,
  };

  return (
    <input 
      style={inputStyle}
      {...props} 
    />
  );
};
